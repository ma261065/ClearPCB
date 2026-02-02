/**
 * SelectionManager - Manages shape selection state
 * 
 * Handles:
 * - Single selection
 * - Multi-selection (shift+click, box select)
 * - Hit testing against shapes
 * - Selection change events
 */

import { Events, globalEventBus } from './EventBus.js';

export class SelectionManager {
    constructor(options = {}) {
        this.shapes = [];  // Reference to all shapes (set by Document)
        this.selected = new Set();  // Set of selected shape IDs
        this.hovered = null;  // Currently hovered shape ID
        
        // Hit test tolerance in world units
        this.tolerance = options.tolerance || 0.5;
        
        // Cache for hitTest results (point-based)
        this.hitTestCache = {
            lastPoint: null,
            lastResult: null,
            lastAllResults: null
        };
        
        // Callbacks
        this.onSelectionChanged = options.onSelectionChanged || null;
        
        this.eventBus = globalEventBus;
    }
    
    /**
     * Invalidate hitTest cache when shapes change
     */
    _invalidateHitTestCache() {
        this.hitTestCache.lastPoint = null;
        this.hitTestCache.lastResult = null;
        this.hitTestCache.lastAllResults = null;
    }
    
    /**
     * Set the shapes array to select from
     */
    setShapes(shapes) {
        this.shapes = shapes;
        this._invalidateHitTestCache();
    }
    
    /**
     * Hit test at a point, return shape(s) under cursor
     * @param {object} point - {x, y} in world coordinates
     * @param {boolean} all - If true, return all shapes at point; else just topmost
     * @returns {Shape|Shape[]|null}
     */
    hitTest(point, all = false) {
        // Check cache - if same point was tested recently, return cached result
        const cacheKey = `${point.x},${point.y}`;
        if (this.hitTestCache.lastPoint === cacheKey) {
            if (all) {
                if (this.hitTestCache.lastAllResults) return this.hitTestCache.lastAllResults;
            } else {
                if (this.hitTestCache.lastResult) return this.hitTestCache.lastResult;
                // Note: We cannot infer single result from 'lastAllResults' anymore because 
                // the single result logic now prioritizes selection, while 'all' is distinct z-order.
            }
        }
        
        // If we want ALL hits, we scan in strict Z-order (top to bottom)
        if (all) {
            const hits = [];
            for (let i = this.shapes.length - 1; i >= 0; i--) {
                const shape = this.shapes[i];
                if (!shape.visible) continue;
                if (shape.hitTest(point, this.tolerance)) {
                    hits.push(shape);
                }
            }
            // Cache all results
            this.hitTestCache.lastPoint = cacheKey;
            this.hitTestCache.lastAllResults = hits;
            return hits;
        }

        // If we want just the topmost hit (single selection/click), we prioritize Selected items first
        // effectively treating them as if they are visually on top (which they are).
        
        // Pass 1: Check selected items
        for (let i = this.shapes.length - 1; i >= 0; i--) {
            const shape = this.shapes[i];
            if (!shape.visible || !shape.selected) continue;
            
            if (shape.hitTest(point, this.tolerance)) {
                this.hitTestCache.lastPoint = cacheKey;
                this.hitTestCache.lastResult = shape;
                this.hitTestCache.lastAllResults = null; // Invalidate 'all' because we skipped unselected
                return shape;
            }
        }

        // Pass 2: Check unselected items
        for (let i = this.shapes.length - 1; i >= 0; i--) {
            const shape = this.shapes[i];
            if (!shape.visible || shape.selected) continue;
            
            if (shape.hitTest(point, this.tolerance)) {
               this.hitTestCache.lastPoint = cacheKey;
               this.hitTestCache.lastResult = shape;
               this.hitTestCache.lastAllResults = null;
               return shape;
            }
        }
        
        this.hitTestCache.lastPoint = cacheKey;
        this.hitTestCache.lastResult = null;
        return null;
    }
    
    /**
     * Find shapes within a rectangular region
     * @param {object} bounds - {minX, minY, maxX, maxY}
     * @param {string} mode - 'contain' (fully inside) or 'intersect' (any overlap)
     * @returns {Shape[]}
     */
    hitTestRect(bounds, mode = 'intersect') {
        const hits = [];
        
        for (const shape of this.shapes) {
            if (!shape.visible) continue;
            
            const shapeBounds = shape.getBounds();
            
            if (mode === 'contain') {
                // Shape must be fully inside bounds
                if (shapeBounds.minX >= bounds.minX &&
                    shapeBounds.minY >= bounds.minY &&
                    shapeBounds.maxX <= bounds.maxX &&
                    shapeBounds.maxY <= bounds.maxY) {
                    hits.push(shape);
                }
            } else {
                // Shape must intersect bounds
                if (shapeBounds.maxX >= bounds.minX &&
                    shapeBounds.minX <= bounds.maxX &&
                    shapeBounds.maxY >= bounds.minY &&
                    shapeBounds.minY <= bounds.maxY) {
                    hits.push(shape);
                }
            }
        }
        
        return hits;
    }
    
    /**
     * Select a shape
     * @param {Shape|string} shape - Shape or shape ID
     * @param {boolean} additive - If true, add to selection; else replace
     */
    select(shape, additive = false) {
        const id = typeof shape === 'string' ? shape : shape.id;
        const shapeObj = this._getShape(id);
        
        if (!shapeObj) return;
        
        if (!additive) {
            this._clearSelection();
        }
        
        if (!this.selected.has(id)) {
            this.selected.add(id);
            shapeObj.selected = true;
            shapeObj.invalidate();
        }
        
        this._notifySelectionChanged();
    }
    
    /**
     * Deselect a shape
     * @param {Shape|string} shape - Shape or shape ID
     */
    deselect(shape) {
        const id = typeof shape === 'string' ? shape : shape.id;
        const shapeObj = this._getShape(id);
        
        if (this.selected.has(id)) {
            this.selected.delete(id);
            if (shapeObj) {
                shapeObj.selected = false;
                shapeObj.invalidate();
            }
            this._notifySelectionChanged();
        }
    }
    
    /**
     * Toggle selection state
     * @param {Shape|string} shape - Shape or shape ID
     */
    toggle(shape) {
        const id = typeof shape === 'string' ? shape : shape.id;
        
        if (this.selected.has(id)) {
            this.deselect(id);
        } else {
            this.select(id, true);
        }
    }
    
    /**
     * Select multiple shapes
     * @param {Shape[]|string[]} shapes - Shapes or shape IDs
     * @param {boolean} additive - If true, add to selection; else replace
     */
    selectMultiple(shapes, additive = false) {
        if (!additive) {
            this._clearSelection();
        }
        
        for (const shape of shapes) {
            const id = typeof shape === 'string' ? shape : shape.id;
            const shapeObj = this._getShape(id);
            
            if (shapeObj && !this.selected.has(id)) {
                this.selected.add(id);
                shapeObj.selected = true;
                shapeObj.invalidate();
            }
        }
        
        this._notifySelectionChanged();
    }
    
    /**
     * Select all shapes
     */
    selectAll() {
        this.selectMultiple(this.shapes);
    }
    
    /**
     * Clear selection
     */
    clearSelection() {
        if (this.selected.size > 0) {
            this._clearSelection();
            this._notifySelectionChanged();
        }
    }
    
    /**
     * Internal clear without notification
     */
    _clearSelection() {
        for (const id of this.selected) {
            const shape = this._getShape(id);
            if (shape) {
                shape.selected = false;
                shape.invalidate();
            }
        }
        this.selected.clear();
    }
    
    /**
     * Get selected shapes
     * @returns {Shape[]}
     */
    getSelection() {
        return Array.from(this.selected)
            .map(id => this._getShape(id))
            .filter(s => s !== null);
    }
    
    /**
     * Check if a shape is selected
     * @param {Shape|string} shape
     * @returns {boolean}
     */
    isSelected(shape) {
        const id = typeof shape === 'string' ? shape : shape.id;
        return this.selected.has(id);
    }
    
    /**
     * Get selection count
     */
    get count() {
        return this.selected.size;
    }
    
    /**
     * Update hover state
     * @param {Shape|null} shape
     */
    setHovered(shape) {
        const newId = shape ? shape.id : null;
        
        if (this.hovered === newId) return false;  // No change
        
        // Clear old hover
        if (this.hovered) {
            const oldShape = this._getShape(this.hovered);
            if (oldShape) {
                oldShape.hovered = false;
                oldShape.invalidate();
            }
        }
        
        // Set new hover
        this.hovered = newId;
        if (shape) {
            shape.hovered = true;
            shape.invalidate();
        }
        
        return true;  // Changed
    }
    
    /**
     * Get combined bounds of selection
     * @returns {object|null} {minX, minY, maxX, maxY} or null if empty
     */
    getSelectionBounds() {
        const shapes = this.getSelection();
        if (shapes.length === 0) return null;
        
        let minX = Infinity, minY = Infinity;
        let maxX = -Infinity, maxY = -Infinity;
        
        for (const shape of shapes) {
            const b = shape.getBounds();
            minX = Math.min(minX, b.minX);
            minY = Math.min(minY, b.minY);
            maxX = Math.max(maxX, b.maxX);
            maxY = Math.max(maxY, b.maxY);
        }
        
        return { minX, minY, maxX, maxY };
    }
    
    /**
     * Handle click at point
     * @param {object} point - {x, y} in world coordinates
     * @param {boolean} additive - Shift key held?
     */
    handleClick(point, additive = false) {
        const hit = this.hitTest(point);
        
        if (hit) {
            if (additive) {
                this.toggle(hit);
            } else {
                this.select(hit, false);
            }
        } else if (!additive) {
            this.clearSelection();
        }
    }
    
    /**
     * Handle box selection
     * @param {object} bounds - {minX, minY, maxX, maxY}
     * @param {boolean} additive - Shift key held?
     * @param {string} mode - 'contain' (fully inside) or 'intersect' (any overlap)
     */
    handleBoxSelect(bounds, additive = false, mode = 'intersect') {
        const hits = this.hitTestRect(bounds, mode);
        
        if (hits.length > 0) {
            this.selectMultiple(hits, additive);
        } else if (!additive) {
            this.clearSelection();
        }
    }
    
    _getShape(id) {
        return this.shapes.find(s => s.id === id) || null;
    }
    
    _notifySelectionChanged() {
        const selection = this.getSelection();
        
        if (this.onSelectionChanged) {
            this.onSelectionChanged(selection);
        }
        
        this.eventBus.emit(Events.SELECTION_CHANGED, {
            selection,
            count: selection.length,
            bounds: this.getSelectionBounds()
        });
    }
}