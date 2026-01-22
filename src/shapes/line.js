/**
 * Line - SVG line segment
 */

import { Shape } from './Shape.js';

export class Line extends Shape {
    constructor(options = {}) {
        super(options);
        this.type = 'line';
        
        this.x1 = options.x1 || 0;
        this.y1 = options.y1 || 0;
        this.x2 = options.x2 || 0;
        this.y2 = options.y2 || 0;
    }
    
    _calculateBounds() {
        const hw = this.lineWidth / 2;
        return {
            minX: Math.min(this.x1, this.x2) - hw,
            minY: Math.min(this.y1, this.y2) - hw,
            maxX: Math.max(this.x1, this.x2) + hw,
            maxY: Math.max(this.y1, this.y2) + hw
        };
    }
    
    hitTest(point, tolerance = 0.5) {
        return this.distanceTo(point) <= tolerance + this.lineWidth / 2;
    }
    
    distanceTo(point) {
        const dx = this.x2 - this.x1;
        const dy = this.y2 - this.y1;
        const lengthSq = dx * dx + dy * dy;
        
        if (lengthSq === 0) {
            return Math.hypot(point.x - this.x1, point.y - this.y1);
        }
        
        let t = ((point.x - this.x1) * dx + (point.y - this.y1) * dy) / lengthSq;
        t = Math.max(0, Math.min(1, t));
        
        const projX = this.x1 + t * dx;
        const projY = this.y1 + t * dy;
        
        return Math.hypot(point.x - projX, point.y - projY);
    }
    
    _createElement() {
        return document.createElementNS('http://www.w3.org/2000/svg', 'line');
    }
    
    _updateElement(el, strokeColor, fillColor, scale) {
        el.setAttribute('x1', this.x1);
        el.setAttribute('y1', this.y1);
        el.setAttribute('x2', this.x2);
        el.setAttribute('y2', this.y2);
        el.setAttribute('stroke', strokeColor);
        el.setAttribute('stroke-width', this._getEffectiveStrokeWidth(scale));
        el.setAttribute('stroke-linecap', 'round');
    }
    
    move(dx, dy) {
        this.x1 += dx;
        this.y1 += dy;
        this.x2 += dx;
        this.y2 += dy;
        this.invalidate();
    }
    
    clone() {
        return new Line({ ...this.toJSON(), x1: this.x1, y1: this.y1, x2: this.x2, y2: this.y2 });
    }
    
    toJSON() {
        return { ...super.toJSON(), x1: this.x1, y1: this.y1, x2: this.x2, y2: this.y2 };
    }
}