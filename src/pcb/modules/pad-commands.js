import {
    AddPadCommand as ModelAddPadCommand, RemovePadCommand as ModelRemovePadCommand,
    ModifyPadCommand as ModelModifyPadCommand, MovePadCommand as ModelMovePadCommand,
} from '../../core/pcb-pad-commands.js';
import { renderPad, removePadElements } from './pad.js';
import { clearPcbSelection, isPcbSelected } from './selection-registry.js';
import { schedulePictureCopperRefresh } from './picture-refresh.js';

function refresh(app, pad) {
    renderPad(pad, id => app._getLayerGroup(id));
    schedulePictureCopperRefresh(app, pad);
}

export class AddPadCommand extends ModelAddPadCommand {
    constructor(app, pad) { super(app.pcbDocument, pad); this.app = app; }
    execute() {
        super.execute();
        refresh(this.app, this.pad);
    }
    undo() {
        removePadElements(this.pad);
        super.undo();
        if (isPcbSelected(this.app, 'pad', this.pad)) clearPcbSelection(this.app);
        schedulePictureCopperRefresh(this.app, this.pad);
    }
}

export class RemovePadCommand extends ModelRemovePadCommand {
    constructor(app, pad) { super(app.pcbDocument, pad); this.app = app; }
    execute() {
        removePadElements(this.pad);
        super.execute();
        if (isPcbSelected(this.app, 'pad', this.pad)) clearPcbSelection(this.app);
        schedulePictureCopperRefresh(this.app, this.pad);
    }
    undo() {
        super.undo();
        refresh(this.app, this.pad);
    }
}

export class ModifyPadCommand extends ModelModifyPadCommand {
    constructor(app, pad, before, after) {
        super(pad, before, after); this.app = app;
    }
    _apply(state) {
        super._apply(state);
        refresh(this.app, this.pad);
    }
}

export class MovePadCommand extends ModelMovePadCommand {
    constructor(app, pad, from, to) {
        super(pad, from, to); this.app = app;
    }
    _apply(point) {
        super._apply(point);
        refresh(this.app, this.pad);
    }
}
