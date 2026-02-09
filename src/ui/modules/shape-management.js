import { AddShapeCommand } from '../../core/CommandHistory.js';

export function addShape(app, shape) {
    const command = new AddShapeCommand(app, shape);
    app.history.execute(command);
    return shape;
}

export function addShapeInternal(app, shape) {
    app.shapes.push(shape);
    shape.render(app.viewport.scale);
    app.viewport.addContent(shape.element);
    app._updateSelectableItems();
    app.selection._invalidateHitTestCache();
    app.fileManager.setDirty(true);
    return shape;
}

export function addShapeInternalAt(app, shape, index) {
    shape.render(app.viewport.scale);

    if (index >= 0 && index < app.shapes.length) {
        app.shapes.splice(index, 0, shape);
    } else {
        app.shapes.push(shape);
    }
    app.viewport.addContent(shape.element);
    app._updateSelectableItems();
    app.fileManager.setDirty(true);
    return shape;
}

export function removeShapeInternal(app, shape) {
    const idx = app.shapes.indexOf(shape);
    if (idx !== -1) {
        app.shapes.splice(idx, 1);
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

export function renderShapes(app, force = false) {
    for (const shape of app.shapes) {
        if (force || shape._dirty || shape.selected || shape.hovered) {
            shape.render(app.viewport.scale);
        }
    }
    
    // Also render components when selected, hovered, or locked
    for (const comp of app.components) {
        if (force || comp.selected || comp.hovered || comp.locked) {
            comp.render(app.viewport.scale);
        }
    }
}
