/**
 * Line - A line segment between two points
 */

import { Shape } from './Shape.js';

export class Line extends Shape {
    constructor(options = {}) {
        super(options);
        this.type = 'line';
        
        // Endpoints
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
        // Distance from point to line segment
        const dx = this.x2 - this.x1;
        const dy = this.y2 - this.y1;
        const lengthSq = dx * dx + dy * dy;
        
        if (lengthSq === 0) {
            // Line is a point
            return Math.hypot(point.x - this.x1, point.y - this.y1);
        }
        
        // Project point onto line, clamped to segment
        let t = ((point.x - this.x1) * dx + (point.y - this.y1) * dy) / lengthSq;
        t = Math.max(0, Math.min(1, t));
        
        const projX = this.x1 + t * dx;
        const projY = this.y1 + t * dy;
        
        return Math.hypot(point.x - projX, point.y - projY);
    }
    
    _draw(g, scale) {
        g.moveTo(this.x1, this.y1);
        g.lineTo(this.x2, this.y2);
    }
    
    _drawHandles(g, scale) {
        const handleSize = 3 / scale;
        
        g.lineStyle(1 / scale, 0xe94560, 1);
        g.beginFill(0xffffff, 1);
        
        // Endpoint handles
        g.drawRect(this.x1 - handleSize/2, this.y1 - handleSize/2, handleSize, handleSize);
        g.drawRect(this.x2 - handleSize/2, this.y2 - handleSize/2, handleSize, handleSize);
        
        g.endFill();
    }
    
    move(dx, dy) {
        this.x1 += dx;
        this.y1 += dy;
        this.x2 += dx;
        this.y2 += dy;
        this.invalidate();
    }
    
    get length() {
        return Math.hypot(this.x2 - this.x1, this.y2 - this.y1);
    }
    
    clone() {
        return new Line({
            ...this.toJSON(),
            x1: this.x1,
            y1: this.y1,
            x2: this.x2,
            y2: this.y2
        });
    }
    
    toJSON() {
        return {
            ...super.toJSON(),
            x1: this.x1,
            y1: this.y1,
            x2: this.x2,
            y2: this.y2
        };
    }
}