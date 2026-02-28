/**
 * Line - SVG multi-point polyline (open, no fill)
 */

import { Shape } from './shape.js';
import { distanceToSegment } from '../core/geometry.js';
import { ShapeValidator } from '../core/ShapeValidator.js';
import { buildPointAnchorsGroup } from '../core/ui-helpers.js';

const _r4 = v => Math.round(v * 10000) / 10000;

export class Line extends Shape {
    constructor(options = {}) {
        super(options);
        this.type = 'line';
        
        // Support both legacy 2-point format (x1/y1/x2/y2) and new multi-point format
        if (options.points && options.points.length >= 2) {
            this.points = options.points.map(p => ({ x: p.x, y: p.y }));
        } else {
            const x1 = ShapeValidator.validateCoordinate(options.x1 || 0, { name: 'x1' });
            const y1 = ShapeValidator.validateCoordinate(options.y1 || 0, { name: 'y1' });
            const x2 = ShapeValidator.validateCoordinate(options.x2 || 0, { name: 'x2' });
            const y2 = ShapeValidator.validateCoordinate(options.y2 || 0, { name: 'y2' });
            this.points = [{ x: x1, y: y1 }, { x: x2, y: y2 }];
        }
    }

    // Legacy accessors for backward compatibility
    get x1() { return this.points[0]?.x || 0; }
    set x1(v) { if (this.points[0]) this.points[0].x = v; }
    get y1() { return this.points[0]?.y || 0; }
    set y1(v) { if (this.points[0]) this.points[0].y = v; }
    get x2() { return this.points[this.points.length - 1]?.x || 0; }
    set x2(v) { if (this.points.length > 0) this.points[this.points.length - 1].x = v; }
    get y2() { return this.points[this.points.length - 1]?.y || 0; }
    set y2(v) { if (this.points.length > 0) this.points[this.points.length - 1].y = v; }
    
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
        return this.distanceTo(point) <= tolerance + this.lineWidth / 2;
    }
    
    distanceTo(point) {
        if (this.points.length < 2) return Infinity;
        let minDist = Infinity;
        for (let i = 0; i < this.points.length - 1; i++) {
            const dist = distanceToSegment(point, this.points[i], this.points[i + 1]);
            minDist = Math.min(minDist, dist);
        }
        return minDist;
    }
    
    getAnchors() {
        const anchors = this.points.map((p, i) => ({
            id: `p${i}`,
            x: p.x,
            y: p.y,
            cursor: 'nwse-resize'
        }));
        // Add midpoint anchors between consecutive points
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
    
    moveAnchor(anchorId, x, y) {
        if (anchorId.startsWith('mid')) {
            // Insert a new point at the midpoint position
            const segIndex = parseInt(anchorId.substring(3));
            const insertIndex = segIndex + 1;
            this.points.splice(insertIndex, 0, { x, y });
            this.invalidate();
            // Return the new point's anchor ID so the drag system tracks it
            return `p${insertIndex}`;
        }
        const index = parseInt(anchorId.substring(1));
        if (index >= 0 && index < this.points.length) {
            this.points[index].x = x;
            this.points[index].y = y;
        }
        this.invalidate();
    }

    /**
     * Delete a point anchor. Returns true if deleted, false if not allowed
     * (minimum 2 points required).
     */
    deleteAnchor(anchorId) {
        if (!anchorId.startsWith('p')) return false;
        if (this.points.length <= 2) return false;
        const index = parseInt(anchorId.substring(1));
        if (index < 0 || index >= this.points.length) return false;
        this.points.splice(index, 1);
        this.invalidate();
        return true;
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

        if (this.element.parentNode) {
            this.element.parentNode.insertBefore(this.anchorsGroup, this.element.nextSibling);
        }
    }

    _createElement() {
        return document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    }
    
    _updateElement(el, strokeColor, fillColor, scale) {
        const validPoints = this.points.filter(p => 
            p && typeof p.x === 'number' && !isNaN(p.x) && 
            typeof p.y === 'number' && !isNaN(p.y)
        );
        const pointsStr = validPoints.map(p => `${p.x},${p.y}`).join(' ');
        el.setAttribute('points', pointsStr);
        el.setAttribute('stroke', strokeColor);
        el.setAttribute('stroke-width', this._getEffectiveStrokeWidth(scale));
        el.setAttribute('stroke-linecap', 'round');
        el.setAttribute('stroke-linejoin', 'round');
        el.setAttribute('fill', 'none');
    }
    
    move(dx, dy) {
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
        for (const p of this.points) {
            p.x += dx;
            p.y += dy;
        }
        this.invalidate();
    }
    
    clone() {
        return new Line({
            ...this.toJSON(),
            points: this.points.map(p => ({ x: p.x, y: p.y }))
        });
    }
    
    captureState() {
        return { points: this.points.map(p => ({ x: p.x, y: p.y })) };
    }

    applyState(state) {
        if (state.points) {
            this.points = state.points.map(p => ({ x: p.x, y: p.y }));
        }
        this.invalidate();
    }

    getPropertyDescriptors() {
        return [
            { key: 'locked',    label: 'Locked',    type: 'checkbox' },
            { key: 'lineWidth', label: 'Line width', type: 'number', min: 0.05, max: 5, step: 0.05 },
        ];
    }

    getPosition() {
        return this.points.length > 0 ? { x: this.points[0].x, y: this.points[0].y } : { x: 0, y: 0 };
    }
    
    toJSON() {
        return {
            ...super.toJSON(),
            pts: this.points.flatMap(p => [_r4(p.x), _r4(p.y)])
        };
    }
}