import { capturePlacementOverride } from './PcbPlacementState.js';
import { updatePlacementPadPositions, repositionPadConnectedNodes,
    applyPlacementSide, disconnectIncompatiblePadNodes } from './pcb-placement-geometry.js';

/** @typedef {import('./PcbPlacementState.js').PcbPlacementState} PcbPlacementState */
/** @typedef {import('./PcbPlacementState.js').PlacementOverride} PlacementOverride */
/** @typedef {Partial<import('./PcbPlacementState.js').PlacementOverride> & {x:number, y:number}} PlacementSeed */
/** @typedef {Partial<import('./PcbPlacementState.js').PlacementOverride> & Record<string, unknown>} PlacementPatch */
/** @typedef {{placementState: PcbPlacementState, compId: string, initial: PlacementOverride}} PlacementPatchCommand */
/** @typedef {ReturnType<import('./ProjectDocument.js').ProjectDocument['getPcbFootprint']>} ResolvedFootprint */
/** @typedef {{padOffsets: NonNullable<ResolvedFootprint>['padOffsets'], pasteOffsets: NonNullable<ResolvedFootprint>['pasteOffsets']}} CachedFootprint */
/** @typedef {PlacementPatchCommand & {project: import('./ProjectDocument.js').ProjectDocument, _footprint?: ResolvedFootprint|CachedFootprint}} PlacementPoseCommand */
/** @typedef {{refSize?: number, refStrokeWidth?: number, refRot?: number}} RefStylePatch */

/** @param {PcbPlacementState} placementState @param {string} compId @param {PlacementSeed|undefined} initial @returns {PlacementOverride} */
function initialPlacement(placementState, compId, initial) {
    const placement = placementState.overrides.get(compId) || placementState.autoSlots.get(compId) || initial;
    if (!placement) throw new Error(`PCB placement is no longer available: ${compId}`);
    return capturePlacementOverride(placement);
}

/** @param {PlacementPatchCommand} command @param {PlacementPatch} patch */
function applyPatch(command, patch) {
    const current = command.placementState.overrides.get(command.compId) || command.initial;
    return command.placementState.record(command.compId, { ...current, ...patch });
}

/** @param {PlacementPoseCommand} command @param {PlacementPatch} patch */
function resolvePose(command, patch) {
    const footprint = command.project.getPcbFootprint(command.compId) || command._footprint;
    if (!footprint) throw new Error(`PCB footprint is no longer available: ${command.compId}`);
    const current = command.placementState.overrides.get(command.compId) || command.initial;
    const placement = { ...capturePlacementOverride({ ...current, ...patch }),
        padOffsets: footprint.padOffsets, pasteOffsets: footprint.pasteOffsets, pads: new Map() };
    updatePlacementPadPositions(placement);
    // Independent schematic history may remove the component before PCB undo.
    // Retain geometry for copper/pose history without recreating that component.
    command._footprint = {
        padOffsets: structuredClone(footprint.padOffsets),
        pasteOffsets: structuredClone(footprint.pasteOffsets),
    };
    return placement;
}

/** @param {PlacementPoseCommand} command @param {PlacementPatch} patch */
function applyPose(command, patch) {
    const placement = resolvePose(command, patch);
    const tracks = repositionPadConnectedNodes(command.project.pcbDocument.tracks, command.compId, placement.pads);
    return { pose: command.placementState.record(command.compId, placement), pads: placement.pads, tracks };
}

export class MovePlacementCommand {
    /** @param {import('./ProjectDocument.js').ProjectDocument} project @param {string} compId @param {number} fromX @param {number} fromY @param {number} toX @param {number} toY @param {PlacementSeed} [initial] */
    constructor(project, compId, fromX, fromY, toX, toY, initial) {
        this.project = project;
        this.placementState = project.pcbDocument.placementState;
        this.compId = compId;
        this.initial = initialPlacement(this.placementState, compId, initial);
        this.from = { x: fromX, y: fromY };
        this.to = { x: toX, y: toY };
    }
    /** @param {{x:number,y:number}} point */
    _apply(point) { return applyPose(this, point); }
    lockTargets() { return [{ kind: 'component', object: this.compId }]; }
    execute() { this._apply(this.to); }
    undo() { this._apply(this.from); }
}

export class RotatePlacementCommand {
    /** @param {import('./ProjectDocument.js').ProjectDocument} project @param {string} compId @param {number} fromDeg @param {number} toDeg @param {PlacementSeed} [initial] */
    constructor(project, compId, fromDeg, toDeg, initial) {
        this.project = project;
        this.placementState = project.pcbDocument.placementState;
        this.compId = compId;
        this.initial = initialPlacement(this.placementState, compId, initial);
        this.from = ((fromDeg % 360) + 360) % 360;
        this.to = ((toDeg % 360) + 360) % 360;
    }
    /** @param {number} rotation */
    _apply(rotation) { return applyPose(this, { rotation }); }
    lockTargets() { return [{ kind: 'component', object: this.compId }]; }
    execute() { this._apply(this.to); }
    undo() { this._apply(this.from); }
}

export class FlipPlacementCommand {
    /** @param {import('./ProjectDocument.js').ProjectDocument} project @param {string} compId @param {'H'|'V'|string} axis @param {PlacementSeed} [initial] */
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
    /** @param {PlacementPatch} pose */
    _apply(pose) { return applyPose(this, pose); }
    lockTargets() { return [{ kind: 'component', object: this.compId }]; }
    execute() { this._apply(this.after); }
    undo() { this._apply(this.before); }
}

export class SetPlacementSideCommand {
    /** @param {import('./ProjectDocument.js').ProjectDocument} project @param {string} compId @param {'top'|'bottom'|string} side @param {PlacementSeed} [initial] */
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
    /** @param {'top'|'bottom'|string} side @param {boolean} [restore] */
    _apply(side, restore = false) {
        // Resolve before changing bonds; never-executed missing targets still fail atomically.
        const placement = resolvePose(this, { side });
        applyPlacementSide(placement, placement.side);
        const tracks = restore ? this._restoreBonds() : new Set();
        if (!restore) this._bonds = this._snapshotBonds();
        const boardTracks = this.project.pcbDocument.tracks;
        for (const track of disconnectIncompatiblePadNodes(boardTracks, this.compId, placement.padOffsets)) tracks.add(track);
        for (const track of repositionPadConnectedNodes(boardTracks, this.compId, placement.pads)) tracks.add(track);
        return { pose: this.placementState.record(this.compId, placement), pads: placement.pads, tracks };
    }
    lockTargets() { return [{ kind: 'component', object: this.compId }]; }
    execute() { this._apply(this.after); }
    undo() { this._apply(this.before, true); }
}

export class SetPlacementLockedCommand {
    /** @param {PcbPlacementState} placementState @param {string} compId @param {boolean} locked @param {PlacementSeed} [initial] */
    constructor(placementState, compId, locked, initial) {
        this.placementState = placementState;
        this.compId = compId;
        this.initial = initialPlacement(placementState, compId, initial);
        this.before = this.initial.locked;
        this.after = !!locked;
    }
    /** @param {boolean} locked */
    _apply(locked) { return applyPatch(this, { locked }); }
    /** Lock changes are how locks are lifted, so they are never refused. */
    lockTargets() { return []; }
    execute() { this._apply(this.after); }
    undo() { this._apply(this.before); }
}

export class SetPlacementRefVisibleCommand {
    /** @param {PcbPlacementState} placementState @param {string} compId @param {boolean} visible @param {PlacementSeed} [initial] */
    constructor(placementState, compId, visible, initial) {
        this.placementState = placementState;
        this.compId = compId;
        this.initial = initialPlacement(placementState, compId, initial);
        this.before = this.initial.refVisible;
        this.after = visible !== false;
    }
    /** @param {boolean} visible */
    _apply(visible) { return applyPatch(this, { refVisible: visible }); }
    lockTargets() { return [{ kind: 'component', object: this.compId }]; }
    execute() { this._apply(this.after); }
    undo() { this._apply(this.before); }
}

export class MoveRefTextCommand {
    /** @param {PcbPlacementState} placementState @param {string} compId @param {number} fromDx @param {number} fromDy @param {number} toDx @param {number} toDy @param {PlacementSeed} [initial] */
    constructor(placementState, compId, fromDx, fromDy, toDx, toDy, initial) {
        this.placementState = placementState;
        this.compId = compId;
        this.initial = initialPlacement(placementState, compId, initial);
        this.from = { refDx: fromDx, refDy: fromDy };
        this.to = { refDx: toDx, refDy: toDy };
    }
    /** @param {{refDx:number,refDy:number}} offset */
    _apply(offset) { return applyPatch(this, offset); }
    lockTargets() { return [{ kind: 'reftext', object: this.compId }]; }
    execute() { this._apply(this.to); }
    undo() { this._apply(this.from); }
}

export class RotateRefTextCommand {
    /** @param {PcbPlacementState} placementState @param {string} compId @param {number} fromDeg @param {number} toDeg @param {PlacementSeed} [initial] */
    constructor(placementState, compId, fromDeg, toDeg, initial) {
        this.placementState = placementState;
        this.compId = compId;
        this.initial = initialPlacement(placementState, compId, initial);
        this.from = ((fromDeg % 360) + 360) % 360;
        this.to = ((toDeg % 360) + 360) % 360;
    }
    /** @param {number} refRot */
    _apply(refRot) { return applyPatch(this, { refRot }); }
    lockTargets() { return [{ kind: 'reftext', object: this.compId }]; }
    execute() { this._apply(this.to); }
    undo() { this._apply(this.from); }
}

export class SetRefStyleCommand {
    /** @param {PcbPlacementState} placementState @param {string} compId @param {RefStylePatch} before @param {RefStylePatch} after @param {PlacementSeed} [initial] */
    constructor(placementState, compId, before, after, initial) {
        this.placementState = placementState;
        this.compId = compId;
        this.initial = initialPlacement(placementState, compId, initial);
        this.before = { ...before };
        this.after = { ...after };
    }
    /** @param {RefStylePatch} state */
    _apply(state) {
        /** @type {RefStylePatch} */
        const patch = {};
        if (state.refSize !== undefined) patch.refSize = state.refSize;
        if (state.refStrokeWidth !== undefined) patch.refStrokeWidth = state.refStrokeWidth;
        if (state.refRot !== undefined) patch.refRot = state.refRot;
        return applyPatch(this, patch);
    }
    lockTargets() { return [{ kind: 'reftext', object: this.compId }]; }
    execute() { this._apply(this.after); }
    undo() { this._apply(this.before); }
}
