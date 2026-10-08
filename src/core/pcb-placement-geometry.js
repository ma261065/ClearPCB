import { placementPose } from '../shared/pcb/board-geometry.js';

const resolvedPlacementFields = ['x', 'y', 'rotation', 'mirror', 'side', 'padOffsets', 'pasteOffsets', 'silks',
    'pads', 'name', 'reference', 'outline', 'refVisible', 'refDx', 'refDy', 'refRot', 'refSize', 'refStrokeWidth'];

/** @typedef {{x:number, y:number, number?:string|number}} BoardPad */
/** @typedef {{padId?:string|number, number?:string|number, dx:number, dy:number, layer?:string, _baseLayer?:string}} PadOffset */
/** @typedef {{side?:string, _baseSide?:string}} PasteOffset */
/** @typedef {{x?:number, y?:number, rotation?:number, mirror?:boolean, side?:string, padOffsets?:PadOffset[], pasteOffsets?:PasteOffset[], pads:Map<any, BoardPad>, [key:string]:any}} Placement */
/** @typedef {import('../shapes/track.js').Track} Track */

/** Detach full-precision physical placement data without copying presentation state. */
/** @param {Placement} placement */
export function captureResolvedPlacement(placement) {
    return structuredClone(Object.fromEntries(resolvedPlacementFields.map(key => [key, placement[key]])));
}

/** Update derived world-pad positions from current footprint-local geometry. */
/** @param {Placement} placement */
export function updatePlacementPadPositions(placement) {
    const pose = placementPose(placement);
    for (const offset of placement.padOffsets || []) {
        const { x, y } = pose.xf(offset.dx, offset.dy);
        placement.pads.set(offset.padId, { x, y, number: offset.number });
    }
}

/** @param {Track[]} tracks @param {string} compId @param {Map<any, BoardPad>} pads */
export function repositionPadConnectedNodes(tracks, compId, pads) {
    const touched = new Set();
    for (const track of tracks) {
        if (!track.padConnections?.size) continue;
        for (const [nodeId, connection] of track.padConnections) {
            if (!connection || connection.componentId !== compId) continue;
            const pad = pads.get(connection.pinNumber)
                ?? pads.get(String(connection.pinNumber))
                ?? pads.get(Number(connection.pinNumber));
            const node = track.nodes.get(nodeId);
            if (!pad || !node || (node.x === pad.x && node.y === pad.y)) continue;
            node.x = pad.x;
            node.y = pad.y;
            touched.add(track);
        }
    }
    for (const track of touched) track.invalidate();
    return touched;
}

/** @param {string|undefined} layer */
const flipShortLayer = layer => layer === 'top' ? 'bottom' : layer === 'bottom' ? 'top' : layer;

/** Apply side-dependent pad/paste layers without touching presentation. */
/** @param {Placement} placement @param {string} side */
export function applyPlacementSide(placement, side) {
    const flip = side === 'bottom';
    placement.side = flip ? 'bottom' : 'top';
    for (const offset of placement.padOffsets || []) {
        if (offset._baseLayer === undefined) offset._baseLayer = offset.layer;
        offset.layer = flip ? flipShortLayer(offset._baseLayer) : offset._baseLayer;
    }
    for (const offset of placement.pasteOffsets || []) {
        if (offset._baseSide === undefined) offset._baseSide = offset.side;
        offset.side = flip ? flipShortLayer(offset._baseSide) : offset._baseSide;
    }
}

/** @param {Track[]} tracks @param {string} compId @param {PadOffset[]} padOffsets */
export function disconnectIncompatiblePadNodes(tracks, compId, padOffsets) {
    // Connection pinNumber stores the physical padId, including duplicate-pad suffixes.
    const layers = new Map(padOffsets.map(offset => [String(offset.padId ?? offset.number), offset.layer]));
    const touched = new Set();
    for (const track of tracks) {
        if (!track.padConnections?.size) continue;
        for (const [nodeId, connection] of [...track.padConnections]) {
            if (!connection || connection.componentId !== compId) continue;
            const short = layers.get(String(connection.pinNumber));
            if (short === 'both') continue;
            const copper = short === 'bottom' ? 'bottom-copper' : 'top-copper';
            const incident = track.incidentEdges(nodeId);
            const compatible = incident.length
                ? incident.some(edge => track.getEdgeLayer(edge.edgeId) === copper)
                : track.layer === copper;
            if (!compatible) {
                track.padConnections.delete(nodeId);
                track.invalidate();
                touched.add(track);
            }
        }
    }
    return touched;
}
