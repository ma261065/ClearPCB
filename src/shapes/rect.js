/**
 * Rect - SVG rectangle
 */

import { Shape } from './shape.js';
import { ShapeValidator } from '../core/ShapeValidator.js';

export class Rect extends Shape {
    constructor(options = {}) {
        super(options);
        this.type = 'rect';
        
        // Validate coordinates and dimensions
        this.x = ShapeValidator.validateCoordinate(options.x || 0, { name: 'x' });
        this.y = ShapeValidator.validateCoordinate(options.y || 0, { name: 'y' });
        this.width = ShapeValidator.validateNumber(options.width || 10, { min: 0, name: 'width' });
        this.height = ShapeValidator.validateNumber(options.height || 10, { min: 0, name: 'height' });
        this.cornerRadius = ShapeValidator.validateNumber(options.cornerRadius || 0, { min: 0, name: 'cornerRadius' });
    }
    
    _calculateBounds() {
        const hw = this.lineWidth / 2;
        return {
            minX: this.x - hw,
            minY: this.y - hw,
            maxX: this.x + this.width + hw,
            maxY: this.y + this.height + hw
        };
    }
    
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
    
    distanceTo(point) {
        const cx = this.x + this.width / 2;
        const cy = this.y + this.height / 2;
        
        const dx = Math.max(Math.abs(point.x - cx) - this.width / 2, 0);
        const dy = Math.max(Math.abs(point.y - cy) - this.height / 2, 0);
        
        return Math.hypot(dx, dy);
    }
    
    getAnchors() {
        return [
            { id: 'tl', x: this.x, y: this.y, cursor: 'nwse-resize' },
            { id: 'tr', x: this.x + this.width, y: this.y, cursor: 'nesw-resize' },
            { id: 'bl', x: this.x, y: this.y + this.height, cursor: 'nesw-resize' },
            { id: 'br', x: this.x + this.width, y: this.y + this.height, cursor: 'nwse-resize' }
        ];
    }
    
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
    
    _createElement() {
        return document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    }
    
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
    
    move(dx, dy) {
        this.x += dx;
        this.y += dy;
        this.invalidate();
    }
    
    clone() {
        return new Rect({ ...this.toJSON(), x: this.x, y: this.y, width: this.width, height: this.height, cornerRadius: this.cornerRadius });
    }
    
    toJSON() {
        return { ...super.toJSON(), x: this.x, y: this.y, width: this.width, height: this.height, cornerRadius: this.cornerRadius };
    }
}