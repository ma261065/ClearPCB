import { DeleteShapesCommand, DeleteComponentsCommand, ModifyPropertyCommand, BatchCommand } from '../../core/CommandHistory.js';
import { updateRibbonState } from './ribbon.js';

export function toggleSelectionLock(app) {
    const selection = app.selection.getSelection();
    if (selection.length === 0) return;
    const allLocked = selection.every(item => item.locked === true);
    const nextValue = !allLocked;
    const affected = selection.filter(item => typeof item.locked === 'boolean' && item.locked !== nextValue);
    if (affected.length === 0) return;

    const command = new ModifyPropertyCommand(app, affected, 'locked', nextValue);
    app.history.execute(command);

    app.fileManager.setDirty(true);
    app._updatePropertiesPanel(selection);
    updateRibbonState(app, selection);
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

    if (shapesToDelete.length > 0 && componentsToDelete.length > 0) {
        // Mixed selection: wrap both deletes in a single undo entry
        const batch = new BatchCommand('Delete selection');
        batch.add(new DeleteShapesCommand(app, shapesToDelete));
        batch.add(new DeleteComponentsCommand(app, componentsToDelete));
        app.history.execute(batch);
    } else if (shapesToDelete.length > 0) {
        const command = new DeleteShapesCommand(app, shapesToDelete);
        app.history.execute(command);
    } else if (componentsToDelete.length > 0) {
        const command = new DeleteComponentsCommand(app, componentsToDelete);
        app.history.execute(command);
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
            // For arc, only capture the actual stored control points, not computed geometry
            return {
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
        case 'text':
            return { x: shape.x, y: shape.y, text: shape.text, fontSize: shape.fontSize, fontFamily: shape.fontFamily, textAnchor: shape.textAnchor };
        case 'pad':
            return { x: shape.x, y: shape.y, width: shape.width, height: shape.height, rotation: shape.rotation,
                shape: shape.shape, cornerRadius: shape.cornerRadius, hole: shape.hole,
                holeShape: shape.holeShape, holeWidth: shape.holeWidth, holeHeight: shape.holeHeight };
        case 'via':
            return { x: shape.x, y: shape.y, diameter: shape.diameter, hole: shape.hole };
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
