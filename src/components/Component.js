import { Text } from '../shapes/text.js';
import { compactObjText } from './LCSCFetcher.js';
import { getBuiltInPackageOptions, withBuiltInPackage } from './BuiltInPackages.js';
import { IdAllocator } from '../core/id-allocator.js';

/**
 * Shrink a `~`-delimited footprint shape string for storage by rounding every
 * decimal coordinate to 4 dp (0.1 µm). KiCad ships pad/silk positions at 6
 * decimals (e.g. `PAD~RECT~1.2345678~-2.3456789~…`), which bloats the saved
 * document for no visual benefit. Non-numeric tokens (RECT, top, …) and plain
 * integers pass through untouched. Idempotent — safe to re-run at save time.
 * @param {*} s
 * @returns {*}
 */
function _compactShapeStr(s) {
    if (typeof s !== 'string') return s;
    return s.replace(/-?\d+\.\d+(?:[eE][-+]?\d+)?/g, (m) => {
        const n = Math.round(parseFloat(m) * 1e4) / 1e4;
        return Number.isFinite(n) ? String(n) : m;
    });
}

/**
 * @typedef {{
 *   name: string,
 *   symbol: any,
 *   category?: string,
 *   description?: string,
 *   defaultReference?: string,
 *   defaultValue?: string,
 *   defaultProperties?: Object,
 *   supplier_part_numbers?: { LCSC?: string },
 *   _source?: string,
 *   [key: string]: any
 * }} ComponentDefinition
 */

/**
 * @typedef {{
 *   x: number,
 *   y: number,
 *   rotation?: number,
 *   mirror?: boolean,
 *   reference?: string,
 *   value?: string,
 *   showReference?: boolean,
 *   showValue?: boolean,
 *   [key: string]: any
 * }} ComponentState
 */

const componentIds = new IdAllocator('comp');

/**
 * Merge component property objects while stripping dangerous keys
 * (`__proto__`, `constructor`, `prototype`) so that definitions parsed from
 * remote/untrusted sources cannot pollute the prototype chain.
 * @param {Object} [base]
 * @param {Object} [override]
 * @returns {Object}
 */
function _safeMergeProps(base, override) {
    /** @type {Record<string, any>} */
    const result = {};
    const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
    for (const src of [base, override]) {
        if (!src || typeof src !== 'object') continue;
        for (const [k, v] of Object.entries(src)) {
            if (FORBIDDEN.has(k)) continue;
            result[k] = v;
        }
    }
    return result;
}

/**
 * Update the ID counter to avoid collisions with loaded components
 * @param {string|number} id
 */
export function updateComponentIdCounter(id) {
    componentIds.observe(id);
}

/**
 * Component class - represents an electronic component instance on the schematic
 */
export class Component {
    /**
     * Create a component instance.
     * @param {ComponentDefinition} definition - Component definition (symbol, name, defaults, etc.)
     * @param {Object} [options]
     * @param {string} [options.id] - Unique ID (auto-generated if omitted)
     * @param {number} [options.x=0] - World X position
     * @param {number} [options.y=0] - World Y position
     * @param {number} [options.rotation=0] - Rotation in degrees
     * @param {boolean} [options.mirror=false] - Horizontal mirror flag
     * @param {string} [options.reference] - Reference designator (e.g. 'R1')
     * @param {string} [options.value] - Component value (e.g. '10k')
     * @param {boolean} [options.showReference=true] - Whether the reference text is visible
     * @param {boolean} [options.showValue=true] - Whether the value text is visible
     * @param {boolean} [options.visible=true] - Component visibility
     * @param {boolean} [options.locked=false] - Lock against edits
     * @param {Object} [options.properties] - Additional user properties
     * @param {string} [options.packageId] - Built-in footprint/model selection
     */
    constructor(definition, options = {}) {
        this.id = componentIds.claim(options.id);
        this.definition = definition;
        if (options.packageId !== undefined) this.packageId = options.packageId;
        this.x = options.x || 0;
        this.y = options.y || 0;
        this.rotation = options.rotation || 0;
        this.mirror = options.mirror || false;
        this.reference = options.reference ?? (definition.defaultReference || 'U?');
        this.value = options.value ?? (definition.defaultValue ?? '');
        this.properties = _safeMergeProps(definition.defaultProperties, options.properties);
        
        // Field text shapes (set by createFieldTexts)
        this.refText = null;
        this.valueText = null;
        this.showReference = options.showReference !== undefined ? options.showReference : true;
        this.showValue = options.showValue !== undefined ? options.showValue : true;
        
        // Selection-related properties
        this.visible = options.visible !== undefined ? options.visible : true;
        this.locked = options.locked !== undefined ? options.locked : false;
        /** @type {boolean|undefined} Set by schematic viewport culling. */
        this._culled = undefined;
        /** @type {{minX:number, minY:number, maxX:number, maxY:number}|null|undefined} */
        this._worldBounds = undefined;
        /** @type {string|undefined} */
        this._worldBoundsSig = undefined;

        /** @type {Set<any>|null} */
        this.attachedLabels = null;
    }

    /** @returns {*} The symbol definition (graphics + pins). */
    get symbol() { return this.definition.symbol; }
    /** @returns {string} The component definition name. */
    get name() { return this.definition.name; }

    get packageId() {
        return this.definition._source === 'Built-in' ? this.definition.packageId || 'default' : 'default';
    }
    set packageId(value) {
        if (value === this.packageId) return;
        this.definition = /** @type {ComponentDefinition} */ (withBuiltInPackage(this.definition, value));
    }

    // ── Coordinate transforms ─────────────────────────────────────

    /** Transform a point from component-local coords to world coords.
     * @param {number} lx
     * @param {number} ly
     */
    localToWorld(lx, ly) {
        let sx = this.mirror ? -lx : lx;
        let sy = ly;
        const rad = this.rotation * Math.PI / 180;
        return {
            x: this.x + sx * Math.cos(rad) - sy * Math.sin(rad),
            y: this.y + sx * Math.sin(rad) + sy * Math.cos(rad)
        };
    }

    /** Transform a point from world coords to component-local coords.
     * @param {number} wx
     * @param {number} wy
     */
    worldToLocal(wx, wy) {
        const dx = wx - this.x;
        const dy = wy - this.y;
        const rad = -this.rotation * Math.PI / 180;
        let lx = dx * Math.cos(rad) - dy * Math.sin(rad);
        let ly = dx * Math.sin(rad) + dy * Math.cos(rad);
        if (this.mirror) lx = -lx;
        return { x: lx, y: ly };
    }

    // ── Field text management ─────────────────────────────────────

    /**
     * Create the Reference and Value Text shapes as independent shapes.
     * Reference is placed centered above the symbol, Value centered below.
     * Both use 1.778mm font (≈7pt/70mil). Call once after the component
     * is placed. Adds them to app.shapes and returns the created models.
     * @param {any} app
     * @returns {Text[]}
     */
    createFieldTexts(app) {
        const symbol = this.symbol;
        if (!symbol) return [];

        // Compute local bounds (already includes 1.0 padding — matches the
        // selection / bounding box the user sees)
        const lb = this._getLocalBounds();
        // Center x — undo mirror swap so localToWorld works correctly
        let cx = (lb.minX + lb.maxX) / 2;
        if (this.mirror) cx = -cx;

        const fontSize = 1.778;   // 7pt / 70mil
        const gap = 0.4;          // spacing outside the bounding box

        // Reference: alphabetic baseline means glyph bottoms sit at the y coord,
        // so offset by ~70% of fontSize (cap height) to clear the box edge.
        const refLocal  = { x: cx, y: lb.minY - gap - fontSize * 0.35 };
        const valLocal  = { x: cx, y: lb.maxY + gap + fontSize };

        const fields = [
            { key: 'reference', label: this.reference, local: refLocal, visible: this.showReference },
            { key: 'value',     label: this.value,     local: valLocal, visible: this.showValue }
        ];

        const created = [];
        for (const f of fields) {
            const world = this.localToWorld(f.local.x, f.local.y);
            const text = new Text(/** @type {any} */ ({
                x: world.x,
                y: world.y,
                text: f.label,
                fontSize,
                fontFamily: 'Arial',
                textAnchor: 'middle',
                color: app.toolOptions.textColor,
                fillColor: app.toolOptions.textColor
            }));
            text.parentComponent = this;
            text.fieldKey = f.key;
            text.visible = f.visible;

            if (f.key === 'reference') this.refText = text;
            else this.valueText = text;

            app.shapes.push(text);
            created.push(text);
        }
        return created;
    }

    /**
     * Re-link field Text shapes after deserialization.
     * Called from loadDocument after both shapes and components are loaded.
     * @param {any[]} shapes
     */
    linkFieldTexts(shapes) {
        for (const s of shapes) {
            if (s.type === 'text' && s._pendingComponentId === this.id) {
                s.parentComponent = this;
                if (s.fieldKey === 'reference') {
                    this.refText = s;
                    s.visible = this.showReference;
                } else if (s.fieldKey === 'value') {
                    this.valueText = s;
                    s.visible = this.showValue;
                }
                delete s._pendingComponentId;
            }
        }
    }

    /** Return array of linked field texts (non-null only). */
    getFieldTexts() {
        const fields = [];
        if (this.refText) fields.push(this.refText);
        if (this.valueText) fields.push(this.valueText);
        if (this.attachedLabels instanceof Set) {
            for (const label of this.attachedLabels) {
                if (label?.type === 'text' && label.fieldKey === 'label') {
                    fields.push(label);
                }
            }
        }
        return fields;
    }

    /**
     * Hit test - check if point is within component bounds
     * @param {{x: number, y: number}} point
     * @param {number} [tolerance=1]
     */
    hitTest(point, tolerance = 1) {
        const bounds = this.getBounds();
        if (!bounds) return false;
        
        return point.x >= bounds.minX - tolerance &&
               point.x <= bounds.maxX + tolerance &&
               point.y >= bounds.minY - tolerance &&
               point.y <= bounds.maxY + tolerance;
    }

    /**
     * Hit test for anchors - components don't have resize anchors
     * @param {{x: number, y: number}} point
     * @param {number} scale
     */
    hitTestAnchor(point, scale) {
        return null;  // Components don't have anchors
    }

    /**
     * Get anchors - components don't have resize anchors
     */
    getAnchors() {
        return [];  // Components don't have anchors
    }

    // ── Shape-compatible API ──────────────────────────────────────

    /**
     * Return the component's world position.
     * @returns {{x: number, y: number}}
     */
    getPosition() {
        return { x: this.x, y: this.y };
    }

    /**
     * Capture current state for undo/redo.
     * @returns {Object} Serialisable snapshot of mutable properties
     */
    captureState() {
        return { x: this.x, y: this.y, rotation: this.rotation, mirror: this.mirror,
                 reference: this.reference, value: this.value,
                 showReference: this.showReference, showValue: this.showValue,
                 packageId: this.packageId };
    }

    /**
     * Restore a previously captured state, recreating the SVG element if
     * the rotation or mirror has changed.
     * @param {Record<string, any>} state - State snapshot from captureState()
     */
    applyState(state) {
        Object.assign(this, state);
        this.invalidate();
    }
    /** @returns {'grid'} Components always snap to the grid. */
    getAnchorSnapMode() { return 'grid'; }
    /** No-op — components have no drag state to reset. */
    resetDragState() {}
    /**
     * Return property descriptors for the properties panel.
     * @returns {Array<{key: string, label: string, type: string, readonly?: boolean, options?: Array<{value: string, label: string}>}>}
     */
    getPropertyDescriptors() {
        /** @type {ReturnType<Component['getPropertyDescriptors']>} */
        const descriptors = [
            { key: 'locked',        label: 'Locked',          type: 'checkbox' },
            { key: 'reference',     label: 'Reference',       type: 'text' },
            { key: 'showReference', label: 'Show Reference',  type: 'checkbox' },
            { key: 'value',         label: 'Value',           type: 'text' },
            { key: 'showValue',     label: 'Show Value',      type: 'checkbox' },
            /** @type {{key:string,label:string,type:string}} */ ({ key: 'source', label: 'Source', type: 'text', readonly: true }),
        ];
        if (this.supplierPartNumber) {
            descriptors.push(/** @type {{key:string,label:string,type:string}} */ ({ key: 'supplierPartNumber', label: 'LCSC Part #', type: 'text', readonly: true }));
        }
        const packages = getBuiltInPackageOptions(this.definition);
        if (packages.length) {
            descriptors.push({ key: 'packageId', label: 'Package', type: 'select', options: packages });
        }
        return descriptors;
    }

    /** @returns {string} Display name for the component's origin library. */
    get source() {
        const raw = this.symbol?._source || this.definition?._source;
        if (!raw) return 'Built-in';
        if (raw === 'EasyEDA') return 'LCSC';
        return raw;
    }

    /** @returns {string} LCSC supplier part number, or empty string if not an LCSC component. */
    get supplierPartNumber() {
        return this.definition?.supplier_part_numbers?.LCSC || '';
    }
    /** @returns {false} Components do not support in-place text editing. */
    get supportsInlineEdit() { return false; }

    /**
     * Get bounding box in world coordinates
     */
    getBounds() {
        const symbol = this.symbol;
        if (!symbol) return null;

        // World bounds change only when the component moves/rotates/mirrors.
        // The viewport-culling pass calls this for every component on every
        // pan/zoom frame, so cache the result keyed on the pose signature to
        // avoid recomputing the rotated corners (and the symbol-geometry scan
        // in _getLocalBounds) thousands of times per frame on large boards.
        const sig = `${this.x}|${this.y}|${this.rotation}|${this.mirror}`;
        if (this._worldBoundsSig === sig && this._worldBounds) {
            return this._worldBounds;
        }

        const localBounds = this._getLocalBounds();
        let minX = localBounds.minX;
        let minY = localBounds.minY;
        let maxX = localBounds.maxX;
        let maxY = localBounds.maxY;
        
        // Apply rotation
        const rad = this.rotation * Math.PI / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        
        // Get all four corners and rotate them
        const corners = [
            { x: minX, y: minY },
            { x: maxX, y: minY },
            { x: maxX, y: maxY },
            { x: minX, y: maxY }
        ];
        
        let worldMinX = Infinity, worldMinY = Infinity;
        let worldMaxX = -Infinity, worldMaxY = -Infinity;
        
        for (const c of corners) {
            const x = c.x, y = c.y;
            
            const rx = x * cos - y * sin;
            const ry = x * sin + y * cos;
            
            const wx = rx + this.x;
            const wy = ry + this.y;
            
            worldMinX = Math.min(worldMinX, wx);
            worldMaxX = Math.max(worldMaxX, wx);
            worldMinY = Math.min(worldMinY, wy);
            worldMaxY = Math.max(worldMaxY, wy);
        }
        
        this._worldBounds = { minX: worldMinX, minY: worldMinY, maxX: worldMaxX, maxY: worldMaxY };
        this._worldBoundsSig = sig;
        return this._worldBounds;
    }

    /**
     * Mark the symbol's highlight stale; the next render redraws it.
     */
    invalidate() {
        this._dirty = true;
        // Invalidate field texts so they update their color to reflect parent selection
        for (const ft of this.getFieldTexts()) {
            ft.invalidate();
        }
    }



    /**
     * Compute the axis-aligned bounding box in component-local coordinates,
     * including all graphics, pins and a 1.0 unit padding.
     * If the component is mirrored the X axis is reflected.
     * @returns {{minX: number, minY: number, maxX: number, maxY: number}}
     */
    _getLocalBounds() {
        const symbol = this.symbol;
        // Local (un-posed) bounds depend only on the symbol geometry and the
        // mirror flag (applied below), both immutable between flips for a placed
        // component, so compute once and reuse. Keyed on the symbol object
        // identity (in case the symbol is ever swapped) plus the mirror state.
        if (this._localBounds && this._localBoundsSymbol === symbol
            && this._localBoundsMirror === this.mirror) {
            return this._localBounds;
        }
        const width = symbol?.width || 10;
        const height = symbol?.height || 10;
        const origin = symbol?.origin || { x: width / 2, y: height / 2 };

        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;

        if (symbol?.graphics) {
            for (const g of symbol.graphics) {
                if (!g) continue;
                switch (g.type) {
                    case 'rect':
                        minX = Math.min(minX, g.x);
                        minY = Math.min(minY, g.y);
                        maxX = Math.max(maxX, g.x + g.width);
                        maxY = Math.max(maxY, g.y + g.height);
                        break;
                    case 'circle':
                        minX = Math.min(minX, g.cx - g.r);
                        minY = Math.min(minY, g.cy - g.r);
                        maxX = Math.max(maxX, g.cx + g.r);
                        maxY = Math.max(maxY, g.cy + g.r);
                        break;
                    case 'line':
                        minX = Math.min(minX, g.x1, g.x2);
                        minY = Math.min(minY, g.y1, g.y2);
                        maxX = Math.max(maxX, g.x1, g.x2);
                        maxY = Math.max(maxY, g.y1, g.y2);
                        break;
                    case 'arc':
                        if (Number.isFinite(g.cx) && Number.isFinite(g.cy) && Number.isFinite(g.r)) {
                            minX = Math.min(minX, g.cx - g.r);
                            minY = Math.min(minY, g.cy - g.r);
                            maxX = Math.max(maxX, g.cx + g.r);
                            maxY = Math.max(maxY, g.cy + g.r);
                        }
                        break;
                    case 'polyline':
                    case 'polygon':
                        if (Array.isArray(g.points)) {
                            for (const p of g.points) {
                                minX = Math.min(minX, p[0]);
                                minY = Math.min(minY, p[1]);
                                maxX = Math.max(maxX, p[0]);
                                maxY = Math.max(maxY, p[1]);
                            }
                        }
                        break;
                    case 'text': {
                        const tmpl = g.text || '';
                        // Skip template text — field texts are independent shapes
                        if (tmpl.includes('${REF}') || tmpl.includes('${VALUE}')) break;
                        const rawText = tmpl;
                        const source = symbol?._source || this.definition?._source;
                        const fontSize = Number.isFinite(g.fontSize) ? g.fontSize : 1.5;
                        const textScale = source === 'KiCad' ? 1.6 : 1.0;
                        const actualFontSize = fontSize * textScale;
                        const textWidth = rawText.length * actualFontSize * 0.7; // More generous
                        const textHeight = actualFontSize * 1.3; // Add extra height
                        let x1 = g.x;
                        if (g.anchor === 'middle') {
                            x1 = g.x - textWidth / 2;
                        } else if (g.anchor === 'end') {
                            x1 = g.x - textWidth;
                        }
                        let y1;
                        if (g.baseline === 'text-after-edge') {
                            y1 = g.y - textHeight;
                        } else if (g.baseline === 'text-before-edge') {
                            y1 = g.y;
                        } else {
                            // middle/unspecified baseline
                            y1 = g.y - textHeight / 2;
                        }
                        minX = Math.min(minX, x1);
                        minY = Math.min(minY, y1);
                        maxX = Math.max(maxX, x1 + textWidth);
                        maxY = Math.max(maxY, y1 + textHeight);
                        break;
                    }
                }
            }
        }

        // Always include pins in bounds calculation
        if (symbol?.pins) {
            for (const pin of symbol.pins) {
                // Hidden pins aren't drawn, so they must not inflate bounds
                // (they're often parked at arbitrary positions by KiCad).
                if (pin.hidden) continue;
                // Include pin connection point
                minX = Math.min(minX, pin.x);
                maxX = Math.max(maxX, pin.x);
                minY = Math.min(minY, pin.y);
                maxY = Math.max(maxY, pin.y);
                
                // If we have path data, parse it to get line extent
                if (pin._pathData) {
                    const pathMatch = pin._pathData.match(/M\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*([hvL])\s*(-?\d+(?:\.\d+)?)/i);
                    if (pathMatch) {
                        const startX = Number(pathMatch[1]);
                        const startY = Number(pathMatch[2]);
                        const cmd = pathMatch[3].toLowerCase();
                        const value = Number(pathMatch[4]);
                        
                        minX = Math.min(minX, startX);
                        minY = Math.min(minY, startY);
                        
                        if (cmd === 'h') {
                            const endX = startX + value;
                            minX = Math.min(minX, endX);
                            maxX = Math.max(maxX, endX);
                        } else if (cmd === 'v') {
                            const endY = startY + value;
                            minY = Math.min(minY, endY);
                            maxY = Math.max(maxY, endY);
                        }
                        
                        maxX = Math.max(maxX, startX);
                        maxY = Math.max(maxY, startY);
                    } else {
                        // Try alternate format
                        const pathMatch2 = pin._pathData.match(/M(-?\d+(?:\.\d+)?)[,\s](-?\d+(?:\.\d+)?)([hvL])(-?\d+(?:\.\d+)?)/i);
                        if (pathMatch2) {
                            const startX = Number(pathMatch2[1]);
                            const startY = Number(pathMatch2[2]);
                            const cmd = pathMatch2[3].toLowerCase();
                            const value = Number(pathMatch2[4]);
                            
                            minX = Math.min(minX, startX);
                            minY = Math.min(minY, startY);
                            
                            if (cmd === 'h') {
                                const endX = startX + value;
                                minX = Math.min(minX, endX);
                                maxX = Math.max(maxX, endX);
                            } else if (cmd === 'v') {
                                const endY = startY + value;
                                minY = Math.min(minY, endY);
                                maxY = Math.max(maxY, endY);
                            }
                            
                            maxX = Math.max(maxX, startX);
                            maxY = Math.max(maxY, startY);
                        }
                    }
                } else if (Number.isFinite(pin.length)) {
                    // Fallback to orientation-based length
                    const length = pin.length;
                    let px = pin.x, py = pin.y;
                    switch (pin.orientation) {
                        case 'right': px += length; break;
                        case 'left': px -= length; break;
                        case 'up': py -= length; break;
                        case 'down': py += length; break;
                    }
                    minX = Math.min(minX, px);
                    maxX = Math.max(maxX, px);
                    minY = Math.min(minY, py);
                    maxY = Math.max(maxY, py);
                }
            }
        }

        if (!Number.isFinite(minX)) {
            minX = -origin.x;
            minY = -origin.y;
            maxX = width - origin.x;
            maxY = height - origin.y;
        }

        const padding = 1.0; // Increased padding to ensure everything is included
        
        // Mirror reflects x coordinates
        if (this.mirror) {
            const tmp = minX;
            minX = -maxX;
            maxX = -tmp;
        }
        
        this._localBounds = {
            minX: minX - padding,
            minY: minY - padding,
            maxX: maxX + padding,
            maxY: maxY + padding
        };
        this._localBoundsSymbol = symbol;
        this._localBoundsMirror = this.mirror;
        return this._localBounds;
    }







    /**
     * Get a pin's connection point in world coordinates.
     * @param {string|number} number - Pin number
     * @returns {{x: number, y: number}|null}
     */
    getPinPosition(number) {
        const pin = this.getPin(number);
        if (!pin) return null;
        let x = pin.x, y = pin.y;
        if (this.mirror) x = -x;
        const rad = this.rotation * Math.PI / 180;
        return {
            x: (x * Math.cos(rad) - y * Math.sin(rad)) + this.x,
            y: (x * Math.sin(rad) + y * Math.cos(rad)) + this.y
        };
    }

    /**
     * Look up a pin descriptor by its number.
     * @param {string|number} num - Pin number
     * @returns {*}
     */
    getPin(num) {
        const key = String(num);
        return this.symbol?.pins?.find((/** @type {any} */ p) => String(p.number) === key);
    }

    /**
     * Move component by delta
     * @param {number} dx
     * @param {number} dy
     */
    move(dx, dy) {
        this.setPosition(this.x + dx, this.y + dy);
        // Move linked field texts by the same delta
        for (const ft of this.getFieldTexts()) {
            ft.x += dx;
            ft.y += dy;
            ft.invalidate();
        }
    }

    /**
     * Get the local-space center in raw (un-mirrored) coordinates.
     * This is the correct frame for use with localToWorld(), which applies
     * its own mirror negation.
     */
    _getLocalCenter() {
        const b = this._getLocalBounds();
        // Remove the padding that _getLocalBounds adds
        let cx = (b.minX + 1.0 + b.maxX - 1.0) / 2;
        const cy = (b.minY + 1.0 + b.maxY - 1.0) / 2;
        // _getLocalBounds returns baked-mirror bounds; undo the swap so
        // the result is in the raw frame that localToWorld expects.
        if (this.mirror) cx = -cx;
        return { x: cx, y: cy };
    }

    /**
     * Rotate component by given degrees around its visual center.
     * @param {number} degrees
     */
    rotate(degrees) {
        // Find world-space center before rotation
        const lc = this._getLocalCenter();
        const beforeCenter = this.localToWorld(lc.x, lc.y);

        this.rotation = (this.rotation + degrees) % 360;
        
        // Find where the center ended up after rotation
        const afterCenter = this.localToWorld(lc.x, lc.y);
        
        // Adjust position to keep the visual center in place
        this.x += beforeCenter.x - afterCenter.x;
        this.y += beforeCenter.y - afterCenter.y;

        this.invalidate();
    }

    /**
     * Flip across the world vertical axis through the visual center.
     */
    flipHorizontal() {
        // Find world-space visual center before flip
        const lc = this._getLocalCenter();
        const beforeCenter = this.localToWorld(lc.x, lc.y);

        const rot = this.rotation || 0;
        this.rotation = (360 - rot) % 360;
        this.mirror = !this.mirror;


        // Adjust position so the visual center stays in place
        const lc2 = this._getLocalCenter();
        const afterCenter = this.localToWorld(lc2.x, lc2.y);
        this.x += beforeCenter.x - afterCenter.x;
        this.y += beforeCenter.y - afterCenter.y;

        this.invalidate();
    }

    /** Backward-compatible alias */
    toggleMirror() { this.flipHorizontal(); }

    /**
     * Flip across the world horizontal axis through the visual center.
     */
    flipVertical() {
        // Find world-space visual center before flip
        const lc = this._getLocalCenter();
        const beforeCenter = this.localToWorld(lc.x, lc.y);

        const rot = this.rotation || 0;
        this.rotation = (180 - rot + 360) % 360;
        this.mirror = !this.mirror;


        // Adjust position so the visual center stays in place
        const lc2 = this._getLocalCenter();
        const afterCenter = this.localToWorld(lc2.x, lc2.y);
        this.x += beforeCenter.x - afterCenter.x;
        this.y += beforeCenter.y - afterCenter.y;

        this.invalidate();
    }

    /**
     * Set the component position and update the SVG transform.
     * @param {number} x - World X
     * @param {number} y - World Y
     */
    setPosition(x, y) {
        this.x = x; this.y = y;
        this.invalidate();
    }

    /**
     * Serialize component to JSON
     */
    toJSON() {
        const _r4 = (/** @type {number} */ v) => Math.round(v * 10000) / 10000;
        /** @type {Record<string,any>} */
        const json = {
            type: 'component',
            id: this.id,
            dn: this.definition.name,
            x: _r4(this.x),
            y: _r4(this.y),
        };
        if (this.rotation) json.rot = this.rotation;
        if (this.mirror) json.mir = true;
        json.ref = this.reference;
        json.val = this.value;
        if (this.packageId !== 'default') json.pkg = this.packageId;
        if (!this.showReference) json.sr = false;
        if (!this.showValue) json.sv = false;
        if (Object.keys(this.properties).length) json.props = this.properties;
        if (!this.visible) json.v = false;
        if (this.locked) json.lk = true;
        
        // Include full definition for online components (KiCad, LCSC, etc.)
        // This ensures the component can be loaded even if the library hasn't cached it
        if (this.definition._source && this.definition._source !== 'Built-in') {
            json.def = {
                name: this.definition.name,
                category: this.definition.category,
                description: this.definition.description,
                symbol: this._cleanSymbol(this.definition.symbol),
                defaultReference: this.definition.defaultReference,
                defaultValue: this.definition.defaultValue,
                defaultProperties: this.definition.defaultProperties,
                _source: this.definition._source
            };
            if (this.definition.supplier_part_numbers) {
                json.def.supplier_part_numbers = this.definition.supplier_part_numbers;
            }
            // Persist footprint pad geometry so the PCB editor can render
            // accurate footprints after save/reload. Round every coordinate to
            // 4 dp (0.1 µm) on the way out — KiCad ships pad/silk positions at
            // 6 decimals, which bloats the file for no visual benefit.
            if (Array.isArray(this.definition.footprintShapes) && this.definition.footprintShapes.length) {
                json.def.footprintShapes = this.definition.footprintShapes.map(_compactShapeStr);
            }
            if (this.definition.footprintBBox) {
                const b = this.definition.footprintBBox;
                json.def.footprintBBox = {
                    x: _r4(b.x), y: _r4(b.y),
                    width: _r4(b.width), height: _r4(b.height),
                };
            }
            if (this.definition.footprintName) {
                json.def.footprintName = this.definition.footprintName;
            }
            // Persist 3D model geometry so the 3D viewer survives save/reload
            // (e.g. autorecover) without re-fetching from the supplier. Compact
            // it on the way out so models cached before compaction existed (or
            // from any other source) are also rounded to 4 dp in the file.
            if (this.definition.model3dObj) {
                json.def.model3dObj = compactObjText(this.definition.model3dObj);
            }
            if (this.definition.model3dUrl) {
                json.def.model3dUrl = this.definition.model3dUrl;
            }
            if (this.definition.model3dName) {
                json.def.model3dName = this.definition.model3dName;
            }
            if (this.definition.has3d) {
                json.def.has3d = this.definition.has3d;
            }
        }
        
        return json;
    }

    /**
     * Create a lean copy of a symbol for serialization, stripping
     * internal/transient fields and rounding coordinates.
     * @param {*} sym
     */
    _cleanSymbol(sym) {
        if (!sym) return sym;
        const _r4 = (/** @type {number} */ v) => Math.round(v * 10000) / 10000;

        // Deep-round all numbers, strip keys starting with '_', and clean specific fields
        const STRIP_KEYS = new Set(['kicadName', '_boundsIncludePins', '_kicadRaw',
            '_easyedaRawShapes', '_coordKey', '_source',
            'pinType', 'shape',                  // pin metadata unused by renderer
            'stroke', 'fill']);                   // graphics always use theme colors
        /** @type {Record<string,any>} */
        const OMIT_DEFAULTS = { strokeWidth: 0.254, kicadNameFontSize: null, kicadNumberFontSize: null };

        /** @type {function(*): *} */
        const deepClean = (val) => {
            if (val == null) return val;
            if (typeof val === 'number') return _r4(val);
            if (typeof val === 'string') {
                // Round floats inside path data strings (e.g. "M 19.380200000000002 4.114800000000001 h 2.54")
                return val.replace(/-?\d+\.\d{5,}/g, m => String(_r4(Number(m))));
            }
            if (Array.isArray(val)) return val.map(deepClean);
            if (typeof val === 'object') {
                /** @type {Record<string,any>} */
                const out = {};
                for (const [k, v] of Object.entries(val)) {
                    if (STRIP_KEYS.has(k)) continue;
                    if (k in OMIT_DEFAULTS && v === OMIT_DEFAULTS[k]) continue;
                    out[k] = deepClean(v);
                }
                return out;
            }
            return val;
        };

        return deepClean(sym);
    }

}
export default Component;