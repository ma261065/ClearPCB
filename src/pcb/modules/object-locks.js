/**
 * Individual PCB object locks, alongside layer locks.
 *
 * An object is locked when its own flag is set (saved as `lk`) or a layer that
 * holds it is locked. Locked objects can be selected for inspection and
 * unlocking, but not moved, edited or deleted. Components and their reference
 * text share the placement's lock; copper pours are also held by their
 * copper-fill layer lock. Clicking the selection lock icon offers to lift the
 * object lock, the layer lock, or both.
 */
import { SetObjectLockedCommand as ModelSetObjectLockedCommand } from '../../core/pcb-lock-commands.js';
import { CommandHistory } from '../../core/CommandHistory.js';
import { createLockGuard } from '../../core/edit-guard.js';
import { padLayers } from '../../shapes/pad-geometry.js';
import { PCB_COPPER_FILLS, isCopperFillLocked, isLayerLocked, isLayerVisible, unlockPcbCopperFill, unlockPcbLayer } from './layers.js';
import { showPathContextMenu } from './path-edit.js';
import { isPcbSelected } from './selection-registry.js';
import { showPcbSelectionProperties } from './selection-interaction.js';
import { CompoundCommand, SetPlacementLockedCommand } from './track-commands.js';

const NOUNS = {
    component: 'component', reftext: 'component', track: 'track', via: 'via',
    pad: 'pad', shape: 'shape', fill: 'fill', text: 'text',
};

/**
 * A layer lock holding an object; `fill` marks a copper-fill (pour) layer lock.
 * @typedef {{id: string, fill?: boolean}} LayerLock
 * @typedef {{object: boolean, layers: LayerLock[]}} PcbLockState
 */

/** The layers an object lives on; components have none of their own. */
export function pcbObjectLayers(app, kind, object) {
    if (kind === 'component') return [];
    if (kind === 'reftext') {
        const placement = app.placements?.get(object);
        return placement ? [placement.side === 'bottom' ? 'bottom-silk' : 'top-silk'] : [];
    }
    if (!object) return [];
    if (kind === 'track') return [...new Set([...object.edges?.keys() || []].map(id => object.getEdgeLayer(id)))];
    if (kind === 'via') return ['vias'];
    if (kind === 'pad') return padLayers(object);
    return [object.layer];
}

/**
 * The locks holding one object. Components and reference text are keyed by
 * component id; every other kind is the model object.
 * @returns {PcbLockState}
 */
export function pcbLockState(app, kind, object) {
    const own = kind === 'component' || kind === 'reftext'
        ? !!app.placements?.get(object)?.locked : !!object?.locked;
    const layers = pcbObjectLayers(app, kind, object);
    // A track stays editable while any of its edges is on an unlocked, visible layer.
    const held = kind === 'track' && layers.some(id => !isLayerLocked(id) && isLayerVisible(id))
        ? [] : layers.filter(isLayerLocked).map(id => /** @type {LayerLock} */ ({ id }));
    if (kind === 'fill' && isCopperFillLocked(object.layer)) held.push({ id: object.layer, fill: true });
    return { object: own, layers: held };
}

/**
 * Whether a layer lock holds the object. Select All and the marquee skip these (a
 * locked layer is meant to stay out of the way) but take objects locked on their
 * own, so a whole selection can be unlocked again from Properties.
 */
export function isPcbObjectLayerLocked(app, kind, object) {
    return pcbLockState(app, kind, object).layers.length > 0;
}

/** Whether an object is held by its own lock or a layer lock. */
export function isPcbObjectLocked(app, kind, object) {
    const state = pcbLockState(app, kind, object);
    return state.object || state.layers.length > 0;
}

/**
 * Tracks and vias that routing and Clear Routes keep: everything locked. The router
 * treats them as fixed copper, so new routes join same-net copper and avoid the rest.
 */
export function lockedRoutedCopper(app) {
    return {
        tracks: (app.tracks || []).filter(track => isPcbObjectLocked(app, 'track', track)),
        vias: (app.vias || []).filter(via => isPcbObjectLocked(app, 'via', via)),
    };
}

/** A board shape (or free text) is locked by its own flag or its layer. */
export function boardShapeLocked(shape) {
    return !!shape && (!!shape.locked || isLayerLocked(shape.layer));
}

/** Editor command: the model toggle plus the Properties refresh it implies. */
export class SetObjectLockedCommand extends ModelSetObjectLockedCommand {
    constructor(app, kind, object, locked) {
        super(app.pcbDocument, kind, object, locked);
        this.app = app;
    }
    _apply(locked) {
        super._apply(locked);
        if (isPcbSelected(this.app, this.kind, this.target())) showPcbSelectionProperties(this.app);
    }
}

/** The undoable command that sets one object's own lock. */
export function objectLockCommand(app, kind, object, locked) {
    return kind === 'component' || kind === 'reftext'
        ? new SetPlacementLockedCommand(app, object, locked)
        : new SetObjectLockedCommand(app, kind, object, locked);
}

/** Set (or clear) the own lock of several objects as one undo step. */
export function setPcbObjectsLocked(app, entries, locked) {
    const seen = new Set();
    const commands = [];
    for (const { kind, object } of entries) {
        const key = kind === 'reftext' ? `component:${object}` : `${kind}:${object?.id ?? object}`;
        if (seen.has(key) || pcbLockState(app, kind, object).object === !!locked) continue;
        seen.add(key);
        commands.push(objectLockCommand(app, kind, object, locked));
    }
    if (commands.length) app.history.execute(commands.length === 1 ? commands[0] : new CompoundCommand(commands));
    return commands.length > 0;
}

function unlockLayer(app, lock) {
    if (lock.fill) unlockPcbCopperFill(app, lock.id);
    else unlockPcbLayer(app, lock.id);
}

/** The layer panel's name for a lock: "Hole", "Top Solder Mask", or "Top Copper Fill" for a fill row. */
function layerName(app, lock) {
    if (!lock.fill) return app.layerLabel(lock.id);
    return `${PCB_COPPER_FILLS.find(fill => fill.id === lock.id)?.name || app.layerLabel(lock.id)} Copper Fill`;
}

/** Describe layer locks for menus, e.g. "Top Copper layer" or "Top Copper and Top Copper Fill layers". */
export function describeLayerLocks(app, layers) {
    const names = layers.map(lock => layerName(app, lock));
    return `${names.join(' and ')} layer${names.length > 1 ? 's' : ''}`;
}

/**
 * Message for an edit the lock gate refused, e.g. "This track is locked" or "Top Copper layer is locked".
 * @param {any} app
 * @param {import('../../core/edit-guard.js').LockTarget} target
 */
export function describeLockedEdit(app, { kind, object }) {
    const state = pcbLockState(app, kind, object);
    if (state.object || !state.layers.length) return `This ${NOUNS[kind] || 'object'} is locked`;
    return `${describeLayerLocks(app, state.layers)} ${state.layers.length > 1 ? 'are' : 'is'} locked`;
}

/**
 * The PCB editor's undo history, guarded by the lock gate (core/edit-guard.js).
 * PCBApp and the test fixtures both build it here, so they cannot drift apart.
 * @param {any} app
 * @param {{onChanged?: Function, onRefused?: (error: Error) => void}} [options] `onRefused` tells the user why
 */
export function createPcbHistory(app, { onChanged, onRefused } = {}) {
    return new CommandHistory({
        maxSize: 200,
        onChanged,
        guard: createLockGuard(target => isPcbObjectLocked(app, target.kind, target.object),
            target => describeLockedEdit(app, target)),
        onRefused,
    });
}

/** Menu items lifting the object's own lock, its layer locks, or both; only applicable ones. */
export function unlockMenuItems(app, kind, object) {
    const state = pcbLockState(app, kind, object);
    const unlockObject = () => app.history.execute(objectLockCommand(app, kind, object, false));
    const unlockLayers = () => { for (const lock of state.layers) unlockLayer(app, lock); };
    const items = [];
    if (state.object) items.push({ text: `Unlock ${NOUNS[kind] || 'object'}`, onClick: unlockObject });
    if (state.layers.length) items.push({ text: `Unlock ${describeLayerLocks(app, state.layers)}`, onClick: unlockLayers });
    if (state.object && state.layers.length) {
        items.push({ text: 'Unlock both', onClick: () => { unlockLayers(); unlockObject(); } });
    }
    return items;
}

/** The lock icon's click: offer the applicable unlock choices at the pointer. */
export function showUnlockMenu(app, kind, object, clientX, clientY) {
    return showPathContextMenu('pcbUnlockMenu', unlockMenuItems(app, kind, object), clientX, clientY);
}

const LOCK_INPUT_ID = 'pcbPropObjectLocked';

/** Properties "Locked" row for the objects' own locks (layer locks live in the layer panel). */
export function lockedPropertyHtml(app, entries) {
    const own = entries.filter(({ kind, object }) => pcbLockState(app, kind, object).object).length;
    const checked = entries.length > 0 && own === entries.length;
    const mixed = own > 0 && !checked ? ' data-mixed="true"' : '';
    return `<label class="prop-row prop-toggle" data-prop="locked"><input type="checkbox" id="${LOCK_INPUT_ID}"${checked ? ' checked' : ''}${mixed}><span>Locked</span></label>`;
}

/**
 * Bind the Locked row and, while any entry is locked by itself or a layer, make
 * the panel's other controls read-only. Edit paths enforce the same rule; this
 * keeps the panel from offering edits that would be refused.
 */
export function bindLockedProperty(app, items, entries) {
    const input = /** @type {HTMLInputElement|null} */ (items?.querySelector?.(`#${LOCK_INPUT_ID}`));
    if (input) {
        if (input.dataset?.mixed) input.indeterminate = true;
        input.addEventListener('change', () => setPcbObjectsLocked(app, entries, input.checked));
    }
    if (!entries.some(({ kind, object }) => isPcbObjectLocked(app, kind, object))) return;
    for (const control of items?.querySelectorAll?.('input, select, textarea, button') || []) {
        if (control !== input) control.disabled = true;
    }
    for (const menu of items?.querySelectorAll?.('details') || []) {
        menu.open = false;
        menu.inert = true;
    }
}
