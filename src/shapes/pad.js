/**
 * Pad - A PCB solder pad
 * 
 * Pads can be various shapes: circle, rect, rounded rect, oval
 */

import { Shape } from './Shape.js';

export class Pad extends Shape {
    constructor(options = {}) {
        super(options);
        this.type = 'pad';
        
        // Position (center)
        this.x = options.x || 0;
        this.y = options.y || 0;
        
        // Pad shape: 'circle', 'rect', 'roundrect', 'oval'
        this.shape = options.shape || 'circle';
        
        // Dimensions
        this.width = options.width || 1.5;   // mm
        this.height = options.height || 1.5; // mm
        this.cornerRadius = options.cornerRadius || 0.3; // for roundrect
        
        // Hole (for through-hole pads)
        this.hole = options.hole || 0; // 0 = SMD (no hole)
        this.holeShape = options.holeShape || 'circle'; // 'circle' or 'oval'
        this.holeWidth = options.holeWidth || 0.8;
        this.holeHeight = options.holeHeight || 0.8;
        
        // Net name
        this.net = options.net || '';
        
        // Pad number/name (e.g., "1", "A1", "GND")
        this.name = options.name || '';
        
        // Rotation in radians
        this.rotation = options.rotation || 0;
        
        // Pads are always filled
        this.fill = true;
        this.fillAlpha = 1;
        this.color = options.color || 0xff6b6b; // Reddish for copper
    }
    
    _calculateBounds() {
        // TODO: account for rotation
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
        // Simple bounding box test for now
        // TODO: account for actual shape and rotation
        const bounds = this.getBounds();
        return point.x >= bounds.minX - tolerance &&
               point.x <= bounds.maxX + tolerance &&
               point.y >= bounds.minY - tolerance &&
               point.y <= bounds.maxY + tolerance;
    }
    
    distanceTo(point) {
        // Distance to center for now
        return Math.hypot(point.x - this.x, point.y - this.y);
    }
    
    _draw(g, scale) {
        const hw = this.width / 2;
        const hh = this.height / 2;
        
        // Draw pad shape
        switch (this.shape) {
            case 'circle':
                g.drawCircle(this.x, this.y, Math.max(hw, hh));
                break;
            case 'oval':
                g.drawEllipse(this.x, this.y, hw, hh);
                break;
            case 'roundrect':
                g.drawRoundedRect(this.x - hw, this.y - hh, this.width, this.height, this.cornerRadius);
                break;
            case 'rect':
            default:
                g.drawRect(this.x - hw, this.y - hh, this.width, this.height);
                break;
        }
        
        // Draw hole if present
        if (this.hole > 0) {
            // Cut out hole
            g.beginHole();
            if (this.holeShape === 'oval') {
                g.drawEllipse(this.x, this.y, this.holeWidth / 2, this.holeHeight / 2);
            } else {
                g.drawCircle(this.x, this.y, this.hole / 2);
            }
            g.endHole();
        }
    }
    
    _drawHandles(g, scale) {
        const handleSize = 3 / scale;
        
        g.lineStyle(1 / scale, 0xe94560, 1);
        g.beginFill(0xffffff, 1);
        
        // Center handle only for pads
        g.drawRect(this.x - handleSize/2, this.y - handleSize/2, handleSize, handleSize);
        
        g.endFill();
    }
    
    move(dx, dy) {
        this.x += dx;
        this.y += dy;
        this.invalidate();
    }
    
    clone() {
        return new Pad({
            ...this.toJSON(),
            x: this.x,
            y: this.y,
            shape: this.shape,
            width: this.width,
            height: this.height,
            cornerRadius: this.cornerRadius,
            hole: this.hole,
            holeShape: this.holeShape,
            holeWidth: this.holeWidth,
            holeHeight: this.holeHeight,
            net: this.net,
            name: this.name,
            rotation: this.rotation
        });
    }
    
    toJSON() {
        return {
            ...super.toJSON(),
            x: this.x,
            y: this.y,
            shape: this.shape,
            width: this.width,
            height: this.height,
            cornerRadius: this.cornerRadius,
            hole: this.hole,
            holeShape: this.holeShape,
            holeWidth: this.holeWidth,
            holeHeight: this.holeHeight,
            net: this.net,
            name: this.name,
            rotation: this.rotation
        };
    }
}