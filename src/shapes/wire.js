/**
 * Wire - Multi-segment wire for connecting component pins
 * Wires consist of multiple line segments forming a path
 */

import { Shape } from './shape.js';
import { ShapeValidator } from '../core/ShapeValidator.js';

export class Wire extends Shape {
    constructor(options = {}) {
        super(options);
        this.type = 'wire';
        
        // Array of points defining the wire path: [{x, y}, {x, y}, ...]
        this.points = options.points || [];
        
        // If initialized from old-style x1/y1/x2/y2, convert to points array
        if (options.x1 !== undefined && options.y1 !== undefined && options.x2 !== undefined && options.y2 !== undefined) {
            this.points = [
                { x: options.x1, y: options.y1 },
                { x: options.x2, y: options.y2 }
            ];
        }
        
        // Validate all points
        this.points = this.points.map(p => ({
            x: ShapeValidator.validateCoordinate(p.x || 0, { name: 'x' }),
            y: ShapeValidator.validateCoordinate(p.y || 0, { name: 'y' })
        }));
        
        // Connection info: which component pins (if any) this wire connects to
        this.connections = options.connections || {
            start: null,  // { componentId, pinNumber }
            end: null     // { componentId, pinNumber }
        };
        
        // Net information (for schematic purposes)
        this.net = options.net || '';
    }

    _calculateBounds() {
        if (this.points.length === 0) {
            return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
        }

        let minX = this.points[0].x;
        let maxX = this.points[0].x;
        let minY = this.points[0].y;
        let maxY = this.points[0].y;

        for (const p of this.points) {
            minX = Math.min(minX, p.x);
            maxX = Math.max(maxX, p.x);
            minY = Math.min(minY, p.y);
            maxY = Math.max(maxY, p.y);
        }

        const hw = this.lineWidth / 2;
        return {
            minX: minX - hw,
            minY: minY - hw,
            maxX: maxX + hw,
            maxY: maxY + hw
        };
    }

    /**
     * Hit test - check if point is on or near the wire
     */
    hitTest(point, tolerance = 0.5) {
        return this.distanceTo(point) <= tolerance + this.lineWidth / 2;
    }

    /**
     * Distance from point to nearest segment of the wire
     */
    distanceTo(point) {
        if (this.points.length < 2) return Infinity;

        let minDist = Infinity;
        
        for (let i = 0; i < this.points.length - 1; i++) {
            const p1 = this.points[i];
            const p2 = this.points[i + 1];
            const dist = this._distanceToSegment(point, p1, p2);
            minDist = Math.min(minDist, dist);
        }

        return minDist;
    }

    /**
     * Distance from point to a line segment
     */
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

    /**
     * Get anchor points for editing
     */
    getAnchors() {
        return this.points.map((p, i) => ({
            id: `point${i}`,
            x: p.x,
            y: p.y,
            cursor: 'move'
        }));
    }

    /**
     * Move an anchor (waypoint)
     */
    moveAnchor(anchorId, x, y) {
        const match = anchorId.match(/point(\d+)/);
        if (match) {
            const idx = parseInt(match[1]);
            if (idx >= 0 && idx < this.points.length) {
                this.points[idx] = { x, y };
                this.invalidate();
            }
        }
    }

    /**
     * Add a waypoint at the specified position
     */
    addWaypoint(x, y) {
        this.points.push({ x, y });
        this.invalidate();
    }

    /**
     * Get the last point in the wire path
     */
    getEndPoint() {
        return this.points.length > 0 ? { ...this.points[this.points.length - 1] } : null;
    }

    /**
     * Get the start point in the wire path
     */
    getStartPoint() {
        return this.points.length > 0 ? { ...this.points[0] } : null;
    }

    /**
     * Create SVG element
     */
    _createElement() {
        return document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    }

    /**
     * Update SVG element
     */
    _updateElement(el, strokeColor, fillColor, scale) {
        // Filter out invalid points to prevent crashes
        const validPoints = this.points.filter(p => 
            p && typeof p.x === 'number' && !isNaN(p.x) && 
            typeof p.y === 'number' && !isNaN(p.y)
        );

        const points = validPoints.map(p => `${p.x},${p.y}`).join(' ');
        el.setAttribute('points', points);
        el.setAttribute('stroke', strokeColor);
        el.setAttribute('stroke-width', this._getEffectiveStrokeWidth(scale));
        el.setAttribute('stroke-linecap', 'round');
        el.setAttribute('stroke-linejoin', 'round');
        el.setAttribute('fill', 'none');
    }

    /**
     * Move the entire wire
     */
    move(dx, dy) {
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
        for (const p of this.points) {
            p.x += dx;
            p.y += dy;
        }
        this.invalidate();
    }

    /**
     * Clone the wire
     */
    clone() {
        return new Wire({
            ...this.toJSON(),
            points: this.points.map(p => ({ ...p })),
            connections: { ...this.connections }
        });
    }

    /**
     * Serialize to JSON
     */
    toJSON() {
        return {
            ...super.toJSON(),
            type: 'wire',
            points: this.points.map(p => ({ x: p.x, y: p.y })),
            connections: this.connections,
            net: this.net
        };
    }
}
