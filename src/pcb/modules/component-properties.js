import { REF_DEFAULT_SIZE, REF_DEFAULT_STROKE } from '../../shared/pcb/footprint.js';
import { isLayerVisible } from './layers.js';
import { isRefTextLocked } from './ref-text-selection.js';
import { hasAny3DModel } from '../../components/model3d-source.js';

const wrapDegrees = value => ((value % 360) + 360) % 360;
const roundDegrees = value => ((Math.round(value) % 360) + 360) % 360;
const numberParse = (min, normalize = value => value) => text => {
    const value = Number.parseFloat(text);
    if (!Number.isFinite(value)) return null;
    return normalize(min === undefined ? value : Math.max(min, value));
};

/**
 * @typedef {object} ComponentPropertiesCapabilities
 * @property {(id: string) => object|undefined} getPlacement
 * @property {() => boolean} isActive
 * @property {(kind: string, id: string) => boolean} isSelected
 * @property {(panel: import('../../shared/ui/property-fields.js').PropertyPanel, owner?: object|null) => boolean} openPanel
 * @property {(panel: import('../../shared/ui/property-fields.js').PropertyPanel) => void} refreshPanel
 * @property {(layer: string) => string} layerLabel
 * @property {(model: object, spec: object) => object} bindStrokeText Existing field-binding helper.
 * @property {(id: string, before: number, after: number) => void} rotate
 * @property {(id: string, locked: boolean) => void} setLocked Finish selection interaction, then execute the lock command.
 * @property {(id: string, visible: boolean) => void} setReferenceVisible
 * @property {(id: string, side: string) => void} setSide
 * @property {(id: string, axis: string) => void} flip
 * @property {(id: string) => void} open3D
 * @property {(id: string) => void} renderReference
 * @property {(id: string, tether: boolean) => void} drawReferenceOverlay
 * @property {(id: string, before: object, after: object) => void} setReferenceStyle
 */
export class ComponentProperties {
    /** @param {ComponentPropertiesCapabilities} capabilities */
    constructor(capabilities) {
        this.capabilities = capabilities;
        this.referenceBinding = null;
        this.panel = null;
    }

    get active() { return !!this.referenceBinding?.active; }

    commit() { this.referenceBinding?.commit(); }

    cancel() { this.referenceBinding?.cancel(); }

    affectsLayer(layer) { return !!this.referenceBinding?.affectsLayer(layer); }

    dispose() {
        this.panel = null;
        const binding = this.referenceBinding;
        this.referenceBinding = null;
        binding?.dispose();
    }

    _isCurrent(panel) {
        return this.panel === panel && this.capabilities.isActive()
            && this.capabilities.getPlacement(panel.id) === panel.placement;
    }

    syncRotationInput(compId) {
        if (!this.capabilities.isSelected('component', compId)) return;
        if (this.panel?.kind !== 'component' || this.panel.id !== compId) return;
        const placement = this.capabilities.getPlacement(compId);
        if (placement && placement === this.panel.placement) this._refresh(this.panel.describe());
    }

    _refresh(panel) {
        if (this.panel) this.capabilities.refreshPanel(panel);
    }

    showComponent(compId) {
        this.dispose();
        const placement = this.capabilities.getPlacement(compId);
        if (!placement) return false;
        const retained = this.panel = { kind: 'component', id: compId, placement, describe: null };
        const current = () => !!placement && this._isCurrent(retained);
        const editable = () => current() && !placement.locked;
        const refresh = () => { if (this._isCurrent(retained)) this._refresh(describe()); };
        const curRot = () => wrapDegrees(this.capabilities.getPlacement(compId)?.rotation || 0);
        const rotateTo = degrees => {
            const live = this.capabilities.getPlacement(compId);
            if (!editable() || !live) return;
            const normalized = roundDegrees(degrees);
            if ((live.rotation || 0) === normalized) { refresh(); return; }
            this.capabilities.rotate(compId, live.rotation || 0, normalized);
            refresh();
        };
        const describe = () => {
            const live = this.capabilities.getPlacement(compId) || placement;
            const locked = !!live.locked;
            const side = live.side === 'bottom' ? 'bottom' : 'top';
            const name = live.name || live.reference || compId;
            /** @type {import('../../shared/ui/property-fields.js').PropertyActionGroup[]} */
            const actions = [{
                title: 'Transform',
                actions: [
                    { id: 'pcbPropRotateLeft', label: '\u21B6 Rotate L', title: 'Rotate Left 90\u00B0',
                        disabled: locked, run: () => rotateTo(curRot() - 90) },
                    { id: 'pcbPropRotateRight', label: '\u21B7 Rotate R', title: 'Rotate Right 90\u00B0',
                        disabled: locked, run: () => rotateTo(curRot() + 90) },
                    { id: 'pcbPropFlipH', label: '\u21D4 Flip H', title: 'Flip Horizontal (X)',
                        disabled: locked, run: () => {
                            if (!editable()) return;
                            this.capabilities.flip(compId, 'H');
                            this.showComponent(compId);
                        } },
                    { id: 'pcbPropFlipV', label: '\u21D5 Flip V', title: 'Flip Vertical (Y)',
                        disabled: locked, run: () => {
                            if (!editable()) return;
                            this.capabilities.flip(compId, 'V');
                            this.showComponent(compId);
                        } },
                ],
            }];
            // Viewing the model edits nothing, so it stays available on a locked part.
            if (hasAny3DModel(live)) actions.push({ title: '3D', actions: [
                { id: 'pcbPropShow3D', label: '\uD83E\uDDCA Show 3D', title: 'Show 3D model',
                    run: () => { if (current()) this.capabilities.open3D(compId); } },
            ] });
            /** @type {import('../../shared/ui/property-fields.js').PropertyPanel} */
            const panel = {
                title: 'Component',
                fields: [
                    { key: 'locked', id: 'pcbPropCompLocked', type: 'checkbox', label: 'Locked',
                        value: locked, commit: value => {
                            if (!current() || !!placement.locked === value) return;
                            this.capabilities.setLocked(compId, value);
                            refresh();
                        } },
                    { key: 'reference', type: 'readout', label: 'Reference', value: name },
                    { key: 'showReference', id: 'pcbPropCompRefVis', type: 'checkbox', label: 'Show Reference',
                        value: live.refVisible !== false, disabled: locked, commit: value => {
                            if (!editable()) return;
                            this.capabilities.setReferenceVisible(compId, value);
                            refresh();
                        } },
                    { key: 'layer', id: 'pcbPropCompSide', type: 'select', label: 'Layer', value: side,
                        disabled: locked, options: [{ value: 'top', label: 'Top' }, { value: 'bottom', label: 'Bottom' }],
                        commit: value => {
                            if (!editable()) return;
                            this.capabilities.setSide(compId, value === 'bottom' ? 'bottom' : 'top');
                            refresh();
                        } },
                    { key: 'rotation', id: 'pcbPropCompRot', type: 'number', label: 'Rotation (\u00B0)',
                        value: roundDegrees(live.rotation || 0), step: 1, numberFormat: 'rotation',
                        disabled: locked, normalize: roundDegrees, commit: value => rotateTo(value),
                        cancel: () => { refresh(); return true; } },
                ],
                actions,
            };
            return panel;
        };
        retained.describe = describe;
        return this.capabilities.openPanel(describe(), this);
    }

    showReference(compId) {
        this.dispose();
        const placement = this.capabilities.getPlacement(compId);
        if (!placement) return false;
        const retained = this.panel = { kind: 'reftext', id: compId, placement, describe: null };
        const silkLayer = () => placement.side === 'bottom' ? 'bottom-silk' : 'top-silk';
        const styleFields = ['refSize', 'refStrokeWidth', 'refRot'];
        const restoreStyle = snapshot => {
            for (const key of styleFields) {
                if (Object.hasOwn(snapshot, key)) placement[key] = snapshot[key];
                else delete placement[key];
            }
        };
        const refresh = () => { if (this._isCurrent(retained)) this._refresh(describe()); };
        const binding = this.referenceBinding = this.capabilities.bindStrokeText(placement, {
            refresh,
            editable: () => this._isCurrent(retained)
                && !isRefTextLocked(placement) && placement.refVisible !== false
                && isLayerVisible(silkLayer()),
            fields: [
                { key: 'fontSize', id: 'pcbPropRefSize', type: 'number', label: 'Text Size (mm)', field: 'refSize',
                    min: 0.2, step: 0.1, parse: numberParse(0.1), value: model => model.refSize || REF_DEFAULT_SIZE },
                { key: 'rotation', id: 'pcbPropRefRot', type: 'number', label: 'Rotation (\u00B0)', field: 'refRot',
                    step: 1, numberFormat: 'rotation', parse: numberParse(undefined, wrapDegrees), wrap: true,
                    value: model => wrapDegrees(model.refRot || 0) },
                { key: 'lineWidth', id: 'pcbPropRefLW', type: 'number', label: 'Line Width (mm)', field: 'refStrokeWidth',
                    min: 0.05, step: 0.05, parse: numberParse(0.01), value: model => model.refStrokeWidth || REF_DEFAULT_STROKE },
            ],
            preview: () => {
                this.capabilities.renderReference(compId);
                if (this.capabilities.isSelected('reftext', compId)) this.capabilities.drawReferenceOverlay(compId, true);
            },
            cancel: snapshot => {
                restoreStyle(snapshot);
                if (this.capabilities.getPlacement(compId) !== placement) return;
                this.capabilities.renderReference(compId);
                if (this.capabilities.isSelected('reftext', compId)) this.capabilities.drawReferenceOverlay(compId, false);
            },
            commit: (model, snapshot) => {
                const before = { refSize: snapshot.refSize, refStrokeWidth: snapshot.refStrokeWidth, refRot: snapshot.refRot };
                const after = { refSize: model.refSize, refStrokeWidth: model.refStrokeWidth, refRot: model.refRot };
                const changed = before.refSize !== after.refSize
                    || before.refStrokeWidth !== after.refStrokeWidth
                    || before.refRot !== after.refRot;
                if (!changed) return;
                Object.assign(model, before);
                this.capabilities.setReferenceStyle(compId, before, after);
            },
        });
        binding.affectsLayer = layer => silkLayer() === layer;
        const describe = () => {
            const disabled = isRefTextLocked(placement);
            /** @type {import('../../shared/ui/property-fields.js').PropertyPanel} */
            const panel = {
                title: 'Reference',
                fields: [
                    { key: 'reference', id: 'pcbPropRefName', type: 'readout', label: 'Reference', value: placement.reference ?? '' },
                    { key: 'layer', id: 'pcbPropRefLayer', type: 'readout', label: 'Layer',
                        value: this.capabilities.layerLabel(silkLayer()) },
                    ...binding.fields(disabled),
                ],
            };
            return panel;
        };
        retained.describe = describe;
        if (!this.capabilities.openPanel(describe(), this)) {
            this.dispose();
            return false;
        }
        return true;
    }
}
