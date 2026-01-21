/**
 * Via - SVG PCB via
 */

import { Shape } from './Shape.js';

export class Via extends Shape {
    constructor(options = {}) {
        super(options);
        this.type = 'via';
        
        this.x = options.x || 0;
        this.y = options.y || 0;
        this.diameter = options.diameter || 0.8;
        this.hole = options.hole || 0.4;
        this.net = options.net || '';
        this.viaType = options.viaType || 'through';
        this.startLayer = options.startLayer || 'top';
        this.endLayer = options.endLayer || 'bottom';
        
        this.fill = true;
        this.fillAlpha = 1;
        this.color = options.color || '#95afc0';
    }
    
    _calculateBounds() {
        const r = this.diameter / 2;
        return {
            minX: this.x - r,
            minY: this.y - r,
            maxX: this.x + r,
            maxY: this.y + r
        };
    }
    
    hitTest(point, tolerance = 0.5) {
        const dist = Math.hypot(point.x - this.x, point.y - this.y);
        return dist <= this.diameter / 2 + tolerance;
    }
    
    distanceTo(point) {
        return Math.max(0, Math.hypot(point.x - this.x, point.y - this.y) - this.diameter / 2);
    }
    
    _createElement() {
        return document.createElementNS('http://www.w3.org/2000/svg', 'g');
    }
    
    _updateElement(el, strokeColor, fillColor, scale) {
        const r = this.diameter / 2;
        const hr = this.hole / 2;
        
        el.innerHTML = `
            <circle cx="${this.x}" cy="${this.y}" r="${r}" fill="${fillColor}"/>
            <circle cx="${this.x}" cy="${this.y}" r="${hr}" fill="#000"/>
        `;
    }
    
    move(dx, dy) {
        this.x += dx;
        this.y += dy;
        this.invalidate();
    }
    
    clone() {
        return new Via({ ...this.toJSON() });
    }
    
    toJSON() {
        return {
            ...super.toJSON(),
            x: this.x, y: this.y, diameter: this.diameter, hole: this.hole,
            net: this.net, viaType: this.viaType, startLayer: this.startLayer, endLayer: this.endLayer
        };
    }
}