/**
 * Circle - SVG circle
 */

import { Shape } from './shape.js';
import { ShapeValidator } from '../core/ShapeValidator.js';
import { circleOuterRadius, circleHitTest } from './path-geometry.js';

/** Round to 4 decimal places for compact serialisation. */
/** @param {number} v */
const _r4 = v => Math.round(v * 10000) / 10000;

/** @typedef {{x:number,y:number}} Point */
/** @typedef {{x?: number, y?: number, radius?: number, fill?: boolean, lineWidth?: number}} CircleState */
/** @typedef {ReturnType<Shape['toJSON']> & {x: number, y: number, r: number, f?: true, fa?: number}} CircleJSON */

export class Circle extends Shape {
    /**
     * @param {Object} [options]
        * @param {string|number} [options.color] - Stroke colour.
        * @param {number} [options.lineWidth] - Stroke width in mm.
     * @param {number} [options.x=0]      - Centre X in mm.
     * @param {number} [options.y=0]      - Centre Y in mm.
     * @param {number} [options.radius=5] - Radius in mm.
     * @param {boolean} [options.fill=false] - Whether the circle is filled.
     * @param {string}  [options.fillColor]  - Fill colour (defaults to stroke).
     * @param {number}  [options.fillAlpha=0.3] - Fill opacity.
     */
    constructor(options = {}) {
        super(options);
        this.type = 'circle';
        
        // Validate coordinates and radius
        this.x = ShapeValidator.validateCoordinate(options.x || 0, { name: 'x' });
        this.y = ShapeValidator.validateCoordinate(options.y || 0, { name: 'y' });
        this.radius = ShapeValidator.validateRadius(options.radius || 5);
        
        // Fill properties
        this.fill = options.fill !== undefined ? options.fill : false;
        this.fillAlpha = ShapeValidator.validateNumber(options.fillAlpha ?? 0.3, {
            min: 0, max: 1, default: 0.3, name: 'fillAlpha'
        });
    }
    
    get diameter() { return this.radius * 2; }

    set diameter(value) {
        if (!Number.isFinite(value)) return;
        this.radius = Math.max(0.05, value / 2);
        this.lineWidth = Math.min(this.lineWidth, this.radius);
        this.invalidate();
    }

    /** @override */
    _calculateBounds() {
        const r = circleOuterRadius(this);
        return {
            minX: this.x - r,
            minY: this.y - r,
            maxX: this.x + r,
            maxY: this.y + r
        };
    }
    
    /** @override */
    /** @param {Point} point @param {number} [tolerance] */
    hitTest(point, tolerance = 0.5) {
        return circleHitTest(this, point, tolerance, this.fill, this.lineWidth);
    }
    
    /** @override */
    /** @param {Point} point */
    distanceTo(point) {
        const dist = Math.hypot(point.x - this.x, point.y - this.y);
        if (this.fill) {
            return Math.max(0, dist - this.radius);
        }
        return Math.abs(dist - this.radius);
    }
    
    /** @override */
    getAnchors() {
        return [
            { id: 'center', x: this.x, y: this.y, cursor: 'move' },
            { id: 'radius', x: this.x + this.radius, y: this.y, cursor: 'ew-resize' }
        ];
    }
    
    /**
     * @override
     * @param {string} anchorId
     * @param {number} x
     * @param {number} y
     * @returns {string|undefined}
     */
    moveAnchor(anchorId, x, y) {
        if (anchorId === 'center') {
            this.x = x;
            this.y = y;
        } else if (anchorId === 'radius') {
            this.radius = Math.max(0.05, Math.hypot(x - this.x, y - this.y));
        }
        this.invalidate();
        return undefined;
    }
    
    /** @override */
    /** @param {number} dx @param {number} dy */
    move(dx, dy) {
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
        this.x += dx;
        this.y += dy;
        this.invalidate();
    }
    
    /** @override */
    clone() {
        return new Circle({ ...this.toJSON(), x: this.x, y: this.y, radius: this.radius });
    }
    /** @override */
    /** @returns {{x:number,y:number,radius:number,fill:boolean,lineWidth:number}} */
    captureState() {
        return { x: this.x, y: this.y, radius: this.radius, fill: this.fill, lineWidth: this.lineWidth };
    }
    /** @override */
    /** @param {CircleState} state */
    applyState(state) {
        if ('x' in state) this.x = /** @type {number} */ (state.x);
        if ('y' in state) this.y = /** @type {number} */ (state.y);
        if ('radius' in state) this.radius = /** @type {number} */ (state.radius);
        if ('lineWidth' in state) this.lineWidth = /** @type {number} */ (state.lineWidth);
        if ('fill' in state) this.fill = /** @type {boolean} */ (state.fill);
        this.invalidate();
    }
    /** @override */
    getPropertyDescriptors() {
        return [
            // The diameter includes the line width, so it is ordered after it (see property-order.js).
            { key: 'diameter', orderKey: 'outerDiameter', label: 'Outer Diameter (mm)', type: 'number', min: 0.15, step: 0.1 },
            { key: 'locked',    label: 'Locked',     type: 'checkbox' },
            { key: 'lineWidth', label: 'Line Width (mm)',  type: 'number', min: 0.05, max: 5, step: 0.05 },
            { key: 'fill',      label: 'Fill',        type: 'checkbox' },
        ];
    }

    /** @override */
    toJSON() {
        const json = /** @type {CircleJSON} */ ({ ...super.toJSON(), x: _r4(this.x), y: _r4(this.y), r: _r4(this.radius) });
        if (this.fill) json.f = true;
        if (this.fillAlpha !== 0.3) json.fa = this.fillAlpha;
        return json;
    }
}