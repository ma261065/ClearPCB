import { createLockIcon, LOCK_SIZE } from '../core/ui-helpers.js';
import { Text } from '../shapes/text.js';

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

let compIdCounter = 0;

/**
 * Merge component property objects while stripping dangerous keys
 * (`__proto__`, `constructor`, `prototype`) so that definitions parsed from
 * remote/untrusted sources cannot pollute the prototype chain.
 * @param {Object} [base]
 * @param {Object} [override]
 * @returns {Object}
 */
function _safeMergeProps(base, override) {
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
    if (typeof id === 'string') {
        const match = id.match(/^comp_(\d+)$/);
        if (match) {
            const num = parseInt(match[1], 10);
            if (num >= compIdCounter) compIdCounter = num + 1;
        }
    }
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
     */
    constructor(definition, options = {}) {
        this.id = options.id || `comp_${++compIdCounter}`;
        this.definition = definition;
        this.x = options.x || 0;
        this.y = options.y || 0;
        this.rotation = options.rotation || 0;
        this.mirror = options.mirror || false;
        this.reference = options.reference ?? (definition.defaultReference || 'U?');
        this.value = options.value ?? (definition.defaultValue ?? '');
        this.properties = _safeMergeProps(definition.defaultProperties, options.properties);
        this.element = null;
        this.pinElements = new Map();
        
        // Field text shapes (set by createFieldTexts)
        this.refText = null;
        this.valueText = null;
        this.showReference = options.showReference !== undefined ? options.showReference : true;
        this.showValue = options.showValue !== undefined ? options.showValue : true;
        
        // Selection-related properties
        this.visible = options.visible !== undefined ? options.visible : true;
        this.locked = options.locked !== undefined ? options.locked : false;
        this.selected = false;
        this.hovered = false;

        /** @type {Set<any>|null} */
        this.attachedLabels = null;

        /** @type {SVGRectElement|null} */
        this._highlightEl = null;

        /** @type {SVGGElement|null} */
        this._lockIconEl = null;
    }

    /** @returns {*} The symbol definition (graphics + pins). */
    get symbol() { return this.definition.symbol; }
    /** @returns {string} The component definition name. */
    get name() { return this.definition.name; }

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
     * is placed. Adds them to app.shapes and the viewport.
     * @param {any} app
     */
    createFieldTexts(app) {
        const symbol = this.symbol;
        if (!symbol) return;

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
            text.render(app.viewport.scale);
            app.viewport.addContent(text.element);
        }
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
                 showReference: this.showReference, showValue: this.showValue };
    }

    /**
     * Restore a previously captured state, recreating the SVG element if
     * the rotation or mirror has changed.
     * @param {ComponentState} state - State snapshot from captureState()
     */
    applyState(state) {
        const mirChanged = state.mirror !== undefined && state.mirror !== this.mirror;
        const rotChanged = state.rotation !== undefined && state.rotation !== this.rotation;
        Object.assign(this, state);
        if (mirChanged || rotChanged) {
            this._recreateElement();
        } else if (this.element) {
            const transform = this._buildTransform();
            if (transform) this.element.setAttribute('transform', transform);
            else this.element.removeAttribute('transform');
        }
    }

    /** @returns {'grid'} Components always snap to the grid. */
    getAnchorSnapMode() { return 'grid'; }
    /** No-op — components have no drag state to reset. */
    resetDragState() {}
    /**
     * Return property descriptors for the properties panel.
     * @returns {Array<{key: string, label: string, type: string}>}
     */
    getPropertyDescriptors() {
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
        
        return { minX: worldMinX, minY: worldMinY, maxX: worldMaxX, maxY: worldMaxY };
    }

    /**
     * Set selection state and update visual
     * @param {boolean} selected
     */
    setSelected(selected) {
        this.selected = selected;
        this._updateHighlight();
        // Invalidate field texts so they update their color to reflect parent selection
        for (const ft of this.getFieldTexts()) {
            ft.invalidate();
        }
    }

    /**
     * Called by SelectionManager to update visual state
     */
    invalidate() {
        this._updateHighlight();
        // Invalidate field texts so they update their color to reflect parent selection
        for (const ft of this.getFieldTexts()) {
            ft.invalidate();
        }
    }

    /**
     * Update visual highlight for hover and selection states
     */
    _updateHighlight() {
        if (!this.element) return;
        
        // Check if any field text is selected (ownership highlight)
        const fieldTextSelected = this.getFieldTexts().some(ft => ft.selected);
        
        // Remove highlight if neither hovered, selected, nor field-text-selected
        if (!this.hovered && !this.selected && !fieldTextSelected) {
            if (this._highlightEl) {
                this._highlightEl.remove();
                this._highlightEl = null;
            }
            // Hide all pin dots when deselected
            for (const pinGroup of this.pinElements.values()) {
                const dot = pinGroup.querySelector('circle');
                if (dot) dot.setAttribute('display', 'none');
            }
            return;
        }
        
        const bounds = this.getBounds();
        if (!bounds) return;
        
        const localBounds = this._getLocalBounds();
        const minX = localBounds.minX;
        const minY = localBounds.minY;
        const maxX = localBounds.maxX;
        const maxY = localBounds.maxY;
        
        // Reuse existing highlight element if available
        let highlight = this._highlightEl;
        if (!highlight) {
            const ns = 'http://www.w3.org/2000/svg';
            highlight = document.createElementNS(ns, 'rect');
            highlight.setAttribute('class', 'component-highlight');
            highlight.setAttribute('pointer-events', 'none');
            this._highlightEl = highlight;
        }
        
        highlight.setAttribute('x', String(minX - 0.5));
        highlight.setAttribute('y', String(minY - 0.5));
        highlight.setAttribute('width', String(maxX - minX + 1));
        highlight.setAttribute('height', String(maxY - minY + 1));
        highlight.setAttribute('fill', this.selected ? 'var(--sch-selection-fill, rgba(51,153,255,0.2))' : 'none');
        highlight.setAttribute('stroke', 'var(--sch-selection, #3399ff)');
        highlight.setAttribute('stroke-width', '0.15');
        highlight.setAttribute('stroke-opacity', this.selected ? '0.6' : '0.35');
        highlight.setAttribute('stroke-dasharray', 'none');
        
        // Insert at beginning so it's behind component graphics
        if (!highlight.parentNode || highlight.parentNode !== this.element) {
            this.element.insertBefore(highlight, this.element.firstChild);
        }

        // Show all pin dots when selected
        if (this.selected) {
            for (const pinGroup of this.pinElements.values()) {
                const dot = pinGroup.querySelector('circle');
                if (dot) dot.setAttribute('display', '');
            }
        }
    }

    /**
     * Render the component with optional lock icon
     * @param {number} scale
     */
    render(scale) {
        if (!this.element) return;
        
        // Update highlight for selection/hover
        this._updateHighlight();
        
        // Remove existing lock icon (use cached ref, not querySelector)
        if (this._lockIconEl) {
            this._lockIconEl.remove();
            this._lockIconEl = null;
        }
        
        // Draw lock icon when locked and selected
        if (this.locked && this.selected) {
            const localBounds = this._getLocalBounds();
            const offset = 0.6;
            const lockX = localBounds.minX - offset - LOCK_SIZE;
            const lockY = localBounds.minY - offset - LOCK_SIZE * 0.6;
            this._lockIconEl = createLockIcon(lockX, lockY, this, 'component-lock-icon');
            this.element.appendChild(this._lockIconEl);
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
        
        return {
            minX: minX - padding,
            minY: minY - padding,
            maxX: maxX + padding,
            maxY: maxY + padding
        };
    }

    /**
     * Create the SVG `<g>` element for this component including
     * all graphic shapes and pins.
     * @param {string} [ns='http://www.w3.org/2000/svg'] - SVG namespace
     * @returns {SVGGElement} The component group element
     */
    createSymbolElement(ns = 'http://www.w3.org/2000/svg') {
        const group = /** @type {SVGGElement} */ (document.createElementNS(ns, 'g'));
        group.setAttribute('class', 'component');
        group.setAttribute('data-id', this.id);
        
        const transform = this._buildTransform();
        if (transform) group.setAttribute('transform', transform);

        if (this.symbol?.graphics) {
            for (const graphic of this.symbol.graphics) {
                const el = this._createGraphicElement(graphic, ns);
                if (el) group.appendChild(el);
            }
        }

        if (this.symbol?.pins) {
            for (const pin of this.symbol.pins) {
                // KiCad hides certain pins (e.g. no-connect / duplicate
                // hidden pins). Match KiCad's default view: don't draw them.
                if (pin.hidden) continue;
                const pinGroup = this._createPinElement(pin, ns);
                if (pinGroup) {
                    group.appendChild(pinGroup);
                    const pinKey = pin._key || pin._id || pin.number || `${pin.x},${pin.y}`;
                    this.pinElements.set(pinKey, pinGroup);
                }
            }
        }
        
        this.element = group;
        return group;
    }

    /**
     * Rebuild the component SVG element in-place.
     * Used after rotation/mirror changes since both are baked into element creation.
     */
    _recreateElement() {
        const parent = this.element?.parentNode;
        if (this.element) this.element.remove();
        this.pinElements.clear();
        this.createSymbolElement();
        if (parent && this.element) parent.appendChild(this.element);
    }

    /**
     * Adjust a pin text's local rotation and anchor so it stays readable
     * regardless of the component's rotation.
     *
     * The visual angle is (componentRotation + localRot).  If that falls
     * in the range (90°, 270°] the text would appear upside-down or
     * read top-to-bottom, so we add 180° and flip the text-anchor.
     *
     * @returns {{ rot: number, anchor: string, flipped: boolean }}
     */
    _readablePinText(/** @type {number} */ localRot, /** @type {string} */ anchor) {
        let visual = ((this.rotation + localRot) % 360 + 360) % 360;
        let flipped = false;
        if (visual > 90 && visual <= 270) {
            localRot += 180;
            flipped = true;
            if (anchor === 'start')      anchor = 'end';
            else if (anchor === 'end')   anchor = 'start';
        }
        return { rot: localRot, anchor, flipped };
    }

    /**
     * Create the SVG elements for a single pin (line, connection dot,
     * optional bubble, name and number labels).
     * @param {*} pin - Pin descriptor from the symbol definition
     * @param {string} ns - SVG namespace
     * @returns {SVGGElement} Pin group element
     */
    _createPinElement(pin, ns) {
        const group = /** @type {SVGGElement} */ (document.createElementNS(ns, 'g'));
        const length = Number.isFinite(pin.length) ? pin.length : 0;
        const source = this.symbol?._source || this.definition?._source;
        const m = this.mirror;
        const mx = (/** @type {number} */ x) => m ? -x : x;
        const flipAnchor = (/** @type {string} */ a) => a === 'start' ? 'end' : a === 'end' ? 'start' : a;
        const flipOrient = (/** @type {string} */ o) => o === 'left' ? 'right' : o === 'right' ? 'left' : o;
        const orient = m ? flipOrient(pin.orientation) : pin.orientation;
        
        // Pin connection point
        const connectionX = mx(pin.x); 
        const connectionY = pin.y;
        
        // Line endpoints
        let x1 = mx(pin.x); 
        let y1 = pin.y;
        let x2 = x1, y2 = y1;

        // If we have path data, parse it to get the actual line coordinates
        if (pin._pathData) {
            // Try both space-separated and compact formats
            const pathMatch = pin._pathData.match(/M\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*([hvL])\s*(-?\d+(?:\.\d+)?)/i) ||
                            pin._pathData.match(/M(-?\d+(?:\.\d+)?)[,\s](-?\d+(?:\.\d+)?)([hvL])(-?\d+(?:\.\d+)?)/i);
            
            if (pathMatch) {
                const startX = Number(pathMatch[1]);
                const startY = Number(pathMatch[2]);
                const cmd = pathMatch[3].toLowerCase();
                const value = Number(pathMatch[4]);
                
                x1 = mx(startX);
                y1 = startY;
                
                if (cmd === 'h') {
                    x2 = mx(startX + value);
                    y2 = startY;
                } else if (cmd === 'v') {
                    x2 = mx(startX);
                    y2 = startY + value;
                } else if (cmd === 'l') {
                    x2 = mx(startX + value);
                    y2 = startY;
                }
            }
        } else {
            // Fallback to orientation-based calculation
            switch (orient) {
                case 'right':
                    x2 = x1 + length;
                    break;
                case 'left':
                    x2 = x1 - length;
                    break;
                case 'up':
                    y2 = y1 - length;
                    break;
                case 'down':
                    y2 = y1 + length;
                    break;
            }
        }

        let nameX, nameY, nameAnchor;
        let numX, numY, numAnchor;
        let nameRot = 0;
        let numRot = 0;
        
        const isKiCad = source === 'KiCad';
        const isActiveLow = pin.bubble || pin.name?.includes('~') || pin.name?.includes('/');
        const bubbleRadius = 0.6;
        const dotRadius = 0.35;
        const kicadTextOffset = isKiCad ? (this.symbol?.kicadTextOffset ?? 0.508) : null;

        const hasNamePos = pin.namePos && Number.isFinite(pin.namePos.x) && Number.isFinite(pin.namePos.y);
        const hasNumberPos = pin.numberPos && Number.isFinite(pin.numberPos.x) && Number.isFinite(pin.numberPos.y);
        const allowInfer = !(source === 'EasyEDA');

        if (hasNamePos) {
            nameX = mx(pin.namePos.x);
            nameY = pin.namePos.y;
            nameAnchor = m ? flipAnchor(pin.namePos.anchor || nameAnchor) : (pin.namePos.anchor || nameAnchor);
            if (Number.isFinite(pin.namePos.rotation)) {
                nameRot = pin.namePos.rotation;
            }
        }

        if (hasNumberPos) {
            numX = mx(pin.numberPos.x);
            numY = pin.numberPos.y;
            numAnchor = m ? flipAnchor(pin.numberPos.anchor || numAnchor) : (pin.numberPos.anchor || numAnchor);
            if (Number.isFinite(pin.numberPos.rotation)) {
                numRot = pin.numberPos.rotation;
            }
        }

        if (allowInfer && (!hasNamePos || !hasNumberPos)) {
            if (isKiCad) {
                const dx = x2 - x1;
                const dy = y2 - y1;
                const lineLen = Math.hypot(dx, dy) || 1;
                const ux = dx / lineLen;
                const uy = dy / lineLen;
                const isHorizontal = Math.abs(ux) >= Math.abs(uy);
                const numPerpOffset = Number.isFinite(pin.kicadNumberYOffset)
                    ? pin.kicadNumberYOffset
                    : -0.05;
                const perpX = -uy;
                const perpY = ux;

                if (!hasNamePos) {
                    nameX = x2 + ux * kicadTextOffset;
                    nameY = y2 + uy * kicadTextOffset;
                    if (isHorizontal) {
                        nameAnchor = ux >= 0 ? 'start' : 'end';
                    } else {
                        nameAnchor = uy >= 0 ? 'end' : 'start';
                        nameRot = -90;
                    }
                }

                if (!hasNumberPos) {
                    numX = x2 - ux * kicadTextOffset + perpX * numPerpOffset;
                    numY = y2 - uy * kicadTextOffset + perpY * numPerpOffset;
                    if (isHorizontal) {
                        numAnchor = ux >= 0 ? 'end' : 'start';
                    } else {
                        numAnchor = uy >= 0 ? 'start' : 'end';
                        numRot = -90;
                    }
                }
            } else {
            const labelOffset = length + 0.2;
            // BODY-ANCHOR LOGIC
            // We ensure the number stays close to the body/bubble so it doesn't drift into the connection dot.
            const bubbleClearance = isActiveLow ? (bubbleRadius * 2) + 0.2 : 0;
            const numBodyOffset = 0.5;
            const numPos = length - (bubbleClearance + numBodyOffset);
            
            const numOffsetLR = 0.35;
            const numOffsetUD = 0.5;
            switch (orient) {
                case 'right':
                    if (!hasNamePos) {
                        nameX = x1 + labelOffset; nameY = y1; nameAnchor = 'start';
                    }
                    if (!hasNumberPos) {
                        numX = x1 + numPos; numY = y1 - numOffsetLR; numAnchor = 'middle';
                    }
                    break;
                case 'left':
                    if (!hasNamePos) {
                        nameX = x1 - labelOffset; nameY = y1; nameAnchor = 'end';
                    }
                    if (!hasNumberPos) {
                        numX = x1 - numPos; numY = y1 - numOffsetLR; numAnchor = 'middle';
                    }
                    break;
                case 'up':
                    if (!hasNamePos) {
                        nameX = x1; nameY = y1 - labelOffset; nameAnchor = 'end'; nameRot = 90;
                    }
                    if (!hasNumberPos) {
                        numX = x1 - numOffsetUD; numY = y1 - numPos; numAnchor = 'middle';
                    }
                    break;
                case 'down':
                    if (!hasNamePos) {
                        nameX = x1; nameY = y1 + labelOffset; nameAnchor = 'start'; nameRot = 90;
                    }
                    if (!hasNumberPos) {
                        numX = x1 - numOffsetUD; numY = y1 + numPos; numAnchor = 'middle';
                    }
                    break;
            }
            }
        }

        // When the component rotation makes pin text upside-down,
        // _readablePinText will add 180° to the text rotation.
        // We must also reflect the text position across the pin line
        // so it stays on the correct side visually.
        {
            const _reflectPerp = (/** @type {number} */ vis, /** @type {number} */ tX, /** @type {number} */ tY) => {
                if (vis > 90 && vis <= 270) {
                    if (orient === 'right' || orient === 'left')
                        return { x: tX, y: 2 * y1 - tY };
                    else
                        return { x: 2 * x1 - tX, y: tY };
                }
                return { x: tX, y: tY };
            };
            if (numX !== undefined && numY !== undefined) {
                const numVis = ((this.rotation + numRot) % 360 + 360) % 360;
                const rn = _reflectPerp(numVis, numX, numY);
                numX = rn.x; numY = rn.y;
            }
            if (nameX !== undefined && nameY !== undefined) {
                const nameVis = ((this.rotation + nameRot) % 360 + 360) % 360;
                const rn = _reflectPerp(nameVis, nameX, nameY);
                nameX = rn.x; nameY = rn.y;
            }
        }

        let lineX2 = x2, lineY2 = y2;
        if (isActiveLow) {
            const bOffset = bubbleRadius * 2;
            if (orient === 'right') lineX2 -= bOffset;
            else if (orient === 'left') lineX2 += bOffset;
            else if (orient === 'up') lineY2 += bOffset;
            else if (orient === 'down') lineY2 -= bOffset;
        }

        const line = document.createElementNS(ns, 'line');
        line.setAttribute('x1', String(x1)); line.setAttribute('y1', String(y1));
        line.setAttribute('x2', String(lineX2)); line.setAttribute('y2', String(lineY2));
        line.setAttribute('stroke', 'var(--sch-pin, #aa0000)');
        line.setAttribute('stroke-width', String(0.2));
        group.appendChild(line);

        const dot = document.createElementNS(ns, 'circle');
        dot.setAttribute('cx', String(connectionX)); dot.setAttribute('cy', String(connectionY));
        dot.setAttribute('r', String(dotRadius));
        dot.setAttribute('fill', 'var(--sch-pin, #aa0000)'); 
        dot.setAttribute('stroke', 'none');
        dot.setAttribute('display', 'none');
        group.appendChild(dot);

        if (isActiveLow) {
            const bubble = document.createElementNS(ns, 'circle');
            let bx = x2, by = y2;
            if (orient === 'right') bx -= bubbleRadius;
            else if (orient === 'left') bx += bubbleRadius;
            else if (orient === 'up') by += bubbleRadius;
            else if (orient === 'down') by -= bubbleRadius;
            bubble.setAttribute('cx', String(bx)); bubble.setAttribute('cy', String(by));
            bubble.setAttribute('r', String(bubbleRadius));
            bubble.setAttribute('fill', 'none');
            bubble.setAttribute('stroke', 'var(--sch-pin, #aa0000)');
            bubble.setAttribute('stroke-width', String(0.254));
            group.appendChild(bubble);
        }

        const shouldShowName = pin.name && pin.showName !== false && pin.name !== pin.number;

        if (shouldShowName && (hasNamePos || allowInfer)) {
            const labelGroup = document.createElementNS(ns, 'g');
            const nameTxt = document.createElementNS(ns, 'text');
            const cleanName = pin.name.replace(/[{}]/g, '').replace(/[~/]/g, '');
            const nameFontSizeBase = (pin.namePos && Number.isFinite(pin.namePos.fontSize))
                ? pin.namePos.fontSize
                : (source === 'KiCad' ? (pin.kicadNameFontSize || 1.27) : 1.0);
            const nameFontScale = source === 'KiCad' ? 1.3386 : 1.0;
            const nameFontSize = nameFontSizeBase * nameFontScale;
            const nameFontFamily = (pin.namePos && pin.namePos.fontFamily)
                ? pin.namePos.fontFamily
                : (source === 'EasyEDA' || source === 'KiCad' ? 'Verdana' : null);
            nameTxt.setAttribute('font-size', String(nameFontSize));
            if (nameFontFamily) {
                nameTxt.setAttribute('font-family', nameFontFamily);
            }
            nameTxt.setAttribute('fill', 'var(--sch-pin-name, #00cccc)');
            const nameRead = this._readablePinText(nameRot, nameAnchor || 'start');
            const effNameRot = nameRead.rot;
            const effNameAnchor = nameRead.anchor;
            if (effNameAnchor) {
                nameTxt.setAttribute('text-anchor', effNameAnchor);
            }
            nameTxt.setAttribute('dominant-baseline', 'middle');
            nameTxt.textContent = cleanName;

            if (effNameRot !== 0) {
                labelGroup.setAttribute('transform', `translate(${nameX},${nameY}) rotate(${effNameRot})`);
            } else {
                nameTxt.setAttribute('x', nameX); nameTxt.setAttribute('y', nameY);
            }
            labelGroup.appendChild(nameTxt);

            if (isActiveLow) {
                const overbar = document.createElementNS(ns, 'line');
                const textWidth = cleanName.length * 0.65; 
                let oy = (effNameRot !== 0) ? (nameRead.flipped ? 0.8 : -0.8) : nameY - 0.8; 
                let ox1, ox2;
                if (effNameAnchor === 'start') {
                    ox1 = (effNameRot !== 0) ? 0.1 : nameX + 0.1;
                    ox2 = ox1 + textWidth;
                } else {
                    ox2 = (effNameRot !== 0) ? -0.1 : nameX - 0.1;
                    ox1 = ox2 - textWidth;
                }
                overbar.setAttribute('x1', String(ox1)); overbar.setAttribute('y1', String(oy));
                overbar.setAttribute('x2', String(ox2)); overbar.setAttribute('y2', String(oy));
                overbar.setAttribute('stroke', 'var(--sch-pin-name, #00cccc)'); overbar.setAttribute('stroke-width', String(0.15));
                labelGroup.appendChild(overbar);
            }
            group.appendChild(labelGroup);
        }

        if (pin.number && pin.showNumber !== false && (hasNumberPos || allowInfer)) {
            const numLabelGroup = document.createElementNS(ns, 'g');
            const numTxt = document.createElementNS(ns, 'text');
            const numFontSizeBase = (pin.numberPos && Number.isFinite(pin.numberPos.fontSize))
                ? pin.numberPos.fontSize
                : (source === 'KiCad' ? (pin.kicadNumberFontSize || 1.27) : 0.7);
            const numFontScale = source === 'KiCad' ? 1.3386 : 1.0;
            const numFontSize = numFontSizeBase * numFontScale;
            const numFontFamily = (pin.numberPos && pin.numberPos.fontFamily)
                ? pin.numberPos.fontFamily
                : (source === 'EasyEDA' || source === 'KiCad' ? 'Verdana' : null);
            numTxt.setAttribute('font-size', String(numFontSize));
            if (numFontFamily) {
                numTxt.setAttribute('font-family', numFontFamily);
            }
            numTxt.setAttribute('fill', 'var(--sch-pin-number, #aa0000)');
            const numRead = this._readablePinText(numRot, numAnchor || 'middle');
            const effNumRot = numRead.rot;
            const effNumAnchor = numRead.anchor;
            if (effNumAnchor) {
                numTxt.setAttribute('text-anchor', effNumAnchor);
            }
            if (source === 'KiCad') {
                numTxt.setAttribute('dominant-baseline', 'text-after-edge');
            } else {
                numTxt.setAttribute('dominant-baseline', 'middle');
            }
            numTxt.textContent = pin.number;
            if (effNumRot !== 0) {
                numLabelGroup.setAttribute('transform', `translate(${numX},${numY}) rotate(${effNumRot})`);
            } else {
                numTxt.setAttribute('x', String(numX)); numTxt.setAttribute('y', String(numY));
            }
            numLabelGroup.appendChild(numTxt);
            group.appendChild(numLabelGroup);
        }
        return group;
    }

    /**
     * Create an SVG element for a graphics primitive (rect, circle, line,
     * polyline, polygon, arc, path, or text). Colours are replaced with
     * CSS custom properties for theming; mirror is applied to X coordinates.
     * @param {*} g - Graphics descriptor from the symbol definition
     * @param {string} ns - SVG namespace
     * @returns {SVGElement|null} The created element, or null if skipped
     */
    _createGraphicElement(g, ns) {
        /** @type {SVGElement|null} */
        let el = null;
        // Ignore colors from component data, use themed colors
        const stroke = 'var(--sch-symbol-outline, #000000)';
        const fill = 'none';
        const m = this.mirror;
        const mx = (/** @type {number} */ x) => m ? -x : x;
        switch (g.type) {
            case 'rect':
                el = /** @type {SVGElement} */ (document.createElementNS(ns, 'rect'));
                el.setAttribute('x', m ? -(g.x + g.width) : g.x); el.setAttribute('y', g.y);
                el.setAttribute('width', g.width); el.setAttribute('height', g.height);
                if (Number.isFinite(g.rx)) el.setAttribute('rx', g.rx);
                if (Number.isFinite(g.ry)) el.setAttribute('ry', g.ry);
                break;
            case 'circle':
                el = /** @type {SVGElement} */ (document.createElementNS(ns, 'circle'));
                el.setAttribute('cx', String(mx(g.cx))); el.setAttribute('cy', String(g.cy)); el.setAttribute('r', String(g.r));
                break;
            case 'line':
                el = /** @type {SVGElement} */ (document.createElementNS(ns, 'line'));
                el.setAttribute('x1', String(mx(g.x1))); el.setAttribute('y1', String(g.y1));
                el.setAttribute('x2', String(mx(g.x2))); el.setAttribute('y2', String(g.y2));
                break;
            case 'polyline':
                el = /** @type {SVGElement} */ (document.createElementNS(ns, 'polyline'));
                const pts = g.points.map((/** @type {any} */ p) => `${mx(p[0])},${p[1]}`).join(' ');
                el.setAttribute('points', pts);
                break;
            case 'polygon':
                el = /** @type {SVGElement} */ (document.createElementNS(ns, 'polygon'));
                const polPts = g.points.map((/** @type {any} */ p) => `${mx(p[0])},${p[1]}`).join(' ');
                el.setAttribute('points', polPts);
                break;
            case 'arc': {
                el = /** @type {SVGElement} */ (document.createElementNS(ns, 'path'));
                const r = g.r || 1;
                const sa = (g.startAngle || 0) * Math.PI / 180;
                const ea = (g.endAngle || 0) * Math.PI / 180;
                const cx = mx(g.cx);
                if (m) {
                    // Mirror reflects angles: angle -> PI - angle, and swap start/end
                    const msa = Math.PI - ea;
                    const mea = Math.PI - sa;
                    const sx = cx + r * Math.cos(msa);
                    const sy = g.cy + r * Math.sin(msa);
                    const ex = cx + r * Math.cos(mea);
                    const ey = g.cy + r * Math.sin(mea);
                    let delta = mea - msa;
                    if (delta < 0) delta += 2 * Math.PI;
                    const largeArc = delta > Math.PI ? 1 : 0;
                    el.setAttribute('d', `M${sx},${sy} A${r},${r} 0 ${largeArc} 1 ${ex},${ey}`);
                } else {
                    const sx = g.cx + r * Math.cos(sa);
                    const sy = g.cy + r * Math.sin(sa);
                    const ex = g.cx + r * Math.cos(ea);
                    const ey = g.cy + r * Math.sin(ea);
                    let delta = ea - sa;
                    if (delta < 0) delta += 2 * Math.PI;
                    const largeArc = delta > Math.PI ? 1 : 0;
                    el.setAttribute('d', `M${sx},${sy} A${r},${r} 0 ${largeArc} 1 ${ex},${ey}`);
                }
                break;
            }
            case 'path':
                el = /** @type {SVGElement} */ (document.createElementNS(ns, 'path'));
                if (m) {
                    // Wrap path in a group with scale(-1,1) to mirror it
                    // (parsing SVG path data to negate x is fragile)
                    const wrapper = document.createElementNS(ns, 'g');
                    wrapper.setAttribute('transform', 'scale(-1,1)');
                    el.setAttribute('d', g.d);
                    el.setAttribute('stroke', stroke); el.setAttribute('fill', fill);
                    el.setAttribute('stroke-width', String(g.strokeWidth || 0.254));
                    el.setAttribute('stroke-linecap', 'round');
                    el.setAttribute('stroke-linejoin', 'round');
                    if (g.transform) el.setAttribute('transform', g.transform);
                    wrapper.appendChild(el);
                    return /** @type {SVGElement} */ (wrapper);
                }
                el.setAttribute('d', g.d);
                break;
            case 'text': {
                const tmpl = g.text || '';
                // Skip template text — these are rendered as independent field Text shapes
                if (tmpl.includes('${REF}') || tmpl.includes('${VALUE}')) return null;
                el = /** @type {SVGElement} */ (document.createElementNS(ns, 'text'));
                el.setAttribute('x', String(mx(g.x))); el.setAttribute('y', String(g.y));
                const textSize = g.fontSize || 1.5;
                const source = this.symbol?._source || this.definition?._source;
                const textScale = source === 'KiCad' ? 1.6 : 1.0;
                el.setAttribute('font-size', String(textSize * textScale));
                if (source === 'KiCad') {
                    el.setAttribute('font-family', 'Verdana');
                }
                el.setAttribute('fill', 'var(--sch-text, #cccccc)');
                const anchor = g.anchor || 'start';
                el.setAttribute('text-anchor', m ? (anchor === 'start' ? 'end' : anchor === 'end' ? 'start' : anchor) : anchor);
                if (g.baseline) {
                    el.setAttribute('dominant-baseline', g.baseline);
                } else {
                    el.setAttribute('dominant-baseline', 'middle');
                }
                el.textContent = tmpl;
                if (g.transform) {
                    el.setAttribute('transform', g.transform);
                }
                return el;
            }
        }
        if (el) {
            el.setAttribute('stroke', stroke); el.setAttribute('fill', fill);
            el.setAttribute('stroke-width', String(g.strokeWidth || 0.254));
            el.setAttribute('stroke-linecap', 'round');
            el.setAttribute('stroke-linejoin', 'round');
            if (g.transform) {
                el.setAttribute('transform', g.transform);
            }
        }
        return el;
    }

    /**
     * Build the SVG transform string for the component's position and rotation.
     * @returns {string|null} e.g. 'translate(10,20) rotate(90)', or null if at origin with no rotation
     */
    _buildTransform() {
        const parts = [];
        if (this.x || this.y) parts.push(`translate(${this.x},${this.y})`);
        if (this.rotation) parts.push(`rotate(${this.rotation})`);
        return parts.length ? parts.join(' ') : null;
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

        // Recreate SVG so pin text readability corrections are refreshed
        this._recreateElement();
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

        // Recreate SVG since mirror/rotation are baked into element creation
        this._recreateElement();

        // Adjust position so the visual center stays in place
        const lc2 = this._getLocalCenter();
        const afterCenter = this.localToWorld(lc2.x, lc2.y);
        this.x += beforeCenter.x - afterCenter.x;
        this.y += beforeCenter.y - afterCenter.y;

        if (this.element) {
            const transform = this._buildTransform();
            if (transform) {
                this.element.setAttribute('transform', transform);
            } else {
                this.element.removeAttribute('transform');
            }
        }
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

        // Recreate SVG since mirror/rotation are baked into element creation
        this._recreateElement();

        // Adjust position so the visual center stays in place
        const lc2 = this._getLocalCenter();
        const afterCenter = this.localToWorld(lc2.x, lc2.y);
        this.x += beforeCenter.x - afterCenter.x;
        this.y += beforeCenter.y - afterCenter.y;

        if (this.element) {
            const transform = this._buildTransform();
            if (transform) {
                this.element.setAttribute('transform', transform);
            } else {
                this.element.removeAttribute('transform');
            }
        }
    }

    /**
     * Set the component position and update the SVG transform.
     * @param {number} x - World X
     * @param {number} y - World Y
     */
    setPosition(x, y) {
        this.x = x; this.y = y;
        if (this.element) {
            const transform = this._buildTransform();
            if (transform) {
                this.element.setAttribute('transform', transform);
            } else {
                this.element.removeAttribute('transform');
            }
        }
    }

    /**
     * Remove component from DOM
     */
    destroy() {
        if (this.element && this.element.parentNode) {
            this.element.parentNode.removeChild(this.element);
        }
        this.element = null;
        this.pinElements.clear();
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
            // accurate footprints after save/reload.
            if (Array.isArray(this.definition.footprintShapes) && this.definition.footprintShapes.length) {
                json.def.footprintShapes = this.definition.footprintShapes;
            }
            if (this.definition.footprintBBox) {
                json.def.footprintBBox = this.definition.footprintBBox;
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