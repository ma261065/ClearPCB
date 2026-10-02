import {
    AddPadCommand as ModelAddPadCommand, RemovePadCommand as ModelRemovePadCommand,
    ModifyPadCommand as ModelModifyPadCommand, MovePadCommand as ModelMovePadCommand,
} from '../../core/pcb-pad-commands.js';
import { renderPad, removePadElements, updatePadHighlightGeometry } from './pad.js';
import { clearPcbSelection, isPcbSelected } from './selection-registry.js';
import { schedulePictureCopperRefresh } from './picture-refresh.js';
import { Pad } from '../../shapes/pad.js';

const padRotationPreviews = new WeakMap();
const padPropertyPreviews = new WeakMap();

export function getPadPropertyPreview(app) {
    return padPropertyPreviews.get(app);
}

export function canonicalPad(app, pad) {
    if (app._viaDrag?.via === pad) return app._viaDrag.original;
    const rotation = padRotationPreviews.get(app);
    if (rotation?.pad === pad) return rotation.original;
    return padPropertyPreviews.get(app)?.originals.get(pad) || pad;
}

export function displayedPad(app, pad) {
    pad = canonicalPad(app, pad);
    if (app._viaDrag?.original === pad) return app._viaDrag.via;
    const rotation = padRotationPreviews.get(app);
    if (rotation?.original === pad) return rotation.pad;
    return padPropertyPreviews.get(app)?.copies.get(pad) || pad;
}

/** Numeric fields share one stable projection for the panel's selected pads. */
export function beginPadPropertyPreview(app, pads) {
    if (padPropertyPreviews.has(app) || padRotationPreviews.has(app) || app._viaDrag) {
        throw new Error('Finish the current pad preview before editing pad properties.');
    }
    const available = new Set(app.pcbDocument.pads);
    if (pads.some(pad => !available.has(pad))) throw new Error('Cannot edit a missing pad.');
    const before = new Map(pads.map(pad => [pad, pad.captureState()]));
    const copies = new Map(pads.map(pad => [pad, Object.assign(new Pad({ id: pad.id }), before.get(pad))]));
    const preview = {
        before, copies, originals: new Map([...copies].map(([pad, copy]) => [copy, pad])),
        pads: app.pcbDocument.pads.map(pad => copies.get(pad) || pad),
    };
    padPropertyPreviews.set(app, preview);
    for (const pad of pads) removePadElements(pad);
    return preview;
}

/** Clear the projection before committing; restore untouched artwork on every exit. */
export function finishPadPropertyPreview(app, commit) {
    const preview = padPropertyPreviews.get(app);
    if (!preview) return;
    padPropertyPreviews.delete(app);
    const changes = [];
    for (const [pad, copy] of preview.copies) {
        removePadElements(copy);
        const before = preview.before.get(pad), after = copy.captureState();
        if (Object.keys(before).some(key => before[key] !== after[key])) changes.push({ pad, before, after });
    }
    let committed = false;
    try {
        if (commit && changes.length) {
            const available = new Set(app.pcbDocument.pads);
            if ([...preview.copies.keys()].some(pad => !available.has(pad))) {
                throw new Error('Cannot edit a missing pad.');
            }
            commit(changes);
            committed = true;
        }
    } finally {
        const changed = new Set(committed ? changes.map(change => change.pad) : []);
        const available = new Set(app.pcbDocument.pads);
        for (const pad of preview.copies.keys()) {
            if (!available.has(pad)) continue;
            if (!changed.has(pad)) renderPad(pad, id => app.getLayerGroup(id));
            schedulePictureCopperRefresh(app, pad);
        }
    }
}

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
            renderPad(preview.original, id => app.getLayerGroup(id));
        }
        if (preview) {
            updatePadHighlightGeometry(preview.original, app.getLayerGroup('selection-overlay'));
            const input = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropPadRotation'));
            if (input) input.value = String(preview.original.rotation);
        }
    }
}

function refresh(app, pad) {
    renderPad(pad, id => app.getLayerGroup(id));
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
