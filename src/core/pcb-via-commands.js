/** @typedef {import('./PcbDocument.js').PcbDocument} PcbDocument */
/** @typedef {import('../shapes/via.js').Via} Via */

export class AddViaCommand {
    /** @param {PcbDocument} document @param {Via} via */
    constructor(document, via) { this.document = document; this.via = via; }
    execute() {
        if (!this.document.vias.includes(this.via)) this.document.vias.push(this.via);
    }
    undo() {
        const index = this.document.vias.indexOf(this.via);
        if (index >= 0) this.document.vias.splice(index, 1);
    }
}

export class RemoveViaCommand {
    /** @param {PcbDocument} document @param {Via} via */
    constructor(document, via) { this.document = document; this.via = via; }
    execute() {
        const index = this.document.vias.indexOf(this.via);
        if (index >= 0) this.document.vias.splice(index, 1);
    }
    undo() {
        if (!this.document.vias.includes(this.via)) this.document.vias.push(this.via);
    }
}

export class ModifyViaCommand {
    /** @param {Via} via */
    constructor(via, before, after) {
        this.via = via;
        this.before = { ...before };
        this.after = { ...after };
    }
    _apply(state) { this.via.applyState(state); }
    execute() { this._apply(this.after); }
    undo() { this._apply(this.before); }
}

export class ModifyViasCommand {
    constructor(changes) {
        this.changes = changes.map(({ via, before, after }) => ({
            via,
            before: { ...before },
            after: { ...after },
        }));
    }
    _apply(stateKey) {
        for (const change of this.changes) change.via.applyState(change[stateKey]);
    }
    execute() { this._apply('after'); }
    undo() { this._apply('before'); }
}

export class MoveViaCommand {
    /** @param {Via} via */
    constructor(via, fromX, fromY, toX, toY) {
        this.via = via;
        this.from = { x: fromX, y: fromY };
        this.to = { x: toX, y: toY };
    }
    _set(point) {
        this.via.x = point.x;
        this.via.y = point.y;
    }
    execute() { this._set(this.to); }
    undo() { this._set(this.from); }
}
