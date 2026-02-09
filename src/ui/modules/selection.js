import { DeleteShapesCommand } from '../../core/CommandHistory.js';

export function toggleSelectionLock(app) {
    const selection = app.selection.getSelection();
    if (selection.length === 0) return;
    const allLocked = selection.every(item => item.locked === true);
    const nextValue = !allLocked;
    for (const item of selection) {
        if (typeof item.locked === 'boolean') {
            item.locked = nextValue;
            if (typeof item.invalidate === 'function') item.invalidate();
        }
    }
    app.fileManager.setDirty(true);
    app.renderShapes(true);
    app._updatePropertiesPanel(selection);
    app._updateRibbonState(selection);
}

export function deleteSelected(app) {
    const toDelete = app.selection.getSelection();
    if (toDelete.length === 0) return;

    app.selection.clearSelection();

    const shapesToDelete = [];
    const componentsToDelete = [];

    for (const item of toDelete) {
        if (app.shapes.includes(item)) {
            shapesToDelete.push(item);
        } else if (app.components.includes(item)) {
            componentsToDelete.push(item);
        }
    }

    if (shapesToDelete.length > 0) {
        const command = new DeleteShapesCommand(app, shapesToDelete);
        app.history.execute(command);
    }

    for (const comp of componentsToDelete) {
        const idx = app.components.indexOf(comp);
        if (idx !== -1) {
            app.components.splice(idx, 1);
            if (comp.element) {
                app.viewport.removeContent(comp.element);
            }
            comp.destroy();
        }
    }

    if (componentsToDelete.length > 0) {
        app._updateSelectableItems();
        app.fileManager.setDirty(true);
    }

    app.renderShapes(true);
}

export function captureShapeState(app, shape) {
    switch (shape.type) {
        case 'rect':
            return { x: shape.x, y: shape.y, width: shape.width, height: shape.height };
        case 'circle':
            return { x: shape.x, y: shape.y, radius: shape.radius };
        case 'line':
            return { x1: shape.x1, y1: shape.y1, x2: shape.x2, y2: shape.y2 };
        case 'arc':
            return {
                x: shape.x,
                y: shape.y,
                radius: shape.radius,
                startAngle: shape.startAngle,
                endAngle: shape.endAngle,
                sweepFlag: shape.sweepFlag,
                largeArc: shape.largeArc,
                snapToGrid: shape.snapToGrid,
                gridSize: shape.gridSize,
                bulgePoint: shape.bulgePoint ? { x: shape.bulgePoint.x, y: shape.bulgePoint.y } : undefined,
                startPoint: shape.startPoint ? { x: shape.startPoint.x, y: shape.startPoint.y } : undefined,
                endPoint: shape.endPoint ? { x: shape.endPoint.x, y: shape.endPoint.y } : undefined
            };
        case 'polygon':
            return { points: shape.points.map(p => ({ x: p.x, y: p.y })) };
        case 'wire':
            return {
                points: shape.points.map(p => ({ x: p.x, y: p.y })),
                connections: shape.connections ? { ...shape.connections } : null,
                net: shape.net || ''
            };
        default:
            console.warn('Unknown shape type for state capture:', shape.type);
            return {};
    }
}

export function applyShapeState(app, shape, state) {
    for (const [key, value] of Object.entries(state)) {
        if (key === 'points' && Array.isArray(value)) {
            shape.points = value.map(p => ({ x: p.x, y: p.y }));
        } else if ((key === 'startPoint' || key === 'endPoint' || key === 'bulgePoint') && value) {
            shape[key] = { x: value.x, y: value.y };
        } else {
            shape[key] = value;
        }
    }
    shape.invalidate();
    app.renderShapes(true);
}
