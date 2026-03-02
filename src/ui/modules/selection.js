import { DeleteShapesCommand, DeleteComponentsCommand, ModifyPropertyCommand, ModifyShapeCommand, BatchCommand } from '../../core/CommandHistory.js';
import { cleanupOrphanedTJunctions } from './wire.js';
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
    const toDelete = app.selection.getSelection().filter(item => !item.locked);
    if (toDelete.length === 0) return;

    app.selection._clearSelection();

    const shapeSet = new Set(app.shapes);
    const compSet = new Set(app.components);
    const deleteSet = new Set(toDelete);
    const shapesToDelete = [];
    const componentsToDelete = [];
    const showFlagCommands = [];

    for (const item of toDelete) {
        if (shapeSet.has(item)) {
            if (item.parentComponent && item.fieldKey) {
                // Skip show-flag toggle if parent component is also being deleted
                if (!deleteSet.has(item.parentComponent)) {
                    const showKey = item.fieldKey === 'reference' ? 'showReference' : 'showValue';
                    if (item.parentComponent[showKey]) {
                        showFlagCommands.push(new ModifyPropertyCommand(
                            app, [item.parentComponent], showKey, false));
                    }
                }
                continue;
            }
            shapesToDelete.push(item);
        } else if (compSet.has(item)) {
            componentsToDelete.push(item);
        }
    }

    // T-junction cleanup is no longer needed in the graph model —
    // junctions are derived from node degree and don't leave orphaned vertices.
    const tjCleanupCmds = [];

    const cmdCount = (shapesToDelete.length > 0 ? 1 : 0) + (componentsToDelete.length > 0 ? 1 : 0)
        + showFlagCommands.length + tjCleanupCmds.length;
    const needsBatch = cmdCount > 1;

    if (needsBatch) {
        const batch = new BatchCommand('Delete selection');
        for (const cmd of showFlagCommands) batch.add(cmd);
        if (shapesToDelete.length > 0) batch.add(new DeleteShapesCommand(app, shapesToDelete));
        if (componentsToDelete.length > 0) batch.add(new DeleteComponentsCommand(app, componentsToDelete));
        for (const cmd of tjCleanupCmds) batch.add(cmd);
        app.history.execute(batch);
    } else if (showFlagCommands.length > 0) {
        app.history.execute(showFlagCommands[0]);
    } else if (shapesToDelete.length > 0 && tjCleanupCmds.length === 0) {
        app.history.execute(new DeleteShapesCommand(app, shapesToDelete));
    } else if (componentsToDelete.length > 0) {
        app.history.execute(new DeleteComponentsCommand(app, componentsToDelete));
    } else if (tjCleanupCmds.length > 0) {
        app.history.execute(tjCleanupCmds[0]);
    }

    app.selection._notifySelectionChanged();
}

export function captureShapeState(app, shape) {
    return shape.captureState();
}

export function applyShapeState(app, shape, state) {
    shape.applyState(state);
    app.renderShapes(true);
}
