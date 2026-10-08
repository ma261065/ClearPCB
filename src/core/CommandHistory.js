/**
 * @typedef {{execute(): void, undo(): void, description?: string}} HistoryCommand
 * @typedef {{canUndo: boolean, canRedo: boolean, undoDescription: string|null, redoDescription: string|null}} HistoryState
 */

export class CommandHistory {
    /**
     * Create a new CommandHistory.
     * @param {Object} [options]
     * @param {number} [options.maxSize=100] - Maximum number of undo entries to keep
     * @param {Function} [options.onChanged] - Callback fired after every undo/redo/execute/clear
     * @param {(command: any) => void} [options.guard] - Throws to refuse a new command before it
     *   runs (see core/edit-guard.js); undo, redo and record() are not guarded
     * @param {(error: Error) => void} [options.onRefused] - Told about a refusal, which is rethrown
     */
    constructor(options = {}) {
        /** @type {HistoryCommand[]} */
        this.undoStack = [];
        /** @type {HistoryCommand[]} */
        this.redoStack = [];
        this.maxSize = options.maxSize || 100;
        
        // Callbacks
        this.onChanged = options.onChanged || null;
        this.guard = options.guard || null;
        this.onRefused = options.onRefused || null;
    }
    
    /**
     * Execute a command and add it to the undo stack. A guard refusal throws before
     * the command runs, so nothing changes; callers' cleanup handles it like any
     * other command failure.
     * @param {{execute(): void, undo(): void, description?: string}} command - any command object;
     *   it need not extend Command (PCB model commands are plain classes)
     */
    execute(command) {
        if (this.guard) {
            try {
                this.guard(command);
            } catch (error) {
                this.onRefused?.(error);
                throw error;
            }
        }
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
        
        const command = this.undoStack[this.undoStack.length - 1];
        command.undo();
        this.undoStack.pop();
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
        
        const command = this.redoStack[this.redoStack.length - 1];
        command.execute();
        this.redoStack.pop();
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
    
    /** Notify the onChanged callback with current undo/redo state. */
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

    /**
     * Push a pre-applied command onto the undo stack without executing it.
     * Use when the command's effects have already been applied manually.
     * Clears the redo stack.
     * @param {HistoryCommand} command - Command to record
     */
    record(command) {
        this.undoStack.push(command);
        this.redoStack = [];
        if (this.undoStack.length > this.maxSize) {
            this.undoStack.shift();
        }
        this._notifyChanged();
    }

    /**
     * Pop the top N entries from the undo stack.
     * @param {number} [count=1] - Number of entries to remove
     * @returns {HistoryCommand[]} The popped commands (most recent first)
     */
    popUndo(count = 1) {
        /** @type {HistoryCommand[]} */
        const popped = [];
        for (let i = 0; i < count && this.undoStack.length > 0; i++) {
            const command = this.undoStack.pop();
            if (command) popped.push(command);
        }
        return popped;
    }

    /**
     * Replace the top undo entry with a new command.
     * Useful for merging a just-pushed command with additional follow-up work.
     * @param {HistoryCommand} command - Replacement command
     */
    replaceTop(command) {
        if (this.undoStack.length > 0) {
            this.undoStack.pop();
        }
        this.undoStack.push(command);
        this.redoStack = [];
        this._notifyChanged();
    }
}

/**
 * Base Command class
 */
export class Command {
    /**
     * @param {string} [description='Unknown action'] - Human-readable description for the undo/redo menu
     */
    constructor(description = 'Unknown action') {
        this.description = description;
    }
    
    /** Execute (or re-execute) the command. Subclasses must override. */
    execute() {
        throw new Error('execute() must be implemented');
    }
    
    /** Reverse the command. Subclasses must override. */
    undo() {
        throw new Error('undo() must be implemented');
    }
}
