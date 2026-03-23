/**
 * Circle - SVG circle
 */

import { Shape } from './shape.js';
import { ShapeValidator } from '../core/ShapeValidator.js';

/** Round to 4 decimal places for compact serialisation. */
const _r4 = v => Math.round(v * 10000) / 10000;

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
    
    /** @override */
    _calculateBounds() {
        const r = this.radius + this.lineWidth / 2;
        return {
            minX: this.x - r,
            minY: this.y - r,
            maxX: this.x + r,
            maxY: this.y + r
        };
    }
    
    /** @override */
    hitTest(point, tolerance = 0.5) {
        const dist = Math.hypot(point.x - this.x, point.y - this.y);
        
        if (this.fill) {
            return dist <= this.radius + tolerance;
        } else {
            return Math.abs(dist - this.radius) <= tolerance + this.lineWidth / 2;
        }
    }
    
    /** @override */
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
            this.radius = Math.max(0.1, Math.hypot(x - this.x, y - this.y));
        }
        this.invalidate();
        return undefined;
    }
    
    /** @override */
    _createElement() {
        return document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    }
    /** @override */
    _updateElement(el, strokeColor, fillColor, scale) {
        el.setAttribute('cx', this.x);
        el.setAttribute('cy', this.y);
        el.setAttribute('r', this.radius);
        el.setAttribute('stroke', strokeColor);
        el.setAttribute('stroke-width', this._getEffectiveStrokeWidth(scale));
        
        if (this.fill) {
            el.setAttribute('fill', fillColor);
            el.setAttribute('fill-opacity', String(this.fillAlpha));
        } else {
            el.setAttribute('fill', 'none');
            el.removeAttribute('fill-opacity');
        }
    }
    
    /** @override */
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
    captureState() {
        return { x: this.x, y: this.y, radius: this.radius, fill: this.fill };
    }
    /** @override */
    applyState(state) {
        if ('x' in state) this.x = state.x;
        if ('y' in state) this.y = state.y;
        if ('radius' in state) this.radius = state.radius;
        if ('fill' in state) this.fill = state.fill;
        this.invalidate();
    }
    /** @override */
    getPropertyDescriptors() {
        return [
            { key: 'locked',    label: 'Locked',     type: 'checkbox' },
            { key: 'lineWidth', label: 'Line width',  type: 'number', min: 0.05, max: 5, step: 0.05 },
            { key: 'fill',      label: 'Fill',        type: 'checkbox' },
        ];
    }

    /** @override */
    toJSON() {
        const json = { ...super.toJSON(), x: _r4(this.x), y: _r4(this.y), r: _r4(this.radius) };
        if (this.fill) json.f = true;
        if (this.fillAlpha !== 0.3) json.fa = this.fillAlpha;
        return json;
    }
}