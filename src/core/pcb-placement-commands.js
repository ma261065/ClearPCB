import { capturePlacementOverride } from './PcbPlacementState.js';
import { updatePlacementPadPositions, repositionPadConnectedNodes,
    applyPlacementSide, disconnectIncompatiblePadNodes } from './pcb-placement-geometry.js';

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

function resolvePose(command, patch) {
    const footprint = command.project.getPcbFootprint(command.compId);
    if (!footprint) throw new Error(`PCB footprint is no longer available: ${command.compId}`);
    const current = command.placementState.overrides.get(command.compId) || command.initial;
    const placement = { ...capturePlacementOverride({ ...current, ...patch }),
        padOffsets: footprint.padOffsets, pasteOffsets: footprint.pasteOffsets, pads: new Map() };
    updatePlacementPadPositions(placement);
    return placement;
}

function applyPose(command, patch) {
    const placement = resolvePose(command, patch);
    const tracks = repositionPadConnectedNodes(command.project.pcbDocument.tracks, command.compId, placement.pads);
    return { pose: command.placementState.record(command.compId, placement), pads: placement.pads, tracks };
}

export class MovePlacementCommand {
    /** @param {import('./ProjectDocument.js').ProjectDocument} project @param {PlacementSeed} [initial] */
    constructor(project, compId, fromX, fromY, toX, toY, initial) {
        this.project = project;
        this.placementState = project.pcbDocument.placementState;
        this.compId = compId;
        this.initial = initialPlacement(this.placementState, compId, initial);
        this.from = { x: fromX, y: fromY };
        this.to = { x: toX, y: toY };
    }
    _apply(point) { return applyPose(this, point); }
    execute() { this._apply(this.to); }
    undo() { this._apply(this.from); }
}

export class RotatePlacementCommand {
    /** @param {import('./ProjectDocument.js').ProjectDocument} project @param {PlacementSeed} [initial] */
    constructor(project, compId, fromDeg, toDeg, initial) {
        this.project = project;
        this.placementState = project.pcbDocument.placementState;
        this.compId = compId;
        this.initial = initialPlacement(this.placementState, compId, initial);
        this.from = ((fromDeg % 360) + 360) % 360;
        this.to = ((toDeg % 360) + 360) % 360;
    }
    _apply(rotation) { return applyPose(this, { rotation }); }
    execute() { this._apply(this.to); }
    undo() { this._apply(this.from); }
}

export class FlipPlacementCommand {
    /** @param {import('./ProjectDocument.js').ProjectDocument} project @param {PlacementSeed} [initial] */
    constructor(project, compId, axis, initial) {
        this.project = project;
        this.placementState = project.pcbDocument.placementState;
        this.compId = compId;
        this.initial = initialPlacement(this.placementState, compId, initial);
        const rotation = ((this.initial.rotation % 360) + 360) % 360;
        this.before = { rotation, mirror: this.initial.mirror };
        this.after = {
            rotation: axis === 'V' ? (180 - rotation + 360) % 360 : (360 - rotation) % 360,
            mirror: !this.initial.mirror,
        };
    }
    _apply(pose) { return applyPose(this, pose); }
    execute() { this._apply(this.after); }
    undo() { this._apply(this.before); }
}

export class SetPlacementSideCommand {
    /** @param {import('./ProjectDocument.js').ProjectDocument} project @param {PlacementSeed} [initial] */
    constructor(project, compId, side, initial) {
        this.project = project;
        this.placementState = project.pcbDocument.placementState;
        this.compId = compId;
        this.initial = initialPlacement(this.placementState, compId, initial);
        this.before = this.initial.side;
        this.after = side === 'bottom' ? 'bottom' : 'top';
        this._bonds = null;
    }
    _snapshotBonds() {
        const snapshot = new Map();
        for (const track of this.project.pcbDocument.tracks) {
            if (!track.padConnections?.size) continue;
            snapshot.set(track, new Map([...track.padConnections].map(([id, connection]) => [id, { ...connection }])));
        }
        return snapshot;
    }
    _restoreBonds() {
        const touched = new Set();
        for (const [track, bonds] of this._bonds || []) {
            const current = track.padConnections;
            if (current.size !== bonds.size || [...bonds].some(([id, connection]) =>
                !current.has(id) || current.get(id)?.componentId !== connection.componentId
                || current.get(id)?.pinNumber !== connection.pinNumber)) {
                track.invalidate();
                touched.add(track);
            }
            current.clear();
            for (const [id, connection] of bonds) current.set(id, { ...connection });
        }
        return touched;
    }
    _apply(side, restore = false) {
        // Resolve first: a missing footprint must not restore bonds or replace the undo snapshot.
        const placement = resolvePose(this, { side });
        applyPlacementSide(placement, placement.side);
        const tracks = restore ? this._restoreBonds() : new Set();
        if (!restore) this._bonds = this._snapshotBonds();
        const boardTracks = this.project.pcbDocument.tracks;
        for (const track of disconnectIncompatiblePadNodes(boardTracks, this.compId, placement.padOffsets)) tracks.add(track);
        for (const track of repositionPadConnectedNodes(boardTracks, this.compId, placement.pads)) tracks.add(track);
        return { pose: this.placementState.record(this.compId, placement), pads: placement.pads, tracks };
    }
    execute() { this._apply(this.after); }
    undo() { this._apply(this.before, true); }
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
