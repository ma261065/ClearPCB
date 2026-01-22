/**
 * Arc - SVG arc using path
 */

import { Shape } from './shape.js';

export class Arc extends Shape {
    constructor(options = {}) {
        super(options);
        this.type = 'arc';
        
        this.x = options.x || 0;
        this.y = options.y || 0;
        this.radius = options.radius || 5;
        this.startAngle = options.startAngle || 0;
        this.endAngle = options.endAngle || Math.PI;
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
        
        if (Math.abs(dist - this.radius) > tolerance + this.lineWidth / 2) {
            return false;
        }
        
        let angle = Math.atan2(point.y - this.y, point.x - this.x);
        return this._isAngleInRange(angle);
    }
    
    _isAngleInRange(angle) {
        const normalize = (a) => {
            while (a < 0) a += Math.PI * 2;
            while (a >= Math.PI * 2) a -= Math.PI * 2;
            return a;
        };
        
        const start = normalize(this.startAngle);
        const end = normalize(this.endAngle);
        angle = normalize(angle);
        
        if (start <= end) {
            return angle >= start && angle <= end;
        } else {
            return angle >= start || angle <= end;
        }
    }
    
    distanceTo(point) {
        const dist = Math.hypot(point.x - this.x, point.y - this.y);
        const angle = Math.atan2(point.y - this.y, point.x - this.x);
        
        if (this._isAngleInRange(angle)) {
            return Math.abs(dist - this.radius);
        }
        
        const start = this.getStartPoint();
        const end = this.getEndPoint();
        return Math.min(
            Math.hypot(point.x - start.x, point.y - start.y),
            Math.hypot(point.x - end.x, point.y - end.y)
        );
    }
    
    getStartPoint() {
        return {
            x: this.x + Math.cos(this.startAngle) * this.radius,
            y: this.y + Math.sin(this.startAngle) * this.radius
        };
    }
    
    getEndPoint() {
        return {
            x: this.x + Math.cos(this.endAngle) * this.radius,
            y: this.y + Math.sin(this.endAngle) * this.radius
        };
    }
    
    getAnchors() {
        const start = this.getStartPoint();
        const end = this.getEndPoint();
        return [
            { id: 'center', x: this.x, y: this.y, cursor: 'move' },
            { id: 'start', x: start.x, y: start.y, cursor: 'crosshair' },
            { id: 'end', x: end.x, y: end.y, cursor: 'crosshair' }
        ];
    }
    
    moveAnchor(anchorId, x, y) {
        if (anchorId === 'center') {
            this.x = x;
            this.y = y;
        } else if (anchorId === 'start') {
            this.startAngle = Math.atan2(y - this.y, x - this.x);
            this.radius = Math.max(0.1, Math.hypot(x - this.x, y - this.y));
        } else if (anchorId === 'end') {
            this.endAngle = Math.atan2(y - this.y, x - this.x);
            this.radius = Math.max(0.1, Math.hypot(x - this.x, y - this.y));
        }
        this.invalidate();
    }
    
    _createElement() {
        return document.createElementNS('http://www.w3.org/2000/svg', 'path');
    }
    
    _updateElement(el, strokeColor, fillColor, scale) {
        const start = this.getStartPoint();
        const end = this.getEndPoint();
        
        // Calculate arc sweep
        let sweep = this.endAngle - this.startAngle;
        while (sweep < 0) sweep += Math.PI * 2;
        const largeArc = sweep > Math.PI ? 1 : 0;
        
        const d = `M ${start.x} ${start.y} A ${this.radius} ${this.radius} 0 ${largeArc} 1 ${end.x} ${end.y}`;
        
        el.setAttribute('d', d);
        el.setAttribute('stroke', strokeColor);
        el.setAttribute('stroke-width', this._getEffectiveStrokeWidth(scale));
        el.setAttribute('fill', 'none');
        el.setAttribute('stroke-linecap', 'round');
    }
    
    move(dx, dy) {
        this.x += dx;
        this.y += dy;
        this.invalidate();
    }
    
    clone() {
        return new Arc({ ...this.toJSON(), x: this.x, y: this.y, radius: this.radius, startAngle: this.startAngle, endAngle: this.endAngle });
    }
    
    toJSON() {
        return { ...super.toJSON(), x: this.x, y: this.y, radius: this.radius, startAngle: this.startAngle, endAngle: this.endAngle };
    }
}