/**
 * Net - Named net connection point
 * 
 * A small flag shape placed on a wire to assign a net name.
 * Two Nets with the same name imply electrical connection
 * without a physical wire between them.
 * 
 * Visual: a text label with a pointed flag outline, connection
 * point at the left tip.
 */

import { Shape } from './shape.js';
import { ShapeValidator } from '../core/ShapeValidator.js';

/** Round to 4 decimal places for compact serialisation. */
const _r4 = v => Math.round(v * 10000) / 10000;

/** Net symbol geometry constants (mm, local space; connection anchor at 0,0). */
const SYMBOL_STEM = 1.0;
const SYMBOL_HALF = 0.8;
const SYMBOL_TIP = 1.7;
const SYMBOL_GAP = 0.3;

/** Text defaults (mm). */
const DEFAULT_FONT_SIZE = 1.4;
const DEFAULT_TEXT_OFFSET = { x: 0, y: 0 };

/** @type {Array<'t'|'gnd'|'arrow'|'chevron'>} */
export const NET_STYLES = ['t', 'gnd', 'arrow', 'chevron'];
/** @type {Array<'N'|'E'|'S'|'W'>} */
export const NET_ORIENTATIONS = ['N', 'E', 'S', 'W'];

/**
 * Normalize Net style to supported values.
 * @param {string} style
 * @returns {'t'|'gnd'|'arrow'|'chevron'}
 */
export function normalizeNetStyle(style) {
    if (NET_STYLES.includes(/** @type {any} */ (style))) {
        return /** @type {any} */ (style);
    }
    return 't';
}

/**
 * Normalize Net orientation to supported values.
 * @param {string} orientation
 * @returns {'N'|'E'|'S'|'W'}
 */
export function normalizeNetOrientation(orientation) {
    if (NET_ORIENTATIONS.includes(/** @type {any} */ (orientation))) {
        return /** @type {any} */ (orientation);
    }
    return 'E';
}

function _orientationDir(orientation) {
    switch (orientation) {
        case 'N': return { x: 0, y: -1 };
        case 'S': return { x: 0, y: 1 };
        case 'W': return { x: -1, y: 0 };
        default: return { x: 1, y: 0 };
    }
}

function _orientationPerp(orientation) {
    const d = _orientationDir(orientation);
    return { x: -d.y, y: d.x };
}

function _worldFromST(origin, orientation, s, t) {
    const d = _orientationDir(orientation);
    const p = _orientationPerp(orientation);
    return {
        x: origin.x + d.x * s + p.x * t,
        y: origin.y + d.y * s + p.y * t
    };
}

/**
 * Convert orientation enum to clockwise SVG rotation in degrees.
 * @param {'N'|'E'|'S'|'W'} orientation
 * @returns {number}
 */
export function netOrientationToRotation(orientation) {
    switch (orientation) {
        case 'N': return 270;
        case 'S': return 90;
        case 'W': return 180;
        default: return 0;
    }
}

/**
 * Convert arbitrary rotation to nearest orientation enum.
 * @param {number} rotation
 * @returns {'N'|'E'|'S'|'W'}
 */
export function netRotationToOrientation(rotation) {
    const norm = ((Math.round(rotation / 90) * 90) % 360 + 360) % 360;
    if (norm === 90) return 'S';
    if (norm === 180) return 'W';
    if (norm === 270) return 'N';
    return 'E';
}

/**
 * Rotate orientation one quarter turn clockwise.
 * @param {'N'|'E'|'S'|'W'} orientation
 * @returns {'N'|'E'|'S'|'W'}
 */
export function rotateNetOrientation(orientation) {
    const list = NET_ORIENTATIONS;
    const idx = list.indexOf(normalizeNetOrientation(orientation));
    return list[(idx + 1) % list.length];
}

/**
 * Estimate symbol width in local +X direction for text placement.
 * @param {'t'|'gnd'|'arrow'|'chevron'} style
 * @returns {number}
 */
export function estimateNetSymbolWidth(style) {
    switch (style) {
        case 'gnd': return SYMBOL_STEM + 0.75;
        case 'arrow': return SYMBOL_TIP;
        case 'chevron': return SYMBOL_TIP;
        default: return SYMBOL_STEM;
    }
}

/**
 * Base text offset along local S-axis from connection point.
 * Positive means in +S direction, negative means in -S direction.
 * @param {'t'|'gnd'|'arrow'|'chevron'} style
 * @returns {number}
 */
export function getNetTextBaseOffsetS(style) {
    return getNetTextBaseLocal(style).s;
}

/**
 * Base text local position from connection point.
 * @param {'t'|'gnd'|'arrow'|'chevron'} style
 * @returns {{s:number,t:number}}
 */
export function getNetTextBaseLocal(style) {
    const width = estimateNetSymbolWidth(style);
    switch (style) {
        case 'gnd':
            // Text past the symbol tip (below when oriented S/down)
            return { s: width + SYMBOL_GAP + 1.2, t: 0 };
        case 'chevron':
            // To the right of the symbol end
            return { s: width + SYMBOL_GAP + 0.3, t: 0.5 };
        default:
            // T & Arrow: text past the symbol tip (above when oriented N/up)
            return { s: width + SYMBOL_GAP + 0.4, t: 0 };
    }
}

function _buildOrientedSymbolPath(style, origin, orientation) {
    const line = (s1, t1, s2, t2) => {
        const p1 = _worldFromST(origin, orientation, s1, t1);
        const p2 = _worldFromST(origin, orientation, s2, t2);
        return `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y}`;
    };

    if (style === 'gnd') {
        return [
            line(0, 0, SYMBOL_STEM, 0)
        ].join(' ');
    }

    if (style === 'arrow') {
        return [
            line(0, 0, SYMBOL_TIP, 0),
            line(SYMBOL_TIP, 0, SYMBOL_TIP - 0.8, -0.65),
            line(SYMBOL_TIP, 0, SYMBOL_TIP - 0.8, 0.65)
        ].join(' ');
    }

    if (style === 'chevron') {
        const cw = 0.55;  // chevron half-height
        const c1 = SYMBOL_STEM;        // first chevron tip position
        const c1b = SYMBOL_STEM + 0.5; // first chevron back
        const c2 = SYMBOL_STEM + 0.35; // second chevron tip
        const c2b = SYMBOL_STEM + 0.85;// second chevron back
        return [
            line(0, 0, SYMBOL_STEM, 0),             // wire stub
            line(c1, 0, c1b, -cw),                   // first < top
            line(c1, 0, c1b, cw),                    // first < bottom
            line(c2, 0, c2b, -cw),                   // second < top
            line(c2, 0, c2b, cw)                     // second < bottom
        ].join(' ');
    }

    return [
        line(0, 0, SYMBOL_STEM, 0),
        line(SYMBOL_STEM, -SYMBOL_HALF, SYMBOL_STEM, SYMBOL_HALF)
    ].join(' ');
}

function _buildGroundBarsPath(origin, orientation) {
    const line = (s1, t1, s2, t2) => {
        const p1 = _worldFromST(origin, orientation, s1, t1);
        const p2 = _worldFromST(origin, orientation, s2, t2);
        return `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y}`;
    };

    return [
        line((SYMBOL_STEM + 0.07), -0.58, (SYMBOL_STEM + 0.07), 0.58),
        line((SYMBOL_STEM + 0.21), -0.42, (SYMBOL_STEM + 0.21), 0.42),
        line((SYMBOL_STEM + 0.37), -0.26, (SYMBOL_STEM + 0.37), 0.26),
        line((SYMBOL_STEM + 0.53), -0.16, (SYMBOL_STEM + 0.53), 0.16)
    ].join(' ');
}

/**
 * Build the secondary ground bars path for gnd style.
 * @param {'N'|'E'|'S'|'W'} [orientation='E']
 * @param {{x:number,y:number}} [origin={x:0,y:0}]
 * @returns {string}
 */
export function buildNetGroundBarsPath(orientation = 'E', origin = { x: 0, y: 0 }) {
    return _buildGroundBarsPath(origin, normalizeNetOrientation(orientation));
}

/**
 * Build symbol path for a style at an orientation and origin.
 * @param {'t'|'gnd'|'arrow'|'chevron'} style
 * @param {'N'|'E'|'S'|'W'} [orientation='E']
 * @param {{x:number,y:number}} [origin={x:0,y:0}]
 * @returns {string}
 */
export function buildNetSymbolPath(style, orientation = 'E', origin = { x: 0, y: 0 }) {
    return _buildOrientedSymbolPath(style, origin, normalizeNetOrientation(orientation));
}

/**
 * Local-space bounds of the visible Net symbol geometry.
 * @param {'t'|'gnd'|'arrow'|'chevron'} style
 * @returns {{minS:number,maxS:number,minT:number,maxT:number}}
 */
function _getSymbolLocalBounds(style) {
    switch (style) {
        case 'gnd':
            return {
                minS: 0,
                maxS: SYMBOL_STEM + 0.53,
                minT: -0.58,
                maxT: 0.58
            };
        case 'arrow':
            return {
                minS: 0,
                maxS: SYMBOL_TIP,
                minT: -0.65,
                maxT: 0.65
            };
        case 'chevron':
            return {
                minS: 0,
                maxS: SYMBOL_STEM + 0.85,
                minT: -0.55,
                maxT: 0.55
            };
        default:
            return {
                minS: 0,
                maxS: SYMBOL_STEM,
                minT: -SYMBOL_HALF,
                maxT: SYMBOL_HALF
            };
    }
}

export class Net extends Shape {
    /**
     * @param {Object} [options]
        * @param {string} [options.id]
        * @param {string} [options.layer]
        * @param {string|number} [options.color]
        * @param {string|number} [options.fillColor]
        * @param {number} [options.lineWidth]
        * @param {boolean} [options.visible]
        * @param {boolean} [options.locked]
     * @param {number} [options.x=0]          - Anchor X (connection point) in mm.
     * @param {number} [options.y=0]          - Anchor Y (connection point) in mm.
     * @param {string} [options.net='NET']    - Net name text.
    * @param {number} [options.fontSize=1.8] - Font size in mm.
    * @param {'t'|'gnd'|'arrow'|'chevron'} [options.style='t'] - Endpoint symbol style.
    * @param {'N'|'E'|'S'|'W'} [options.orientation='N'] - Label orientation.
    * @param {{x:number,y:number}|number[]} [options.textOffset] - Additional text offset (local space, mm).
    * @param {number} [options.rotation=0] - Legacy orientation rotation (kept for backward compatibility).
     */
    constructor(options = {}) {
        // Default color matches standard text labels for visual consistency.
        if (!options.color) options.color = 'var(--sch-text-label, #00b894)';
        super(options);
        this.type = 'net';

        this.x = ShapeValidator.validateCoordinate(options.x || 0, { name: 'x' });
        this.y = ShapeValidator.validateCoordinate(options.y || 0, { name: 'y' });
        this.net = typeof options.net === 'string' ? options.net : 'NET';
        this.fontSize = ShapeValidator.validateNumber(options.fontSize || DEFAULT_FONT_SIZE, {
            min: 0.5, max: 20, default: DEFAULT_FONT_SIZE, name: 'fontSize'
        });
        this.style = normalizeNetStyle(options.style || 't');
        const orientation = options.orientation
            ? normalizeNetOrientation(options.orientation)
            : (Number.isFinite(options.rotation)
                ? netRotationToOrientation(options.rotation || 0)
                : 'N');
        this.orientation = orientation;

        const offset = Array.isArray(options.textOffset)
            ? { x: Number(options.textOffset[0]) || 0, y: Number(options.textOffset[1]) || 0 }
            : (options.textOffset || DEFAULT_TEXT_OFFSET);
        this.textOffset = {
            x: ShapeValidator.validateCoordinate(offset.x || 0, { name: 'textOffset.x' }),
            y: ShapeValidator.validateCoordinate(offset.y || 0, { name: 'textOffset.y' })
        };

        /** @type {import('./text.js').Text|null} */
        this.labelText = null;
    }

    get rotation() {
        return netOrientationToRotation(this.orientation);
    }

    set rotation(v) {
        this.orientation = netRotationToOrientation(Number(v) || 0);
        this.invalidate();
    }

    // ─── Pin interface (reuse component wire-attachment system) ────

    /** Expose a single virtual pin at the connection point so Net labels
     *  work identically to component pins for wire snapping, sticky
     *  wires, bridge nodes, etc. */
    get symbol() {
        return { pins: [{ number: 'conn', x: 0, y: 0 }] };
    }

    /** Return the world position of the connection point. */
    getPinPosition() { return { x: this.x, y: this.y }; }

    // ─── Geometry helpers ──────────────────────────────────────────

    /**
     * Compute symbol geometry used for rendering and hit-testing.
     * @returns {{
     *   symbolPath: string,
     *   corners: Array<{x:number,y:number}>
     * }}
     */
    _getGeometry() {
        const symbolPath = _buildOrientedSymbolPath(this.style, { x: this.x, y: this.y }, this.orientation);
        const ext = _getSymbolLocalBounds(this.style);

        const symbolCorners = [
            _worldFromST({ x: this.x, y: this.y }, this.orientation, ext.minS, ext.minT),
            _worldFromST({ x: this.x, y: this.y }, this.orientation, ext.minS, ext.maxT),
            _worldFromST({ x: this.x, y: this.y }, this.orientation, ext.maxS, ext.minT),
            _worldFromST({ x: this.x, y: this.y }, this.orientation, ext.maxS, ext.maxT)
        ];

        return {
            symbolPath,
            corners: symbolCorners
        };
    }

    /**
     * Apply rotation transform to a point around origin.
     */
    _rotatePoint(px, py) {
        const rad = (netOrientationToRotation(this.orientation) * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        return {
            x: px * cos - py * sin,
            y: px * sin + py * cos
        };
    }

    _worldToLocal(point) {
        const dx = point.x - this.x;
        const dy = point.y - this.y;
        const dir = _orientationDir(this.orientation);
        const perp = _orientationPerp(this.orientation);
        return {
            x: dx * dir.x + dy * dir.y,
            y: dx * perp.x + dy * perp.y
        };
    }

    _localToWorld(point) {
        return _worldFromST({ x: this.x, y: this.y }, this.orientation, point.x, point.y);
    }

    // ─── Shape overrides ───────────────────────────────────────────

    /** @override */
    _calculateBounds() {
        const geo = this._getGeometry();
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of geo.corners) {
            minX = Math.min(minX, p.x);
            minY = Math.min(minY, p.y);
            maxX = Math.max(maxX, p.x);
            maxY = Math.max(maxY, p.y);
        }
        return { minX, minY, maxX, maxY };
    }

    /** @override */
    hitTest(point, tolerance = 0.5) {
        const bounds = this.getBounds();
        return (
            point.x >= bounds.minX - tolerance &&
            point.x <= bounds.maxX + tolerance &&
            point.y >= bounds.minY - tolerance &&
            point.y <= bounds.maxY + tolerance
        );
    }

    /** @override */
    hitTestAnchor(point, scale) {
        const tol = 8 / scale;
        const dist = Math.hypot(point.x - this.x, point.y - this.y);
        if (dist <= tol) {
            return 'pos';
        }
        return null;
    }

    /** @override */
    getAnchors() {
        return [
            { id: 'pos', x: this.x, y: this.y, cursor: 'move', hidden: true }
        ];
    }

    _getTextOriginLocal() {
        const base = getNetTextBaseLocal(this.style);
        return {
            x: base.s + this.textOffset.x,
            y: base.t + this.textOffset.y
        };
    }

    getTextPosition() {
        const local = this._getTextOriginLocal();
        return this._localToWorld(local);
    }

    syncTextOffsetFromLabelText() {
        if (!this.labelText) return;
        const local = this._worldToLocal({ x: this.labelText.x, y: this.labelText.y });
        const base = getNetTextBaseLocal(this.style);
        this.textOffset.x = ShapeValidator.validateCoordinate(local.x - base.s, { name: 'textOffset.x' });
        this.textOffset.y = ShapeValidator.validateCoordinate(local.y - base.t, { name: 'textOffset.y' });
        this.invalidate();
    }

    syncLabelText() {
        if (!this.labelText) return;
        this.labelText.text = this.net;
        this.labelText.fontSize = this.fontSize;
        this.labelText.rotation = 0;
        this.labelText.textAnchor = (this.style === 'chevron') ? 'start' : 'middle';
        const pos = this.getTextPosition();
        this.labelText.x = pos.x;
        this.labelText.y = pos.y;
        this.labelText.invalidate();
    }

    /** @override */
    moveAnchor(anchorId, x, y) {
        if (anchorId === 'pos') {
            const dx = x - this.x;
            const dy = y - this.y;
            this.x = x;
            this.y = y;
            if (this.labelText) {
                this.labelText.x += dx;
                this.labelText.y += dy;
                this.labelText.invalidate();
            }
            this.invalidate();
        }
        return undefined;
    }

    /** @override */
    _createElement() {
        return document.createElementNS('http://www.w3.org/2000/svg', 'g');
    }

    /** @override */
    _updateElement(el, strokeColor, fillColor, scale) {
        const geo = this._getGeometry();

        // Ensure children exist
        if (!el.children.length || el.children.length < 2) {
            while (el.firstChild) el.removeChild(el.firstChild);
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            const detailPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            el.appendChild(path);
            el.appendChild(detailPath);
        }

        const path = el.children[0];
        const detailPath = el.children[1];
        const baseStrokeWidth = Math.max(this.lineWidth, 1 / scale);
        const selectionColor = 'var(--sch-selection, #3399ff)';
        let symbolStroke = strokeColor;

        const attachedLabels = /** @type {any} */ (this).attachedLabels;
        const attachedActive = attachedLabels instanceof Set
            && Array.from(attachedLabels).some(label => label?.selected || label?.hovered);
        if (!this.selected && !this.hovered && (this.labelText?.selected || this.labelText?.hovered || attachedActive)) {
            symbolStroke = selectionColor;
        }

        path.setAttribute('d', geo.symbolPath);
        path.setAttribute('stroke', symbolStroke);
        path.setAttribute('stroke-width', baseStrokeWidth);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke-linejoin', 'round');
        path.setAttribute('stroke-linecap', 'round');

        if (this.style === 'gnd') {
            detailPath.setAttribute('d', _buildGroundBarsPath({ x: this.x, y: this.y }, this.orientation));
            detailPath.setAttribute('stroke', symbolStroke);
            detailPath.setAttribute('stroke-width', Math.max(baseStrokeWidth * 0.32, 0.18 / scale));
            detailPath.setAttribute('fill', 'none');
            detailPath.setAttribute('stroke-linejoin', 'round');
            detailPath.setAttribute('stroke-linecap', 'round');
            detailPath.removeAttribute('display');
        } else {
            detailPath.setAttribute('d', '');
            detailPath.setAttribute('display', 'none');
        }

        // Keep text horizontal by avoiding group rotation.
        el.removeAttribute('transform');
    }

    /** @override */
    move(dx, dy) {
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
        this.x += dx;
        this.y += dy;
        if (this.labelText) {
            this.labelText.x += dx;
            this.labelText.y += dy;
            this.labelText.invalidate();
        }
        this.invalidate();
    }

    /** @override — no visible stroke for hit-test expansion. */
    _getEffectiveStrokeWidth(scale) {
        return 0;
    }

    /** @override */
    clone() {
        this.syncTextOffsetFromLabelText();
        return new Net({
            ...this.toJSON(),
            x: this.x,
            y: this.y,
            net: this.net,
            fontSize: this.fontSize,
            style: this.style,
            orientation: this.orientation,
            textOffset: { ...this.textOffset }
        });
    }

    /** @override */
    captureState() {
        this.syncTextOffsetFromLabelText();
        return {
            x: this.x,
            y: this.y,
            net: this.net,
            fontSize: this.fontSize,
            style: this.style,
            orientation: this.orientation,
            textOffset: { ...this.textOffset }
        };
    }

    /** @override */
    getPropertyDescriptors() {
        return [
            { key: 'locked',   label: 'Locked',    type: 'checkbox' },
            { key: 'net',      label: 'Net name',   type: 'text' },
            { key: 'fontSize', label: 'Text size',  type: 'number', min: 0.5, max: 20, step: 0.5 },
            { key: 'style',    label: 'Style',      type: 'select', options: [
                { value: 't', label: 'T' },
                { value: 'gnd', label: 'GND' },
                { value: 'arrow', label: 'Arrow' },
                { value: 'chevron', label: 'Chevron' }
            ]},
        ];
    }

    /** @override */
    get supportsInlineEdit() {
        return false;
    }

    applyState(state) {
        super.applyState(state);
        this.syncLabelText();
    }

    /** @override */
    toJSON() {
        this.syncTextOffsetFromLabelText();
        const json = {
            ...super.toJSON(),
            x: _r4(this.x),
            y: _r4(this.y),
            n: this.net,
        };
        if (this.fontSize !== DEFAULT_FONT_SIZE) json.fs = this.fontSize;
        if (this.style !== 't') json.nst = this.style;
        if (this.orientation !== 'N') json.no = this.orientation;
        if (Math.abs(this.textOffset.x) > 1e-6 || Math.abs(this.textOffset.y) > 1e-6) {
            json.nto = [_r4(this.textOffset.x), _r4(this.textOffset.y)];
        }
        return json;
    }
}
