import { AddShapeCommand } from '../../core/CommandHistory.js';
import { freeWireLabel, bumpWireLabelCounter } from '../../shapes/wire.js';
import { Text } from '../../shapes/text.js';

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
const OVERLAY_TYPES = new Set(['noconnect', 'netlabel']);

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
    if (shape.type === 'wire' && shape.wireLabel) bumpWireLabelCounter(shape.wireLabel);
    // Auto-create label Text shape for new wires (like Component.createFieldTexts)
    if (shape.type === 'wire' && !shape.labelText) {
        _createWireLabelText(app, shape);
    }
    app._updateSelectableItems();
    app.selection._invalidateHitTestCache();
    app.fileManager.setDirty(true);
    return shape;
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
    if (shape.type === 'wire' && shape.wireLabel) bumpWireLabelCounter(shape.wireLabel);
    app._updateSelectableItems();
    app.fileManager.setDirty(true);
    return shape;
}

/**
 * Directly removes a shape (no undo) — splices from array, removes SVG elements,
 * deselects, invalidates hit-test cache, and marks dirty.
 * @param {object} app - Application state.
 * @param {import('../../shapes/shape.js').Shape} shape - Shape to remove.
 */
export function removeShapeInternal(app, shape) {
    const idx = app.shapes.indexOf(shape);
    if (idx !== -1) {
        app.shapes.splice(idx, 1);
        if (shape.type === 'wire' && shape.wireLabel) freeWireLabel(shape.wireLabel);
        // Also remove the linked label Text shape
        if (shape.type === 'wire' && shape.labelText) {
            removeShapeInternal(app, shape.labelText);
            shape.labelText = null;
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
 * Re-renders all visible (non-culled) shapes and components. If `force` is true,
 * invalidates hit-test cache and recalculates stroke widths on zoom.
 * @param {object} app - Application state.
 * @param {boolean} [force=false] - Force full re-render regardless of dirty state.
 */
export function renderShapes(app, force = false) {
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

    // Ensure overlay-type shapes (noconnect, netlabel) render above wires.
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

// ─── Wire label Text helper ──────────────────────────────────────

/** Wire label font size (mm) — matches WIRE_LABEL_FONT_SIZE in wire.js. */
const WIRE_LABEL_FONT_SIZE = 1.4;

/**
 * Creates a Text shape for a wire's label, adds it to app.shapes and
 * the viewport, and links it to the wire via parentComponent/fieldKey.
 * Follows the same pattern as Component.createFieldTexts.
 * @param {object} app
 * @param {import('../../shapes/wire.js').Wire} wire
 */
function _createWireLabelText(app, wire) {
    const pos = wire.getLabelPosition();
    const text = new Text({
        x: pos.x,
        y: pos.y,
        text: wire.wireLabel,
        fontSize: WIRE_LABEL_FONT_SIZE,
        fontFamily: 'Arial',
        textAnchor: 'middle',
        color: 'var(--sch-wire-label, #669966)'
    });
    text.parentComponent = wire;
    text.fieldKey = 'wireLabel';
    text.visible = wire.showLabel;
    wire.labelText = text;

    app.shapes.push(text);
    text.render(app.viewport.scale);
    app.viewport.addContent(text.element);
}

/**
 * Exported helper so files.js can create label texts for wires loaded
 * from file that don't already have one.
 */
export { _createWireLabelText as createWireLabelText };
