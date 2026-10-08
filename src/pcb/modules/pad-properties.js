/**
 * Properties panel for pads: one or more selected pads, or the Pad tool's defaults
 * (`pad` null). The editor passes in the tool state the panel needs: the defaults
 * object it edits and a callback that redraws the placement preview.
 *
 * Logic only: the panel describes its fields (shared/ui/property-fields.js) and the
 * editor shows them. Number edits preview on display copies of the pads and commit one
 * ModifyPadCommand (per pad) when the field's run settles.
 */
import { noteEditSettled } from './refresh-state.js';
import { pcbToolBlockNotice } from './tool-lifecycle.js';
import { refreshBoxSelectionHighlights } from './box-select.js';
import { isLayerVisible } from './layers.js';
import { isPcbObjectLocked, lockedProperty } from './object-locks.js';
import { ModifyPadCommand, beginPadPropertyPreview, canonicalPad, finishPadPropertyPreview } from './pad-commands.js';
import { padLayers, renderPad } from './pad.js';
import { pictureRefreshHold, schedulePictureCopperRefresh } from './picture-refresh.js';
import { setPropertyEditor } from './property-editors.js';
import { getPcbSelection } from './selection-registry.js';
import { CompoundCommand } from './track-commands.js';
import { isEditorActive } from './pcb-editor-api.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */
/** @typedef {import('../../shapes/pad.js').Pad} Pad */
/** @typedef {import('../../shared/ui/property-fields.js').PropertyField} PropertyField */
/** @typedef {import('../../shared/ui/property-fields.js').PropertyPanel} PropertyPanel */
/** @typedef {import('./pad-commands.js').PadPropertyPreview} PadPropertyPreview */
/** @typedef {'shape'|'layers'|'net'|'size'|'ratio'|'drill'|'rotation'} PadPropertyKey */
/** @typedef {'size'|'ratio'|'drill'|'rotation'} PadNumberPropertyKey */
/** @typedef {{shape: string, layers: string, net: string, size: number, ratio: number, drill: number, rotation: number}} PadDefaults */
/** @typedef {{defaults: PadDefaults, refreshPreview: () => void}} PadTool */
/** @typedef {{pads: Pad[], active: boolean, affectsLayer: (layerId: string) => boolean, commit: () => void, cancel: () => void, dispose: () => void}} PadPropertyBinding */
/** @typedef {{pad: Pad, before: any, after: any}} PadPropertyChange */

const SHAPES = [['round', 'Round'], ['stadium', 'Stadium'], ['square', 'Square'], ['rectangle', 'Rectangle'], ['oval', 'Oval']]
    .map(([value, label]) => ({ value, label }));
const LAYERS = [['top-copper', 'Top'], ['bottom-copper', 'Bottom'], ['both', 'Both']].map(([value, label]) => ({ value, label }));
const ELONGATED = new Set(['stadium', 'rectangle', 'oval']);

/**
 * @param {PcbEditor} app
 * @param {Pad|null} pad
 * @param {PadTool} tool
 */
export function showPadEditor(app, pad, tool) {
    if (pad) pad = canonicalPad(app, pad);
    const selectedPads = /** @type {Pad[]} */ (pad ? getPcbSelection(app, 'pad').map(/** @param {Pad} target */ target => canonicalPad(app, target)) : []);
    const pads = pad && selectedPads.includes(pad) ? selectedPads : (pad ? [pad] : []);
    const lockEntries = pads.map((target) => ({ kind: 'pad', object: target }));
    const hold = pictureRefreshHold(app);
    let disposed = false;
    /** @type {PadPropertyPreview|null} */
    let preview = null;
    /** @type {PadPropertyKey|null} */
    let activeProperty = null;
    /** @type {number|null} */
    let renderFrame = null;
    /** What the panel shows: a pad's preview copy while a number edit is live. */
    /** @param {Pad} target */
    const shown = target => preview?.copies.get(target) || target;
    const maxDrill = () => (pad ? Math.min(...pads.map((target) => shown(target).size)) : tool.defaults.size);
    const editable = () => !disposed && isEditorActive(app) && (!pad || pads.every((target) => !isPcbObjectLocked(app, 'pad', target)
        && target.visible !== false && padLayers(target).some(isLayerVisible)));

    /** @returns {PropertyPanel} */
    const describe = () => {
        const current = pad ? shown(pad) : tool.defaults;
        const shownPads = pads.map(shown);
        /** @param {PadPropertyKey} property */
        const mixed = property => shownPads.some(target => (target[property] ?? '') !== (current[property] ?? ''));
        const lock = pad ? lockedProperty(app, lockEntries) : null;
        // The tool's defaults: say when its layer is locked or hidden.
        const notice = pad ? null : pcbToolBlockNotice(app, 'pad');
        const readOnly = !!lock?.readOnly;
        /**
         * @param {PadNumberPropertyKey} key
         * @param {string} id
         * @param {string} label
         * @param {{min?: number, max?: number, step?: number, title?: string, normalize?: (value: number) => number}} extra
         * @returns {PropertyField}
         */
        const number = (key, id, label, extra) => ({
            key, id, type: 'number', label, value: current[key], mixed: mixed(key), disabled: readOnly, hold,
            preview: /** @param {number} value */ value => previewNumber(key, value),
            commit: () => binding.commit(),
            cancel: () => { const active = preview !== null; binding.cancel(); return active; },
            ...extra,
            // Below the minimum is invalid (cancelled and restored), not clamped.
            normalize: /** @param {number} value */ value => (value < (extra.min ?? -Infinity) ? NaN : (extra.normalize ? extra.normalize(value) : value)),
        });
        const showRatio = pad ? shownPads.some((target) => ELONGATED.has(target.shape)) : ELONGATED.has(current.shape);
        const showRotation = pad ? shownPads.some((target) => target.shape !== 'round') : current.shape !== 'round';
        const fields = [
            ...(lock ? [lock.field] : []),
            { key: 'padShape', id: 'pcbPropPadShape', type: 'select', label: 'Shape', value: current.shape, mixed: mixed('shape'),
                disabled: readOnly, options: SHAPES, commit: /** @param {string} value */ value => {
                    apply('shape', value);
                    if (!disposed) showPadEditor(app, pad, tool);
                } },
            { key: 'layer', id: 'pcbPropPadLayers', type: 'select', label: 'Layer', value: current.layers, mixed: mixed('layers'),
                disabled: readOnly, warning: notice?.warning, options: LAYERS, commit: /** @param {string} value */ value => apply('layers', value) },
            { key: 'net', id: 'pcbPropPadNet', type: 'net', label: 'Net', value: current.net || '', mixed: mixed('net'),
                disabled: readOnly, nets: app.netNames(), commit: /** @param {string} value */ value => apply('net', value) },
            number('size', 'pcbPropPadSize', 'Size (mm)', { min: 0.05, step: 0.05 }),
            ...(showRatio ? [number('ratio', 'pcbPropPadRatio', 'Ratio', { min: 1, step: 0.1 })] : []),
            number('drill', 'pcbPropPadDrill', 'Drill (mm)', { min: 0, max: maxDrill(), step: 0.05, title: '0 = no hole',
                normalize: value => Math.min(value, maxDrill()) }),
            ...(showRotation ? [number('rotation', 'pcbPropPadRotation', 'Rotation (°)', { step: 1,
                normalize: value => ((value % 360) + 360) % 360 })] : []),
        ];
        return /** @type {PropertyPanel} */ ({ title: pad ? 'Pad' : 'New Pad', fields, actions: notice?.actions });
    };
    const refresh = () => { if (!disposed) app.refreshPropertyPanel(describe()); };

    /**
     * @param {PadPropertyKey} property
     * @param {string|number} value
     */
    const apply = (property, value) => {
        if (disposed || (pad && !editable())) return;
        finish(true);
        if (pad) {
            const commands = [];
            for (const target of pads) {
                const before = target.captureState();
                const after = { ...before, [property]: value };
                if (property === 'size') after.drill = Math.min(after.drill, Number(value));
                if (JSON.stringify(after) !== JSON.stringify(before)) {
                    commands.push(new ModifyPadCommand(app, target, before, after));
                }
            }
            if (!commands.length) return;
            app.history.execute(commands.length === 1 ? commands[0] : new CompoundCommand(commands));
            refreshBoxSelectionHighlights(app);
        } else {
            if (property === 'size' || property === 'ratio' || property === 'drill' || property === 'rotation') {
                tool.defaults[property] = Number(value);
            } else {
                tool.defaults[property] = String(value);
            }
            if (property === 'size') tool.defaults.drill = Math.min(tool.defaults.drill, Number(value));
            tool.refreshPreview();
        }
        refresh();
    };
    const renderLivePads = () => {
        if (!pad || renderFrame !== null) return;
        renderFrame = requestAnimationFrame(() => {
            renderFrame = null;
            for (const target of preview?.copies.values() || []) renderPad(target, /** @param {string} layer */ layer => app.getLayerGroup(layer));
            refreshBoxSelectionHighlights(app);
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
        if (commit && !editable()) commit = false;
        preview = null;
        noteEditSettled(app);
        activeProperty = null;
        cancelLiveRender();
        try {
            finishPadPropertyPreview(app, commit ? /** @param {PadPropertyChange[]} changes */ changes => {
                const commands = changes.map(({ pad, before, after }) => new ModifyPadCommand(app, pad, before, after));
                app.history.execute(commands.length === 1 ? commands[0] : new CompoundCommand(commands));
            } : undefined);
        } finally {
            refreshBoxSelectionHighlights(app);
            refresh();
        }
    };
    /**
     * @param {PadPropertyKey} property
     * @param {number} value
     */
    const previewNumber = (property, value) => {
        if (!editable()) {
            binding.cancel();
            return;
        }
        if (!pad) {
            if (tool.defaults[property] === value) return;
            /** @type {Record<string, any>} */ (tool.defaults)[property] = value;
            if (property === 'size') tool.defaults.drill = Math.min(tool.defaults.drill, value);
            tool.refreshPreview();
            refresh();
            return;
        }
        if (preview && activeProperty !== property) binding.commit();
        if (pads.every((target) => shown(target)[property] === value)) return;
        preview ??= beginPadPropertyPreview(app, pads);
        activeProperty = property;
        for (const target of preview.copies.values()) {
            /** @type {Record<string, any>} */ (target)[property] = value;
            if (property === 'size') target.drill = Math.min(target.drill, value);
            schedulePictureCopperRefresh(app, target);
        }
        renderLivePads();
        refresh();
    };
    /** @type {PadPropertyBinding} */
    const binding = {
        pads,
        affectsLayer: layerId => pads.some((target) => padLayers(target).includes(layerId)),
        get active() { return preview !== null; },
        commit: () => finish(editable()),
        cancel: () => finish(false),
        dispose: () => {
            disposed = true;
            finish(false);
            cancelLiveRender();
        },
    };
    if (!app.openPropertyPanel(describe())) return;
    setPropertyEditor(app, 'pad', binding);
}
