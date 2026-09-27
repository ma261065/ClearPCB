/**
 * Arc - SVG arc using path
 * Single source of truth: three control points (startPoint, endPoint, bulgePoint)
 * All geometry is computed on-demand from these three points
 */

import { Shape } from './shape.js';
import { pointInPolygon, distanceToSegment, bulgeRatio, bulgePointFromRatio } from '../core/geometry.js';
import { projectArcBulge, arcBulgeRatio, arcBulgeFromRatio, controlArcGeometry, sampleControlArc } from './arc-edit.js';
import { pointsBounds, hitTestStrokeSegments } from './path-geometry.js';
import { primitiveShapePath } from './shape-drawing.js';

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
     * @param {boolean} [options.fill] - Whether to fill the chord area.
     */
    constructor(options = {}) {
        super(options);
        this.type = 'arc';
        
        // The ONLY source of truth: three control points
        this._startPoint = options.startPoint || { x: 0, y: 0 };
        this._endPoint = options.endPoint || { x: 10, y: 0 };
        this._bulgePoint = options.bulgePoint || { x: 5, y: 5 };
        this._cachedGeometry = null;

        // Fill properties
        this.fill = options.fill || false;
        this.fillAlpha = options.fillAlpha ?? 0.3;
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
    get bulge() { return bulgeRatio(this._startPoint, this._endPoint, this._bulgePoint); }

    set bulge(value) {
        if (!Number.isFinite(value)) return;
        this.bulgePoint = bulgePointFromRatio(this._startPoint, this._endPoint, Math.max(-1, Math.min(1, value)));
        this.invalidate();
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
        const p3 = this._endPoint;
        
        const circ = controlArcGeometry(this._controlArc());
        
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
        
        return { ...circ, sweepFlag: circ.counterclockwise ? 0 : 1 };
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
        return pointsBounds(sampleControlArc(this._controlArc()), this.lineWidth / 2);
    }
    
    /** @override */
    hitTest(point, tolerance = 0.5) {
        const points = sampleControlArc(this._controlArc());
        return (this.fill && pointInPolygon(point, points)) || hitTestStrokeSegments(point,
            points.slice(0, -1).map((start, index) => ({ start, end: points[index + 1], lineWidth: this.lineWidth })), tolerance);
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
        const points = sampleControlArc(this._controlArc());
        return points.slice(0, -1).reduce((distance, start, index) =>
            Math.min(distance, distanceToSegment(point, start, points[index + 1])), Infinity);
    }

    _controlArc() {
        return { kind: 'arc', start: this._startPoint, end: this._endPoint, bulge: this._bulgePoint };
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
            { id: 'mid', x: mid.x, y: mid.y, cursor: 'grab', bulge: true },
            { id: 'end', x: end.x, y: end.y, cursor: 'grab' }
        ];
    }
    
    /**
     * Compute the midpoint of the drawn arc (for the "mid" anchor handle).
     * @returns {{x:number,y:number}}
     */
    getMidPoint() {
        const geometry = controlArcGeometry(this._controlArc());
        if (!geometry) return { x: (this._startPoint.x + this._endPoint.x) / 2, y: (this._startPoint.y + this._endPoint.y) / 2 };
        const angle = (geometry.startAngle + geometry.endAngle) / 2;
        return {
            x: geometry.cx + geometry.radius * Math.cos(angle),
            y: geometry.cy + geometry.radius * Math.sin(angle)
        };
    }
    
    /** @override */
    moveAnchor(anchorId, x, y) {
        const start = this.getStartPoint();
        const end = this.getEndPoint();

        if (anchorId === 'mid') {
            this.bulgePoint = projectArcBulge(start, end, { x, y });
        } else {
            // Start/end anchor: snapshot bulge *ratio* at drag start so the
            // curvature stays constant as the chord changes length.
            if (this._dragBulgeRatio == null) {
                this._dragBulgeRatio = arcBulgeRatio({ start, end, bulge: this._bulgePoint });
            }
            if (anchorId === 'start') {
                this.startPoint = { x, y };
                this.bulgePoint = arcBulgeFromRatio({ x, y }, end, this._dragBulgeRatio);
            } else {
                this.endPoint = { x, y };
                this.bulgePoint = arcBulgeFromRatio(start, { x, y }, this._dragBulgeRatio);
            }
        }
        this.invalidate();
        return undefined;
    }

    /** @override */
    _createElement() {
        return document.createElementNS('http://www.w3.org/2000/svg', 'g');
    }
    /** @override */
    _updateElement(el, strokeColor, fillColor, scale) {
        el.textContent = '';

        const arcPath = primitiveShapePath(this._controlArc());
        const sw = this._getEffectiveStrokeWidth(scale);

        // Fill: chord area (arc + close)
        if (this.fill) {
            const fillEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            fillEl.setAttribute('d', `${arcPath} Z`);
            fillEl.setAttribute('fill', fillColor);
            fillEl.setAttribute('fill-opacity', String(this.fillAlpha));
            fillEl.setAttribute('stroke', 'none');
            el.appendChild(fillEl);
        }

        // Stroke: arc only (no chord line)
        const strokeEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        strokeEl.setAttribute('d', arcPath);
        strokeEl.setAttribute('stroke', strokeColor);
        strokeEl.setAttribute('stroke-width', String(sw));
        strokeEl.setAttribute('stroke-linecap', 'round');
        strokeEl.setAttribute('fill', 'none');
        el.appendChild(strokeEl);
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
            bulgePoint: { x: this._bulgePoint.x, y: this._bulgePoint.y },
            fill: this.fill,
            fillAlpha: this.fillAlpha,
            lineWidth: this.lineWidth,
        };
    }

    /** @override */
    getPropertyDescriptors() {
        return [
            { key: 'bulge', label: 'Bulge', type: 'number', min: -1, max: 1, step: 0.05 },
            { key: 'locked',    label: 'Locked',    type: 'checkbox' },
            { key: 'lineWidth', label: 'Line width', type: 'number', min: 0.05, max: 5, step: 0.05 },
            { key: 'fill',      label: 'Fill',       type: 'checkbox' },
        ];
    }
    /** @override */
    applyState(state) {
        if (state.startPoint) this.startPoint = { x: state.startPoint.x, y: state.startPoint.y };
        if (state.endPoint) this.endPoint = { x: state.endPoint.x, y: state.endPoint.y };
        if (state.bulgePoint) this.bulgePoint = { x: state.bulgePoint.x, y: state.bulgePoint.y };
        if ('fill' in state) this.fill = state.fill;
        if ('fillAlpha' in state) this.fillAlpha = state.fillAlpha;
        if ('lineWidth' in state) this.lineWidth = state.lineWidth;
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
        const json = {
            ...super.toJSON(),
            sp: { x: _r4(this._startPoint.x), y: _r4(this._startPoint.y) },
            ep: { x: _r4(this._endPoint.x), y: _r4(this._endPoint.y) },
            bp: { x: _r4(this._bulgePoint.x), y: _r4(this._bulgePoint.y) }
        };
        if (this.fill) json.f = true;
        return json;
    }
}