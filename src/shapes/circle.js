/**
 * Circle - SVG circle
 */

import { Shape } from './shape.js';

export class Circle extends Shape {
    constructor(options = {}) {
        super(options);
        this.type = 'circle';
        
        this.x = options.x || 0;
        this.y = options.y || 0;
        this.radius = options.radius || 5;
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
        this.x += dx;
        this.y += dy;
        this.invalidate();
    }
    
    clone() {
        return new Circle({ ...this.toJSON(), x: this.x, y: this.y, radius: this.radius });
    }
    
    toJSON() {
        return { ...super.toJSON(), x: this.x, y: this.y, radius: this.radius };
    }
}