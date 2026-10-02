import { placementPose } from '../shared/pcb/board-geometry.js';

const resolvedPlacementFields = ['x', 'y', 'rotation', 'mirror', 'side', 'padOffsets', 'pasteOffsets', 'silks',
    'pads', 'name', 'reference', 'outline', 'refVisible', 'refDx', 'refDy', 'refRot', 'refSize', 'refStrokeWidth'];

/** Detach full-precision physical placement data without copying presentation state. */
export function captureResolvedPlacement(placement) {
    return structuredClone(Object.fromEntries(resolvedPlacementFields.map(key => [key, placement[key]])));
}

/** Update derived world-pad positions from current footprint-local geometry. */
export function updatePlacementPadPositions(placement) {
    const pose = placementPose(placement);
    for (const offset of placement.padOffsets || []) {
        const { x, y } = pose.xf(offset.dx, offset.dy);
        placement.pads.set(offset.padId, { x, y, number: offset.number });
    }
}

/** @param {import('../shapes/track.js').Track[]} tracks */
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

const flipShortLayer = layer => layer === 'top' ? 'bottom' : layer === 'bottom' ? 'top' : layer;

/** Apply side-dependent pad/paste layers without touching presentation. */
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

/** @param {import('../shapes/track.js').Track[]} tracks */
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
