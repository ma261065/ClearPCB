import { ModifyPropertyCommand } from './commands.js';
import { hasOwnLock } from '../../shapes/lock-owner.js';
import { updateRibbonState } from './ribbon.js';
import { refreshComponentPose } from './schematic-view.js';
import { isComponentItem as isComponentShape } from '../../core/schematic-items.js';
import { applySchematicItemState } from '../../core/schematic-state.js';
/** @typedef {import('./schematic-editor-api.js').SchematicEditor} SchematicEditor */
/** @typedef {import('../../core/SchematicDocument.js').SchematicItem} SchematicItem */
/** @typedef {import('../../components/Component.js').Component} Component */
/** @typedef {import('../../core/schematic-state.js').SchematicItemState} ShapeState */

/**
 * Toggles the `locked` property on all selected items via `ModifyPropertyCommand`
 * and refreshes the properties panel and ribbon.
 * @param {SchematicEditor} app
 */
export function toggleSelectionLock(app) {
    const selection = app.selection.getSelection();
    if (selection.length === 0) return;
    // Owned field texts follow their owner's lock and have none of their own.
    const lockable = selection.filter(hasOwnLock);
    const allLocked = lockable.length > 0 && lockable.every(item => item.locked === true);
    const nextValue = !allLocked;
    const affected = lockable.filter(item => item.locked !== nextValue);
    if (affected.length === 0) return;

    const command = new ModifyPropertyCommand(app, affected, 'locked', nextValue);
    app.history.execute(command);

    app.fileManager.setDirty(true);
    app.updatePropertiesPanel(selection);
    updateRibbonState(app, selection);
}

/**
 * Snapshots a shape's current state for undo purposes.
 * @param {SchematicEditor} app
 * @param {SchematicItem} shape - Shape to capture.
 * @returns {ShapeState} The captured state object.
 */
export function captureShapeState(app, shape) {
    return shape.captureState();
}

/**
 * Restores a shape to a previously captured state and triggers a full re-render.
 * @param {SchematicEditor} app
 * @param {SchematicItem} shape - Shape to restore.
 * @param {ShapeState} state - Previously captured state.
 */
export function applyShapeState(app, shape, state) {
    const component = isComponentShape(shape) ? shape : null;
    const oldRotation = component?.rotation;
    const oldMirror = component?.mirror;
    applySchematicItemState(shape, state);
    if (component) {
        const rebuild = ('rotation' in state && state.rotation !== undefined && state.rotation !== oldRotation)
            || ('mirror' in state && state.mirror !== undefined && state.mirror !== oldMirror);
        refreshComponentPose(component, { rebuild });
    }
    app.renderShapes(true);
}
