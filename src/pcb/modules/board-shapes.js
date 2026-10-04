/**
 * Free-standing PCB board shapes: line, rectangle, polygon, arc and circle.
 *
 * Shapes are plain
 * objects stored in `app.boardShapes`; geometry-specific bits (path, outline,
 * hit-test) dispatch on `shape.kind`. This module owns their rendering,
 * selection adapter, interaction (drag, draw, topology edits) and Track
 * conversion; the Properties panel lives in board-shape-properties.js.
 *
 * Shape object shape:
 *   common: { id, kind:'line'|'rect'|'polygon'|'arc'|'circle', layer, lineWidth, filled, copperMode, plated }
 *   line:   + { points: [{x,y}, {x,y}] }   (open)
 *   rect:   + { cornerRadius }
 *   rect/polygon: + { points: [{x,y}, ...] }   (closed)
 *   arc:          + { start:{x,y}, end:{x,y}, bulge:{x,y} }
 *   circle:       + { x, y, radius }
 */

import { bulgeRatio, distanceToSegment } from '../../core/geometry.js';
import { formatNumberInputValue } from '../../core/number-inputs.js';
import { projectArcBulge, snapArcBulgeToChord, arcBulgeRatio, arcBulgeFromRatio } from '../../shapes/arc-edit.js';
import { pathHandleDescriptors, pathSegmentAt } from '../../shapes/path-geometry.js';
import { joinPaths, remapPathNodes, splitPathSegmentMetadata, deletePathVertex, collapseCollinearPath, deletePathSegment, closePathIfCoincident, resizeRectanglePoints, pointsFormAxisAlignedRect, setPathSegmentType, splitPathAtNode } from '../../shapes/path-operations.js';
import { validBoardOutline } from '../../shared/pcb/board-outline.js';
import { shapeFromPoints, shapePreviewPath, advanceShapeDrawing, canFinishShapeAtPoint } from '../../shapes/shape-drawing.js';
import { CopperFill } from '../../shapes/copper-fill.js';
import { SHAPE_KINDS, loadBoardShapeData, cloneShapeGeometry, applyShapeGeometry,
    applyShapeSnapshot, captureBoardShapeState as shapeSnapshot } from '../../core/pcb-board-shapes.js';
import { getBoardShapeNodeFocus, getBoardShapeSegmentFocus, getHoveredBoardShape, getNetHoveredShapeIds, getShapeDefaults, setBoardShapeNodeFocus, setBoardShapeSegmentFocus, setHoveredBoardShape, setNetHoveredShapeIds } from './board-shape-state.js';
export { serializeBoardShapes, cloneShapeGeometry, applyShapeGeometry,
    applyShapeSnapshot, captureBoardShapeState } from '../../core/pcb-board-shapes.js';
import {
    isLayerLocked,
    isLayerVisible,
    pcbHighlightColor,
    PCB_HOVER_HIGHLIGHT_OPACITY,
    PCB_LAYERS,
    PCB_SELECTION_HIGHLIGHT_OPACITY,
    unlockPcbLayer,
} from './layers.js';
import {
    AddBoardShapeCommand,
    RemoveBoardShapeCommand,
    MoveBoardShapeCommand,
    ModifyBoardShapeCommand,
} from './shape-commands.js';
import { AddTrackCommand, RemoveTrackCommand, CompoundCommand } from './track-commands.js';
import { isCopperPathShape, trackFromBoardShape } from '../../shared/pcb/copper-path-tracks.js';
import { clearAxisGlow, renderAxisGlow, pathAlignmentSegments, squareAlignmentSegments } from '../../shapes/axis-glow.js';
import { pathContinuationConstraints, pathSegmentConstraints } from '../../shapes/path-snap.js';
import { redrawPropertyPreview, createPropertyBinding } from '../../shapes/property-preview.js';
import {
    boundsWithPathNodes,
    getPcbSelection,
    getPcbSelectionEntries,
    hitTestPcbSelection,
    isPcbSelected,
    registerPcbSelectionAdapter,
    setPcbSelection,
    syncPcbSelection,
} from './selection-registry.js';
import { clearPcbSelectionAnchors, lockPositionOutsideOutline, renderPcbSelectionAnchors } from './selection-anchors.js';
import { appendSegmentSelection, insideStrokeGroup } from '../../core/ui-helpers.js';
import { beginPcbAnchorInteraction, finishSelectionInteraction, showPcbSelectionProperties } from './selection-interaction.js';
import { pathMoveInteraction, beginPathSplit, snapPathPoint, snapPathTranslation, pathContextActions, showPathContextMenu, dismissPathContextMenu } from './path-edit.js';
import {
    canDrawPictureCircles,
    resizePicturePoints,
} from '../../shared/pcb/picture-raster.js';
import { cancelPictureCopperRefresh, schedulePictureCopperRefresh } from './picture-refresh.js';
import { rotationHandleAnchor, pointerRotation, rotatedImagePoints } from './rotation-handle.js';
import { BULGE_EPS, arcFromBulge } from '../../shapes/arc-edge.js';
import { syncBoardOutlineDimensions } from '../../shared/pcb/board-outline.js';
import { getPropertyEditor, releasePropertyEditor, setPropertyEditor } from './property-editors.js';
import { areDragOverlaysDeferred, isPictureCopperRefreshPending, setDragOverlaysDeferred } from './refresh-state.js';

import {
    normalizeShapeCopperMode,
    isMaskLayer,
    rectCornerRadius,
    polygonCornerRadius,
    circleOutline,
    circleFilledRadius,
    boardShapeSegmentBulge,
    shapeOutline,
    boardShapeStrokeSegments,
    boardShapeRemovalPathD,
    boardShapeFillPathD,
    boardShapeBounds,
    boardShapeHitTest,
    shapePathD,
    shapeIsFilled,
    normalizedBoardShapeLineWidth,
    boardShapeSegmentWidth,
    resolveBoardShapeGeometry,
} from '../../shared/pcb/board-shape-geometry.js';
import { PROP_HIDDEN_LAYERS, showBoardShapeProperties, showBoardShapeToolProperties, syncCircleDiameterProperty, syncShapeBulgeProperty } from './board-shape-properties.js';
import { isEditorActive } from './pcb-editor-api.js';
import { forgetBoardShapeClearance, getBoardShapeClearance } from './clearance-overlay.js';
import { hasCopperCuts } from './copper-cuts.js';

const NS = 'http://www.w3.org/2000/svg';
const HOLE_BORDER_WIDTH = 0.05;
const REMOVAL_OUTLINE_WIDTH_PX = 1;
const boardShapeRotationPreviews = new WeakMap();
const boardShapePropertyPreviews = new WeakMap();

export function getBoardShapePropertyPreview(app) {
    return boardShapePropertyPreviews.get(app);
}

export function getBoardShapeRotationPreview(app) {
    return boardShapeRotationPreviews.get(app);
}

export function canonicalBoardShape(app, shape) {
    shape = boardShapePropertyPreviews.get(app)?.originalsByCopy.get(shape) || shape;
    if (app._shapeDrag?.shape === shape) return app._shapeDrag.original;
    const preview = boardShapeRotationPreviews.get(app);
    return preview && preview.shape === shape ? preview.original : shape;
}

export function displayedBoardShape(app, shape) {
    shape = boardShapePropertyPreviews.get(app)?.copiesByOriginal.get(shape) || shape;
    const drag = app._shapeDrag;
    if (drag && (drag.original === shape || drag.shape === shape)) return drag.shape;
    const preview = boardShapeRotationPreviews.get(app);
    return preview && (preview.original === shape || preview.shape === shape) ? preview.shape : shape;
}

export function getBoardShapePointerPreview(app) {
    return app._shapeDrag?.preview;
}

export function copyBoardShape(shape) {
    const copy = { ...shape };
    applyShapeGeometry(copy, cloneShapeGeometry(shape));
    for (const key of ['nodeCornerRadii', 'segmentWidths', 'segmentBulges']) {
        if (shape[key]) copy[key] = { ...shape[key] };
    }
    return copy;
}

function beginBoardShapePointerPreview(app, drag) {
    if (!drag.preview) {
        const originals = app.pcbDocument?.boardShapes || app.boardShapes;
        if (!originals.includes(drag.original)) {
            endBoardShapeDrag(app, false);
            throw new Error('Cannot edit a missing board shape.');
        }
        drag.shape = copyBoardShape(drag.original);
        drag.preview = { boardShapes: originals.map(shape => shape === drag.original ? drag.shape : shape) };
    }
    return drag.shape;
}

/** Release displayed geometry before handing the canonical image to history. */
export function finishBoardShapeRotationPreview(app, commit = false) {
    const preview = boardShapeRotationPreviews.get(app);
    if (!preview) return false;
    boardShapeRotationPreviews.delete(app);
    app._rotationHandleDrag = false;
    const { original, shape, before } = preview;
    const present = app.pcbDocument.boardShapes.includes(original);
    let committed = false;
    try {
        if (commit && !present) throw new Error('Cannot rotate a missing board shape.');
        if (commit && isLayerVisible(original.layer) && !isLayerLocked(original.layer) && shape !== original) {
            const after = shapeSnapshot(shape);
            if (JSON.stringify(before) !== JSON.stringify(after)) {
                schedulePictureCopperRefresh(app, original);
                app.history.execute(new ModifyBoardShapeCommand(app, original, before, after));
                committed = true;
            }
        }
    } finally {
        if (!present) {
            removeBoardShapeElement(app, original.id);
            if (shape !== original) cancelPictureCopperRefresh(app);
        } else if (shape !== original && !committed) {
            schedulePictureCopperRefresh(app, original);
            renderBoardShape(app, original, { liveDrag: true });
            cancelPictureCopperRefresh(app);
            showBoardShapeProperties(app, original);
        }
        if (!present || shape !== original) renderPcbSelectionAnchors(app);
        const input = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropImageRot'));
        if (input && present) {
            const points = original.points;
            const rotation = ((-Math.atan2(points[1].y - points[0].y,
                points[1].x - points[0].x) * 180 / Math.PI) % 360 + 360) % 360;
            input.value = String(Math.round(rotation) % 360);
        }
    }
    return committed;
}

/** Round to 4 dp for compact, stable path/serialisation output. */
const r4 = (n) => Math.round(n * 10000) / 10000;

/** Human-friendly title for the Properties panel. */
export function shapeKindLabel(kind) {
    return kind === 'image' ? 'Image' : kind === 'line' ? 'Line'
        : kind === 'rect' ? 'Rectangle'
        : kind === 'polygon' ? 'Polygon'
            : kind === 'arc' ? 'Arc'
                : kind === 'circle' ? 'Circle'
                : 'Shape';
}

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

    const points = [];
    const segmentWidths = {};
    const segmentBulges = {};
    const nodeCornerRadii = {};
    const visitedEdges = new Set();
    let previousNodeId = null;
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

/** Whether a track is a closed single-layer loop that Fill can turn into a copper area. */
export function canFillTrackLoop(track) {
    return !!simpleTrackLinePoints(track)?.closed;
}

/**
 * Fill a closed track loop: a filled area is copper a Track cannot represent, so
 * the loop becomes a filled board shape (polygon, or rectangle when axis-aligned)
 * that keeps the track's net.
 */
export function fillTrackLoop(app, track) {
    return canFillTrackLoop(track) && replaceTrackWithBoardShape(app, track, { filled: true, net: track.net || '' });
}

/** Whether a track is a single-layer line or loop that can become a plain board shape. */
export function canMoveTrackToBoardLayer(track) {
    // Off copper a pad link means nothing, so it is dropped just as deleting the track would.
    return !!simpleTrackLinePoints(track, { allowPadConnections: true });
}

/**
 * Move a track off copper: it becomes an unfilled board shape on `layer`. Tracks
 * remember the shape they were made from, so a hole keeps its plating on the way back.
 */
export function moveTrackToBoardLayer(app, track, layer) {
    if (layer === 'top-copper' || layer === 'bottom-copper' || !canMoveTrackToBoardLayer(track)) return false;
    const plated = layer === 'hole' && !!track.sourceBoardShape?.plated;
    return replaceTrackWithBoardShape(app, track, { filled: false, net: '', layer, plated, allowPadConnections: true });
}

/**
 * Give a track a copper removal mode. Removal shapes add no copper, so the
 * track becomes an unfilled board shape on its layer without a net; 'add' is a no-op.
 */
export function setTrackCopperMode(app, track, copperMode) {
    const mode = normalizeShapeCopperMode(copperMode);
    if (mode === 'add' || !canMoveTrackToBoardLayer(track)) return false;
    return replaceTrackWithBoardShape(app, track, { filled: false, net: '', copperMode: mode, allowPadConnections: true });
}

function replaceTrackWithBoardShape(app, track, { filled, net, layer = null, plated = false, copperMode = 'add', allowPadConnections = false }) {
    if (!app.tracks?.includes(track)) return false;
    const source = simpleTrackLinePoints(track, { allowPadConnections });
    if (!source) return false;
    const kind = source.closed ? 'polygon' : 'line';
    const targetLayer = layer || source.layer;
    // The remembered source id may have been reused since (a reload resets the id
    // counter, and split or pasted tracks share a source), so only keep it while free.
    const sourceId = track.sourceBoardShape?.id;
    const id = sourceId && !app.boardShapes.some((shape) => shape.id === sourceId)
        ? sourceId : `pshape_${app._shapeIdCounter++}`;
    const shape = {
        id,
        kind,
        layer: targetLayer,
        lineWidth: layer ? normalizedBoardShapeLineWidth({ kind, layer: targetLayer }, source.width) : source.width,
        filled,
        copperMode,
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
    app._refreshPcbSelectionHighlights?.();
    return true;
}

/**
 * Command adding a new board shape, or the equivalent Track when the shape is a
 * copper path (see isCopperPathShape).
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
 * @returns {{commands: any[], track: import('../../shapes/track.js').Track}|null}
 */
export function copperPathReplacementCommands(app, original, edited) {
    if (!isCopperPathShape(edited)) return null;
    const track = trackFromBoardShape(edited);
    return { commands: [new RemoveBoardShapeCommand(app, original), new AddTrackCommand(app, track)], track };
}

/** Select tracks that replaced board shapes and show their properties. */
export function selectReplacementTracks(app, tracks) {
    selectBoardShape(app, null);
    setPcbSelection(app, tracks.map(track => ({ kind: 'track', object: track })));
    showPcbSelectionProperties(app);
    app._refreshPcbSelectionHighlights?.();
}

// ── Geometry ────────────────────────────────────────────────────────────────

/** Keep PCB kinds in lockstep with the schematic Polyline topology. */
export function normalizeBoardPolylineKind(shape) {
    if (!shape || !['line', 'polygon', 'rect'].includes(shape.kind)) return false;
    const points = shape.points || [];
    const before = shape.kind;
    if (shape.kind === 'line') {
        shape.filled = false;
    } else if (points.length <= 2) {
        shape.kind = 'line';
        shape.filled = false;
        shape.cornerRadius = undefined;
    } else if (pointsFormAxisAlignedRect(points) && !Object.values(shape.segmentBulges || {}).some(value => Math.abs(value) >= BULGE_EPS)) {
        shape.kind = 'rect';
        shape.cornerRadius = Math.max(0, Number(shape.cornerRadius) || 0);
    } else {
        shape.kind = 'polygon';
        shape.cornerRadius = Math.max(0, Number(shape.cornerRadius) || 0);
    }
    return shape.kind !== before;
}

/** Close an open Line when its two endpoints are intentionally coincident. */
function closeBoardLineIfCoincident(shape, handle) {
    if (!closePathIfCoincident(shape, handle)) return false;
    normalizeBoardPolylineKind(shape);
    return true;
}

/** Find a compatible open-Line endpoint to merge with the dragged endpoint. */
function findBoardLineJoinTarget(app, shape, handle, worldPos) {
    if (shape.kind !== 'line' || (handle !== 0 && handle !== shape.points.length - 1)) return null;
    const tolerance = 8 / Math.max(0.01, app.viewport?.scale || 1);
    let best = null;
    for (const candidate of app.boardShapes || []) {
        if (candidate.id === shape.id || candidate.kind !== 'line'
            || candidate.layer !== shape.layer
            || normalizeShapeCopperMode(candidate.copperMode) !== normalizeShapeCopperMode(shape.copperMode)) continue;
        for (const endpoint of [0, candidate.points.length - 1]) {
            const point = candidate.points[endpoint];
            const distance = Math.hypot(point.x - worldPos.x, point.y - worldPos.y);
            if (distance <= tolerance && (!best || distance < best.distance)) {
                best = { shape: candidate, endpoint, point: { x: point.x, y: point.y }, distance };
            }
        }
    }
    return best;
}

/** Combine two open Lines whose selected endpoints have been snapped together. */
function mergeBoardLines(app, first, firstEndpoint, second, secondEndpoint) {
    return {
        ...joinPaths(first, firstEndpoint, second, secondEndpoint),
        id: `pshape_${app._shapeIdCounter++}`,
        net: '',
    };
}

export function setBoardShapeNodeCornerRadius(shape, index, radius) {
    if (!['line', 'rect', 'polygon'].includes(shape?.kind) || !shape.points?.[index]) return;
    const fallback = shape.kind === 'rect' ? rectCornerRadius(shape) : polygonCornerRadius(shape);
    const value = Math.max(0, Number(radius) || 0);
    shape.nodeCornerRadii ||= {};
    if (Math.abs(value - fallback) < 1e-9) delete shape.nodeCornerRadii[index];
    else shape.nodeCornerRadii[index] = value;
}

export function editableShapeBulge(shape, segment = null) {
    return shape.kind === 'arc'
        ? Math.max(-1, Math.min(1, bulgeRatio(shape.start, shape.end, shape.bulge)))
        : segment == null ? 0 : boardShapeSegmentBulge(shape, segment);
}

export function normalizeStraightArc(shape, segment = null) {
    if (Math.abs(editableShapeBulge(shape, segment)) >= BULGE_EPS) return;
    if (shape.kind === 'arc') {
        const points = [shape.start, shape.end];
        shape.kind = 'line';
        shape.filled = false;
        applyShapeGeometry(shape, { points });
    } else if (segment != null && shape.segmentBulges) {
        delete shape.segmentBulges[segment];
    }
}

// ── Geometry clone / translate (shared by drag + commands) ───────────────────

function geomAnchor(geom) {
    return geom.points ? geom.points[0] : geom.start || { x: geom.x, y: geom.y };
}

/** Translate a geometry snapshot without changing its dimensions or curvature. */
export function translateShapeGeometry(geom, dx, dy) {
    if (geom.points) {
        return { points: geom.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
    }
    if ('radius' in geom) return { x: geom.x + dx, y: geom.y + dy, radius: geom.radius };
    return {
        start: { x: geom.start.x + dx, y: geom.start.y + dy },
        end: { x: geom.end.x + dx, y: geom.end.y + dy },
        bulge: { x: geom.bulge.x + dx, y: geom.bulge.y + dy },
    };
}

// ── Style ────────────────────────────────────────────────────────────────────

const CUT_RING = '#8a929b';
const REMOVAL_COLORS = {
    'remove-copper': '#5f6770',
    'remove-solder-mask': '#8a6923',
    'remove-copper-mask': '#7c3b4c',
};
// Holes use a muted teal feedback base so they read distinctly from copper,
// but hover/selection lighten it in the same direction as every other layer.
const HOLE_FEEDBACK_BASE = '#2f7d72';

/** Base display color for the shape's PCB layer. */
export function shapeLayerColor(shape) {
    return PCB_LAYERS.find((layer) => layer.id === shape?.layer)?.color || '#ffffff';
}

/** Selection is a lighter version of the owning layer, not a fixed side color. */
export function shapeSelectionColor(shape) {
    const base = shape?.layer === 'hole' ? HOLE_FEEDBACK_BASE : shapeLayerColor(shape);
    return pcbHighlightColor(base, PCB_SELECTION_HIGHLIGHT_OPACITY);
}

/** Match the effective colour of the track hover's translucent white overlay. */
export function shapeHoverColor(shape) {
    const base = shape?.layer === 'hole' ? HOLE_FEEDBACK_BASE : shapeLayerColor(shape);
    return pcbHighlightColor(base, PCB_HOVER_HIGHLIGHT_OPACITY);
}

function shapeStyle(shape) {
    const layer = String(shape.layer || 'top-silk');
    const isHoleLayer = layer === 'hole';
    const isCopperLayer = layer === 'top-copper' || layer === 'bottom-copper';
    const isMaskLayer = layer === 'top-mask' || layer === 'bottom-mask';
    const copperMode = normalizeShapeCopperMode(shape.copperMode);
    const isCopperAdd = isCopperLayer && copperMode === 'add';
    const isCopperRemoveOnly = isCopperLayer && copperMode === 'remove-copper';
    const isCopperRemoveSolderMask = isCopperLayer && copperMode === 'remove-solder-mask';
    const isCopperRemoveMask = isCopperLayer && copperMode === 'remove-copper-mask';
    const isCopperRemoval = isCopperRemoveOnly || isCopperRemoveSolderMask || isCopperRemoveMask;
    const isCopperKnockout = isCopperRemoveOnly || isCopperRemoveMask;
    const layerColor = shapeLayerColor(shape);
    const copperColor = layerColor;
    const filled = isHoleLayer || shapeIsFilled(shape);
    const fillColor = isHoleLayer ? 'var(--bg-canvas, #000000)' : layerColor;
    const fillOpacity = '1';
    const baseStroke = isCopperRemoval ? (REMOVAL_COLORS[copperMode] || CUT_RING) : layerColor;
    const strokeWidth = isCopperRemoval
        ? REMOVAL_OUTLINE_WIDTH_PX
        : isHoleLayer
            ? HOLE_BORDER_WIDTH
            : Math.max(0.05, Number(shape.lineWidth) || 0.2);
    const targetLayer = isCopperKnockout
        ? (layer === 'bottom-copper' ? 'bottom-copper-knockout' : 'top-copper-knockout')
        : layer;
    return { filled, fillColor, fillOpacity, baseStroke, strokeWidth, isHoleLayer, isCopperRemoval, isCopperKnockout, targetLayer };
}

// ── Render ───────────────────────────────────────────────────────────────────

function redrawBoardShapePropertyPreview(app, targets, { liveDrag = false } = {}) {
    redrawPropertyPreview(targets, {
        prepare: target => {
            if (target.kind !== 'image' || target.layer.endsWith('copper')) schedulePictureCopperRefresh(app, target);
        },
        render: changed => {
            for (const target of changed) renderBoardShape(app, target, {
                liveDrag, skipCopperUpdate: target.kind === 'image' && !target.layer.endsWith('copper'),
            });
        },
        refreshSelection: () => {
            renderBoardShapeSegmentSelection(app);
            if (app._refreshPcbSelectionHighlights) app._refreshPcbSelectionHighlights();
            else renderPcbSelectionAnchors(app);
        },
        refreshDerived() {},
    });
}

export function createBoardShapePropertyBinding(app) {
    getPropertyEditor(app, 'boardShape')?.dispose();
    const binding = createPropertyBinding({
        beforeActivate() {
            if (app._shapeDrag) endBoardShapeDrag(app, true);
            if (getBoardShapeRotationPreview(app)) finishBoardShapeRotationPreview(app, true);
        },
        onDispose() {
            releasePropertyEditor(app, 'boardShape', binding);
        },
    });
    binding.affectsLayer = layer =>
        boardShapePropertyPreviews.get(app)?.originals.some(shape => shape.layer === layer) || false;
    setPropertyEditor(app, 'boardShape', binding);
    return binding;
}

/**
 * @param {any} app
 * @param {any[]} targets
 * @param {{liveDrag?: boolean, beforeCommit?: (copies: any[]) => boolean|void}} [options]
 */
export function createBoardShapePropertyPreview(app, targets, { liveDrag = false, beforeCommit = () => false } = {}) {
    const binding = getPropertyEditor(app, 'boardShape');
    const originals = targets.map(target => canonicalBoardShape(app, target));
    const collection = () => app.pcbDocument?.boardShapes || app.boardShapes;
    const editable = () => !binding.disposed && isEditorActive(app)
        && originals.every(shape => isLayerVisible(shape.layer) && !isLayerLocked(shape.layer));
    let state = null;
    const finish = (commit, { rebuild = true } = {}) => {
        if (!state) return false;
        const preview = state;
        state = null;
        binding.release(control);
        boardShapePropertyPreviews.delete(app);
        setDragOverlaysDeferred(app, preview.previousDeferDragOverlays);
        let committed = false;
        try {
            if (commit && originals.some(shape => !collection().includes(shape))) {
                throw new Error('Cannot edit properties of a missing board shape.');
            }
            const canCommit = commit && editable();
            if (canCommit) rebuild = beforeCommit(preview.copies) || rebuild;
            if (canCommit && preview.copies.every(shape => shape.layer !== 'board-outline' || validBoardOutline(shape))) {
                const after = preview.copies.map(shapeSnapshot);
                const commands = originals.flatMap((target, index) => JSON.stringify(preview.before[index]) === JSON.stringify(after[index])
                    ? [] : [new ModifyBoardShapeCommand(app, target, preview.before[index], after[index])]);
                if (commands.length) {
                    if (originals.some((shape, index) => getBoardShapeSegmentFocus(app)?.shapeId === shape.id
                        && shape.points?.length !== preview.copies[index].points?.length)) {
                        setBoardShapeSegmentFocus(app, null);
                    }
                    binding.committing = true;
                    try {
                        app.history.execute(commands.length === 1 ? commands[0] : new CompoundCommand(commands));
                        committed = true;
                    } finally { binding.committing = false; }
                }
            }
        } finally {
            if (!committed) {
                for (const original of originals) {
                    if (collection().includes(original)) {
                        if (app._pendingShapeClearances?.has(original.id)) schedulePictureCopperRefresh(app, original);
                        renderBoardShape(app, original, {
                            liveDrag: true, skipCopperUpdate: original.kind === 'image' && !original.layer.endsWith('copper'),
                        });
                    } else removeBoardShapeElement(app, original.id);
                }
                if (originals.some(shape => shape.kind !== 'image' || shape.layer.endsWith('copper'))) {
                    cancelPictureCopperRefresh(app);
                    if (preview.previousPictureRefreshPending) schedulePictureCopperRefresh(app);
                }
                syncPcbSelection(app);
                renderBoardShapeSegmentSelection(app);
                renderPcbSelectionAnchors(app);
            }
        }
        if (committed && rebuild) showBoardShapeProperties(app, originals[0]);
        return committed;
    };
    const control = {
        get active() { return !!state; },
        update(mutate) {
            if (!editable()) { control.cancel(); return; }
            if (!state) {
                if (!binding.activate(control)) return;
                if (originals.some(shape => !collection().includes(shape))) {
                    binding.release(control);
                    binding.dispose();
                    for (const original of originals) {
                        if (!collection().includes(original)) removeBoardShapeElement(app, original.id);
                    }
                    syncPcbSelection(app);
                    renderPcbSelectionAnchors(app);
                    throw new Error('Cannot edit properties of a missing board shape.');
                }
                const copies = originals.map(copyBoardShape);
                const copiesByOriginal = new Map(originals.map((original, index) => [original, copies[index]]));
                state = {
                    originals, copies, copiesByOriginal,
                    originalsByCopy: new Map(copies.map((copy, index) => [copy, originals[index]])),
                    before: originals.map(shapeSnapshot),
                    previousDeferDragOverlays: areDragOverlaysDeferred(app),
                    previousPictureRefreshPending: !!isPictureCopperRefreshPending(app),
                    boardShapes: collection().map(shape => copiesByOriginal.get(shape) || shape),
                };
                boardShapePropertyPreviews.set(app, state);
                setDragOverlaysDeferred(app, true);
            }
            try {
                mutate(state.before, state.copies);
                redrawBoardShapePropertyPreview(app, state.copies, { liveDrag });
            } catch (error) {
                control.cancel();
                throw error;
            }
        },
        commit(options) { return finish(true, options); },
        cancel() {
            if (!state) return false;
            finish(false);
            return true;
        },
    };
    return control;
}

export function renderBoardShape(app, shape, opts = {}) {
    if (!opts.interactionOnly) app.refreshSelectedDRCMarker?.();
    shape = displayedBoardShape(app, shape);
    removeBoardShapeElement(app, shape.id, { skipHatchUpdate: true, preserveInteraction: true });
    const selectedSegment = getBoardShapeSegmentFocus(app)?.shapeId === shape.id
        && isPcbSelected(app, 'shape', shape)
        ? getBoardShapeSegmentFocus(app).segment
        : null;
    const supportsSegmentRendering = !shapeAffectsCopperCuts(shape)
        && shape.kind === 'line';
    const renderAsSegments = supportsSegmentRendering
        && ((!shapeIsFilled(shape) && Object.keys(shape.segmentWidths || {}).length > 0)
            || selectedSegment != null);
    const el = document.createElementNS(NS, renderAsSegments ? 'g' : 'path');
    const isSelected = isPcbSelected(app, 'shape', shape)
        && getBoardShapeSegmentFocus(app)?.shapeId !== shape.id
        && getBoardShapeNodeFocus(app)?.shapeId !== shape.id;
    const isHovered = (!!(getHoveredBoardShape(app) && getHoveredBoardShape(app).id === shape.id)
        || getNetHoveredShapeIds(app)?.has(shape.id))
        && getBoardShapeSegmentFocus(app)?.shapeId !== shape.id
        && getBoardShapeNodeFocus(app)?.shapeId !== shape.id;
    const st = shapeStyle(shape);
    if (!renderAsSegments) {
        el.setAttribute('d', st.isCopperRemoval || st.isHoleLayer
            ? boardShapeRemovalPathD(shape)
            : shapePathD(shape, { close: st.filled }));
    }
    if (st.isCopperRemoval || st.isHoleLayer) el.setAttribute('fill-rule', 'evenodd');
    el.setAttribute('fill', st.filled
        ? (st.isCopperRemoval
            ? 'none'
            : isSelected
                ? shapeSelectionColor(shape)
                : isHovered ? shapeHoverColor(shape) : st.fillColor)
        : 'none');
    if (st.filled) el.setAttribute('fill-opacity', st.isCopperRemoval ? '1' : st.fillOpacity);
    el.setAttribute('stroke', isSelected ? shapeSelectionColor(shape) : isHovered ? shapeHoverColor(shape) : st.baseStroke);
    el.setAttribute('stroke-width', String(st.strokeWidth));
    if (st.isCopperRemoval) el.setAttribute('vector-effect', 'non-scaling-stroke');
    el.setAttribute('stroke-linejoin', 'round');
    el.setAttribute('stroke-linecap', 'round');
    if (shape.layer !== 'board-outline' && ['rect', 'polygon', 'circle', 'image'].includes(shape.kind) && !renderAsSegments && !st.isCopperRemoval && !st.isHoleLayer) {
        el.setAttribute('d', boardShapeFillPathD(shape));
        el.setAttribute('fill-rule', 'evenodd');
        if (!st.filled) el.setAttribute('fill', el.getAttribute('stroke'));
        el.setAttribute('stroke', 'none');
    }
    if (st.isCopperKnockout && !isSelected && !st.filled) el.setAttribute('stroke-dasharray', '0.6 0.45');
    if (shape.kind === 'image' && canDrawPictureCircles(shape.artwork)) el.setAttribute('fill-rule', 'nonzero');
    if (shape.layer === 'board-outline') el.setAttribute('class', 'pcb-board-outline');
    if (renderAsSegments) {
        if (st.filled) {
            const fillEl = document.createElementNS(NS, 'path');
            fillEl.setAttribute('d', shapePathD(shape, { close: true }));
            fillEl.setAttribute('stroke', 'none');
            el.appendChild(fillEl);
        }
        for (const segment of boardShapeStrokeSegments(shape)) {
            const { start, end, logicalSegment } = segment;
            const segmentEl = document.createElementNS(NS, 'path');
            segmentEl.setAttribute('d', `M ${r4(start.x)} ${r4(start.y)} L ${r4(end.x)} ${r4(end.y)}`);
            segmentEl.setAttribute('fill', 'none');
            segmentEl.setAttribute('stroke', logicalSegment === selectedSegment
                ? shapeSelectionColor(shape)
                : el.getAttribute('stroke') || st.baseStroke);
            segmentEl.setAttribute('stroke-width', String(segment.lineWidth));
            segmentEl.setAttribute('stroke-linejoin', 'round');
            segmentEl.setAttribute('stroke-linecap', 'round');
            if (logicalSegment != null) segmentEl.setAttribute('data-segment', String(logicalSegment));
            el.appendChild(segmentEl);
        }
    }
    const root = st.isHoleLayer ? insideStrokeGroup(el) : el;
    root.setAttribute('data-board-shape-layer', shape.layer || '');
    app.getLayerGroup(st.targetLayer)?.appendChild(root);
    app._shapeElements.set(shape.id, root);
    if (!opts.interactionOnly) app._refreshBoardShapeClearance?.(shape);
    if (!opts.interactionOnly && (!opts.liveDrag || st.isCopperRemoval)) app._scheduleRemovalHatchRender?.();
    if (isPictureCopperRefreshPending(app)) {
        if (!opts.skipCopperUpdate && (shapeAffectsCopperCuts(shape) || (!opts.liveDrag && hasCopperCuts(app)))) app._deferredShapeCopperCuts = true;
        return;
    }
    // Rebuilding the copper-cut clip-path re-rasterises the whole copper/fill
    // layer (every track + pour), so during a live drag skip it unless THIS
    // shape is itself a copper cut. Outside a drag, also run it when cuts
    // already exist so a layer/mode change can clear a stale cut.
    if (!opts.skipCopperUpdate) {
        const affectsCuts = shapeAffectsCopperCuts(shape);
        if (opts.liveDrag) {
            if (affectsCuts) app.updateCopperCuts?.();
        } else if (affectsCuts || hasCopperCuts(app)) {
            app.updateCopperCuts?.();
        }
    }
}

/**
 * Does this shape participate in copper-cut geometry? (Hole-layer shapes are
 * board cutouts that drill both sides; copper-removal shapes cut their own
 * layer.) Mirrors the filter in `boardShapeCopperCuts`.
 */
export function shapeAffectsCopperCuts(shape) {
    if (!shape) return false;
    if (shape.layer === 'hole') return true;
    if (shape.layer === 'top-copper' || shape.layer === 'bottom-copper') {
        const m = normalizeShapeCopperMode(shape.copperMode);
        return m === 'remove-copper' || m === 'remove-copper-mask';
    }
    return false;
}

export function removeBoardShapeElement(app, id, opts = {}) {
    const el = app._shapeElements.get(id);
    if (el?.parentNode) el.parentNode.removeChild(el);
    app._shapeElements.delete(id);
    if (!opts.preserveInteraction) {
        if (getHoveredBoardShape(app)?.id === id) setHoveredBoardShape(app, null);
        const clearance = getBoardShapeClearance(app, id);
        for (const element of clearance?.elements || []) {
            element.parentNode?.removeChild(element);
        }
        forgetBoardShapeClearance(app, id);
    }
    if (!opts.skipHatchUpdate) app._scheduleRemovalHatchRender?.();
}

// ── Hit-test / hover / selection ─────────────────────────────────────────────

export function hitTestBoardShape(app, worldPos) {
    return worldPos ? hitTestPcbSelection(app, worldPos, 'shape') : null;
}

export function setBoardShapeHover(app, shape) {
    const prev = getHoveredBoardShape(app) || null;
    const next = canonicalBoardShape(app, shape) || null;
    if (prev === next || (prev && next && prev.id === next.id)) return;
    setHoveredBoardShape(app, next);
    if (prev) renderBoardShape(app, prev, { interactionOnly: true, skipCopperUpdate: true });
    if (next) renderBoardShape(app, next, { interactionOnly: true, skipCopperUpdate: true });
}

export function setBoardShapeNetHover(app, shapes) {
    const previous = getNetHoveredShapeIds(app) || new Set();
    const next = new Set([...shapes || []].map(shape => shape.id));
    if (previous.size === next.size && [...previous].every(id => next.has(id))) return;
    setNetHoveredShapeIds(app, next);
    const changed = new Set([...previous, ...next]);
    for (const shape of app.boardShapes || []) {
        if (changed.has(shape.id)) {
            renderBoardShape(app, shape, { interactionOnly: true, skipCopperUpdate: true });
        }
    }
}

export function selectBoardShape(app, shape) {
    shape = canonicalBoardShape(app, shape);
    const properties = boardShapePropertyPreviews.get(app);
    if (properties && !properties.originals.includes(shape)) getPropertyEditor(app, 'boardShape').dispose();
    if (app._shapeDrag && app._shapeDrag.original !== shape) endBoardShapeDrag(app, false);
    const rotation = boardShapeRotationPreviews.get(app);
    if (rotation && rotation.original !== shape) {
        if (!finishSelectionInteraction(app, false)) finishBoardShapeRotationPreview(app);
    }
    const previousShapes = getPcbSelection(app, 'shape');
    const prev = previousShapes[0] || null;
    const next = shape || null;
    if (prev === next || (prev && next && prev.id === next.id)) return;
    setBoardShapeSegmentFocus(app, null);
    setBoardShapeNodeFocus(app, null);
    if (next && !isPcbSelected(app, 'shape', next)) {
        setPcbSelection(app, [{ kind: 'shape', object: next }]);
    } else if (!next) {
        setPcbSelection(app, getPcbSelectionEntries(app).filter(entry => entry.kind !== 'shape'));
    }
    app.syncClipboardButtons?.();
    for (const previous of previousShapes) {
        if (app.boardShapes.includes(previous)) renderBoardShape(app, previous);
    }
    if (next) renderBoardShape(app, next);
    clearBoardShapeHandles(app);
    if (next) renderBoardShapeHandles(app, next);
    renderBoardShapeSegmentSelection(app);
    app.setPcbStatus?.();
}

// ── Resize handles ───────────────────────────────────────────────────────────

function shapeHandlePoints(shape) {
    if (shape.kind === 'arc') {
        return [
            { key: 'start', ...shape.start },
            { key: 'end', ...shape.end },
            { key: 'bulge', ...shape.bulge },
        ];
    }
    if (shape.kind === 'circle') {
        return [
            { key: 'center', x: shape.x, y: shape.y, cursor: 'move' },
            { key: 'radius', x: shape.x + circleFilledRadius(shape), y: shape.y, cursor: 'ew-resize' },
        ];
    }
    return boardPathHandles(shape).filter(anchor => !anchor.midpoint).map(anchor => ({ ...anchor, key: anchor.id }));
}

function boardPathHandles(shape) {
    const points = shape.points || [];
    const count = shape.kind === 'line' ? points.length - 1 : points.length;
    const edges = !['line', 'polygon', 'rect'].includes(shape.kind) ? [] : points.slice(0, count).map((start, id) => ({
        id, start, end: points[(id + 1) % points.length], bulge: boardShapeSegmentBulge(shape, id),
    }));
    return pathHandleDescriptors(points.map((point, id) => ({ id, ...point })), edges,
        id => `mid:${id}`, id => `bulge:${id}`, ['line', 'polygon'].includes(shape.kind));
}

/** Midpoint insertion handles belong to editable open and closed polylines. */
function shapeMidpointHandles(shape) {
    return boardPathHandles(shape).filter(anchor => anchor.midpoint).map(anchor => ({ ...anchor, key: anchor.id }));
}

/** Anchors exposed through the common PCB selection adapter contract. */
export function getBoardShapeAnchors(shape) {
    const vertices = shapeHandlePoints(shape).map((anchor) => ({
        ...anchor,
        id: anchor.key,
        cursor: anchor.cursor || 'nwse-resize',
        round: anchor.key === 'bulge' || String(anchor.key).startsWith('bulge:'),
        fill: anchor.key === 'bulge' || String(anchor.key).startsWith('bulge:') ? '#33dd77' : '#ffffff',
    }));
    const midpoints = shapeMidpointHandles(shape).map((anchor) => ({
        ...anchor,
        id: anchor.key,
        round: true,
        fill: '#ffffff',
        symbol: 'plus',
    }));
    return [...vertices, ...midpoints];
}

/** Move one anchor through the existing geometry and rendering path. */
export function moveBoardShapeAnchor(app, shape, anchorId, worldPos) {
    const before = cloneShapeGeometry(shape);
    const snap = app._snapToGrid(worldPos);
    applyBoardShapeVertexResize(shape, { before, handle: anchorId }, snap);
    if (shape.layer === 'board-outline') syncBoardOutlineDimensions(app);
    schedulePictureCopperRefresh(app, shape);
    renderBoardShape(app, shape, { liveDrag: true });
    syncCircleDiameterProperty(app, shape);
}

/** Full SelectionManager adapter for rectangle, polygon, and arc objects. */
export function createBoardShapeSelectionAdapter(app, shape, id) {
    shape = canonicalBoardShape(app, shape);
    const displayed = () => displayedBoardShape(app, shape);
    return {
        id,
        kind: 'shape',
        get object() { return displayed(); },
        get visible() { return isLayerVisible(shape.layer); },
        get locked() { return isLayerLocked(shape.layer); },
        unlock() { unlockPcbLayer(app, shape.layer); },
        getLockPosition(pointer, scale) {
            const shape = displayed();
            const geometry = resolveBoardShapeGeometry(shape);
            if (['rect', 'polygon'].includes(shape.kind) && geometry.physicalContours?.length) {
                return lockPositionOutsideOutline(
                    geometry.physicalContours,
                    pointer,
                    scale,
                );
            }
            const strokedCenterline = ['line', 'arc'].includes(shape.kind);
            if (strokedCenterline) {
                const segments = boardShapeStrokeSegments(shape);
                return lockPositionOutsideOutline(
                    segments.map(segment => [segment.start, segment.end]),
                    pointer,
                    scale,
                    false,
                    segments.map(segment => segment.lineWidth / 2),
                );
            }
            return lockPositionOutsideOutline(
                shapeOutline(shape),
                pointer,
                scale,
                true,
            );
        },
        getBounds() { return boardShapeBounds(displayed()); },
        getHitBounds() {
            const shape = displayed();
            const bounds = boardShapeBounds(shape);
            return ['line', 'rect', 'polygon'].includes(shape.kind) && isPcbSelected(app, 'shape', shape)
                ? boundsWithPathNodes(bounds, shape.points) : bounds;
        },
        hitTest(point, tolerance) {
            const shape = displayed();
            if (boardShapeHitTest(shape, point, tolerance)) return true;
            if (!isPcbSelected(app, 'shape', shape) || !['line', 'rect', 'polygon'].includes(shape.kind)) return false;
            const points = shape.points || [];
            const count = shape.kind === 'line' ? points.length - 1 : points.length;
            return points.slice(0, count).some((start, index) =>
                distanceToSegment(point, start, points[(index + 1) % points.length]) <= tolerance);
        },
        getEditPath() {
            const shape = displayed();
            if (getBoardShapeNodeFocus(app)?.shapeId === shape.id) return '';
            return shapePathD({ ...shape, cornerRadius: 0, nodeCornerRadii: {} });
        },
        getAnchors() {
            const shape = displayed();
            const anchors = getBoardShapeAnchors(shape).map(anchor => ({ ...anchor,
                selected: getBoardShapeNodeFocus(app)?.shapeId === shape.id
                    && getBoardShapeNodeFocus(app).index === anchor.id,
            }));
            return shape.kind === 'image'
                ? [...anchors, rotationHandleAnchor(boardShapeBounds(shape), app.viewport?.scale)] : anchors;
        },
        moveAnchor(anchorId, x, y) { moveBoardShapeAnchor(app, shape, anchorId, { x, y }); },
        beginAnchorDrag(anchorId, worldPos) {
            if (anchorId !== 'rotate' || shape.kind !== 'image') return startBoardShapeDrag(app, shape, worldPos, anchorId);
            getPropertyEditor(app, 'boardShape')?.commit();
            if (isLayerLocked(shape.layer) || !isLayerVisible(shape.layer)) return false;
            if (boardShapeRotationPreviews.has(app) || app._rotationHandleDrag || app._shapeDrag) {
                throw new Error('Finish the current shape preview before rotating an image.');
            }
            if (!app.pcbDocument.boardShapes.includes(shape)) throw new Error('Cannot rotate a missing board shape.');
            const center = { x: (shape.points[0].x + shape.points[2].x) / 2,
                y: (shape.points[0].y + shape.points[2].y) / 2 };
            const rotation = ((-Math.atan2(shape.points[1].y - shape.points[0].y,
                shape.points[1].x - shape.points[0].x) * 180 / Math.PI) % 360 + 360) % 360;
            const before = shapeSnapshot(shape);
            boardShapeRotationPreviews.set(app, {
                original: shape, shape, before, points: before.geom.points,
                center, start: { ...worldPos }, rotation, currentRotation: rotation,
            });
            app._rotationHandleDrag = true;
            return true;
        },
        updateAnchorDrag(worldPos) {
            const rotationDrag = boardShapeRotationPreviews.get(app);
            if (!rotationDrag || rotationDrag.original !== shape) return handleBoardShapeDrag(app, worldPos);
            const { center, start, rotation, points } = rotationDrag;
            const next = pointerRotation(center, start, worldPos, rotation);
            if (next === rotationDrag.currentRotation) return;
            if (!rotationDrag.boardShapes) {
                if (!app.pcbDocument.boardShapes.includes(shape)) {
                    if (!finishSelectionInteraction(app, false)) finishBoardShapeRotationPreview(app);
                    throw new Error('Cannot rotate a missing board shape.');
                }
                rotationDrag.shape = { ...shape };
                rotationDrag.boardShapes = app.pcbDocument.boardShapes.map(
                    original => original === shape ? rotationDrag.shape : original);
            }
            const displayed = rotationDrag.shape;
            displayed.points = next === rotation
                ? points.map(point => ({ ...point }))
                : rotatedImagePoints(points, center, next - rotation);
            schedulePictureCopperRefresh(app, displayed);
            renderBoardShape(app, displayed, { liveDrag: true });
            const input = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropImageRot'));
            if (input) input.value = String(Math.round(next) % 360);
            rotationDrag.currentRotation = next;
        },
        endAnchorDrag(commit, options = {}) {
            if (boardShapeRotationPreviews.get(app)?.original === shape) return finishBoardShapeRotationPreview(app, commit);
            const drag = app._shapeDrag;
            if (commit && drag && !options.moved && !options.place
                && typeof drag.sourceAnchorId === 'number'
                && ['line', 'rect', 'polygon'].includes(shape.kind)) {
                setBoardShapeSegmentFocus(app, null);
                setBoardShapeNodeFocus(app, { shapeId: shape.id, index: drag.sourceAnchorId });
                showBoardShapeProperties(app, shape);
                renderBoardShape(app, shape);
                renderBoardShapeSegmentSelection(app);
                renderBoardShapeHandles(app, shape);
                endBoardShapeDrag(app, true);
                return;
            }
            if (commit && drag && !options.moved && !options.place) {
                endBoardShapeDrag(app, true);
                return;
            }
            endBoardShapeDrag(app, commit);
        },
        ...pathMoveInteraction({
            segmentAt: point => shape.kind === 'arc' ? 0
                : polygonSegmentIndexAt(shape, point, 8 / Math.max(0.01, app.viewport?.scale || 1)),
            selectedSegment: () => getBoardShapeSegmentFocus(app)?.shapeId === shape.id ? getBoardShapeSegmentFocus(app).segment : null,
            selectSegment: segment => {
                setBoardShapeNodeFocus(app, null);
                setBoardShapeSegmentFocus(app, { shapeId: shape.id, segment });
                renderBoardShape(app, shape);
                renderBoardShapeSegmentSelection(app);
                showBoardShapeProperties(app, shape);
            },
            begin: (point, segment) => {
                setBoardShapeNodeFocus(app, null);
                return startBoardShapeDrag(app, shape, point, null, { whole: true, allowSegment: segment != null });
            },
            update: point => handleBoardShapeDrag(app, point),
            end: commit => endBoardShapeDrag(app, commit),
        }),
        anchorColor: shapeSelectionColor(shape),
        getPosition() {
            const bounds = boardShapeBounds(displayed());
            return { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
        },
        invalidate() { renderBoardShape(app, shape); },
        render() { renderBoardShape(app, shape); },
    };
}

registerPcbSelectionAdapter('shape', createBoardShapeSelectionAdapter);

/** Draw the resize handles for the selected shape on the overlay layer. */
export function renderBoardShapeHandles(app, shape) {
    shape = displayedBoardShape(app, shape);
    if (!shape || isLayerLocked(shape.layer) || !isLayerVisible(shape.layer)) return;
    const selectedNode = getBoardShapeNodeFocus(app);
    const node = selectedNode?.shapeId === shape.id ? shape.points?.[selectedNode.index] : null;
    if (shape.kind === 'line' && node) {
        for (const axis of ['x', 'y']) {
            const field = document.getElementById(`pcbPropShapeNode${axis.toUpperCase()}`);
            if (field) field.textContent = formatNumberInputValue(node[axis]);
        }
    }
    renderPcbSelectionAnchors(app);
}

/** Remove all board-shape resize handles from the overlay. */
export function clearBoardShapeHandles(app) {
    clearPcbSelectionAnchors(app);
}

/** Remove obsolete standalone segment overlays after selection changes. */
export function renderBoardShapeSegmentSelection(app) {
    const overlay = app.getLayerGroup?.('selection-overlay');
    if (!overlay) return;
    for (const element of [...overlay.querySelectorAll('.pcb-shape-segment-selection')]) element.remove();
    const selected = getBoardShapeSegmentFocus(app);
    const shape = selected && displayedBoardShape(app, app.boardShapes?.find(shape => shape.id === selected.shapeId));
    if (!shape || !isPcbSelected(app, 'shape', shape)) return;
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('class', 'pcb-shape-segment-selection');
    path.setAttribute('d', shape.kind === 'arc' ? shapePathD(shape, { close: false })
        : boardShapeStrokeSegments(shape).filter(segment => segment.logicalSegment === selected.segment)
            .map(({ start, end }) => `M ${start.x} ${start.y} L ${end.x} ${end.y}`).join(' '));
    const handles = overlay.querySelectorAll('.pcb-selection-anchors')[0];
    appendSegmentSelection(overlay, path, shapeSelectionColor(shape),
        boardShapeSegmentWidth(shape, selected.segment), handles);
}

/** Return the handle key (vertex index, or 'start'/'end'/'bulge') near worldPos, else null. */
export function hitTestBoardShapeVertex(app, shape, worldPos) {
    if (!shape || !worldPos) return null;
    const scale = app.viewport?.scale || 50;
    const tol = Math.max(0.3, 8 / scale);
    let bestKey = null;
    let bestD = tol;
    for (const h of shapeHandlePoints(shape)) {
        const d = Math.hypot(h.x - worldPos.x, h.y - worldPos.y);
        if (d <= bestD) { bestD = d; bestKey = h.key; }
    }
    return bestKey;
}

/** Apply a live vertex/anchor drag to a shape's geometry, keeping shape invariants. */
export function applyBoardShapeVertexResize(shape, drag, snap) {
    const segmentBulge = typeof drag.handle === 'string' ? /^bulge:(\d+)$/.exec(drag.handle) : null;
    if (segmentBulge && ['line', 'polygon'].includes(shape.kind)) {
        const index = Number(segmentBulge[1]);
        const start = shape.points[index];
        const end = shape.points[(index + 1) % shape.points.length];
        if (start && end) {
            shape.segmentBulges ||= {};
            shape.segmentBulges[index] = Math.max(-1, Math.min(1, bulgeRatio(start, end, snap)));
        }
        return;
    }
    if (shape.kind === 'image') {
        shape.points = resizePicturePoints(drag.before.points, drag.handle, snap);
        return;
    }
    if (shape.kind === 'arc') {
        if (drag.handle === 'start' || drag.handle === 'end') {
            const ratio = arcBulgeRatio(drag.before || shape);
            if (drag.handle === 'start') shape.start = { x: snap.x, y: snap.y };
            else shape.end = { x: snap.x, y: snap.y };
            shape.bulge = arcBulgeFromRatio(shape.start, shape.end, ratio);
        } else {
            shape.bulge = projectArcBulge(shape.start, shape.end, snap);
        }
        return;
    }
    if (shape.kind === 'circle') {
        if (drag.handle === 'center') {
            shape.x = snap.x;
            shape.y = snap.y;
        } else if (drag.handle === 'radius') {
            shape.radius = Math.max(0.05, Math.hypot(snap.x - shape.x, snap.y - shape.y));
        }
        return;
    }
    if (shape.kind === 'rect' && Array.isArray(drag.before.points)
        && drag.before.points.length === 4 && typeof drag.handle === 'number') {
        shape.points = resizeRectanglePoints(drag.before.points, drag.handle, snap);
        return;
    }
    if (Array.isArray(shape.points) && typeof drag.handle === 'number' && shape.points[drag.handle]) {
        shape.points[drag.handle] = { x: snap.x, y: snap.y };
    }
}

function polygonSegmentIndexAt(shape, worldPos, tolerance) {
    if (!['line', 'polygon', 'rect'].includes(shape.kind) || !Array.isArray(shape.points) || shape.points.length < 2) return null;
    const count = shape.kind === 'line' ? shape.points.length - 1 : shape.points.length;
    return pathSegmentAt(worldPos, shape.points.slice(0, count).map((start, id) => ({
        id, start, end: shape.points[(id + 1) % shape.points.length],
        bulge: boardShapeSegmentBulge(shape, id), lineWidth: boardShapeSegmentWidth(shape, id),
    })), tolerance);
}

function polygonVertexSnap(app, before, index, worldPos, closed, requireGrid = false, bulges = []) {
    const points = before.points || [];
    if (points.length < 2) return snapPathPoint(app, worldPos);
    const neighbours = [];
    if (index > 0 || closed) neighbours.push(points[(index + points.length - 1) % points.length]);
    if (index < points.length - 1 || closed) neighbours.push(points[(index + 1) % points.length]);
    return snapPathPoint(app, worldPos, neighbours, false, pathContinuationConstraints(points, closed, index, bulges));
}

function clearPolygonAxisIndicators(app) {
    clearAxisGlow(app);
}

function boardSquareIndicators(shape) {
    if (shape.kind !== 'rect') return [];
    return squareAlignmentSegments(shape.points || [],
        (shape.points || []).map((_, index) => boardShapeSegmentWidth(shape, index)))
        .map(segment => ({ ...segment, layerId: shape.layer }));
}

function renderPolygonAxisIndicators(app, shape, indices, excludedSegments = [], haloMarginPx = null) {
    if (shape.kind === 'rect') {
        renderAxisGlow(app, boardSquareIndicators(shape));
        return;
    }
    const bulgeMatch = typeof indices === 'string' ? /^bulge:(\d+)$/.exec(indices) : null;
    const bulgeSegment = bulgeMatch ? Number(bulgeMatch[1]) : null;
    if (shape.kind === 'arc' && indices === 'bulge' || bulgeMatch) {
        if (Math.abs(editableShapeBulge(shape, bulgeSegment)) >= BULGE_EPS) {
            clearAxisGlow(app);
            return;
        }
        renderAxisGlow(app, [{
            a: shape.kind === 'arc' ? shape.start : shape.points[bulgeSegment],
            b: shape.kind === 'arc' ? shape.end : shape.points[(bulgeSegment + 1) % shape.points.length],
            layerId: shape.layer,
            width: boardShapeSegmentWidth(shape, bulgeSegment ?? 0),
            haloMarginPx,
            collinear: true,
        }]);
        return;
    }
    if (shape.kind === 'arc') {
        renderPolygonAxisIndicators(app, { ...shape, kind: 'line', points: [shape.start, shape.end] },
            indices === 'end' ? 1 : 0, excludedSegments, 1);
        return;
    }
    if (!['line', 'polygon', 'rect'].includes(shape.kind) || !shape.points?.length) {
        clearAxisGlow(app);
        return;
    }
    const segments = pathAlignmentSegments(shape.points, shape.kind !== 'line',
        Array.isArray(indices) ? indices : [indices],
        shape.points.map((_, index) => boardShapeSegmentWidth(shape, index)),
        shape.points.map((_, index) => boardShapeSegmentBulge(shape, index)), excludedSegments)
        .map(segment => ({ ...segment, layerId: shape.layer, haloMarginPx }));
    renderAxisGlow(app, segments);
}

/** Snap a parallel segment drag when either adjoining segment reaches H/V/45. */
function snapPolylineSegmentDrag(app, shape, before, segment, worldPos) {
    const points = before.points || [];
    const firstIndex = segment;
    const secondIndex = shape.kind === 'line' ? segment + 1 : (segment + 1) % points.length;
    const first = points[firstIndex];
    if (!first) return { dx: 0, dy: 0 };
    const closed = shape.kind !== 'line';
    const constraints = pathSegmentConstraints(points, closed, segment, shape.segmentBulges);
    const delta = snapPathTranslation(app, [points[firstIndex], points[secondIndex]],
        { x: worldPos.x - before.startWorld.x, y: worldPos.y - before.startWorld.y }, [], constraints);
    return { dx: delta.x, dy: delta.y };
}

/** Remove redundant straight-through waypoints after a polyline edit. */
export function collapseCollinearPolylinePoints(shape) {
    return collapseCollinearPath(shape, index => boardShapeSegmentWidth(shape, index));
}

export function remapBoardShapeNodeRadii(shape, index, delta) {
    remapPathNodes(shape, index, delta);
}

export function splitBoardShapeSegmentMetadata(shape, segment) {
    splitPathSegmentMetadata(shape, segment);
}

function finishBoardShapeRemoval(app) {
    setBoardShapeNodeFocus(app, null);
    setBoardShapeSegmentFocus(app, null);
    app.clearProperties?.();
    app.setActiveRibbonTab?.('pcb-home');
}

export function deleteSelectedBoardShape(app) {
    const s = getPcbSelection(app, 'shape')[0] || null;
    if (!s) return false;
    if (s.layer === 'board-outline') return false;
    if (isLayerLocked(s.layer)) return false;
    app.history.execute(new RemoveBoardShapeCommand(app, s));
    selectBoardShape(app, null);
    finishBoardShapeRemoval(app);
    return true;
}

export function setBoardShapeSegmentType(app, shape, segment, type, { floating = false } = {}) {
    shape = canonicalBoardShape(app, shape);
    const original = shape;
    const standalone = shape?.kind === 'arc' || (shape?.kind === 'line' && shape.points?.length === 2);
    const count = shape?.kind === 'line' ? shape.points?.length - 1
        : ['polygon', 'rect'].includes(shape?.kind) ? shape.points?.length : shape?.kind === 'arc' ? 1 : 0;
    if (!Number.isInteger(segment) || segment < 0 || segment >= count
        || !['line', 'arc'].includes(type) || isLayerLocked(shape.layer)) return false;
    const before = shapeSnapshot(shape);
    shape = copyBoardShape(shape);
    if (shape.kind === 'rect') shape.kind = 'polygon';
    if (standalone) {
        if (shape.kind === 'line' && type === 'arc') {
            const [start, end] = shape.points;
            const arc = arcFromBulge(start, end, boardShapeSegmentBulge(shape, 0) || 0.25);
            if (!arc) return false;
            shape.lineWidth = boardShapeSegmentWidth(shape, 0);
            shape.kind = 'arc';
            applyShapeGeometry(shape, { start, end, bulge: arc.bulgePoint });
        } else if (shape.kind === 'arc' && type === 'line') {
            const points = [shape.start, shape.end];
            shape.kind = 'line';
            applyShapeGeometry(shape, { points });
        }
        shape.filled = false;
        shape.segmentWidths = {};
        shape.segmentBulges = {};
    } else if (!setPathSegmentType(shape, segment, type)) {
        return false;
    }
    const merged = type === 'line' && collapseCollinearPolylinePoints(shape);
    const after = shapeSnapshot(shape);
    setBoardShapeSegmentFocus(app, merged ? null : { shapeId: shape.id, segment });
    setBoardShapeNodeFocus(app, null);
    if (floating && type === 'arc') {
        const anchorId = shape.kind === 'arc' ? 'bulge' : `bulge:${segment}`;
        const stagedAnchor = getBoardShapeAnchors(shape).find(item => item.id === anchorId);
        if (!stagedAnchor || !startBoardShapeDrag(app, original, stagedAnchor, anchorId)) return false;
        const drag = app._shapeDrag;
        applyShapeSnapshot(beginBoardShapePointerPreview(app, drag), after);
        setBoardShapeSegmentFocus(app, { shapeId: original.id, segment });
        drag.editBefore = after.geom;
        drag.editKind = after.kind;
        drag.vertexBefore = cloneShapeGeometry(drag.shape);
        drag.preparing = true;
        const adapter = createBoardShapeSelectionAdapter(app, original, original.id);
        const anchor = adapter.getAnchors().find(item => item.id === anchorId);
        if (!anchor || !beginPcbAnchorInteraction(app, adapter, anchor, anchor, true)) {
            endBoardShapeDrag(app, false);
            return false;
        }
        drag.preparing = false;
        renderBoardShape(app, drag.shape, { liveDrag: true });
    } else app.history.execute(new ModifyBoardShapeCommand(app, original, before, after));
    showBoardShapeProperties(app, original);
    renderBoardShapeHandles(app, original);
    renderBoardShapeSegmentSelection(app);
    return true;
}

// ── Drag (move whole shape) ──────────────────────────────────────────────────

export function startBoardShapeDrag(app, shape, worldPos, anchorId = null, options = {}) {
    shape = canonicalBoardShape(app, shape);
    getPropertyEditor(app, 'boardShape')?.commit();
    if (!shape || isLayerLocked(shape.layer) || !isLayerVisible(shape.layer)) return false;
    if (app._shapeDrag?.preparing && app._shapeDrag.original === shape) return true;
    if (app._shapeDrag) throw new Error('Finish the current shape drag before starting another.');
    if (boardShapeRotationPreviews.has(app)) {
        if (!finishSelectionInteraction(app, true)) finishBoardShapeRotationPreview(app, true);
    }
    const before = cloneShapeGeometry(shape);
    const beforeState = shapeSnapshot(shape);
    let handle = anchorId != null ? anchorId : options.whole ? null : hitTestBoardShapeVertex(app, shape, worldPos);
    const midpointMatch = typeof anchorId === 'string' ? /^mid:(\d+)$/.exec(anchorId) : null;
    if (midpointMatch) setBoardShapeNodeFocus(app, null);
    let mode = handle != null ? 'vertex' : 'move';
    let segment = null;
    const drag = {
        original: shape, shape, id: shape.id, before, beforeState,
        startWorld: { x: worldPos.x, y: worldPos.y }, sourceAnchorId: anchorId,
        previousDeferDragOverlays: !!areDragOverlaysDeferred(app),
    };
    if (['line', 'polygon', 'rect'].includes(shape.kind) && midpointMatch) {
        segment = Number(midpointMatch[1]);
        if (segment >= 0 && segment < shape.points.length) {
            shape = beginBoardShapePointerPreview(app, drag);
            const next = shape.points[(segment + 1) % shape.points.length];
            const point = shape.points[segment];
            if (shape.kind === 'rect') {
                shape.kind = 'polygon';
            }
            splitBoardShapeSegmentMetadata(shape, segment);
            remapBoardShapeNodeRadii(shape, segment + 1, 1);
            shape.points.splice(segment + 1, 0, { x: (point.x + next.x) / 2, y: (point.y + next.y) / 2 });
            handle = segment + 1;
            mode = 'vertex';
        }
    } else if (options.allowSegment && ['line', 'polygon', 'rect'].includes(shape.kind) && handle == null) {
        segment = polygonSegmentIndexAt(shape, worldPos, Math.max(0.3, 8 / Math.max(0.01, app.viewport?.scale || 1)));
        if (segment != null) {
            mode = 'segment';
            setBoardShapeSegmentFocus(app, { shapeId: shape.id, segment });
        }
    }
    const bulgeMatch = typeof handle === 'string' ? /^bulge:(\d+)$/.exec(handle) : null;
    if (bulgeMatch || shape.kind === 'arc' && handle === 'bulge') {
        setBoardShapeNodeFocus(app, null);
        setBoardShapeSegmentFocus(app, { shapeId: shape.id, segment: bulgeMatch ? Number(bulgeMatch[1]) : 0 });
        showBoardShapeProperties(app, shape);
    } else if (mode !== 'segment') setBoardShapeSegmentFocus(app, null);
    renderBoardShapeSegmentSelection(app);
    const net = String(shape.net || '');
    const ratsnestNets = net
        && (shape.layer === 'top-copper' || shape.layer === 'bottom-copper')
        && normalizeShapeCopperMode(shape.copperMode) === 'add'
        ? new Set([net])
        : null;
    app._shapeDrag = Object.assign(drag, {
        mode,
        handle,
        segment,
        vertexBefore: cloneShapeGeometry(shape),
        ratsnestNets,
    });
    app.setPcbStatus?.();
    setDragOverlaysDeferred(app, true);
    if (mode === 'vertex' || mode === 'segment') schedulePictureCopperRefresh(app, shape);
    const vertex = midpointMatch ? shape.points[handle] : handle != null
        ? shapeHandlePoints(shape).find((point) => point.key === handle)
        : null;
    app.viewport?.setCrosshair(vertex || (mode === 'move' ? geomAnchor(before) : worldPos));
    return true;
}

export function handleBoardShapeDrag(app, worldPos) {
    const d = app._shapeDrag;
    if (!d) return;
    if (!Number.isFinite(worldPos?.x) || !Number.isFinite(worldPos?.y)) {
        endBoardShapeDrag(app, false);
        throw new Error('Shape drag requires a finite position.');
    }
    if (isLayerLocked(d.original.layer) || !isLayerVisible(d.original.layer)) {
        endBoardShapeDrag(app, false);
        return;
    }
    if (!d.preview && worldPos.x === d.startWorld.x && worldPos.y === d.startWorld.y) return;
    const modifiers = `${!!app.viewport?.shiftHeld}:${!!app.viewport?.gridVisible}:${app.viewport?.gridSize}:${app.viewport?.scale}:${app.viewport?.snapToGrid}:${app._snapActive?.()}`;
    if (d.lastPoint?.x === worldPos.x && d.lastPoint?.y === worldPos.y && d.lastModifiers === modifiers) return;
    d.lastPoint = { ...worldPos };
    d.lastModifiers = modifiers;
    const s = beginBoardShapePointerPreview(app, d);
    const before = d.editBefore || d.before, beforeKind = d.editKind || d.beforeState.kind;
    if (d.mode === 'vertex' || d.mode === 'segment') schedulePictureCopperRefresh(app, s);
    if (d.mode === 'vertex') {
        const polylineDrag = (['line', 'polygon'].includes(beforeKind) && typeof d.handle === 'number')
            || (typeof d.sourceAnchorId === 'string' && d.sourceAnchorId.startsWith('mid:'));
        const editingSegmentBulge = typeof d.handle === 'string' && d.handle.startsWith('bulge:');
        const editingArcEndpoint = s.kind === 'arc' && (d.handle === 'start' || d.handle === 'end');
        let snap = editingSegmentBulge ? snapPathPoint(app, worldPos, []) : polylineDrag && typeof d.handle === 'number'
            ? polygonVertexSnap(app, d.vertexBefore || before, d.handle, worldPos, beforeKind !== 'line',
                app._snapActive?.() ?? app.viewport?.snapToGrid !== false, s.segmentBulges || [])
            : editingArcEndpoint
                ? polygonVertexSnap(app, { points: [before.start, before.end] }, d.handle === 'start' ? 0 : 1,
                    worldPos, false, app._snapActive?.() ?? app.viewport?.snapToGrid !== false)
            : beforeKind === 'rect' && typeof d.handle === 'number'
                ? snapPathPoint(app, worldPos, [before.points[(d.handle + 2) % 4]])
            : snapPathPoint(app, worldPos, before.points || []);
        if (!app.viewport?.shiftHeld && (editingSegmentBulge || s.kind === 'arc' && d.handle === 'bulge')) {
            const segment = editingSegmentBulge ? Number(d.handle.slice(6)) : null;
            const start = segment == null ? s.start : s.points[segment];
            const end = segment == null ? s.end : s.points[(segment + 1) % s.points.length];
            snap = snapArcBulgeToChord(start, end, worldPos, snap, 8 / Math.max(0.01, app.viewport?.scale || 1));
        }
        if (polylineDrag) {
            s.points = d.vertexBefore.points.map((point, index) => index === d.handle ? { ...snap } : { ...point });
            s.kind = beforeKind === 'line' ? 'line' : 'polygon';
        } else {
            applyBoardShapeVertexResize(s, d.editBefore ? { ...d, before } : d, snap);
        }
        if (s.kind === 'polygon') normalizeBoardPolylineKind(s);
        else if (s.kind === 'line' && !d.splitBeforeState) closeBoardLineIfCoincident(s, d.handle);
        if (s.kind === 'line') {
            const target = app.viewport?.shiftHeld ? null : findBoardLineJoinTarget(app, s, d.handle, worldPos);
            d.joinTarget = target;
            if (target) s.points[d.handle] = { ...target.point };
        }
        const handle = shapeHandlePoints(s).find((point) => point.key === d.handle);
        app.viewport?.setCrosshair(handle || snap);
        renderBoardShape(app, s, { liveDrag: true });
        renderBoardShapeHandles(app, s);
        renderBoardShapeSegmentSelection(app);
        syncCircleDiameterProperty(app, s);
        syncShapeBulgeProperty(app, s);
        if (['line', 'polygon', 'rect', 'arc'].includes(s.kind)) renderPolygonAxisIndicators(app, s, d.handle);
        if (d.ratsnestNets) app.updateRatsnest?.({ nets: d.ratsnestNets });
        return;
    }
    if (d.mode === 'segment' && ['line', 'polygon', 'rect'].includes(s.kind) && d.segment != null) {
        const points = d.before.points || [];
        const firstIndex = d.segment;
        const wasLine = d.beforeState.kind === 'line';
        const secondIndex = wasLine ? d.segment + 1 : (d.segment + 1) % points.length;
        const { dx, dy } = snapPolylineSegmentDrag(app, s, { ...d.before, startWorld: d.startWorld }, d.segment, worldPos);
        s.points[firstIndex] = { x: points[firstIndex].x + dx, y: points[firstIndex].y + dy };
        s.points[secondIndex] = { x: points[secondIndex].x + dx, y: points[secondIndex].y + dy };
        app.viewport?.setCrosshair({ x: d.startWorld.x + dx, y: d.startWorld.y + dy });
        normalizeBoardPolylineKind(s);
        renderBoardShape(app, s, { liveDrag: true });
        renderBoardShapeHandles(app, s);
        renderBoardShapeSegmentSelection(app);
        if (['line', 'polygon', 'rect'].includes(s.kind)) {
            renderPolygonAxisIndicators(app, s, [firstIndex, secondIndex], [d.segment]);
        }
        if (d.ratsnestNets) app.updateRatsnest?.({ nets: d.ratsnestNets });
        return;
    }
    const dx = worldPos.x - d.startWorld.x;
    const dy = worldPos.y - d.startWorld.y;
    // Snap by the shape's anchor point so the whole shape lands on the grid.
    const anchor = geomAnchor(d.before);
    const delta = snapPathTranslation(app, d.before.points || [anchor], { x: dx, y: dy }, [anchor]);
    const snapped = { x: anchor.x + delta.x, y: anchor.y + delta.y };
    applyShapeGeometry(s, translateShapeGeometry(d.before, delta.x, delta.y));
    app.viewport?.setCrosshair(snapped);
    renderBoardShape(app, s, { liveDrag: true });
    renderBoardShapeHandles(app, s);
    renderAxisGlow(app, boardSquareIndicators(s));
    if (d.ratsnestNets) app.updateRatsnest?.({ nets: d.ratsnestNets });
}

export function endBoardShapeDrag(app, commit) {
    const d = app._shapeDrag;
    if (!d) return;
    app._shapeDrag = null;
    const interaction = app._pcbSelectionInteraction;
    if (interaction?.adapter?.kind === 'shape'
        || (interaction?.mode === 'move-adapter' && interaction.entry.kind === 'shape')) app._pcbSelectionInteraction = null;
    app.setPcbStatus?.();
    app.viewport?.hideCrosshair();
    clearPolygonAxisIndicators(app);
    setDragOverlaysDeferred(app, d.previousDeferDragOverlays);
    const s = d.shape, original = d.original;
    const originals = app.pcbDocument?.boardShapes || app.boardShapes;
    const present = originals.includes(original);
    if (d.splitRemainder) removeBoardShapeElement(app, d.splitRemainder.id);
    let committed = false;
    try {
        if (commit && !present) throw new Error('Cannot finish a drag of a missing board shape.');
        if (!commit || !d.preview || isLayerLocked(original.layer) || !isLayerVisible(original.layer)) return;
        if (d.splitBeforeState) {
            const first = s.points[0], last = d.splitOrigin || s.points.at(-1);
            if (Math.hypot(first.x - last.x, first.y - last.y) < 1e-9) return;
        }
        const target = d.splitBeforeState ? null : d.joinTarget?.shape;
        if (s.kind === 'line' && target) {
            if (!originals.includes(target)) throw new Error('Cannot join a missing board shape.');
            if (isLayerLocked(target.layer) || !isLayerVisible(target.layer)) return;
            const merged = mergeBoardLines(app, s, d.handle, target, d.joinTarget.endpoint);
            const added = addBoardShapeOrTrackCommand(app, merged);
            selectBoardShape(app, null);
            app.history.execute(new CompoundCommand([
                new RemoveBoardShapeCommand(app, original),
                new RemoveBoardShapeCommand(app, target),
                added.command,
            ]));
            committed = true;
            if (added.track) selectReplacementTracks(app, [added.track]);
            else selectBoardShape(app, merged);
            return;
        }
        const closedOpenLine = d.beforeState.kind === 'line' && s.kind !== 'line';
        const bulgeHandle = typeof d.handle === 'string' ? /^bulge:(\d+)$/.exec(d.handle) : null;
        if ((d.mode === 'vertex' || d.mode === 'segment') && !closedOpenLine && !bulgeHandle && !d.splitBeforeState
            && JSON.stringify(cloneShapeGeometry(s)) !== JSON.stringify(d.before)) collapseCollinearPolylinePoints(s);
        if (d.mode === 'vertex') normalizeStraightArc(s, bulgeHandle ? Number(bulgeHandle[1]) : null);
        const after = cloneShapeGeometry(s);
        if (!d.editBefore && ['rect', 'polygon'].includes(d.beforeState.kind)
            && ['rect', 'polygon'].includes(s.kind) && JSON.stringify(after) === JSON.stringify(d.before)) {
            s.kind = d.beforeState.kind;
        }
        const afterState = shapeSnapshot(s);
        if (JSON.stringify(afterState) === JSON.stringify(d.beforeState)
            || (s.layer === 'board-outline' && !validBoardOutline(s))) return;
        const metadataChanged = ['kind', 'segmentWidths', 'segmentBulges', 'nodeCornerRadii'].some(
            key => JSON.stringify(afterState[key]) !== JSON.stringify(d.beforeState[key]));
        const command = d.splitBeforeState || metadataChanged || after.points?.length !== d.before.points?.length
            ? new ModifyBoardShapeCommand(app, original, d.beforeState, afterState)
            : new MoveBoardShapeCommand(app, original, d.before, after);
        const replacement = copperPathReplacementCommands(app, original, s);
        const remainder = d.splitRemainder ? addBoardShapeOrTrackCommand(app, d.splitRemainder) : null;
        const commands = [...(replacement ? replacement.commands : [command]), ...(remainder ? [remainder.command] : [])];
        if (replacement) selectBoardShape(app, null);
        app.history.execute(commands.length === 1 ? commands[0] : new CompoundCommand(commands));
        committed = true;
        const tracks = [replacement?.track, remainder?.track].filter(Boolean);
        if (tracks.length) selectReplacementTracks(app, tracks);
    } finally {
        if (!committed) {
            if (d.splitBeforeState) setBoardShapeNodeFocus(app, null);
            if (present) {
                schedulePictureCopperRefresh(app, app._pendingShapeClearances?.has(original.id) ? original : undefined);
                renderBoardShape(app, original, { liveDrag: true });
                showBoardShapeProperties(app, original);
            } else {
                removeBoardShapeElement(app, original.id);
                syncPcbSelection(app);
                renderPcbSelectionAnchors(app);
            }
            cancelPictureCopperRefresh(app);
        }
        if (originals.includes(original)) {
            renderBoardShapeHandles(app, original);
            renderBoardShapeSegmentSelection(app);
            syncCircleDiameterProperty(app, original);
            syncShapeBulgeProperty(app, original);
        }
        if (d.ratsnestNets) app.updateRatsnest?.({ nets: d.ratsnestNets, skipFillRefresh: !committed });
    }
}

/** Split a closed shape at a node and float one of the coincident endpoints. */
export function openBoardShape(app, shape, vertexIndex = 0) {
    shape = canonicalBoardShape(app, shape);
    if (shape?.layer === 'board-outline') return false;
    if (!shape || !['line', 'polygon', 'rect'].includes(shape.kind) || isLayerLocked(shape.layer)) return false;
    const points = shape.points || [];
    if (points.length < 3) return false;
    const before = shapeSnapshot(shape);
    const start = Math.max(0, Math.min(points.length - 1, Math.trunc(Number(vertexIndex) || 0)));
    const split = splitPathAtNode(shape, start);
    if (!split) return false;
    const remainder = split.remainder;
    if (remainder) remainder.id = `pshape_${app._shapeIdCounter}`;
    selectBoardShape(app, shape);
    if (!startBoardShapeDrag(app, shape, split.moving.points[0], 0)) return false;
    const drag = app._shapeDrag;
    Object.assign(beginBoardShapePointerPreview(app, drag), split.moving);
    drag.editBefore = cloneShapeGeometry(drag.shape);
    drag.editKind = drag.shape.kind;
    drag.vertexBefore = drag.editBefore;
    drag.preparing = true;
    Object.assign(drag, { splitBeforeState: before, splitRemainder: remainder, splitOrigin: { ...points[start] } });
    if (remainder) { drag.preview.boardShapes.push(remainder); renderBoardShape(app, remainder); }
    const adapter = createBoardShapeSelectionAdapter(app, shape, shape.id);
    if (!beginPathSplit(app, adapter, 0, () => {
        drag.preparing = false;
    })) {
        endBoardShapeDrag(app, false);
        setBoardShapeNodeFocus(app, null);
        return false;
    }
    renderBoardShape(app, drag.shape, { liveDrag: true });
    return true;
}

export function deleteBoardShapeSegment(app, shape, segment) {
    if (shape?.layer === 'board-outline') {
        if (!Number.isInteger(segment) || segment < 0 || segment >= (shape.points?.length || 0)) return false;
        return deleteBoardShapeVertex(app, shape, (segment + 1) % shape.points.length);
    }
    if (shape.kind === 'arc' && segment === 0 && !isLayerLocked(shape.layer)) {
        setPcbSelection(app, []);
        app.history.execute(new RemoveBoardShapeCommand(app, shape));
        finishBoardShapeRemoval(app);
        return true;
    }
    const count = shape.kind === 'line' ? shape.points.length - 1 : shape.points?.length;
    if (!Number.isInteger(segment) || segment < 0 || segment >= count || isLayerLocked(shape.layer)) return false;
    const parts = deletePathSegment(shape, segment).map(part => {
        part.id = `pshape_${app._shapeIdCounter++}`;
        return part;
    });
    setPcbSelection(app, []);
    app.history.execute(new CompoundCommand([new RemoveBoardShapeCommand(app, shape),
        ...parts.map(part => addBoardShapeOrTrackCommand(app, part).command)]));
    if (parts.length === 0) finishBoardShapeRemoval(app);
    return true;
}

export function deleteFocusedBoardShape(app) {
    const selected = getPcbSelection(app, 'shape');
    if (selected.length !== 1 || getPcbSelection(app).length !== 1) return false;
    const shape = canonicalBoardShape(app, selected[0]);
    const node = getBoardShapeNodeFocus(app)?.shapeId === shape.id ? getBoardShapeNodeFocus(app).index : null;
    const segment = getBoardShapeSegmentFocus(app)?.shapeId === shape.id ? getBoardShapeSegmentFocus(app).segment : null;
    if (node == null && segment == null) return false;
    if (app._shapeDrag) {
        const splitting = !!app._shapeDrag.splitBeforeState;
        endBoardShapeDrag(app, false);
        app._pcbSelectionInteraction = null;
        if (splitting) {
            setBoardShapeNodeFocus(app, null);
            setBoardShapeSegmentFocus(app, null);
            showBoardShapeProperties(app, shape);
            return true;
        }
    }
    if (node != null) deleteBoardShapeVertex(app, shape, node);
    else deleteBoardShapeSegment(app, shape, segment);
    setBoardShapeNodeFocus(app, null);
    setBoardShapeSegmentFocus(app, null);
    app._refreshPcbSelectionHighlights?.();
    return true;
}

/** Delete a polyline vertex; a triangle reduces to an open two-point Line. */
export function deleteBoardShapeVertex(app, shape, vertexIndex) {
    shape = canonicalBoardShape(app, shape);
    if (!shape || !['line', 'polygon', 'rect'].includes(shape.kind) || isLayerLocked(shape.layer)) return false;
    const points = shape.points || [];
    if (shape.layer === 'board-outline' && points.length <= 3) return false;
    if (!Number.isInteger(vertexIndex) || vertexIndex < 0 || vertexIndex >= points.length) return false;
    if (shape.kind === 'line' && points.length <= 2) {
        setPcbSelection(app, []);
        app.history.execute(new RemoveBoardShapeCommand(app, shape));
        finishBoardShapeRemoval(app);
        return true;
    }
    const before = shapeSnapshot(shape);
    const candidate = copyBoardShape(shape);
    deletePathVertex(candidate, vertexIndex);
    normalizeBoardPolylineKind(candidate);
    const after = shapeSnapshot(candidate);
    app.history.execute(new ModifyBoardShapeCommand(app, shape, before, after));
    setBoardShapeNodeFocus(app, null);
    setBoardShapeSegmentFocus(app, null);
    showBoardShapeProperties(app, shape);
    return true;
}

/** Remove the currently-open board-shape context menu. */
export function dismissBoardShapeContextMenu() {
    dismissPathContextMenu('pcbBoardShapeContextMenu');
}

/** Show topology actions for a Line, Polygon, or Rectangle. */
export function showBoardShapeContextMenu(app, shape, clientX, clientY, worldPos) {
    dismissBoardShapeContextMenu();
    if (!shape || !['line', 'polygon', 'rect', 'arc'].includes(shape.kind) || isLayerLocked(shape.layer)) return;
    selectBoardShape(app, shape);
    const vertexIndex = hitTestBoardShapeVertex(app, shape, worldPos);
    const node = typeof vertexIndex === 'number';
    const segmentIndex = node ? null : shape.kind === 'arc' ? 0
        : polygonSegmentIndexAt(shape, worldPos, 8 / Math.max(0.01, app.viewport?.scale || 1));
    setBoardShapeNodeFocus(app, node ? { shapeId: shape.id, index: vertexIndex } : null);
    setBoardShapeSegmentFocus(app, segmentIndex != null ? { shapeId: shape.id, segment: segmentIndex } : null);
    const curved = shape.kind === 'arc' || !!boardShapeSegmentBulge(shape, segmentIndex);
    const remove = () => {
        setPcbSelection(app, []);
        app.history.execute(new RemoveBoardShapeCommand(app, shape));
        finishBoardShapeRemoval(app);
    };
    const items = pathContextActions({ node, segment: segmentIndex != null, curved,
        standalone: shape.kind === 'arc' || (shape.kind === 'line' && shape.points.length === 2),
        split: shape.layer !== 'board-outline' && node && (shape.kind !== 'line' || vertexIndex > 0 && vertexIndex < shape.points.length - 1)
            ? () => openBoardShape(app, shape, vertexIndex) : null,
        deleteNode: shape.layer === 'board-outline' && shape.points.length <= 3 ? null : () => deleteBoardShapeVertex(app, shape, vertexIndex),
        convert: () => setBoardShapeSegmentType(app, shape, segmentIndex, curved ? 'line' : 'arc', { floating: !curved }),
        deleteSegment: shape.layer === 'board-outline' && shape.points.length <= 3 ? null
            : shape.kind === 'arc' ? remove : () => deleteBoardShapeSegment(app, shape, segmentIndex),
        deleteObject: shape.layer === 'board-outline' ? null : remove, label: shapeKindLabel(shape.kind).toLowerCase(),
    });
    showBoardShapeProperties(app, shape);
    renderBoardShape(app, shape);
    renderBoardShapeHandles(app, shape);
    renderBoardShapeSegmentSelection(app);
    return showPathContextMenu('pcbBoardShapeContextMenu', items, clientX, clientY, () => app._refreshPcbSelectionHighlights?.());
}

// ── Draw lifecycle ───────────────────────────────────────────────────────────

/** Prefer the active drawing layer, otherwise the first unlocked valid choice. */
export function resolveShapeDrawLayer(app, layerId) {
    let id = String(layerId || 'top-copper');
    if (id === 'top-paste' || id === 'bottom-paste' || id === 'board-outline' || id === 'vias') {
        id = id.startsWith('bottom-') ? 'bottom-silk' : 'top-silk';
    }
    const available = PCB_LAYERS.filter(layer => !PROP_HIDDEN_LAYERS.has(layer.id) && !layer.locked);
    return (available.find(layer => layer.id === id) || available[0])?.id || null;
}

function makePreview(app) {
    const preview = document.createElementNS(NS, 'path');
    preview.setAttribute('class', 'pcb-shape-preview');
    preview.setAttribute('stroke', 'var(--sch-symbol-outline, #ffffff)');
    preview.setAttribute('stroke-width', '1');
    preview.setAttribute('opacity', '0.6');
    preview.setAttribute('vector-effect', 'non-scaling-stroke');
    preview.setAttribute('stroke-linejoin', 'round');
    app.getLayerGroup('selection-overlay')?.appendChild(preview);
    return preview;
}

function shapeDrawSnap(app, worldPos) {
    const draw = app._shapeDraw;
    if (draw?.kind === 'arc' && draw.points.length === 2) return worldPos;
    const previous = draw?.points.at(-1);
    const continuations = draw && ['line', 'polygon'].includes(draw.kind)
        ? pathContinuationConstraints([...draw.points, worldPos], false, draw.points.length) : [];
    return snapPathPoint(app, worldPos, previous ? [previous] : [], false, continuations);
}

/** Screen distance (px) within which a click repeats the last placed vertex. */
const REPEAT_CLICK_PX = 4;

/** The open shape drawing session (`{ kind, … }`), or null. */
export function getShapeDraw(app) {
    return app._shapeDraw || null;
}

/** Left-click while a shape tool is active. */
export function shapeDrawClick(app, kind, worldPos) {
    if (!SHAPE_KINDS.has(kind) || kind === 'image') return;
    const snap = shapeDrawSnap(app, worldPos);
    if (!app._shapeDraw || app._shapeDraw.kind !== kind) {
        const layer = resolveShapeDrawLayer(app, app.activeLayer);
        if (!layer) {
            showBoardShapeToolProperties(app, kind);
            return;
        }
        app.activeLayer = layer;
        app._shapeDraw = {
            kind,
            layer,
            points: [{ x: snap.x, y: snap.y }],
            preview: makePreview(app),
        };
        updateShapeDrawPreview(app, worldPos);
        return;
    }
    const d = app._shapeDraw;
    // The second click of a double-click lands on the vertex it just placed. It
    // must not add another: snapped against itself it can land just off-grid.
    const last = d.points.at(-1);
    if ((kind === 'line' || kind === 'polygon') && last
        && Math.hypot(worldPos.x - last.x, worldPos.y - last.y) * (app.viewport?.scale || 1) < REPEAT_CLICK_PX) {
        updateShapeDrawPreview(app, worldPos);
        return;
    }
    const next = advanceShapeDrawing(kind, d.points, snap);
    d.points = next.points;
    if (next.complete) finishShapeDraw(app);
    else updateShapeDrawPreview(app, worldPos);
}

/** Live preview as the cursor moves (cursor acts as the pending next point). */
export function updateShapeDrawPreview(app, worldPos) {
    const d = app._shapeDraw;
    if (!d) return;
    d.cursorWorld = { ...worldPos };
    d.preview.setAttribute('stroke-linejoin', 'round');
    d.preview.setAttribute('stroke-linecap', 'round');
    const p = shapeDrawSnap(app, worldPos);
    const dstr = shapePreviewPath(d.kind, d.points, p, getShapeDefaults(app)?.cornerRadius);
    d.preview?.setAttribute('d', dstr);
    const geometry = shapeFromPoints(d.kind, [...d.points, p], true);
    const lineWidth = normalizedBoardShapeLineWidth({ kind: d.kind, layer: d.layer }, getShapeDefaults(app)?.lineWidth);
    const indicators = geometry?.points
        ? d.kind === 'rect' ? boardSquareIndicators({ ...geometry, layer: d.layer, lineWidth })
            : pathAlignmentSegments(geometry.points, d.kind !== 'line', [geometry.points.length - 1],
                geometry.points.map(() => lineWidth)).map(segment => ({ ...segment, layerId: d.layer }))
        : [];
    renderAxisGlow(app, indicators);
    if (d.preview) {
        const st = shapeStyle({
            layer: d.layer,
            filled: !!getShapeDefaults(app)?.filled,
            copperMode: getShapeDefaults(app)?.copperMode,
        });
        const previewFilled = d.kind !== 'line' && st.filled;
        d.preview.setAttribute('fill', previewFilled ? st.fillColor : 'none');
        if (previewFilled) d.preview.setAttribute('fill-opacity', st.fillOpacity);
        else d.preview.removeAttribute('fill-opacity');
    }
}

/** Remove the live preview element and clear draw state. */
export function cancelShapeDraw(app) {
    const d = app._shapeDraw;
    if (!d) return;
    clearAxisGlow(app);
    if (d.preview?.parentNode) d.preview.parentNode.removeChild(d.preview);
    app._shapeDraw = null;
}

/** Finish a multi-click polygon (Enter / double-click). */
export function finishPolygonDraw(app) {
    if (app._shapeDraw && app._shapeDraw.kind === 'polygon') finishShapeDraw(app);
}

/** Finish a multi-click open Line (Enter / double-click). */
export function finishLineDraw(app) {
    if (app._shapeDraw && app._shapeDraw.kind === 'line') finishShapeDraw(app);
}

/** Commit the cursor position as the final point and finish the active shape. */
export function finishShapeDrawAtPoint(app, worldPos) {
    const draw = app._shapeDraw;
    if (!draw || !worldPos) return false;
    const point = shapeDrawSnap(app, worldPos);
    if (!canFinishShapeAtPoint(draw.kind, draw.points)) return false;
    draw.points = advanceShapeDrawing(draw.kind, draw.points, point).points;
    finishShapeDraw(app);
    return true;
}

/** Commit the in-progress draw into a board shape. */
export function finishShapeDraw(app) {
    const d = app._shapeDraw;
    if (!d) return;
    clearAxisGlow(app);
    if (d.preview?.parentNode) d.preview.parentNode.removeChild(d.preview);
    app._shapeDraw = null;

    const layer = d.layer || app.activeLayer;
    const alwaysFilled = isMaskLayer(layer);
    const base = {
        id: `pshape_${app._shapeIdCounter++}`,
        kind: d.kind,
        layer,
        lineWidth: normalizedBoardShapeLineWidth(
            { kind: d.kind, layer },
            getShapeDefaults(app)?.lineWidth,
        ),
        filled: d.kind === 'line' ? false : alwaysFilled || !!getShapeDefaults(app)?.filled,
        copperMode: normalizeShapeCopperMode(getShapeDefaults(app)?.copperMode),
        plated: layer === 'hole' && !!getShapeDefaults(app)?.plated,
        net: layer === 'top-copper' || layer === 'bottom-copper'
            ? String(getShapeDefaults(app)?.net || '')
            : '',
        cornerRadius: d.kind === 'rect' ? Math.max(0, Number(getShapeDefaults(app)?.cornerRadius) || 0) : undefined,
    };

    const geometry = shapeFromPoints(d.kind, d.points);
    if (!geometry) return;
    const shape = { ...base, ...geometry, filled: d.kind === 'arc' ? false : base.filled };
    if ('points' in shape && isCopperPathShape(shape)) {
        // A copper path is routing intent, with or without a net, so it enters
        // the Track model directly instead of creating a generic shape first.
        const track = trackFromBoardShape(shape, shape.net);
        app.history.execute(new AddTrackCommand(app, track));
        setPcbSelection(app, [{ kind: 'track', object: track }]);
        app._refreshPcbSelectionHighlights?.();
        return;
    }
    app.history.execute(new AddBoardShapeCommand(app, shape));
}

// ── Copper cuts ──────────────────────────────────────────────────────────────

/**
 * SVG sub-paths for board shapes that subtract copper on the given copper
 * layer. Returns { count, d } to fold into updateCopperCuts (copper-cuts.js).
 */
export function boardShapeCopperCuts(app, copperLayer) {
    let d = '';
    let count = 0;
    const appendLoop = (points) => {
        if (points.length < 3) return;
        d += ` M ${r4(points[0].x)} ${r4(points[0].y)}`;
        for (let index = 1; index < points.length; index++) d += ` L ${r4(points[index].x)} ${r4(points[index].y)}`;
        d += ' Z';
    };
    for (const s of (app.boardShapes || [])) {
        if (!s) continue;
        // A hole-layer shape is a board cutout — it removes copper on both
        // sides regardless of mode. Copper-removal shapes only cut their own
        // copper layer.
        if (s.layer === 'hole') {
            // included on every side
        } else if (s.layer === copperLayer) {
            const m = normalizeShapeCopperMode(s.copperMode);
            if (m !== 'remove-copper' && m !== 'remove-copper-mask') continue;
        } else {
            continue;
        }
        if (s.layer !== 'hole') {
            const removalPath = boardShapeRemovalPathD(s);
            if (!removalPath) continue;
            d += ` ${removalPath}`;
            count++;
            continue;
        }
        const geometry = resolveBoardShapeGeometry(s);
        if (geometry.physicalContours) {
            for (const contour of geometry.physicalContours) appendLoop(contour);
            count++;
            continue;
        }
        if (geometry.filled) {
            const outline = geometry.circle
                ? circleOutline({ ...s, radius: geometry.circle.outerRadius, filled: false })
                : geometry.areaOutline || [];
            if (outline.length < 3) continue;
            appendLoop(outline);
        } else {
            continue;
        }
        count++;
    }
    return { count, d };
}

// ── Serialisation ────────────────────────────────────────────────────────────

export function loadBoardShapes(app, arr, { render = true, strict = false } = {}) {
    const stage = { boardShapes: [], shapeIdCounter: app._shapeIdCounter };
    loadBoardShapeData(stage, arr, { strict, lineWidth: getShapeDefaults(app)?.lineWidth ?? 0.2 });
    app._shapeIdCounter = stage.shapeIdCounter;
    for (const shape of stage.boardShapes) {
        app.boardShapes.push(shape);
        if (shape.layer === 'board-outline') syncBoardOutlineDimensions(app);
        if (render && shape.type !== 'fill') renderBoardShape(app, shape);
    }
}

/**
 * Keys while a board shape is being drawn: Escape cancels; Enter finishes a polygon
 * or line, or completes any other shape at the cursor.
 * @returns {boolean|null} null when no shape is being drawn, else whether the key was consumed.
 */
export function handleShapeDrawKey(app, e) {
    if (!app._shapeDraw) return null;
    if (e.key === 'Escape') {
        cancelShapeDraw(app);
        return true;
    }
    if (e.key === 'Enter' && app._shapeDraw.kind === 'polygon') {
        finishPolygonDraw(app);
        return true;
    }
    if (e.key === 'Enter' && app._shapeDraw.kind === 'line') {
        finishLineDraw(app);
        return true;
    }
    if (e.key === 'Enter') {
        finishShapeDrawAtPoint(app, app._shapeDraw.cursorWorld);
        return true;
    }
    return false;
}
