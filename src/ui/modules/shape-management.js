import { AddShapeCommand } from '../../core/CommandHistory.js';
import { freeWireLabel, bumpWireLabelCounter, freeNetName, bumpNetNameCounter, nextNetName } from '../../shapes/wire.js';
import { Text } from '../../shapes/text.js';
import { detachLabel, syncAttachedLabels } from './label-attachment.js';
import { VERTEX_EPSILON } from './wire.js';
import { connectComponentPinsToWires as _connectComponentPinsToWires, connectPinsToWires } from './pin-wire-connect.js';

/**
 * Adds a shape to the canvas via an undoable `AddShapeCommand`.
 * @param {object} app - Application state.
 * @param {import('../../shapes/shape.js').Shape} shape - Shape to add.
 * @returns {import('../../shapes/shape.js').Shape} The added shape.
 */
export function addShape(app, shape) {
    const command = new AddShapeCommand(app, shape);
    app.history.execute(command);
    return shape;
}
/** Shape types that render above wires (re-appended at end of each render cycle). */
const OVERLAY_TYPES = new Set(['noconnect', 'net']);

/**
 * Directly adds a shape (no undo) — pushes to `app.shapes`, renders,
 * adds SVG element, updates selectable items, and marks dirty.
 * @param {object} app - Application state.
 * @param {import('../../shapes/shape.js').Shape} shape - Shape to add.
 * @returns {import('../../shapes/shape.js').Shape} The added shape.
 */
export function addShapeInternal(app, shape) {
    app.shapes.push(shape);
    shape.render(app.viewport.scale);
    app.viewport.addContent(shape.element);
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
    app._updateSelectableItems();
    app.selection._invalidateHitTestCache();
    app.fileManager.setDirty(true);
    return shape;
}

/**
 * Command-layer shape add hook to keep AddShapeCommand decoupled from
 * direct shape-array/DOM bookkeeping details.
 * @param {object} app
 * @param {import('../../shapes/shape.js').Shape} shape
 * @param {import('../../shapes/text.js').Text|null} [linkedWireLabelText]
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
    if (!labelText.element || !labelText.element.parentNode) {
        labelText.render(app.viewport.scale);
        app.viewport.addContent(labelText.element);
    }

    app._updateSelectableItems();
    app.selection._invalidateHitTestCache();
    return labelText;
}

/**
 * Like `addShapeInternal` but inserts at a specific index in the shapes array
 * (used for undo re-insertion at original position).
 * @param {object} app - Application state.
 * @param {import('../../shapes/shape.js').Shape} shape - Shape to insert.
 * @param {number} index - Array index at which to insert.
 * @returns {import('../../shapes/shape.js').Shape} The inserted shape.
 */
export function addShapeInternalAt(app, shape, index) {
    shape.render(app.viewport.scale);

    if (index >= 0 && index < app.shapes.length) {
        app.shapes.splice(index, 0, shape);
    } else {
        app.shapes.push(shape);
    }
    app.viewport.addContent(shape.element);
    const wireShape = shape.type === 'wire' ? /** @type {import('../../shapes/wire.js').Wire} */ (shape) : null;
    if (wireShape?.wireLabel) bumpWireLabelCounter(wireShape.wireLabel);
    app._updateSelectableItems();
    app.fileManager.setDirty(true);
    return shape;
}

/**
 * Directly removes a shape (no undo) — splices from array, removes SVG elements,
 * deselects, invalidates hit-test cache, and marks dirty.
 * @param {object} app - Application state.
 * @param {import('../../shapes/shape.js').Shape} shape - Shape to remove.
 * @param {{ preserveWireLabelRef?: boolean }} [options] - Optional remove behavior.
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
            delete wireShape.attachedLabels;
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
        if (shape.element && shape.element.parentNode) {
            shape.element.parentNode.removeChild(shape.element);
        }
        if (shape.anchorsGroup && shape.anchorsGroup.parentNode) {
            shape.anchorsGroup.parentNode.removeChild(shape.anchorsGroup);
        }
        app.selection.deselect(shape);
        app.selection._invalidateHitTestCache();
        app._updateSelectableItems();
        app.fileManager.setDirty(true);
    }
}

/**
 * Command-layer shape remove hook to preserve wire/label linkage metadata.
 * @param {object} app
 * @param {import('../../shapes/shape.js').Shape} shape
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
 * @param {object} app
 * @param {Array<{shape: import('../../shapes/shape.js').Shape, index: number}>} shapesData
 * @param {Array<{shape: import('../../shapes/shape.js').Shape, index: number, parentWire: import('../../shapes/wire.js').Wire}>} linkedLabelData
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

/**
 * Command-layer batch restore hook to isolate shape-array/DOM internals.
 * @param {object} app
 * @param {Array<{shape: import('../../shapes/shape.js').Shape, index: number}>} shapesData
 * @param {Array<{shape: import('../../shapes/shape.js').Shape, index: number, parentWire: import('../../shapes/wire.js').Wire}>} linkedLabelData
 */
export function commandRestoreShapesInternal(app, shapesData, linkedLabelData) {
    const allData = [...shapesData, ...linkedLabelData];
    const layer = app.viewport.contentLayer;
    const parent = layer.parentNode;
    const nextSib = layer.nextSibling;
    if (parent) parent.removeChild(layer);

    for (const data of allData) {
        data.shape.hovered = false;
        data.shape.render(app.viewport.scale);
        app.viewport.addContent(data.shape.element);
    }

    if (parent) parent.insertBefore(layer, nextSib);

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

    app._updateSelectableItems();
    app.selection._invalidateHitTestCache();
    app.fileManager.setDirty(true);
}

/**
 * Re-renders all visible (non-culled) shapes and components. If `force` is true,
 * invalidates hit-test cache and recalculates stroke widths on zoom.
 * @param {object} app - Application state.
 * @param {boolean} [force=false] - Force full re-render regardless of dirty state.
 */
export function renderShapes(app, force = false) {
    syncAttachedLabels(app);

    if (force && app.selection) {
        app.selection._invalidateHitTestCache();
    }
    const scale = app.viewport.scale;
    for (const shape of app.shapes) {
        if (shape._culled) continue; // skip off-screen
        if (shape._dirty || shape.selected || shape.hovered) {
            shape.render(scale);
        } else if (force || (shape._lastScale !== scale && shape.element)) {
            // Only stroke-width changed on zoom or force — fast-path update
            const sw = shape._getEffectiveStrokeWidth(scale);
            if (sw > 0) shape.element.setAttribute('stroke-width', sw);
            shape._lastScale = scale;
        }
    }
    
    // Only render components that actually need visual updates
    for (const comp of app.components) {
        if (comp._culled) continue; // skip off-screen
        if (comp.selected || comp.hovered || comp.locked) {
            comp.render(scale);
        }
    }

    // Ensure overlay-type shapes (noconnect, Net) render above wires.
    // Selected-shape rendering calls appendChild() which can move wire SVG
    // elements past overlay shapes. Re-append overlay shape elements (and
    // their anchor groups) as the last children of contentLayer so they
    // always paint on top.  Skip when shapes are selected so anchor
    // handles remain accessible during editing.
    if (!app.selection?.selected?.size) {
        const cl = app.viewport.contentLayer;
        for (const shape of app.shapes) {
            if (shape._culled || !shape.element) continue;
            if (OVERLAY_TYPES.has(shape.type)) {
                cl.appendChild(shape.element);
                if (shape.anchorsGroup && shape.anchorsGroup.parentNode) {
                    cl.appendChild(shape.anchorsGroup);
                }
            }
        }
    }
}

/**
 * Viewport culling — hide/show shapes & components based on whether they
 * intersect the visible viewport.  Uses a generous margin so elements
 * don't pop in during fast panning.
 */
export function updateViewportCulling(app) {
    const bounds = app.viewport.getVisibleBounds();
    const w = bounds.maxX - bounds.minX;
    const h = bounds.maxY - bounds.minY;
    const margin = Math.max(w, h) * 0.5; // 50 % overdraw

    const minX = bounds.minX - margin;
    const maxX = bounds.maxX + margin;
    const minY = bounds.minY - margin;
    const maxY = bounds.maxY + margin;
    const scale = app.viewport.scale;

    for (const shape of app.shapes) {
        const b = shape.getBounds();
        const inView = b.maxX >= minX && b.minX <= maxX &&
                       b.maxY >= minY && b.minY <= maxY;

        if (inView && shape._culled) {
            // scrolled into view — un-cull and re-render
            shape._culled = false;
            if (shape.element) shape.element.classList.remove('culled');
            if (shape.anchorsGroup) shape.anchorsGroup.classList.remove('culled');
            shape.render(scale);
        } else if (!inView && !shape._culled) {
            // scrolled out of view — cull
            shape._culled = true;
            if (shape.element) shape.element.classList.add('culled');
            if (shape.anchorsGroup) shape.anchorsGroup.classList.add('culled');
        }
    }

    for (const comp of app.components) {
        const b = comp.getBounds();
        if (!b) continue;
        const inView = b.maxX >= minX && b.minX <= maxX &&
                       b.maxY >= minY && b.minY <= maxY;

        if (inView && comp._culled) {
            comp._culled = false;
            if (comp.element) comp.element.classList.remove('culled');
            comp.render(scale);
        } else if (!inView && !comp._culled) {
            comp._culled = true;
            if (comp.element) comp.element.classList.add('culled');
        }
    }
}

/**
 * Creates a Text shape for a Net's text, adds it to app.shapes and
 * viewport, and links it via parentComponent/fieldKey.
 * @param {object} app
 * @param {import('../../shapes/net.js').Net} Net
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
        color: 'var(--sch-net-label, #00cccc)'
    }));
    text.parentComponent = Net;
    text.fieldKey = 'net';
    text.visible = Net.visible;
    Net.labelText = text;

    app.shapes.push(text);
    text.render(app.viewport.scale);
    app.viewport.addContent(text.element);
}

export { _createNetText as createNetText };
export { _connectNetToWires as connectNetToWires };
export { _disconnectNetFromWires as disconnectNetFromWires };

/**
 * Ensure each component pin that lands on a wire segment creates a node
 * (split edge) so connectivity can be established by refreshWireConnections.
 * Mirrors the Net label mid-segment split behavior.
 *
 * @param {object} app
 * @param {object} component
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
 */
function _connectNetToWires(app, netShape) {
    connectPinsToWires(app, [{ x: netShape.x, y: netShape.y, pinNumber: 'conn' }], {
        ownerId: netShape.id,
        connectPinConnections: true,
        tolerance: VERTEX_EPSILON,
        onConnectedWire: (wire) => {
            const netName = netShape.net;
            if (netName && wire.net !== netName) {
                freeNetName(wire.net);
                wire.net = netName;
                bumpNetNameCounter(netName);
            }
        }
    });
    app._updatePropertiesPanel?.(app.selection?.getSelection?.() || []);
}

/**
 * When a Net shape is deleted, remove its entries from wire pinConnections
 * and revert wire net names if no other same-named Net is still connected.
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
    app._updatePropertiesPanel?.(app.selection?.getSelection?.() || []);
}
