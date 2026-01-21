/**
 * Arc - A circular arc defined by center, radius, and angles
 */

import { Shape } from './Shape.js';

export class Arc extends Shape {
    constructor(options = {}) {
        super(options);
        this.type = 'arc';
        
        // Center and radius
        this.x = options.x || 0;
        this.y = options.y || 0;
        this.radius = options.radius || 5;
        
        // Start and end angles in radians (0 = right, PI/2 = down)
        this.startAngle = options.startAngle || 0;
        this.endAngle = options.endAngle || Math.PI;
    }
    
    _calculateBounds() {
        // Conservative bounds - full circle extent
        // Could be optimized to use actual arc extent
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
        
        // Check if at correct distance
        if (Math.abs(dist - this.radius) > tolerance + this.lineWidth / 2) {
            return false;
        }
        
        // Check if within angle range
        let angle = Math.atan2(point.y - this.y, point.x - this.x);
        return this._isAngleInRange(angle);
    }
    
    _isAngleInRange(angle) {
        // Normalize angles to [0, 2*PI)
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
            // Arc crosses 0
            return angle >= start || angle <= end;
        }
    }
    
    distanceTo(point) {
        const dist = Math.hypot(point.x - this.x, point.y - this.y);
        const angle = Math.atan2(point.y - this.y, point.x - this.x);
        
        if (this._isAngleInRange(angle)) {
            return Math.abs(dist - this.radius);
        } else {
            // Distance to nearest endpoint
            const start = this.getStartPoint();
            const end = this.getEndPoint();
            return Math.min(
                Math.hypot(point.x - start.x, point.y - start.y),
                Math.hypot(point.x - end.x, point.y - end.y)
            );
        }
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
    
    _draw(g, scale) {
        g.arc(this.x, this.y, this.radius, this.startAngle, this.endAngle);
    }
    
    _drawHandles(g, scale) {
        const handleSize = 3 / scale;
        
        g.lineStyle(1 / scale, 0xe94560, 1);
        g.beginFill(0xffffff, 1);
        
        // Center handle
        g.drawRect(this.x - handleSize/2, this.y - handleSize/2, handleSize, handleSize);
        
        // Endpoint handles
        const start = this.getStartPoint();
        const end = this.getEndPoint();
        
        g.drawRect(start.x - handleSize/2, start.y - handleSize/2, handleSize, handleSize);
        g.drawRect(end.x - handleSize/2, end.y - handleSize/2, handleSize, handleSize);
        
        g.endFill();
    }
    
    move(dx, dy) {
        this.x += dx;
        this.y += dy;
        this.invalidate();
    }
    
    get arcLength() {
        let sweep = this.endAngle - this.startAngle;
        if (sweep < 0) sweep += Math.PI * 2;
        return this.radius * sweep;
    }
    
    clone() {
        return new Arc({
            ...this.toJSON(),
            x: this.x,
            y: this.y,
            radius: this.radius,
            startAngle: this.startAngle,
            endAngle: this.endAngle
        });
    }
    
    toJSON() {
        return {
            ...super.toJSON(),
            x: this.x,
            y: this.y,
            radius: this.radius,
            startAngle: this.startAngle,
            endAngle: this.endAngle
        };
    }
}