/**
 * Arc - SVG arc using path
 * Single source of truth: three control points (startPoint, endPoint, bulgePoint)
 * All geometry is computed on-demand from these three points
 */

import { Shape } from './shape.js';

export class Arc extends Shape {
    constructor(options = {}) {
        super(options);
        this.type = 'arc';
        
        // The ONLY source of truth: three control points
        this._startPoint = options.startPoint || { x: 0, y: 0 };
        this._endPoint = options.endPoint || { x: 10, y: 0 };
        this._bulgePoint = options.bulgePoint || { x: 5, y: 5 };
    }
    
    get startPoint() {
        return this._startPoint;
    }
    
    set startPoint(val) {
        this._startPoint = val;
    }
    
    get endPoint() {
        return this._endPoint;
    }
    
    set endPoint(val) {
        this._endPoint = val;
    }
    
    get bulgePoint() {
        return this._bulgePoint;
    }
    
    set bulgePoint(val) {
        this._bulgePoint = val;
    }
    
    /**
     * Compute geometry from the three control points on demand
     * No caching - always fresh to ensure consistency
     */
    _getGeometry() {
        const x1 = this._startPoint.x;
        const y1 = this._startPoint.y;
        const x2 = this._bulgePoint.x;
        const y2 = this._bulgePoint.y;
        const x3 = this._endPoint.x;
        const y3 = this._endPoint.y;
        
        // Calculate circle center from three points
        const d1 = x1 * x1 + y1 * y1;
        const d2 = x2 * x2 + y2 * y2;
        const d3 = x3 * x3 + y3 * y3;
        
        const det = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2));
        
        // If points are collinear, return a degenerate circle
        if (Math.abs(det) < 0.0001) {
            return {
                cx: (x1 + x3) / 2,
                cy: (y1 + y3) / 2,
                radius: Math.hypot(x3 - x1, y3 - y1) / 2,
                startAngle: Math.atan2(y1 - (y1 + y3) / 2, x1 - (x1 + x3) / 2),
                endAngle: Math.atan2(y3 - (y1 + y3) / 2, x3 - (x1 + x3) / 2),
                sweepFlag: 0,
                largeArc: 0
            };
        }
        
        const cx = (d1 * (y2 - y3) + d2 * (y3 - y1) + d3 * (y1 - y2)) / det;
        const cy = (d1 * (x3 - x2) + d2 * (x1 - x3) + d3 * (x2 - x1)) / det;
        const radius = Math.hypot(x1 - cx, y1 - cy);
        
        const startAngle = Math.atan2(y1 - cy, x1 - cx);
        const endAngle = Math.atan2(y3 - cy, x3 - cx);
        
        const crossProduct = (x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1);
        const sweepFlag = crossProduct > 0 ? 0 : 1;
        
        return {
            cx, cy, radius,
            startAngle,
            endAngle,
            sweepFlag,
            largeArc: 0
        };
    }
    
    // Geometry getters - always computed from three points
    get x() {
        return this._getGeometry().cx;
    }
    
    get y() {
        return this._getGeometry().cy;
    }
    
    get radius() {
        return this._getGeometry().radius;
    }
    
    get startAngle() {
        return this._getGeometry().startAngle;
    }
    
    get endAngle() {
        return this._getGeometry().endAngle;
    }
    
    get sweepFlag() {
        return this._getGeometry().sweepFlag;
    }
    
    get largeArc() {
        return this._getGeometry().largeArc;
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
        
        // If sweepFlag is defined, use it to determine direction of the arc
        if (this.sweepFlag !== undefined) {
            const isBetweenCCW = (from, to, test) => (from < to ? (test >= from && test <= to) : (test >= from || test <= to));
            // sweepFlag 1 means increasing angle (clockwise on screen), 0 means decreasing
            return this.sweepFlag === 1
                ? isBetweenCCW(start, end, angle)
                : isBetweenCCW(end, start, angle);
        }
        
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
        return { x: this._startPoint.x, y: this._startPoint.y };
    }
    
    getEndPoint() {
        return { x: this._endPoint.x, y: this._endPoint.y };
    }

    getAnchors() {
        const start = this.getStartPoint();
        const end = this.getEndPoint();
        const mid = this.getMidPoint();
        return [
            { id: 'start', x: start.x, y: start.y, cursor: 'grab' },
            { id: 'mid', x: mid.x, y: mid.y, cursor: 'grab' },
            { id: 'end', x: end.x, y: end.y, cursor: 'grab' }
        ];
    }
    
    getMidPoint() {
        return { x: this._bulgePoint.x, y: this._bulgePoint.y };
    }
    
    moveAnchor(anchorId, x, y) {
        const start = this.getStartPoint();
        const end = this.getEndPoint();
        
        // Clear any previous drag state when starting a new drag
        if (anchorId === 'start' || anchorId === 'end') {
            this._draggingMidTo = null;
            if (!this._dragMidPoint) {
                this._dragMidPoint = this._bulgePoint || this.getMidPoint();
            }
        } else if (anchorId === 'mid') {
            this._dragMidPoint = null;
            // Clamp bulge to maximum curvature, then set new position
            const clamped = this._clampBulgePoint(start.x, start.y, end.x, end.y, x, y);
            x = clamped.x;
            y = clamped.y;
            this._draggingMidTo = { x, y };
        }
        
        if (anchorId === 'start') {
            const clampedMid = this._clampBulgePoint(x, y, end.x, end.y, this._dragMidPoint.x, this._dragMidPoint.y);
            this._dragMidPoint = clampedMid;
            this.startPoint = { x, y };
            this.bulgePoint = clampedMid;
        } else if (anchorId === 'mid') {
            this.bulgePoint = { x, y };
        } else if (anchorId === 'end') {
            const clampedMid = this._clampBulgePoint(start.x, start.y, x, y, this._dragMidPoint.x, this._dragMidPoint.y);
            this._dragMidPoint = clampedMid;
            this.endPoint = { x, y };
            this.bulgePoint = clampedMid;
        }
        
        this.invalidate();
    }

    _clampBulgePoint(x1, y1, x2, y2, bx, by) {
        const mx = (x1 + x2) / 2;
        const my = (y1 + y2) / 2;
        const chordDx = x2 - x1;
        const chordDy = y2 - y1;
        const maxRadius = Math.hypot(chordDx, chordDy) / 2;

        if (maxRadius === 0) return { x: bx, y: by };

        const dx = bx - mx;
        const dy = by - my;
        const dist = Math.hypot(dx, dy);

        if (dist <= maxRadius) return { x: bx, y: by };

        const scale = maxRadius / dist;
        return {
            x: mx + dx * scale,
            y: my + dy * scale
        };
    }
    
    _createElement() {
        return document.createElementNS('http://www.w3.org/2000/svg', 'path');
    }
    
    _updateElement(el, strokeColor, fillColor, scale) {
        const start = this.getStartPoint();
        const end = this.getEndPoint();
        
        // Calculate arc sweep (small arc only)
        const largeArc = 0;
        
        // Determine sweep flag: CCW (endAngle > startAngle) maps to SVG sweep 0
        const sweepFlag = this.sweepFlag !== undefined ? this.sweepFlag : (this.endAngle > this.startAngle ? 0 : 1);
        
        const d = `M ${start.x} ${start.y} A ${this.radius} ${this.radius} 0 ${largeArc} ${sweepFlag} ${end.x} ${end.y}`;
        
        el.setAttribute('d', d);
        el.setAttribute('stroke', strokeColor);
        el.setAttribute('stroke-width', this._getEffectiveStrokeWidth(scale));
        el.setAttribute('fill', 'none');
        el.setAttribute('stroke-linecap', 'round');
    }
    
    move(dx, dy) {
        this.startPoint.x += dx;
        this.startPoint.y += dy;
        this.endPoint.x += dx;
        this.endPoint.y += dy;
        this.bulgePoint.x += dx;
        this.bulgePoint.y += dy;
        this.invalidate();
    }
    
    clone() {
        return new Arc(this.toJSON());
    }
    
    toJSON() {
        return {
            ...super.toJSON(),
            startPoint: this.startPoint,
            endPoint: this.endPoint,
            bulgePoint: this.bulgePoint
        };
    }
}