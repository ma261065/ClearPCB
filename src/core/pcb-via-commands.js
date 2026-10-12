import { editTargets } from './edit-guard.js';
/** @typedef {import('./PcbDocument.js').PcbDocument} PcbDocument */
/** @typedef {import('../shapes/via.js').Via} Via */
/** @typedef {Partial<ReturnType<Via['captureState']>> & object} ViaState */
/** @typedef {{via: Via, before: ViaState, after: ViaState}} ViaChange */

export class AddViaCommand {
    /** @param {PcbDocument} document @param {Via} via */
    constructor(document, via) { this.document = document; this.via = via; }
    lockTargets() { return []; }
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
    lockTargets() { return [{ kind: 'via', object: this.via }]; }
    execute() {
        const index = this.document.vias.indexOf(this.via);
        if (index >= 0) this.document.vias.splice(index, 1);
    }
    undo() {
        if (!this.document.vias.includes(this.via)) this.document.vias.push(this.via);
    }
}

export class ModifyViaCommand {
    /** @param {Via} via @param {ViaState} before @param {ViaState} after */
    constructor(via, before, after) {
        this.via = via;
        this.before = { ...before };
        this.after = { ...after };
    }
    /** @param {ViaState} state */
    _apply(state) { this.via.applyState(state); }
    lockTargets() { return editTargets('via', this.via, this.before, this.after); }
    execute() { this._apply(this.after); }
    undo() { this._apply(this.before); }
}

export class ModifyViasCommand {
    /** @param {ViaChange[]} changes */
    constructor(changes) {
        this.changes = changes.map(({ via, before, after }) => ({
            via,
            before: { ...before },
            after: { ...after },
        }));
    }
    /** @param {'before'|'after'} stateKey */
    _apply(stateKey) {
        for (const change of this.changes) change.via.applyState(change[stateKey]);
    }
    lockTargets() { return this.changes.flatMap(({ via, before, after }) => editTargets('via', via, before, after)); }
    execute() { this._apply('after'); }
    undo() { this._apply('before'); }
}

export class MoveViaCommand {
    /** @param {Via} via @param {number} fromX @param {number} fromY @param {number} toX @param {number} toY */
    constructor(via, fromX, fromY, toX, toY) {
        this.via = via;
        this.from = { x: fromX, y: fromY };
        this.to = { x: toX, y: toY };
    }
    /** @param {{x: number, y: number}} point */
    _set(point) {
        this.via.x = point.x;
        this.via.y = point.y;
    }
    lockTargets() { return [{ kind: 'via', object: this.via }]; }
    execute() { this._set(this.to); }
    undo() { this._set(this.from); }
}
