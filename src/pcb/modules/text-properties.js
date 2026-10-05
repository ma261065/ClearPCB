/**
 * Properties panels for PCB free text: the Text tool's defaults and a selected text,
 * plus the stroke-text field binding they share with the reference-designator panel.
 * Panels describe fields only; shared/ui/property-fields.js owns the DOM.
 */
import { displayRotationDegrees } from '../../core/number-inputs.js';
import { TEXT_LAYERS } from '../../core/pcb-text.js';
import { measureText as measureStrokeText } from '../../shared/pcb/stroke-font.js';
import { pcbLayerOption, isLayerVisible } from './layers.js';
import { boardShapeLocked, lockedProperty } from './object-locks.js';
import { pictureRefreshHold, schedulePictureCopperRefresh } from './picture-refresh.js';
import { setPropertyEditor } from './property-editors.js';
import { EditTextCommand, beginTextPropertyPreview, finishTextPropertyPreview } from './text-commands.js';
import { isEditorActive } from './pcb-editor-api.js';

const SYMBOLS = [
    ['', 'Symbol\u2026'],
    ['\u00A9', '\u00A9 Copyright'],
    ['\u00AE', '\u00AE Registered'],
    ['\u2122', '\u2122 Trademark'],
    ['\u00B0', '\u00B0 Degree'],
    ['\u00B5', '\u00B5 Micro'],
    ['\u03A9', '\u03A9 Ohm'],
    ['\u00B1', '\u00B1 Plus-minus'],
    ['\u00D7', '\u00D7 Times'],
    ['\u00F7', '\u00F7 Divide'],
].map(([value, label]) => ({ value, label }));

const wrapDegrees = value => ((Math.round(value) % 360) + 360) % 360;
const positive = min => value => Math.max(min, value);
const numberParse = (min, normalize = value => value) => text => {
    const value = Number.parseFloat(text);
    if (!Number.isFinite(value)) return null;
    return normalize(min === undefined ? value : Math.max(min, value));
};

/** Show Text drawing defaults in Properties. */
export function showTextToolProperties(app, defaults) {
    const hold = pictureRefreshHold(app);
    const refresh = () => app.refreshPropertyPanel?.(describe());
    const number = (key, id, label, property, extra = {}) => {
        const { value, after, ...field } = extra;
        return {
            key, id, type: 'number', label, value: value?.() ?? defaults[property], hold,
            preview: next => { defaults[property] = next; after?.(); },
            commit: next => { defaults[property] = next; after?.(); refresh(); },
            ...field,
        };
    };
    const describe = () => ({
        title: 'New Text',
        fields: [
            { key: 'layer', id: 'pcbPropTextToolLayer', type: 'select', label: 'Layer', value: defaults.layer,
                options: TEXT_LAYERS.map(layer => pcbLayerOption(layer, app.layerLabel(layer))),
                commit: value => {
                    if (TEXT_LAYERS.includes(value)) defaults.layer = value;
                    app.setPcbStatus?.();
                    refresh();
                } },
            number('fontSize', 'pcbPropTextToolSize', 'Text Size (mm)', 'size',
                { min: 0.2, max: 20, step: 0.1, normalize: positive(0.2) }),
            number('lineWidth', 'pcbPropTextToolLW', 'Line Width (mm)', 'strokeWidth',
                { min: 0.05, max: 2, step: 0.05, normalize: positive(0.05) }),
            number('rotation', 'pcbPropTextToolRot', 'Rotation (\u00B0)', 'rotation',
                { step: 1, numberFormat: 'rotation', value: () => displayRotationDegrees(defaults.rotation),
                    normalize: wrapDegrees }),
            { key: 'border', id: 'pcbPropTextToolBorder', type: 'checkbox', label: 'Border',
                value: defaults.border, commit: value => { defaults.border = value; refresh(); } },
        ],
    });
    app.openPropertyPanel?.(describe());
}

/**
 * Show properties for the given text and switch to Properties tab.
 * Editing pushes EditTextCommand on settled commit so undo collapses each edit run
 * into one entry.
 * @param {any} app
 * @param {any} text
 * @param {() => any} [textEdit] The editor's inline text edit, if any.
 * @param {(textId:string, symbol:string) => boolean} [insertInlineSymbol]
 */
export function showTextProperties(app, text, textEdit = () => null, insertInlineSymbol = () => false) {
    text = app.pcbDocument.texts.get(text.id);
    if (!text) return;
    const lockEntries = [{ kind: 'text', object: text }];
    let disposed = false;
    const hold = pictureRefreshHold(app);
    const isEditingThis = () => textEdit()?.text?.id === text.id;
    const layerApply = (model, value) => {
        const wasBottom = typeof model.layer === 'string' && model.layer.startsWith('bottom-');
        const willBottom = typeof value === 'string' && value.startsWith('bottom-');
        if (wasBottom !== willBottom) {
            const edit = textEdit();
            const content = edit?.text?.id === model.id ? edit.text.content : model.content;
            const width = measureStrokeText(content, model.size);
            const sign = willBottom ? 1 : -1;
            const rotation = (model.rotation || 0) * Math.PI / 180;
            model.x += sign * width * Math.cos(rotation);
            model.y += sign * width * -Math.sin(rotation);
        }
        model.layer = value;
    };
    const binding = bindStrokeTextProps(app, text, {
        refresh: () => refresh(),
        editable: () => isEditorActive(app)
            && !boardShapeLocked(text) && isLayerVisible(text.layer),
        fields: [
            { key: 'layer', id: 'pcbPropTextLayer', type: 'select', label: 'Layer', field: 'layer',
                options: () => TEXT_LAYERS.map(layer => pcbLayerOption(layer, app.layerLabel(layer))),
                parse: value => TEXT_LAYERS.includes(value) ? value : null, apply: layerApply },
            { key: 'fontSize', id: 'pcbPropTextSize', type: 'number', label: 'Text Size (mm)', field: 'size',
                min: 0.2, step: 0.1, parse: numberParse(0.1) },
            { key: 'rotation', id: 'pcbPropTextRot', type: 'number', label: 'Rotation (\u00B0)', field: 'rotation',
                step: 1, numberFormat: 'rotation', parse: numberParse(undefined, wrapDegrees),
                value: model => displayRotationDegrees(model.rotation), wrap: true },
            { key: 'lineWidth', id: 'pcbPropTextLW', type: 'number', label: 'Line Width (mm)', field: 'strokeWidth',
                min: 0.05, step: 0.05, parse: numberParse(0.01) },
        ],
        begin: target => beginTextPropertyPreview(app, target.id),
        cancel: () => finishTextPropertyPreview(app),
        preview: target => app.refreshText(target.id),
        commit: (target, snapshot) => {
            const after = {};
            for (const key of ['layer', 'size', 'rotation', 'strokeWidth', 'x', 'y']) {
                if (snapshot[key] !== target[key]) after[key] = target[key];
            }
            finishTextPropertyPreview(app, Object.keys(after).length
                ? () => app.history.execute(new EditTextCommand(app, target.id, after)) : undefined);
        },
    });
    const refresh = () => {
        if (!disposed) app.refreshPropertyPanel?.(describe());
    };
    const describe = () => {
        const lock = lockedProperty(app, lockEntries);
        const readOnly = lock.readOnly;
        return {
            title: 'Text',
            fields: [
                lock.field,
                ...(isEditingThis() ? [{ key: 'insert', id: 'pcbPropTextInsert', type: 'select', label: 'Insert',
                    value: '', disabled: readOnly, options: SYMBOLS, commit: symbol => {
                        if (!symbol || boardShapeLocked(text)) { refresh(); return; }
                        if (!insertInlineSymbol(text.id, symbol)) {
                            app.history.execute(new EditTextCommand(app, text.id,
                                { content: (text.content || '') + symbol }));
                        }
                        refresh();
                    } }] : []),
                ...binding.fields(readOnly, hold),
                { key: 'border', id: 'pcbPropTextBorder', type: 'checkbox', label: 'Border',
                    value: text.border, disabled: readOnly, commit: value => {
                        if (boardShapeLocked(text)) return;
                        app.history.execute(new EditTextCommand(app, text.id, { border: value }));
                        refresh();
                    } },
            ],
        };
    };
    binding.dispose = ((dispose) => () => {
        disposed = true;
        dispose();
    })(binding.dispose);
    if (!app.openPropertyPanel?.(describe())) {
        binding.dispose();
        return;
    }
    setPropertyEditor(app, 'text', binding);
}

/**
 * Shared field-binding machinery for stroke-text style panels. It exposes
 * PropertyField descriptions whose hooks preview into a temporary model and commit
 * one undo command when a number run settles.
 * @param {any} app
 * @param {any} model object whose fields the inputs drive
 * @param {{fields: Array<{key?:string, id:string, type?:'number'|'select', label:string, field:string, min?:number, max?:number, step?:number, numberFormat?:'rotation', options?:()=>Array<any>, parse?:(v:string)=>any, apply?:(m:any,v:any)=>void, value?:(m:any)=>any, wrap?:boolean}>, editable?:()=>boolean, begin?:(m:any)=>any, cancel?:(snap:any)=>void, preview:(m:any)=>void, commit:(m:any, snap:any)=>void, refresh?:()=>void}} spec
 */
export function bindStrokeTextProps(app, model, spec) {
    let snapshot = null;
    let target = model;
    let disposed = false;
    let activeField = null;
    let invalidField = null;
    const editable = () => !disposed && (!spec.editable || spec.editable());
    const fieldValue = field => field.value ? field.value(target) : target[field.field];
    const apply = (field, value) => {
        if (field.apply) field.apply(target, value);
        else target[field.field] = value;
    };
    const parse = (field, text) => {
        const value = field.parse ? field.parse(text) : Number.parseFloat(text);
        if (value === null || value === undefined) {
            invalidField = field;
            return NaN;
        }
        if (invalidField === field) invalidField = null;
        return value;
    };
    const previewField = (field, value) => {
        if (disposed) return;
        if (!editable()) { binding.cancel(); return; }
        if (snapshot && activeField !== field) binding.commit();
        if (fieldValue(field) === value) return;
        if (invalidField === field) invalidField = null;
        if (!snapshot) {
            target = spec.begin ? spec.begin(model) : model;
            snapshot = { ...target };
        }
        activeField = field;
        apply(field, value);
        if (typeof target.content === 'string') schedulePictureCopperRefresh(app, target);
        spec.preview(target);
    };
    const onCommit = () => {
        if (disposed || !snapshot) return;
        if (!editable() || invalidField === activeField) { binding.cancel(); return; }
        const snap = snapshot;
        const edited = target;
        snapshot = null;
        activeField = null;
        invalidField = null;
        target = model;
        let committed = false;
        try {
            spec.commit(edited, snap);
            committed = true;
        } finally {
            if (!committed) spec.cancel?.(snap);
            spec.refresh?.();
        }
    };
    const binding = {
        model,
        spec,
        affectsLayer: layerId => model.layer === layerId || target.layer === layerId,
        get active() { return snapshot !== null; },
        fields(disabled = false, hold = undefined) {
            return spec.fields.map(field => {
                const base = {
                    key: field.key || field.field,
                    id: field.id,
                    type: field.type || 'number',
                    label: field.label,
                    prop: field.key,
                    value: fieldValue(field),
                    disabled,
                };
                if (base.type === 'select') {
                    return { ...base, options: field.options?.() || [], commit: value => {
                        const parsed = field.parse ? field.parse(value) : value;
                        if (parsed === null || parsed === undefined) return;
                        previewField(field, parsed);
                        onCommit();
                    } };
                }
                return {
                    ...base,
                    min: field.min,
                    max: field.max,
                    step: field.step,
                    numberFormat: field.numberFormat,
                    hold,
                    parse: text => parse(field, text),
                    preview: value => previewField(field, value),
                    commit: () => onCommit(),
                    cancel: () => binding.cancel(),
                };
            });
        },
        commit: onCommit,
        cancel: () => {
            if (!snapshot) return false;
            const snap = snapshot;
            snapshot = null;
            activeField = null;
            invalidField = null;
            target = model;
            spec.cancel?.(snap);
            spec.refresh?.();
            return true;
        },
        dispose: () => {
            if (disposed) return;
            try { binding.cancel(); } finally { disposed = true; }
        },
    };
    return binding;
}
