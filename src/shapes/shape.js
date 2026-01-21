/**
 * Shape - Base class for all PCB shapes (SVG version)
 * 
 * All coordinates are in world units (mm).
 * Each shape manages its own SVG element.
 */

let shapeIdCounter = 0;

export class Shape {
    constructor(options = {}) {
        this.id = options.id || `shape_${++shapeIdCounter}`;
        this.type = 'shape';
        
        // Layer (for PCB: top, bottom, silkscreen, etc.)
        this.layer = options.layer || 'top';
        
        // Visual properties
        this.color = options.color || '#00b894';
        this.lineWidth = options.lineWidth || 0.2; // mm
        this.fill = options.fill !== undefined ? options.fill : false;
        this.fillColor = options.fillColor || this.color;
        this.fillAlpha = options.fillAlpha || 0.3;
        
        // State
        this.selected = false;
        this.hovered = false;
        this.visible = true;
        this.locked = false;
        
        // SVG element (created on first render)
        this.element = null;
        
        // Cached bounds
        this._bounds = null;
        this._dirty = true;
    }
    
    // Convert color to CSS format
    _colorToCSS(color) {
        if (typeof color === 'string') return color;
        // Convert hex number to CSS hex string
        return '#' + color.toString(16).padStart(6, '0');
    }
    
    getBounds() {
        if (!this._bounds || this._dirty) {
            this._bounds = this._calculateBounds();
        }
        return this._bounds;
    }
    
    _calculateBounds() {
        return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    }
    
    hitTest(point, tolerance = 0.5) {
        return false;
    }
    
    distanceTo(point) {
        return Infinity;
    }
    
    invalidate() {
        this._dirty = true;
        this._bounds = null;
    }
    
    render(scale) {
        if (!this.element) {
            this.element = this._createElement();
        }
        
        if (!this.visible) {
            this.element.style.display = 'none';
            return this.element;
        }
        
        this.element.style.display = '';
        
        // Determine colors based on state
        let strokeColor = this._colorToCSS(this.color);
        let fillColor = this._colorToCSS(this.fillColor);
        
        if (this.selected) {
            strokeColor = '#e94560';
            fillColor = '#e94560';
        } else if (this.hovered) {
            strokeColor = '#ffeaa7';
            fillColor = '#ffeaa7';
        }
        
        // Update element
        this._updateElement(this.element, strokeColor, fillColor, scale);
        
        this._dirty = false;
        return this.element;
    }
    
    _createElement() {
        // Override in subclass
        return document.createElementNS('http://www.w3.org/2000/svg', 'g');
    }
    
    _updateElement(el, strokeColor, fillColor, scale) {
        // Override in subclass
    }
    
    move(dx, dy) {
        this.invalidate();
    }
    
    clone() {
        throw new Error('clone() must be implemented by subclass');
    }
    
    toJSON() {
        return {
            id: this.id,
            type: this.type,
            layer: this.layer,
            color: this.color,
            lineWidth: this.lineWidth,
            fill: this.fill,
            fillColor: this.fillColor,
            fillAlpha: this.fillAlpha,
            visible: this.visible,
            locked: this.locked
        };
    }
    
    destroy() {
        if (this.element && this.element.parentNode) {
            this.element.parentNode.removeChild(this.element);
        }
        this.element = null;
    }
}