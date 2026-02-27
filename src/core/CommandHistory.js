/**
 * CommandHistory - Manages undo/redo stack
 * 
 * Uses the Command pattern to track reversible operations.
 */

export class CommandHistory {
    constructor(options = {}) {
        this.undoStack = [];
        this.redoStack = [];
        this.maxSize = options.maxSize || 100;
        
        // Callbacks
        this.onChanged = options.onChanged || null;
    }
    
    /**
     * Execute a command and add it to the undo stack
     * @param {Command} command - Command to execute
     */
    execute(command) {
        command.execute();
        this.undoStack.push(command);
        
        // Clear redo stack when new command is executed
        this.redoStack = [];
        
        // Limit stack size
        if (this.undoStack.length > this.maxSize) {
            this.undoStack.shift();
        }
        
        this._notifyChanged();
    }
    
    /**
     * Undo the last command
     * @returns {boolean} True if undo was performed
     */
    undo() {
        if (this.undoStack.length === 0) return false;
        
        const command = this.undoStack.pop();
        command.undo();
        this.redoStack.push(command);
        
        this._notifyChanged();
        return true;
    }
    
    /**
     * Redo the last undone command
     * @returns {boolean} True if redo was performed
     */
    redo() {
        if (this.redoStack.length === 0) return false;
        
        const command = this.redoStack.pop();
        command.execute();
        this.undoStack.push(command);
        
        this._notifyChanged();
        return true;
    }
    
    /**
     * Check if undo is available
     */
    canUndo() {
        return this.undoStack.length > 0;
    }
    
    /**
     * Check if redo is available
     */
    canRedo() {
        return this.redoStack.length > 0;
    }
    
    /**
     * Clear all history
     */
    clear() {
        this.undoStack = [];
        this.redoStack = [];
        this._notifyChanged();
    }
    
    /**
     * Get description of next undo action
     */
    getUndoDescription() {
        if (this.undoStack.length === 0) return null;
        return this.undoStack[this.undoStack.length - 1].description;
    }
    
    /**
     * Get description of next redo action
     */
    getRedoDescription() {
        if (this.redoStack.length === 0) return null;
        return this.redoStack[this.redoStack.length - 1].description;
    }
    
    _notifyChanged() {
        if (this.onChanged) {
            this.onChanged({
                canUndo: this.canUndo(),
                canRedo: this.canRedo(),
                undoDescription: this.getUndoDescription(),
                redoDescription: this.getRedoDescription()
            });
        }
    }
}

/**
 * Base Command class
 */
export class Command {
    constructor(description = 'Unknown action') {
        this.description = description;
    }
    
    execute() {
        throw new Error('execute() must be implemented');
    }
    
    undo() {
        throw new Error('undo() must be implemented');
    }
}

/**
 * Command to add a shape
 */
export class AddShapeCommand extends Command {
    constructor(app, shape) {
        super(`Add ${shape.type}`);
        this.app = app;
        this.shape = shape;
    }
    
    execute() {
        this.app._addShapeInternal(this.shape);
    }
    
    undo() {
        this.app._removeShapeInternal(this.shape);
    }
}

/**
 * Command to delete shapes
 */
export class DeleteShapesCommand extends Command {
    constructor(app, shapes) {
        super(shapes.length === 1 ? `Delete ${shapes[0].type}` : `Delete ${shapes.length} shapes`);
        this.app = app;
        // Build index map in one pass O(N) instead of O(N²) indexOf per shape
        const indexMap = new Map();
        for (let i = 0; i < app.shapes.length; i++) {
            indexMap.set(app.shapes[i], i);
        }
        this.shapesData = shapes.map(s => ({
            shape: s,
            index: indexMap.get(s) ?? -1
        }));
    }
    
    execute() {
        const app = this.app;
        const toRemove = new Set(this.shapesData.map(d => d.shape));
        let writeIdx = 0;
        for (let i = 0; i < app.shapes.length; i++) {
            if (!toRemove.has(app.shapes[i])) {
                app.shapes[writeIdx++] = app.shapes[i];
            }
        }
        app.shapes.length = writeIdx;

        const layer = app.viewport.contentLayer;
        const parent = layer.parentNode;
        const nextSib = layer.nextSibling;
        if (parent) parent.removeChild(layer);
        for (const data of this.shapesData) {
            const shape = data.shape;
            if (shape.element?.parentNode) shape.element.parentNode.removeChild(shape.element);
            if (shape.anchorsGroup?.parentNode) shape.anchorsGroup.parentNode.removeChild(shape.anchorsGroup);
            if (shape.selected) {
                shape.selected = false;
                app.selection.selected.delete(shape.id);
            }
            if (shape.hovered) {
                shape.hovered = false;
                if (app.selection.hovered === shape.id) app.selection.hovered = null;
            }
        }
        if (parent) parent.insertBefore(layer, nextSib);

        app.selection._selectionCache = null;
        app.selection._invalidateHitTestCache();
        app._updateSelectableItems();
        app.fileManager.setDirty(true);
    }
    
    undo() {
        const app = this.app;
        // Detach content layer for batched DOM additions
        const layer = app.viewport.contentLayer;
        const parent = layer.parentNode;
        const nextSib = layer.nextSibling;
        if (parent) parent.removeChild(layer);
        // Re-render and add to DOM, ensuring hover state is clean
        for (const data of this.shapesData) {
            data.shape.hovered = false;
            data.shape.render(app.viewport.scale);
            app.viewport.addContent(data.shape.element);
        }
        // Reattach content layer
        if (parent) parent.insertBefore(layer, nextSib);
        // Merge back at original positions using a single rebuild
        const sorted = [...this.shapesData].sort((a, b) => a.index - b.index);
        for (const data of sorted) {
            const idx = Math.min(data.index, app.shapes.length);
            app.shapes.splice(idx, 0, data.shape);
        }
        app._updateSelectableItems();
        app.selection._invalidateHitTestCache();
        app.fileManager.setDirty(true);
    }
}

/**
 * Command to move shapes
 */
export class MoveShapesCommand extends Command {
    constructor(app, items, dx, dy) {
        const label = items.length === 1 
            ? `Move ${items[0].type || items[0].reference || 'item'}` 
            : `Move ${items.length} items`;
        super(label);
        this.app = app;
        this.itemIds = items.map(s => s.id);
        this.dx = dx;
        this.dy = dy;
    }
    
    _buildLookup() {
        const map = new Map();
        for (const s of this.app.shapes) map.set(s.id, s);
        for (const c of this.app.components) map.set(c.id, c);
        return map;
    }
    
    execute() {
        const lookup = this._buildLookup();
        for (const id of this.itemIds) {
            const item = lookup.get(id);
            if (item) item.move(this.dx, this.dy);
        }
        this._updateStickyWires();
        this.app.renderShapes(true);
    }
    
    undo() {
        const lookup = this._buildLookup();
        for (const id of this.itemIds) {
            const item = lookup.get(id);
            if (item) item.move(-this.dx, -this.dy);
        }
        this._updateStickyWires();
        this.app.renderShapes(true);
    }

    /**
     * Update wire endpoints connected to component pins after move/undo.
     */
    _updateStickyWires() {
        for (const shape of this.app.shapes) {
            if (shape.type !== 'wire') continue;
            const conn = shape.connections;
            if (conn.start) {
                const comp = this.app.components.find(c => c.id === conn.start.componentId);
                if (comp) {
                    const pos = comp.getPinPosition(conn.start.pinNumber);
                    if (pos) {
                        shape.points[0].x = pos.x;
                        shape.points[0].y = pos.y;
                        shape.invalidate();
                    }
                }
            }
            if (conn.end) {
                const comp = this.app.components.find(c => c.id === conn.end.componentId);
                if (comp) {
                    const pos = comp.getPinPosition(conn.end.pinNumber);
                    if (pos) {
                        const last = shape.points[shape.points.length - 1];
                        last.x = pos.x;
                        last.y = pos.y;
                        shape.invalidate();
                    }
                }
            }
        }
    }
}

/**
 * Command to modify a shape (e.g., resize via anchor drag)
 */
export class ModifyShapeCommand extends Command {
    constructor(app, shape, beforeState, afterState) {
        super(`Modify ${shape.type}`);
        this.app = app;
        this.shapeId = shape.id;
        this.beforeState = beforeState;
        this.afterState = afterState;
    }
    
    execute() {
        const shape = this._findItem(this.shapeId);
        if (shape) {
            this._applyState(shape, this.afterState);
        }
    }
    
    undo() {
        const shape = this._findItem(this.shapeId);
        if (shape) {
            this._applyState(shape, this.beforeState);
        }
    }
    
    _findItem(id) {
        let item = this.app.shapes.find(s => s.id === id);
        if (!item) item = this.app.components.find(c => c.id === id);
        return item;
    }

    _applyState(shape, state) {
        shape.applyState(state);
        // Sync field text changes back to parent component
        if ('text' in state && shape.parentComponent && shape.fieldKey) {
            shape.parentComponent[shape.fieldKey] = shape.text;
        }
        this.app.renderShapes(true);
    }
}

/**
 * Command to modify properties on one or more shapes/components
 */
export class ModifyPropertyCommand extends Command {
    constructor(app, items, prop, newValue) {
        const label = items.length === 1
            ? `Change ${prop} of ${items[0].type || 'item'}`
            : `Change ${prop} of ${items.length} items`;
        super(label);
        this.app = app;
        this.entries = items.map(item => ({
            id: item.id,
            oldValue: item[prop],
            newValue
        }));
        this.prop = prop;
    }

    _findItem(id) {
        let item = this.app.shapes.find(s => s.id === id);
        if (!item) item = this.app.components.find(c => c.id === id);
        return item;
    }

    _applyValues(useNew) {
        const lookup = new Map();
        for (const s of this.app.shapes) lookup.set(s.id, s);
        for (const c of this.app.components) lookup.set(c.id, c);
        for (const entry of this.entries) {
            const item = lookup.get(entry.id);
            if (!item) continue;
            const val = useNew ? entry.newValue : entry.oldValue;
            // Mirror/flip needs special handling — must use flipHorizontal() for SVG recreation
            if (this.prop === 'mirror' && typeof item.flipHorizontal === 'function') {
                if (item.mirror !== val) {
                    item.flipHorizontal();
                }
            } else {
                item[this.prop] = val;
            }
            if (typeof item.invalidate === 'function') item.invalidate();
            // Sync field text changes back to parent component
            if (this.prop === 'text' && item.parentComponent && item.fieldKey) {
                item.parentComponent[item.fieldKey] = val;
            }
            // Sync component reference/value to field text content
            if (this.prop === 'reference' && item.refText) {
                item.refText.text = val;
                item.refText.invalidate();
            }
            if (this.prop === 'value' && item.valueText) {
                item.valueText.text = val;
                item.valueText.invalidate();
            }
            // Sync show flags to field text visibility
            if (this.prop === 'showReference' && item.refText) {
                item.refText.visible = val;
                item.refText.invalidate();
            }
            if (this.prop === 'showValue' && item.valueText) {
                item.valueText.visible = val;
                item.valueText.invalidate();
            }
        }
        this.app.renderShapes(true);
    }

    execute() { this._applyValues(true); }
    undo() { this._applyValues(false); }
}

/**
 * Command to delete components
 */
export class DeleteComponentsCommand extends Command {
    constructor(app, components) {
        super(components.length === 1
            ? `Delete ${components[0].reference || 'component'}`
            : `Delete ${components.length} components`);
        this.app = app;
        // Build index map in one pass O(N)
        const indexMap = new Map();
        for (let i = 0; i < app.components.length; i++) {
            indexMap.set(app.components[i], i);
        }
        this.componentsData = components.map(c => ({
            component: c,
            index: indexMap.get(c) ?? -1
        }));
    }

    execute() {
        const app = this.app;
        // Collect all items to remove
        const compsToRemove = new Set(this.componentsData.map(d => d.component));
        const ftsToRemove = new Set();
        // Detach content layer to batch DOM removals
        const layer = app.viewport.contentLayer;
        const parent = layer.parentNode;
        const nextSib = layer.nextSibling;
        if (parent) parent.removeChild(layer);
        for (const data of this.componentsData) {
            const comp = data.component;
            if (comp.hovered) {
                comp.hovered = false;
                if (app.selection.hovered === comp.id) app.selection.hovered = null;
            }
            if (comp.element?.parentNode) comp.element.parentNode.removeChild(comp.element);
            for (const ft of comp.getFieldTexts()) {
                ftsToRemove.add(ft);
                if (ft.hovered) {
                    ft.hovered = false;
                    if (app.selection.hovered === ft.id) app.selection.hovered = null;
                }
                if (ft.element?.parentNode) ft.element.parentNode.removeChild(ft.element);
            }
        }
        // Reattach content layer
        if (parent) parent.insertBefore(layer, nextSib);
        // In-place filter components: O(N) instead of O(N²)
        let writeIdx = 0;
        for (let i = 0; i < app.components.length; i++) {
            if (!compsToRemove.has(app.components[i])) {
                app.components[writeIdx++] = app.components[i];
            }
        }
        app.components.length = writeIdx;
        // In-place filter field texts from shapes: O(N)
        if (ftsToRemove.size > 0) {
            writeIdx = 0;
            for (let i = 0; i < app.shapes.length; i++) {
                if (!ftsToRemove.has(app.shapes[i])) {
                    app.shapes[writeIdx++] = app.shapes[i];
                }
            }
            app.shapes.length = writeIdx;
        }
        app._updateSelectableItems();
        app.fileManager.setDirty(true);
    }

    undo() {
        const app = this.app;
        const sorted = [...this.componentsData].sort((a, b) => a.index - b.index);
        const shapeSet = new Set(app.shapes);
        for (const data of sorted) {
            const comp = data.component;
            comp.hovered = false;
            if (!comp.element) comp.createSymbolElement();
            const idx = Math.min(data.index, app.components.length);
            app.components.splice(idx, 0, comp);
            app.viewport.addComponentContent(comp.element);
            for (const ft of comp.getFieldTexts()) {
                if (!shapeSet.has(ft)) {
                    app.shapes.push(ft);
                    shapeSet.add(ft);
                    ft.render(app.viewport.scale);
                    app.viewport.addContent(ft.element);
                }
            }
        }
        app._updateSelectableItems();
        app.fileManager.setDirty(true);
    }
}

/**
 * Command to add a component
 */
export class AddComponentCommand extends Command {
    constructor(app, component) {
        super(`Add ${component.reference || 'component'}`);
        this.app = app;
        this.component = component;
    }

    execute() {
        this.app.components.push(this.component);
        if (!this.component.element) {
            this.component.createSymbolElement();
        }
        this.app.viewport.addComponentContent(this.component.element);
        // Create field texts if they don't exist yet
        if (!this.component.refText && !this.component.valueText) {
            this.component.createFieldTexts(this.app);
        } else {
            // Re-add existing field texts
            for (const ft of this.component.getFieldTexts()) {
                if (!this.app.shapes.includes(ft)) {
                    this.app.shapes.push(ft);
                    ft.render(this.app.viewport.scale);
                    this.app.viewport.addContent(ft.element);
                }
            }
        }
        this.app._updateSelectableItems();
        this.app.fileManager.setDirty(true);
    }

    undo() {
        const idx = this.app.components.indexOf(this.component);
        if (idx !== -1) {
            this.app.components.splice(idx, 1);
        }
        if (this.component.element && this.component.element.parentNode) {
            this.component.element.parentNode.removeChild(this.component.element);
        }
        // Remove field texts
        const ftsToRemove = new Set();
        for (const ft of this.component.getFieldTexts()) {
            ftsToRemove.add(ft);
            if (ft.element && ft.element.parentNode) ft.element.parentNode.removeChild(ft.element);
        }
        if (ftsToRemove.size > 0) {
            let writeIdx = 0;
            for (let i = 0; i < this.app.shapes.length; i++) {
                if (!ftsToRemove.has(this.app.shapes[i])) {
                    this.app.shapes[writeIdx++] = this.app.shapes[i];
                }
            }
            this.app.shapes.length = writeIdx;
        }
        this.app._updateSelectableItems();
        this.app.fileManager.setDirty(true);
    }
}

/**
 * Command to transform a component (rotate/flip)
 */
export class TransformComponentCommand extends Command {
    constructor(app, components, type) {
        const label = components.length === 1
            ? `${type} ${components[0].reference || 'component'}`
            : `${type} ${components.length} components`;
        super(label);
        this.app = app;
        this.type = type;
        this.entries = components.map(c => ({
            id: c.id,
            oldX: c.x,
            oldY: c.y,
            oldRotation: c.rotation,
            oldMirror: c.mirror,
            // Capture field text positions for undo
            fieldPositions: c.getFieldTexts().map(ft => ({ id: ft.id, x: ft.x, y: ft.y }))
        }));
    }

    _apply(useOld) {
        for (const entry of this.entries) {
            const comp = this.app.components.find(c => c.id === entry.id);
            if (!comp) continue;
            if (useOld) {
                // Restore old position/rotation/mirror and field text positions
                const mirrorChanged = comp.mirror !== entry.oldMirror;
                comp.x = entry.oldX;
                comp.y = entry.oldY;
                comp.rotation = entry.oldRotation;
                comp.mirror = entry.oldMirror;
                for (const fp of entry.fieldPositions) {
                    const ft = comp.getFieldTexts().find(f => f.id === fp.id);
                    if (ft) { ft.x = fp.x; ft.y = fp.y; ft.invalidate(); }
                }
                // Rotation and mirror are baked into element creation — always recreate
                comp._recreateElement();
            } else {
                switch (this.type) {
                    case 'RotateRight': comp.rotate(90); break;
                    case 'RotateLeft':  comp.rotate(-90); break;
                    case 'FlipH':       comp.flipHorizontal(); break;
                    case 'FlipV':       comp.flipVertical(); break;
                    // Legacy support
                    case 'Rotate':      comp.rotate(90); break;
                    case 'Mirror':      comp.flipHorizontal(); break;
                }
            }
            if (comp.element) {
                const transform = comp._buildTransform();
                if (transform) {
                    comp.element.setAttribute('transform', transform);
                } else {
                    comp.element.removeAttribute('transform');
                }
            }
        }
        this.app.renderShapes(true);
    }

    execute() { this._apply(false); }
    undo() { this._apply(true); }
}

/**
 * Bulk paste command — adds many shapes and components in one go.
 * Only rebuilds the selectable-items map once at the end (O(N) instead of O(N²)).
 */
export class PasteCommand extends Command {
    constructor(app, shapes, components) {
        const n = shapes.length + components.length;
        super(`Paste ${n} item${n !== 1 ? 's' : ''}`);
        this.app = app;
        this.shapes = shapes;
        this.components = components;
    }

    execute() {
        const app = this.app;
        // Build a Set for O(1) membership checks on field texts
        const shapeSet = new Set(app.shapes);
        // Bulk-add shapes without per-item updateSelectableItems
        for (const shape of this.shapes) {
            app.shapes.push(shape);
            shape.render(app.viewport.scale);
            app.viewport.addContent(shape.element);
            shapeSet.add(shape);
        }
        // Bulk-add components
        for (const comp of this.components) {
            app.components.push(comp);
            if (!comp.element) comp.createSymbolElement();
            app.viewport.addComponentContent(comp.element);
            if (!comp.refText && !comp.valueText) {
                comp.createFieldTexts(app);
            } else {
                for (const ft of comp.getFieldTexts()) {
                    if (!shapeSet.has(ft)) {
                        app.shapes.push(ft);
                        shapeSet.add(ft);
                        ft.render(app.viewport.scale);
                        app.viewport.addContent(ft.element);
                    }
                }
            }
        }
        app._updateSelectableItems();
        app.selection._invalidateHitTestCache();
        app.fileManager.setDirty(true);
    }

    undo() {
        const app = this.app;
        // Collect all items to remove in Sets for O(N) filtering
        const shapesToRemove = new Set(this.shapes);
        const compsToRemove = new Set(this.components);
        const ftsToRemove = new Set();

        // Remove component DOM and collect field texts
        for (const comp of this.components) {
            if (comp.element?.parentNode) comp.element.parentNode.removeChild(comp.element);
            for (const ft of comp.getFieldTexts()) {
                ftsToRemove.add(ft);
                if (ft.element?.parentNode) ft.element.parentNode.removeChild(ft.element);
                if (ft.selected) {
                    ft.selected = false;
                    app.selection.selected.delete(ft.id);
                }
            }
            if (comp.selected) {
                comp.selected = false;
                app.selection.selected.delete(comp.id);
            }
        }
        // Remove shape DOM
        for (const shape of this.shapes) {
            if (shape.element?.parentNode) shape.element.parentNode.removeChild(shape.element);
            if (shape.anchorsGroup?.parentNode) shape.anchorsGroup.parentNode.removeChild(shape.anchorsGroup);
            if (shape.selected) {
                shape.selected = false;
                app.selection.selected.delete(shape.id);
            }
        }
        // In-place filter shapes array: O(N) instead of O(N²)
        let writeIdx = 0;
        for (let i = 0; i < app.shapes.length; i++) {
            if (!shapesToRemove.has(app.shapes[i]) && !ftsToRemove.has(app.shapes[i])) {
                app.shapes[writeIdx++] = app.shapes[i];
            }
        }
        app.shapes.length = writeIdx;
        // In-place filter components array: O(N)
        writeIdx = 0;
        for (let i = 0; i < app.components.length; i++) {
            if (!compsToRemove.has(app.components[i])) {
                app.components[writeIdx++] = app.components[i];
            }
        }
        app.components.length = writeIdx;
        // One-time bookkeeping
        app.selection._selectionCache = null;
        app.selection._invalidateHitTestCache();
        app.selection._notifySelectionChanged();
        app._updateSelectableItems();
        app.fileManager.setDirty(true);
    }
}

/**
 * Command that groups multiple sub-commands into a single undo/redo entry
 */
export class BatchCommand extends Command {
    constructor(label) {
        super(label);
        this.commands = [];
    }

    add(command) {
        this.commands.push(command);
    }

    execute() {
        for (const cmd of this.commands) cmd.execute();
    }

    undo() {
        for (let i = this.commands.length - 1; i >= 0; i--) this.commands[i].undo();
    }
}