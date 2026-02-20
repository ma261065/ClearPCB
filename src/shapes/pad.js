/**
 * Pad - SVG PCB pad
 */

import { Shape } from './shape.js';

export class Pad extends Shape {
    constructor(options = {}) {
        super(options);
        this.type = 'pad';
        
        this.x = options.x || 0;
        this.y = options.y || 0;
        this.shape = options.shape || 'circle';
        this.width = options.width || 1.5;
        this.height = options.height || 1.5;
        this.cornerRadius = options.cornerRadius || 0.3;
        this.hole = options.hole || 0;
        this.holeShape = options.holeShape || 'circle';
        this.holeWidth = options.holeWidth || 0.8;
        this.holeHeight = options.holeHeight || 0.8;
        this.net = options.net || '';
        this.name = options.name || '';
        this.rotation = options.rotation || 0;
        
        this.fill = true;
        this.fillAlpha = 1;
        this.color = options.color || '#ff6b6b';
    }
    
    _calculateBounds() {
        const hw = this.width / 2;
        const hh = this.height / 2;
        return {
            minX: this.x - hw,
            minY: this.y - hh,
            maxX: this.x + hw,
            maxY: this.y + hh
        };
    }
    
    hitTest(point, tolerance = 0.5) {
        const bounds = this.getBounds();
        return point.x >= bounds.minX - tolerance &&
               point.x <= bounds.maxX + tolerance &&
               point.y >= bounds.minY - tolerance &&
               point.y <= bounds.maxY + tolerance;
    }
    
    distanceTo(point) {
        return Math.hypot(point.x - this.x, point.y - this.y);
    }
    
    _createElement() {
        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        this._padEl = null;
        this._holeEl = null;
        this._lastPadTag = null;
        this._lastHoleTag = null;
        return g;
    }
    
    _updateElement(el, strokeColor, fillColor, scale) {
        const hw = this.width / 2;
        const hh = this.height / 2;
        const SVG_NS = 'http://www.w3.org/2000/svg';
        
        // Determine required SVG tag for pad shape
        const padTag = (this.shape === 'circle') ? 'circle'
            : (this.shape === 'oval') ? 'ellipse'
            : 'rect';
        
        // Recreate pad element only if tag changed
        if (padTag !== this._lastPadTag) {
            if (this._padEl) this._padEl.remove();
            this._padEl = document.createElementNS(SVG_NS, padTag);
            // Insert before hole if it exists
            if (this._holeEl) {
                el.insertBefore(this._padEl, this._holeEl);
            } else {
                el.appendChild(this._padEl);
            }
            this._lastPadTag = padTag;
        }
        
        // Update pad attributes
        switch (this.shape) {
            case 'circle':
                this._padEl.setAttribute('cx', this.x);
                this._padEl.setAttribute('cy', this.y);
                this._padEl.setAttribute('r', Math.max(hw, hh));
                break;
            case 'oval':
                this._padEl.setAttribute('cx', this.x);
                this._padEl.setAttribute('cy', this.y);
                this._padEl.setAttribute('rx', hw);
                this._padEl.setAttribute('ry', hh);
                break;
            case 'roundrect':
                this._padEl.setAttribute('x', this.x - hw);
                this._padEl.setAttribute('y', this.y - hh);
                this._padEl.setAttribute('width', this.width);
                this._padEl.setAttribute('height', this.height);
                this._padEl.setAttribute('rx', this.cornerRadius);
                break;
            case 'rect':
            default:
                this._padEl.setAttribute('x', this.x - hw);
                this._padEl.setAttribute('y', this.y - hh);
                this._padEl.setAttribute('width', this.width);
                this._padEl.setAttribute('height', this.height);
                this._padEl.removeAttribute('rx');
                break;
        }
        this._padEl.setAttribute('fill', fillColor);
        
        // Handle hole element
        if (this.hole > 0) {
            const holeTag = this.holeShape === 'oval' ? 'ellipse' : 'circle';
            if (holeTag !== this._lastHoleTag) {
                if (this._holeEl) this._holeEl.remove();
                this._holeEl = document.createElementNS(SVG_NS, holeTag);
                this._holeEl.setAttribute('fill', '#000');
                el.appendChild(this._holeEl);
                this._lastHoleTag = holeTag;
            }
            if (this.holeShape === 'oval') {
                this._holeEl.setAttribute('cx', this.x);
                this._holeEl.setAttribute('cy', this.y);
                this._holeEl.setAttribute('rx', this.holeWidth / 2);
                this._holeEl.setAttribute('ry', this.holeHeight / 2);
            } else {
                this._holeEl.setAttribute('cx', this.x);
                this._holeEl.setAttribute('cy', this.y);
                this._holeEl.setAttribute('r', this.hole / 2);
            }
        } else if (this._holeEl) {
            this._holeEl.remove();
            this._holeEl = null;
            this._lastHoleTag = null;
        }
    }
    
    move(dx, dy) {
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
        this.x += dx;
        this.y += dy;
        this.invalidate();
    }
    
    clone() {
        return new Pad({ ...this.toJSON() });
    }
    
    toJSON() {
        return {
            ...super.toJSON(),
            x: this.x, y: this.y, shape: this.shape,
            width: this.width, height: this.height, cornerRadius: this.cornerRadius,
            hole: this.hole, holeShape: this.holeShape, holeWidth: this.holeWidth, holeHeight: this.holeHeight,
            net: this.net, name: this.name, rotation: this.rotation
        };
    }
}