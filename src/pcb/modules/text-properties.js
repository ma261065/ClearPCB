/**
 * Properties panels for PCB free text: the Text tool's defaults and a selected text,
 * plus the stroke-text field binder they share with the reference-designator panel.
 * The editor passes in the state these panels need (tool defaults, inline-edit state)
 * rather than the panels reaching into it.
 */
import { displayRotationDegrees } from '../../core/number-inputs.js';
import { TEXT_LAYERS } from '../../core/pcb-text.js';
import { measureText as measureStrokeText } from '../../shared/pcb/stroke-font.js';
import { isLayerVisible } from './layers.js';
import { bindLockedProperty, boardShapeLocked, lockedPropertyHtml } from './object-locks.js';
import { bindPictureRefreshHold, schedulePictureCopperRefresh } from './picture-refresh.js';
import { setPropertyEditor } from './property-editors.js';
import { EditTextCommand, beginTextPropertyPreview, finishTextPropertyPreview } from './text-commands.js';
import { isEditorActive } from './pcb-editor-api.js';
import { bindSettledChange } from '../../shared/ui/settled-input.js';

/** Show Text drawing defaults in Properties. */
export function showTextToolProperties(app, defaults) {
    const d = defaults;
    const items = app.propertiesItems();
    if (!items) return;
    const layerOpts = TEXT_LAYERS.map(layer =>
        `<option value="${layer}"${layer === d.layer ? ' selected' : ''}>${app.layerLabel(layer)}</option>`
    ).join('');
    app.setPropertiesTitle('New Text');
    items.innerHTML = `
        <div class="prop-row" data-prop="layer"><label>Layer</label><select id="pcbPropTextToolLayer">${layerOpts}</select></div>
        <div class="prop-row" data-prop="fontSize"><label>Text Size (mm)</label><input type="number" id="pcbPropTextToolSize" value="${d.size}" min="0.2" max="20" step="0.1"></div>
        <div class="prop-row" data-prop="lineWidth"><label>Line Width (mm)</label><input type="number" id="pcbPropTextToolLW" value="${d.strokeWidth}" min="0.05" max="2" step="0.05"></div>
        <div class="prop-row" data-prop="rotation"><label>Rotation (°)</label><input type="number" id="pcbPropTextToolRot" data-number-format="rotation" value="${displayRotationDegrees(d.rotation)}" step="1"></div>
        <div class="prop-row" data-prop="border"><label><input type="checkbox" id="pcbPropTextToolBorder"${d.border ? ' checked' : ''}> Border</label></div>
    `;
    const layerEl = /** @type {HTMLSelectElement|null} */ (items.querySelector('#pcbPropTextToolLayer'));
    const sizeEl = /** @type {HTMLInputElement|null} */ (items.querySelector('#pcbPropTextToolSize'));
    const rotationEl = /** @type {HTMLInputElement|null} */ (items.querySelector('#pcbPropTextToolRot'));
    const lineWidthEl = /** @type {HTMLInputElement|null} */ (items.querySelector('#pcbPropTextToolLW'));
    const borderEl = /** @type {HTMLInputElement|null} */ (items.querySelector('#pcbPropTextToolBorder'));
    layerEl?.addEventListener('change', () => {
        if (TEXT_LAYERS.includes(layerEl.value)) defaults.layer = layerEl.value;
        app.setPcbStatus();
    });
    sizeEl?.addEventListener('input', () => {
        const size = parseFloat(sizeEl.value);
        if (Number.isFinite(size) && size > 0) defaults.size = size;
    });
    rotationEl?.addEventListener('input', () => {
        const rotation = parseFloat(rotationEl.value);
        if (Number.isFinite(rotation)) {
            defaults.rotation = ((Math.round(rotation) % 360) + 360) % 360;
            rotationEl.value = String(defaults.rotation);
        }
    });
    lineWidthEl?.addEventListener('input', () => {
        const lineWidth = parseFloat(lineWidthEl.value);
        if (Number.isFinite(lineWidth) && lineWidth > 0) defaults.strokeWidth = lineWidth;
    });
    borderEl?.addEventListener('change', () => {
        defaults.border = borderEl.checked;
    });
    app.showPropertiesTab?.();
}

/**
 * Show properties for the given text and switch to Properties tab.
 * Editing pushes EditTextCommand on `change` (not per keystroke) so
 * undo collapses each edit into one entry.
 * @param {any} app
 * @param {any} text
 * @param {() => any} [textEdit] The editor's inline text edit, if any.
 */
export function showTextProperties(app, text, textEdit = () => null) {
    text = app.pcbDocument.texts.get(text.id);
    const items = app.propertiesItems();
    if (!items) return;
    app.setPropertiesTitle('Text');
    const disabled = boardShapeLocked(text) ? ' disabled' : '';
    const layerOpts = TEXT_LAYERS.map(l =>
        `<option value="${l}" ${l === text.layer ? 'selected' : ''}>${app.layerLabel(l)}</option>`
    ).join('');
    const isEditingThis = textEdit()?.text?.id === text.id;
    const insertRow = isEditingThis ? `
        <div class="prop-row" data-prop="insert"><label>Insert</label><select id="pcbPropTextInsert"${disabled}>
            <option value="">Symbol…</option>
            <option value="\u00A9">© Copyright</option>
            <option value="\u00AE">® Registered</option>
            <option value="\u2122">™ Trademark</option>
            <option value="\u00B0">° Degree</option>
            <option value="\u00B5">µ Micro</option>
            <option value="\u03A9">Ω Ohm</option>
            <option value="\u00B1">± Plus-minus</option>
            <option value="\u00D7">× Times</option>
            <option value="\u00F7">÷ Divide</option>
        </select></div>` : '';
    const lockEntries = [{ kind: 'text', object: text }];
    items.innerHTML = `
        ${lockedPropertyHtml(app, lockEntries)}
        ${insertRow}
        <div class="prop-row" data-prop="layer"><label>Layer</label><select id="pcbPropTextLayer"${disabled}>${layerOpts}</select></div>
        <div class="prop-row" data-prop="fontSize"><label>Text Size (mm)</label><input type="number" id="pcbPropTextSize" value="${text.size}" min="0.2" step="0.1"${disabled}></div>
        <div class="prop-row" data-prop="lineWidth"><label>Line Width (mm)</label><input type="number" id="pcbPropTextLW" value="${text.strokeWidth}" min="0.05" step="0.05"${disabled}></div>
        <div class="prop-row" data-prop="rotation"><label>Rotation (°)</label><input type="number" id="pcbPropTextRot" data-number-format="rotation" value="${displayRotationDegrees(text.rotation)}" step="1"${disabled}></div>
        <div class="prop-row" data-prop="border"><label><input type="checkbox" id="pcbPropTextBorder"${text.border ? ' checked' : ''}${disabled}> Border</label></div>
    `;
    // Snapshot at first edit so undo collapses keystrokes into a
    // single command per field. The field binding/commit machinery is
    // shared with the reference-designator panel via _bindStrokeTextProps.
    const layerApply = (model, v) => {
        // Layer change: if mirror flips (top↔bottom), the rendered
        // text reflects about its anchor x and visually jumps. Shift
        // the anchor by the text width (rotated into world space) so
        // the visible glyphs stay put.
        const wasBottom = typeof model.layer === 'string' && model.layer.startsWith('bottom-');
        const willBottom = typeof v === 'string' && v.startsWith('bottom-');
        if (wasBottom !== willBottom) {
            const content = textEdit()?.text?.id === model.id ? textEdit().text.content : model.content;
            const w = measureStrokeText(content, model.size);
            const sign = willBottom ? 1 : -1; // top→bottom: +w; bottom→top: -w
            const rot = (model.rotation || 0) * Math.PI / 180;
            // SVG-Y-down with rotate(-rot): dx,dy in local frame map
            // to (cos(rot)*dx, -sin(rot)*dx) in world.
            model.x += sign * w * Math.cos(rot);
            model.y += sign * w * -Math.sin(rot);
        }
        model.layer = v;
    };
    const num = (min) => (v) => {
        const n = parseFloat(v);
        if (!Number.isFinite(n)) return null;
        return min !== undefined ? Math.max(min, n) : n;
    };
    const rotParse = (v) => {
        const n = parseFloat(v);
        if (!Number.isFinite(n)) return null;
        return ((Math.round(n) % 360) + 360) % 360;
    };
    setPropertyEditor(app, 'text', bindStrokeTextProps(app, items, text, {
        editable: () => isEditorActive(app) && app.pcbDocument.texts.get(text.id) === text
            && !boardShapeLocked(text) && isLayerVisible(text.layer),
        fields: [
            { id: 'pcbPropTextLayer', field: 'layer', parse: (v) => TEXT_LAYERS.includes(v) ? v : null, apply: layerApply },
            { id: 'pcbPropTextSize', field: 'size', parse: num(0.1) },
            { id: 'pcbPropTextRot', field: 'rotation', parse: rotParse, wrap: true },
            { id: 'pcbPropTextLW', field: 'strokeWidth', parse: num(0.01) },
        ],
        begin: (t) => beginTextPropertyPreview(app, t.id),
        cancel: () => finishTextPropertyPreview(app),
        preview: (t) => app.refreshText(t.id),
        commit: (t, snap) => {
            const after = {};
            for (const k of ['layer', 'size', 'rotation', 'strokeWidth', 'x', 'y']) {
                if (snap[k] !== t[k]) {
                    after[k] = t[k];
                }
            }
            finishTextPropertyPreview(app, Object.keys(after).length
                ? () => app.history.execute(new EditTextCommand(app, t.id, after)) : undefined);
        },
    }));
    const borderEl = /** @type {HTMLInputElement|null} */ (items.querySelector('#pcbPropTextBorder'));
    borderEl?.addEventListener('change', () => {
        if (boardShapeLocked(text)) return;
        app.history.execute(new EditTextCommand(app, text.id, { border: borderEl.checked }));
    });
    // Insert-symbol dropdown: insert at caret when inline-editing,
    // otherwise append to the text via an EditTextCommand. Resets
    // to the placeholder after each selection so the same symbol
    // can be inserted again.
    const insertEl = /** @type {HTMLSelectElement|null} */
        (document.getElementById('pcbPropTextInsert'));
    insertEl?.addEventListener('change', () => {
        const sym = insertEl.value;
        insertEl.value = '';
        if (!sym || boardShapeLocked(text)) return;
        const edit = textEdit();
        if (edit && edit.text?.id === text.id) {
            const inp = edit.input;
            const sel = inp.selectionStart ?? inp.value.length;
            const end = inp.selectionEnd ?? sel;
            inp.value = inp.value.slice(0, sel) + sym + inp.value.slice(end);
            const pos = sel + sym.length;
            try { inp.setSelectionRange(pos, pos); } catch { /* */ }
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            inp.focus();
        } else {
            app.history.execute(new EditTextCommand(app, text.id,
                { content: (text.content || '') + sym }));
        }
    });
    bindLockedProperty(app, items, lockEntries);

    app.showPropertiesTab?.();
}

/**
 * Shared field-binding machinery for the stroke-text style panels (Text
 * objects and reference designators). For each spec field it wires the
 * input/change events so edits update the selected preview (via spec.preview)
 * and collapse into a single undo entry on commit (via spec.commit). A
 * snapshot of the model is taken on the first keystroke so spec.commit
 * can diff against the pre-edit state.
 * @param {Element} items container holding the inputs
 * @param {any} model object whose fields the inputs drive
 * @param {{fields: Array<{id:string, field:string, parse:(v:string)=>any, apply?:(m:any,v:any)=>void, value?:(m:any)=>any, wrap?:boolean}>, editable?:()=>boolean, begin?:(m:any)=>any, cancel?:(snap:any)=>void, preview:(m:any)=>void, commit:(m:any, snap:any)=>void}} spec
 */
export function bindStrokeTextProps(app, items, model, spec) {
    let snapshot = null;
    let target = model;
    let disposed = false;
    let activeField = null;
    const controls = new Map(spec.fields.map(f => [f, items.querySelector('#' + f.id)]));
    const editable = () => !disposed && (!spec.editable || spec.editable());
    const resetFields = () => {
        for (const f of spec.fields) {
            const el = controls.get(f);
            const value = f.value ? f.value(model) : model[f.field];
            if (el) el.value = String(f.wrap ? Math.round(value) % 360 : value);
        }
    };
    const onInput = (f) => () => {
        if (disposed) return;
        if (!editable()) { binding.cancel(); return; }
        const el = controls.get(f);
        if (snapshot && activeField !== f) {
            const pending = el.value;
            onCommit();
            el.value = pending;
        }
        const v = f.parse(el ? el.value : '');
        if (v === null || v === undefined) return;
        if (target[f.field] === v) return;
        if (!snapshot) {
            target = spec.begin ? spec.begin(model) : model;
            snapshot = { ...target };
        }
        activeField = f;
        if (f.apply) f.apply(target, v); else target[f.field] = v;
        if (typeof target.content === 'string') schedulePictureCopperRefresh(app, target);
        spec.preview(target);
    };
    const onCommit = () => {
        if (disposed || !snapshot) return;
        if (!editable() || activeField.parse(controls.get(activeField)?.value || '') == null) {
            binding.cancel();
            return;
        }
        const snap = snapshot;
        snapshot = null;
        activeField = null;
        const edited = target;
        target = model;
        let committed = false;
        try {
            spec.commit(edited, snap);
            committed = true;
        } finally {
            if (!committed) {
                spec.cancel?.(snap);
                resetFields();
            }
        }
    };
    for (const f of spec.fields) {
        const el = controls.get(f);
        if (!el) continue;
        bindPictureRefreshHold(app, el);
        const handler = onInput(f);
        el.addEventListener('input', handler);
        // Spinner step clicks on number inputs fire 'change' without 'input'.
        el.addEventListener('change', handler);
        if (el.type === 'number') bindSettledChange(el, onCommit);
        else el.addEventListener('change', onCommit);
        el.addEventListener('keydown', event => {
            if (disposed || event.key !== 'Escape' || !snapshot) return;
            binding.cancel();
            event.preventDefault();
            event.stopPropagation();
        });
        if (f.wrap) {
            const wrapDeg = () => {
                if (disposed) return;
                const n = parseFloat(el.value);
                if (!Number.isFinite(n)) return;
                const wrapped = ((Math.round(n) % 360) + 360) % 360;
                if (wrapped !== n) el.value = String(wrapped);
            };
            el.addEventListener('change', wrapDeg);
        }
    }
    const binding = {
        model,
        affectsLayer: layerId => model.layer === layerId,
        get active() { return snapshot !== null; },
        commit: onCommit,
        cancel: () => {
            if (!snapshot) return;
            const snap = snapshot;
            snapshot = null;
            activeField = null;
            target = model;
            spec.cancel?.(snap);
            resetFields();
        },
        dispose: () => {
            if (disposed) return;
            try { binding.cancel(); } finally { disposed = true; }
        },
    };
    return binding;
}
