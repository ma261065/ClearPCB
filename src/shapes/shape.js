/**
 * Shape - Base class for schematic and PCB shape models
 * 
 * All coordinates are in world units (mm).
 */

import { ShapeValidator } from '../core/ShapeValidator.js';
import { IdAllocator } from '../core/id-allocator.js';

const shapeIds = new IdAllocator('shape');

// Anchor handle size in screen pixels
const ANCHOR_SIZE_PIXELS = 8;

/**
 * Update the ID counter to avoid collisions with loaded shapes
 * Call this after loading shapes from a file
 * @param {string} id - An existing shape ID to check against
 */
export function updateIdCounter(id) {
    shapeIds.observe(id);
}

/**
 * Reset the ID counter (useful for testing)
 */
export function resetIdCounter() {
    shapeIds.reset();
}

export class Shape {
    /**
     * Create a new shape.
     * @param {Object} [options] - Shape configuration.
     * @param {string} [options.id] - Unique ID (auto-generated if omitted).
     * @param {string} [options.layer='top'] - Board layer ('top', 'bottom', etc.).
     * @param {string|number} [options.color='#00b894'] - Stroke/fill colour.
    * @param {string|number|null} [options.fillColor] - Optional fill colour override.
     * @param {number} [options.lineWidth=0.2] - Stroke width in mm.
     * @param {boolean} [options.visible=true] - Whether the shape is rendered.
     * @param {boolean} [options.locked=false] - Whether the shape is locked.
     */
    constructor(options = {}) {
        this.id = shapeIds.claim(options.id);
        this.type = 'shape';
        
        // Validate and apply common properties
        this.layer = ShapeValidator.validateLayer(options.layer || 'top');
        this.color = ShapeValidator.validateColor(options.color || '#00b894');
        this.fillColor = options.fillColor ?? 'var(--sch-shape-fill, #777777)';
        this.lineWidth = ShapeValidator.validateLineWidth(options.lineWidth || 0.2);
        
        // State
        this.visible = options.visible !== undefined ? options.visible : true;
        this.locked = options.locked !== undefined ? options.locked : false;
        
        // Cached bounds
        this._bounds = null;
        this._dirty = true;
    }
    
    
    /**
     * Get the axis-aligned bounding box, cached until geometry is invalidated.
     * @returns {{minX: number, minY: number, maxX: number, maxY: number}}
     */
    getBounds() {
        if (!this._bounds) {
            this._bounds = this._calculateBounds();
        }
        return this._bounds;
    }
    
    /**
     * Compute the axis-aligned bounding box. Override in subclasses.
     * @returns {{minX: number, minY: number, maxX: number, maxY: number}}
     */
    _calculateBounds() {
        return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    }
    
    /**
     * Test whether a point intersects this shape. Override in subclasses.
     * @param {{x: number, y: number}} point - World-space point to test.
     * @param {number} [tolerance=0.5] - Hit margin in mm.
     * @returns {boolean} True if the point hits the shape.
     */
    hitTest(point, tolerance = 0.5) {
        return false;
    }
    
    /**
     * Minimum distance from a world point to this shape. Override in subclasses.
     * @param {{x: number, y: number}} point - World-space point.
     * @returns {number} Distance in mm (Infinity by default).
     */
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
        return undefined;
    }
    
    /**
     * Mark the shape as dirty, clearing the cached bounding box.
     * Call after any geometric mutation so the next render recalculates.
     */
    invalidate() {
        this._dirty = true;
        this._bounds = null;
    }
    
    /**
     * Translate the shape by the given delta. Override in subclasses.
     * @param {number} dx - Horizontal offset in mm.
     * @param {number} dy - Vertical offset in mm.
     */
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
        const positioned = /** @type {{x?: number, y?: number}} */ (this);
        if (typeof positioned.x === 'number' && typeof positioned.y === 'number') {
            return { x: positioned.x, y: positioned.y };
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
     * @returns {Array<{key: string, label: string, type: string, min?: number, max?: number, step?: number, [extra: string]: any}>}
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
    
    /**
     * Create a deep copy of this shape with a new unique ID.
     * Must be implemented by every concrete subclass.
     * @returns {Shape} A new independent shape instance.
     */
    clone() {
        throw new Error('clone() must be implemented by subclass');
    }
    
    /**
     * Serialise the shape to a compact JSON-friendly object.
     * Subclasses should call `super.toJSON()` and extend the result.
     * @returns {Object} Plain object with short keys (`c`, `l`, `lw`, etc.).
     */
    toJSON() {
        const json = {
            id: this.id,
            type: this.type,
            c: this.color,
        };
        if (this.layer !== 'top') json.l = this.layer;
        if (this.lineWidth !== 0.2) json.lw = this.lineWidth;
        if (!this.visible) json.v = false;
        if (this.locked) json.lk = true;
        return json;
    }
}
