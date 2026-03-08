/**
 * NetLabel - Named net connection point
 * 
 * A small flag shape placed on a wire to assign a net name.
 * Two net labels with the same name imply electrical connection
 * without a physical wire between them.
 * 
 * Visual: a text label with a pointed flag outline, connection
 * point at the left tip.
 */

import { Shape } from './shape.js';
import { ShapeValidator } from '../core/ShapeValidator.js';

/** Round to 4 decimal places for compact serialisation. */
const _r4 = v => Math.round(v * 10000) / 10000;

/** NetLabel symbol geometry constants (mm, local space; connection anchor at 0,0). */
const SYMBOL_STEM = 1.0;
const SYMBOL_HALF = 0.8;
const SYMBOL_TIP = 1.7;
const SYMBOL_GAP = 0.3;

/** Text defaults (mm). */
const DEFAULT_FONT_SIZE = 1.4;
const DEFAULT_TEXT_OFFSET = { x: 0, y: 0 };

/** @type {Array<'t'|'gnd'|'arrow'|'chevron'>} */
export const NETLABEL_STYLES = ['t', 'gnd', 'arrow', 'chevron'];
/** @type {Array<'N'|'E'|'S'|'W'>} */
export const NETLABEL_ORIENTATIONS = ['N', 'E', 'S', 'W'];

/**
 * Normalize netlabel style to supported values.
 * @param {string} style
 * @returns {'t'|'gnd'|'arrow'|'chevron'}
 */
export function normalizeNetLabelStyle(style) {
    if (NETLABEL_STYLES.includes(/** @type {any} */ (style))) {
        return /** @type {any} */ (style);
    }
    return 't';
}

/**
 * Normalize netlabel orientation to supported values.
 * @param {string} orientation
 * @returns {'N'|'E'|'S'|'W'}
 */
export function normalizeNetLabelOrientation(orientation) {
    if (NETLABEL_ORIENTATIONS.includes(/** @type {any} */ (orientation))) {
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
export function netLabelOrientationToRotation(orientation) {
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
export function netLabelRotationToOrientation(rotation) {
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
export function rotateNetLabelOrientation(orientation) {
    const list = NETLABEL_ORIENTATIONS;
    const idx = list.indexOf(normalizeNetLabelOrientation(orientation));
    return list[(idx + 1) % list.length];
}

/**
 * Estimate symbol width in local +X direction for text placement.
 * @param {'t'|'gnd'|'arrow'|'chevron'} style
 * @returns {number}
 */
export function estimateNetLabelSymbolWidth(style) {
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
export function getNetLabelTextBaseOffsetS(style) {
    return getNetLabelTextBaseLocal(style).s;
}

/**
 * Base text local position from connection point.
 * @param {'t'|'gnd'|'arrow'|'chevron'} style
 * @returns {{s:number,t:number}}
 */
export function getNetLabelTextBaseLocal(style) {
    if (style === 'gnd') {
        return { s: -2.6, t: -1.5 };
    }
    return { s: estimateNetLabelSymbolWidth(style) + SYMBOL_GAP, t: 0 };
}

function _buildOrientedSymbolPath(style, origin, orientation) {
    const line = (s1, t1, s2, t2) => {
        const p1 = _worldFromST(origin, orientation, s1, t1);
        const p2 = _worldFromST(origin, orientation, s2, t2);
        return `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y}`;
    };

    if (style === 'gnd') {
        return [
            line(0, 0, -SYMBOL_STEM, 0)
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
        return [
            line(0, 0, SYMBOL_STEM, -0.55),
            line(SYMBOL_STEM, -0.55, SYMBOL_TIP, 0),
            line(SYMBOL_STEM, 0.55, SYMBOL_TIP, 0),
            line(0, 0, SYMBOL_STEM, 0.55),
            line(SYMBOL_STEM + 0.32, -0.55, SYMBOL_TIP + 0.32, 0),
            line(SYMBOL_STEM + 0.32, 0.55, SYMBOL_TIP + 0.32, 0)
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
        line(-(SYMBOL_STEM + 0.07), -0.58, -(SYMBOL_STEM + 0.07), 0.58),
        line(-(SYMBOL_STEM + 0.21), -0.42, -(SYMBOL_STEM + 0.21), 0.42),
        line(-(SYMBOL_STEM + 0.37), -0.26, -(SYMBOL_STEM + 0.37), 0.26),
        line(-(SYMBOL_STEM + 0.53), -0.16, -(SYMBOL_STEM + 0.53), 0.16)
    ].join(' ');
}

/**
 * Build the secondary ground bars path for gnd style.
 * @param {'N'|'E'|'S'|'W'} [orientation='E']
 * @param {{x:number,y:number}} [origin={x:0,y:0}]
 * @returns {string}
 */
export function buildNetLabelGroundBarsPath(orientation = 'E', origin = { x: 0, y: 0 }) {
    return _buildGroundBarsPath(origin, normalizeNetLabelOrientation(orientation));
}

/**
 * Build symbol path for a style at an orientation and origin.
 * @param {'t'|'gnd'|'arrow'|'chevron'} style
 * @param {'N'|'E'|'S'|'W'} [orientation='E']
 * @param {{x:number,y:number}} [origin={x:0,y:0}]
 * @returns {string}
 */
export function buildNetLabelSymbolPath(style, orientation = 'E', origin = { x: 0, y: 0 }) {
    return _buildOrientedSymbolPath(style, origin, normalizeNetLabelOrientation(orientation));
}

export class NetLabel extends Shape {
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
        // Default colour to the net-label theme variable
        if (!options.color) options.color = 'var(--sch-net-label, #00cccc)';
        super(options);
        this.type = 'netlabel';

        this.x = ShapeValidator.validateCoordinate(options.x || 0, { name: 'x' });
        this.y = ShapeValidator.validateCoordinate(options.y || 0, { name: 'y' });
        this.net = typeof options.net === 'string' ? options.net : 'NET';
        this.fontSize = ShapeValidator.validateNumber(options.fontSize || DEFAULT_FONT_SIZE, {
            min: 0.5, max: 20, default: DEFAULT_FONT_SIZE, name: 'fontSize'
        });
        this.style = normalizeNetLabelStyle(options.style || 't');
        const orientation = options.orientation
            ? normalizeNetLabelOrientation(options.orientation)
            : (Number.isFinite(options.rotation)
                ? netLabelRotationToOrientation(options.rotation || 0)
                : 'N');
        this.orientation = orientation;

        const offset = Array.isArray(options.textOffset)
            ? { x: Number(options.textOffset[0]) || 0, y: Number(options.textOffset[1]) || 0 }
            : (options.textOffset || DEFAULT_TEXT_OFFSET);
        this.textOffset = {
            x: ShapeValidator.validateCoordinate(offset.x || 0, { name: 'textOffset.x' }),
            y: ShapeValidator.validateCoordinate(offset.y || 0, { name: 'textOffset.y' })
        };

        /** @type {'symbol'|'text'|null} */
        this._hoverPart = null;
        /** @type {'symbol'|'text'} */
        this._selectedSubPart = 'symbol';
    }

    get rotation() {
        return netLabelOrientationToRotation(this.orientation);
    }

    set rotation(v) {
        this.orientation = netLabelRotationToOrientation(Number(v) || 0);
        this.invalidate();
    }

    // ─── Geometry helpers ──────────────────────────────────────────

    /**
     * Measure approximate text width without relying on DOM.
     * @returns {number} Estimated text width in mm.
     */
    _estimateTextWidth() {
        return this.net.length * this.fontSize * 0.6;
    }

    /**
     * Compute geometry used for rendering, bounds, and hit-testing.
     * @returns {{
     *   symbolPath: string,
     *   textX: number,
     *   textY: number,
     *   textWidth: number,
     *   textHeight: number,
     *   corners: Array<{x:number,y:number}>,
     *   textLocal: {x:number,y:number}
     * }}
     */
    _getGeometry() {
        const symbolWidth = estimateNetLabelSymbolWidth(this.style);
        const textBase = getNetLabelTextBaseLocal(this.style);
        const textLocal = {
            x: textBase.s + this.textOffset.x,
            y: textBase.t + this.textOffset.y
        };
        const textWorld = _worldFromST({ x: this.x, y: this.y }, this.orientation, textLocal.x, textLocal.y);
        const textWidth = this._estimateTextWidth();
        const halfH = this.fontSize / 2;
        const symbolPath = _buildOrientedSymbolPath(this.style, { x: this.x, y: this.y }, this.orientation);

        const symbolCorners = [
            _worldFromST({ x: this.x, y: this.y }, this.orientation, 0, 0),
            _worldFromST({ x: this.x, y: this.y }, this.orientation, symbolWidth, 0),
            _worldFromST({ x: this.x, y: this.y }, this.orientation, symbolWidth, -SYMBOL_HALF),
            _worldFromST({ x: this.x, y: this.y }, this.orientation, symbolWidth, SYMBOL_HALF)
        ];

        return {
            symbolPath,
            textX: textWorld.x,
            textY: textWorld.y,
            textWidth,
            textHeight: this.fontSize,
            corners: [
                ...symbolCorners,
                { x: textWorld.x, y: textWorld.y - halfH },
                { x: textWorld.x + textWidth, y: textWorld.y - halfH },
                { x: textWorld.x + textWidth, y: textWorld.y + halfH },
                { x: textWorld.x, y: textWorld.y + halfH }
            ],
            textLocal
        };
    }

    /**
     * Apply rotation transform to a point around origin.
     */
    _rotatePoint(px, py) {
        const rad = (netLabelOrientationToRotation(this.orientation) * Math.PI) / 180;
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

        const geo = this._getGeometry();
        const minX = geo.textX - tol;
        const maxX = geo.textX + geo.textWidth + tol;
        const minY = geo.textY - geo.textHeight / 2 - tol;
        const maxY = geo.textY + geo.textHeight / 2 + tol;
        if (point.x >= minX && point.x <= maxX && point.y >= minY && point.y <= maxY) {
            return 'text';
        }
        return null;
    }

    /** @override */
    getAnchors() {
        const textWorld = this._localToWorld(this._getTextOriginLocal());
        return [
            { id: 'pos', x: this.x, y: this.y, cursor: 'move', hidden: true },
            { id: 'text', x: textWorld.x, y: textWorld.y, cursor: 'move', hidden: true }
        ];
    }

    _getTextOriginLocal() {
        const geo = this._getGeometry();
        return { ...geo.textLocal };
    }

    /** @override */
    moveAnchor(anchorId, x, y) {
        if (anchorId === 'pos') {
            this.x = x;
            this.y = y;
            this.invalidate();
        } else if (anchorId === 'text') {
            const local = this._worldToLocal({ x, y });
            const base = getNetLabelTextBaseLocal(this.style);
            this.textOffset.x = local.x - base.s;
            this.textOffset.y = local.y - base.t;
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
        if (!el.children.length || el.children.length < 3) {
            while (el.firstChild) el.removeChild(el.firstChild);
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            const detailPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            el.appendChild(path);
            el.appendChild(detailPath);
            el.appendChild(text);
        }

        const path = el.children[0];
        const detailPath = el.children[1];
        const text = el.children[2];
        const baseStrokeWidth = Math.max(this.lineWidth, 1 / scale);
        const normalStroke = this._colorToCSS(this.color);
        const normalText = this._colorToCSS(this.fillColor ?? this.color);
        const selectionColor = 'var(--sch-selection, #3399ff)';
        const hoverPart = this._hoverPart === 'text' ? 'text' : 'symbol';
        const selectedPart = this._selectedSubPart === 'text' ? 'text' : 'symbol';

        let symbolStroke = strokeColor;
        let textFill = fillColor;

        if (this.hovered && !this.selected) {
            if (hoverPart === 'text') {
                symbolStroke = normalStroke;
            } else {
                textFill = normalText;
            }
        }

        if (this.selected) {
            if (selectedPart === 'symbol') {
                textFill = selectionColor;
            }
            if (selectedPart === 'text') {
                symbolStroke = selectionColor;
            }
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

        text.setAttribute('x', geo.textX);
        text.setAttribute('y', geo.textY);
        text.setAttribute('fill', textFill);
        text.setAttribute('font-size', this.fontSize);
        text.setAttribute('font-family', 'Arial');
        text.setAttribute('dominant-baseline', 'middle');
        text.setAttribute('alignment-baseline', 'middle');
        text.setAttribute('text-anchor', 'start');
        text.setAttribute('text-rendering', 'geometricPrecision');
        text.textContent = this.net;

        // Keep text horizontal by avoiding group rotation.
        el.removeAttribute('transform');
    }

    /** @override */
    move(dx, dy) {
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
        this.x += dx;
        this.y += dy;
        this.invalidate();
    }

    /** @override — no visible stroke for hit-test expansion. */
    _getEffectiveStrokeWidth(scale) {
        return 0;
    }

    /** @override */
    clone() {
        return new NetLabel({
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
            { key: 'orientation', label: 'Orientation', type: 'select', options: [
                { value: 'N', label: 'North' },
                { value: 'E', label: 'East' },
                { value: 'S', label: 'South' },
                { value: 'W', label: 'West' }
            ]},
        ];
    }

    /** @override */
    get supportsInlineEdit() {
        return true;
    }

    /** 
     * Get/set the text content for inline editing.
     * Maps to `net` property so double-click editing works.
     */
    get text() { return this.net; }
    set text(v) { this.net = v; this.invalidate(); }

    /**
     * Returns the SVG `<text>` child element for inline text editing.
     * Used by text-edit.js for caret positioning and bbox measurement.
     */
    getTextElement() {
        return this.element?.children?.[1] || null;
    }

    /**
     * Returns the world-space origin for the text-edit overlay.
     * Accounts for rotation by computing the text element's position in world coords.
     */
    getTextEditOrigin() {
        return this._localToWorld(this._getTextOriginLocal());
    }

    /** @override */
    toJSON() {
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
