/**
 * Wire - Multi-segment wire for connecting component pins
 * Wires consist of multiple line segments forming a path.
 * Supports midpoint anchors (+ in circle) for inserting new points,
 * junction dots where wires join, and sticky connections to pins.
 */

import { Shape } from './shape.js';
import { distanceToSegment } from '../core/geometry.js';
import { ShapeValidator } from '../core/ShapeValidator.js';
import { buildPointAnchorsGroup } from '../core/ui-helpers.js';

const _r4 = v => Math.round(v * 10000) / 10000;

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

        // Junction indices — points where another wire T-joins onto this wire
        // Stored as Set of point indices that should render a junction dot
        this.junctions = new Set(options.junctions || []);
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
     * Return the index of the segment closest to the given point,
     * or -1 if the wire has fewer than 2 points.
     */
    hitTestSegment(point, tolerance = 0.5) {
        if (this.points.length < 2) return -1;
        const { segIndex, distance } = this.closestSegment(point);
        return distance <= tolerance + this.lineWidth / 2 ? segIndex : -1;
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
            const dist = distanceToSegment(point, p1, p2);
            minDist = Math.min(minDist, dist);
        }

        return minDist;
    }

    /**
     * Get anchor points for editing — vertex anchors + midpoint insertion anchors
     */
    getAnchors() {
        const anchors = this.points.map((p, i) => ({
            id: `p${i}`,
            x: p.x,
            y: p.y,
            cursor: 'nwse-resize'
        }));
        // Add midpoint anchors between consecutive points (+ in circle)
        for (let i = 0; i < this.points.length - 1; i++) {
            const a = this.points[i];
            const b = this.points[i + 1];
            anchors.push({
                id: `mid${i}`,
                x: (a.x + b.x) / 2,
                y: (a.y + b.y) / 2,
                cursor: 'copy',
                midpoint: true
            });
        }
        return anchors;
    }

    /**
     * Move an anchor (waypoint) or insert a new point at a midpoint
     */
    moveAnchor(anchorId, x, y) {
        if (anchorId.startsWith('mid')) {
            // Insert a new point at the midpoint position
            const segIndex = parseInt(anchorId.substring(3));
            const insertIndex = segIndex + 1;
            this.points.splice(insertIndex, 0, { x, y });
            // Shift junction indices that are at or after the insertion point
            const shifted = new Set();
            for (const j of this.junctions) {
                shifted.add(j >= insertIndex ? j + 1 : j);
            }
            this.junctions = shifted;
            this.invalidate();
            return `p${insertIndex}`;
        }
        const match = anchorId.match(/^p(\d+)$/);
        if (match) {
            const idx = parseInt(match[1]);
            if (idx >= 0 && idx < this.points.length) {
                this.points[idx] = { x, y };
                this.invalidate();
            }
        }
    }

    /**
     * Delete a point anchor. Returns true if deleted, false if not allowed.
     * Minimum 2 points required.
     */
    deleteAnchor(anchorId) {
        if (!anchorId.startsWith('p')) return false;
        if (this.points.length <= 2) return false;
        const index = parseInt(anchorId.substring(1));
        if (index < 0 || index >= this.points.length) return false;
        this.points.splice(index, 1);
        // Remove junction at deleted index, shift those after
        const shifted = new Set();
        for (const j of this.junctions) {
            if (j === index) continue;
            shifted.add(j > index ? j - 1 : j);
        }
        this.junctions = shifted;
        this.invalidate();
        return true;
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
     * Find the segment index closest to the given point.
     * Returns { segIndex, t, point } where t is the parameter along the segment (0–1).
     */
    closestSegment(point) {
        let bestDist = Infinity, bestSeg = -1, bestT = 0;
        for (let i = 0; i < this.points.length - 1; i++) {
            const a = this.points[i], b = this.points[i + 1];
            const dx = b.x - a.x, dy = b.y - a.y;
            const lenSq = dx * dx + dy * dy;
            let t = lenSq === 0 ? 0 : ((point.x - a.x) * dx + (point.y - a.y) * dy) / lenSq;
            t = Math.max(0, Math.min(1, t));
            const px = a.x + t * dx, py = a.y + t * dy;
            const d = Math.hypot(point.x - px, point.y - py);
            if (d < bestDist) { bestDist = d; bestSeg = i; bestT = t; }
        }
        const a = this.points[bestSeg], b = this.points[bestSeg + 1];
        return {
            segIndex: bestSeg,
            t: bestT,
            point: { x: a.x + bestT * (b.x - a.x), y: a.y + bestT * (b.y - a.y) },
            distance: bestDist
        };
    }

    /**
     * Split this wire at the given point, inserting a new vertex.
     * Returns the index of the inserted point.
     */
    splitAt(point) {
        const { segIndex } = this.closestSegment(point);
        const insertIndex = segIndex + 1;
        this.points.splice(insertIndex, 0, { x: point.x, y: point.y });
        // Shift junction indices
        const shifted = new Set();
        for (const j of this.junctions) {
            shifted.add(j >= insertIndex ? j + 1 : j);
        }
        this.junctions = shifted;
        this.invalidate();
        return insertIndex;
    }

    /**
     * Check if a point is at (or very near) an endpoint of this wire.
     * Returns 'start', 'end', or null.
     */
    endpointAt(point, epsilon = 0.15) {
        if (this.points.length === 0) return null;
        const s = this.points[0], e = this.points[this.points.length - 1];
        if (Math.hypot(point.x - s.x, point.y - s.y) < epsilon) return 'start';
        if (Math.hypot(point.x - e.x, point.y - e.y) < epsilon) return 'end';
        return null;
    }

    /**
     * Check if a point lies on a segment (not at an endpoint) within tolerance.
     * Returns { segIndex, point } or null.
     */
    pointOnSegment(point, tolerance = 0.15) {
        const result = this.closestSegment(point);
        if (result.distance > tolerance) return null;
        // Exclude if at an existing vertex
        for (const p of this.points) {
            if (Math.hypot(point.x - p.x, point.y - p.y) < tolerance) return null;
        }
        return result;
    }

    _updateAnchors(scale) {
        if (!this.selected) {
            if (this.anchorsGroup) {
                this.anchorsGroup.remove();
                this.anchorsGroup = null;
                this._anchorRects = null;
            }
            return;
        }

        // Full rebuild every time (anchors can change count when midpoints are used)
        if (this.anchorsGroup) {
            this.anchorsGroup.remove();
        }

        const { group, rects } = buildPointAnchorsGroup(this, scale);
        this.anchorsGroup = group;
        this._anchorRects = rects;

        if (this.element?.parentNode) {
            this.element.parentNode.insertBefore(this.anchorsGroup, this.element.nextSibling);
        }
    }

    /**
     * Create SVG element — a group containing polyline + junction dots
     */
    _createElement() {
        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'polyline'));
        return g;
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

        const polyline = el.querySelector('polyline') || el;
        const points = validPoints.map(p => `${p.x},${p.y}`).join(' ');
        polyline.setAttribute('points', points);
        polyline.setAttribute('stroke', strokeColor);
        polyline.setAttribute('stroke-width', this._getEffectiveStrokeWidth(scale));
        polyline.setAttribute('stroke-linecap', 'round');
        polyline.setAttribute('stroke-linejoin', 'round');
        polyline.setAttribute('fill', 'none');

        // Render junction dots
        // Remove existing junction circles
        const existing = el.querySelectorAll('.junction-dot');
        for (const c of existing) c.remove();

        const junctionRadius = Math.max(0.4, 2.5 / scale);
        for (const idx of this.junctions) {
            if (idx < 0 || idx >= this.points.length) continue;
            const p = this.points[idx];
            const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            circle.setAttribute('cx', p.x);
            circle.setAttribute('cy', p.y);
            circle.setAttribute('r', junctionRadius);
            circle.setAttribute('fill', strokeColor);
            circle.setAttribute('stroke', 'none');
            circle.classList.add('junction-dot');
            el.appendChild(circle);
        }
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
            junctions: [...this.junctions]
        });
    }
    
    captureState() {
        return {
            points: this.points.map(p => ({ x: p.x, y: p.y })),
            connections: {
                start: this.connections.start ? { ...this.connections.start } : null,
                end: this.connections.end ? { ...this.connections.end } : null
            },
            net: this.net,
            junctions: [...this.junctions]
        };
    }
    
    applyState(state) {
        if (state.points) {
            this.points = state.points.map(p => ({ x: p.x, y: p.y }));
        }
        if (state.connections !== undefined) this.connections = state.connections;
        if (state.net !== undefined) this.net = state.net;
        if (state.junctions !== undefined) this.junctions = new Set(state.junctions);
        this.invalidate();
    }
    
    getPosition() {
        return this.points.length > 0 ? { x: this.points[0].x, y: this.points[0].y } : { x: 0, y: 0 };
    }
    
    getAnchorSnapMode(anchorId) {
        return 'axis';
    }
    
    getPropertyDescriptors() {
        return [
            { key: 'locked', label: 'Locked', type: 'checkbox' },
        ];
    }

    /**
     * Serialize to JSON
     */
    toJSON() {
        const json = {
            ...super.toJSON(),
            type: 'wire',
            pts: this.points.flatMap(p => [_r4(p.x), _r4(p.y)]),
        };
        if (this.connections.start || this.connections.end) {
            json.cn = {
                start: this.connections.start ? { ...this.connections.start } : null,
                end: this.connections.end ? { ...this.connections.end } : null
            };
        }
        if (this.net) json.n = this.net;
        if (this.junctions.size > 0) json.jn = [...this.junctions];
        return json;
    }
}
