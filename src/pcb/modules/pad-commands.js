import { renderPad, removePadElements } from './pad.js';
import { clearPcbSelection, isPcbSelected } from './selection-registry.js';
import { schedulePictureCopperRefresh } from './picture-refresh.js';

function refresh(app, pad) {
    renderPad(pad, id => app._getLayerGroup(id));
    schedulePictureCopperRefresh(app, pad);
}

export class AddPadCommand {
    constructor(app, pad) { this.app = app; this.pad = pad; }
    execute() {
        if (!this.app.pads.includes(this.pad)) this.app.pads.push(this.pad);
        refresh(this.app, this.pad);
    }
    undo() {
        removePadElements(this.pad);
        this.app.pads = this.app.pads.filter(pad => pad !== this.pad);
        if (isPcbSelected(this.app, 'pad', this.pad)) clearPcbSelection(this.app);
        schedulePictureCopperRefresh(this.app, this.pad);
    }
}

export class RemovePadCommand {
    constructor(app, pad) { this.app = app; this.pad = pad; }
    execute() {
        removePadElements(this.pad);
        this.app.pads = this.app.pads.filter(candidate => candidate !== this.pad);
        if (isPcbSelected(this.app, 'pad', this.pad)) clearPcbSelection(this.app);
        schedulePictureCopperRefresh(this.app, this.pad);
    }
    undo() {
        if (!this.app.pads.includes(this.pad)) this.app.pads.push(this.pad);
        refresh(this.app, this.pad);
    }
}

export class ModifyPadCommand {
    constructor(app, pad, before, after) {
        this.app = app; this.pad = pad; this.before = before; this.after = after;
    }
    _apply(state) {
        this.pad.applyState(state);
        refresh(this.app, this.pad);
    }
    execute() { this._apply(this.after); }
    undo() { this._apply(this.before); }
}

export class MovePadCommand {
    constructor(app, pad, from, to) {
        this.app = app; this.pad = pad; this.from = from; this.to = to;
    }
    _apply(point) {
        this.pad.x = point.x;
        this.pad.y = point.y;
        refresh(this.app, this.pad);
    }
    execute() { this._apply(this.to); }
    undo() { this._apply(this.from); }
}
