import {
    AddPadCommand as ModelAddPadCommand, RemovePadCommand as ModelRemovePadCommand,
    ModifyPadCommand as ModelModifyPadCommand, MovePadCommand as ModelMovePadCommand,
} from '../../core/pcb-pad-commands.js';
import { renderPad, removePadElements, updatePadHighlightGeometry } from './pad.js';
import { clearPcbSelection, isPcbSelected } from './selection-registry.js';
import { schedulePictureCopperRefresh } from './picture-refresh.js';
import { Pad } from '../../shapes/pad.js';

const padRotationPreviews = new WeakMap();

export function getPadRotationPreview(app) {
    return padRotationPreviews.get(app);
}

export function beginPadRotationPreview(app, original, start) {
    if (padRotationPreviews.has(app)) {
        throw new Error('Finish the current pad rotation preview before starting another.');
    }
    padRotationPreviews.set(app, {
        original, pad: original, start: { ...start }, rotation: original.rotation, pads: undefined,
    });
    app._rotationHandleDrag = true;
}

/** Allocate once, on the first changed rotation, without touching authored geometry. */
export function previewPadRotation(app, original, rotation) {
    const preview = padRotationPreviews.get(app);
    if (!preview || preview.original !== original) {
        throw new Error('Begin the pad rotation preview before updating it.');
    }
    if (!preview.pads) {
        if (!app.pcbDocument.pads.includes(original)) throw new Error('Cannot rotate a missing pad.');
        const pad = Object.assign(new Pad({ id: original.id }), original.captureState());
        preview.pad = pad;
        preview.pads = app.pcbDocument.pads.map(item => item === original ? pad : item);
        removePadElements(original);
    }
    preview.pad.rotation = rotation;
    return preview.pad;
}

/** Hand artwork and collection ownership back before invoking the model command. */
export function finishPadRotationPreview(app, commit) {
    const preview = padRotationPreviews.get(app);
    padRotationPreviews.delete(app);
    if (preview) {
        app._rotationHandleDrag = false;
        if (preview.pads) removePadElements(preview.pad);
    }
    let committed = false;
    try {
        if (commit) {
            if (!preview || !app.pcbDocument.pads.includes(preview.original)) {
                throw new Error('Cannot rotate a missing pad.');
            }
            commit();
            committed = true;
        }
    } finally {
        if (preview?.pads && !committed && app.pcbDocument.pads.includes(preview.original)) {
            renderPad(preview.original, id => app._getLayerGroup(id));
        }
        if (preview) {
            updatePadHighlightGeometry(preview.original, app._getLayerGroup('selection-overlay'));
            const input = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropPadRotation'));
            if (input) input.value = String(preview.original.rotation);
        }
    }
}

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
