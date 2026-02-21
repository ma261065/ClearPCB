/**
 * Circle - SVG circle
 */

import { Shape } from './shape.js';
import { ShapeValidator } from '../core/ShapeValidator.js';

export class Circle extends Shape {
    constructor(options = {}) {
        super(options);
        this.type = 'circle';
        
        // Validate coordinates and radius
        this.x = ShapeValidator.validateCoordinate(options.x || 0, { name: 'x' });
        this.y = ShapeValidator.validateCoordinate(options.y || 0, { name: 'y' });
        this.radius = ShapeValidator.validateRadius(options.radius || 5);
        
        // Fill properties
        this.fill = options.fill !== undefined ? options.fill : false;
        this.fillColor = ShapeValidator.validateColor(options.fillColor || this.color);
        this.fillAlpha = ShapeValidator.validateNumber(options.fillAlpha ?? 0.3, {
            min: 0, max: 1, default: 0.3, name: 'fillAlpha'
        });
    }
    
    _calculateBounds() {
        const r = this.radius + this.lineWidth / 2;
        return {
            minX: this.x - r,
            minY: this.y - r,
            maxX: this.x + r,
            maxY: this.y + r
        };
    }
    
    hitTest(point, tolerance = 0.5) {
        const dist = Math.hypot(point.x - this.x, point.y - this.y);
        
        if (this.fill) {
            return dist <= this.radius + tolerance;
        } else {
            return Math.abs(dist - this.radius) <= tolerance + this.lineWidth / 2;
        }
    }
    
    distanceTo(point) {
        const dist = Math.hypot(point.x - this.x, point.y - this.y);
        if (this.fill) {
            return Math.max(0, dist - this.radius);
        }
        return Math.abs(dist - this.radius);
    }
    
    getAnchors() {
        return [
            { id: 'center', x: this.x, y: this.y, cursor: 'move' },
            { id: 'radius', x: this.x + this.radius, y: this.y, cursor: 'ew-resize' }
        ];
    }
    
    moveAnchor(anchorId, x, y) {
        if (anchorId === 'center') {
            this.x = x;
            this.y = y;
        } else if (anchorId === 'radius') {
            this.radius = Math.max(0.1, Math.hypot(x - this.x, y - this.y));
        }
        this.invalidate();
    }
    
    _createElement() {
        return document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    }
    
    _updateElement(el, strokeColor, fillColor, scale) {
        el.setAttribute('cx', this.x);
        el.setAttribute('cy', this.y);
        el.setAttribute('r', this.radius);
        el.setAttribute('stroke', strokeColor);
        el.setAttribute('stroke-width', this._getEffectiveStrokeWidth(scale));
        
        if (this.fill) {
            el.setAttribute('fill', fillColor);
            el.setAttribute('fill-opacity', this.fillAlpha);
        } else {
            el.setAttribute('fill', 'none');
        }
    }
    
    move(dx, dy) {
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
        this.x += dx;
        this.y += dy;
        this.invalidate();
    }
    
    clone() {
        return new Circle({ ...this.toJSON(), x: this.x, y: this.y, radius: this.radius });
    }
    
    captureState() {
        return { x: this.x, y: this.y, radius: this.radius };
    }
    
    getPropertyDescriptors() {
        return [
            { key: 'locked',    label: 'Locked',     type: 'checkbox' },
            { key: 'lineWidth', label: 'Line width',  type: 'number', min: 0.05, max: 5, step: 0.05 },
            { key: 'fill',      label: 'Fill',        type: 'checkbox' },
        ];
    }

    toJSON() {
        return { ...super.toJSON(), x: this.x, y: this.y, radius: this.radius, fill: this.fill, fillColor: this.fillColor, fillAlpha: this.fillAlpha };
    }
}