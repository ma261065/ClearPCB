/**
 * NoConnect - "X" flag for intentionally unconnected pins
 * 
 * Placed on a component pin to indicate it is deliberately
 * left unconnected. Renders as an "X" cross mark.
 */

import { Shape } from './shape.js';
import { ShapeValidator } from '../core/ShapeValidator.js';

/** Round to 4 decimal places for compact serialisation. */
/** @param {number} v */
const _r4 = v => Math.round(v * 10000) / 10000;

/** Half-size of the X mark in mm */
const NC_HALF = 0.8;

export class NoConnect extends Shape {
    /** @type {'noconnect'} */
    type;

    /**
     * @param {Object} [options]
        * @param {string} [options.id]
        * @param {string} [options.layer]
        * @param {string|number} [options.color]
        * @param {string|number} [options.fillColor]
        * @param {number} [options.lineWidth]
        * @param {boolean} [options.visible]
        * @param {boolean} [options.locked]
     * @param {number} [options.x=0] - Centre X in mm.
     * @param {number} [options.y=0] - Centre Y in mm.
        * @param {{ componentId: string, pinNumber: string|number }|null} [options.pinConnection]
     */
    constructor(options = {}) {
        if (!options.color) options.color = 'var(--sch-no-connect, #cc0000)';
        // NoConnect has a fixed thin stroke
        if (!options.lineWidth) options.lineWidth = 0.25;
        super(options);
        /** @type {'noconnect'} */
        this.type = 'noconnect';

        /** @type {number} */
        this.x = ShapeValidator.validateCoordinate(options.x || 0, { name: 'x' });
        /** @type {number} */
        this.y = ShapeValidator.validateCoordinate(options.y || 0, { name: 'y' });

        /** @type {{ componentId: string, pinNumber: string|number }|null} */
        this.pinConnection = options.pinConnection || null;
        /** @type {Set<import('./text.js').Text>|null|undefined} Labels attached to this no-connect marker. */
        this.attachedLabels = null;
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

    /**
     * @override
     * @param {{x:number,y:number}} point
     */
    hitTest(point, tolerance = 0.5) {
        const d = Math.hypot(point.x - this.x, point.y - this.y);
        return d <= NC_HALF + tolerance;
    }

    /**
     * @override
     * @param {{x:number,y:number}} point
     */
    distanceTo(point) {
        return Math.hypot(point.x - this.x, point.y - this.y);
    }

    /** @override */
    getAnchors() {
        return [
            { id: 'pos', x: this.x, y: this.y, cursor: 'move', hidden: true }
        ];
    }

    /**
     * @override
     * @param {string} anchorId
     * @param {number} x
     * @param {number} y
     */
    moveAnchor(anchorId, x, y) {
        if (anchorId === 'pos') {
            this.x = x;
            this.y = y;
            this.invalidate();
        }
        return undefined;
    }

    /**
     * @override
     * @param {number} dx
     * @param {number} dy
     */
    move(dx, dy) {
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
        this.x += dx;
        this.y += dy;
        this.invalidate();
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
        /** @type {ReturnType<Shape['toJSON']> & {x:number,y:number,pn?: { componentId: string, pinNumber: string|number }}} */
        const json = {
            ...super.toJSON(),
            x: _r4(this.x),
            y: _r4(this.y),
        };
        if (this.pinConnection) json.pn = this.pinConnection;
        return json;
    }
}
