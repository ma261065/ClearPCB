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

/** Flag geometry constants (in mm, relative to anchor point) */
const FLAG_PAD_X = 0.6;   // horizontal padding inside flag
const FLAG_PAD_Y = 0.3;   // vertical padding inside flag
const FLAG_TIP  = 1.0;    // width of the pointed tip

export class NetLabel extends Shape {
    /**
     * @param {Object} [options]
     * @param {number} [options.x=0]          - Anchor X (connection point) in mm.
     * @param {number} [options.y=0]          - Anchor Y (connection point) in mm.
     * @param {string} [options.net='NET']    - Net name text.
     * @param {number} [options.fontSize=1.8] - Font size in mm.
     * @param {number} [options.rotation=0]   - Rotation in degrees (0, 90, 180, 270).
     */
    constructor(options = {}) {
        // Default colour to the net-label theme variable
        if (!options.color) options.color = 'var(--sch-net-label, #00cccc)';
        super(options);
        this.type = 'netlabel';

        this.x = ShapeValidator.validateCoordinate(options.x || 0, { name: 'x' });
        this.y = ShapeValidator.validateCoordinate(options.y || 0, { name: 'y' });
        this.net = typeof options.net === 'string' ? options.net : 'NET';
        this.fontSize = ShapeValidator.validateNumber(options.fontSize || 1.8, {
            min: 0.5, max: 20, default: 1.8, name: 'fontSize'
        });
        this.rotation = options.rotation || 0;
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
     * Compute the flag polygon points (untransformed, anchor at origin).
     * Shape: pointed tip on the left, rectangular body on the right.
     *   tip ──┐
     *   ◄     │  text area
     *   tip ──┘
     * @returns {{points: Array<{x:number,y:number}>, textX: number, textY: number, width: number, height: number}}
     */
    _getGeometry() {
        const tw = this._estimateTextWidth();
        const halfH = this.fontSize / 2 + FLAG_PAD_Y;
        const bodyW = tw + FLAG_PAD_X * 2;

        // Flag points: tip at origin, body extends to the right
        const points = [
            { x: 0, y: 0 },                         // tip (connection point)
            { x: FLAG_TIP, y: -halfH },              // top-left of body
            { x: FLAG_TIP + bodyW, y: -halfH },      // top-right
            { x: FLAG_TIP + bodyW, y: halfH },        // bottom-right
            { x: FLAG_TIP, y: halfH },                // bottom-left of body
        ];

        return {
            points,
            textX: FLAG_TIP + FLAG_PAD_X,
            textY: this.fontSize * 0.35,
            width: FLAG_TIP + bodyW,
            height: halfH * 2
        };
    }

    /**
     * Apply rotation transform to a point around origin.
     */
    _rotatePoint(px, py) {
        const rad = (this.rotation * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        return {
            x: px * cos - py * sin,
            y: px * sin + py * cos
        };
    }

    // ─── Shape overrides ───────────────────────────────────────────

    /** @override */
    _calculateBounds() {
        const geo = this._getGeometry();
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of geo.points) {
            const rp = this._rotatePoint(p.x, p.y);
            const wx = this.x + rp.x;
            const wy = this.y + rp.y;
            minX = Math.min(minX, wx);
            minY = Math.min(minY, wy);
            maxX = Math.max(maxX, wx);
            maxY = Math.max(maxY, wy);
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
    getAnchors() {
        return [
            { id: 'pos', x: this.x, y: this.y, cursor: 'move', hidden: true }
        ];
    }

    /** @override */
    moveAnchor(anchorId, x, y) {
        if (anchorId === 'pos') {
            this.x = x;
            this.y = y;
            this.invalidate();
        }
    }

    /** @override */
    _createElement() {
        return document.createElementNS('http://www.w3.org/2000/svg', 'g');
    }

    /** @override */
    _updateElement(el, strokeColor, fillColor, scale) {
        const geo = this._getGeometry();

        // Build polygon path
        const pathData = geo.points
            .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`)
            .join(' ') + ' Z';

        // Ensure children exist
        if (!el.children.length) {
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            el.appendChild(path);
            el.appendChild(text);
        }

        const path = el.children[0];
        const text = el.children[1];

        path.setAttribute('d', pathData);
        path.setAttribute('stroke', strokeColor);
        path.setAttribute('stroke-width', Math.max(this.lineWidth, 1 / scale));
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke-linejoin', 'miter');

        text.setAttribute('x', geo.textX);
        text.setAttribute('y', geo.textY);
        text.setAttribute('fill', fillColor);
        text.setAttribute('font-size', this.fontSize);
        text.setAttribute('font-family', 'Arial');
        text.setAttribute('dominant-baseline', 'central');
        text.setAttribute('text-rendering', 'geometricPrecision');
        text.textContent = this.net;

        // Apply rotation around anchor point
        el.setAttribute('transform', `translate(${this.x}, ${this.y}) rotate(${this.rotation})`);
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
            rotation: this.rotation
        });
    }

    /** @override */
    captureState() {
        return { x: this.x, y: this.y, net: this.net, fontSize: this.fontSize, rotation: this.rotation };
    }

    /** @override */
    getPropertyDescriptors() {
        return [
            { key: 'locked',   label: 'Locked',    type: 'checkbox' },
            { key: 'net',      label: 'Net name',   type: 'text' },
            { key: 'fontSize', label: 'Text size',  type: 'number', min: 0.5, max: 20, step: 0.5 },
            { key: 'rotation', label: 'Rotation',   type: 'select', options: [
                { value: 0, label: '0°' },
                { value: 90, label: '90°' },
                { value: 180, label: '180°' },
                { value: 270, label: '270°' }
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
        const geo = this._getGeometry();
        const rp = this._rotatePoint(geo.textX, 0);
        return { x: this.x + rp.x, y: this.y + rp.y };
    }

    /** @override */
    toJSON() {
        const json = {
            ...super.toJSON(),
            x: _r4(this.x),
            y: _r4(this.y),
            n: this.net,
        };
        if (this.fontSize !== 1.8) json.fs = this.fontSize;
        if (this.rotation !== 0) json.rot = this.rotation;
        return json;
    }
}
