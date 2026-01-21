/**
 * Via - A PCB via (connection between layers)
 */

import { Shape } from './Shape.js';

export class Via extends Shape {
    constructor(options = {}) {
        super(options);
        this.type = 'via';
        
        // Position (center)
        this.x = options.x || 0;
        this.y = options.y || 0;
        
        // Dimensions
        this.diameter = options.diameter || 0.8;  // Outer diameter (annular ring)
        this.hole = options.hole || 0.4;          // Drill hole diameter
        
        // Net name
        this.net = options.net || '';
        
        // Via type: 'through', 'blind', 'buried'
        this.viaType = options.viaType || 'through';
        
        // Layer span (for blind/buried vias)
        this.startLayer = options.startLayer || 'top';
        this.endLayer = options.endLayer || 'bottom';
        
        // Vias are always filled
        this.fill = true;
        this.fillAlpha = 1;
        this.color = options.color || 0x95afc0; // Bluish-gray
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
    
    _draw(g, scale) {
        const r = this.diameter / 2;
        
        // Draw outer circle
        g.drawCircle(this.x, this.y, r);
        
        // Draw hole
        g.beginHole();
        g.drawCircle(this.x, this.y, this.hole / 2);
        g.endHole();
    }
    
    _drawHandles(g, scale) {
        const handleSize = 3 / scale;
        
        g.lineStyle(1 / scale, 0xe94560, 1);
        g.beginFill(0xffffff, 1);
        
        // Just center handle for vias
        g.drawRect(this.x - handleSize/2, this.y - handleSize/2, handleSize, handleSize);
        
        g.endFill();
    }
    
    move(dx, dy) {
        this.x += dx;
        this.y += dy;
        this.invalidate();
    }
    
    clone() {
        return new Via({
            ...this.toJSON(),
            x: this.x,
            y: this.y,
            diameter: this.diameter,
            hole: this.hole,
            net: this.net,
            viaType: this.viaType,
            startLayer: this.startLayer,
            endLayer: this.endLayer
        });
    }
    
    toJSON() {
        return {
            ...super.toJSON(),
            x: this.x,
            y: this.y,
            diameter: this.diameter,
            hole: this.hole,
            net: this.net,
            viaType: this.viaType,
            startLayer: this.startLayer,
            endLayer: this.endLayer
        };
    }
}