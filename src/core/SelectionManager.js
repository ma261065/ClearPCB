/**
 * SelectionManager - Manages shape selection state
 * 
 * Handles:
 * - Single selection
 * - Multi-selection (Ctrl+click, box select)
 * - Hit testing against shapes
 * - Selection change events
 */

/** @typedef {any} Shape */

export class SelectionManager {
    /**
     * Create a new SelectionManager.
     * @param {Object} [options]
     * @param {number} [options.tolerance=0.5] - Hit-test tolerance in world units
     * @param {number} [options.screenTolerancePx=6] - Minimum hit tolerance in screen pixels (kept constant on screen across zoom)
     * @param {Function} [options.getScale] - Returns current viewport scale (px per world unit) so tolerance stays usable when zoomed out
     * @param {Function} [options.onSelectionChanged] - Callback fired when selection changes
     * @param {(entity: Shape) => void} [options.invalidateEntity] - Refreshes an entity whose
     *   selection, hover or ownership tint changed (defaults to `entity.invalidate()`)
     */
    constructor(options = {}) {
        this.shapes = [];  // Reference to all shapes (set by Document)
        this._shapeMap = new Map();  // ID → shape for O(1) lookups
        this._shapeIndex = new Map();  // ID → z-order index (position in shapes)
        this.selected = new Set();  // Set of selected shape IDs
        this.hovered = null;  // Currently hovered shape ID
        this._selectionCache = null;  // Cached getSelection() result
        
        // Hit test tolerance in world units
        this.tolerance = options.tolerance || 0.5;
        // Minimum on-screen hit tolerance (px). At low zoom a fixed world-unit
        // tolerance shrinks to sub-pixel size, making thin shapes nearly
        // impossible to click; this floor keeps the target a usable size.
        this.screenTolerancePx = options.screenTolerancePx || 6;
        this.getScale = options.getScale || null;
        
        // Cache for hitTest results (point-based)
        this.hitTestCache = {
            lastPoint: null,
            lastResult: null,
            lastAllResults: null
        };
        
        // Callbacks
        this.onSelectionChanged = options.onSelectionChanged || null;
        this._invalidateEntity = options.invalidateEntity || (entity => entity.invalidate());
    }
    
    /**
     * Effective hit tolerance in world units: the larger of the configured
     * world tolerance and the screen-pixel floor converted to world units.
     * @returns {number}
     */
    _effectiveTolerance() {
        const scale = this.getScale ? this.getScale() : 0;
        if (scale && scale > 0) {
            return Math.max(this.tolerance, this.screenTolerancePx / scale);
        }
        return this.tolerance;
    }

    /**
     * Cheaply reject shapes whose cached bounds cannot contain the hit point.
     * Shapes without usable bounds fall through to their authoritative test.
     */
    _boundsMayHit(shape, point, tolerance) {
        // Adapters whose hitTest reaches beyond their visual bounds supply wider hit bounds.
        const bounds = typeof shape.getHitBounds === 'function' ? shape.getHitBounds()
            : typeof shape.getBounds === 'function' ? shape.getBounds() : null;
        if (!bounds) return true;
        const { minX, minY, maxX, maxY } = bounds;
        if (![minX, minY, maxX, maxY].every(Number.isFinite)) return true;
        return point.x >= minX - tolerance && point.x <= maxX + tolerance
            && point.y >= minY - tolerance && point.y <= maxY + tolerance;
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
        this._shapeMap = new Map();
        this._shapeIndex = new Map();
        for (let index = 0; index < shapes.length; index++) {
            this._shapeMap.set(shapes[index].id, shapes[index]);
            this._shapeIndex.set(shapes[index].id, index);
        }
        this._selectionCache = null;
        this._invalidateHitTestCache();
    }

    /**
     * Invalidate linked selection visuals for parent/child shape pairs.
     * Keeps ownership tint in sync for component fields, wire labels,
     * and Net text.
     * @param {Shape|null|undefined} shape
     */
    _invalidateLinkedSelectionVisuals(shape) {
        if (!shape) return;
        if (shape.type === 'text' && shape.parentComponent) {
            let parent = shape.parentComponent;
            if (typeof parent === 'string') {
                parent = this._shapeMap.get(parent) || null;
            } else if (parent && typeof parent === 'object' && parent.id && typeof parent.invalidate !== 'function') {
                parent = this._shapeMap.get(parent.id) || parent;
            }
            if (parent && typeof parent.invalidate === 'function') {
                this._invalidateEntity(parent);
            }
        }
        if (shape.attachedLabels instanceof Set) {
            for (const label of shape.attachedLabels) {
                if (label && typeof label.invalidate === 'function') {
                    this._invalidateEntity(label);
                }
            }
        }
        if (shape.labelText && typeof shape.labelText.invalidate === 'function') {
            this._invalidateEntity(shape.labelText);
        }
    }
    
    /**
     * Hit test at a point, return shape(s) under cursor
     * @param {object} point - {x, y} in world coordinates
     * @param {boolean} all - If true, return all shapes at point; else just topmost
     * @returns {Shape|Shape[]|null}
     */
    hitTest(point, all = false) {
        const tol = this._effectiveTolerance();
        // Check cache - if same point + tolerance was tested recently, reuse
        const cacheKey = `${point.x},${point.y},${tol}`;
        if (this.hitTestCache.lastPoint === cacheKey) {
            if (all) {
                if (this.hitTestCache.lastAllResults) return this.hitTestCache.lastAllResults;
            } else {
                if (this.hitTestCache.lastResult) return this.hitTestCache.lastResult;
                if (this.hitTestCache.lastAllResults) {
                    const result = this.hitTestCache.lastAllResults.find(shape => this.selected.has(shape.id))
                        || this.hitTestCache.lastAllResults[0]
                        || null;
                    this.hitTestCache.lastResult = result;
                    return result;
                }
            }
        }
        
        // If we want ALL hits, we scan in strict Z-order (top to bottom)
        if (all) {
            const hits = [];
            for (let i = this.shapes.length - 1; i >= 0; i--) {
                const shape = this.shapes[i];
                if (!shape.visible || shape._culled) continue;
                if (!this._boundsMayHit(shape, point, tol)) continue;
                if (shape.hitTest(point, tol)) {
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
        
        // Pass 1: the topmost selected item under the point. Only selected entries
        // are visited, so the cost scales with the selection, not the document.
        let selectedHit = null;
        let selectedIndex = -1;
        for (const id of this.selected) {
            const shape = this._shapeMap.get(id);
            const index = this._shapeIndex.get(id);
            if (!shape || index <= selectedIndex || !shape.visible || shape._culled) continue;
            if (!this._boundsMayHit(shape, point, tol)) continue;
            if (shape.hitTest(point, tol)) {
                selectedHit = shape;
                selectedIndex = index;
            }
        }
        if (selectedHit) {
            this.hitTestCache.lastPoint = cacheKey;
            this.hitTestCache.lastResult = selectedHit;
            this.hitTestCache.lastAllResults = null; // Invalidate 'all' because we skipped unselected
            return selectedHit;
        }

        // Pass 2: the topmost item. No selected item is under the point (pass 1),
        // so they need not be skipped.
        for (let i = this.shapes.length - 1; i >= 0; i--) {
            const shape = this.shapes[i];
            if (!shape.visible || shape._culled) continue;
            if (!this._boundsMayHit(shape, point, tol)) continue;
            
            if (shape.hitTest(point, tol)) {
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
            this._selectionCache = null;
            this._invalidateEntity(shapeObj);
            this._invalidateHitTestCache();
        }

        this._invalidateLinkedSelectionVisuals(shapeObj);
        
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
            this._selectionCache = null;
            this._invalidateHitTestCache();
            if (shapeObj) {
                this._invalidateEntity(shapeObj);
                this._invalidateLinkedSelectionVisuals(shapeObj);
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
                this._selectionCache = null;
                this._invalidateEntity(shapeObj);
                this._invalidateLinkedSelectionVisuals(shapeObj);
            }
        }
        this._invalidateHitTestCache();
        
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
     * @param {{notify?: boolean}} [options] - `notify: false` clears without
     *   firing onSelectionChanged, for callers that notify once after a batch.
     */
    clearSelection({ notify = true } = {}) {
        if (!notify) {
            this._clearSelection();
            return;
        }
        if (this.selected.size > 0) {
            this._clearSelection();
            this._notifySelectionChanged();
        }
    }
    
    /**
     * Internal clear without notification
     */
    _clearSelection() {
        const selectedIds = [...this.selected];
        this.selected.clear();
        this._selectionCache = null;
        this._invalidateHitTestCache();
        for (const id of selectedIds) {
            const shape = this._getShape(id);
            if (shape) {
                this._invalidateEntity(shape);
                this._invalidateLinkedSelectionVisuals(shape);
            }
        }
    }
    
    /**
     * Get selected shapes
     * @returns {Shape[]}
     */
    getSelection() {
        if (this._selectionCache) return this._selectionCache;
        const result = Array.from(this.selected)
            .map(id => this._getShape(id))
            .filter(s => s !== null);
        this._selectionCache = result;
        return result;
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
     * Check if a shape is the hovered one
     * @param {Shape|string|null|undefined} shape
     * @returns {boolean}
     */
    isHovered(shape) {
        const id = typeof shape === 'string' ? shape : shape?.id;
        return id != null && this.hovered === id;
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
        
        // Switch hover first so refresh hooks that redraw immediately see it.
        const oldShape = this.hovered ? this._getShape(this.hovered) : null;
        this.hovered = newId;
        if (oldShape) this._invalidateEntity(oldShape);
        if (shape) this._invalidateEntity(shape);
        
        return true;  // Changed
    }

    /**
     * Keep a tracked shape selected after an edit, without notifying listeners.
     * Untracked shapes are ignored so the selection never names a shape it cannot find.
     * @param {Shape|null|undefined} shape
     */
    keepSelected(shape) {
        if (!shape || this._shapeMap.get(shape.id) !== shape || this.selected.has(shape.id)) return;
        this.selected.add(shape.id);
        this._selectionCache = null;
        this._invalidateHitTestCache();
        this._invalidateEntity(shape);
        this._invalidateLinkedSelectionVisuals(shape);
    }

    /**
     * Drop a shape that is leaving the document from the selection, without notifying.
     * @param {Shape|null|undefined} shape
     */
    dropSelected(shape) {
        if (!shape) return;
        if (this.selected.delete(shape.id)) {
            this._selectionCache = null;
            this._invalidateHitTestCache();
        }
    }

    /**
     * Drop a shape that is leaving or re-entering the document from hover state.
     * @param {Shape|null|undefined} shape
     */
    dropHover(shape) {
        if (shape && this.hovered === shape.id) this.hovered = null;
    }

    /**
     * Drop a shape from both selection and hover state, without notifying.
     * @param {Shape|null|undefined} shape
     */
    forget(shape) {
        this.dropSelected(shape);
        this.dropHover(shape);
    }

    /** Discard cached hit results after shape geometry or membership changes. */
    invalidateHitCache() {
        this._invalidateHitTestCache();
    }

    /** Tell listeners about a selection change made without notification. */
    notifyChanged() {
        this._notifySelectionChanged();
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

    /**
     * Diff-based box selection for live drag preview.
     * Only invalidates shapes whose selected state actually changed,
     * avoiding O(N) re-renders on every mousemove.
     * Does NOT fire selectionChanged notifications (caller handles that).
     */
    syncBoxSelection(bounds, additive = false, mode = 'contain') {
        const hits = this.hitTestRect(bounds, mode);
        const newSet = new Set(hits.map(h => h.id));
        if (additive) {
            // Merge with base selection captured at drag start
            if (this._boxSelectBase) {
                for (const id of this._boxSelectBase) newSet.add(id);
            }
        }
        // Refresh only shapes whose state changed, after the new set is in place
        // so refresh hooks that redraw immediately see the final selection.
        const previous = this.selected;
        this.selected = newSet;
        this._selectionCache = null;
        this._invalidateHitTestCache();
        for (const id of previous) {
            if (!newSet.has(id)) {
                const shape = this._getShape(id);
                if (shape) this._invalidateEntity(shape);
            }
        }
        for (const id of newSet) {
            if (!previous.has(id)) {
                const shape = this._getShape(id);
                if (shape) this._invalidateEntity(shape);
            }
        }
    }

    /** Capture current selection as additive base for box drag. */
    captureBoxSelectBase() {
        this._boxSelectBase = new Set(this.selected);
    }
    
    /**
     * Look up a shape by ID from the internal map.
     * @param {string} id - Shape identifier
     * @returns {Shape|null}
     */
    _getShape(id) {
        return this._shapeMap.get(id) || null;
    }
    
    /**
     * Fire the onSelectionChanged callback with the current selection.
     */
    _notifySelectionChanged() {
        const selection = this.getSelection();
        
        if (this.onSelectionChanged) {
            this.onSelectionChanged(selection);
        }
    }
}