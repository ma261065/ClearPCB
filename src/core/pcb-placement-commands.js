import { capturePlacementOverride } from './PcbPlacementState.js';

/** @typedef {import('./PcbPlacementState.js').PcbPlacementState} PcbPlacementState */
/** @typedef {Partial<import('./PcbPlacementState.js').PlacementOverride> & {x:number, y:number}} PlacementSeed */

function initialPlacement(placementState, compId, initial) {
    const placement = placementState.overrides.get(compId) || initial;
    if (!placement) throw new Error(`PCB placement is no longer available: ${compId}`);
    return capturePlacementOverride(placement);
}

function applyPatch(command, patch) {
    const current = command.placementState.overrides.get(command.compId) || command.initial;
    return command.placementState.record(command.compId, { ...current, ...patch });
}

export class SetPlacementLockedCommand {
    /** @param {PcbPlacementState} placementState @param {PlacementSeed} [initial] */
    constructor(placementState, compId, locked, initial) {
        this.placementState = placementState;
        this.compId = compId;
        this.initial = initialPlacement(placementState, compId, initial);
        this.before = this.initial.locked;
        this.after = !!locked;
    }
    _apply(locked) { return applyPatch(this, { locked }); }
    execute() { this._apply(this.after); }
    undo() { this._apply(this.before); }
}

export class SetPlacementRefVisibleCommand {
    /** @param {PcbPlacementState} placementState @param {PlacementSeed} [initial] */
    constructor(placementState, compId, visible, initial) {
        this.placementState = placementState;
        this.compId = compId;
        this.initial = initialPlacement(placementState, compId, initial);
        this.before = this.initial.refVisible;
        this.after = visible !== false;
    }
    _apply(visible) { return applyPatch(this, { refVisible: visible }); }
    execute() { this._apply(this.after); }
    undo() { this._apply(this.before); }
}

export class MoveRefTextCommand {
    /** @param {PcbPlacementState} placementState @param {PlacementSeed} [initial] */
    constructor(placementState, compId, fromDx, fromDy, toDx, toDy, initial) {
        this.placementState = placementState;
        this.compId = compId;
        this.initial = initialPlacement(placementState, compId, initial);
        this.from = { refDx: fromDx, refDy: fromDy };
        this.to = { refDx: toDx, refDy: toDy };
    }
    _apply(offset) { return applyPatch(this, offset); }
    execute() { this._apply(this.to); }
    undo() { this._apply(this.from); }
}

export class RotateRefTextCommand {
    /** @param {PcbPlacementState} placementState @param {PlacementSeed} [initial] */
    constructor(placementState, compId, fromDeg, toDeg, initial) {
        this.placementState = placementState;
        this.compId = compId;
        this.initial = initialPlacement(placementState, compId, initial);
        this.from = ((fromDeg % 360) + 360) % 360;
        this.to = ((toDeg % 360) + 360) % 360;
    }
    _apply(refRot) { return applyPatch(this, { refRot }); }
    execute() { this._apply(this.to); }
    undo() { this._apply(this.from); }
}

export class SetRefStyleCommand {
    /** @param {PcbPlacementState} placementState @param {PlacementSeed} [initial] */
    constructor(placementState, compId, before, after, initial) {
        this.placementState = placementState;
        this.compId = compId;
        this.initial = initialPlacement(placementState, compId, initial);
        this.before = { ...before };
        this.after = { ...after };
    }
    _apply(state) {
        const patch = {};
        if (state.refSize !== undefined) patch.refSize = state.refSize;
        if (state.refStrokeWidth !== undefined) patch.refStrokeWidth = state.refStrokeWidth;
        if (state.refRot !== undefined) patch.refRot = state.refRot;
        return applyPatch(this, patch);
    }
    execute() { this._apply(this.after); }
    undo() { this._apply(this.before); }
}
