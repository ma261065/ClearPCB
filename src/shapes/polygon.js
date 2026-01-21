/**
 * Polygon - A closed polygon defined by an array of points
 */

import { Shape } from './Shape.js';

export class Polygon extends Shape {
    constructor(options = {}) {
        super(options);
        this.type = 'polygon';
        
        // Array of {x, y} points
        this.points = options.points || [];
        
        // Polygons are typically filled
        this.fill = options.fill !== undefined ? options.fill : true;
        this.fillAlpha = options.fillAlpha || 0.5;
    }
    
    _calculateBounds() {
        if (this.points.length === 0) {
            return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
        }
        
        const hw = this.lineWidth / 2;
        let minX = Infinity, minY = Infinity;
        let maxX = -Infinity, maxY = -Infinity;
        
        for (const p of this.points) {
            minX = Math.min(minX, p.x);
            minY = Math.min(minY, p.y);
            maxX = Math.max(maxX, p.x);
            maxY = Math.max(maxY, p.y);
        }
        
        return {
            minX: minX - hw,
            minY: minY - hw,
            maxX: maxX + hw,
            maxY: maxY + hw
        };
    }
    
    hitTest(point, tolerance = 0.5) {
        if (this.fill && this._pointInPolygon(point)) {
            return true;
        }
        
        // Check distance to edges
        return this.distanceTo(point) <= tolerance + this.lineWidth / 2;
    }
    
    _pointInPolygon(point) {
        // Ray casting algorithm
        const pts = this.points;
        const n = pts.length;
        let inside = false;
        
        for (let i = 0, j = n - 1; i < n; j = i++) {
            const xi = pts[i].x, yi = pts[i].y;
            const xj = pts[j].x, yj = pts[j].y;
            
            if (((yi > point.y) !== (yj > point.y)) &&
                (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi)) {
                inside = !inside;
            }
        }
        
        return inside;
    }
    
    distanceTo(point) {
        if (this.points.length < 2) return Infinity;
        
        let minDist = Infinity;
        const pts = this.points;
        const n = pts.length;
        
        // Check distance to each edge
        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            const dist = this._distanceToSegment(point, pts[i], pts[j]);
            minDist = Math.min(minDist, dist);
        }
        
        return minDist;
    }
    
    _distanceToSegment(point, p1, p2) {
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const lengthSq = dx * dx + dy * dy;
        
        if (lengthSq === 0) {
            return Math.hypot(point.x - p1.x, point.y - p1.y);
        }
        
        let t = ((point.x - p1.x) * dx + (point.y - p1.y) * dy) / lengthSq;
        t = Math.max(0, Math.min(1, t));
        
        const projX = p1.x + t * dx;
        const projY = p1.y + t * dy;
        
        return Math.hypot(point.x - projX, point.y - projY);
    }
    
    _draw(g, scale) {
        if (this.points.length < 2) return;
        
        g.moveTo(this.points[0].x, this.points[0].y);
        
        for (let i = 1; i < this.points.length; i++) {
            g.lineTo(this.points[i].x, this.points[i].y);
        }
        
        // Close the polygon
        g.closePath();
    }
    
    _drawHandles(g, scale) {
        const handleSize = 3 / scale;
        
        g.lineStyle(1 / scale, 0xe94560, 1);
        g.beginFill(0xffffff, 1);
        
        // Handle at each vertex
        for (const p of this.points) {
            g.drawRect(p.x - handleSize/2, p.y - handleSize/2, handleSize, handleSize);
        }
        
        g.endFill();
    }
    
    move(dx, dy) {
        for (const p of this.points) {
            p.x += dx;
            p.y += dy;
        }
        this.invalidate();
    }
    
    addPoint(x, y) {
        this.points.push({ x, y });
        this.invalidate();
    }
    
    removePoint(index) {
        if (index >= 0 && index < this.points.length) {
            this.points.splice(index, 1);
            this.invalidate();
        }
    }
    
    get area() {
        // Shoelace formula
        let area = 0;
        const n = this.points.length;
        
        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            area += this.points[i].x * this.points[j].y;
            area -= this.points[j].x * this.points[i].y;
        }
        
        return Math.abs(area) / 2;
    }
    
    clone() {
        return new Polygon({
            ...this.toJSON(),
            points: this.points.map(p => ({ x: p.x, y: p.y }))
        });
    }
    
    toJSON() {
        return {
            ...super.toJSON(),
            points: this.points.map(p => ({ x: p.x, y: p.y }))
        };
    }
}