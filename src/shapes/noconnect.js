/**
 * NoConnect - "X" flag for intentionally unconnected pins
 * 
 * Placed on a component pin to indicate it is deliberately
 * left unconnected. Renders as an "X" cross mark.
 */

import { Shape } from './shape.js';
import { ShapeValidator } from '../core/ShapeValidator.js';

/** Round to 4 decimal places for compact serialisation. */
const _r4 = v => Math.round(v * 10000) / 10000;

/** Half-size of the X mark in mm */
const NC_HALF = 0.8;

export class NoConnect extends Shape {
    /**
     * @param {Object} [options]
     * @param {number} [options.x=0] - Centre X in mm.
     * @param {number} [options.y=0] - Centre Y in mm.
     */
    constructor(options = {}) {
        if (!options.color) options.color = 'var(--sch-no-connect, #cc0000)';
        // NoConnect has a fixed thin stroke
        if (!options.lineWidth) options.lineWidth = 0.25;
        super(options);
        this.type = 'noconnect';

        this.x = ShapeValidator.validateCoordinate(options.x || 0, { name: 'x' });
        this.y = ShapeValidator.validateCoordinate(options.y || 0, { name: 'y' });

        /** @type {{ componentId: string, pinNumber: string|number }|null} */
        this.pinConnection = options.pinConnection || null;
    }

    // ─── Shape overrides ───────────────────────────────────────────

    /** @override */
    _calculateBounds() {
        return {
            minX: this.x - NC_HALF,
            minY: this.y - NC_HALF,
            maxX: this.x + NC_HALF,
            maxY: this.y + NC_HALF
        };
    }

    /** @override */
    hitTest(point, tolerance = 0.5) {
        const d = Math.hypot(point.x - this.x, point.y - this.y);
        return d <= NC_HALF + tolerance;
    }

    /** @override */
    distanceTo(point) {
        return Math.hypot(point.x - this.x, point.y - this.y);
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
        const sw = Math.max(this.lineWidth, 1.5 / scale);

        // Ensure two lines exist
        if (el.children.length < 2) {
            el.innerHTML = '';
            el.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'line'));
            el.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'line'));
        }

        const line1 = el.children[0];
        const line2 = el.children[1];

        // Diagonal 1: top-left to bottom-right
        line1.setAttribute('x1', this.x - NC_HALF);
        line1.setAttribute('y1', this.y - NC_HALF);
        line1.setAttribute('x2', this.x + NC_HALF);
        line1.setAttribute('y2', this.y + NC_HALF);
        line1.setAttribute('stroke', strokeColor);
        line1.setAttribute('stroke-width', sw);
        line1.setAttribute('stroke-linecap', 'round');

        // Diagonal 2: top-right to bottom-left
        line2.setAttribute('x1', this.x + NC_HALF);
        line2.setAttribute('y1', this.y - NC_HALF);
        line2.setAttribute('x2', this.x - NC_HALF);
        line2.setAttribute('y2', this.y + NC_HALF);
        line2.setAttribute('stroke', strokeColor);
        line2.setAttribute('stroke-width', sw);
        line2.setAttribute('stroke-linecap', 'round');
    }

    /** @override */
    move(dx, dy) {
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
        this.x += dx;
        this.y += dy;
        this.invalidate();
    }

    /** @override — no fill, minimal stroke for hit expansion. */
    _getEffectiveStrokeWidth(scale) {
        return Math.max(this.lineWidth, 1.5 / scale);
    }

    /** @override */
    clone() {
        return new NoConnect({
            x: this.x,
            y: this.y,
            color: this.color,
            pinConnection: this.pinConnection ? { ...this.pinConnection } : null,
        });
    }

    /** @override */
    captureState() {
        return {
            x: this.x,
            y: this.y,
            pinConnection: this.pinConnection ? { ...this.pinConnection } : null
        };
    }

    /** @override */
    getPropertyDescriptors() {
        return [
            { key: 'locked', label: 'Locked', type: 'checkbox' },
        ];
    }

    /** @override */
    toJSON() {
        const json = {
            ...super.toJSON(),
            x: _r4(this.x),
            y: _r4(this.y),
        };
        if (this.pinConnection) json.pn = this.pinConnection;
        return json;
    }
}
