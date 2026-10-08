import { Command } from '../../core/CommandHistory.js';
import { editTargets } from '../../core/edit-guard.js';
import { setComponentReference } from '../../core/SchematicDocument.js';
import { Component } from '../../components/Component.js';
/**
 * CommandHistory - Manages undo/redo stack
 * 
 * Uses the Command pattern to track reversible operations.
 */

import { freeWireLabel, bumpWireLabelCounter, freeNetName, bumpNetNameCounter } from '../../shapes/wire.js';
import { applyStickyConnections } from './sticky-wires.js';
import { connectComponentPinsToWires, PIN_ATTACH_TOL } from './pin-wire-connect.js';
import { mountComponent, mountShape, redrawShape, refreshComponentPose, unmountComponent, unmountShape, withContentDetached } from './schematic-view.js';
/** @typedef {import('./schematic-editor-api.js').SchematicEditor} SchematicEditor */
/** @typedef {import('../../core/CommandHistory.js').HistoryCommand} HistoryCommand */
/**
 * @typedef {any} Shape
 * @typedef {import('../../core/SchematicDocument.js').SchematicShape} Wire
 * @typedef {import('../../shapes/text.js').Text} TextShape
 * @typedef {import('./selection.js').ShapeState} ShapeState
 * @typedef {import('../../ui/SchematicApp.js').ShapeRestoreData} ShapeRestoreData
 * @typedef {{component: Component, index: number}} ComponentRestoreData
 * @typedef {{wire: Wire, nodeId: string, conn: Record<string, any>}} RemovedPinConnection
 */

/**
 * Update wires connected to a Net label to use its current net name.
 * @param {SchematicEditor} app
 * @param {Shape} netShape
 */
function _propagateNetNameToWires(app, netShape) {
    for (const wire of app.shapes) {
        if (wire.type !== 'wire') continue;
        for (const [, conn] of wire.pinConnections) {
            if (conn.componentId === netShape.id) {
                if (wire.net !== netShape.net) {
                    freeNetName(wire.net);
                    wire.net = netShape.net;
                    bumpNetNameCounter(netShape.net);
                    wire.invalidate();
                }
                break;
            }
        }
    }
    app.updatePropertiesPanel?.(app.selection?.getSelection?.() || []);
}

/**
 * Command to add a shape
 */
export class AddShapeCommand extends Command {
    /**
     * @param {SchematicEditor} app
     * @param {Shape} shape - The shape to add
     */
    constructor(app, shape) {
        super(`Add ${shape.type}`);
        this.app = app;
        this.shape = shape;
        this.linkedLabelText = (shape.type === 'wire' || shape.type === 'net')
            ? (shape.labelText || null)
            : null;
    }
    
    /** Add the shape to the canvas. */
    lockTargets() { return []; }
    execute() {
        this.linkedLabelText = this.app.commandAddShape(this.shape, this.linkedLabelText) || this.linkedLabelText;
    }
    
    /** Remove the shape from the canvas. */
    undo() {
        this.linkedLabelText = this.app.commandRemoveShape(this.shape, { preserveLinkedLabelRef: true }) || this.linkedLabelText;
    }
}

/**
 * Command to delete shapes
 */
export class DeleteShapesCommand extends Command {
    /**
     * @param {SchematicEditor} app
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
        const linkedShapeSet = new Set();
        /** @type {ShapeRestoreData[]} */
        this.linkedLabelData = [];

        /** @param {TextShape|null|undefined} labelShape @param {Shape|null} parentShape */
        const pushLinked = (labelShape, parentShape) => {
            if (!labelShape || explicitShapes.has(labelShape) || linkedShapeSet.has(labelShape)) return;
            linkedShapeSet.add(labelShape);
            this.linkedLabelData.push({
                shape: labelShape,
                index: indexMap.get(labelShape) ?? -1,
                parentWire: parentShape
            });
        };

        for (const data of this.shapesData) {
            const shape = data.shape;
            if ((shape.type === 'wire' || shape.type === 'net') && shape.labelText) {
                pushLinked(shape.labelText, shape);
            }
            if (shape.type === 'wire' && shape.attachedLabels instanceof Set) {
                for (const label of shape.attachedLabels) {
                    if (!label || label.type !== 'text' || label.fieldKey !== 'label') continue;
                    if (label.parentComponent !== shape) continue;
                    pushLinked(label, shape);
                }
            }
            if (shape.type !== 'wire' && shape.attachedLabels instanceof Set) {
                for (const label of shape.attachedLabels) {
                    if (!label || label.type !== 'text' || label.fieldKey !== 'label') continue;
                    if (label.parentComponent !== shape) continue;
                    pushLinked(label, null);
                }
            }
        }
    }
    
    /** Remove the shapes from the canvas and deselect them. */
    lockTargets() { return this.shapesData.map(({ shape }) => ({ object: shape })); }
    execute() {
        this.app.commandDeleteShapes(this.shapesData, this.linkedLabelData);
    }
    
    /** Re-insert the shapes at their original z-order positions. */
    undo() {
        this.app.commandRestoreShapes(this.shapesData, this.linkedLabelData);
    }
}

/**
 * Command to move shapes
 */
export class MoveShapesCommand extends Command {
    /**
     * @param {SchematicEditor} app
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
    lockTargets() {
        const items = new Map([...this.app.shapes, ...this.app.components].map(item => [item.id, item]));
        return this.itemIds.map(id => ({ object: items.get(id) }));
    }
    execute() {
        const lookup = this._buildLookup();
        for (const id of this.itemIds) {
            const item = lookup.get(id);
            if (item) {
                item.move(this.dx, this.dy);
                if (item instanceof Component) refreshComponentPose(item);
            }
        }
        this._updateStickyWires();
        this.app.renderShapes(true);
    }
    
    /** Move all items by (-dx, -dy) and update sticky wires. */
    undo() {
        const lookup = this._buildLookup();
        for (const id of this.itemIds) {
            const item = lookup.get(id);
            if (item) {
                item.move(-this.dx, -this.dy);
                if (item instanceof Component) refreshComponentPose(item);
            }
        }
        this._updateStickyWires();
        this.app.renderShapes(true);
    }

    /**
     * Update wire nodes connected to component pins after move/undo.
     * NOTE: Duplicates updateStickyWires() in schematic/modules/wire.js.
     * Kept inline to avoid circular import (wire.js imports from this module).
     */
    _updateStickyWires() {
        // Skip explicitly moved NoConnect shapes so user-intentful drags
        // don't snap back to connected pins.
        applyStickyConnections(this.app, { movedIds: new Set(this.itemIds) });
    }
}

/**
 * Command to modify a shape (e.g., resize via anchor drag)
 */
export class ModifyShapeCommand extends Command {
    /**
     * @param {SchematicEditor} app
     * @param {Shape|Component} shape - The item being modified
     * @param {ShapeState} beforeState - Snapshot of shape state before the edit
     * @param {ShapeState} afterState - Snapshot of shape state after the edit
     */
    constructor(app, shape, beforeState, afterState) {
        super(`Modify ${shape.type}`);
        this.app = app;
        this.shapeId = shape.id;
        this.beforeState = beforeState;
        this.afterState = afterState;
    }
    
    /** Apply the after-state to restore the modification. */
    lockTargets() { return editTargets(undefined, this._findItem(this.shapeId), this.beforeState, this.afterState); }
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
     * @param {ShapeState} state - State object from captureState()
     */
    _applyState(shape, state) {
        const oldRotation = shape.rotation;
        const oldMirror = shape.mirror;
        shape.applyState(state);
        if (shape instanceof Component) {
            const rebuild = (state.rotation !== undefined && state.rotation !== oldRotation)
                || (state.mirror !== undefined && state.mirror !== oldMirror);
            refreshComponentPose(shape, { rebuild });
        }
        // Sync field text changes back to parent component or wire
        if ('text' in state && shape.parentComponent && shape.fieldKey) {
            if ((shape.fieldKey === 'wireLabel' || shape.fieldKey === 'label') && shape.parentComponent.type === 'wire') {
                freeWireLabel(shape.parentComponent.wireLabel);
                shape.parentComponent.wireLabel = shape.text;
                bumpWireLabelCounter(shape.text);
                shape.parentComponent.invalidate();
            } else if (shape.fieldKey === 'net' && shape.parentComponent.type === 'net') {
                const oldName = shape.parentComponent.net;
                shape.parentComponent.net = shape.text;
                shape.parentComponent.syncTextOffsetFromLabelText?.();
                shape.parentComponent.invalidate();
                // Propagate renamed net to all attached wires
                if (oldName !== shape.parentComponent.net) {
                    _propagateNetNameToWires(this.app, shape.parentComponent);
                }
            } else if (shape.fieldKey !== 'label') {
                // Generic attached labels on non-wire shapes are free text with no parent field.
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
     * @param {SchematicEditor} app
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
                    if (item instanceof Component) refreshComponentPose(item, { rebuild: true });
                }
            } else if (this.prop === 'reference') {
                setComponentReference(item, val);
            } else {
                item[this.prop] = val;
            }
            if (typeof item.invalidate === 'function') item.invalidate();
            // Sync field text changes back to parent component
            if (this.prop === 'text' && item.parentComponent && item.fieldKey) {
                if (item.fieldKey === 'net' && item.parentComponent.type === 'net') {
                    item.parentComponent.net = val;
                    item.parentComponent.syncTextOffsetFromLabelText?.();
                    item.parentComponent.invalidate();
                } else if ((item.fieldKey === 'wireLabel' || item.fieldKey === 'label') && item.parentComponent.type === 'wire') {
                    const prev = useNew ? entry.oldValue : entry.newValue;
                    freeWireLabel(prev);
                    item.parentComponent.wireLabel = val;
                    bumpWireLabelCounter(val);
                    item.parentComponent.invalidate();
                } else if (item.fieldKey === 'reference') {
                    setComponentReference(item.parentComponent, val);
                } else if (item.fieldKey !== 'label') {
                    item.parentComponent[item.fieldKey] = val;
                }
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
            // Sync net property edits through the net allocation system
            if (this.prop === 'net' && item.type === 'wire') {
                const oldNet = useNew ? entry.oldValue : entry.newValue;
                const newNet = useNew ? entry.newValue : entry.oldValue;
                if (oldNet) freeNetName(oldNet);
                if (newNet) bumpNetNameCounter(newNet);
            }
            if (item.type === 'net' && ['net', 'fontSize', 'style', 'orientation', 'border'].includes(this.prop)) {
                if (typeof item.syncTextOffsetFromLabelText === 'function') {
                    item.syncTextOffsetFromLabelText();
                }
                if (typeof item.syncLabelText === 'function') {
                    item.syncLabelText();
                }
            }
            // Sync component reference/value to field text content
            if (this.prop === 'reference' && item.refText) {
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
    /** Lock changes are how locks are lifted; net renames follow connectivity. */
    lockTargets() {
        if (this.prop === 'locked' || this.prop === 'net') return [];
        const items = new Map([...this.app.shapes, ...this.app.components].map(item => [item.id, item]));
        return this.entries.map(({ id }) => ({ object: items.get(id) }));
    }
    execute() { this._applyValues(true); }
    /** Restore the old property values. */
    undo() { this._applyValues(false); }
}

/**
 * Command to delete components
 */
export class DeleteComponentsCommand extends Command {
    /**
     * @param {SchematicEditor} app
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
        const shapeIndexMap = new Map();
        for (let i = 0; i < app.shapes.length; i++) {
            shapeIndexMap.set(app.shapes[i], i);
        }
        const attachedSet = new Set();
        this.attachedLabelData = [];
        for (const data of this.componentsData) {
            const comp = data.component;
            if (!(comp?.attachedLabels instanceof Set)) continue;
            for (const label of comp.attachedLabels) {
                if (!label || label.type !== 'text' || label.fieldKey !== 'label') continue;
                if (label.parentComponent !== comp) continue;
                if (attachedSet.has(label)) continue;
                attachedSet.add(label);
                this.attachedLabelData.push({
                    shape: label,
                    index: shapeIndexMap.get(label) ?? -1
                });
            }
        }
    }

    /** Remove the components and their field texts from the canvas. */
    lockTargets() { return this.componentsData.map(({ component }) => ({ object: component })); }
    execute() {
        const app = this.app;
        // Collect all items to remove
        const compsToRemove = new Set(this.componentsData.map(d => d.component));
        const ftsToRemove = new Set();
        const attachedToRemove = new Set(this.attachedLabelData.map(d => d.shape));
        withContentDetached(app, () => {
            for (const data of this.componentsData) {
                const comp = data.component;
                app.selection.dropHover(comp);
                unmountComponent(comp);
                for (const ft of comp.getFieldTexts()) {
                    ftsToRemove.add(ft);
                    app.selection.dropHover(ft);
                    unmountShape(ft);
                }
            }
            for (const label of attachedToRemove) {
                app.selection.dropHover(label);
                unmountShape(label);
            }
        });
        // In-place filter components: O(N) instead of O(N²)
        let writeIdx = 0;
        for (let i = 0; i < app.components.length; i++) {
            if (!compsToRemove.has(app.components[i])) {
                app.components[writeIdx++] = app.components[i];
            }
        }
        app.components.length = writeIdx;
        // In-place filter field texts from shapes: O(N)
        if (ftsToRemove.size > 0 || attachedToRemove.size > 0) {
            writeIdx = 0;
            for (let i = 0; i < app.shapes.length; i++) {
                if (!ftsToRemove.has(app.shapes[i]) && !attachedToRemove.has(app.shapes[i])) {
                    app.shapes[writeIdx++] = app.shapes[i];
                }
            }
            app.shapes.length = writeIdx;
        }
        // Drop wire→pin connection records for the removed components so their
        // on-canvas connection dots disappear (and can be restored on undo).
        const removedIds = new Set();
        for (const c of compsToRemove) removedIds.add(c.id);
        /** @type {RemovedPinConnection[]|null} */
        this._removedPinConnections = [];
        const dirtyWires = new Set();
        for (const shape of app.shapes) {
            if (shape.type !== 'wire' || shape.pinConnections.size === 0) continue;
            for (const [nodeId, conn] of shape.pinConnections) {
                if (removedIds.has(conn.componentId)) {
                    this._removedPinConnections.push({ wire: shape, nodeId, conn });
                    shape.pinConnections.delete(nodeId);
                    dirtyWires.add(shape);
                }
            }
        }
        for (const wire of dirtyWires) redrawShape(app, wire);
        app.updateSelectableItems();
        app.fileManager.setDirty(true);
    }

    /** Re-insert the components at their original positions and restore field texts. */
    undo() {
        const app = this.app;
        const sorted = [...this.componentsData].sort((a, b) => a.index - b.index);
        const shapeSet = new Set(app.shapes);
        for (const data of sorted) {
            const comp = data.component;
            app.selection.dropHover(comp);
            const idx = Math.min(data.index, app.components.length);
            app.components.splice(idx, 0, comp);
            mountComponent(app, comp);
            for (const ft of comp.getFieldTexts()) {
                if (!shapeSet.has(ft)) {
                    app.shapes.push(ft);
                    shapeSet.add(ft);
                    mountShape(app, ft);
                }
            }
        }
        const labelSorted = [...this.attachedLabelData].sort((a, b) => a.index - b.index);
        for (const data of labelSorted) {
            const label = data.shape;
            if (shapeSet.has(label)) continue;
            const idx = data.index >= 0 ? Math.min(data.index, app.shapes.length) : app.shapes.length;
            app.shapes.splice(idx, 0, label);
            shapeSet.add(label);
            mountShape(app, label);
        }
        // Restore wire→pin connection records (and their dots) removed on execute.
        if (this._removedPinConnections?.length) {
            const dirtyWires = new Set();
            for (const { wire, nodeId, conn } of this._removedPinConnections) {
                wire.pinConnections.set(nodeId, conn);
                dirtyWires.add(wire);
            }
            for (const wire of dirtyWires) redrawShape(app, wire);
        }
        this._removedPinConnections = null;
        app.updateSelectableItems();
        app.fileManager.setDirty(true);
    }
}

/**
 * Command to add a component
 */
export class AddComponentCommand extends Command {
    /**
     * @param {SchematicEditor} app
     * @param {Component} component - The component to add
     */
    constructor(app, component) {
        super(`Add ${component.reference || 'component'}`);
        this.app = app;
        this.component = component;
    }

    /** Add the component and its field texts to the canvas. */
    lockTargets() { return []; }
    execute() {
        // On first execute, snapshot wire states before placement so undo can restore them
        if (!this._wireStatesBeforePlace) {
            this._wireStatesBeforePlace = new Map();
            const comp = this.component;
            if (comp.symbol?.pins) {
                for (const wire of this.app.shapes) {
                    if (wire.type !== 'wire') continue;
                    for (const pin of comp.symbol.pins) {
                        const pinPos = comp.getPinPosition?.(pin.number);
                        if (!pinPos) continue;
                        let touchesWire = false;
                        for (const [, nodePos] of wire.nodes) {
                            if (Math.hypot(nodePos.x - pinPos.x, nodePos.y - pinPos.y) < PIN_ATTACH_TOL) {
                                touchesWire = true;
                                break;
                            }
                        }
                        if (!touchesWire && typeof wire.closestEdge === 'function') {
                            const edge = wire.closestEdge(pinPos);
                            if (edge && edge.distance < PIN_ATTACH_TOL) touchesWire = true;
                        }
                        if (touchesWire && !this._wireStatesBeforePlace.has(wire.id)) {
                            this._wireStatesBeforePlace.set(wire.id, wire.captureState());
                        }
                    }
                }
            }
        }

        this.app.components.push(this.component);
        mountComponent(this.app, this.component);
        // Create field texts if they don't exist yet
        if (!this.component.refText && !this.component.valueText) {
            for (const ft of this.component.createFieldTexts(this.app)) mountShape(this.app, ft);
        } else {
            // Re-add existing field texts
            for (const ft of this.component.getFieldTexts()) {
                if (!this.app.shapes.includes(ft)) {
                    this.app.shapes.push(ft);
                    mountShape(this.app, ft);
                }
            }
        }

        // Symmetric with drag/drop behavior: if a pin lands on a wire segment,
        // split that segment to create an anchor and connect immediately.
        connectComponentPinsToWires(this.app, this.component, {
            connectPinConnections: true,
            tolerance: PIN_ATTACH_TOL
        });

        this.app.updateSelectableItems();
        this.app.fileManager.setDirty(true);
    }

    /** Remove the component and its field texts from the canvas. */
    undo() {
        // Save wire states before removal so we can detect which wires
        // had pinConnections to this component and restore their geometry
        const compId = this.component.id;
        const affectedWireStates = new Map();
        for (const shape of this.app.shapes) {
            if (shape.type !== 'wire') continue;
            for (const [, conn] of shape.pinConnections) {
                if (conn.componentId === compId) {
                    // This wire is connected - save its state if we haven't already
                    if (!affectedWireStates.has(shape.id) && !this._wireStatesBeforePlace) {
                        affectedWireStates.set(shape.id, shape.captureState());
                    }
                    break;
                }
            }
        }

        const idx = this.app.components.indexOf(this.component);
        if (idx !== -1) {
            this.app.components.splice(idx, 1);
        }
        unmountComponent(this.component);
        // Remove field texts
        const ftsToRemove = new Set();
        for (const ft of this.component.getFieldTexts()) {
            ftsToRemove.add(ft);
            unmountShape(ft);
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
        // Clean up wire pinConnections referencing this removed component
        // and restore wire geometry to pre-placement state if saved
        for (const shape of this.app.shapes) {
            if (shape.type !== 'wire') continue;
            for (const [nodeId, conn] of shape.pinConnections) {
                if (conn.componentId === compId) {
                    shape.pinConnections.delete(nodeId);
                }
            }
        }
        // Restore wire states from before the component was ever placed
        if (this._wireStatesBeforePlace) {
            for (const [wireId, state] of this._wireStatesBeforePlace) {
                const wire = this.app.shapes.find(s => s.id === wireId);
                if (wire?.type === 'wire') {
                    wire.applyState(state);
                }
            }
        }
        this.app.updateSelectableItems();
        this.app.fileManager.setDirty(true);
    }
}

/**
 * Command to transform a component (rotate/flip)
 */
export class TransformComponentCommand extends Command {
    /**
     * @param {SchematicEditor} app
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
            // Rotation and mirror are baked into the symbol, so every transform pass rebuilds it.
            refreshComponentPose(comp, { rebuild: true });
        }
        this._updateStickyWires();
        this.app.renderShapes(true);
    }

    /** Perform the transform. */
    lockTargets() {
        const items = new Map([...this.app.shapes, ...this.app.components].map(item => [item.id, item]));
        return this.entries.map(({ id }) => ({ object: items.get(id) }));
    }
    execute() { this._apply(false); }
    /** Reverse the transform by restoring captured state. */
    undo() { this._apply(true); }

    /**
     * Update wire nodes connected to component pins after transform.
     * NOTE: Duplicates updateStickyWires() in schematic/modules/wire.js and
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
     * @param {SchematicEditor} app
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
    lockTargets() { return []; }
    execute() {
        const app = this.app;
        // Build a Set for O(1) membership checks on field texts
        const shapeSet = new Set(app.shapes);
        // Bulk-add shapes without per-item updateSelectableItems
        for (const shape of this.shapes) {
            app.shapes.push(shape);
            mountShape(app, shape);
            shapeSet.add(shape);
        }
        // Bulk-add components
        for (const comp of this.components) {
            app.components.push(comp);
            mountComponent(app, comp);
            if (!comp.refText && !comp.valueText) {
                for (const ft of comp.createFieldTexts(app)) mountShape(app, ft);
            } else {
                for (const ft of comp.getFieldTexts()) {
                    if (!shapeSet.has(ft)) {
                        app.shapes.push(ft);
                        shapeSet.add(ft);
                        mountShape(app, ft);
                    }
                }
            }
        }
        app.updateSelectableItems();
        app.selection.invalidateHitCache();
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
            unmountComponent(comp);
            for (const ft of comp.getFieldTexts()) {
                ftsToRemove.add(ft);
                unmountShape(ft);
                app.selection.dropSelected(ft);
            }
            app.selection.dropSelected(comp);
        }
        // Remove shape DOM
        for (const shape of this.shapes) {
            unmountShape(shape);
            app.selection.dropSelected(shape);
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
        app.selection.invalidateHitCache();
        app.selection.notifyChanged();
        app.updateSelectableItems();
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
        /** @type {HistoryCommand[]} */
        this.commands = [];
    }

    /**
     * Append a sub-command to the batch.
     * @param {HistoryCommand} command
     */
    add(command) {
        this.commands.push(command);
    }

    /** Execute all sub-commands in order. */
    /** A batch is checked through its child commands. */
    lockTargets() { return []; }
    execute() {
        for (const cmd of this.commands) cmd.execute();
    }

    /** Undo all sub-commands in reverse order. */
    undo() {
        for (let i = this.commands.length - 1; i >= 0; i--) this.commands[i].undo();
    }
}