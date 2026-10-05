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

/**
 * The schematic editor's undo history, guarded by the lock gate (core/edit-guard.js).
 * SchematicApp and tests both build it here, so they cannot drift apart.
 * @param {any} app
 * @param {{onChanged?: Function, onRefused?: (error: Error) => void}} [options] `onRefused` tells the user why
 */
export function createSchematicHistory(app, { onChanged, onRefused } = {}) {
    return new CommandHistory({
        onChanged,
        guard: createLockGuard(target => isSchematicLocked(target.object),
            target => `This ${lockNoun(lockOwner(target.object))} is locked`),
        onRefused,
    });
}

/** The word the unlock menu uses for an object, e.g. "Unlock wire". */
export function lockNoun(item) {
    if (item?.definition) return 'component';
    if (item?.type === 'polyline') return item.isRect ? 'rectangle' : item.closed ? 'polygon' : 'line';
    return { net: 'net label', noconnect: 'no-connect', text: 'text' }[item?.type] || item?.type || 'object';
}

/** Lift one object's lock (an owned field text's owner's) as its own undo step. */
export function unlockSchematicItem(app, item) {
    item = lockOwner(item);
    if (!item?.locked) return;
    app.history.execute(new ModifyPropertyCommand(app, [item], 'locked', false));
    app.fileManager?.setDirty?.(true);
    const selection = app.selection.getSelection();
    app.updatePropertiesPanel?.(selection);
    updateRibbonState(app, selection);
}

/**
 * The lock icon's click: offer to unlock that object, at the pointer. A component's
 * reference or value text offers to unlock the component, as on the PCB.
 */
export function showUnlockMenu(app, item, clientX, clientY) {
    item = lockOwner(item);
    if (!item?.locked) return null;
    return createContextMenu([{ text: `Unlock ${lockNoun(item)}`, onClick: () => unlockSchematicItem(app, item) }],
        clientX, clientY);
}
