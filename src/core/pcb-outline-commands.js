import { getBoardOutline, rectangleBoardOutline } from '../pcb/modules/board-outline.js';

export class SetBoardOutlineCommand {
    /** @param {import('./PcbDocument.js').PcbDocument} document */
    constructor(document, before, after) {
        this.document = document;
        this.before = { ...before, outline: structuredClone(getBoardOutline(document)) };
        this.after = { ...after, outline: after.outline
            ? structuredClone(after.outline)
            : rectangleBoardOutline(after.width, after.height, after.radius) };
    }
    _apply(state) {
        this.document.setBoardOutline(state.outline
            || rectangleBoardOutline(state.width, state.height, state.radius));
    }
    execute() { this._apply(this.after); }
    undo() { this._apply(this.before); }
}
