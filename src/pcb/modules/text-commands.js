/**
 * Command classes for PCB free-standing text undo/redo.
 *
 * Model commands own mutations and undo state. These adapters keep SVG,
 * selection, and derived-geometry updates synchronized with those operations.
 */

import {
    AddTextCommand as ModelAddTextCommand, RemoveTextCommand as ModelRemoveTextCommand,
    MoveTextCommand as ModelMoveTextCommand, EditTextCommand as ModelEditTextCommand,
} from '../../core/pcb-text-commands.js';
import { getPcbSelectionEntries, isPcbSelected } from './selection-registry.js';
import { schedulePictureCopperRefresh } from './picture-refresh.js';
import { deferDerivedUpdate } from '../../core/DerivedUpdates.js';
import { removeTextElement, renderText } from './pcb-text-render.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */
/** @typedef {import('../../core/pcb-text.js').PcbText} PcbText */
/** @typedef {import('../../core/pcb-text-commands.js').PcbTextPatch} PcbTextPatch */
/** @typedef {Partial<PcbText>} PcbTextPose */
/** @typedef {{copies: Map<string, PcbText>, texts: Map<string, PcbText>, contentId?: string, propertyId?: string}} TextPosePreview */

/** @type {WeakMap<PcbEditor, TextPosePreview>} */
const textPosePreviews = new WeakMap();
/** @type {(keyof PcbText)[]} */
const TEXT_STYLE_FIELDS = ['layer', 'size', 'rotation', 'strokeWidth', 'x', 'y'];

/** @param {PcbEditor} app */
export function getTextPosePreviewTexts(app) {
    return textPosePreviews.get(app)?.texts;
}

/**
 * Preview one text's pose without changing authored text or unrelated entries.
 * @param {PcbEditor} app
 * @param {string} id
 * @param {PcbTextPose} pose
 */
export function previewTextPose(app, id, pose) {
    previewTextPoses(app, new Map([[id, pose]]));
}

/**
 * Reuse one projection for a fixed set of moving texts.
 * @param {PcbEditor} app
 * @param {Map<string, PcbTextPose>} poses
 */
export function previewTextPoses(app, poses) {
    if (!poses.size) return;
    let preview = textPosePreviews.get(app);
    if (!preview) {
        const texts = new Map(app.pcbDocument.texts);
        const copies = new Map();
        for (const id of poses.keys()) {
            const original = app.pcbDocument.texts.get(id);
            if (!original) throw new Error(`PCB text is no longer available: ${id}`);
            const text = { ...original };
            copies.set(id, text);
            texts.set(id, text);
        }
        preview = { copies, texts };
        textPosePreviews.set(app, preview);
    }
    if (preview.copies.size !== poses.size || [...poses.keys()].some(id => !preview.copies.has(id))) {
        throw new Error('Finish the current text preview before starting another.');
    }
    for (const [id, pose] of poses) Object.assign(/** @type {PcbText} */ (preview.copies.get(id)), pose);
}

/**
 * Inline typing shares the stable text projection but owns only its content.
 * @param {PcbEditor} app
 * @param {string} id
 * @returns {PcbText}
 */
export function beginTextContentPreview(app, id) {
    const text = app.pcbDocument.texts.get(id);
    if (!text) throw new Error(`PCB text is no longer available: ${id}`);
    previewTextPose(app, id, { content: text.content });
    const preview = /** @type {TextPosePreview} */ (textPosePreviews.get(app));
    preview.contentId = id;
    return /** @type {PcbText} */ (preview.copies.get(id));
}

/**
 * Keep separately edited style/pose fields current without overwriting typed content.
 * @param {PcbEditor} app
 * @param {string} id
 */
export function syncTextContentPreview(app, id) {
    const preview = textPosePreviews.get(app);
    if (!preview || (preview.contentId !== id && preview.propertyId !== id)) return;
    const text = app.pcbDocument.texts.get(id);
    if (!text) throw new Error(`PCB text is no longer available: ${id}`);
    const copy = /** @type {PcbText} */ (preview.copies.get(id));
    /** @type {PcbTextPatch} */
    const pending = {};
    if (preview.contentId === id) pending.content = copy.content;
    if (preview.propertyId === id) for (const key of TEXT_STYLE_FIELDS) pending[key] = copy[key];
    Object.assign(copy, text, pending);
}

/** @param {PcbEditor} app @param {string} id @returns {PcbText} */
export function beginTextPropertyPreview(app, id) {
    previewTextPose(app, id, {});
    const preview = /** @type {TextPosePreview} */ (textPosePreviews.get(app));
    preview.propertyId = id;
    return /** @type {PcbText} */ (preview.copies.get(id));
}

/**
 * Finish style editing without ending an independent inline-content preview.
 * @param {PcbEditor} app
 * @param {(() => void)|undefined} [commit]
 */
export function finishTextPropertyPreview(app, commit) {
    const preview = textPosePreviews.get(app);
    const id = preview?.propertyId;
    if (!id) return;
    delete preview.propertyId;
    if (!preview.contentId) textPosePreviews.delete(app);
    let committed = false;
    try {
        if (commit) {
            commit();
            committed = true;
        }
    } finally {
        const text = app.pcbDocument.texts.get(id);
        if (!text) {
            textPosePreviews.delete(app);
            removeTextElement(app, id);
        } else {
            const copy = /** @type {PcbText} */ (preview.copies.get(id));
            const changed = TEXT_STYLE_FIELDS.some(key => copy[key] !== text[key]);
            syncTextContentPreview(app, id);
            if (!committed) {
                schedulePictureCopperRefresh(app, /** @type {any} */ (getTextPosePreviewTexts(app)?.get(id) || text));
                if (commit || changed) app.refreshText(id);
            }
        }
    }
}

/**
 * End a pose gesture (drag, rotation, group move) and switch back to canonical text
 * before executing its model command or restoring artwork. Inline typing on the same
 * text outlives the gesture: its content projection is kept and re-synced, so the
 * typed text stays on screen until the inline edit itself finishes.
 * @param {PcbEditor} app
 * @param {(() => void)|undefined} [commit]
 */
export function finishTextPosePreview(app, commit) {
    const preview = textPosePreviews.get(app);
    const contentId = preview?.contentId;
    if (preview && contentId != null && preview.copies.size === 1 && preview.copies.has(contentId)) {
        finishPoseKeepingContent(app, contentId, commit);
        return;
    }
    finishTextContentPreview(app, commit);
}

/** @param {PcbEditor} app @param {string} id @param {(() => void)|undefined} [commit] */
function finishPoseKeepingContent(app, id, commit) {
    try {
        if (commit) commit();
    } finally {
        if (!app.pcbDocument.texts.get(id)) {
            textPosePreviews.delete(app);
            removeTextElement(app, id);
        } else {
            // The command (or a cancel) leaves authored pose current; the copy keeps the typing.
            syncTextContentPreview(app, id);
            app.refreshText(id);
        }
    }
}

/**
 * End every text preview, inline content included, before executing its model command.
 * @param {PcbEditor} app
 * @param {(() => void)|undefined} [commit]
 */
export function finishTextContentPreview(app, commit) {
    const preview = textPosePreviews.get(app);
    textPosePreviews.delete(app);
    let committed = false;
    try {
        if (commit) {
            commit();
            committed = true;
        }
    } finally {
        if (preview && !committed) {
            for (const [id, copy] of preview.copies) {
                const text = app.pcbDocument.texts.get(id);
                if (!text) removeTextElement(app, id);
                else if (commit || /** @type {(keyof PcbText)[]} */ (['x', 'y', 'rotation']).some(key => text[key] !== copy[key])) {
                    app.refreshText(id);
                }
            }
        }
    }
}

/** @param {PcbEditor} app */
function refreshTextLayerProperties(app) {
    if (deferDerivedUpdate(app, 'text-layer-properties', () => refreshTextLayerProperties(app))) return;
    /** @type {Array<{kind:string, object:any}>} */
    const selected = getPcbSelectionEntries(app);
    if (!selected.some(entry => entry.kind === 'text')) return;
    if (selected.length === 1) app.showTextProperties(selected[0].object);
    else app.showMultiSelectionProperties(selected);
}

/** Add a text to app.texts and render it. */
export class AddTextCommand extends ModelAddTextCommand {
    /** @param {PcbEditor} app @param {PcbText} text */
    constructor(app, text) {
        super(app.pcbDocument, text);
        this.app = app;
    }
    execute() {
        super.execute();
        schedulePictureCopperRefresh(this.app, this.text);
        renderText(this.app, this.text);
    }
    undo() {
        removeTextElement(this.app, this.text.id);
        super.undo();
        schedulePictureCopperRefresh(this.app, this.text);
        if (isPcbSelected(this.app, 'text', this.text)) {
            this.app.selectText(null);
        }
    }
}

/** Remove a text. */
export class RemoveTextCommand extends ModelRemoveTextCommand {
    /** @param {PcbEditor} app @param {string} textId */
    constructor(app, textId) {
        super(app.pcbDocument, textId);
        this.app = app;
    }
    execute() {
        const text = this.document.texts.get(this.snapshot.id);
        removeTextElement(this.app, this.snapshot.id);
        super.execute();
        schedulePictureCopperRefresh(this.app, this.snapshot);
        if (text && isPcbSelected(this.app, 'text', text)) {
            this.app.selectText(null);
        }
    }
    undo() {
        super.undo();
        const text = this.document.texts.get(this.snapshot.id);
        schedulePictureCopperRefresh(this.app, text);
        renderText(this.app, text);
    }
}

/** Move a text from (x0,y0) to (x1,y1). */
export class MoveTextCommand extends ModelMoveTextCommand {
    /** @param {PcbEditor} app @param {string} textId @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1 */
    constructor(app, textId, x0, y0, x1, y1) {
        super(app.pcbDocument, textId, x0, y0, x1, y1);
        this.app = app;
    }
    /** @param {number} x @param {number} y */
    _set(x, y) {
        super._set(x, y);
        syncTextContentPreview(this.app, this.id);
        schedulePictureCopperRefresh(this.app);
        this.app.refreshText(this.id);
    }
}

/**
 * Replace any subset of a text's editable properties. `after` is a
 * partial object (e.g. `{ size: 1.2, layer: 'bottom-silk' }`). The
 * pre-edit values are captured at construction time.
 */
export class EditTextCommand extends ModelEditTextCommand {
    /** @param {PcbEditor} app @param {string} textId @param {PcbTextPatch} after */
    constructor(app, textId, after) {
        super(app.pcbDocument, textId, after);
        this.app = app;
    }
    /** @param {PcbTextPatch} patch */
    _apply(patch) {
        super._apply(patch);
        syncTextContentPreview(this.app, this.id);
        const t = this.document.texts.get(this.id);
        schedulePictureCopperRefresh(this.app, getTextPosePreviewTexts(this.app)?.get(this.id) || t);
        this.app.refreshText(this.id);
        if ('layer' in patch && isPcbSelected(this.app, 'text', t)) {
            refreshTextLayerProperties(this.app);
        }
        if ('rotation' in patch && isPcbSelected(this.app, 'text', t)) {
            const input = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropTextRot'));
            if (input) input.value = String(Math.round(t.rotation) % 360);
        }
    }
}
