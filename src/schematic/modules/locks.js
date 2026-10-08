/**
 * Schematic object locks, matching the PCB editor: a locked shape or component can
 * be selected but not moved, edited or deleted. Clicking a selected object's lock
 * icon offers to unlock it (undoable); the Properties Locked checkbox locks or
 * unlocks the whole selection.
 */
import { ModifyPropertyCommand } from './commands.js';
import { createContextMenu } from './context-menu.js';
import { updateRibbonState } from './ribbon.js';
import { isSchematicLocked, lockOwner } from '../../shapes/lock-owner.js';
import { CommandHistory } from '../../core/CommandHistory.js';
import { createLockGuard } from '../../core/edit-guard.js';
/** @typedef {import('./schematic-editor-api.js').SchematicEditor} SchematicEditor */
/** @typedef {import('../../core/SchematicDocument.js').SchematicShape} SchematicShape */

/**
 * The schematic editor's undo history, guarded by the lock gate (core/edit-guard.js).
 * SchematicApp and tests both build it here, so they cannot drift apart.
 * @param {SchematicEditor} app
 * @param {{onChanged?: () => void, onRefused?: (error: unknown) => void}} [options] `onRefused` tells the user why
 */
export function createSchematicHistory(app, { onChanged, onRefused } = {}) {
    return new CommandHistory({
        onChanged,
        guard: createLockGuard(target => isSchematicLocked(target.object),
            target => `This ${lockNoun(/** @type {SchematicShape|null|undefined} */ (lockOwner(target.object)))} is locked`),
        onRefused,
    });
}

/** The word the unlock menu uses for an object, e.g. "Unlock wire". */
/** @param {SchematicShape|null|undefined} item */
export function lockNoun(item) {
    if (item?.definition) return 'component';
    if (item?.type === 'polyline') return item.isRect ? 'rectangle' : item.closed ? 'polygon' : 'line';
    const type = typeof item?.type === 'string' ? item.type : '';
    return /** @type {Record<string, string>} */ ({ net: 'net label', noconnect: 'no-connect', text: 'text' })[type] || type || 'object';
}

/**
 * Lift one object's lock (an owned field text's owner's) as its own undo step.
 * @param {SchematicEditor} app
 * @param {SchematicShape|null|undefined} item
 */
export function unlockSchematicItem(app, item) {
    const owner = /** @type {SchematicShape|null|undefined} */ (lockOwner(item));
    if (!owner?.locked) return;
    app.history.execute(new ModifyPropertyCommand(app, [owner], 'locked', false));
    app.fileManager?.setDirty?.(true);
    const selection = app.selection.getSelection();
    app.updatePropertiesPanel(selection);
    updateRibbonState(app, selection);
}

/**
 * The lock icon's click: offer to unlock that object, at the pointer. A component's
 * reference or value text offers to unlock the component, as on the PCB.
 * @param {SchematicEditor} app
 * @param {SchematicShape|null|undefined} item
 * @param {number} clientX
 * @param {number} clientY
 */
export function showUnlockMenu(app, item, clientX, clientY) {
    const owner = /** @type {SchematicShape|null|undefined} */ (lockOwner(item));
    if (!owner?.locked) return null;
    return createContextMenu([{ text: `Unlock ${lockNoun(owner)}`, onClick: () => unlockSchematicItem(app, owner) }],
        clientX, clientY);
}
