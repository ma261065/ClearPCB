/**
 * CommandHistory - Manages undo/redo stack
 * 
 * Uses the Command pattern to track reversible operations.
 */

import { freeWireLabel, bumpWireLabelCounter } from '../shapes/wire.js';

/** @typedef {any} SchematicApp */
/** @typedef {any} Shape */
/** @typedef {any} Component */

export class CommandHistory {
    /**
     * Create a new CommandHistory.
     * @param {Object} [options]
     * @param {number} [options.maxSize=100] - Maximum number of undo entries to keep
     * @param {Function} [options.onChanged] - Callback fired after every undo/redo/execute/clear
     */
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

/**
 * Command to add a shape
 */
export class AddShapeCommand extends Command {
    /**
     * @param {SchematicApp} app - Application instance
     * @param {Shape} shape - The shape to add
     */
    constructor(app, shape) {
        super(`Add ${shape.type}`);
        this.app = app;
        this.shape = shape;
        this.linkedWireLabelText = shape.type === 'wire' ? (shape.labelText || null) : null;
    }

    _ensureWireLabelTextPresent() {
        if (this.shape.type !== 'wire') return;
        const labelText = this.shape.labelText || this.linkedWireLabelText;
        if (!labelText) return;

        this.linkedWireLabelText = labelText;
        this.shape.labelText = labelText;
        labelText.parentComponent = this.shape;

        if (!this.app.shapes.includes(labelText)) {
            this.app.shapes.push(labelText);
        }
        if (!labelText.element || !labelText.element.parentNode) {
            labelText.render(this.app.viewport.scale);
            this.app.viewport.addContent(labelText.element);
        }
    }
    
    /** Add the shape to the canvas. */
    execute() {
        if (this.shape.type === 'wire' && this.linkedWireLabelText && !this.shape.labelText) {
            this.shape.labelText = this.linkedWireLabelText;
        }
        this.app._addShapeInternal(this.shape);
        this._ensureWireLabelTextPresent();
        this.app._updateSelectableItems();
        this.app.selection._invalidateHitTestCache();
    }
    
    /** Remove the shape from the canvas. */
    undo() {
        if (this.shape.type === 'wire') {
            this.app._removeShapeInternal(this.shape, { preserveWireLabelRef: true });
            const linked = this.shape.labelText || this.linkedWireLabelText;
            if (linked) {
                this.linkedWireLabelText = linked;
                this.shape.labelText = linked;
                linked.parentComponent = this.shape;
            }
            return;
        }
        this.app._removeShapeInternal(this.shape);
    }
}

/**
 * Command to delete shapes
 */
export class DeleteShapesCommand extends Command {
    /**
     * @param {SchematicApp} app - Application instance
     * @param {Shape[]} shapes - The shapes to delete
     */
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

        const explicitShapes = new Set(shapes);
        this.linkedLabelData = [];
        for (const data of this.shapesData) {
            const shape = data.shape;
            if (shape.type === 'wire' && shape.labelText && !explicitShapes.has(shape.labelText)) {
                this.linkedLabelData.push({
                    shape: shape.labelText,
                    index: indexMap.get(shape.labelText) ?? -1,
                    parentWire: shape
                });
            }
        }
    }
    
    /** Remove the shapes from the canvas and deselect them. */
    execute() {
        const app = this.app;
        const allData = [...this.shapesData, ...this.linkedLabelData];
        const toRemove = new Set(allData.map(d => d.shape));

        let writeIdx = 0;
        for (let i = 0; i < app.shapes.length; i++) {
            if (!toRemove.has(app.shapes[i])) {
                app.shapes[writeIdx++] = app.shapes[i];
            }
        }
        app.shapes.length = writeIdx;

        for (const data of this.shapesData) {
            const shape = data.shape;
            if (shape.type === 'wire' && shape.wireLabel) freeWireLabel(shape.wireLabel);
        }

        const layer = app.viewport.contentLayer;
        const parent = layer.parentNode;
        const nextSib = layer.nextSibling;
        if (parent) parent.removeChild(layer);
        for (const data of allData) {
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
    
    /** Re-insert the shapes at their original z-order positions. */
    undo() {
        const app = this.app;
        const allData = [...this.shapesData, ...this.linkedLabelData];
        // Detach content layer for batched DOM additions
        const layer = app.viewport.contentLayer;
        const parent = layer.parentNode;
        const nextSib = layer.nextSibling;
        if (parent) parent.removeChild(layer);
        // Re-render and add to DOM, ensuring hover state is clean
        for (const data of allData) {
            data.shape.hovered = false;
            data.shape.render(app.viewport.scale);
            app.viewport.addContent(data.shape.element);
        }
        // Reattach content layer
        if (parent) parent.insertBefore(layer, nextSib);
        // Merge back at original positions using a single rebuild
        const sorted = [...allData].sort((a, b) => a.index - b.index);
        for (const data of sorted) {
            if (app.shapes.includes(data.shape)) continue;
            const idx = data.index >= 0 ? Math.min(data.index, app.shapes.length) : app.shapes.length;
            app.shapes.splice(idx, 0, data.shape);
            if (data.shape.type === 'wire' && data.shape.wireLabel) bumpWireLabelCounter(data.shape.wireLabel);
        }

        for (const linked of this.linkedLabelData) {
            if (linked.parentWire && linked.parentWire.labelText !== linked.shape) {
                linked.parentWire.labelText = linked.shape;
            }
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
    /**
     * @param {SchematicApp} app - Application instance
     * @param {Array<Shape|Component>} items - Items to move
     * @param {number} dx - Horizontal displacement
     * @param {number} dy - Vertical displacement
     */
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
    
    /**
     * Build a Map of id → shape/component for O(1) lookups.
     * @returns {Map<string, Shape|Component>}
     */
    _buildLookup() {
        const map = new Map();
        for (const s of this.app.shapes) map.set(s.id, s);
        for (const c of this.app.components) map.set(c.id, c);
        return map;
    }
    
    /** Move all items by (dx, dy) and update sticky wires. */
    execute() {
        const lookup = this._buildLookup();
        for (const id of this.itemIds) {
            const item = lookup.get(id);
            if (item) item.move(this.dx, this.dy);
        }
        this._updateStickyWires();
        this.app.renderShapes(true);
    }
    
    /** Move all items by (-dx, -dy) and update sticky wires. */
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
     * Update wire nodes connected to component pins after move/undo.
     * NOTE: Duplicates updateStickyWires() in ui/modules/wire.js.
     * Kept inline to avoid circular import (wire.js imports from this module).
     */
    _updateStickyWires() {
        // Build set of moved item IDs so we can skip NoConnect shapes that
        // the user is intentionally moving away from their pin.
        const movedIds = new Set(this.itemIds);
        for (const shape of this.app.shapes) {
            if (shape.type === 'wire') {
                for (const [nodeId, conn] of shape.pinConnections) {
                    const comp = this.app.components.find(c => c.id === conn.componentId);
                    if (comp) {
                        const pos = comp.getPinPosition(conn.pinNumber);
                        if (pos) {
                            const node = shape.nodes.get(nodeId);
                            if (node) {
                                node.x = pos.x;
                                node.y = pos.y;
                                shape.invalidate();
                            }
                        }
                    }
                }
            } else if (shape.type === 'noconnect' && shape.pinConnection) {
                // Skip if this NC is one of the items being moved — the user
                // is deliberately dragging it, so don't snap it back to the pin.
                if (movedIds.has(shape.id)) continue;
                const comp = this.app.components.find(c => c.id === shape.pinConnection.componentId);
                if (comp) {
                    const pos = comp.getPinPosition(shape.pinConnection.pinNumber);
                    if (pos) {
                        shape.x = pos.x;
                        shape.y = pos.y;
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
    /**
     * @param {SchematicApp} app - Application instance
     * @param {Shape|Component} shape - The item being modified
     * @param {Object} beforeState - Snapshot of shape state before the edit
     * @param {Object} afterState - Snapshot of shape state after the edit
     */
    constructor(app, shape, beforeState, afterState) {
        super(`Modify ${shape.type}`);
        this.app = app;
        this.shapeId = shape.id;
        this.beforeState = beforeState;
        this.afterState = afterState;
    }
    
    /** Apply the after-state to restore the modification. */
    execute() {
        const shape = this._findItem(this.shapeId);
        if (shape) {
            this._applyState(shape, this.afterState);
        }
    }
    
    /** Apply the before-state to reverse the modification. */
    undo() {
        const shape = this._findItem(this.shapeId);
        if (shape) {
            this._applyState(shape, this.beforeState);
        }
    }
    
    /**
     * Find a shape or component by ID.
     * @param {string} id
     * @returns {Shape|Component|undefined}
     */
    _findItem(id) {
        let item = this.app.shapes.find(s => s.id === id);
        if (!item) item = this.app.components.find(c => c.id === id);
        return item;
    }

    /**
     * Apply a captured state snapshot to a shape and re-render.
     * @param {Shape|Component} shape
     * @param {Object} state - State object from captureState()
     */
    _applyState(shape, state) {
        shape.applyState(state);
        // Sync field text changes back to parent component or wire
        if ('text' in state && shape.parentComponent && shape.fieldKey) {
            if (shape.fieldKey === 'wireLabel' && shape.parentComponent.type === 'wire') {
                freeWireLabel(shape.parentComponent.wireLabel);
                shape.parentComponent.wireLabel = shape.text;
                bumpWireLabelCounter(shape.text);
                shape.parentComponent.invalidate();
            } else {
                shape.parentComponent[shape.fieldKey] = shape.text;
            }
        }
        this.app.renderShapes(true);
    }
}

/**
 * Command to modify properties on one or more shapes/components
 */
export class ModifyPropertyCommand extends Command {
    /**
     * @param {SchematicApp} app - Application instance
     * @param {Array<Shape|Component>} items - Items whose property is changing
     * @param {string} prop - Property name to modify
     * @param {*} newValue - New value for the property
     */
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

    /**
     * Find a shape or component by ID.
     * @param {string} id
     * @returns {Shape|Component|undefined}
     */
    _findItem(id) {
        let item = this.app.shapes.find(s => s.id === id);
        if (!item) item = this.app.components.find(c => c.id === id);
        return item;
    }

    /**
     * Apply new or old property values to all affected items and re-render.
     * Handles special cases like mirror (flipHorizontal), field text sync,
     * and show-reference/show-value visibility toggling.
     * @param {boolean} useNew - If true apply newValue; otherwise restore oldValue
     */
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
            // Sync wireLabel property edits through the label tracking system
            if (this.prop === 'wireLabel' && item.type === 'wire') {
                const otherLabel = useNew ? entry.oldValue : entry.newValue;
                freeWireLabel(otherLabel);
                bumpWireLabelCounter(val);
                // Update the separate label Text shape
                if (item.labelText) {
                    item.labelText.text = val;
                    item.labelText.invalidate();
                }
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

    /** Apply the new property values. */
    execute() { this._applyValues(true); }
    /** Restore the old property values. */
    undo() { this._applyValues(false); }
}

/**
 * Command to delete components
 */
export class DeleteComponentsCommand extends Command {
    /**
     * @param {SchematicApp} app - Application instance
     * @param {Component[]} components - Components to delete
     */
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

    /** Remove the components and their field texts from the canvas. */
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

    /** Re-insert the components at their original positions and restore field texts. */
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
    /**
     * @param {SchematicApp} app - Application instance
     * @param {Component} component - The component to add
     */
    constructor(app, component) {
        super(`Add ${component.reference || 'component'}`);
        this.app = app;
        this.component = component;
    }

    /** Add the component and its field texts to the canvas. */
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

    /** Remove the component and its field texts from the canvas. */
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
    /**
     * @param {SchematicApp} app - Application instance
     * @param {Component[]} components - Components to transform
     * @param {string} type - Transform type: 'RotateRight', 'RotateLeft', 'FlipH', 'FlipV', 'Rotate', or 'Mirror'
     */
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

    /**
     * Apply or reverse the transform on all affected components.
     * @param {boolean} useOld - If true, restore the captured before-state (undo);
     *                           if false, perform the transform (execute)
     */
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
        this._updateStickyWires();
        this.app.renderShapes(true);
    }

    /** Perform the transform. */
    execute() { this._apply(false); }
    /** Reverse the transform by restoring captured state. */
    undo() { this._apply(true); }

    /**
     * Update wire nodes connected to component pins after transform.
     * NOTE: Duplicates updateStickyWires() in ui/modules/wire.js and
     * MoveShapesCommand._updateStickyWires() — kept inline to avoid
     * circular imports.
     */
    _updateStickyWires() {
        for (const shape of this.app.shapes) {
            if (shape.type === 'wire') {
                for (const [nodeId, conn] of shape.pinConnections) {
                    const comp = this.app.components.find(c => c.id === conn.componentId);
                    if (comp) {
                        const pos = comp.getPinPosition(conn.pinNumber);
                        if (pos) {
                            const node = shape.nodes.get(nodeId);
                            if (node) {
                                node.x = pos.x;
                                node.y = pos.y;
                                shape.invalidate();
                            }
                        }
                    }
                }
            } else if (shape.type === 'noconnect' && shape.pinConnection) {
                const comp = this.app.components.find(c => c.id === shape.pinConnection.componentId);
                if (comp) {
                    const pos = comp.getPinPosition(shape.pinConnection.pinNumber);
                    if (pos) {
                        shape.x = pos.x;
                        shape.y = pos.y;
                        shape.invalidate();
                    }
                }
            }
        }
    }
}

/**
 * Bulk paste command — adds many shapes and components in one go.
 * Only rebuilds the selectable-items map once at the end (O(N) instead of O(N²)).
 */
export class PasteCommand extends Command {
    /**
     * @param {SchematicApp} app - Application instance
     * @param {Shape[]} shapes - Pasted shapes
     * @param {Component[]} components - Pasted components
     */
    constructor(app, shapes, components) {
        const n = shapes.length + components.length;
        super(`Paste ${n} item${n !== 1 ? 's' : ''}`);
        this.app = app;
        this.shapes = shapes;
        this.components = components;
    }

    /** Add all pasted shapes and components to the canvas. */
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

    /** Remove all pasted shapes and components from the canvas. */
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
    /**
     * @param {string} label - Description for the grouped operation
     */
    constructor(label) {
        super(label);
        this.commands = [];
    }

    /**
     * Append a sub-command to the batch.
     * @param {Command} command
     */
    add(command) {
        this.commands.push(command);
    }

    /** Execute all sub-commands in order. */
    execute() {
        for (const cmd of this.commands) cmd.execute();
    }

    /** Undo all sub-commands in reverse order. */
    undo() {
        for (let i = this.commands.length - 1; i >= 0; i--) this.commands[i].undo();
    }
}