/**
 * Turning tracks into board shapes and back: filling a closed track loop, moving a track
 * to a non-copper layer, changing its copper mode, and replacing a shape that has become a
 * plain copper path with a track, each as one undoable command.
 */
import { AddBoardShapeCommand, RemoveBoardShapeCommand } from './shape-commands.js';
import { AddTrackCommand, RemoveTrackCommand, CompoundCommand } from './track-commands.js';
import { isCopperPathShape, trackFromBoardShape } from '../../shared/pcb/copper-path-tracks.js';
import { setPcbSelection } from './selection-registry.js';
import { showPcbSelectionProperties } from './selection-interaction.js';
import { normalizeShapeCopperMode, normalizedBoardShapeLineWidth } from '../../shared/pcb/board-shape-geometry.js';
import { showBoardShapeProperties } from './board-shape-properties.js';
import { nextBoardShapeId, normalizeBoardPolylineKind, selectBoardShape } from './board-shapes.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */
/** @typedef {import('../../shapes/track.js').Track} Track */
/** @typedef {{x: number, y: number, [key: string]: any}} Point */
/** @typedef {import('../../core/pcb-board-shapes.js').BoardShape} BoardShape */

/**
 * @param {Track} track
 * @param {{allowPadConnections?: boolean}} [options]
 */
function simpleTrackLinePoints(track, { allowPadConnections = false } = {}) {
    if (!track || track.nodes.size < 2 || (track.padConnections.size && !allowPadConnections)) return null;
    const closed = track.edges.size === track.nodes.size;
    if (!closed && track.edges.size !== track.nodes.size - 1) return null;
    /** @type {Map<string, Array<{edgeId:string, nodeId:string}>>} */
    const adjacency = new Map([...track.nodes.keys()].map((nodeId) => [nodeId, []]));
    for (const [edgeId, edge] of track.edges) {
        const fromEdges = adjacency.get(edge.from);
        const toEdges = adjacency.get(edge.to);
        if (!fromEdges || !toEdges) return null;
        fromEdges.push({ edgeId, nodeId: edge.to });
        toEdges.push({ edgeId, nodeId: edge.from });
    }
    const endpoints = [...adjacency].filter(([, edges]) => edges.length === 1).map(([nodeId]) => nodeId);
    if ([...adjacency.values()].some((edges) => edges.length < 1 || edges.length > 2)) return null;
    // A closed loop has no endpoints; start where the source shape's first node was.
    if (closed ? endpoints.length || track.nodes.size < 3 : endpoints.length !== 2) return null;
    const firstNodeId = closed ? (track.nodes.has('n0') ? 'n0' : track.nodes.keys().next().value) : endpoints[0];

    /** @type {Point[]} */
    const points = [];
    /** @type {Record<number, number>} */
    const segmentWidths = {};
    /** @type {Record<number, number>} */
    const segmentBulges = {};
    /** @type {Record<number, number>} */
    const nodeCornerRadii = {};
    const visitedEdges = new Set();
    /** @type {string|null} */
    let previousNodeId = null;
    /** @type {string|undefined} */
    let nodeId = firstNodeId;
    let layer = null;
    while (nodeId) {
        const node = track.nodes.get(nodeId);
        if (!node) return null;
        if (Object.hasOwn(track.nodeCornerRadii || {}, nodeId)) nodeCornerRadii[points.length] = track.nodeCornerRadii[nodeId];
        points.push({ x: node.x, y: node.y });
        const next = (adjacency.get(nodeId) || []).find((edge) => edge.nodeId !== previousNodeId && !visitedEdges.has(edge.edgeId));
        if (!next) break;
        const edgeLayer = track.getEdgeLayer(next.edgeId);
        const edgeWidth = track.getEdgeWidth(next.edgeId);
        if (layer !== null && edgeLayer !== layer) return null;
        const index = points.length - 1;
        if (edgeWidth !== track.width) segmentWidths[index] = edgeWidth;
        const edge = track.edges.get(next.edgeId);
        if (edge.bulge) segmentBulges[index] = edge.from === nodeId ? edge.bulge : -edge.bulge;
        visitedEdges.add(next.edgeId);
        layer = edgeLayer;
        previousNodeId = nodeId;
        nodeId = next.nodeId;
        // The closing edge leads back to the first node, which is already recorded.
        if (closed && nodeId === firstNodeId) break;
    }
    return visitedEdges.size === track.edges.size && points.length === track.nodes.size
        ? { points, layer, closed, width: track.width, segmentWidths, segmentBulges,
            cornerRadius: track.cornerRadius, nodeCornerRadii }
        : null;
}

/**
 * Whether a track is a closed single-layer loop that Fill can turn into a copper area.
 * @param {Track} track
 */
export function canFillTrackLoop(track) {
    return !!simpleTrackLinePoints(track)?.closed;
}

/**
 * Fill a closed track loop: a filled area is copper a Track cannot represent, so
 * the loop becomes a filled board shape (polygon, or rectangle when axis-aligned)
 * that keeps the track's net.
 * @param {PcbEditor} app
 * @param {Track} track
 */
export function fillTrackLoop(app, track) {
    return canFillTrackLoop(track) && replaceTrackWithBoardShape(app, track, { filled: true, net: track.net || '' });
}

/**
 * Whether a track is a single-layer line or loop that can become a plain board shape.
 * @param {Track} track
 */
export function canMoveTrackToBoardLayer(track) {
    // Off copper a pad link means nothing, so it is dropped just as deleting the track would.
    return !!simpleTrackLinePoints(track, { allowPadConnections: true });
}

/**
 * Move a track off copper: it becomes an unfilled board shape on `layer`. Tracks
 * remember the shape they were made from, so a hole keeps its plating on the way back.
 * @param {PcbEditor} app
 * @param {Track} track
 * @param {string} layer
 */
export function moveTrackToBoardLayer(app, track, layer) {
    if (layer === 'top-copper' || layer === 'bottom-copper' || !canMoveTrackToBoardLayer(track)) return false;
    const plated = layer === 'hole' && !!track.sourceBoardShape?.plated;
    return replaceTrackWithBoardShape(app, track, { filled: false, net: '', layer, plated, allowPadConnections: true });
}

/**
 * Give a track a copper removal mode. Removal shapes add no copper, so the
 * track becomes an unfilled board shape on its layer without a net; 'add' is a no-op.
 * @param {PcbEditor} app
 * @param {Track} track
 * @param {string} copperMode
 */
export function setTrackCopperMode(app, track, copperMode) {
    const mode = normalizeShapeCopperMode(copperMode);
    if (mode === 'add' || !canMoveTrackToBoardLayer(track)) return false;
    return replaceTrackWithBoardShape(app, track, { filled: false, net: '', copperMode: mode, allowPadConnections: true });
}

/**
 * @param {PcbEditor} app
 * @param {Track} track
 * @param {{filled: boolean, net: string, layer?: string|null, plated?: boolean, copperMode?: string, allowPadConnections?: boolean}} options
 */
function replaceTrackWithBoardShape(app, track, { filled, net, layer = null, plated = false, copperMode = 'add', allowPadConnections = false }) {
    if (!app.tracks?.includes(track)) return false;
    const source = simpleTrackLinePoints(track, { allowPadConnections });
    if (!source) return false;
    /** @type {'line'|'polygon'} */
    const kind = source.closed ? 'polygon' : 'line';
    const targetLayer = /** @type {string} */ (layer || source.layer);
    // The remembered source id may have been reused since (a reload resets the id
    // counter, and split or pasted tracks share a source), so only keep it while free.
    const sourceId = track.sourceBoardShape?.id;
    const id = sourceId && !app.boardShapes.some(/** @param {BoardShape} shape */ (shape) => shape.id === sourceId)
        ? sourceId : nextBoardShapeId(app);
    const shape = {
        id,
        kind,
        layer: targetLayer,
        lineWidth: layer ? normalizedBoardShapeLineWidth({ kind, layer: targetLayer }, source.width) : source.width,
        filled,
        copperMode: normalizeShapeCopperMode(copperMode),
        plated,
        net,
        points: source.points,
        segmentWidths: source.segmentWidths,
        segmentBulges: source.segmentBulges,
        cornerRadius: source.cornerRadius,
        nodeCornerRadii: source.nodeCornerRadii,
    };
    // Closed loops return as a polygon, or a rectangle when still axis-aligned.
    if (source.closed) normalizeBoardPolylineKind(shape);
    app.history.execute(new CompoundCommand([
        new RemoveTrackCommand(app, track),
        new AddBoardShapeCommand(app, shape),
    ]));
    setPcbSelection(app, [{ kind: 'shape', object: shape }]);
    showBoardShapeProperties(app, shape);
    app.refreshSelectionHighlights();
    return true;
}

/**
 * Command adding a new board shape, or the equivalent Track when the shape is a
 * copper path (see isCopperPathShape).
 * @param {PcbEditor} app
 * @param {BoardShape} shape
 * @returns {{command: any, track: import('../../shapes/track.js').Track|null}}
 */
export function addBoardShapeOrTrackCommand(app, shape) {
    if (!isCopperPathShape(shape)) return { command: new AddBoardShapeCommand(app, shape), track: null };
    const track = trackFromBoardShape(shape);
    return { command: new AddTrackCommand(app, track), track };
}

/**
 * Commands replacing a board shape whose edited copy has become a copper path
 * (e.g. unfilled, opened, or moved to additive copper) with the equivalent Track.
 * @param {PcbEditor} app
 * @param {BoardShape} original
 * @param {BoardShape} edited
 * @returns {{commands: any[], track: import('../../shapes/track.js').Track}|null}
 */
export function copperPathReplacementCommands(app, original, edited) {
    if (!isCopperPathShape(edited)) return null;
    const track = trackFromBoardShape(edited);
    return { commands: [new RemoveBoardShapeCommand(app, original), new AddTrackCommand(app, track)], track };
}

/**
 * Select tracks that replaced board shapes and show their properties.
 * @param {PcbEditor} app
 * @param {Track[]} tracks
 */
export function selectReplacementTracks(app, tracks) {
    selectBoardShape(app, null);
    setPcbSelection(app, tracks.map(track => ({ kind: 'track', object: track })));
    showPcbSelectionProperties(app);
    app.refreshSelectionHighlights();
}
