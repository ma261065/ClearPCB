/**
 * Polygon - SVG polygon/polyline
 */

import { Shape } from './Shape.js';

export class Polygon extends Shape {
    constructor(options = {}) {
        super(options);
        this.type = 'polygon';
        
        this.points = options.points || [];
        this.fill = options.fill !== undefined ? options.fill : true;
        this.fillAlpha = options.fillAlpha || 0.5;
        this.closed = options.closed !== undefined ? options.closed : true;
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
        return this.distanceTo(point) <= tolerance + this.lineWidth / 2;
    }
    
    _pointInPolygon(point) {
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
    
    getAnchors() {
        return this.points.map((p, i) => ({
            id: `p${i}`,
            x: p.x,
            y: p.y,
            cursor: 'move'
        }));
    }
    
    moveAnchor(anchorId, x, y) {
        const index = parseInt(anchorId.substring(1));
        if (index >= 0 && index < this.points.length) {
            this.points[index].x = x;
            this.points[index].y = y;
        }
        this.invalidate();
    }
    
    _createElement() {
        return document.createElementNS('http://www.w3.org/2000/svg', this.fill && this.closed ? 'polygon' : 'polyline');
    }
    
    _updateElement(el, strokeColor, fillColor, scale) {
        const pointsStr = this.points.map(p => `${p.x},${p.y}`).join(' ');
        el.setAttribute('points', pointsStr);
        el.setAttribute('stroke', strokeColor);
        el.setAttribute('stroke-width', this._getEffectiveStrokeWidth(scale));
        el.setAttribute('stroke-linecap', 'round');
        el.setAttribute('stroke-linejoin', 'round');
        
        if (this.fill && this.closed) {
            el.setAttribute('fill', fillColor);
            el.setAttribute('fill-opacity', this.fillAlpha);
        } else {
            el.setAttribute('fill', 'none');
        }
    }
    
    move(dx, dy) {
        for (const p of this.points) {
            p.x += dx;
            p.y += dy;
        }
        this.invalidate();
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
            points: this.points.map(p => ({ x: p.x, y: p.y })),
            closed: this.closed
        };
    }
}