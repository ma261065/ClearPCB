/**
 * Arc - SVG arc using path
 * Single source of truth: three control points (startPoint, endPoint, bulgePoint)
 * All geometry is computed on-demand from these three points
 */

import { Shape } from './shape.js';
import { circumcircle, projectOntoChordBisector, clampBulgePoint, bulgeRatio, bulgePointFromRatio } from '../core/geometry.js';

/** Round to 4 decimal places for compact serialisation. */
const _r4 = v => Math.round(v * 10000) / 10000;

export class Arc extends Shape {
    /**
     * @param {Object} [options]
        * @param {string} [options.id]
        * @param {string} [options.layer]
        * @param {string|number} [options.color]
        * @param {string|number} [options.fillColor]
        * @param {number} [options.lineWidth]
        * @param {boolean} [options.visible]
        * @param {boolean} [options.locked]
     * @param {{x:number,y:number}} [options.startPoint] - Arc start.
     * @param {{x:number,y:number}} [options.endPoint]   - Arc end.
     * @param {{x:number,y:number}} [options.bulgePoint]  - Arc midpoint (curvature control).
     */
    constructor(options = {}) {
        super(options);
        this.type = 'arc';
        
        // The ONLY source of truth: three control points
        this._startPoint = options.startPoint || { x: 0, y: 0 };
        this._endPoint = options.endPoint || { x: 10, y: 0 };
        this._bulgePoint = options.bulgePoint || { x: 5, y: 5 };
        this._cachedGeometry = null;
    }
    
    /** @returns {{x:number,y:number}} Arc start control point. */
    get startPoint() {
        return this._startPoint;
    }
    /** @param {{x:number,y:number}} val */
    set startPoint(val) {
        this._startPoint = val;
        this._cachedGeometry = null;
    }
    /** @returns {{x:number,y:number}} Arc end control point. */
    get endPoint() {
        return this._endPoint;
    }
    /** @param {{x:number,y:number}} val */
    set endPoint(val) {
        this._endPoint = val;
        this._cachedGeometry = null;
    }
    /** @returns {{x:number,y:number}} Bulge (curvature) control point. */
    get bulgePoint() {
        return this._bulgePoint;
    }
    /** @param {{x:number,y:number}} val */
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

    /**
     * Derive centre, radius, angles, and sweep from the three control points
     * via circumcircle calculation.
     * @returns {{cx:number, cy:number, radius:number, startAngle:number, endAngle:number, sweepFlag:0|1}}
     */
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
                sweepFlag: 0
            };
        }
        
        const { cx, cy, radius } = circ;
        
        const startAngle = Math.atan2(p1.y - cy, p1.x - cx);
        const endAngle = Math.atan2(p3.y - cy, p3.x - cx);
        
        const crossProduct = (p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x);
        const sweepFlag = crossProduct > 0 ? 0 : 1;
        
        return { cx, cy, radius, startAngle, endAngle, sweepFlag };
    }
    
    /** Centre X, derived from control points. */
    get x() {
        return this._getGeometry().cx;
    }
    
    /** Centre Y, derived from control points. */
    get y() {
        return this._getGeometry().cy;
    }
    /** Arc radius in mm. */
    get radius() {
        return this._getGeometry().radius;
    }
    /** Start angle in radians. */
    get startAngle() {
        return this._getGeometry().startAngle;
    }
    /** End angle in radians. */
    get endAngle() {
        return this._getGeometry().endAngle;
    }
    /** SVG sweep flag (0 = CCW, 1 = CW). */
    get sweepFlag() {
        return this._getGeometry().sweepFlag;
    }
    
    /** @override */
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
    
    /** @override */
    hitTest(point, tolerance = 0.5) {
        const dist = Math.hypot(point.x - this.x, point.y - this.y);
        
        if (Math.abs(dist - this.radius) > tolerance + this.lineWidth / 2) {
            return false;
        }
        
        let angle = Math.atan2(point.y - this.y, point.x - this.x);
        return this._isAngleInRange(angle);
    }
    
    /**
     * Test whether an angle lies on the drawn arc.
     * @param {number} angle - Angle in radians.
     * @returns {boolean}
     */
    _isAngleInRange(angle) {
        const TWO_PI = Math.PI * 2;
        const mod = (a) => ((a % TWO_PI) + TWO_PI) % TWO_PI;
        const geo = this._getGeometry();
        angle = mod(angle);

        if (geo.sweepFlag === 1) {
            // CW: start → end in increasing-angle direction
            const span = mod(geo.endAngle - geo.startAngle);
            const test = mod(angle - geo.startAngle);
            return test <= span;
        } else {
            // CCW: start → end in decreasing-angle direction
            const span = mod(geo.startAngle - geo.endAngle);
            const test = mod(geo.startAngle - angle);
            return test <= span;
        }
    }
    
    /** @override */
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
    
    /** @returns {{x:number,y:number}} Copy of the arc start point. */
    getStartPoint() {
        return { x: this._startPoint.x, y: this._startPoint.y };
    }
    /** @returns {{x:number,y:number}} Copy of the arc end point. */
    getEndPoint() {
        return { x: this._endPoint.x, y: this._endPoint.y };
    }

    /** @override */
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
    
    /**
     * Compute the midpoint of the drawn arc (for the "mid" anchor handle).
     * @returns {{x:number,y:number}}
     */
    getMidPoint() {
        const geo = this._getGeometry();
        const { cx, cy, radius, sweepFlag } = geo;

        // Use the same sweepFlag that drives SVG rendering so the
        // anchor always sits on the drawn curve.
        const TWO_PI = Math.PI * 2;
        const mod = (a) => ((a % TWO_PI) + TWO_PI) % TWO_PI;

        let midAngle;
        if (sweepFlag === 1) {
            // CW in SVG (positive-angle / increasing atan2 with Y-down)
            const span = mod(geo.endAngle - geo.startAngle);
            midAngle = geo.startAngle + span / 2;
        } else {
            // CCW in SVG (decreasing angles)
            const span = mod(geo.startAngle - geo.endAngle);
            midAngle = geo.startAngle - span / 2;
        }

        return {
            x: cx + radius * Math.cos(midAngle),
            y: cy + radius * Math.sin(midAngle)
        };
    }
    
    /** @override */
    moveAnchor(anchorId, x, y) {
        const start = this.getStartPoint();
        const end = this.getEndPoint();

        if (anchorId === 'mid') {
            const projected = projectOntoChordBisector(start, end, { x, y });
            this.bulgePoint = clampBulgePoint(start, end, projected);
        } else {
            // Start/end anchor: snapshot bulge *ratio* at drag start so the
            // curvature stays constant as the chord changes length.
            if (this._dragBulgeRatio == null) {
                this._dragBulgeRatio = bulgeRatio(start, end, this._bulgePoint);
            }
            if (anchorId === 'start') {
                this.startPoint = { x, y };
                this.bulgePoint = bulgePointFromRatio({ x, y }, end, this._dragBulgeRatio);
            } else {
                this.endPoint = { x, y };
                this.bulgePoint = bulgePointFromRatio(start, { x, y }, this._dragBulgeRatio);
            }
        }
        this.invalidate();
        return undefined;
    }

    /** @override */
    _createElement() {
        return document.createElementNS('http://www.w3.org/2000/svg', 'path');
    }
    /** @override */
    _updateElement(el, strokeColor, fillColor, scale) {
        const start = this.getStartPoint();
        const end = this.getEndPoint();
        const d = `M ${start.x} ${start.y} A ${this.radius} ${this.radius} 0 0 ${this.sweepFlag} ${end.x} ${end.y}`;
        
        el.setAttribute('d', d);
        el.setAttribute('stroke', strokeColor);
        el.setAttribute('stroke-width', this._getEffectiveStrokeWidth(scale));
        el.setAttribute('fill', 'none');
        el.setAttribute('stroke-linecap', 'round');
    }
    
    /** @override */
    move(dx, dy) {
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
        // Assign new objects through setters so _cachedGeometry is cleared at each step
        this.startPoint = { x: this._startPoint.x + dx, y: this._startPoint.y + dy };
        this.endPoint = { x: this._endPoint.x + dx, y: this._endPoint.y + dy };
        this.bulgePoint = { x: this._bulgePoint.x + dx, y: this._bulgePoint.y + dy };
        this.invalidate();
    }
    
    /** @override */
    clone() {
        return new Arc(this.toJSON());
    }
    /** @override */
    captureState() {
        return {
            startPoint: { x: this._startPoint.x, y: this._startPoint.y },
            endPoint: { x: this._endPoint.x, y: this._endPoint.y },
            bulgePoint: { x: this._bulgePoint.x, y: this._bulgePoint.y }
        };
    }

    /** @override */
    getPropertyDescriptors() {
        return [
            { key: 'locked',    label: 'Locked',    type: 'checkbox' },
            { key: 'lineWidth', label: 'Line width', type: 'number', min: 0.05, max: 5, step: 0.05 },
        ];
    }
    /** @override */
    applyState(state) {
        if (state.startPoint) this.startPoint = { x: state.startPoint.x, y: state.startPoint.y };
        if (state.endPoint) this.endPoint = { x: state.endPoint.x, y: state.endPoint.y };
        if (state.bulgePoint) this.bulgePoint = { x: state.bulgePoint.x, y: state.bulgePoint.y };
        this.invalidate();
    }
    
    /** @override */
    getPosition() {
        return { x: this._startPoint.x, y: this._startPoint.y };
    }
    /** @override — 'none' for the mid anchor, 'grid' for start/end. */
    getAnchorSnapMode(anchorId) {
        return anchorId === 'mid' ? 'none' : 'grid';
    }
    /** @override — clears the cached bulge ratio from start/end drags. */
    resetDragState() {
        this._dragBulgeRatio = null;
    }
    /** @override */
    toJSON() {
        return {
            ...super.toJSON(),
            sp: { x: _r4(this._startPoint.x), y: _r4(this._startPoint.y) },
            ep: { x: _r4(this._endPoint.x), y: _r4(this._endPoint.y) },
            bp: { x: _r4(this._bulgePoint.x), y: _r4(this._bulgePoint.y) }
        };
    }
}