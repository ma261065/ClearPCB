/**
 * Rect - A rectangle defined by corner and dimensions
 */

import { Shape } from './Shape.js';

export class Rect extends Shape {
    constructor(options = {}) {
        super(options);
        this.type = 'rect';
        
        // Position (top-left corner) and dimensions
        this.x = options.x || 0;
        this.y = options.y || 0;
        this.width = options.width || 10;
        this.height = options.height || 10;
        
        // Corner radius (0 for sharp corners)
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
        
        // Check if point is inside expanded bounds
        const insideOuter = point.x >= expanded.minX && point.x <= expanded.maxX &&
                           point.y >= expanded.minY && point.y <= expanded.maxY;
        
        if (!insideOuter) return false;
        
        if (this.fill) {
            return true;
        }
        
        // Stroke only - check if near edge
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
        // Distance to nearest edge of rectangle
        const cx = this.x + this.width / 2;
        const cy = this.y + this.height / 2;
        
        const dx = Math.max(Math.abs(point.x - cx) - this.width / 2, 0);
        const dy = Math.max(Math.abs(point.y - cy) - this.height / 2, 0);
        
        if (this.fill) {
            return Math.hypot(dx, dy);
        } else {
            // For stroke, return distance to edge
            const insideX = point.x >= this.x && point.x <= this.x + this.width;
            const insideY = point.y >= this.y && point.y <= this.y + this.height;
            
            if (insideX && insideY) {
                // Inside - distance to nearest edge
                return Math.min(
                    point.x - this.x,
                    this.x + this.width - point.x,
                    point.y - this.y,
                    this.y + this.height - point.y
                );
            }
            return Math.hypot(dx, dy);
        }
    }
    
    _draw(g, scale) {
        if (this.cornerRadius > 0) {
            g.drawRoundedRect(this.x, this.y, this.width, this.height, this.cornerRadius);
        } else {
            g.drawRect(this.x, this.y, this.width, this.height);
        }
    }
    
    move(dx, dy) {
        this.x += dx;
        this.y += dy;
        this.invalidate();
    }
    
    get center() {
        return {
            x: this.x + this.width / 2,
            y: this.y + this.height / 2
        };
    }
    
    get area() {
        return this.width * this.height;
    }
    
    clone() {
        return new Rect({
            ...this.toJSON(),
            x: this.x,
            y: this.y,
            width: this.width,
            height: this.height,
            cornerRadius: this.cornerRadius
        });
    }
    
    toJSON() {
        return {
            ...super.toJSON(),
            x: this.x,
            y: this.y,
            width: this.width,
            height: this.height,
            cornerRadius: this.cornerRadius
        };
    }
}