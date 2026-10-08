import { editTargets } from './edit-guard.js';
import { serializePcbText } from './pcb-text.js';

/** @typedef {import('./PcbDocument.js').PcbDocument} PcbDocument */
/** @typedef {import('./pcb-text.js').PcbText} PcbText */
/** @typedef {Partial<Record<keyof PcbText, any>>} PcbTextPatch */

/** @param {PcbDocument} document @param {string} id */
function requireText(document, id) {
    const text = document.texts.get(id);
    if (!text) throw new Error(`PCB text is no longer available: ${id}`);
    return text;
}

/** Data-only commands; rendering and selection belong to the editor adapters. */
export class AddTextCommand {
    /** @param {PcbDocument} document @param {PcbText} text */
    constructor(document, text) {
        /** @type {any} Adapter subclasses treat the document as legacy app data. */
        this.document = document;
        /** @type {any} Adapter subclasses pass text through loosely typed render helpers. */
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
    /** @param {PcbDocument} document @param {string} textId */
    constructor(document, textId) {
        /** @type {any} Adapter subclasses treat the document as legacy app data. */
        this.document = document;
        /** @type {any} Full-precision legacy snapshot consumed by UI adapters. */
        this.snapshot = serializePcbText(requireText(document, textId));
    }
    lockTargets() { return [{ kind: 'text', object: this.document.texts.get(this.snapshot.id) }]; }
    execute() { this.document.texts.delete(this.snapshot.id); }
    undo() { this.document.texts.set(this.snapshot.id, /** @type {any} */ ({ ...this.snapshot })); }
    get description() { return `Delete text "${this.snapshot.content}"`; }
}

export class MoveTextCommand {
    /** @param {PcbDocument} document @param {string} textId @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1 */
    constructor(document, textId, x0, y0, x1, y1) {
        /** @type {any} Adapter subclasses treat the document as legacy app data. */
        this.document = document;
        this.id = textId;
        this.x0 = x0; this.y0 = y0;
        this.x1 = x1; this.y1 = y1;
    }
    lockTargets() { return [{ kind: 'text', object: this.document.texts.get(this.id) }]; }
    execute() { this._set(this.x1, this.y1); }
    undo() { this._set(this.x0, this.y0); }
    /** @param {number} x @param {number} y */
    _set(x, y) {
        const text = requireText(this.document, this.id);
        text.x = x; text.y = y;
    }
    get description() { return 'Move text'; }
}

export class EditTextCommand {
    /** @param {PcbDocument} document @param {string} textId @param {PcbTextPatch} after */
    constructor(document, textId, after) {
        /** @type {any} Adapter subclasses treat the document as legacy app data. */
        this.document = document;
        this.id = textId;
        const text = requireText(document, textId);
        /** @type {PcbTextPatch} */
        this.before = {};
        /** @type {PcbTextPatch} */
        this.after = {};
        const current = /** @type {PcbText} */ (text);
        for (const key of /** @type {(keyof PcbText)[]} */ (Object.keys(after))) {
            this.before[key] = current[key];
            this.after[key] = after[key];
        }
    }
    lockTargets() { return editTargets('text', this.document.texts.get(this.id), this.before, this.after); }
    execute() { this._apply(this.after); }
    undo() { this._apply(this.before); }
    /** @param {PcbTextPatch} patch */
    _apply(patch) { Object.assign(requireText(this.document, this.id), patch); }
    get description() { return 'Edit text'; }
}
