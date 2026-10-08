import { getBoardOutline, rectangleBoardOutline } from '../shared/pcb/board-outline.js';

/**
 * @typedef {{width: number, height: number, radius: number, outline?: any}} BoardOutlineCommandState
 */

export class SetBoardOutlineCommand {
    /**
     * @param {import('./PcbDocument.js').PcbDocument} document
     * @param {BoardOutlineCommandState} before
     * @param {BoardOutlineCommandState} after
     */
    constructor(document, before, after) {
        this.document = document;
        this.before = { ...before, outline: structuredClone(getBoardOutline(document)) };
        this.after = { ...after, outline: after.outline
            ? structuredClone(after.outline)
            : rectangleBoardOutline(after.width, after.height, after.radius) };
    }
    /** @param {BoardOutlineCommandState} state */
    _apply(state) {
        this.document.setBoardOutline(state.outline
            || rectangleBoardOutline(state.width, state.height, state.radius));
    }
    /**
     * The outline has its own validity rules and lock checkbox, and New/first-open set it
     * programmatically even when the outline layer lock is remembered from a past session.
     */
    lockTargets() { return []; }
    execute() { this._apply(this.after); }
    undo() { this._apply(this.before); }
}
