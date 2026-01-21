/**
 * Shape - Base class for all PCB shapes
 * 
 * All coordinates are in world units (mm).
 * Each shape manages its own PIXI.Graphics object.
 */

let shapeIdCounter = 0;

export class Shape {
    constructor(options = {}) {
        this.id = options.id || `shape_${++shapeIdCounter}`;
        this.type = 'shape';
        
        // Layer (for PCB: top, bottom, silkscreen, etc.)
        this.layer = options.layer || 'top';
        
        // Visual properties
        this.color = options.color || 0x00b894;
        this.lineWidth = options.lineWidth || 0.2; // mm
        this.fill = options.fill !== undefined ? options.fill : false;
        this.fillColor = options.fillColor || this.color;
        this.fillAlpha = options.fillAlpha || 0.3;
        
        // State
        this.selected = false;
        this.hovered = false;
        this.visible = true;
        this.locked = false;
        
        // PIXI graphics object (created on first render)
        this.graphics = null;
        
        // Cached bounds (invalidated on change)
        this._bounds = null;
        this._dirty = true;
    }
    
    /**
     * Get axis-aligned bounding box in world coordinates
     * @returns {{minX: number, minY: number, maxX: number, maxY: number}}
     */
    getBounds() {
        if (!this._bounds || this._dirty) {
            this._bounds = this._calculateBounds();
        }
        return this._bounds;
    }
    
    /**
     * Override in subclass to calculate bounds
     */
    _calculateBounds() {
        return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    }
    
    /**
     * Hit test - check if point is on/in this shape
     * @param {object} point - {x, y} in world coordinates
     * @param {number} tolerance - hit tolerance in world units
     * @returns {boolean}
     */
    hitTest(point, tolerance = 0.5) {
        return false; // Override in subclass
    }
    
    /**
     * Get distance from point to shape (for selection priority)
     * @param {object} point - {x, y} in world coordinates
     * @returns {number} distance in world units
     */
    distanceTo(point) {
        return Infinity; // Override in subclass
    }
    
    /**
     * Mark shape as needing redraw
     */
    invalidate() {
        this._dirty = true;
        this._bounds = null;
    }
    
    /**
     * Create or update PIXI graphics
     * @param {number} scale - current viewport scale (pixels per mm)
     */
    render(scale) {
        if (!this.graphics) {
            this.graphics = new PIXI.Graphics();
        }
        
        if (!this.visible) {
            this.graphics.visible = false;
            return this.graphics;
        }
        
        this.graphics.visible = true;
        this.graphics.clear();
        
        // Determine colors based on state
        let strokeColor = this.color;
        let fillColor = this.fillColor;
        
        if (this.selected) {
            strokeColor = 0xe94560; // Selection color
            fillColor = 0xe94560;
        } else if (this.hovered) {
            strokeColor = 0xffeaa7; // Hover color
            fillColor = 0xffeaa7;
        }
        
        // Line width in world units (will be scaled by container)
        const lineWidth = this.lineWidth;
        
        // Setup styles
        if (this.fill) {
            this.graphics.beginFill(fillColor, this.fillAlpha);
        }
        this.graphics.lineStyle(lineWidth, strokeColor, 1);
        
        // Draw the shape (implemented by subclass)
        this._draw(this.graphics, scale);
        
        if (this.fill) {
            this.graphics.endFill();
        }
        
        // Draw selection handles if selected
        if (this.selected) {
            this._drawHandles(this.graphics, scale);
        }
        
        this._dirty = false;
        return this.graphics;
    }
    
    /**
     * Override in subclass to draw the shape
     */
    _draw(g, scale) {
        // Subclass implements
    }
    
    /**
     * Draw selection handles
     */
    _drawHandles(g, scale) {
        const handleSize = 3 / scale; // Constant screen size
        const bounds = this.getBounds();
        
        g.lineStyle(1 / scale, 0xe94560, 1);
        g.beginFill(0xffffff, 1);
        
        // Corner handles
        const corners = [
            { x: bounds.minX, y: bounds.minY },
            { x: bounds.maxX, y: bounds.minY },
            { x: bounds.maxX, y: bounds.maxY },
            { x: bounds.minX, y: bounds.maxY }
        ];
        
        corners.forEach(c => {
            g.drawRect(c.x - handleSize/2, c.y - handleSize/2, handleSize, handleSize);
        });
        
        g.endFill();
    }
    
    /**
     * Clone this shape
     */
    clone() {
        throw new Error('clone() must be implemented by subclass');
    }
    
    /**
     * Serialize to plain object
     */
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
    
    /**
     * Move shape by delta
     */
    move(dx, dy) {
        // Override in subclass
        this.invalidate();
    }
    
    /**
     * Cleanup PIXI resources
     */
    destroy() {
        if (this.graphics) {
            this.graphics.destroy();
            this.graphics = null;
        }
    }
}