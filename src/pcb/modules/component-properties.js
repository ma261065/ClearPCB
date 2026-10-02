import { REF_DEFAULT_SIZE, REF_DEFAULT_STROKE } from '../../shared/pcb/footprint.js';
import { isLayerVisible } from './layers.js';
import { isRefTextLocked } from './ref-text-selection.js';
import { hasAny3DModel } from '../../components/model3d-source.js';

/**
 * @typedef {object} ComponentPropertiesCapabilities
 * @property {(id: string) => object|undefined} getPlacement
 * @property {() => boolean} isActive
 * @property {(kind: string, id: string) => boolean} isSelected
 * @property {() => Element|null} getItems Shared Properties container.
 * @property {(title: string) => void} setTitle Release the previous editor and title the shared panel.
 * @property {() => void} activateTab
 * @property {(layer: string) => string} layerLabel
 * @property {(items: Element, model: object, spec: object) => object} bindStrokeText Existing field-binding helper.
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
    /**
     * @param {ComponentPropertiesCapabilities} capabilities
     * @param {{getDocument?: () => Document}} [runtime]
     */
    constructor(capabilities, runtime = {}) {
        this.capabilities = capabilities;
        this.getDocument = runtime.getDocument || (() => document);
        this.referenceBinding = null;
        this.panel = null;
    }

    get active() { return !!this.referenceBinding?.active; }

    commit() { this.referenceBinding?.commit(); }

    cancel() { this.referenceBinding?.cancel(); }

    affectsLayer(layer) { return !!this.referenceBinding?.affectsLayer(layer); }

    clearExtras() {
        this.panel?.extra?.remove();
        if (this.panel) this.panel.extra = null;
    }

    dispose() {
        this.clearExtras();
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
        const input = /** @type {HTMLInputElement|null} */ (this.panel.items.querySelector('#pcbPropCompRot'));
        if (placement && placement === this.panel.placement && input) {
            input.value = String(((Math.round(placement.rotation || 0) % 360) + 360) % 360);
        }
    }

    showComponent(compId) {
        const items = this.capabilities.getItems();
        if (!items) return;
        this.dispose();
        this.capabilities.setTitle('Component');

        const pl = this.capabilities.getPlacement(compId);
        const retained = this.panel = { kind: 'component', id: compId, placement: pl, items, extra: null };
        const current = () => !!pl && this._isCurrent(retained);
        const editable = () => current() && !pl.locked;
        const name = pl?.name || pl?.reference || compId;
        const side = pl?.side === 'bottom' ? 'bottom' : 'top';
        const refVisible = pl?.refVisible !== false;
        const locked = !!pl?.locked;

        items.innerHTML = `
            <div class="prop-row"><label>Reference</label><span style="font-size:11px;color:var(--text-primary)">${name}</span></div>
            <label class="prop-row prop-toggle"><input type="checkbox" id="pcbPropCompLocked"${locked ? ' checked' : ''}><span>Locked</span></label>
            <label class="prop-row prop-toggle"><input type="checkbox" id="pcbPropCompRefVis"${refVisible ? ' checked' : ''}${locked ? ' disabled' : ''}><span>Show Reference</span></label>
            <div class="prop-row"><label>Layer</label><select id="pcbPropCompSide"${locked ? ' disabled' : ''}>
                <option value="top"${side === 'top' ? ' selected' : ''}>Top</option>
                <option value="bottom"${side === 'bottom' ? ' selected' : ''}>Bottom</option>
            </select></div>
            <div class="prop-row"><label>Rotation (°)</label><input type="number" id="pcbPropCompRot" data-number-format="rotation" value="${((Math.round(pl?.rotation || 0) % 360) + 360) % 360}" step="1"${locked ? ' disabled' : ''}></div>
            ${hasAny3DModel(pl) ? '<div class="prop-actions" style="margin-top:6px"><button id="pcbPropShow3D" title="Show 3D model">\uD83E\uDDCA Show 3D</button></div>' : ''}
        `;

        // Sibling ribbon-group sections (mirrors the schematic Properties
        // panel: Transform sits beside the info group horizontally).
        const document = this.getDocument();
        const panel = document.getElementById('pcbPropertiesPanel');
        const transform = document.createElement('div');
        retained.extra = transform;
        transform.className = 'ribbon-group pcb-props-extra';
        transform.innerHTML = `
            <div class="ribbon-group-title">Transform</div>
            <div class="ribbon-group-items prop-actions">
                <button id="pcbPropRotateLeft" title="Rotate Left 90°">↶ Rotate L</button>
                <button id="pcbPropRotateRight" title="Rotate Right 90°">↷ Rotate R</button>
                <button id="pcbPropFlipH" title="Flip Horizontal (X)">⇔ Flip H</button>
                <button id="pcbPropFlipV" title="Flip Vertical (Y)">⇕ Flip V</button>
            </div>
        `;
        panel?.appendChild(transform);
        for (const button of transform.querySelectorAll('button')) button.disabled = locked;

        const curRot = () => ((this.capabilities.getPlacement(compId)?.rotation || 0) % 360 + 360) % 360;

        const rotateTo = (deg) => {
            const p = this.capabilities.getPlacement(compId);
            if (!editable()) return;
            const norm = ((deg % 360) + 360) % 360;
            if ((p.rotation || 0) === norm) return;
            this.capabilities.rotate(compId, p.rotation || 0, norm);
        };

        const lockedEl = /** @type {HTMLInputElement} */ (items.querySelector('#pcbPropCompLocked'));
        lockedEl?.addEventListener('change', () => {
            if (!current() || !!pl.locked === lockedEl.checked) return;
            this.capabilities.setLocked(compId, lockedEl.checked);
        });
        const rotationEl = /** @type {HTMLInputElement|null} */ (items.querySelector('#pcbPropCompRot'));
        rotationEl?.addEventListener('change', () => {
            if (!current()) return;
            const value = Number.parseFloat(rotationEl.value);
            if (Number.isFinite(value)) rotateTo(Math.round(value));
            this.syncRotationInput(compId);
        });
        const refEl = /** @type {HTMLInputElement} */ (items.querySelector('#pcbPropCompRefVis'));
        refEl?.addEventListener('change', () => {
            if (!editable()) return;
            this.capabilities.setReferenceVisible(compId, refEl.checked);
        });
        transform.querySelector('#pcbPropRotateLeft')
            ?.addEventListener('click', () => rotateTo(curRot() - 90));
        transform.querySelector('#pcbPropRotateRight')
            ?.addEventListener('click', () => rotateTo(curRot() + 90));
        transform.querySelector('#pcbPropFlipH')
            ?.addEventListener('click', () => {
                if (!editable()) return;
                this.capabilities.flip(compId, 'H');
                this.showComponent(compId);
            });
        transform.querySelector('#pcbPropFlipV')
            ?.addEventListener('click', () => {
                if (!editable()) return;
                this.capabilities.flip(compId, 'V');
                this.showComponent(compId);
            });
        const sideEl = /** @type {HTMLSelectElement} */ (items.querySelector('#pcbPropCompSide'));
        sideEl?.addEventListener('change', () => {
            if (!editable()) return;
            this.capabilities.setSide(compId, sideEl.value === 'bottom' ? 'bottom' : 'top');
        });
        items.querySelector('#pcbPropShow3D')
            ?.addEventListener('click', () => {
                if (current()) this.capabilities.open3D(compId);
            });

        this.capabilities.activateTab();
    }

    showReference(compId) {
        const pl = this.capabilities.getPlacement(compId);
        if (!pl) return;
        const items = this.capabilities.getItems();
        if (!items) return;
        this.dispose();
        this.capabilities.setTitle('Reference');
        const retained = this.panel = { kind: 'reftext', id: compId, placement: pl, items, extra: null };
        const silkLayer = pl.side === 'bottom' ? 'bottom-silk' : 'top-silk';
        const size = pl.refSize || REF_DEFAULT_SIZE;
        const lw = pl.refStrokeWidth || REF_DEFAULT_STROKE;
        const rot = ((pl.refRot || 0) % 360 + 360) % 360;
        const disabled = isRefTextLocked(pl) ? ' disabled' : '';
        items.innerHTML = `
            <div class="prop-row"><label>Reference</label><input type="text" id="pcbPropRefName" value="${pl.reference ?? ''}" disabled></div>
            <div class="prop-row"><label>Layer</label><input type="text" id="pcbPropRefLayer" value="${this.capabilities.layerLabel(silkLayer)}" disabled></div>
            <div class="prop-row"><label>Size (mm)</label><input type="number" id="pcbPropRefSize" value="${size}" min="0.2" step="0.1"${disabled}></div>
            <div class="prop-row"><label>Rotation (°)</label><input type="number" id="pcbPropRefRot" data-number-format="rotation" value="${rot}" step="1"${disabled}></div>
            <div class="prop-row"><label>Line W (mm)</label><input type="number" id="pcbPropRefLW" value="${lw}" min="0.05" step="0.05"${disabled}></div>
        `;
        const num = (min) => (v) => {
            const n = parseFloat(v);
            if (!Number.isFinite(n)) return null;
            return min !== undefined ? Math.max(min, n) : n;
        };
        const rotParse = (v) => {
            const n = parseFloat(v);
            if (!Number.isFinite(n)) return null;
            return ((n % 360) + 360) % 360;
        };
        const styleFields = ['refSize', 'refStrokeWidth', 'refRot'];
        const restoreStyle = snapshot => {
            for (const key of styleFields) {
                if (Object.hasOwn(snapshot, key)) pl[key] = snapshot[key];
                else delete pl[key];
            }
        };
        this.referenceBinding = this.capabilities.bindStrokeText(items, pl, {
            editable: () => this._isCurrent(retained)
                && !isRefTextLocked(pl) && pl.refVisible !== false
                && isLayerVisible(pl.side === 'bottom' ? 'bottom-silk' : 'top-silk'),
            fields: [
                { id: 'pcbPropRefSize', field: 'refSize', parse: num(0.1), value: m => m.refSize || REF_DEFAULT_SIZE },
                { id: 'pcbPropRefRot', field: 'refRot', parse: rotParse, wrap: true, value: m => m.refRot || 0 },
                { id: 'pcbPropRefLW', field: 'refStrokeWidth', parse: num(0.01), value: m => m.refStrokeWidth || REF_DEFAULT_STROKE },
            ],
            preview: () => {
                this.capabilities.renderReference(compId);
                if (this.capabilities.isSelected('reftext', compId)) this.capabilities.drawReferenceOverlay(compId, true);
            },
            cancel: snapshot => {
                restoreStyle(snapshot);
                if (this.capabilities.getPlacement(compId) !== pl) return;
                this.capabilities.renderReference(compId);
                if (this.capabilities.isSelected('reftext', compId)) this.capabilities.drawReferenceOverlay(compId, false);
            },
            commit: (m, snap) => {
                const before = { refSize: snap.refSize, refStrokeWidth: snap.refStrokeWidth, refRot: snap.refRot };
                const after = { refSize: m.refSize, refStrokeWidth: m.refStrokeWidth, refRot: m.refRot };
                const changed = before.refSize !== after.refSize
                    || before.refStrokeWidth !== after.refStrokeWidth
                    || before.refRot !== after.refRot;
                if (!changed) return;
                // Capture an automatic placement's pre-preview baseline without repainting it.
                Object.assign(m, before);
                this.capabilities.setReferenceStyle(compId, before, after);
            },
        });
        this.referenceBinding.affectsLayer = layer => (pl.side === 'bottom' ? 'bottom-silk' : 'top-silk') === layer;
        this.capabilities.activateTab();
    }
}
