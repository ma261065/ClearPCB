import { editTargets } from './edit-guard.js';
import { serializePcbText } from './pcb-text.js';

/** @typedef {import('./PcbDocument.js').PcbDocument} PcbDocument */

/** @param {PcbDocument} document */
function requireText(document, id) {
    const text = document.texts.get(id);
    if (!text) throw new Error(`PCB text is no longer available: ${id}`);
    return text;
}

/** Data-only commands; rendering and selection belong to the editor adapters. */
export class AddTextCommand {
    /** @param {PcbDocument} document */
    constructor(document, text) {
        this.document = document;
        this.text = text;
    }
    lockTargets() { return []; }
    execute() { this.document.texts.set(this.text.id, this.text); }
    undo() {
        // Deletion undo may have recreated the text since this command ran.
        this.text = requireText(this.document, this.text.id);
        this.document.texts.delete(this.text.id);
    }
    get description() { return `Add text "${this.text.content}"`; }
}

export class RemoveTextCommand {
    /** @param {PcbDocument} document */
    constructor(document, textId) {
        this.document = document;
        this.snapshot = serializePcbText(requireText(document, textId));
    }
    lockTargets() { return [{ kind: 'text', object: this.document.texts.get(this.snapshot.id) }]; }
    execute() { this.document.texts.delete(this.snapshot.id); }
    undo() { this.document.texts.set(this.snapshot.id, /** @type {any} */ ({ ...this.snapshot })); }
    get description() { return `Delete text "${this.snapshot.content}"`; }
}

export class MoveTextCommand {
    /** @param {PcbDocument} document */
    constructor(document, textId, x0, y0, x1, y1) {
        this.document = document;
        this.id = textId;
        this.x0 = x0; this.y0 = y0;
        this.x1 = x1; this.y1 = y1;
    }
    lockTargets() { return [{ kind: 'text', object: this.document.texts.get(this.id) }]; }
    execute() { this._set(this.x1, this.y1); }
    undo() { this._set(this.x0, this.y0); }
    _set(x, y) {
        const text = requireText(this.document, this.id);
        text.x = x; text.y = y;
    }
    get description() { return 'Move text'; }
}

export class EditTextCommand {
    /** @param {PcbDocument} document */
    constructor(document, textId, after) {
        this.document = document;
        this.id = textId;
        const text = requireText(document, textId);
        this.before = {};
        this.after = {};
        for (const key of Object.keys(after)) {
            this.before[key] = text[key];
            this.after[key] = after[key];
        }
    }
    lockTargets() { return editTargets('text', this.document.texts.get(this.id), this.before, this.after); }
    execute() { this._apply(this.after); }
    undo() { this._apply(this.before); }
    _apply(patch) { Object.assign(requireText(this.document, this.id), patch); }
    get description() { return 'Edit text'; }
}
