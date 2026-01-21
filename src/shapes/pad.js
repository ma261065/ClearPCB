/**
 * Pad - SVG PCB pad
 */

import { Shape } from './Shape.js';

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
        return document.createElementNS('http://www.w3.org/2000/svg', 'g');
    }
    
    _updateElement(el, strokeColor, fillColor, scale) {
        const hw = this.width / 2;
        const hh = this.height / 2;
        
        let svg = '';
        
        // Pad shape
        switch (this.shape) {
            case 'circle':
                svg += `<circle cx="${this.x}" cy="${this.y}" r="${Math.max(hw, hh)}" fill="${fillColor}"/>`;
                break;
            case 'oval':
                svg += `<ellipse cx="${this.x}" cy="${this.y}" rx="${hw}" ry="${hh}" fill="${fillColor}"/>`;
                break;
            case 'roundrect':
                svg += `<rect x="${this.x - hw}" y="${this.y - hh}" width="${this.width}" height="${this.height}" rx="${this.cornerRadius}" fill="${fillColor}"/>`;
                break;
            case 'rect':
            default:
                svg += `<rect x="${this.x - hw}" y="${this.y - hh}" width="${this.width}" height="${this.height}" fill="${fillColor}"/>`;
                break;
        }
        
        // Hole (black)
        if (this.hole > 0) {
            if (this.holeShape === 'oval') {
                svg += `<ellipse cx="${this.x}" cy="${this.y}" rx="${this.holeWidth/2}" ry="${this.holeHeight/2}" fill="#000"/>`;
            } else {
                svg += `<circle cx="${this.x}" cy="${this.y}" r="${this.hole/2}" fill="#000"/>`;
            }
        }
        
        el.innerHTML = svg;
    }
    
    move(dx, dy) {
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