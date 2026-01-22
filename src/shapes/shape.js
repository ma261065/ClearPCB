/**
 * Shape - Base class for all PCB shapes (SVG version)
 * 
 * All coordinates are in world units (mm).
 * Each shape manages its own SVG element.
 */

let shapeIdCounter = 0;

// Minimum stroke width in screen pixels
const MIN_STROKE_PIXELS = 1;

// Anchor handle size in screen pixels
const ANCHOR_SIZE_PIXELS = 8;

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
        
        // SVG elements
        this.element = null;
        this.anchorsGroup = null;
        
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
    
    // Calculate effective stroke width with minimum screen pixel size
    _getEffectiveStrokeWidth(scale) {
        const minWorldWidth = MIN_STROKE_PIXELS / scale;
        return Math.max(this.lineWidth, minWorldWidth);
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
    
    /**
     * Get anchor points for this shape
     * Returns array of { id, x, y, cursor } objects
     */
    getAnchors() {
        return [];
    }
    
    /**
     * Test if point hits an anchor, returns anchor id or null
     */
    hitTestAnchor(point, scale) {
        const anchors = this.getAnchors();
        const tolerance = ANCHOR_SIZE_PIXELS / scale;
        
        for (const anchor of anchors) {
            const dist = Math.hypot(point.x - anchor.x, point.y - anchor.y);
            if (dist <= tolerance) {
                return anchor.id;
            }
        }
        return null;
    }
    
    /**
     * Move an anchor point to a new position
     */
    moveAnchor(anchorId, x, y) {
        // Override in subclass
        this.invalidate();
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
        
        // Update anchor handles
        this._updateAnchors(scale);
        
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
    
    _updateAnchors(scale) {
        // Remove existing anchors
        if (this.anchorsGroup) {
            this.anchorsGroup.remove();
            this.anchorsGroup = null;
        }
        
        // Only show anchors when selected
        if (!this.selected) return;
        
        const anchors = this.getAnchors();
        if (anchors.length === 0) return;
        
        // Create anchors group
        this.anchorsGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        this.anchorsGroup.setAttribute('class', 'shape-anchors');
        
        const size = ANCHOR_SIZE_PIXELS / scale;
        
        for (const anchor of anchors) {
            const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            rect.setAttribute('x', anchor.x - size / 2);
            rect.setAttribute('y', anchor.y - size / 2);
            rect.setAttribute('width', size);
            rect.setAttribute('height', size);
            rect.setAttribute('fill', '#fff');
            rect.setAttribute('stroke', '#e94560');
            rect.setAttribute('stroke-width', 1 / scale);
            rect.setAttribute('data-anchor-id', anchor.id);
            this.anchorsGroup.appendChild(rect);
        }
        
        // Add anchors group to same parent as element
        if (this.element.parentNode) {
            this.element.parentNode.appendChild(this.anchorsGroup);
        }
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
        if (this.anchorsGroup && this.anchorsGroup.parentNode) {
            this.anchorsGroup.parentNode.removeChild(this.anchorsGroup);
        }
        this.element = null;
        this.anchorsGroup = null;
    }
}