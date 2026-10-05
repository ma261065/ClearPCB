/** @typedef {import('./PcbDocument.js').PcbDocument} PcbDocument */

/**
 * Set one PCB object's own lock flag (saved as `lk`). Layer locks are editor
 * preferences, not document data, so they have no command.
 *
 * Free text resolves by id because undoing a text deletion recreates its
 * record; every other kind keeps its instance across remove/add undo.
 */
export class SetObjectLockedCommand {
    /**
     * @param {PcbDocument} document
     * @param {'track'|'via'|'pad'|'shape'|'fill'|'text'} kind
     * @param {{id: string, locked?: boolean}} object
     * @param {boolean} locked
     */
    constructor(document, kind, object, locked) {
        this.document = document;
        this.kind = kind;
        this.object = kind === 'text' ? null : object;
        this.textId = kind === 'text' ? object.id : null;
        this.before = !!object.locked;
        this.after = !!locked;
    }

    target() {
        if (this.kind !== 'text') return this.object;
        const text = this.document.texts.get(this.textId);
        if (!text) throw new Error(`PCB text is no longer available: ${this.textId}`);
        return text;
    }

    _apply(locked) { this.target().locked = locked; }
    /** Lock changes are how locks are lifted, so they are never refused. */
    lockTargets() { return []; }
    execute() { this._apply(this.after); }
    undo() { this._apply(this.before); }
    get description() { return this.after ? 'Lock' : 'Unlock'; }
}
