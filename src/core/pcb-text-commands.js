import { editTargets } from './edit-guard.js';
import { serializePcbText } from './pcb-text.js';

/** @typedef {import('./PcbDocument.js').PcbDocument} PcbDocument */
/** @typedef {import('./pcb-text.js').PcbText} PcbText */
/** @typedef {Object<string, *>} PcbTextPatch */

/** @param {PcbDocument} document @param {string} id */
function requireText(document, id) {
    const text = document.texts.get(id);
    if (!text) throw new Error(`PCB text is no longer available: ${id}`);
    return text;
}

/** @param {PcbDocument} document @param {string} id */
function panelNote(document, id) {
    return document.panelization?.noteTexts?.find(note => note.id === id);
}

/** Data-only commands; rendering and selection belong to the editor adapters. */
export class AddTextCommand {
    /** @param {PcbDocument} document @param {PcbText} text */
    constructor(document, text) {
        /** @type {PcbDocument} */
        this.document = document;
        /** @type {PcbText} */
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
        /** @type {PcbDocument} */
        this.document = document;
        /** @type {PcbText} Full-precision snapshot consumed by UI adapters. */
        this.snapshot = serializePcbText(requireText(document, textId));
    }
    lockTargets() { return [{ kind: 'text', object: this.document.texts.get(this.snapshot.id) }]; }
    execute() { this.document.texts.delete(this.snapshot.id); }
    undo() { this.document.texts.set(this.snapshot.id, { ...this.snapshot }); }
    get description() { return `Delete text "${this.snapshot.content}"`; }
}

export class MoveTextCommand {
    /** @param {PcbDocument} document @param {string} textId @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1 */
    constructor(document, textId, x0, y0, x1, y1) {
        /** @type {PcbDocument} */
        this.document = document;
        this.id = textId;
        this.x0 = x0; this.y0 = y0;
        this.x1 = x1; this.y1 = y1;
        this.wasDetached = !!panelNote(document, textId)?.detached;
    }
    lockTargets() { return [{ kind: 'text', object: this.document.texts.get(this.id) }]; }
    execute() {
        this._set(this.x1, this.y1);
        const note = panelNote(this.document, this.id);
        if (note && (this.x0 !== this.x1 || this.y0 !== this.y1)) note.detached = true;
    }
    undo() {
        this._set(this.x0, this.y0);
        const note = panelNote(this.document, this.id);
        if (note) {
            if (this.wasDetached) note.detached = true;
            else delete note.detached;
        }
    }
    /** @param {number} x @param {number} y */
    _set(x, y) {
        const text = requireText(this.document, this.id);
        text.x = x; text.y = y;
    }
    get description() { return 'Move text'; }
}

export class EditTextCommand {
    /** @param {PcbDocument} document @param {string} textId @param {PcbTextPatch} after @param {boolean} [preservePanelOwnership] */
    constructor(document, textId, after, preservePanelOwnership = false) {
        /** @type {PcbDocument} */
        this.document = document;
        this.id = textId;
        this.preservePanelOwnership = preservePanelOwnership;
        this.wasDetached = !!panelNote(document, textId)?.detached;
        const text = requireText(document, textId);
        /** @type {PcbTextPatch} */
        this.before = {};
        /** @type {PcbTextPatch} */
        this.after = {};
        const current = /** @type {PcbText} */ (text);
        for (const key of /** @type {(keyof PcbText)[]} */ (Object.keys(after))) {
            /** @type {Record<string, unknown>} */ (this.before)[key] = current[key];
            /** @type {Record<string, unknown>} */ (this.after)[key] = after[key];
        }
    }
    lockTargets() { return editTargets('text', this.document.texts.get(this.id), this.before, this.after); }
    execute() {
        this._apply(this.after);
        const note = panelNote(this.document, this.id);
        if (note && !this.preservePanelOwnership
            && Object.keys(this.after).some(key => this.before[key] !== this.after[key])) note.detached = true;
    }
    undo() {
        this._apply(this.before);
        const note = panelNote(this.document, this.id);
        if (note && !this.preservePanelOwnership) {
            if (this.wasDetached) note.detached = true;
            else delete note.detached;
        }
    }
    /** @param {PcbTextPatch} patch */
    _apply(patch) { Object.assign(requireText(this.document, this.id), patch); }
    get description() { return 'Edit text'; }
}
