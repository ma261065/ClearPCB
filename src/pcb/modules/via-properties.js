/**
 * The Properties panel for selected vias: net, diameter, drill and lock, with live
 * previews that commit as one undoable edit.
 */
import { noteEditSettled } from './refresh-state.js';
import { renderVia } from './track-render.js';
import { collectBondedCopper } from './track-connections.js';
import { CompoundCommand, ModifyTrackCommand, ModifyViaCommand, ModifyViasCommand, canonicalVia, beginViaPropertyPreview, finishViaPropertyPreview } from './track-commands.js';
import { isViaLocked, isViaVisible } from './layers.js';
import { lockedProperty } from './object-locks.js';
import { showAlert } from '../../shared/ui/modal.js';
import { getPcbSelection } from './selection-registry.js';
import { setPropertyEditor } from './property-editors.js';
import { isEditorActive } from './pcb-editor-api.js';
import { refreshTrackSelectionHalo } from './copper-halos.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */
/** @typedef {import('../../shared/ui/property-fields.js').PropertyField} PropertyField */
/** @typedef {import('../../shared/ui/property-fields.js').PropertyPanel} PropertyPanel */
/** @typedef {import('../../shapes/via.js').Via} Via */
/** @typedef {import('./track-commands.js').ViaPropertyPreview} ViaPropertyPreview */
/** @typedef {'diameter'|'drill'} ViaNumberKey */
/** @typedef {{vias: Via[], active: boolean, affectsLayer: (layerId: string) => boolean, commit: () => void, cancel: () => void, dispose: () => void, prepare: () => boolean}} ViaPropertyBinding */
/** @typedef {{via: Via, before: object, after: object}} ViaPropertyChange */
/** @typedef {import('./track-properties.js').BondedCopperGroup} BondedCopperGroup */
/** @typedef {import('../../core/CommandHistory.js').HistoryCommand} HistoryCommand */
/** @typedef {import('../../shapes/track.js').Track} Track */

/**
 * Apply a net to all selected vias and the copper bonded to each of them.
 * @param {PcbEditor} app
 * @param {Via[]} vias
 * @param {string} v
 */
function _applyNetToSelectedVias(app, vias, v) {
    const tracks = new Set();
    const bondedVias = new Set();
    const padNets = new Set();
    for (const via of vias) {
        const group = /** @type {BondedCopperGroup} */ (collectBondedCopper(app, { via }));
        for (const track of group.tracks) tracks.add(track);
        for (const bondedVia of group.vias) bondedVias.add(bondedVia);
        for (const padNet of group.padNets) if (padNet) padNets.add(padNet);
    }
    const conflict = [...padNets].find((padNet) => padNet !== v);
    if (conflict !== undefined) {
        showAlert(
            `This copper is connected to a pad on net "${conflict}" (assigned by the schematic). ` +
            `Rename the net in the schematic instead of editing the via.`,
            { title: 'Net Assigned by Schematic' },
        );
        return false;
    }
    /** @type {HistoryCommand[]} */
    const commands = [];
    for (const track of tracks) {
        if ((track.net || '') !== v) {
            commands.push(new ModifyTrackCommand(app, track, { net: track.net || '' }, { net: v }));
        }
    }
    const viaChanges = [...bondedVias]
        .filter((bondedVia) => (bondedVia.net || '') !== v)
        .map((bondedVia) => ({
            via: bondedVia,
            before: { net: bondedVia.net || '' },
            after: { net: v },
        }));
    if (viaChanges.length === 1) {
        const change = viaChanges[0];
        commands.push(new ModifyViaCommand(app, change.via, change.before, change.after));
    } else if (viaChanges.length > 1) {
        commands.push(new ModifyViasCommand(app, viaChanges));
    }
    if (commands.length) {
        app.history?.execute(commands.length === 1 ? commands[0] : new CompoundCommand(commands));
    }
    return true;
}

/**
 * @param {PcbEditor} app
 * @param {Via} via
 */
export function showViaProperties(app, via) {
    via = canonicalVia(app, via);
    const selectedVias = /** @type {Via[]} */ (getPcbSelection(app, 'via').map(/** @param {Via} target */ target => canonicalVia(app, target)));
    const vias = /** @type {Via[]} */ (selectedVias.includes(via) && selectedVias.length ? selectedVias : [via]);
    /** @type {ViaPropertyPreview|null} */
    let preview = null;
    /** @type {ViaNumberKey|null} */
    let activeProperty = null;
    let disposed = false;
    /** @param {Via} target */
    const shown = target => preview?.copies.get(target) || target;
    /** @param {ViaNumberKey|'net'} property */
    const mixed = property => vias.map(shown).some((target) => (target[property] ?? '') !== (shown(via)[property] ?? ''));
    const limits = () => ({
        minDiameter: Math.max(...vias.map((target) => shown(target).drill)),
        maxDrill: Math.min(...vias.map((target) => shown(target).diameter)),
    });
    const lockEntries = vias.map((target) => ({ kind: 'via', object: target }));
    /** @type {number|null} */
    let renderFrame = null;
    const refresh = () => { if (!disposed) app.refreshPropertyPanel(describe()); };
    const reRender = () => {
        if (renderFrame !== null) return;
        renderFrame = requestAnimationFrame(() => {
            renderFrame = null;
            for (const target of preview?.copies.values() || []) renderVia(target, /** @param {string} id */ (id) => app.getLayerGroup(id));
            // renderVia replaces the circles that the existing selection halo
            // was painted above, so rebuild that overlay after the redraw.
            refreshTrackSelectionHalo(app);
        });
    };
    const cancelLiveRender = () => {
        if (renderFrame === null) return;
        cancelAnimationFrame(renderFrame);
        renderFrame = null;
    };
    /** @param {boolean} commit */
    const finish = commit => {
        if (!preview) return;
        preview = null;
        noteEditSettled(app);
        activeProperty = null;
        cancelLiveRender();
        let committed = false;
        try {
            finishViaPropertyPreview(app, commit ? /** @param {ViaPropertyChange[]} changes */ changes => {
                app.history.execute(changes.length === 1
                    ? new ModifyViaCommand(app, changes[0].via, changes[0].before, changes[0].after)
                    : new ModifyViasCommand(app, changes));
            } : undefined);
            committed = commit;
        } finally {
            refreshTrackSelectionHalo(app);
            refresh();
        }
    };
    const editable = () => !disposed && isEditorActive(app) && !isViaLocked() && isViaVisible()
        && vias.every((target) => !target.locked && target.visible !== false);
    /** @type {ViaPropertyBinding} */
    const binding = {
        vias,
        affectsLayer: /** @param {string} layerId */ layerId => layerId === 'vias',
        get active() { return preview !== null; },
        commit: () => finish(editable()),
        cancel: () => finish(false),
        dispose: () => {
            disposed = true;
            finish(false);
            cancelLiveRender();
        },
        prepare() {
            if (disposed) return false;
            binding.commit();
            return true;
        },
    };
    /**
     * @param {ViaNumberKey} key
     * @param {number} value
     */
    const live = (key, value) => {
        if (!editable()) {
            binding.cancel();
            return;
        }
        if (preview && activeProperty !== key) {
            binding.commit();
        }
        if (!Number.isFinite(value) || value <= 0) return;
        if (vias.every((target) => shown(target)[key] === value)) return;
        preview ??= beginViaPropertyPreview(app, vias);
        activeProperty = key;
        for (const target of preview.copies.values()) target[key] = value;
        reRender();
        refresh();
    };
    /**
     * @param {ViaNumberKey} key
     * @param {string} id
     * @param {string} label
     * @returns {PropertyField}
     */
    const numberField = (key, id, label) => {
        const current = shown(via);
        const currentLimits = limits();
        const isDiameter = key === 'diameter';
        return {
            key, id, type: 'number', label, value: current[key], mixed: mixed(key), disabled: !editable(),
            min: isDiameter ? currentLimits.minDiameter : 0.05,
            max: isDiameter ? undefined : currentLimits.maxDrill,
            step: 0.05,
            normalize: /** @param {number} value */ value => isDiameter ? Math.max(value, limits().minDiameter)
                : Math.min(Math.max(value, 0.05), limits().maxDrill),
            preview: /** @param {number} value */ value => live(key, value),
            commit: () => binding.commit(),
            cancel: () => { const active = preview !== null; binding.cancel(); return active; },
        };
    };
    /** @param {string} value */
    const applyNet = value => {
        if (!editable()) {
            binding.cancel();
            return;
        }
        let applied = false;
        try {
            binding.commit();
            const v = String(value || '').trim();
            applied = vias.every((target) => (target.net || '') === v) || _applyNetToSelectedVias(app, vias, v);
        } finally {
            if (!applied) refresh();
        }
    };
    /** @returns {PropertyPanel} */
    function describe() {
        const lock = lockedProperty(app, lockEntries);
        const readOnly = lock.readOnly;
        return {
            title: 'Via',
            fields: /** @type {PropertyField[]} */ ([
                lock.field,
                { key: 'net', id: 'pcbPropViaNet', type: 'net', label: 'Net',
                    value: shown(via).net || '', mixed: mixed('net'), disabled: readOnly, nets: app.netNames(),
                    commit: applyNet },
                numberField('diameter', 'pcbPropViaDia', 'Diameter (mm)'),
                numberField('drill', 'pcbPropViaDrill', 'Drill (mm)'),
            ]).map(field => field.key === 'locked' ? field : { ...field, disabled: field.disabled || readOnly }),
        };
    }
    if (!app.openPropertyPanel(describe(), via)) { binding.dispose(); return; }
    setPropertyEditor(app, 'via', binding);
}
