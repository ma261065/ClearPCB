/**
 * Rect - SVG rectangle
 */

import { Shape } from './Shape.js';

export class Rect extends Shape {
    constructor(options = {}) {
        super(options);
        this.type = 'rect';
        
        this.x = options.x || 0;
        this.y = options.y || 0;
        this.width = options.width || 10;
        this.height = options.height || 10;
        this.cornerRadius = options.cornerRadius || 0;
    }
    
    _calculateBounds() {
        const hw = this.lineWidth / 2;
        return {
            minX: this.x - hw,
            minY: this.y - hw,
            maxX: this.x + this.width + hw,
            maxY: this.y + this.height + hw
        };
    }
    
    hitTest(point, tolerance = 0.5) {
        const bounds = this.getBounds();
        const expanded = {
            minX: bounds.minX - tolerance,
            minY: bounds.minY - tolerance,
            maxX: bounds.maxX + tolerance,
            maxY: bounds.maxY + tolerance
        };
        
        const insideOuter = point.x >= expanded.minX && point.x <= expanded.maxX &&
                           point.y >= expanded.minY && point.y <= expanded.maxY;
        
        if (!insideOuter) return false;
        if (this.fill) return true;
        
        const inner = {
            minX: this.x + this.lineWidth / 2 + tolerance,
            minY: this.y + this.lineWidth / 2 + tolerance,
            maxX: this.x + this.width - this.lineWidth / 2 - tolerance,
            maxY: this.y + this.height - this.lineWidth / 2 - tolerance
        };
        
        const insideInner = point.x >= inner.minX && point.x <= inner.maxX &&
                           point.y >= inner.minY && point.y <= inner.maxY;
        
        return !insideInner;
    }
    
    distanceTo(point) {
        const cx = this.x + this.width / 2;
        const cy = this.y + this.height / 2;
        
        const dx = Math.max(Math.abs(point.x - cx) - this.width / 2, 0);
        const dy = Math.max(Math.abs(point.y - cy) - this.height / 2, 0);
        
        return Math.hypot(dx, dy);
    }
    
    _createElement() {
        return document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    }
    
    _updateElement(el, strokeColor, fillColor, scale) {
        el.setAttribute('x', this.x);
        el.setAttribute('y', this.y);
        el.setAttribute('width', this.width);
        el.setAttribute('height', this.height);
        el.setAttribute('stroke', strokeColor);
        el.setAttribute('stroke-width', this._getEffectiveStrokeWidth(scale));
        
        if (this.cornerRadius > 0) {
            el.setAttribute('rx', this.cornerRadius);
            el.setAttribute('ry', this.cornerRadius);
        }
        
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
        return new Rect({ ...this.toJSON(), x: this.x, y: this.y, width: this.width, height: this.height, cornerRadius: this.cornerRadius });
    }
    
    toJSON() {
        return { ...super.toJSON(), x: this.x, y: this.y, width: this.width, height: this.height, cornerRadius: this.cornerRadius };
    }
}