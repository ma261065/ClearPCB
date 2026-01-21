/**
 * Circle - A circle defined by center and radius
 */

import { Shape } from './Shape.js';

export class Circle extends Shape {
    constructor(options = {}) {
        super(options);
        this.type = 'circle';
        
        // Center and radius
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
        const dist = this.distanceTo(point);
        
        if (this.fill) {
            // Filled circle - hit if inside
            return dist <= this.radius + tolerance;
        } else {
            // Stroke only - hit if near edge
            return Math.abs(dist - this.radius) <= tolerance + this.lineWidth / 2;
        }
    }
    
    distanceTo(point) {
        const dist = Math.hypot(point.x - this.x, point.y - this.y);
        
        if (this.fill) {
            return Math.max(0, dist - this.radius);
        } else {
            return Math.abs(dist - this.radius);
        }
    }
    
    _draw(g, scale) {
        g.drawCircle(this.x, this.y, this.radius);
    }
    
    _drawHandles(g, scale) {
        const handleSize = 3 / scale;
        
        g.lineStyle(1 / scale, 0xe94560, 1);
        g.beginFill(0xffffff, 1);
        
        // Center handle
        g.drawRect(this.x - handleSize/2, this.y - handleSize/2, handleSize, handleSize);
        
        // Cardinal handles
        const cardinals = [
            { x: this.x + this.radius, y: this.y },
            { x: this.x - this.radius, y: this.y },
            { x: this.x, y: this.y + this.radius },
            { x: this.x, y: this.y - this.radius }
        ];
        
        cardinals.forEach(c => {
            g.drawRect(c.x - handleSize/2, c.y - handleSize/2, handleSize, handleSize);
        });
        
        g.endFill();
    }
    
    move(dx, dy) {
        this.x += dx;
        this.y += dy;
        this.invalidate();
    }
    
    get area() {
        return Math.PI * this.radius * this.radius;
    }
    
    get circumference() {
        return 2 * Math.PI * this.radius;
    }
    
    clone() {
        return new Circle({
            ...this.toJSON(),
            x: this.x,
            y: this.y,
            radius: this.radius
        });
    }
    
    toJSON() {
        return {
            ...super.toJSON(),
            x: this.x,
            y: this.y,
            radius: this.radius
        };
    }
}