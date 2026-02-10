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
                if (item.type === 'arc' && item.bulgePoint) {
                    item.bulgePoint.x += this.dx;
                    item.bulgePoint.y += this.dy;
                }
            }
        }
        this.app.renderShapes(true);
    }
    
    undo() {
        for (const id of this.itemIds) {
            const item = this._findItem(id);
            if (item) {
                item.move(-this.dx, -this.dy);
                if (item.type === 'arc' && item.bulgePoint) {
                    item.bulgePoint.x -= this.dx;
                    item.bulgePoint.y -= this.dy;
                }
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
        const shape = this.app.shapes.find(s => s.id === this.shapeId);
        if (shape) {
            this._applyState(shape, this.afterState);
        }
    }
    
    undo() {
        const shape = this.app.shapes.find(s => s.id === this.shapeId);
        if (shape) {
            this._applyState(shape, this.beforeState);
        }
    }
    
    _applyState(shape, state) {
        for (const [key, value] of Object.entries(state)) {
            if (key === 'points' && Array.isArray(value)) {
                // Deep copy for points array
                shape.points = value.map(p => ({ ...p }));
            } else {
                shape[key] = value;
            }
        }
        shape.invalidate();
        this.app.renderShapes(true);
    }
}