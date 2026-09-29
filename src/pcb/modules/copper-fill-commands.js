/**
 * Command classes for CopperFill undo/redo.
 *
 * Fills are derived geometry: the model is just the user-authored region
 * (outline + layer + net). Model changes recompute pours synchronously;
 * pour completion owns the subsequent connectivity and DRC refresh.
 */

import { isPcbSelected } from './selection-registry.js';
import { renderPcbSelectionAnchors } from './selection-anchors.js';

function refresh(app) {
    // Empty or deferred pours still need connectivity, without requesting another pour.
    if (app._recomputeFillsNow?.() !== true) app._updateRatsnest?.({ skipFillRefresh: true });
}

/** Add a CopperFill to the canonical app.boardShapes collection. */
export class AddFillCommand {
    constructor(app, fill) {
        this.app = app;
        this.fill = fill;
    }
    execute() {
        if (!this.app.boardShapes.includes(this.fill)) this.app.boardShapes.push(this.fill);
        refresh(this.app);
    }
    undo() {
        const i = this.app.boardShapes.indexOf(this.fill);
        if (i >= 0) this.app.boardShapes.splice(i, 1);
        if (isPcbSelected(this.app, 'fill', this.fill)) this.app._selectFill?.(null);
        refresh(this.app);
    }
}

/** Remove an existing CopperFill. */
export class RemoveFillCommand {
    constructor(app, fill) {
        this.app = app;
        this.fill = fill;
    }
    execute() {
        const i = this.app.boardShapes.indexOf(this.fill);
        if (i >= 0) this.app.boardShapes.splice(i, 1);
        if (isPcbSelected(this.app, 'fill', this.fill)) this.app._selectFill?.(null);
        refresh(this.app);
    }
    undo() {
        if (!this.app.boardShapes.includes(this.fill)) this.app.boardShapes.push(this.fill);
        refresh(this.app);
    }
}

/**
 * Change a CopperFill's state (net / layer / outline). `before` and
 * `after` are captureState() snapshots.
 */
export class ModifyFillCommand {
    constructor(app, fill, before, after) {
        this.app = app;
        this.fill = fill;
        this.before = before;
        this.after = after;
    }
    execute() {
        this.fill.applyState(this.after);
        if (!this.app._deferDragOverlays) {
            refresh(this.app);
        }
        this.app._refreshFillProperties?.(this.fill);
        renderPcbSelectionAnchors(this.app);
    }
    undo() {
        this.fill.applyState(this.before);
        if (!this.app._deferDragOverlays) {
            refresh(this.app);
        }
        this.app._refreshFillProperties?.(this.fill);
        renderPcbSelectionAnchors(this.app);
    }
}
