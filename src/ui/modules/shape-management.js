import { AddShapeCommand } from '../../core/CommandHistory.js';
import { freeWireLabel, bumpWireLabelCounter } from '../../shapes/wire.js';

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
