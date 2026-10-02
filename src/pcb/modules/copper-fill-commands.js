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

function refresh(app) {
    // Empty or deferred pours still need connectivity, without requesting another pour.
    if (app._recomputeFillsNow?.() !== true) app.updateRatsnest?.({ skipFillRefresh: true });
}

/** Add a CopperFill to the canonical app.boardShapes collection. */
export class AddFillCommand extends ModelAddFillCommand {
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
        if (isPcbSelected(this.app, 'fill', this.fill)) this.app.selectFill?.(null);
        refresh(this.app);
    }
}

/** Remove an existing CopperFill. */
export class RemoveFillCommand extends ModelRemoveFillCommand {
    constructor(app, fill) {
        super(app.pcbDocument, fill);
        this.app = app;
    }
    execute() {
        super.execute();
        if (isPcbSelected(this.app, 'fill', this.fill)) this.app.selectFill?.(null);
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
    constructor(app, fill, before, after) {
        super(fill, before, after);
        this.app = app;
    }
    _apply(state) {
        super._apply(state);
        if (!areDragOverlaysDeferred(this.app)) {
            refresh(this.app);
        }
        this.app._refreshFillProperties?.(this.fill);
        renderPcbSelectionAnchors(this.app);
    }
}
