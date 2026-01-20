/**
 * CommandHistory - Undo/Redo system using the Command pattern
 * 
 * All document modifications should go through commands to enable undo/redo.
 * 
 * Usage:
 *   const cmd = new MoveCommand(component, oldPos, newPos);
 *   history.execute(cmd);
 *   history.undo();
 *   history.redo();
 */

/**
 * Base class for all commands
 * @abstract
 */
export class Command {
    constructor(description = 'Unknown action') {
        this.description = description;
        this.timestamp = Date.now();
    }

    /**
     * Execute the command
     * @abstract
     */
    execute() {
        throw new Error('Command.execute() must be implemented');
    }

    /**
     * Undo the command
     * @abstract
     */
    undo() {
        throw new Error('Command.undo() must be implemented');
    }

    /**
     * Optional: Can this command be merged with another?
     * Useful for continuous actions like dragging
     * @param {Command} other 
     * @returns {boolean}
     */
    canMergeWith(other) {
        return false;
    }

    /**
     * Optional: Merge another command into this one
     * @param {Command} other 
     */
    mergeWith(other) {
        // Override in subclasses that support merging
    }
}

/**
 * Group multiple commands into a single undoable action
 */
export class CompoundCommand extends Command {
    constructor(commands = [], description = 'Multiple actions') {
        super(description);
        this.commands = commands;
    }

    add(command) {
        this.commands.push(command);
    }

    execute() {
        this.commands.forEach(cmd => cmd.execute());
    }

    undo() {
        // Undo in reverse order
        for (let i = this.commands.length - 1; i >= 0; i--) {
            this.commands[i].undo();
        }
    }
}

/**
 * Command history manager
 */
export class CommandHistory {
    constructor(options = {}) {
        this.undoStack = [];
        this.redoStack = [];
        this.maxSize = options.maxSize || 100;
        this.onChange = options.onChange || null;
        
        // For merging continuous actions
        this.lastCommandTime = 0;
        this.mergeWindow = options.mergeWindow || 500; // ms
    }

    /**
     * Execute a command and add it to history
     * @param {Command} command 
     */
    execute(command) {
        command.execute();
        
        // Check if we can merge with the last command
        const lastCommand = this.undoStack[this.undoStack.length - 1];
        const timeSinceLastCommand = Date.now() - this.lastCommandTime;
        
        if (lastCommand && 
            timeSinceLastCommand < this.mergeWindow && 
            lastCommand.canMergeWith(command)) {
            lastCommand.mergeWith(command);
        } else {
            this.undoStack.push(command);
            
            // Trim history if too large
            while (this.undoStack.length > this.maxSize) {
                this.undoStack.shift();
            }
        }
        
        // Clear redo stack on new action
        this.redoStack = [];
        
        this.lastCommandTime = Date.now();
        this._notifyChange();
    }

    /**
     * Undo the last command
     * @returns {boolean} Whether undo was successful
     */
    undo() {
        if (!this.canUndo()) return false;
        
        const command = this.undoStack.pop();
        command.undo();
        this.redoStack.push(command);
        
        this._notifyChange();
        return true;
    }

    /**
     * Redo the last undone command
     * @returns {boolean} Whether redo was successful
     */
    redo() {
        if (!this.canRedo()) return false;
        
        const command = this.redoStack.pop();
        command.execute();
        this.undoStack.push(command);
        
        this._notifyChange();
        return true;
    }

    /**
     * Check if undo is possible
     * @returns {boolean}
     */
    canUndo() {
        return this.undoStack.length > 0;
    }

    /**
     * Check if redo is possible
     * @returns {boolean}
     */
    canRedo() {
        return this.redoStack.length > 0;
    }

    /**
     * Get description of the next undo action
     * @returns {string|null}
     */
    getUndoDescription() {
        if (!this.canUndo()) return null;
        return this.undoStack[this.undoStack.length - 1].description;
    }

    /**
     * Get description of the next redo action
     * @returns {string|null}
     */
    getRedoDescription() {
        if (!this.canRedo()) return null;
        return this.redoStack[this.redoStack.length - 1].description;
    }

    /**
     * Clear all history
     */
    clear() {
        this.undoStack = [];
        this.redoStack = [];
        this._notifyChange();
    }

    /**
     * Get history statistics
     */
    getStats() {
        return {
            undoCount: this.undoStack.length,
            redoCount: this.redoStack.length,
            maxSize: this.maxSize
        };
    }

    _notifyChange() {
        if (this.onChange) {
            this.onChange({
                canUndo: this.canUndo(),
                canRedo: this.canRedo(),
                undoDescription: this.getUndoDescription(),
                redoDescription: this.getRedoDescription()
            });
        }
    }
}

// ==================== Common Command Implementations ====================

/**
 * Command for adding an item to a collection
 */
export class AddItemCommand extends Command {
    constructor(collection, item, description = 'Add item') {
        super(description);
        this.collection = collection;
        this.item = item;
    }

    execute() {
        this.collection.push(this.item);
    }

    undo() {
        const index = this.collection.indexOf(this.item);
        if (index !== -1) {
            this.collection.splice(index, 1);
        }
    }
}

/**
 * Command for removing an item from a collection
 */
export class RemoveItemCommand extends Command {
    constructor(collection, item, description = 'Remove item') {
        super(description);
        this.collection = collection;
        this.item = item;
        this.index = -1;
    }

    execute() {
        this.index = this.collection.indexOf(this.item);
        if (this.index !== -1) {
            this.collection.splice(this.index, 1);
        }
    }

    undo() {
        if (this.index !== -1) {
            this.collection.splice(this.index, 0, this.item);
        }
    }
}

/**
 * Command for moving an item
 */
export class MoveCommand extends Command {
    constructor(item, oldPosition, newPosition, description = 'Move') {
        super(description);
        this.item = item;
        this.oldPosition = { ...oldPosition };
        this.newPosition = { ...newPosition };
    }

    execute() {
        this.item.x = this.newPosition.x;
        this.item.y = this.newPosition.y;
    }

    undo() {
        this.item.x = this.oldPosition.x;
        this.item.y = this.oldPosition.y;
    }

    canMergeWith(other) {
        return other instanceof MoveCommand && other.item === this.item;
    }

    mergeWith(other) {
        this.newPosition = { ...other.newPosition };
    }
}

/**
 * Command for changing a property value
 */
export class SetPropertyCommand extends Command {
    constructor(object, property, newValue, description = 'Change property') {
        super(description);
        this.object = object;
        this.property = property;
        this.oldValue = object[property];
        this.newValue = newValue;
    }

    execute() {
        this.object[this.property] = this.newValue;
    }

    undo() {
        this.object[this.property] = this.oldValue;
    }

    canMergeWith(other) {
        return other instanceof SetPropertyCommand && 
               other.object === this.object && 
               other.property === this.property;
    }

    mergeWith(other) {
        this.newValue = other.newValue;
    }
}