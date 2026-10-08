import { AddShapeCommand } from './commands.js';
import { freeWireLabel, bumpWireLabelCounter, freeNetName, bumpNetNameCounter, nextNetName } from '../../shapes/wire.js';
import { Text } from '../../shapes/text.js';
import { detachLabel } from './label-attachment.js';
import { VERTEX_EPSILON } from './wire.js';
import { connectComponentPinsToWires as _connectComponentPinsToWires, connectPinsToWires } from './pin-wire-connect.js';
import { ensureShapeMounted, mountShape, unmountShape, withContentDetached } from './schematic-view.js';
/** @typedef {import('./schematic-editor-api.js').SchematicEditor} SchematicEditor */
/** @typedef {import('../../core/SchematicDocument.js').SchematicShape} Net */

/**
 * Adds a shape to the canvas via an undoable `AddShapeCommand`.
 * @param {SchematicEditor} app
 * @param {import('../../core/SchematicDocument.js').SchematicShape} shape - Shape to add.
 * @returns {import('../../core/SchematicDocument.js').SchematicShape} The added shape.
 */
export function addShape(app, shape) {
    const command = new AddShapeCommand(app, shape);
    app.history.execute(command);
    return shape;
}

/**
 * Directly adds a shape (no undo) — pushes to `app.shapes`, renders,
 * adds SVG element, updates selectable items, and marks dirty.
 * @param {SchematicEditor} app
 * @param {import('../../core/SchematicDocument.js').SchematicShape} shape - Shape to add.
 * @returns {import('../../core/SchematicDocument.js').SchematicShape} The added shape.
 */
export function addShapeInternal(app, shape) {
    app.shapes.push(shape);
    mountShape(app, shape);
    const wireShape = shape.type === 'wire' ? /** @type {import('../../shapes/wire.js').Wire} */ (shape) : null;
    const netShape = shape.type === 'net' ? /** @type {import('../../shapes/net.js').Net} */ (shape) : null;
    if (wireShape?.wireLabel) bumpWireLabelCounter(wireShape.wireLabel);
    // Wire names are no longer materialized as dedicated wireLabel Text shapes.
    // Generic attached labels (fieldKey === 'label') are used instead.
    if (netShape && !netShape.labelText) {
        _createNetText(app, netShape);
    }
    // When a Net label is placed on a wire, record the connection and propagate the net name
    if (netShape) {
        _connectNetToWires(app, netShape);
    }
    app.updateSelectableItems();
    app.selection.invalidateHitCache();
    app.fileManager.setDirty(true);
    return shape;
}

/**
 * Command-layer shape add hook to keep AddShapeCommand decoupled from
 * direct shape-array/DOM bookkeeping details.
 * @param {SchematicEditor} app
 * @param {import('../../core/SchematicDocument.js').SchematicShape} shape
 * @param {import('../../shapes/text.js').Text|null} [linkedLabelText]
 * @returns {import('../../shapes/text.js').Text|null}
 */
export function commandAddShapeInternal(app, shape, linkedLabelText = null) {
    const wireShape = shape.type === 'wire' ? /** @type {import('../../shapes/wire.js').Wire} */ (shape) : null;
    const netShape = shape.type === 'net' ? /** @type {import('../../shapes/net.js').Net} */ (shape) : null;

    if (wireShape && linkedLabelText && !wireShape.labelText) {
        wireShape.labelText = linkedLabelText;
    }
    if (netShape && linkedLabelText && !netShape.labelText) {
        netShape.labelText = linkedLabelText;
    }

    addShapeInternal(app, shape);

    const parentShape = wireShape || netShape;
    if (!parentShape) return null;

    const labelText = parentShape.labelText || linkedLabelText;
    if (!labelText) return null;

    parentShape.labelText = labelText;
    labelText.parentComponent = parentShape;
    if (!labelText.fieldKey) {
        labelText.fieldKey = parentShape.type === 'wire' ? 'wireLabel' : 'net';
    }

    if (!app.shapes.includes(labelText)) {
        app.shapes.push(labelText);
    }
    ensureShapeMounted(app, labelText);

    app.updateSelectableItems();
    app.selection.invalidateHitCache();
    return labelText;
}

/**
 * Like `addShapeInternal` but inserts at a specific index in the shapes array
 * (used for undo re-insertion at original position).
 * @param {SchematicEditor} app
 * @param {import('../../core/SchematicDocument.js').SchematicShape} shape - Shape to insert.
 * @param {number} index - Array index at which to insert.
 * @returns {import('../../core/SchematicDocument.js').SchematicShape} The inserted shape.
 */
export function addShapeInternalAt(app, shape, index) {
    if (index >= 0 && index < app.shapes.length) {
        app.shapes.splice(index, 0, shape);
    } else {
        app.shapes.push(shape);
    }
    mountShape(app, shape);
    const wireShape = shape.type === 'wire' ? /** @type {import('../../shapes/wire.js').Wire} */ (shape) : null;
    if (wireShape?.wireLabel) bumpWireLabelCounter(wireShape.wireLabel);
    app.updateSelectableItems();
    app.fileManager.setDirty(true);
    return shape;
}

/**
 * Directly removes a shape (no undo) — splices from array, removes SVG elements,
 * deselects, invalidates hit-test cache, and marks dirty.
 * @param {SchematicEditor} app
 * @param {import('../../core/SchematicDocument.js').SchematicShape} shape - Shape to remove (text fields carry fieldKey/parentComponent).
 * @param {{ preserveWireLabelRef?: boolean, preserveLinkedLabelRef?: boolean }} [options] - Optional remove behavior.
 */
export function removeShapeInternal(app, shape, options = {}) {
    const { preserveWireLabelRef = false, preserveLinkedLabelRef = preserveWireLabelRef } = options;
    if (shape?.type === 'text' && shape.fieldKey === 'label' && shape.parentComponent) {
        detachLabel(shape);
    }
    const idx = app.shapes.indexOf(shape);
    if (idx !== -1) {
        app.shapes.splice(idx, 1);
        const wireShape = shape.type === 'wire' ? /** @type {import('../../shapes/wire.js').Wire} */ (shape) : null;
        const netShape = shape.type === 'net' ? /** @type {import('../../shapes/net.js').Net} */ (shape) : null;
        if (wireShape?.wireLabel) freeWireLabel(wireShape.wireLabel);
        if (wireShape?.net) freeNetName(wireShape.net);

        // Remove generic attached label Text shapes owned by this wire
        const attachedLabels = wireShape?.attachedLabels instanceof Set
            ? Array.from(wireShape.attachedLabels).filter(label =>
                label?.type === 'text'
                && label.fieldKey === 'label'
                && label.parentComponent === wireShape
            )
            : [];
        for (const label of attachedLabels) {
            removeShapeInternal(app, label, options);
        }
        if (wireShape && attachedLabels.length > 0) {
            delete (/** @type {{attachedLabels?: Set<any>|null}} */ (wireShape)).attachedLabels;
        }

        // Also remove the linked label Text shape
        const linkedLabel = wireShape?.labelText || netShape?.labelText || null;
        if (linkedLabel) {
            removeShapeInternal(app, linkedLabel, options);
            if (wireShape) wireShape.labelText = preserveLinkedLabelRef ? linkedLabel : null;
            if (netShape) netShape.labelText = preserveLinkedLabelRef ? linkedLabel : null;
        }
        // When a Net label is removed, clean up wire pinConnections and revert net names
        if (netShape) {
            _disconnectNetFromWires(app, netShape);
        }
        unmountShape(shape);
        app.selection.deselect(shape);
        app.selection.invalidateHitCache();
        app.updateSelectableItems();
        app.fileManager.setDirty(true);
    }
}

/**
 * Command-layer shape remove hook to preserve wire/label linkage metadata.
 * @param {SchematicEditor} app
 * @param {import('../../core/SchematicDocument.js').SchematicShape} shape
 * @param {{ preserveWireLabelRef?: boolean }} [options]
 * @returns {import('../../shapes/text.js').Text|null}
 */
export function commandRemoveShapeInternal(app, shape, options = {}) {
    const wireShape = shape.type === 'wire' ? /** @type {import('../../shapes/wire.js').Wire} */ (shape) : null;
    const netShape = shape.type === 'net' ? /** @type {import('../../shapes/net.js').Net} */ (shape) : null;
    const linkedLabel = wireShape?.labelText || netShape?.labelText || null;
    removeShapeInternal(app, shape, options);
    if ((wireShape || netShape) && linkedLabel) {
        if (wireShape) wireShape.labelText = linkedLabel;
        if (netShape) netShape.labelText = linkedLabel;
        linkedLabel.parentComponent = wireShape || netShape;
    }
    return linkedLabel;
}

/**
 * Command-layer batch delete hook to isolate shape-array/DOM internals.
 * @param {SchematicEditor} app
 * @param {Array<{shape: import('../../core/SchematicDocument.js').SchematicShape, index: number}>} shapesData
 * @param {Array<{shape: import('../../core/SchematicDocument.js').SchematicShape, index: number, parentWire: import('../../core/SchematicDocument.js').SchematicShape|null}>} linkedLabelData
 */
export function commandDeleteShapesInternal(app, shapesData, linkedLabelData) {
    const allData = [...shapesData, ...linkedLabelData];
    const toRemove = new Set(allData.map(d => d.shape));

    let writeIdx = 0;
    for (let i = 0; i < app.shapes.length; i++) {
        if (!toRemove.has(app.shapes[i])) {
            app.shapes[writeIdx++] = app.shapes[i];
        }
    }
    app.shapes.length = writeIdx;

    for (const data of shapesData) {
        const shape = data.shape;
        const wireShape = shape.type === 'wire' ? /** @type {import('../../shapes/wire.js').Wire} */ (shape) : null;
        if (wireShape?.wireLabel) freeWireLabel(wireShape.wireLabel);
        if (wireShape?.net) freeNetName(wireShape.net);
    }

    withContentDetached(app, () => {
        for (const { shape } of allData) {
            unmountShape(shape);
            app.selection.forget(shape);
        }
    });

    app.selection.invalidateHitCache();
    app.updateSelectableItems();
    app.fileManager.setDirty(true);
}

/**
 * Command-layer batch restore hook to isolate shape-array/DOM internals.
 * @param {SchematicEditor} app
 * @param {Array<{shape: import('../../core/SchematicDocument.js').SchematicShape, index: number}>} shapesData
 * @param {Array<{shape: import('../../core/SchematicDocument.js').SchematicShape, index: number, parentWire: import('../../core/SchematicDocument.js').SchematicShape|null}>} linkedLabelData
 */
export function commandRestoreShapesInternal(app, shapesData, linkedLabelData) {
    const allData = [...shapesData, ...linkedLabelData];
    withContentDetached(app, () => {
        for (const { shape } of allData) {
            app.selection.dropHover(shape);
            mountShape(app, shape);
        }
    });

    const sorted = [...allData].sort((a, b) => a.index - b.index);
    for (const data of sorted) {
        if (app.shapes.includes(data.shape)) continue;
        const idx = data.index >= 0 ? Math.min(data.index, app.shapes.length) : app.shapes.length;
        app.shapes.splice(idx, 0, data.shape);
        const wireShape = data.shape.type === 'wire' ? /** @type {import('../../shapes/wire.js').Wire} */ (data.shape) : null;
        if (wireShape?.wireLabel) bumpWireLabelCounter(wireShape.wireLabel);
        if (wireShape?.net) bumpNetNameCounter(wireShape.net);
    }

    for (const linked of linkedLabelData) {
        if ((linked.shape?.fieldKey === 'wireLabel' || linked.shape?.fieldKey === 'net')
            && linked.parentWire
            && linked.parentWire.labelText !== linked.shape) {
            linked.parentWire.labelText = linked.shape;
        }
    }

    app.updateSelectableItems();
    app.selection.invalidateHitCache();
    app.fileManager.setDirty(true);
}

/**
 * Creates a Text shape for a Net's text, adds it to app.shapes and
 * viewport, and links it via parentComponent/fieldKey.
 * @param {SchematicEditor} app
 * @param {import('../../core/SchematicDocument.js').SchematicShape} Net
 */
function _createNetText(app, Net) {
    const pos = Net.getTextPosition();
    const anchor = (Net.style === 'chevron') ? 'start' : 'middle';
    const text = new Text(/** @type {any} */ ({
        x: pos.x,
        y: pos.y,
        text: Net.net,
        fontSize: Net.fontSize,
        fontFamily: 'Arial',
        textAnchor: anchor,
        color: 'var(--sch-text-label, #00b894)',
        border: Net.border
    }));
    text.parentComponent = Net;
    text.fieldKey = 'net';
    text.visible = Net.visible;
    Net.labelText = text;

    app.shapes.push(text);
    mountShape(app, text);
}

export { _createNetText as createNetText };
export { _connectNetToWires as connectNetToWires };
export { _disconnectNetFromWires as disconnectNetFromWires };

/**
 * Ensure each component pin that lands on a wire segment creates a node
 * (split edge) so connectivity can be established by refreshWireConnections.
 * Mirrors the Net label mid-segment split behavior.
 *
 * @param {SchematicEditor} app
 * @param {import('../../core/SchematicDocument.js').SchematicShape} component
 */
export function connectComponentPinsToWires(app, component) {
    _connectComponentPinsToWires(app, component, {
        connectPinConnections: false,
        tolerance: VERTEX_EPSILON
    });
}

/**
 * When a Net shape is placed on a wire, record the connection
 * via the wire's pinConnections (reusing the component pin system)
 * and propagate the net name.
 * @param {SchematicEditor} app
 * @param {Net} netShape
 */
function _connectNetToWires(app, netShape) {
    connectPinsToWires(app, [{ x: netShape.x, y: netShape.y, pinNumber: 'conn' }], {
        ownerId: netShape.id,
        connectPinConnections: true,
        tolerance: VERTEX_EPSILON,
        onConnectedWire: (wire) => {
            const wireShape = /** @type {import('../../shapes/wire.js').Wire} */ (wire);
            const netName = netShape.net;
            if (netName && wireShape.net !== netName) {
                freeNetName(wireShape.net);
                wireShape.net = netName;
                bumpNetNameCounter(netName);
            }
        }
    });
    app.updatePropertiesPanel(app.selection?.getSelection?.() || []);
}

/**
 * When a Net shape is deleted, remove its entries from wire pinConnections
 * and revert wire net names if no other same-named Net is still connected.
 * @param {SchematicEditor} app
 * @param {Net} netShape
 */
function _disconnectNetFromWires(app, netShape) {
    const removedName = netShape.net;
    for (const wire of app.shapes) {
        if (wire.type !== 'wire') continue;
        let found = false;
        for (const [nodeId, conn] of wire.pinConnections) {
            if (conn.componentId === netShape.id) {
                wire.pinConnections.delete(nodeId);
                found = true;
            }
        }
        if (found && removedName && wire.net === removedName) {
            // Check if any other Net with the same name is still on this wire
            let otherSameNet = false;
            for (const [, conn] of wire.pinConnections) {
                const other = app.shapes.find(s => s.id === conn.componentId && s.type === 'net');
                if (other && other.net === removedName) { otherSameNet = true; break; }
            }
            if (!otherSameNet) {
                freeNetName(wire.net);
                wire.net = nextNetName();
                wire.invalidate();
            }
        }
    }
    app.updatePropertiesPanel(app.selection?.getSelection?.() || []);
}
