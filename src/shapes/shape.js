/**
 * Shape - Base class for all PCB shapes (SVG version)
 * 
 * All coordinates are in world units (mm).
 * Each shape manages its own SVG element.
 */

import { ShapeValidator } from '../core/ShapeValidator.js';
import { createLockIcon, LOCK_SIZE } from '../core/ui-helpers.js';

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
        
        // State
        this.selected = false;
        this.hovered = false;
        this.visible = options.visible !== undefined ? options.visible : true;
        this.locked = options.locked !== undefined ? options.locked : false;
        
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
            // Store reference to shape on the element for easy lookup
            this.element.__shape = this;
        }
        
        if (!this.visible) {
            this.element.style.display = 'none';
            return this.element;
        }
        
        this.element.style.display = '';
        
        // Determine colors based on state
        let strokeColor = this._colorToCSS(this.color);
        let fillColor = this._colorToCSS(this.fillColor ?? this.color);
        
        if (this.selected) {
            strokeColor = '#e94560';
            fillColor = '#e94560';
            
            // Raise element to top of its container to ensure visibility
            // (Only if it's not already the last child)
            if (this.element.parentNode && this.element.nextSibling) {
                this.element.parentNode.appendChild(this.element);
            }
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
        // Only show anchors when selected
        if (!this.selected) {
            if (this.anchorsGroup) {
                this.anchorsGroup.remove();
                this.anchorsGroup = null;
                this._anchorRects = null;
            }
            return;
        }
        
        const anchors = this.getAnchors();
        const visibleAnchors = anchors.filter(anchor => !anchor.hidden);
        if (visibleAnchors.length === 0 && !this.locked) {
            if (this.anchorsGroup) {
                this.anchorsGroup.remove();
                this.anchorsGroup = null;
                this._anchorRects = null;
            }
            return;
        }
        
        const size = ANCHOR_SIZE_PIXELS / scale;
        const strokeW = 1 / scale;
        
        // Reuse existing anchor rects if count matches (fast path for drag)
        // Skip fast path if lock icon was previously rendered (stale after unlock)
        if (this.anchorsGroup && this._anchorRects && this._anchorRects.length === visibleAnchors.length
            && !this.locked && !this._anchorsHaveLock) {
            for (let i = 0; i < visibleAnchors.length; i++) {
                const anchor = visibleAnchors[i];
                const rect = this._anchorRects[i];
                rect.setAttribute('x', anchor.x - size / 2);
                rect.setAttribute('y', anchor.y - size / 2);
                rect.setAttribute('width', size);
                rect.setAttribute('height', size);
                rect.setAttribute('stroke-width', strokeW);
            }
            // Re-position anchors group right after element so it renders on top
            if (this.element.parentNode && this.anchorsGroup.previousSibling !== this.element) {
                this.element.parentNode.insertBefore(this.anchorsGroup, this.element.nextSibling);
            }
            return;
        }
        
        // Full rebuild needed
        if (this.anchorsGroup) {
            this.anchorsGroup.remove();
        }
        
        // Create anchors group
        this.anchorsGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        this.anchorsGroup.setAttribute('class', 'shape-anchors');
        this._anchorRects = [];
        this._anchorsHaveLock = false;
        
        for (const anchor of visibleAnchors) {
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
            this._anchorRects.push(rect);
        }

        // Draw lock icon near primary anchor when locked
        if (this.locked && anchors.length > 0) {
            const primary = anchors[0];
            const offset = 0.6;
            let lockX = primary.x + offset;
            let lockY = primary.y - offset - LOCK_SIZE * 0.6;

            if (this.type === 'text') {
                const bounds = this.getBounds();
                lockX = bounds.maxX + offset;
                lockY = bounds.minY - offset - LOCK_SIZE * 0.6;
            }

            this.anchorsGroup.appendChild(createLockIcon(lockX, lockY, this, 'lock-icon'));
            this._anchorsHaveLock = true;
        }
        
        // Add anchors group to same parent as element, always after it
        // so anchors render on top of the shape (important for thick lines)
        if (this.element.parentNode) {
            // insertBefore(node, ref) with ref=nextSibling places it right after element;
            // if nextSibling is null, it appends at the end — both correct.
            this.element.parentNode.insertBefore(this.anchorsGroup, this.element.nextSibling);
        }
    }
    
    move(dx, dy) {
        this.invalidate();
    }
    
    /**
     * Capture the mutable geometric state for undo/redo.
     * Override in subclasses to return a plain object snapshot.
     */
    captureState() {
        return {};
    }
    
    /**
     * Restore a previously captured state.
     * Override in subclasses if custom deep-copy logic is needed.
     */
    applyState(state) {
        for (const [key, value] of Object.entries(state)) {
            this[key] = value;
        }
        this.invalidate();
    }
    
    /**
     * Get a reference position for drag offset calculation.
     * Override in subclasses with non-standard coordinate layouts.
     */
    getPosition() {
        if (typeof this.x === 'number' && typeof this.y === 'number') {
            return { x: this.x, y: this.y };
        }
        return { x: 0, y: 0 };
    }
    
    /**
     * Get the snap mode for a given anchor during drag.
     * Returns 'grid' (default), 'none', or 'axis'.
     */
    getAnchorSnapMode(anchorId) {
        return 'grid';
    }
    
    /**
     * Clean up transient drag state after an anchor drag completes.
     */
    resetDragState() {
        // Override in subclasses that use transient drag properties
    }
    
    /**
     * Property descriptors for the properties panel.
     * Override in subclasses to customise which properties are shown.
     */
    getPropertyDescriptors() {
        return [
            { key: 'locked',    label: 'Locked',     type: 'checkbox' },
            { key: 'lineWidth', label: 'Line width',  type: 'number', min: 0.05, max: 5, step: 0.05 },
        ];
    }

    /**
     * Whether this shape supports inline (double-click) text editing.
     */
    get supportsInlineEdit() {
        return false;
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