/**
 * Properties panel for pads: one or more selected pads, or the Pad tool's defaults
 * (`pad` null). The editor passes in the tool state the panel needs: the defaults
 * object it edits and a callback that redraws the placement preview.
 */
import { refreshBoxSelectionHighlights } from './box-select.js';
import { isLayerVisible } from './layers.js';
import { bindLockedProperty, isPcbObjectLocked, lockedPropertyHtml } from './object-locks.js';
import { ModifyPadCommand, beginPadPropertyPreview, canonicalPad, finishPadPropertyPreview } from './pad-commands.js';
import { padLayers, renderPad } from './pad.js';
import { bindPictureRefreshHold, schedulePictureCopperRefresh } from './picture-refresh.js';
import { setPropertyEditor } from './property-editors.js';
import { getPcbSelection } from './selection-registry.js';
import { CompoundCommand } from './track-commands.js';
import { isEditorActive } from './pcb-editor-api.js';
import { bindSettledChange } from '../../shared/ui/settled-input.js';

export function showPadEditor(app, pad, tool) {
    const items = app.propertiesItems();
    if (!items) return;
    if (pad) pad = canonicalPad(app, pad);
    const state = pad || tool.defaults;
    const selectedPads = pad ? getPcbSelection(app, 'pad').map(target => canonicalPad(app, target)) : [];
    const pads = pad && selectedPads.includes(pad) ? selectedPads : (pad ? [pad] : []);
    const isMixed = property => pads.some(target => target[property] !== state[property]);
    const mixedShape = isMixed('shape');
    const mixedSize = isMixed('size');
    const mixedRatio = isMixed('ratio');
    const mixedDrill = isMixed('drill');
    const mixedRotation = isMixed('rotation');
    const mixedLayers = isMixed('layers');
    const mixedNet = pads.some(target => (target.net || '') !== (state.net || ''));
    const elongated = ['stadium', 'rectangle', 'oval'].includes(state.shape);
    const showRatio = pad ? pads.some(target => ['stadium', 'rectangle', 'oval'].includes(target.shape)) : elongated;
    const showRotation = pad ? pads.some(target => target.shape !== 'round') : state.shape !== 'round';
    const maximumDrill = pad ? Math.min(...pads.map(target => target.size)) : state.size;
    const { escape, options } = app.toolNetOptions(state.net || '');
    app.setPropertiesTitle(pad ? 'Pad' : 'New Pad');
    const lockEntries = pads.map(target => ({ kind: 'pad', object: target }));
    items.innerHTML = `
        ${pad ? lockedPropertyHtml(app, lockEntries) : ''}
        <div class="prop-row" data-prop="padShape"><label>Shape</label><select id="pcbPropPadShape">
            ${mixedShape ? '<option value="" selected disabled>Mixed</option>' : ''}
            ${[['round', 'Round'], ['stadium', 'Stadium'], ['square', 'Square'], ['rectangle', 'Rectangle'], ['oval', 'Oval']]
                .map(([value, label]) => `<option value="${value}"${!mixedShape && state.shape === value ? ' selected' : ''}>${label}</option>`).join('')}
        </select></div>
        <div class="prop-row" data-prop="layer"><label>Layer</label><select id="pcbPropPadLayers">
            ${mixedLayers ? '<option value="" selected disabled>Mixed</option>' : ''}
            <option value="top-copper"${!mixedLayers && state.layers === 'top-copper' ? ' selected' : ''}>Top</option>
            <option value="bottom-copper"${!mixedLayers && state.layers === 'bottom-copper' ? ' selected' : ''}>Bottom</option>
            <option value="both"${!mixedLayers && state.layers === 'both' ? ' selected' : ''}>Both</option>
        </select></div>
        <div class="prop-row" data-prop="net"><label>Net</label><span class="prop-net-control"><input type="text" id="pcbPropPadNet" value="${mixedNet ? '' : escape(state.net || '')}" placeholder="${mixedNet ? 'Mixed' : 'None'}"><details class="prop-net-menu"><summary aria-label="Select existing net"></summary><div>${options}</div></details></span></div>
        <div class="prop-row" data-prop="size"><label>Size (mm)</label><input type="number" id="pcbPropPadSize" value="${mixedSize ? '' : state.size}" placeholder="${mixedSize ? 'Mixed' : ''}" min="0.05" step="0.05"></div>
        ${showRatio ? `<div class="prop-row" data-prop="ratio"><label>Ratio</label><input type="number" id="pcbPropPadRatio" value="${mixedRatio ? '' : state.ratio}" placeholder="${mixedRatio ? 'Mixed' : ''}" min="1" step="0.1"></div>` : ''}
        <div class="prop-row" data-prop="drill"><label>Drill (mm)</label><input type="number" id="pcbPropPadDrill" value="${mixedDrill ? '' : state.drill}" placeholder="${mixedDrill ? 'Mixed' : ''}" min="0" max="${maximumDrill}" step="0.05" title="0 = no hole"></div>
        ${showRotation ? `<div class="prop-row" data-prop="rotation"><label>Rotation (°)</label><input type="number" id="pcbPropPadRotation" value="${mixedRotation ? '' : state.rotation}" placeholder="${mixedRotation ? 'Mixed' : ''}" step="1"></div>` : ''}
    `;
    let disposed = false;
    let preview = null;
    let activeProperty = null;
    const fields = new Map();
    const minimums = new Map();
    const apply = (property, value) => {
        if (disposed || (pad && !editable())) return;
        finish(true);
        if (pad) {
            const commands = [];
            for (const target of pads) {
                const before = target.captureState();
                const after = { ...before, [property]: value };
                if (property === 'size') after.drill = Math.min(after.drill, value);
                if (JSON.stringify(after) !== JSON.stringify(before)) {
                    commands.push(new ModifyPadCommand(app, target, before, after));
                }
            }
            if (!commands.length) return;
            app.history.execute(commands.length === 1 ? commands[0] : new CompoundCommand(commands));
            refreshBoxSelectionHighlights(app);
        } else {
            tool.defaults[property] = value;
            if (property === 'size') tool.defaults.drill = Math.min(tool.defaults.drill, value);
            tool.refreshPreview();
        }
    };
    items.querySelector('#pcbPropPadShape')?.addEventListener('change', event => {
        if (disposed) return;
        apply('shape', event.target.value);
        showPadEditor(app, pad, tool);
    });
    items.querySelector('#pcbPropPadLayers')?.addEventListener('change', event => apply('layers', event.target.value));
    let renderFrame = null;
    const renderLivePads = () => {
        if (!pad || renderFrame !== null) return;
        renderFrame = requestAnimationFrame(() => {
            renderFrame = null;
            for (const target of preview?.copies.values() || []) renderPad(target, layer => app.getLayerGroup(layer));
            refreshBoxSelectionHighlights(app);
        });
    };
    const cancelLiveRender = () => {
        if (renderFrame === null) return;
        cancelAnimationFrame(renderFrame);
        renderFrame = null;
    };
    const resetFields = () => {
        for (const [property, input] of fields) {
            input.value = pads.some(target => target[property] !== pad[property]) ? '' : String(pad[property]);
        }
        const drillInput = fields.get('drill');
        if (drillInput && pad) drillInput.max = String(Math.min(...pads.map(target => target.size)));
    };
    const finish = commit => {
        if (!preview) return;
        if (commit && !editable()) commit = false;
        const input = fields.get(activeProperty);
        if (commit && (!input?.value.trim() || !Number.isFinite(Number(input.value))
            || Number(input.value) < minimums.get(activeProperty))) commit = false;
        preview = null;
        activeProperty = null;
        cancelLiveRender();
        let committed = false;
        try {
            finishPadPropertyPreview(app, commit ? changes => {
                const commands = changes.map(({ pad, before, after }) => new ModifyPadCommand(app, pad, before, after));
                app.history.execute(commands.length === 1 ? commands[0] : new CompoundCommand(commands));
            } : undefined);
            committed = commit;
        } finally {
            if (!committed) resetFields();
            refreshBoxSelectionHighlights(app);
        }
    };
    const editable = () => !disposed && isEditorActive(app) && (!pad || pads.every(target => !isPcbObjectLocked(app, 'pad', target)
        && target.visible !== false && padLayers(target).some(isLayerVisible)));
    const binding = {
        pads,
        affectsLayer: layerId => pads.some(target => padLayers(target).includes(layerId)),
        get active() { return preview !== null; },
        commit: () => finish(editable()),
        cancel: () => finish(false),
        dispose: () => {
            disposed = true;
            finish(false);
            cancelLiveRender();
        },
    };
    setPropertyEditor(app, 'pad', binding);
    const bindLiveNumber = (id, property, minimum) => {
        const input = /** @type {HTMLInputElement|null} */ (items.querySelector(id));
        if (!input) return;
        fields.set(property, input);
        minimums.set(property, minimum);
        bindPictureRefreshHold(app, input);
        const onInput = () => {
            if (!editable()) {
                binding.cancel();
                return;
            }
            if (!input.value.trim()) return;
            let value = Number(input.value);
            if (!Number.isFinite(value) || value < minimum) return;
            if (property === 'rotation') {
                value = ((value % 360) + 360) % 360;
                if (Number(input.value) !== value) input.value = String(value);
            }
            if (property === 'drill') {
                const max = pad ? Math.min(...pads.map(target => preview?.copies.get(target).size ?? target.size)) : state.size;
                value = Math.min(value, max);
                if (Number(input.value) !== value) input.value = String(value);
            }
            if (!pad) {
                if (tool.defaults[property] === value) return;
                tool.defaults[property] = value;
                if (property === 'size') {
                    const drillInput = /** @type {HTMLInputElement|null} */ (items.querySelector('#pcbPropPadDrill'));
                    if (drillInput) drillInput.max = String(value);
                    if (tool.defaults.drill > value) {
                        tool.defaults.drill = value;
                        if (drillInput) drillInput.value = String(value);
                    }
                }
                tool.refreshPreview();
                return;
            }
            if (preview && activeProperty !== property) {
                const pending = input.value;
                binding.commit();
                input.value = pending;
            }
            if (pads.every(target => (preview?.copies.get(target) || target)[property] === value)) return;
            preview ??= beginPadPropertyPreview(app, pads);
            activeProperty = property;
            for (const target of preview.copies.values()) {
                target[property] = value;
                if (property === 'size') target.drill = Math.min(target.drill, value);
                schedulePictureCopperRefresh(app, target);
            }
            if (property === 'size') {
                const drillInput = /** @type {HTMLInputElement|null} */ (items.querySelector('#pcbPropPadDrill'));
                if (drillInput) drillInput.max = String(value);
            }
            renderLivePads();
        };
        input.addEventListener('input', onInput);
        input.addEventListener('change', onInput);
        bindSettledChange(input, () => binding.commit());
        input.addEventListener('keydown', event => {
            if (disposed || event.key !== 'Escape') return;
            binding.cancel();
            event.preventDefault();
            event.stopPropagation();
        });
    };
    bindLiveNumber('#pcbPropPadSize', 'size', 0.05);
    bindLiveNumber('#pcbPropPadRatio', 'ratio', 1);
    bindLiveNumber('#pcbPropPadDrill', 'drill', 0);
    bindLiveNumber('#pcbPropPadRotation', 'rotation', -Infinity);
    app.bindToolNetControl(items, 'pcbPropPadNet', next => apply('net', next));
    if (pad) bindLockedProperty(app, items, lockEntries);
    app.showPropertiesTab?.();
}
