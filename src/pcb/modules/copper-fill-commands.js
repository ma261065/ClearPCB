/**
 * Command classes for CopperFill undo/redo.
 *
 * Fills are derived geometry: the model is just the user-authored region
 * (outline + layer + net). After any model change the app recomputes and
 * re-renders all pours via app._refreshFills().
 */

/** Add a CopperFill to app.copperFills. */
export class AddFillCommand {
    constructor(app, fill) {
        this.app = app;
        this.fill = fill;
    }
    execute() {
        if (!this.app.copperFills.includes(this.fill)) this.app.copperFills.push(this.fill);
        this.app._refreshFills?.();
    }
    undo() {
        const i = this.app.copperFills.indexOf(this.fill);
        if (i >= 0) this.app.copperFills.splice(i, 1);
        if (this.app._selectedFill === this.fill) this.app._selectFill?.(null);
        this.app._refreshFills?.();
    }
}

/** Remove an existing CopperFill. */
export class RemoveFillCommand {
    constructor(app, fill) {
        this.app = app;
        this.fill = fill;
    }
    execute() {
        const i = this.app.copperFills.indexOf(this.fill);
        if (i >= 0) this.app.copperFills.splice(i, 1);
        if (this.app._selectedFill === this.fill) this.app._selectFill?.(null);
        this.app._refreshFills?.();
    }
    undo() {
        if (!this.app.copperFills.includes(this.fill)) this.app.copperFills.push(this.fill);
        this.app._refreshFills?.();
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
        this.app._refreshFills?.();
        this.app._refreshFillProperties?.(this.fill);
    }
    undo() {
        this.fill.applyState(this.before);
        this.app._refreshFills?.();
        this.app._refreshFillProperties?.(this.fill);
    }
}
