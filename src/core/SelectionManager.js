/**
 * SelectionManager - Manages shape selection state
 * 
 * Handles:
 * - Single selection
 * - Multi-selection (Ctrl+click, box select)
 * - Hit testing against shapes
 * - Selection change events
 */

/** @typedef {{minX:number, minY:number, maxX:number, maxY:number}} Bounds */
/** @typedef {import('./geometry.js').Point} Point */
/** @typedef {{id:string, visible?:boolean, type?:string, kind?:string, object?:any, fieldKey?:string, parentComponent?:Shape|string|null, attachedLabels?:Set<Shape>|null, labelText?:Shape|null, locked?:boolean, invalidate:() => void, getBounds:() => Bounds|null, getHitBounds?:() => Bounds|null, hitTest:(point:Point, tolerance?:number) => boolean, [key:string]: any}} Shape */
/**
 * @template {Shape} [T=Shape]
 * @typedef {{tolerance?:number, screenTolerancePx?:number, getScale?:() => number, isCulled?:(entity:T) => boolean, onSelectionChanged?:(selection:T[]) => void, invalidateEntity?:(entity:T) => void}} SelectionManagerOptions
 */

/**
 * @template {Shape} [T=Shape] The selectable items: each editor's own shape type.
 */
export class SelectionManager {
    /**
     * Create a new SelectionManager.
     * @param {SelectionManagerOptions<T>} [options]
     */
    constructor(options = {}) {
        /** @type {T[]} */
        this.shapes = [];  // Reference to all shapes (set by Document)
        /** @type {Map<string, T>} */
        this._shapeMap = new Map();  // ID → shape for O(1) lookups
        /** @type {Map<string, number>} */
        this._shapeIndex = new Map();  // ID → z-order index (position in shapes)
        /** @type {Set<string>} */
        this.selected = new Set();  // Set of selected shape IDs
        /**
         * Where the last selecting press landed; the schematic renders lock icons beside it.
         * @type {{x: number, y: number}|null}
         */
        this.lockPointer = null;
        /** @type {string|null} */
        this.hovered = null;  // Currently hovered shape ID
        /** @type {T[]|null} */
        this._selectionCache = null;  // Cached getSelection() result
        /** @type {Set<string>|null} */
        this._boxSelectBase = null;
        
        // Hit test tolerance in world units
        this.tolerance = options.tolerance || 0.5;
        // Minimum on-screen hit tolerance (px). At low zoom a fixed world-unit
        // tolerance shrinks to sub-pixel size, making thin shapes nearly
        // impossible to click; this floor keeps the target a usable size.
        this.screenTolerancePx = options.screenTolerancePx || 6;
        /** @type {(() => number)|null} */
        this.getScale = options.getScale || null;
        /** @type {((entity:T) => boolean)|null} */
        this._isCulled = options.isCulled || null;
        
        // Cache for hitTest results (point-based)
        /** @type {{lastPoint:string|null, lastResult:T|null, lastAllResults:T[]|null}} */
        this.hitTestCache = {
            lastPoint: null,
            lastResult: null,
            lastAllResults: null
        };
        
        // Callbacks
        /** @type {((selection:T[]) => void)|null} */
        this.onSelectionChanged = options.onSelectionChanged || null;
        /** @type {(entity:T) => void} */
        this._invalidateEntity = /** @type {(entity:T) => void} */ (options.invalidateEntity || (entity => entity.invalidate()));
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
    /** @param {T} shape @param {Point} point @param {number} tolerance */
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

    /** @param {T} shape */
    _canHit(shape) {
        return !!shape.visible && !(this._isCulled && this._isCulled(shape));
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
    /** @param {T[]} shapes */
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
     * @param {T|null|undefined} shape
     */
    _invalidateLinkedSelectionVisuals(shape) {
        if (!shape) return;
        if (shape.type === 'text' && shape.parentComponent) {
            const owner = shape.parentComponent;
            /** @type {T|null} */
            let parent = null;
            if (typeof owner === 'string') {
                parent = this._shapeMap.get(owner) || null;
            } else if (owner && typeof owner === 'object') {
                // A text's owner is one of this manager's items.
                const ownerItem = /** @type {T} */ (owner);
                parent = owner.id && typeof owner.invalidate !== 'function'
                    ? this._shapeMap.get(owner.id) || ownerItem
                    : ownerItem;
            }
            if (parent && typeof parent.invalidate === 'function') {
                this._invalidateEntity(parent);
            }
        }
        if (shape.attachedLabels instanceof Set) {
            for (const label of shape.attachedLabels) {
                if (label && typeof label.invalidate === 'function') {
                    this._invalidateEntity(/** @type {T} */ (label));
                }
            }
        }
        if (shape.labelText && typeof shape.labelText.invalidate === 'function') {
            this._invalidateEntity(/** @type {T} */ (shape.labelText));
        }
    }
    
    /**
     * @overload
     * @param {Point} point
     * @param {true} all
     * @returns {T[]}
     */
    /**
     * @overload
     * @param {Point} point
     * @param {false} [all]
     * @returns {T|null}
     */
    /**
     * Hit test at a point: every shape under it (topmost first) when `all`, else the
     * one a click would pick (a selected shape before the topmost).
     * @param {Point} point - {x, y} in world coordinates
     * @param {boolean} [all]
     * @returns {T|T[]|null}
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
                if (!this._canHit(shape)) continue;
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
            const index = /** @type {number} */ (this._shapeIndex.get(id));
            if (!shape || index <= selectedIndex || !this._canHit(shape)) continue;
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
            if (!this._canHit(shape)) continue;
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
     * @param {Bounds} bounds - {minX, minY, maxX, maxY}
     * @param {string} mode - 'contain' (fully inside) or 'intersect' (any overlap)
     * @returns {T[]}
     */
    hitTestRect(bounds, mode = 'intersect') {
        const hits = [];
        
        for (const shape of this.shapes) {
            if (!shape.visible) continue;
            
            const shapeBounds = shape.getBounds();
            if (!shapeBounds) continue;
            
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
     * @param {T|string} shape - Shape or shape ID
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
     * @param {T|string} shape - Shape or shape ID
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
     * @param {T|string} shape - Shape or shape ID
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
     * @param {T[]|string[]} shapes - Shapes or shape IDs
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
     * @returns {T[]}
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
     * @param {T|string} shape
     * @returns {boolean}
     */
    isSelected(shape) {
        const id = typeof shape === 'string' ? shape : shape.id;
        return this.selected.has(id);
    }
    
    /**
     * Check if a shape is the hovered one
     * @param {T|string|null|undefined} shape
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
     * @param {T|null} shape
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
     * @param {T|null|undefined} shape
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
     * @param {T|null|undefined} shape
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
     * @param {T|null|undefined} shape
     */
    dropHover(shape) {
        if (shape && this.hovered === shape.id) this.hovered = null;
    }

    /**
     * Drop a shape from both selection and hover state, without notifying.
     * @param {T|null|undefined} shape
     */
    forget(shape) {
        this.dropSelected(shape);
        this.dropHover(shape);
    }

    /** Discard cached hit results after shape geometry or membership changes. */
    invalidateHitCache() {
        this._invalidateHitTestCache();
    }

    /** Discard the cached selected-shape array after selection membership changes. */
    invalidateSelectionCache() {
        this._selectionCache = null;
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
            if (!b) continue;
            minX = Math.min(minX, b.minX);
            minY = Math.min(minY, b.minY);
            maxX = Math.max(maxX, b.maxX);
            maxY = Math.max(maxY, b.maxY);
        }
        
        return { minX, minY, maxX, maxY };
    }
    
    /**
     * Handle click at point
     * @param {Point} point - {x, y} in world coordinates
     * @param {boolean} additive - Shift key held?
     */
    handleClick(point, additive = false) {
        const hit = /** @type {T|null} */ (this.hitTest(point));
        
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
     * @param {Bounds} bounds - {minX, minY, maxX, maxY}
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
    /** @param {Bounds} bounds @param {boolean} [additive] @param {string} [mode] */
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
     * @returns {T|null}
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