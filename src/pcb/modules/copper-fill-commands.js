/**
 * Command classes for CopperFill undo/redo.
 *
 * Fills are derived geometry: the model is just the user-authored region
 * (outline + layer + net). After any model change the app recomputes and
 * re-renders all pours via app._refreshFills().
 */

import { isPcbSelected } from './selection-registry.js';

/** Add a CopperFill to the canonical app.boardShapes collection. */
export class AddFillCommand {
    constructor(app, fill) {
        this.app = app;
        this.fill = fill;
    }
    execute() {
        if (!this.app.boardShapes.includes(this.fill)) this.app.boardShapes.push(this.fill);
        this.app._recomputeFillsNow?.();
        this.app._updateRatsnest?.();
    }
    undo() {
        const i = this.app.boardShapes.indexOf(this.fill);
        if (i >= 0) this.app.boardShapes.splice(i, 1);
        if (isPcbSelected(this.app, 'fill', this.fill)) this.app._selectFill?.(null);
        this.app._recomputeFillsNow?.();
        this.app._updateRatsnest?.();
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
        this.app._recomputeFillsNow?.();
        this.app._updateRatsnest?.();
    }
    undo() {
        if (!this.app.boardShapes.includes(this.fill)) this.app.boardShapes.push(this.fill);
        this.app._recomputeFillsNow?.();
        this.app._updateRatsnest?.();
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
        // Recompute pours synchronously so fill._computed is fresh, then
        // reconcile the ratsnest — a net/layer change alters which copper the
        // pour bonds, so ratlines must reappear/disappear accordingly.
        if (!this.app._deferDragOverlays) {
            this.app._recomputeFillsNow?.();
            this.app._updateRatsnest?.();
        }
        this.app._refreshFillProperties?.(this.fill);
    }
    undo() {
        this.fill.applyState(this.before);
        if (!this.app._deferDragOverlays) {
            this.app._recomputeFillsNow?.();
            this.app._updateRatsnest?.();
        }
        this.app._refreshFillProperties?.(this.fill);
    }
}
