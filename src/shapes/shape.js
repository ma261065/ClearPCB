/**
 * Shape - Base class for all PCB shapes (SVG version)
 * 
 * All coordinates are in world units (mm).
 * Each shape manages its own SVG element.
 */

import { ShapeValidator } from '../core/ShapeValidator.js';

let shapeIdCounter = 0;

// Minimum stroke width in screen pixels
const MIN_STROKE_PIXELS = 1;

// Anchor handle size in screen pixels
const ANCHOR_SIZE_PIXELS = 8;

/**
 * Update the ID counter to avoid collisions with loaded shapes
 * Call this after loading shapes from a file
 * @param {string} id - An existing shape ID to check against
 */
export function updateIdCounter(id) {
    if (typeof id === 'string') {
        const match = id.match(/^shape_(\d+)$/);
        if (match) {
            const num = parseInt(match[1], 10);
            if (num >= shapeIdCounter) {
                shapeIdCounter = num + 1;
            }
        }
    }
}

/**
 * Reset the ID counter (useful for testing)
 */
export function resetIdCounter() {
    shapeIdCounter = 0;
}

export class Shape {
    constructor(options = {}) {
        this.id = options.id || `shape_${++shapeIdCounter}`;
        this.type = 'shape';
        
        // Validate and apply common properties
        this.layer = ShapeValidator.validateLayer(options.layer || 'top');
        this.color = ShapeValidator.validateColor(options.color || '#00b894');
        this.lineWidth = ShapeValidator.validateLineWidth(options.lineWidth || 0.2);
        
        // Fill properties
        this.fill = options.fill !== undefined ? options.fill : false;
        this.fillColor = ShapeValidator.validateColor(options.fillColor || this.color);
        this.fillAlpha = ShapeValidator.validateNumber(options.fillAlpha || 0.3, {
            min: 0,
            max: 1,
            default: 0.3,
            name: 'fillAlpha'
        });
        
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
     * @param {string} anchorId - ID of the anchor to move
     * @param {number} x - New x position
     * @param {number} y - New y position
     * @returns {string|undefined} New anchor ID if the shape flipped, otherwise undefined
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

        // Draw lock icon near primary anchor when locked
        if (this.locked && anchors.length > 0) {
            const primary = anchors[0];
            const lockGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            const lockSize = 0.8; // world units so it scales with zoom
            const offset = 0.6;
            const strokeW = 0.15;
            const lockX = primary.x + offset;
            const lockY = primary.y - offset - lockSize * 0.6;

            const bodyW = lockSize;
            const bodyH = lockSize * 0.7;
            const bodyY = lockY + bodyH * 0.25;

            const body = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            body.setAttribute('x', lockX);
            body.setAttribute('y', bodyY);
            body.setAttribute('width', bodyW);
            body.setAttribute('height', bodyH);
            body.setAttribute('rx', lockSize * 0.12);
            body.setAttribute('fill', 'var(--lock-icon, #666666)');
            body.setAttribute('stroke', 'var(--lock-icon, #666666)');
            body.setAttribute('stroke-width', strokeW);
            lockGroup.appendChild(body);

            const shackleR = bodyW * 0.35;
            const shackleY = lockY + bodyH * 0.25;
            const shacklePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            const shackleCx = lockX + bodyW / 2;
            const shackleD = `M ${shackleCx - shackleR} ${shackleY} ` +
                `A ${shackleR} ${shackleR} 0 0 1 ${shackleCx + shackleR} ${shackleY}`;
            shacklePath.setAttribute('d', shackleD);
            shacklePath.setAttribute('fill', 'none');
            shacklePath.setAttribute('stroke', 'var(--lock-icon, #666666)');
            shacklePath.setAttribute('stroke-width', strokeW);
            lockGroup.appendChild(shacklePath);

            this.anchorsGroup.appendChild(lockGroup);
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