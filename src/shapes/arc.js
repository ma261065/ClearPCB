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
        this.sweepFlag = options.sweepFlag;
        this.largeArc = options.largeArc;
        this.bulgePoint = options.bulgePoint;
        this.snapToGrid = options.snapToGrid;
        this.gridSize = options.gridSize;
        this.startPoint = options.startPoint || {
            x: this.x + Math.cos(this.startAngle) * this.radius,
            y: this.y + Math.sin(this.startAngle) * this.radius
        };
        this.endPoint = options.endPoint || {
            x: this.x + Math.cos(this.endAngle) * this.radius,
            y: this.y + Math.sin(this.endAngle) * this.radius
        };
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
        if (this.startPoint) {
            const p = { x: this.startPoint.x, y: this.startPoint.y };
            return this._snapPoint(p);
        }
        return {
            x: this.x + Math.cos(this.startAngle) * this.radius,
            y: this.y + Math.sin(this.startAngle) * this.radius
        };
    }
    
    getEndPoint() {
        if (this.endPoint) {
            const p = { x: this.endPoint.x, y: this.endPoint.y };
            return this._snapPoint(p);
        }
        return {
            x: this.x + Math.cos(this.endAngle) * this.radius,
            y: this.y + Math.sin(this.endAngle) * this.radius
        };
    }

    _snapPoint(p) {
        if (!this.snapToGrid || !this.gridSize) return p;
        return {
            x: Math.round(p.x / this.gridSize) * this.gridSize,
            y: Math.round(p.y / this.gridSize) * this.gridSize
        };
    }
    
    getAnchors() {
        const start = this.getStartPoint();
        const end = this.getEndPoint();
        // Use drag position if dragging mid, otherwise use bulge point if available
        const mid = this._draggingMidTo || this.bulgePoint || this.getMidPoint();
        return [
            { id: 'start', x: start.x, y: start.y, cursor: 'crosshair' },
            { id: 'mid', x: mid.x, y: mid.y, cursor: 'move' },
            { id: 'end', x: end.x, y: end.y, cursor: 'crosshair' }
        ];
    }
    
    setSelected(selected) {
        super.setSelected(selected);
        // Clear drag states when deselecting
        if (!selected) {
            this._dragMidPoint = null;
            this._draggingMidTo = null;
        }
    }
    
    getMidPoint() {
        let midAngle;
        if (this.sweepFlag !== undefined) {
            const normalize = (a) => {
                while (a < 0) a += Math.PI * 2;
                while (a >= Math.PI * 2) a -= Math.PI * 2;
                return a;
            };
            const start = normalize(this.startAngle);
            const end = normalize(this.endAngle);
            const ccwDelta = (from, to) => (to >= from ? to - from : (Math.PI * 2 - from) + to);

            // sweepFlag 1 means CCW (in angle space), 0 means CW
            let delta = this.sweepFlag === 1 ? ccwDelta(start, end) : ccwDelta(end, start);
            // We always draw the small arc
            if (delta > Math.PI) delta = (Math.PI * 2) - delta;

            if (this.sweepFlag === 1) {
                midAngle = start + delta / 2;
            } else {
                midAngle = start - delta / 2;
            }
        } else {
            if (this.endAngle > this.startAngle) {
                // Counter-clockwise arc
                midAngle = (this.startAngle + this.endAngle) / 2;
            } else {
                // Clockwise arc (endAngle is negative relative to startAngle)
                midAngle = (this.startAngle + this.endAngle) / 2;
            }
        }
        return {
            x: this.x + Math.cos(midAngle) * this.radius,
            y: this.y + Math.sin(midAngle) * this.radius
        };
    }
    
    moveAnchor(anchorId, x, y) {
        const start = this.getStartPoint();
        const end = this.getEndPoint();
        
        // Clear any previous drag state when starting a new drag
        if (anchorId === 'start' || anchorId === 'end') {
            this._draggingMidTo = null;
            if (!this._dragMidPoint) {
                this._dragMidPoint = this.bulgePoint || this.getMidPoint();
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
            this.bulgePoint = { x: clampedMid.x, y: clampedMid.y };
            this._recalculateFromThreePoints(x, y, clampedMid.x, clampedMid.y, end.x, end.y);
        } else if (anchorId === 'mid') {
            this._recalculateFromThreePoints(start.x, start.y, x, y, end.x, end.y);
        } else if (anchorId === 'end') {
            const clampedMid = this._clampBulgePoint(start.x, start.y, x, y, this._dragMidPoint.x, this._dragMidPoint.y);
            this._dragMidPoint = clampedMid;
            this.bulgePoint = { x: clampedMid.x, y: clampedMid.y };
            this._recalculateFromThreePoints(start.x, start.y, clampedMid.x, clampedMid.y, x, y);
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
    
    _recalculateFromThreePoints(x1, y1, x2, y2, x3, y3) {
        // Calculate arc from three points
        // Using circle equation: (x-cx)^2 + (y-cy)^2 = r^2
        const dx1 = x2 - x1;
        const dy1 = y2 - y1;
        const dx2 = x3 - x2;
        const dy2 = y3 - y2;
        
        const d1 = x1 * x1 + y1 * y1;
        const d2 = x2 * x2 + y2 * y2;
        const d3 = x3 * x3 + y3 * y3;
        
        const det = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2));
        
        if (Math.abs(det) < 0.0001) return; // Points are collinear
        
        const cx = (d1 * (y2 - y3) + d2 * (y3 - y1) + d3 * (y1 - y2)) / det;
        const cy = (d1 * (x3 - x2) + d2 * (x1 - x3) + d3 * (x2 - x1)) / det;
        const r = Math.hypot(x1 - cx, y1 - cy);
        
        // Calculate angles
        const angle1 = Math.atan2(y1 - cy, x1 - cx);
        const angle2 = Math.atan2(y2 - cy, x2 - cx);
        const angle3 = Math.atan2(y3 - cy, x3 - cx);
        
        // Determine direction from cross product (bulge side)
        const crossProduct = (x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1);
        const ccw = crossProduct > 0;
        const sweepFlag = ccw ? 0 : 1;
        const largeArc = 0;
        
        this.x = cx;
        this.y = cy;
        this.radius = r;
        this.bulgePoint = { x: x2, y: y2 };
        this.startPoint = { x: x1, y: y1 };
        this.endPoint = { x: x3, y: y3 };
        this.startAngle = angle1;
        if (ccw) {
            this.endAngle = angle3;
            while (this.endAngle <= this.startAngle) this.endAngle += Math.PI * 2;
        } else {
            this.endAngle = angle3;
            while (this.endAngle >= this.startAngle) this.endAngle -= Math.PI * 2;
        }
        
        this.sweepFlag = sweepFlag;
        this.largeArc = largeArc;
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
        this.x += dx;
        this.y += dy;
        if (this.startPoint) {
            this.startPoint.x += dx;
            this.startPoint.y += dy;
        }
        if (this.endPoint) {
            this.endPoint.x += dx;
            this.endPoint.y += dy;
        }
        this.invalidate();
    }
    
    clone() {
        return new Arc({ ...this.toJSON(), x: this.x, y: this.y, radius: this.radius, startAngle: this.startAngle, endAngle: this.endAngle });
    }
    
    toJSON() {
        return {
            ...super.toJSON(),
            x: this.x,
            y: this.y,
            radius: this.radius,
            startAngle: this.startAngle,
            endAngle: this.endAngle,
            sweepFlag: this.sweepFlag,
            largeArc: this.largeArc,
            bulgePoint: this.bulgePoint,
            startPoint: this.startPoint,
            endPoint: this.endPoint
        };
    }
}