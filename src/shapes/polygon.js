/**
 * Polygon - SVG polygon/polyline
 */

import { Shape } from './shape.js';
import { ShapeValidator } from '../core/ShapeValidator.js';
import { distanceToSegment, pointInPolygon } from '../core/geometry.js';
import { buildPointAnchorsGroup } from '../core/ui-helpers.js';

const _r4 = v => Math.round(v * 10000) / 10000;

export class Polygon extends Shape {
    constructor(options = {}) {
        super(options);
        this.type = 'polygon';
        
        this.points = options.points || [];
        this.fill = options.fill !== undefined ? options.fill : true;
        this.fillColor = ShapeValidator.validateColor(options.fillColor || this.color);
        this.fillAlpha = options.fillAlpha ?? 0.5;
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
        if (this.fill && this.closed && pointInPolygon(point, this.points)) {
            return true;
        }
        return this.distanceTo(point) <= tolerance + this.lineWidth / 2;
    }
    
    distanceTo(point) {
        if (this.points.length < 2) return Infinity;
        
        let minDist = Infinity;
        const pts = this.points;
        const n = pts.length;
        const edgeCount = this.closed ? n : n - 1;
        
        for (let i = 0; i < edgeCount; i++) {
            const j = (i + 1) % n;
            const dist = distanceToSegment(point, pts[i], pts[j]);
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
        // Add midpoint anchors between consecutive edges (including closing edge)
        const n = this.points.length;
        const edgeCount = this.closed ? n : n - 1;
        for (let i = 0; i < edgeCount; i++) {
            const a = this.points[i];
            const b = this.points[(i + 1) % n];
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
            // Insert a new point after the segment start index
            const segIndex = parseInt(anchorId.substring(3));
            const insertIndex = segIndex + 1;
            this.points.splice(insertIndex, 0, { x, y });
            this.invalidate();
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
     * (minimum 3 points required for a polygon).
     */
    deleteAnchor(anchorId) {
        if (!anchorId.startsWith('p')) return false;
        if (this.points.length <= 3) return false;
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

        // Full rebuild every time (anchor count can change with midpoint operations)
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
        return document.createElementNS('http://www.w3.org/2000/svg', this.closed ? 'polygon' : 'polyline');
    }
    
    _updateElement(el, strokeColor, fillColor, scale) {
        // Filter out invalid points to prevent crashes
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
        
        if (this.fill && this.closed) {
            el.setAttribute('fill', fillColor);
            el.setAttribute('fill-opacity', this.fillAlpha);
        } else {
            el.setAttribute('fill', 'none');
        }
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
        return new Polygon({
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
            { key: 'locked',    label: 'Locked',     type: 'checkbox' },
            { key: 'lineWidth', label: 'Line width',  type: 'number', min: 0.05, max: 5, step: 0.05 },
            { key: 'fill',      label: 'Fill',        type: 'checkbox' },
        ];
    }

    getPosition() {
        return this.points.length > 0 ? { x: this.points[0].x, y: this.points[0].y } : { x: 0, y: 0 };
    }
    
    toJSON() {
        const json = {
            ...super.toJSON(),
            pts: this.points.flatMap(p => [_r4(p.x), _r4(p.y)]),
        };
        if (!this.closed) json.cl = false;
        if (!this.fill) json.f = false;
        if (this.fillColor !== this.color) json.fc = this.fillColor;
        if (this.fillAlpha !== 0.5) json.fa = this.fillAlpha;
        return json;
    }
}