/**
 * Properties panels for PCB free text: the Text tool's defaults and a selected text,
 * plus the stroke-text field binding they share with the reference-designator panel.
 * Panels describe fields only; shared/ui/property-fields.js owns the DOM.
 */
import { noteEditSettled } from './refresh-state.js';
import { pcbToolBlockNotice } from './tool-lifecycle.js';
import { displayRotationDegrees } from '../../core/number-inputs.js';
import { TEXT_LAYERS, createPcbText } from '../../core/pcb-text.js';
import { measureText as measureStrokeText } from '../../shared/pcb/stroke-font.js';
import { pcbLayerOption, isLayerVisible } from './layers.js';
import { boardShapeLocked, lockedProperty } from './object-locks.js';
import { pictureRefreshHold, schedulePictureCopperRefresh } from './picture-refresh.js';
import { setPropertyEditor } from './property-editors.js';
import { AddTextCommand, EditTextCommand, beginTextPropertyPreview, finishTextPropertyPreview } from './text-commands.js';
import { startTextInlineEdit } from './text-inline-edit.js';
import { isEditorActive } from './pcb-editor-api.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */
/** @typedef {import('../../core/pcb-text.js').PcbText} PcbText */
/** @typedef {import('../../core/pcb-placement-geometry.js').Placement} Placement */
/** @typedef {import('../../core/pcb-placement-commands.js').RefStylePatch} RefStylePatch */
/** @typedef {import('../../shared/ui/property-fields.js').PropertyPanel} PropertyPanel */
/** @typedef {import('../../shared/ui/property-fields.js').PropertyField} PropertyField */
/** @typedef {{x:number,y:number}} Point */
/** @typedef {{size:number, rotation:number, layer:string, strokeWidth:number, border:boolean}} TextDefaults */
/** @typedef {import('../../core/pcb-text-commands.js').PcbTextPatch} PcbTextPatch */
/** @typedef {(PcbText | (Placement & RefStylePatch)) & Record<string, any>} StrokeTextModel */
/** @typedef {{key?:string, id:string, type?:'number'|'select', label:string, field:string, min?:number, max?:number, step?:number, numberFormat?:'rotation', options?:()=>Array<any>, parse?:(v:string)=>any, apply?:(m:StrokeTextModel,v:any)=>void, value?:(m:StrokeTextModel)=>any, wrap?:boolean}} StrokeTextFieldSpec */
/** @typedef {{fields: Array<StrokeTextFieldSpec>, editable?:()=>boolean, begin?:(m:StrokeTextModel)=>StrokeTextModel, cancel?:(snap:StrokeTextModel)=>void, preview:(m:StrokeTextModel)=>void, commit:(m:StrokeTextModel, snap:StrokeTextModel)=>void, refresh?:()=>void}} StrokeTextBindingSpec */
/** @typedef {{model:StrokeTextModel, spec:StrokeTextBindingSpec, affectsLayer:(layerId:string)=>boolean, readonly active:boolean, fields:(disabled?:boolean, hold?:any)=>PropertyField[], commit:()=>void, cancel:()=>boolean, dispose:()=>void}} StrokeTextBinding */

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

/** @param {number} value */
const wrapDegrees = value => ((Math.round(value) % 360) + 360) % 360;
/** @param {number} min */
const positive = min => /** @param {number} value */ value => Math.max(min, value);
/** @param {number|undefined} min @param {(value:number)=>number} [normalize] */
const numberParse = (min, normalize = value => value) => /** @param {string} text */ text => {
    const value = Number.parseFloat(text);
    if (!Number.isFinite(value)) return null;
    return normalize(min === undefined ? value : Math.max(min, value));
};
/** @type {WeakMap<PcbEditor, TextDefaults>} */
const textToolDefaults = new WeakMap();

/** @param {PcbEditor} app */
export function getTextToolDefaults(app) {
    let defaults = textToolDefaults.get(app);
    if (!defaults) {
        defaults = { size: 1.0, rotation: 0, layer: 'top-silk', strokeWidth: 0.15, border: false };
        textToolDefaults.set(app, defaults);
    }
    return defaults;
}

/** @param {PcbEditor} app @param {TextDefaults} defaults */
export function setTextToolDefaults(app, defaults) {
    textToolDefaults.set(app, defaults);
}

/**
 * Show Text drawing defaults in Properties.
 * @param {PcbEditor} app
 */
export function showTextToolProperties(app) {
    const defaults = getTextToolDefaults(app);
    const hold = pictureRefreshHold(app);
    const refresh = () => app.refreshPropertyPanel(describe());
    /**
     * @param {string} key
     * @param {string} id
     * @param {string} label
     * @param {'size'|'strokeWidth'|'rotation'} property
     * @param {Partial<PropertyField> & {value?:()=>any, after?:()=>void}} [extra]
     * @returns {PropertyField}
     */
    const number = (key, id, label, property, extra = {}) => {
        const { value, after, ...field } = extra;
        return {
            key, id, type: 'number', label, value: value?.() ?? defaults[property], hold,
            preview: next => { defaults[property] = next; after?.(); },
            commit: next => { defaults[property] = next; after?.(); refresh(); },
            ...field,
        };
    };
    /** @returns {PropertyPanel} */
    const describe = () => ({
        title: 'New Text',
        actions: pcbToolBlockNotice(app, 'text').actions,
        fields: [
            { key: 'layer', id: 'pcbPropTextToolLayer', type: 'select', label: 'Layer', value: defaults.layer,
                warning: pcbToolBlockNotice(app, 'text').warning,
                options: TEXT_LAYERS.map(layer => pcbLayerOption(layer, app.layerLabel(layer))),
                commit: value => {
                    if (TEXT_LAYERS.includes(value)) defaults.layer = value;
                    app.setPcbStatus();
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
    app.openPropertyPanel(describe());
}

/**
 * Show properties for the given text and switch to Properties tab.
 * Editing pushes EditTextCommand on settled commit so undo collapses each edit run
 * into one entry.
 * @param {PcbEditor} app
 * @param {PcbText} text
 * @param {() => any} [textEdit] The editor's inline text edit, if any.
 * @param {(textId:string, symbol:string) => boolean} [insertInlineSymbol]
 */
export function showTextProperties(app, text, textEdit = () => null, insertInlineSymbol = () => false) {
    const loadedText = app.pcbDocument.texts.get(text.id);
    if (!loadedText) return;
    text = loadedText;
    const lockEntries = [{ kind: 'text', object: text }];
    let disposed = false;
    const hold = pictureRefreshHold(app);
    const isEditingThis = () => textEdit()?.text?.id === text.id;
    /** @param {StrokeTextModel} model @param {string} value */
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
                value: model => displayRotationDegrees(Number(model.rotation) || 0), wrap: true },
            { key: 'lineWidth', id: 'pcbPropTextLW', type: 'number', label: 'Line Width (mm)', field: 'strokeWidth',
                min: 0.05, step: 0.05, parse: numberParse(0.01) },
        ],
        begin: target => beginTextPropertyPreview(app, target.id),
        cancel: () => finishTextPropertyPreview(app),
        preview: target => app.refreshText(target.id),
        commit: (target, snapshot) => {
            /** @type {PcbTextPatch} */
            const after = {};
            for (const key of /** @type {(keyof PcbText)[]} */ (['layer', 'size', 'rotation', 'strokeWidth', 'x', 'y'])) {
                if (snapshot[key] !== target[key]) after[key] = target[key];
            }
            finishTextPropertyPreview(app, Object.keys(after).length
                ? () => app.history.execute(new EditTextCommand(app, target.id, after)) : undefined);
        },
    });
    const refresh = () => {
        if (!disposed) app.refreshPropertyPanel(describe());
    };
    /** @returns {PropertyPanel} */
    const describe = () => {
        const lock = lockedProperty(app, lockEntries);
        const readOnly = lock.readOnly;
        return {
            title: 'Text',
            fields: [
                lock.field,
                ...(isEditingThis() ? /** @type {PropertyField[]} */ ([{ key: 'insert', id: 'pcbPropTextInsert', type: 'select', label: 'Insert',
                    value: '', disabled: readOnly, options: SYMBOLS, commit: symbol => {
                        if (!symbol || boardShapeLocked(text)) { refresh(); return; }
                        if (!insertInlineSymbol(text.id, symbol)) {
                            app.history.execute(new EditTextCommand(app, text.id,
                                { content: (text.content || '') + symbol }));
                        }
                        refresh();
                    } }]) : []),
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
    if (!app.openPropertyPanel(describe())) {
        binding.dispose();
        return;
    }
    setPropertyEditor(app, 'text', binding);
}

/**
 * Shared field-binding machinery for stroke-text style panels. It exposes
 * PropertyField descriptions whose hooks preview into a temporary model and commit
 * one undo command when a number run settles.
 * @param {PcbEditor} app
 * @param {StrokeTextModel} model object whose fields the inputs drive
 * @param {StrokeTextBindingSpec} spec
 * @returns {StrokeTextBinding}
 */
export function bindStrokeTextProps(app, model, spec) {
    /** @type {StrokeTextModel|null} */
    let snapshot = null;
    let target = model;
    let disposed = false;
    /** @type {StrokeTextFieldSpec|null} */
    let activeField = null;
    /** @type {StrokeTextFieldSpec|null} */
    let invalidField = null;
    const editable = () => !disposed && (!spec.editable || spec.editable());
    /** @param {StrokeTextFieldSpec} field */
    const fieldValue = field => field.value ? field.value(target) : target[field.field];
    /** @param {StrokeTextFieldSpec} field @param {any} value */
    const apply = (field, value) => {
        if (field.apply) field.apply(target, value);
        else /** @type {any} */ (target)[field.field] = value;
    };
    /** @param {StrokeTextFieldSpec} field @param {string} text */
    const parse = (field, text) => {
        const value = field.parse ? field.parse(text) : Number.parseFloat(text);
        if (value === null || value === undefined) {
            invalidField = field;
            return NaN;
        }
        if (invalidField === field) invalidField = null;
        return value;
    };
    /** @param {StrokeTextFieldSpec} field @param {any} value */
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
        if (typeof target.content === 'string') schedulePictureCopperRefresh(app, /** @type {any} */ (target));
        spec.preview(target);
    };
    const onCommit = () => {
        if (disposed || !snapshot) return;
        if (!editable() || invalidField === activeField) { binding.cancel(); return; }
        const snap = snapshot;
        const edited = target;
        snapshot = null;
        noteEditSettled(app);
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
    /** @type {StrokeTextBinding} */
    const binding = {
        model,
        spec,
        affectsLayer: layerId => model.layer === layerId || target.layer === layerId,
        get active() { return snapshot !== null; },
        /** @returns {PropertyField[]} */
        fields(disabled = false, hold = undefined) {
            return spec.fields.map(field => {
                /** @type {PropertyField} */
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
            noteEditSettled(app);
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

/**
 * A primary press with the Text tool: place an empty text from the tool's defaults,
 * select it and type into it in place, as in the schematic editor.
 * @param {PcbEditor} app
 * @param {Point} worldPos
 */
export function pressTextTool(app, worldPos) {
    const snap = app.snapToGrid(worldPos);
    const defaults = getTextToolDefaults(app);
    const text = createPcbText({
        content: '', x: snap.x, y: snap.y, size: defaults.size, rotation: defaults.rotation,
        layer: defaults.layer, strokeWidth: defaults.strokeWidth, border: defaults.border,
    });
    app.history.execute(new AddTextCommand(app, text));
    app.selectText(text);
    app.showTextProperties(text);
    startTextInlineEdit(app, text, /** @type {any} */ (null), { isNewPlacement: true });
}
