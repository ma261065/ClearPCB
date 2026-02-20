/**
 * Arc - SVG arc using path
 * Single source of truth: three control points (startPoint, endPoint, bulgePoint)
 * All geometry is computed on-demand from these three points
 */

import { Shape } from './shape.js';
import { circumcircle } from '../core/geometry.js';

export class Arc extends Shape {
    constructor(options = {}) {
        super(options);
        this.type = 'arc';
        
        // The ONLY source of truth: three control points
        this._startPoint = options.startPoint || { x: 0, y: 0 };
        this._endPoint = options.endPoint || { x: 10, y: 0 };
        this._bulgePoint = options.bulgePoint || { x: 5, y: 5 };
        this._cachedGeometry = null;
    }
    
    get startPoint() {
        return this._startPoint;
    }
    
    set startPoint(val) {
        this._startPoint = val;
        this._cachedGeometry = null;
    }
    
    get endPoint() {
        return this._endPoint;
    }
    
    set endPoint(val) {
        this._endPoint = val;
        this._cachedGeometry = null;
    }
    
    get bulgePoint() {
        return this._bulgePoint;
    }
    
    set bulgePoint(val) {
        this._bulgePoint = val;
        this._cachedGeometry = null;
    }
    
    /**
     * Override invalidate to also clear cached geometry
     */
    invalidate() {
        this._cachedGeometry = null;
        super.invalidate();
    }

    /**
     * Compute geometry from the three control points.
     * Cached per dirty cycle — invalidated when control points change.
     */
    _getGeometry() {
        if (this._cachedGeometry) return this._cachedGeometry;
        const geo = this._computeGeometry();
        this._cachedGeometry = geo;
        return geo;
    }

    _computeGeometry() {
        const p1 = this._startPoint;
        const p2 = this._bulgePoint;
        const p3 = this._endPoint;
        
        const circ = circumcircle(p1, p2, p3);
        
        // If points are collinear, return a degenerate circle
        if (!circ) {
            return {
                cx: (p1.x + p3.x) / 2,
                cy: (p1.y + p3.y) / 2,
                radius: Math.hypot(p3.x - p1.x, p3.y - p1.y) / 2,
                startAngle: Math.atan2(p1.y - (p1.y + p3.y) / 2, p1.x - (p1.x + p3.x) / 2),
                endAngle: Math.atan2(p3.y - (p1.y + p3.y) / 2, p3.x - (p1.x + p3.x) / 2),
                sweepFlag: 0,
                largeArc: 0
            };
        }
        
        const { cx, cy, radius } = circ;
        
        const startAngle = Math.atan2(p1.y - cy, p1.x - cx);
        const endAngle = Math.atan2(p3.y - cy, p3.x - cx);
        
        const crossProduct = (p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x);
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
        const geo = this._getGeometry();
        const { cx, cy, radius } = geo;
        const half = this.lineWidth / 2;

        // Start with the three control points
        const pts = [this._startPoint, this._endPoint, this._bulgePoint];
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of pts) {
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
        }

        // Check if any cardinal axis point (0°, 90°, 180°, 270°) lies on the arc.
        // If so, expand bounds to the circle's extent in that direction.
        const cardinals = [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2];
        for (const angle of cardinals) {
            if (this._isAngleInRange(angle)) {
                const px = cx + radius * Math.cos(angle);
                const py = cy + radius * Math.sin(angle);
                if (px < minX) minX = px;
                if (py < minY) minY = py;
                if (px > maxX) maxX = px;
                if (py > maxY) maxY = py;
            }
        }

        return {
            minX: minX - half,
            minY: minY - half,
            maxX: maxX + half,
            maxY: maxY + half
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
        const TWO_PI = Math.PI * 2;
        const mod = (a) => ((a % TWO_PI) + TWO_PI) % TWO_PI;
        
        const geo = this._getGeometry();
        const start = mod(geo.startAngle);
        const end = mod(geo.endAngle);
        // Compute bulge angle directly from the control point for robustness
        const bulge = mod(Math.atan2(this._bulgePoint.y - geo.cy, this._bulgePoint.x - geo.cx));
        angle = mod(angle);
        
        // Shift all angles so start is at 0
        const dEnd = mod(end - start);
        const dBulge = mod(bulge - start);
        const dTest = mod(angle - start);
        
        if (dBulge <= dEnd) {
            // Arc sweeps CCW from start through bulge to end
            return dTest <= dEnd;
        } else {
            // Arc sweeps CW from start through bulge to end
            return dTest >= dEnd;
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
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
        // Assign new objects through setters so _cachedGeometry is cleared at each step
        this.startPoint = { x: this._startPoint.x + dx, y: this._startPoint.y + dy };
        this.endPoint = { x: this._endPoint.x + dx, y: this._endPoint.y + dy };
        this.bulgePoint = { x: this._bulgePoint.x + dx, y: this._bulgePoint.y + dy };
        this.invalidate();
    }
    
    clone() {
        return new Arc(this.toJSON());
    }
    
    toJSON() {
        return {
            ...super.toJSON(),
            startPoint: { x: this._startPoint.x, y: this._startPoint.y },
            endPoint: { x: this._endPoint.x, y: this._endPoint.y },
            bulgePoint: { x: this._bulgePoint.x, y: this._bulgePoint.y }
        };
    }
}