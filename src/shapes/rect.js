/**
 * Rect - SVG rectangle
 */

import { Shape } from './shape.js';
import { ShapeValidator } from '../core/ShapeValidator.js';

/** Round to 4 decimal places for compact serialisation. */
const _r4 = v => Math.round(v * 10000) / 10000;

export class Rect extends Shape {
    /**
     * @param {Object} [options]
     * @param {number}  [options.x=0]           - Top-left X in mm.
     * @param {number}  [options.y=0]           - Top-left Y in mm.
     * @param {number}  [options.width=10]      - Width in mm.
     * @param {number}  [options.height=10]     - Height in mm.
     * @param {number}  [options.cornerRadius=0] - Corner rounding radius.
     * @param {boolean} [options.fill=false]     - Whether the rect is filled.
     * @param {string}  [options.fillColor]      - Fill colour.
     * @param {number}  [options.fillAlpha=0.3]  - Fill opacity.
     */
    constructor(options = {}) {
        super(options);
        this.type = 'rect';
        
        // Validate coordinates and dimensions
        this.x = ShapeValidator.validateCoordinate(options.x || 0, { name: 'x' });
        this.y = ShapeValidator.validateCoordinate(options.y || 0, { name: 'y' });
        this.width = ShapeValidator.validateNumber(options.width || 10, { min: 0, name: 'width' });
        this.height = ShapeValidator.validateNumber(options.height || 10, { min: 0, name: 'height' });
        this.cornerRadius = ShapeValidator.validateNumber(options.cornerRadius || 0, { min: 0, name: 'cornerRadius' });
        
        // Fill properties
        this.fill = options.fill !== undefined ? options.fill : false;
        this.fillColor = ShapeValidator.validateColor(options.fillColor || this.color);
        this.fillAlpha = ShapeValidator.validateNumber(options.fillAlpha ?? 0.3, {
            min: 0, max: 1, default: 0.3, name: 'fillAlpha'
        });
    }
    
    /** @override */
    _calculateBounds() {
        const hw = this.lineWidth / 2;
        return {
            minX: this.x - hw,
            minY: this.y - hw,
            maxX: this.x + this.width + hw,
            maxY: this.y + this.height + hw
        };
    }
    
    /** @override */
    hitTest(point, tolerance = 0.5) {
        const bounds = this.getBounds();
        const expanded = {
            minX: bounds.minX - tolerance,
            minY: bounds.minY - tolerance,
            maxX: bounds.maxX + tolerance,
            maxY: bounds.maxY + tolerance
        };
        
        const insideOuter = point.x >= expanded.minX && point.x <= expanded.maxX &&
                           point.y >= expanded.minY && point.y <= expanded.maxY;
        
        if (!insideOuter) return false;
        
        // If filled, we hit anywhere inside
        if (this.fill) return true;
        
        const inner = {
            minX: this.x + this.lineWidth / 2 + tolerance,
            minY: this.y + this.lineWidth / 2 + tolerance,
            maxX: this.x + this.width - this.lineWidth / 2 - tolerance,
            maxY: this.y + this.height - this.lineWidth / 2 - tolerance
        };
        
        const insideInner = point.x > inner.minX && point.x < inner.maxX &&
                            point.y > inner.minY && point.y < inner.maxY;
                            
        // If inside outer but NOT inside inner, we are on the border
        return !insideInner;
    }
    
    /** @override */
    distanceTo(point) {
        const cx = this.x + this.width / 2;
        const cy = this.y + this.height / 2;
        
        const dx = Math.max(Math.abs(point.x - cx) - this.width / 2, 0);
        const dy = Math.max(Math.abs(point.y - cy) - this.height / 2, 0);
        
        return Math.hypot(dx, dy);
    }
    
    /** @override */
    getAnchors() {
        return [
            { id: 'tl', x: this.x, y: this.y, cursor: 'nwse-resize' },
            { id: 'tr', x: this.x + this.width, y: this.y, cursor: 'nesw-resize' },
            { id: 'bl', x: this.x, y: this.y + this.height, cursor: 'nesw-resize' },
            { id: 'br', x: this.x + this.width, y: this.y + this.height, cursor: 'nwse-resize' }
        ];
    }
    
    /** @override — returns new anchor ID when dimensions flip. */
    moveAnchor(anchorId, x, y) {
        switch (anchorId) {
            case 'tl':
                this.width += this.x - x;
                this.height += this.y - y;
                this.x = x;
                this.y = y;
                break;
            case 'tr':
                this.width = x - this.x;
                this.height += this.y - y;
                this.y = y;
                break;
            case 'bl':
                this.width += this.x - x;
                this.x = x;
                this.height = y - this.y;
                break;
            case 'br':
                this.width = x - this.x;
                this.height = y - this.y;
                break;
        }
        
        // Track if we flip
        let flippedX = false;
        let flippedY = false;
        
        // Normalize negative dimensions
        if (this.width < 0) {
            this.x += this.width;
            this.width = -this.width;
            flippedX = true;
        }
        if (this.height < 0) {
            this.y += this.height;
            this.height = -this.height;
            flippedY = true;
        }
        
        // Calculate new anchor ID after flipping
        let newAnchorId = anchorId;
        if (flippedX || flippedY) {
            const isLeft = anchorId === 'tl' || anchorId === 'bl';
            const isTop = anchorId === 'tl' || anchorId === 'tr';
            
            const newIsLeft = flippedX ? !isLeft : isLeft;
            const newIsTop = flippedY ? !isTop : isTop;
            
            if (newIsTop && newIsLeft) newAnchorId = 'tl';
            else if (newIsTop && !newIsLeft) newAnchorId = 'tr';
            else if (!newIsTop && newIsLeft) newAnchorId = 'bl';
            else newAnchorId = 'br';
        }
        
        this.invalidate();
        return newAnchorId;
    }
    
    /** @override */
    _createElement() {
        return document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    }
    /** @override */
    _updateElement(el, strokeColor, fillColor, scale) {
        el.setAttribute('x', this.x);
        el.setAttribute('y', this.y);
        el.setAttribute('width', this.width);
        el.setAttribute('height', this.height);
        el.setAttribute('stroke', strokeColor);
        el.setAttribute('stroke-width', this._getEffectiveStrokeWidth(scale));
        
        if (this.cornerRadius > 0) {
            el.setAttribute('rx', this.cornerRadius);
            el.setAttribute('ry', this.cornerRadius);
        }
        
        if (this.fill) {
            el.setAttribute('fill', fillColor);
            el.setAttribute('fill-opacity', this.fillAlpha);
        } else {
            el.setAttribute('fill', 'none');
        }
    }
    
    /** @override */
    move(dx, dy) {
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
        this.x += dx;
        this.y += dy;
        this.invalidate();
    }
    
    /** @override */
    clone() {
        return new Rect({ ...this.toJSON(), x: this.x, y: this.y, width: this.width, height: this.height, cornerRadius: this.cornerRadius });
    }
    /** @override */
        captureState() {
        return { x: this.x, y: this.y, width: this.width, height: this.height };
    }
    
    /** @override */
    getPropertyDescriptors() {
        return [
            { key: 'locked',    label: 'Locked',     type: 'checkbox' },
            { key: 'lineWidth', label: 'Line width',  type: 'number', min: 0.05, max: 5, step: 0.05 },
            { key: 'fill',      label: 'Fill',        type: 'checkbox' },
        ];
    }
    /** @override */
    toJSON() {
        const json = { ...super.toJSON(), x: _r4(this.x), y: _r4(this.y), w: _r4(this.width), h: _r4(this.height) };
        if (this.cornerRadius) json.cr = _r4(this.cornerRadius);
        if (this.fill) json.f = true;
        if (this.fillColor !== this.color) json.fc = this.fillColor;
        if (this.fillAlpha !== 0.3) json.fa = this.fillAlpha;
        return json;
    }
}