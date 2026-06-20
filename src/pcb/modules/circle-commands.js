/**
 * Undoable commands for free-standing PCB circles.
 */

export class AddCircleCommand {
    constructor(app, circle) {
        this.app = app;
        this.circle = circle;
    }

    execute() {
        if (!this.app.circles.includes(this.circle)) this.app.circles.push(this.circle);
        this.app._renderCircle?.(this.circle);
        this.app._refreshFills?.();
    }

    undo() {
        this.app._removeCircleElement?.(this.circle.id);
        const i = this.app.circles.indexOf(this.circle);
        if (i >= 0) this.app.circles.splice(i, 1);
        this.app._updateCopperCuts?.();
        this.app._refreshFills?.();
    }
}

export class RemoveCircleCommand {
    constructor(app, circle) {
        this.app = app;
        this.circle = circle;
    }

    execute() {
        this.app._removeCircleElement?.(this.circle.id);
        const i = this.app.circles.indexOf(this.circle);
        if (i >= 0) this.app.circles.splice(i, 1);
        this.app._updateCopperCuts?.();
        this.app._refreshFills?.();
    }

    undo() {
        if (!this.app.circles.includes(this.circle)) this.app.circles.push(this.circle);
        this.app._renderCircle?.(this.circle);
        this.app._refreshFills?.();
    }
}

export class MoveCircleCommand {
    constructor(app, circle, x0, y0, x1, y1) {
        this.app = app;
        this.circle = circle;
        this.x0 = x0;
        this.y0 = y0;
        this.x1 = x1;
        this.y1 = y1;
    }

    execute() {
        this.circle.x = this.x1;
        this.circle.y = this.y1;
        this.app._renderCircle?.(this.circle);
        this.app._refreshFills?.();
    }

    undo() {
        this.circle.x = this.x0;
        this.circle.y = this.y0;
        this.app._renderCircle?.(this.circle);
        this.app._refreshFills?.();
    }
}

export class ModifyCircleCommand {
    constructor(app, circle, before, after) {
        this.app = app;
        this.circle = circle;
        this.before = before;
        this.after = after;
    }

    _apply(state) {
        this.circle.x = state.x;
        this.circle.y = state.y;
        this.circle.radius = state.radius;
        this.circle.layer = state.layer;
        this.circle.lineWidth = state.lineWidth;
        this.circle.filled = !!state.filled;
        const mode = String(state.copperMode || 'add');
        this.circle.copperMode = (mode === 'remove-copper' || mode === 'remove-solder-mask' || mode === 'remove-copper-mask')
            ? mode
            : (mode === 'remove' ? 'remove-copper-mask'
                : (mode === 'remove-mask' ? 'remove-solder-mask' : 'add'));
        this.app._renderCircle?.(this.circle);
        this.app._refreshFills?.();
        this.app._refreshCircleProperties?.(this.circle);
    }

    execute() {
        this._apply(this.after);
    }

    undo() {
        this._apply(this.before);
    }
}
