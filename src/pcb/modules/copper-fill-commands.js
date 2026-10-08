/**
 * Command classes for CopperFill undo/redo.
 *
 * Core commands own the authored region and undo state. These adapters
 * recompute derived pours synchronously unless a drag defers refresh;
 * pour completion owns subsequent connectivity and DRC updates.
 */

import {
    AddFillCommand as ModelAddFillCommand, RemoveFillCommand as ModelRemoveFillCommand,
    ModifyFillCommand as ModelModifyFillCommand,
} from '../../core/pcb-fill-commands.js';
import { isPcbSelected } from './selection-registry.js';
import { renderPcbSelectionAnchors } from './selection-anchors.js';
import { areDragOverlaysDeferred } from './refresh-state.js';
import { recomputeFillsNow } from './fill-refresh.js';
import { setComputedFill } from './computed-fill-cache.js';
import { refreshFillProperties } from './copper-fill-edit.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */
/** @typedef {import('../../shapes/copper-fill.js').CopperFill} CopperFill */
/** @typedef {import('../../shapes/copper-fill.js').CopperFillState} CopperFillState */

/** State that does not shape a pour's copper; changing only these keeps its computed copper. */
const NON_GEOMETRY = new Set(['net', 'locked', 'visible']);

/** Whether a state change moves or reshapes the poured copper (outline, kind, layer, corners). */
/** @param {Partial<CopperFillState>|null|undefined} before @param {Partial<CopperFillState>|null|undefined} after */
function reshapesCopper(before, after) {
    const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
    return [...keys].some(key => !NON_GEOMETRY.has(key) && JSON.stringify((/** @type {Record<string, unknown>|null|undefined} */ (before))?.[key]) !== JSON.stringify((/** @type {Record<string, unknown>|null|undefined} */ (after))?.[key]));
}

/** @param {PcbEditor} app */
function refresh(app) {
    // Empty or deferred pours still need connectivity, without requesting another pour.
    if (recomputeFillsNow(app) !== true) app.updateRatsnest({ skipFillRefresh: true });
}

/** Add a CopperFill to the canonical app.boardShapes collection. */
export class AddFillCommand extends ModelAddFillCommand {
    /** @param {PcbEditor} app @param {CopperFill} fill */
    constructor(app, fill) {
        super(app.pcbDocument, fill);
        this.app = app;
    }
    execute() {
        super.execute();
        refresh(this.app);
    }
    undo() {
        super.undo();
        if (isPcbSelected(this.app, 'fill', this.fill)) this.app.selectFill(null);
        refresh(this.app);
    }
}

/** Remove an existing CopperFill. */
export class RemoveFillCommand extends ModelRemoveFillCommand {
    /** @param {PcbEditor} app @param {CopperFill} fill */
    constructor(app, fill) {
        super(app.pcbDocument, fill);
        this.app = app;
    }
    execute() {
        super.execute();
        if (isPcbSelected(this.app, 'fill', this.fill)) this.app.selectFill(null);
        refresh(this.app);
    }
    undo() {
        super.undo();
        refresh(this.app);
    }
}

/**
 * Change a CopperFill's state (net / layer / outline). `before` and
 * `after` are captureState() snapshots.
 */
export class ModifyFillCommand extends ModelModifyFillCommand {
    /** @param {PcbEditor} app @param {CopperFill} fill @param {CopperFillState} before @param {CopperFillState} after */
    constructor(app, fill, before, after) {
        super(fill, before, after);
        this.app = app;
    }
    /** @param {CopperFillState} state */
    _apply(state) {
        const reshaped = reshapesCopper(this.fill.captureState(), state);
        super._apply(state);
        // Copper computed for the old outline must never be drawn at the new one: until the
        // recompute lands (later when it waits for geometry to load), the pour shows its outline.
        if (reshaped) setComputedFill(this.fill, null);
        if (!areDragOverlaysDeferred(this.app)) {
            refresh(this.app);
        }
        refreshFillProperties(this.app, this.fill);
        renderPcbSelectionAnchors(this.app);
    }
}
