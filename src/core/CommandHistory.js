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
        // Store shape data for restoration
        this.shapesData = shapes.map(s => ({
            shape: s,
            index: app.shapes.indexOf(s)
        }));
    }
    
    execute() {
        // Remove in reverse order to maintain indices
        for (let i = this.shapesData.length - 1; i >= 0; i--) {
            this.app._removeShapeInternal(this.shapesData[i].shape);
        }
    }
    
    undo() {
        // Re-add in original order at original positions
        for (const data of this.shapesData) {
            this.app._addShapeInternalAt(data.shape, data.index);
        }
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
    
    _findItem(id) {
        // Search in both shapes and components
        let item = this.app.shapes.find(s => s.id === id);
        if (!item) {
            item = this.app.components.find(c => c.id === id);
        }
        return item;
    }
    
    execute() {
        for (const id of this.itemIds) {
            const item = this._findItem(id);
            if (item) {
                item.move(this.dx, this.dy);
            }
        }
        this.app.renderShapes(true);
    }
    
    undo() {
        for (const id of this.itemIds) {
            const item = this._findItem(id);
            if (item) {
                item.move(-this.dx, -this.dy);
            }
        }
        this.app.renderShapes(true);
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
        const shape = this._findShape(this.shapeId);
        if (shape) {
            this._applyState(shape, this.afterState);
        }
    }
    
    undo() {
        const shape = this._findShape(this.shapeId);
        if (shape) {
            this._applyState(shape, this.beforeState);
        }
    }
    
    _findShape(id) {
        let shape = this.app.shapes.find(s => s.id === id);
        if (!shape) shape = this.app.components.find(c => c.id === id);
        return shape;
    }

    _applyState(shape, state) {
        for (const [key, value] of Object.entries(state)) {
            if (key === 'points' && Array.isArray(value)) {
                // Deep copy for points array
                shape.points = value.map(p => ({ ...p }));
            } else if ((key === 'startPoint' || key === 'endPoint' || key === 'bulgePoint') && value) {
                shape[key] = { x: value.x, y: value.y };
            } else {
                shape[key] = value;
            }
        }
        shape.invalidate();
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

    execute() {
        for (const entry of this.entries) {
            const item = this._findItem(entry.id);
            if (item) {
                item[this.prop] = entry.newValue;
                if (typeof item.invalidate === 'function') item.invalidate();
            }
        }
        this.app.renderShapes(true);
    }

    undo() {
        for (const entry of this.entries) {
            const item = this._findItem(entry.id);
            if (item) {
                item[this.prop] = entry.oldValue;
                if (typeof item.invalidate === 'function') item.invalidate();
            }
        }
        this.app.renderShapes(true);
    }
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
        this.componentsData = components.map(c => ({
            component: c,
            index: app.components.indexOf(c)
        }));
    }

    execute() {
        for (let i = this.componentsData.length - 1; i >= 0; i--) {
            const comp = this.componentsData[i].component;
            const idx = this.app.components.indexOf(comp);
            if (idx !== -1) {
                this.app.components.splice(idx, 1);
            }
            if (comp.element && comp.element.parentNode) {
                comp.element.parentNode.removeChild(comp.element);
            }
        }
        this.app._updateSelectableItems();
        this.app.fileManager.setDirty(true);
    }

    undo() {
        for (const data of this.componentsData) {
            const comp = data.component;
            // Re-create SVG element if it was destroyed
            if (!comp.element) {
                comp.createSymbolElement();
            }
            if (data.index >= 0 && data.index < this.app.components.length) {
                this.app.components.splice(data.index, 0, comp);
            } else {
                this.app.components.push(comp);
            }
            this.app.viewport.addContent(comp.element);
        }
        this.app._updateSelectableItems();
        this.app.fileManager.setDirty(true);
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
        this.app.viewport.addContent(this.component.element);
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
        this.app._updateSelectableItems();
        this.app.fileManager.setDirty(true);
    }
}

/**
 * Command to transform a component (rotate/mirror)
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
            oldRotation: c.rotation,
            oldMirror: c.mirror
        }));
    }

    _apply(useOld) {
        for (const entry of this.entries) {
            const comp = this.app.components.find(c => c.id === entry.id);
            if (!comp) continue;
            if (useOld) {
                comp.rotation = entry.oldRotation;
                comp.mirror = entry.oldMirror;
            } else {
                if (this.type === 'Rotate') {
                    comp.rotation = (entry.oldRotation + 90) % 360;
                } else {
                    comp.mirror = !entry.oldMirror;
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