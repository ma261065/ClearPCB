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

const textPosePreviews = new WeakMap();

export function getTextPosePreviewTexts(app) {
    return textPosePreviews.get(app)?.texts;
}

/** Preview one text's pose without changing authored text or unrelated entries. */
export function previewTextPose(app, id, pose) {
    let preview = textPosePreviews.get(app);
    if (preview && preview.id !== id) throw new Error('Finish the current text preview before starting another.');
    if (!preview) {
        const original = app.pcbDocument.texts.get(id);
        if (!original) throw new Error(`PCB text is no longer available: ${id}`);
        const text = { ...original };
        const texts = new Map(app.pcbDocument.texts);
        texts.set(id, text);
        preview = { id, text, texts };
        textPosePreviews.set(app, preview);
    }
    Object.assign(preview.text, pose);
}

/** Switch back to canonical text before executing a model command or restoring artwork. */
export function finishTextPosePreview(app, commit) {
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
            const text = app.pcbDocument.texts.get(preview.id);
            if (!text) app._removeTextElement(preview.id);
            else if (commit || ['x', 'y', 'rotation'].some(key => text[key] !== preview.text[key])) {
                app._refreshText(preview.id);
            }
        }
    }
}

function refreshTextLayerProperties(app) {
    if (deferDerivedUpdate(app, 'text-layer-properties', () => refreshTextLayerProperties(app))) return;
    const selected = getPcbSelectionEntries(app);
    if (!selected.some(entry => entry.kind === 'text')) return;
    if (selected.length === 1) app._showTextProperties?.(selected[0].object);
    else app._showPcbMultiSelectionProperties?.(selected);
}

/** Add a text to app.texts and render it. */
export class AddTextCommand extends ModelAddTextCommand {
    constructor(app, text) {
        super(app.pcbDocument, text);
        this.app = app;
    }
    execute() {
        super.execute();
        schedulePictureCopperRefresh(this.app, this.text);
        this.app._renderText(this.text);
    }
    undo() {
        this.app._removeTextElement(this.text.id);
        super.undo();
        schedulePictureCopperRefresh(this.app, this.text);
        if (isPcbSelected(this.app, 'text', this.text)) {
            this.app._selectText(null);
        }
    }
}

/** Remove a text. */
export class RemoveTextCommand extends ModelRemoveTextCommand {
    constructor(app, textId) {
        super(app.pcbDocument, textId);
        this.app = app;
    }
    execute() {
        const text = this.document.texts.get(this.snapshot.id);
        this.app._removeTextElement(this.snapshot.id);
        super.execute();
        schedulePictureCopperRefresh(this.app, this.snapshot);
        if (text && isPcbSelected(this.app, 'text', text)) {
            this.app._selectText(null);
        }
    }
    undo() {
        super.undo();
        const text = this.document.texts.get(this.snapshot.id);
        schedulePictureCopperRefresh(this.app, text);
        this.app._renderText(text);
    }
}

/** Move a text from (x0,y0) to (x1,y1). */
export class MoveTextCommand extends ModelMoveTextCommand {
    constructor(app, textId, x0, y0, x1, y1) {
        super(app.pcbDocument, textId, x0, y0, x1, y1);
        this.app = app;
    }
    _set(x, y) {
        super._set(x, y);
        schedulePictureCopperRefresh(this.app);
        this.app._refreshText(this.id);
    }
}

/**
 * Replace any subset of a text's editable properties. `after` is a
 * partial object (e.g. `{ size: 1.2, layer: 'bottom-silk' }`). The
 * pre-edit values are captured at construction time.
 */
export class EditTextCommand extends ModelEditTextCommand {
    constructor(app, textId, after) {
        super(app.pcbDocument, textId, after);
        this.app = app;
    }
    _apply(patch) {
        super._apply(patch);
        const t = this.document.texts.get(this.id);
        schedulePictureCopperRefresh(this.app, t);
        this.app._refreshText(this.id);
        if ('layer' in patch && isPcbSelected(this.app, 'text', t)) {
            refreshTextLayerProperties(this.app);
        }
        if ('rotation' in patch && isPcbSelected(this.app, 'text', t)) {
            const input = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropTextRot'));
            if (input) input.value = String(Math.round(t.rotation) % 360);
        }
    }
}
