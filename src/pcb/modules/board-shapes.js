/**
 * Free-standing PCB board shapes: line, rectangle, polygon, arc and circle.
 *
 * Shapes are plain
 * objects stored in `app.boardShapes`; geometry-specific bits (path, outline,
 * hit-test) dispatch on `shape.kind`.
 *
 * Shape object shape:
 *   common: { id, kind:'line'|'rect'|'polygon'|'arc'|'circle', layer, lineWidth, filled, copperMode, plated }
 *   line:   + { points: [{x,y}, {x,y}] }   (open)
 *   rect:   + { cornerRadius }
 *   rect/polygon: + { points: [{x,y}, ...] }   (closed)
 *   arc:          + { start:{x,y}, end:{x,y}, bulge:{x,y} }
 *   circle:       + { x, y, radius }
 */

import { bulgeRatio, bulgePointFromRatio } from '../../core/geometry.js';
import { formatNumberInput, formatNumberInputValue } from '../../core/number-inputs.js';
import { projectArcBulge, snapArcBulgeToChord, arcBulgeRatio, arcBulgeFromRatio } from '../../shapes/arc-edit.js';
import { pathHandleDescriptors, pathSegmentAt } from '../../shapes/path-geometry.js';
import { joinPaths, remapPathNodes, splitPathSegmentMetadata, deletePathVertex, collapseCollinearPath, deletePathSegment, closePathIfCoincident, resizeRectanglePoints, pointsFormAxisAlignedRect, setPathSegmentType, splitPathAtNode } from '../../shapes/path-operations.js';
import { shapeFromPoints, shapePreviewPath, advanceShapeDrawing, canFinishShapeAtPoint } from '../../shapes/shape-drawing.js';
import { CopperFill, updateFillIdCounter } from '../../shapes/copper-fill.js';
import { isLayerLocked, isLayerVisible, PCB_LAYERS } from './layers.js';
import {
    AddBoardShapeCommand,
    RemoveBoardShapeCommand,
    MoveBoardShapeCommand,
    ModifyBoardShapeCommand,
} from './shape-commands.js';
import { AddTrackCommand, RemoveTrackCommand, CompoundCommand } from './track-commands.js';
import { Track } from '../../shapes/track.js';
import { clearAxisGlow, renderAxisGlow, pathAlignmentSegments, squareAlignmentSegments } from '../../shapes/axis-glow.js';
import { pathContinuationConstraints, pathSegmentConstraints } from '../../shapes/path-snap.js';
import { redrawPropertyPreview, createPropertyPreview } from '../../shapes/property-preview.js';
import {
    getPcbSelection,
    hitTestPcbSelection,
    isPcbSelected,
    registerPcbSelectionAdapter,
    setPcbSelection,
    syncPcbSelection,
} from './selection-registry.js';
import { clearPcbSelectionAnchors, renderPcbSelectionAnchors } from './selection-anchors.js';
import { appendSegmentSelection } from '../../core/ui-helpers.js';
import { beginPcbAnchorInteraction, showPcbSelectionProperties } from './selection-interaction.js';
import { pathMoveInteraction, beginPathSplit, snapPathPoint, snapPathTranslation, pathContextActions, showPathContextMenu, dismissPathContextMenu } from './path-edit.js';
import { canDrawPictureCircles, resizePicturePoints, validatePictureArtwork, validatePicturePoints, PICTURE_LAYERS } from './picture-raster.js';
import { encodePictureArtwork, decodePictureArtwork } from './picture-storage.js';
import { bindPictureRefreshHold, cancelPictureCopperRefresh, schedulePictureCopperRefresh } from './picture-refresh.js';
import { rotationHandleAnchor, pointerRotation, rotatedImagePoints } from './rotation-handle.js';
import { BULGE_EPS, arcFromBulge } from '../../shapes/arc-edge.js';
import { syncBoardOutlineDimensions, boardBoundary } from './board-outline.js';

import {
    normalizeShapeCopperMode,
    isMaskLayer,
    rectCornerRadius,
    polygonCornerRadius,
    boardShapeNodeCornerRadius,
    circleOutline,
    circleFilledRadius,
    boardShapeSegmentBulge,
    shapeOutline,
    boardShapeStrokeSegments,
    boardShapeRemovalPathD,
    boardShapeBounds,
    boardShapeHitTest,
    shapePathD,
    shapeIsFilled,
    boardShapeLineWidthMinimum,
    normalizedBoardShapeLineWidth,
    boardShapeSegmentWidth,
    resolveBoardShapeGeometry,
} from './board-shape-geometry.js';

const NS = 'http://www.w3.org/2000/svg';
const SHAPE_KINDS = new Set(['line', 'rect', 'polygon', 'arc', 'circle', 'image']);
const HOLE_BORDER_WIDTH = 0.05;
const REMOVAL_OUTLINE_WIDTH_PX = 1;

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

function canConvertBoardLineToTrack(shape, net = shape?.net) {
    return shape?.kind === 'line'
        && (shape.layer === 'top-copper' || shape.layer === 'bottom-copper')
        && normalizeShapeCopperMode(shape.copperMode) === 'add'
        && !!String(net || '').trim()
        && Array.isArray(shape.points)
        && shape.points.length >= 2;
}

function sourceBoardShapeForTrack(shape) {
    const source = JSON.parse(JSON.stringify(shape));
    source.net = '';
    return source;
}

function simpleTrackLinePoints(track) {
    if (!track || track.nodes.size < 2
        || track.edges.size !== track.nodes.size - 1 || track.padConnections.size) return null;
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
    if (endpoints.length !== 2 || [...adjacency.values()].some((edges) => edges.length < 1 || edges.length > 2)) return null;

    const points = [];
    const segmentWidths = {};
    const segmentBulges = {};
    const nodeCornerRadii = {};
    const visitedEdges = new Set();
    let previousNodeId = null;
    let nodeId = endpoints[0];
    let layer = null;
    while (nodeId) {
        const node = track.nodes.get(nodeId);
        if (!node) return null;
        if (Object.hasOwn(track.nodeCornerRadii || {}, nodeId)) nodeCornerRadii[points.length] = track.nodeCornerRadii[nodeId];
        points.push({ x: node.x, y: node.y });
        const next = (adjacency.get(nodeId) || []).find((edge) => edge.nodeId !== previousNodeId);
        if (!next) break;
        if (visitedEdges.has(next.edgeId)) return null;
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
    }
    return visitedEdges.size === track.edges.size && points.length === track.nodes.size
        ? { points, layer, width: track.width, segmentWidths, segmentBulges,
            cornerRadius: track.cornerRadius, nodeCornerRadii }
        : null;
}

export function canRestoreTrackToSourceBoardShape(track) {
    return !!simpleTrackLinePoints(track);
}

export function restoreTrackToSourceBoardShape(app, track) {
    if (!app.tracks?.includes(track)) return false;
    const source = simpleTrackLinePoints(track);
    if (!source) return false;
    const shape = {
        ...track.sourceBoardShape,
        id: track.sourceBoardShape?.id || `pshape_${app._shapeIdCounter++}`,
        kind: 'line',
        layer: source.layer,
        lineWidth: source.width,
        filled: false,
        copperMode: 'add',
        plated: false,
        net: '',
        points: source.points,
        segmentWidths: source.segmentWidths,
        segmentBulges: source.segmentBulges,
        cornerRadius: source.cornerRadius,
        nodeCornerRadii: source.nodeCornerRadii,
    };
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
 * Move a net-assigned generic copper Line into the canonical Track model.
 * Tracks that retain their unmodified source geometry can be restored to the
 * original Line when their net is cleared.
 */
export function convertBoardLineToTrack(app, shape, net = shape?.net) {
    if (!canConvertBoardLineToTrack(shape, net) || !app.boardShapes?.includes(shape)) return null;
    const track = new Track({
        net: String(net).trim(),
        width: Math.max(0.05, Number(shape.lineWidth) || 0.2),
        layer: shape.layer,
        points: shape.points.map((point) => ({ x: point.x, y: point.y })),
        edgeWidths: Object.fromEntries(Object.entries(shape.segmentWidths || {}).map(([index, width]) => [`e${index}`, width])),
        edgeBulges: Object.fromEntries(Object.entries(shape.segmentBulges || {}).map(([index, bulge]) => [`e${index}`, bulge])),
        cornerRadius: shape.cornerRadius,
        nodeCornerRadii: Object.fromEntries(Object.entries(shape.nodeCornerRadii || {}).map(([index, radius]) => [`n${index}`, radius])),
        sourceBoardShape: sourceBoardShapeForTrack(shape),
    });
    selectBoardShape(app, null);
    app.history.execute(new CompoundCommand([
        new RemoveBoardShapeCommand(app, shape),
        new AddTrackCommand(app, track),
    ]));
    setPcbSelection(app, [{ kind: 'track', object: track }]);
    showPcbSelectionProperties(app);
    app._refreshPcbSelectionHighlights?.();
    return track;
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
        if (candidate === shape || candidate.kind !== 'line'
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

function editableShapeBulge(shape, segment = null) {
    return shape.kind === 'arc'
        ? Math.max(-1, Math.min(1, bulgeRatio(shape.start, shape.end, shape.bulge)))
        : segment == null ? 0 : boardShapeSegmentBulge(shape, segment);
}

function normalizeStraightArc(shape, segment = null) {
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

/** Snapshot just the geometry (for move/modify undo). */
export function cloneShapeGeometry(shape) {
    if (shape.kind === 'arc') {
        return { start: { ...shape.start }, end: { ...shape.end }, bulge: { ...shape.bulge } };
    }
    if (shape.kind === 'circle') return { x: shape.x, y: shape.y, radius: shape.radius };
    return { points: (shape.points || []).map((p) => ({ x: p.x, y: p.y })) };
}

/** Write a geometry snapshot back onto a shape. */
export function applyShapeGeometry(shape, geom) {
    if (shape.kind === 'arc') {
        delete shape.points;
        shape.start = { ...geom.start };
        shape.end = { ...geom.end };
        shape.bulge = { ...geom.bulge };
    } else if (shape.kind === 'circle') {
        shape.x = geom.x;
        shape.y = geom.y;
        shape.radius = geom.radius;
    } else {
        delete shape.start;
        delete shape.end;
        delete shape.bulge;
        shape.points = (geom.points || []).map((p) => ({ x: p.x, y: p.y }));
    }
}

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

/** Lighten a hex color toward white by the given fraction (0..1). */
function lightenColor(color, fraction) {
    const channels = color.match(/[\da-f]{2}/gi);
    if (!channels || channels.length !== 3) return color;
    return `#${channels.map((channel) => {
        const value = parseInt(channel, 16);
        return Math.round(value + (255 - value) * fraction).toString(16).padStart(2, '0');
    }).join('')}`;
}

/** Base display color for the shape's PCB layer. */
export function shapeLayerColor(shape) {
    return PCB_LAYERS.find((layer) => layer.id === shape?.layer)?.color || '#ffffff';
}

/** Selection is a lighter version of the owning layer, not a fixed side color. */
export function shapeSelectionColor(shape) {
    const base = shape?.layer === 'hole' ? HOLE_FEEDBACK_BASE : shapeLayerColor(shape);
    return lightenColor(base, 0.35);
}

/** Hover is a subtle lightening of the owning layer color. */
export function shapeHoverColor(shape) {
    const base = shape?.layer === 'hole' ? HOLE_FEEDBACK_BASE : shapeLayerColor(shape);
    return lightenColor(base, 0.18);
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
            for (const target of changed) renderBoardShape(app, target, { liveDrag });
        },
        refreshSelection: () => {
            renderBoardShapeSegmentSelection(app);
            if (app._refreshPcbSelectionHighlights) app._refreshPcbSelectionHighlights();
            else renderPcbSelectionAnchors(app);
        },
        refreshDerived: () => {
            if (!liveDrag) app._refreshFills?.();
        },
    });
}

function createBoardShapePropertyPreview(app, targets, { liveDrag = false } = {}) {
    return createPropertyPreview({
        capture: () => targets.map(shapeSnapshot),
        restore: states => targets.forEach((target, index) => applyShapeSnapshot(target, states[index])),
        redraw: phase => redrawBoardShapePropertyPreview(app, targets, { liveDrag: liveDrag && phase === 'preview' }),
        commit: (before, after) => {
            const commands = targets.flatMap((target, index) => JSON.stringify(before[index]) === JSON.stringify(after[index])
                ? [] : [new ModifyBoardShapeCommand(app, target, before[index], after[index])]);
            if (commands.length) app.history.execute(commands.length === 1 ? commands[0] : new CompoundCommand(commands));
        },
    });
}

function bindPropertyPreviewCancel(input, preview, refreshPanel) {
    input?.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || !preview.cancel()) return;
        event.preventDefault();
        event.stopPropagation();
        refreshPanel();
    });
    input?.addEventListener('blur', () => {
        queueMicrotask(() => {
            if (!Number.isFinite(input.valueAsNumber)) preview.cancel();
            else preview.commit();
        });
    });
}

export function renderBoardShape(app, shape, opts = {}) {
    if (shape.layer === 'board-outline') syncBoardOutlineDimensions(app);
    removeBoardShapeElement(app, shape.id, { skipHatchUpdate: true, preserveInteraction: true });
    const selectedSegment = app._selectedBoardShapeSegment?.shapeId === shape.id
        && isPcbSelected(app, 'shape', shape)
        ? app._selectedBoardShapeSegment.segment
        : null;
    const supportsSegmentRendering = !shapeAffectsCopperCuts(shape)
        && shape.kind === 'line';
    const renderAsSegments = supportsSegmentRendering
        && ((!shapeIsFilled(shape) && Object.keys(shape.segmentWidths || {}).length > 0)
            || selectedSegment != null);
    const el = document.createElementNS(NS, renderAsSegments ? 'g' : 'path');
    const isSelected = isPcbSelected(app, 'shape', shape)
        && app._selectedBoardShapeSegment?.shapeId !== shape.id
        && app._selectedBoardShapeNode?.shapeId !== shape.id;
    const isHovered = !!(app._hoveredShape && app._hoveredShape.id === shape.id)
        && app._selectedBoardShapeSegment?.shapeId !== shape.id
        && app._selectedBoardShapeNode?.shapeId !== shape.id;
    const st = shapeStyle(shape);
    if (!renderAsSegments) {
        el.setAttribute('d', st.isCopperRemoval || st.isHoleLayer
            ? boardShapeRemovalPathD(shape)
            : shapePathD(shape, { close: st.filled }));
    }
    if (st.isCopperRemoval) el.setAttribute('fill-rule', 'evenodd');
    const canvasHatch = st.isCopperRemoval && st.filled;
    el.setAttribute('fill', st.filled
        ? (canvasHatch
            ? 'none'
            : st.isCopperRemoval
                ? app._ensureCopperRemovalHatch?.(shape.copperMode) || st.fillColor
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
        el.setAttribute('d', boardShapeRemovalPathD(shape));
        el.setAttribute('fill-rule', 'evenodd');
        if (!st.filled) el.setAttribute('fill', el.getAttribute('stroke'));
        el.setAttribute('stroke', 'none');
    }
    if (st.isCopperKnockout && !isSelected && !st.filled) el.setAttribute('stroke-dasharray', '0.6 0.45');
    if (shape.kind === 'image' && canDrawPictureCircles(shape.artwork)) el.setAttribute('fill-rule', 'nonzero');
    el.setAttribute('data-board-shape-layer', shape.layer || '');
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
    app._getLayerGroup(st.targetLayer)?.appendChild(el);
    app._shapeElements.set(shape.id, el);
    app._refreshBoardShapeClearance?.(shape);
    if (!opts.liveDrag || st.isCopperRemoval) app._scheduleRemovalHatchRender?.();
    if (app._pictureCopperRefreshPending) {
        if (shapeAffectsCopperCuts(shape) || app._hasCopperCuts) app._deferredShapeCopperCuts = true;
        return;
    }
    // Rebuilding the copper-cut clip-path re-rasterises the whole copper/fill
    // layer (every track + pour), so during a live drag skip it unless THIS
    // shape is itself a copper cut. Outside a drag, also run it when cuts
    // already exist so a layer/mode change can clear a stale cut.
    if (!opts.skipCopperUpdate) {
        const affectsCuts = shapeAffectsCopperCuts(shape);
        if (opts.liveDrag) {
            if (affectsCuts) app._updateCopperCuts?.();
        } else if (affectsCuts || app._hasCopperCuts) {
            app._updateCopperCuts?.();
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
        if (app._hoveredShape?.id === id) app._hoveredShape = null;
        const clearance = app._boardShapeClearanceCache?.get(id);
        for (const element of clearance?.elements || []) {
            element.parentNode?.removeChild(element);
        }
        app._boardShapeClearanceCache?.delete(id);
    }
    if (!opts.skipHatchUpdate) app._scheduleRemovalHatchRender?.();
}

// ── Hit-test / hover / selection ─────────────────────────────────────────────

export function hitTestBoardShape(app, worldPos) {
    return worldPos ? hitTestPcbSelection(app, worldPos, 'shape') : null;
}

export function setBoardShapeHover(app, shape) {
    const prev = app._hoveredShape || null;
    const next = shape || null;
    if (prev === next || (prev && next && prev.id === next.id)) return;
    app._hoveredShape = next;
    if (prev) renderBoardShape(app, prev);
    if (next) renderBoardShape(app, next);
}

export function selectBoardShape(app, shape) {
    const prev = getPcbSelection(app, 'shape')[0] || null;
    const next = shape || null;
    if (prev === next || (prev && next && prev.id === next.id)) return;
    app._selectedBoardShapeSegment = null;
    if (next && !isPcbSelected(app, 'shape', next)) {
        setPcbSelection(app, [{ kind: 'shape', object: next }]);
    }
    app._syncClipboardButtons?.();
    if (prev && app.boardShapes.includes(prev)) renderBoardShape(app, prev);
    if (next) renderBoardShape(app, next);
    clearBoardShapeHandles(app);
    if (next) renderBoardShapeHandles(app, next);
    renderBoardShapeSegmentSelection(app);
    app._setPcbStatus?.();
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
    schedulePictureCopperRefresh(app, shape);
    renderBoardShape(app, shape, { liveDrag: true });
    syncCircleDiameterProperty(app, shape);
}

/** Full SelectionManager adapter for rectangle, polygon, and arc objects. */
export function createBoardShapeSelectionAdapter(app, shape, id) {
    let rotationDrag = null;
    return {
        id,
        kind: 'shape',
        object: shape,
        get visible() {
            return !isLayerLocked(shape.layer) && isLayerVisible(shape.layer);
        },
        getBounds() { return boardShapeBounds(shape); },
        hitTest(point, tolerance) {
            if (boardShapeHitTest(shape, point, tolerance)) return true;
            if (!isPcbSelected(app, 'shape', shape) || !['line', 'rect', 'polygon'].includes(shape.kind)) return false;
            const points = shape.points || [];
            const count = shape.kind === 'line' ? points.length - 1 : points.length;
            return points.slice(0, count).some((start, index) =>
                distanceToSegment(point, start, points[(index + 1) % points.length]) <= tolerance);
        },
        getEditPath() {
            if (app._selectedBoardShapeNode?.shapeId === shape.id) return '';
            return shapePathD({ ...shape, cornerRadius: 0, nodeCornerRadii: {} });
        },
        getAnchors() {
            const anchors = getBoardShapeAnchors(shape).map(anchor => ({ ...anchor,
                selected: app._selectedBoardShapeNode?.shapeId === shape.id
                    && app._selectedBoardShapeNode.index === anchor.id,
            }));
            return shape.kind === 'image'
                ? [...anchors, rotationHandleAnchor(boardShapeBounds(shape), app.viewport?.scale)] : anchors;
        },
        moveAnchor(anchorId, x, y) { moveBoardShapeAnchor(app, shape, anchorId, { x, y }); },
        beginAnchorDrag(anchorId, worldPos) {
            if (anchorId !== 'rotate' || shape.kind !== 'image') return startBoardShapeDrag(app, shape, worldPos, anchorId);
            const center = { x: (shape.points[0].x + shape.points[2].x) / 2,
                y: (shape.points[0].y + shape.points[2].y) / 2 };
            const rotation = ((-Math.atan2(shape.points[1].y - shape.points[0].y,
                shape.points[1].x - shape.points[0].x) * 180 / Math.PI) % 360 + 360) % 360;
            rotationDrag = { before: shapeSnapshot(shape), points: shape.points.map(point => ({ ...point })),
                center, start: { ...worldPos }, rotation };
            app._rotationHandleDrag = true;
            schedulePictureCopperRefresh(app, shape);
            return true;
        },
        updateAnchorDrag(worldPos) {
            if (!rotationDrag) return handleBoardShapeDrag(app, worldPos);
            const { center, start, rotation, points } = rotationDrag;
            const next = pointerRotation(center, start, worldPos, rotation);
            shape.points = rotatedImagePoints(points, center, next - rotation);
            schedulePictureCopperRefresh(app, shape);
            renderBoardShape(app, shape, { liveDrag: true });
            const input = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropImageRot'));
            if (input) input.value = String(Math.round(next) % 360);
        },
        endAnchorDrag(commit, options = {}) {
            if (rotationDrag) {
                const before = rotationDrag.before;
                const after = shapeSnapshot(shape);
                rotationDrag = null;
                app._rotationHandleDrag = false;
                applyShapeSnapshot(shape, before);
                schedulePictureCopperRefresh(app, shape);
                if (commit && JSON.stringify(before) !== JSON.stringify(after)) {
                    app.history.execute(new ModifyBoardShapeCommand(app, shape, before, after));
                } else {
                    renderBoardShape(app, shape, { liveDrag: true });
                    showBoardShapeProperties(app, shape);
                }
                return;
            }
            const drag = app._shapeDrag;
            if (commit && drag && !options.moved && !options.place
                && typeof drag.sourceAnchorId === 'number'
                && ['line', 'rect', 'polygon'].includes(shape.kind)) {
                app._selectedBoardShapeSegment = null;
                app._selectedBoardShapeNode = { shapeId: shape.id, index: drag.sourceAnchorId };
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
            selectedSegment: () => app._selectedBoardShapeSegment?.shapeId === shape.id ? app._selectedBoardShapeSegment.segment : null,
            selectSegment: segment => {
                app._selectedBoardShapeNode = null;
                app._selectedBoardShapeSegment = { shapeId: shape.id, segment };
                renderBoardShape(app, shape);
                renderBoardShapeSegmentSelection(app);
                showBoardShapeProperties(app, shape);
            },
            begin: (point, segment) => {
                app._selectedBoardShapeNode = null;
                return startBoardShapeDrag(app, shape, point, null, { whole: true, allowSegment: segment != null });
            },
            update: point => handleBoardShapeDrag(app, point),
            end: commit => endBoardShapeDrag(app, commit),
        }),
        anchorColor: shapeSelectionColor(shape),
        getPosition() {
            const bounds = boardShapeBounds(shape);
            return { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
        },
        invalidate() { renderBoardShape(app, shape); },
        render() { renderBoardShape(app, shape); },
    };
}

registerPcbSelectionAdapter('shape', createBoardShapeSelectionAdapter);

/** Draw the resize handles for the selected shape on the overlay layer. */
export function renderBoardShapeHandles(app, shape) {
    if (!shape || isLayerLocked(shape.layer) || !isLayerVisible(shape.layer)) return;
    const selectedNode = app._selectedBoardShapeNode;
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
    const overlay = app._getLayerGroup?.('selection-overlay');
    if (!overlay) return;
    for (const element of [...overlay.querySelectorAll('.pcb-shape-segment-selection')]) element.remove();
    const selected = app._selectedBoardShapeSegment;
    const shape = selected && app.boardShapes?.find(shape => shape.id === selected.shapeId);
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
    return snapPathPoint(app, worldPos, neighbours, true, pathContinuationConstraints(points, closed, index, bulges));
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
function collapseCollinearPolylinePoints(shape) {
    return collapseCollinearPath(shape, index => boardShapeSegmentWidth(shape, index));
}

export function remapBoardShapeNodeRadii(shape, index, delta) {
    remapPathNodes(shape, index, delta);
}

export function splitBoardShapeSegmentMetadata(shape, segment) {
    splitPathSegmentMetadata(shape, segment);
}

export function deleteSelectedBoardShape(app) {
    const s = getPcbSelection(app, 'shape')[0] || null;
    if (!s) return false;
    if (s.layer === 'board-outline') return false;
    if (isLayerLocked(s.layer)) return false;
    app.history.execute(new RemoveBoardShapeCommand(app, s));
    selectBoardShape(app, null);
    app._clearProperties?.();
    return true;
}

export function setBoardShapeSegmentType(app, shape, segment, type, { floating = false } = {}) {
    const standalone = shape?.kind === 'arc' || (shape?.kind === 'line' && shape.points?.length === 2);
    const count = shape?.kind === 'line' ? shape.points?.length - 1
        : ['polygon', 'rect'].includes(shape?.kind) ? shape.points?.length : shape?.kind === 'arc' ? 1 : 0;
    if (!Number.isInteger(segment) || segment < 0 || segment >= count
        || !['line', 'arc'].includes(type) || isLayerLocked(shape.layer)) return false;
    const before = shapeSnapshot(shape);
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
        applyShapeSnapshot(shape, before);
        return false;
    }
    const merged = type === 'line' && collapseCollinearPolylinePoints(shape);
    const after = shapeSnapshot(shape);
    applyShapeSnapshot(shape, before);
    app._selectedBoardShapeSegment = merged ? null : { shapeId: shape.id, segment };
    app._selectedBoardShapeNode = null;
    if (floating && type === 'arc') {
        applyShapeSnapshot(shape, after);
        const adapter = createBoardShapeSelectionAdapter(app, shape, shape.id);
        const anchorId = shape.kind === 'arc' ? 'bulge' : `bulge:${segment}`;
        const anchor = adapter.getAnchors().find(item => item.id === anchorId);
        if (!anchor || !beginPcbAnchorInteraction(app, adapter, anchor, anchor, true)) {
            applyShapeSnapshot(shape, before);
            renderBoardShape(app, shape);
            renderBoardShapeHandles(app, shape);
            renderBoardShapeSegmentSelection(app);
            return false;
        }
        app._shapeDrag.beforeState = before;
        app._shapeDrag.before = before.geom;
    } else app.history.execute(new ModifyBoardShapeCommand(app, shape, before, after));
    showBoardShapeProperties(app, shape);
    renderBoardShapeHandles(app, shape);
    renderBoardShapeSegmentSelection(app);
    return true;
}

// ── Drag (move whole shape) ──────────────────────────────────────────────────

export function startBoardShapeDrag(app, shape, worldPos, anchorId = null, options = {}) {
    if (!shape || isLayerLocked(shape.layer)) return false;
    const before = cloneShapeGeometry(shape);
    const beforeState = shapeSnapshot(shape);
    let handle = anchorId != null ? anchorId : options.whole ? null : hitTestBoardShapeVertex(app, shape, worldPos);
    const midpointMatch = typeof anchorId === 'string' ? /^mid:(\d+)$/.exec(anchorId) : null;
    if (midpointMatch) app._selectedBoardShapeNode = null;
    let mode = handle != null ? 'vertex' : 'move';
    let segment = null;
    if (['line', 'polygon', 'rect'].includes(shape.kind) && midpointMatch) {
        segment = Number(midpointMatch[1]);
        if (segment >= 0 && segment < shape.points.length) {
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
            app._selectedBoardShapeSegment = { shapeId: shape.id, segment };
        }
    }
    const bulgeMatch = typeof handle === 'string' ? /^bulge:(\d+)$/.exec(handle) : null;
    if (bulgeMatch || shape.kind === 'arc' && handle === 'bulge') {
        app._selectedBoardShapeNode = null;
        app._selectedBoardShapeSegment = { shapeId: shape.id, segment: bulgeMatch ? Number(bulgeMatch[1]) : 0 };
        showBoardShapeProperties(app, shape);
    } else if (mode !== 'segment') app._selectedBoardShapeSegment = null;
    renderBoardShapeSegmentSelection(app);
    const net = String(shape.net || '');
    const ratsnestNets = net
        && (shape.layer === 'top-copper' || shape.layer === 'bottom-copper')
        && normalizeShapeCopperMode(shape.copperMode) === 'add'
        ? new Set([net])
        : null;
    app._shapeDrag = {
        id: shape.id,
        mode,
        handle,
        segment,
        vertexBefore: cloneShapeGeometry(shape),
        startWorld: { x: worldPos.x, y: worldPos.y },
        before,
        beforeState,
        sourceAnchorId: anchorId,
        ratsnestNets,
        previousDeferDragOverlays: !!app._deferDragOverlays,
    };
    app._setPcbStatus?.();
    app._deferDragOverlays = true;
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
    const s = app.boardShapes.find((x) => x.id === d.id);
    if (!s) return;
    if (d.mode === 'vertex' || d.mode === 'segment') schedulePictureCopperRefresh(app, s);
    if (d.mode === 'vertex') {
        const polylineDrag = (['line', 'polygon'].includes(d.beforeState.kind) && typeof d.handle === 'number')
            || (typeof d.sourceAnchorId === 'string' && d.sourceAnchorId.startsWith('mid:'));
        const editingSegmentBulge = typeof d.handle === 'string' && d.handle.startsWith('bulge:');
        const editingArcEndpoint = s.kind === 'arc' && (d.handle === 'start' || d.handle === 'end');
        let snap = editingSegmentBulge ? snapPathPoint(app, worldPos, [], true) : polylineDrag && typeof d.handle === 'number'
            ? polygonVertexSnap(app, d.vertexBefore || d.before, d.handle, worldPos, d.beforeState.kind !== 'line',
                app._snapActive?.() ?? app.viewport?.snapToGrid !== false, s.segmentBulges || [])
            : editingArcEndpoint
                ? polygonVertexSnap(app, { points: [d.before.start, d.before.end] }, d.handle === 'start' ? 0 : 1,
                    worldPos, false, app._snapActive?.() ?? app.viewport?.snapToGrid !== false)
            : d.beforeState.kind === 'rect' && typeof d.handle === 'number'
                ? snapPathPoint(app, worldPos, [d.before.points[(d.handle + 2) % 4]], true)
            : snapPathPoint(app, worldPos, d.before.points || [], true);
        if (!app.viewport?.shiftHeld && (editingSegmentBulge || s.kind === 'arc' && d.handle === 'bulge')) {
            const segment = editingSegmentBulge ? Number(d.handle.slice(6)) : null;
            const start = segment == null ? s.start : s.points[segment];
            const end = segment == null ? s.end : s.points[(segment + 1) % s.points.length];
            snap = snapArcBulgeToChord(start, end, worldPos, snap, 8 / Math.max(0.01, app.viewport?.scale || 1));
        }
        if (polylineDrag) {
            s.points = d.vertexBefore.points.map((point, index) => index === d.handle ? { ...snap } : { ...point });
            s.kind = d.beforeState.kind === 'line' ? 'line' : 'polygon';
        } else {
            applyBoardShapeVertexResize(s, d, snap);
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
        if (d.ratsnestNets) app._updateRatsnest?.({ nets: d.ratsnestNets });
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
        if (d.ratsnestNets) app._updateRatsnest?.({ nets: d.ratsnestNets });
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
    if (d.ratsnestNets) app._updateRatsnest?.({ nets: d.ratsnestNets });
}

export function endBoardShapeDrag(app, commit) {
    const d = app._shapeDrag;
    app._shapeDrag = null;
    app._setPcbStatus?.();
    app.viewport?.hideCrosshair();
    clearPolygonAxisIndicators(app);
    if (!d) return;
    app._deferDragOverlays = d.previousDeferDragOverlays;
    const s = app.boardShapes.find((x) => x.id === d.id);
    if (d.mode === 'vertex' || d.mode === 'segment') schedulePictureCopperRefresh(app, s);
    if (!s) return;
    if (d.splitBeforeState) {
        const first = s.points[0];
        const last = d.splitOrigin || s.points.at(-1);
        if (Math.hypot(first.x - last.x, first.y - last.y) < 1e-9) commit = false;
        d.beforeState = d.splitBeforeState;
        d.before = d.splitBeforeState.geom;
        if (!commit) app._selectedBoardShapeNode = null;
        if (d.splitRemainder) {
            const remainderIndex = app.boardShapes.indexOf(d.splitRemainder);
            if (remainderIndex >= 0) app.boardShapes.splice(remainderIndex, 1);
            removeBoardShapeElement(app, d.splitRemainder.id);
        }
    }
    const target = d.splitBeforeState ? null : d.joinTarget?.shape;
    if (commit && s.kind === 'line' && target && app.boardShapes.includes(target)) {
        const merged = mergeBoardLines(app, s, d.handle, target, d.joinTarget.endpoint);
        applyShapeSnapshot(s, d.beforeState);
        renderBoardShape(app, s);
        selectBoardShape(app, null);
        app.history.execute(new CompoundCommand([
            new RemoveBoardShapeCommand(app, s),
            new RemoveBoardShapeCommand(app, target),
            new AddBoardShapeCommand(app, merged),
        ]));
        selectBoardShape(app, merged);
        return;
    }
    const closedOpenLine = d.beforeState.kind === 'line' && s.kind !== 'line';
    const bulgeHandle = typeof d.handle === 'string' ? /^bulge:(\d+)$/.exec(d.handle) : null;
    if ((d.mode === 'vertex' || d.mode === 'segment') && !closedOpenLine && !bulgeHandle && !d.splitBeforeState
        && JSON.stringify(cloneShapeGeometry(s)) !== JSON.stringify(d.before)) {
        collapseCollinearPolylinePoints(s);
    }
    if (commit && d.mode === 'vertex') normalizeStraightArc(s, bulgeHandle ? Number(bulgeHandle[1]) : null);
    const after = cloneShapeGeometry(s);
    const afterState = shapeSnapshot(s);
    const moved = JSON.stringify(afterState) !== JSON.stringify(d.beforeState);
    // Roll back first, then commit through history so undo is exact.
    if (d.mode === 'move') applyShapeGeometry(s, d.before);
    else applyShapeSnapshot(s, d.beforeState);
    renderBoardShape(app, s);
    if (!moved || !commit) {
        if (d.splitBeforeState || !commit) showBoardShapeProperties(app, s);
        renderBoardShapeHandles(app, s);
        renderBoardShapeSegmentSelection(app);
        syncCircleDiameterProperty(app, s);
        syncShapeBulgeProperty(app, s);
        cancelPictureCopperRefresh(app);
        app._refreshFills?.();
        return;
    }
    const kindChanged = afterState.kind !== d.beforeState.kind;
    const segmentWidthsChanged = JSON.stringify(afterState.segmentWidths || {})
        !== JSON.stringify(d.beforeState.segmentWidths || {});
    const segmentBulgesChanged = JSON.stringify(afterState.segmentBulges || {})
        !== JSON.stringify(d.beforeState.segmentBulges || {});
    const topologyChanged = after.points?.length !== d.before.points?.length;
    const command = d.splitBeforeState || kindChanged || topologyChanged || segmentWidthsChanged || segmentBulgesChanged
        ? new ModifyBoardShapeCommand(app, s, d.beforeState, afterState)
        : new MoveBoardShapeCommand(app, s, d.before, after);
    app.history.execute(d.splitRemainder ? new CompoundCommand([command, new AddBoardShapeCommand(app, d.splitRemainder)]) : command);
    renderBoardShapeHandles(app, s);
    renderBoardShapeSegmentSelection(app);
    syncCircleDiameterProperty(app, s);
    syncShapeBulgeProperty(app, s);
}

/** Split a closed shape at a node and float one of the coincident endpoints. */
export function openBoardShape(app, shape, vertexIndex = 0) {
    if (shape?.layer === 'board-outline') return false;
    if (!shape || !['line', 'polygon', 'rect'].includes(shape.kind) || isLayerLocked(shape.layer)) return false;
    const points = shape.points || [];
    if (points.length < 3) return false;
    const before = shapeSnapshot(shape);
    const start = Math.max(0, Math.min(points.length - 1, Math.trunc(Number(vertexIndex) || 0)));
    const split = splitPathAtNode(shape, start);
    if (!split) return false;
    const remainder = split.remainder;
    if (remainder) remainder.id = `pshape_${app._shapeIdCounter++}`;
    Object.assign(shape, split.moving);
    if (remainder) { app.boardShapes.push(remainder); renderBoardShape(app, remainder); }
    selectBoardShape(app, shape);
    const adapter = createBoardShapeSelectionAdapter(app, shape, shape.id);
    if (!beginPathSplit(app, adapter, 0, () => {
        Object.assign(app._shapeDrag, { splitBeforeState: before, splitRemainder: remainder, splitOrigin: { ...points[start] } });
    })) {
        if (remainder) {
            app.boardShapes.splice(app.boardShapes.indexOf(remainder), 1);
            removeBoardShapeElement(app, remainder.id);
        }
        applyShapeSnapshot(shape, before);
        app._selectedBoardShapeNode = null;
        renderBoardShape(app, shape);
        showBoardShapeProperties(app, shape);
        return false;
    }
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
        ...parts.map(part => new AddBoardShapeCommand(app, part))]));
    return true;
}

export function deleteFocusedBoardShape(app) {
    const selected = getPcbSelection(app, 'shape');
    if (selected.length !== 1 || getPcbSelection(app).length !== 1) return false;
    const shape = selected[0];
    const node = app._selectedBoardShapeNode?.shapeId === shape.id ? app._selectedBoardShapeNode.index : null;
    const segment = app._selectedBoardShapeSegment?.shapeId === shape.id ? app._selectedBoardShapeSegment.segment : null;
    if (node == null && segment == null) return false;
    if (app._shapeDrag) {
        const splitting = !!app._shapeDrag.splitBeforeState;
        endBoardShapeDrag(app, false);
        app._pcbSelectionInteraction = null;
        if (splitting) {
            app._selectedBoardShapeNode = null;
            app._selectedBoardShapeSegment = null;
            showBoardShapeProperties(app, shape);
            return true;
        }
    }
    if (node != null) deleteBoardShapeVertex(app, shape, node);
    else deleteBoardShapeSegment(app, shape, segment);
    app._selectedBoardShapeNode = null;
    app._selectedBoardShapeSegment = null;
    app._refreshPcbSelectionHighlights?.();
    return true;
}

/** Delete a polyline vertex; a triangle reduces to an open two-point Line. */
export function deleteBoardShapeVertex(app, shape, vertexIndex) {
    if (!shape || !['line', 'polygon', 'rect'].includes(shape.kind) || isLayerLocked(shape.layer)) return false;
    const points = shape.points || [];
    if (shape.layer === 'board-outline' && points.length <= 3) return false;
    if (!Number.isInteger(vertexIndex) || vertexIndex < 0 || vertexIndex >= points.length) return false;
    if (shape.kind === 'line' && points.length <= 2) {
        setPcbSelection(app, []);
        app.history.execute(new RemoveBoardShapeCommand(app, shape));
        return true;
    }
    const before = shapeSnapshot(shape);
    deletePathVertex(shape, vertexIndex);
    normalizeBoardPolylineKind(shape);
    const after = shapeSnapshot(shape);
    applyShapeSnapshot(shape, before);
    app.history.execute(new ModifyBoardShapeCommand(app, shape, before, after));
    app._selectedBoardShapeNode = null;
    app._selectedBoardShapeSegment = null;
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
    app._selectedBoardShapeNode = node ? { shapeId: shape.id, index: vertexIndex } : null;
    app._selectedBoardShapeSegment = segmentIndex != null ? { shapeId: shape.id, segment: segmentIndex } : null;
    const curved = shape.kind === 'arc' || !!boardShapeSegmentBulge(shape, segmentIndex);
    const remove = () => {
        setPcbSelection(app, []);
        app.history.execute(new RemoveBoardShapeCommand(app, shape));
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

/** Shapes follow the active edit layer; redirect non-graphic layers to silk. */
export function resolveShapeDrawLayer(app, layerId) {
    const id = String(layerId || 'top-copper');
    if (id === 'top-paste' || id === 'bottom-paste' || id === 'board-outline') {
        return id.startsWith('bottom-') ? 'bottom-silk' : 'top-silk';
    }
    return id;
}

function makePreview(app) {
    const preview = document.createElementNS(NS, 'path');
    preview.setAttribute('class', 'pcb-shape-preview');
    preview.setAttribute('stroke', 'var(--sch-symbol-outline, #ffffff)');
    preview.setAttribute('stroke-width', '1');
    preview.setAttribute('opacity', '0.6');
    preview.setAttribute('vector-effect', 'non-scaling-stroke');
    preview.setAttribute('stroke-linejoin', 'round');
    app._getLayerGroup('selection-overlay')?.appendChild(preview);
    return preview;
}

function shapeDrawSnap(app, worldPos) {
    const draw = app._shapeDraw;
    if (draw?.kind === 'arc' && draw.points.length === 2) return worldPos;
    const previous = draw?.points.at(-1);
    const continuations = draw && ['line', 'polygon'].includes(draw.kind)
        ? pathContinuationConstraints([...draw.points, worldPos], false, draw.points.length) : [];
    return snapPathPoint(app, worldPos, previous ? [previous] : [], true, continuations);
}

/** Left-click while a shape tool is active. */
export function shapeDrawClick(app, kind, worldPos) {
    if (!SHAPE_KINDS.has(kind) || kind === 'image') return;
    const snap = shapeDrawSnap(app, worldPos);
    if (!app._shapeDraw || app._shapeDraw.kind !== kind) {
        const layer = resolveShapeDrawLayer(app, app.activeLayer);
        if (isLayerLocked(layer)) return;
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
    const dstr = shapePreviewPath(d.kind, d.points, p, app._shapeDefaults?.cornerRadius);
    d.preview?.setAttribute('d', dstr);
    const geometry = shapeFromPoints(d.kind, [...d.points, p], true);
    const lineWidth = normalizedBoardShapeLineWidth({ kind: d.kind, layer: d.layer }, app._shapeDefaults?.lineWidth);
    const indicators = geometry?.points
        ? d.kind === 'rect' ? boardSquareIndicators({ ...geometry, layer: d.layer, lineWidth })
            : pathAlignmentSegments(geometry.points, d.kind !== 'line', [geometry.points.length - 1],
                geometry.points.map(() => lineWidth)).map(segment => ({ ...segment, layerId: d.layer }))
        : [];
    renderAxisGlow(app, indicators);
    if (d.preview) {
        const st = shapeStyle({
            layer: d.layer,
            filled: !!app._shapeDefaults?.filled,
            copperMode: app._shapeDefaults?.copperMode,
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
            app._shapeDefaults?.lineWidth,
        ),
        filled: d.kind === 'line' ? false : alwaysFilled || !!app._shapeDefaults?.filled,
        copperMode: normalizeShapeCopperMode(app._shapeDefaults?.copperMode),
        plated: layer === 'hole' && !!app._shapeDefaults?.plated,
        net: layer === 'top-copper' || layer === 'bottom-copper'
            ? String(app._shapeDefaults?.net || '')
            : '',
        cornerRadius: d.kind === 'rect' ? Math.max(0, Number(app._shapeDefaults?.cornerRadius) || 0) : undefined,
    };

    const geometry = shapeFromPoints(d.kind, d.points);
    if (!geometry) return;
    const shape = { ...base, ...geometry, filled: d.kind === 'arc' ? false : base.filled };
    if ('points' in shape && canConvertBoardLineToTrack(shape)) {
        // A named copper Line is routing intent, so enter the Track model
        // directly instead of creating a transient generic shape first.
        const track = new Track({
            net: String(shape.net).trim(),
            width: Math.max(0.05, Number(shape.lineWidth) || 0.2),
            layer: shape.layer,
            points: shape.points.map((point) => ({ x: point.x, y: point.y })),
            sourceBoardShape: sourceBoardShapeForTrack(shape),
        });
        app.history.execute(new AddTrackCommand(app, track));
        setPcbSelection(app, [{ kind: 'track', object: track }]);
        app._refreshPcbSelectionHighlights?.();
        return;
    }
    app.history.execute(new AddBoardShapeCommand(app, shape));
}

// ── Properties panel ─────────────────────────────────────────────────────────

const PROP_HIDDEN_LAYERS = new Set([
    'top-paste', 'bottom-paste',
    'top-mask', 'bottom-mask',
    'board-outline',
]);

function boardNetNames(app) {
    const netNames = new Set((app.netlist || []).map((entry) => String(entry.net || '')).filter(Boolean));
    for (const source of [app.tracks, app.vias, app.boardShapes, app.copperFills]) {
        for (const item of source || []) {
            const net = String(item?.net || '');
            if (net) netNames.add(net);
        }
    }
    return [...netNames].sort();
}

function netOptions(app, current = '') {
    const names = boardNetNames(app);
    const selected = String(current || '');
    return `<button type="button" data-net="">None</button>${names.map((name) =>
        `<button type="button" data-net="${name.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"${name === selected ? ' aria-current="true"' : ''}>${name.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</button>`
    ).join('')}`;
}

function syncNetMenuSelection(menu, input) {
    if (!menu || !input) return;
    const current = input.value.trim();
    for (const option of menu.querySelectorAll('button[data-net]')) {
        option.toggleAttribute('aria-current', option.dataset.net === current);
    }
}

/** Snapshot of everything ModifyBoardShapeCommand can change. */
function shapeSnapshot(shape) {
    return {
        kind: shape.kind,
        ...(shape.kind === 'image' ? { artwork: shape.artwork } : {}),
        geom: cloneShapeGeometry(shape),
        cornerRadius: shape.kind === 'rect' ? rectCornerRadius(shape) : polygonCornerRadius(shape),
        nodeCornerRadii: { ...(shape.nodeCornerRadii || {}) },
        layer: shape.layer,
        lineWidth: Math.max(0.05, Number(shape.lineWidth) || 0.2),
        segmentWidths: { ...(shape.segmentWidths || {}) },
        segmentBulges: { ...(shape.segmentBulges || {}) },
        filled: !!shape.filled,
        copperMode: normalizeShapeCopperMode(shape.copperMode),
        plated: !!shape.plated,
        net: String(shape.net || ''),
    };
}

/**
 * Show Properties-tab controls for the active board-shape tool. These edit
 * creation defaults (and an unfinished draw), rather than a saved shape.
 * @param {object} app
 * @param {'line'|'circle'|'rect'|'polygon'|'arc'} kind
 */
export function showBoardShapeToolProperties(app, kind) {
        const items = app._pcbPropsItems?.();
        if (!items) return;
        const defaults = app._shapeDefaults || (app._shapeDefaults = { lineWidth: 0.2 });
        const currentLayer = resolveShapeDrawLayer(app, app._shapeDraw?.layer || app.activeLayer);
        const layerOptionsHtml = PCB_LAYERS
            .filter((layer) => !PROP_HIDDEN_LAYERS.has(layer.id))
            .map((layer) => `<option value="${layer.id}"${layer.id === currentLayer ? ' selected' : ''}>${layer.name}</option>`)
            .join('');
        const initialCopperMode = normalizeShapeCopperMode(defaults.copperMode);
        const initialNet = String(defaults.net || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
        const toolNetOptions = netOptions(app, defaults.net);
        const showFill = currentLayer !== 'hole' && kind !== 'line';
        const showLineWidth = currentLayer !== 'hole' || kind === 'line';
        const lineWidthMinimum = boardShapeLineWidthMinimum({ kind, layer: currentLayer });
        const toolLineWidth = normalizedBoardShapeLineWidth(
            { kind, layer: currentLayer },
            defaults.lineWidth,
        );

        app._setPcbPropsTitle?.(`New ${shapeKindLabel(kind)}`);
        items.innerHTML = `
            <div class="prop-row"><label>Layer</label><select id="pcbToolShapeLayer">${layerOptionsHtml}</select></div>
            ${showFill ? `<label class="prop-row prop-toggle"><input type="checkbox" id="pcbToolShapeFilled"${defaults.filled ? ' checked' : ''}><span>Fill</span></label>` : ''}
            ${currentLayer === 'hole' ? `<label class="prop-row prop-toggle"><input type="checkbox" id="pcbToolShapePlated"${defaults.plated ? ' checked' : ''}><span>Plated</span></label>` : ''}
            <div class="prop-row" id="pcbToolShapeCopperModeRow"><label>Copper Mode</label><select id="pcbToolShapeCopperMode"><option value="add"${initialCopperMode === 'add' ? ' selected' : ''}>Add Copper</option><option value="remove-copper"${initialCopperMode === 'remove-copper' ? ' selected' : ''}>Remove Copper</option><option value="remove-solder-mask"${initialCopperMode === 'remove-solder-mask' ? ' selected' : ''}>Remove Solder Mask</option><option value="remove-copper-mask"${initialCopperMode === 'remove-copper-mask' ? ' selected' : ''}>Remove Copper + Mask</option></select></div>
            <div class="prop-row" id="pcbToolShapeNetRow"><label>Net</label><span class="prop-net-control"><input type="text" id="pcbToolShapeNet" value="${initialNet}" placeholder="None"><details class="prop-net-menu"><summary aria-label="Select existing net"></summary><div>${toolNetOptions}</div></details></span></div>
            ${kind === 'rect' ? `<div class="prop-row"><label>Corner Radius (mm)</label><input type="number" id="pcbToolShapeCornerRadius" min="0" max="25" step="0.5" value="${Math.max(0, Number(defaults.cornerRadius) || 0).toFixed(2)}"></div>` : ''}
            ${showLineWidth ? `<div class="prop-row" id="pcbToolShapeLineWidthRow"><label>Width (mm)</label><input type="number" id="pcbToolShapeLineWidth" min="${lineWidthMinimum}" step="0.05" value="${toolLineWidth.toFixed(2)}"></div>` : ''}
        `;

        const lineEl = /** @type {HTMLInputElement|null} */ (items.querySelector('#pcbToolShapeLineWidth'));
        const lineRowEl = /** @type {HTMLDivElement|null} */ (items.querySelector('#pcbToolShapeLineWidthRow'));
    const cornerRadiusEl = /** @type {HTMLInputElement|null} */ (items.querySelector('#pcbToolShapeCornerRadius'));
        const filledEl = /** @type {HTMLInputElement|null} */ (items.querySelector('#pcbToolShapeFilled'));
        const platedEl = /** @type {HTMLInputElement|null} */ (items.querySelector('#pcbToolShapePlated'));
        const layerEl = /** @type {HTMLSelectElement|null} */ (items.querySelector('#pcbToolShapeLayer'));
        const copperModeRowEl = /** @type {HTMLDivElement|null} */ (items.querySelector('#pcbToolShapeCopperModeRow'));
        const copperModeEl = /** @type {HTMLSelectElement|null} */ (items.querySelector('#pcbToolShapeCopperMode'));
        const netRowEl = /** @type {HTMLDivElement|null} */ (items.querySelector('#pcbToolShapeNetRow'));
        const netEl = /** @type {HTMLInputElement|null} */ (items.querySelector('#pcbToolShapeNet'));
        const netMenuEl = /** @type {HTMLDetailsElement|null} */ (items.querySelector('.prop-net-menu'));
        const syncAvailability = () => {
            if (!layerEl || !copperModeEl || !copperModeRowEl) return;
            const copper = layerEl.value === 'top-copper' || layerEl.value === 'bottom-copper';
            copperModeRowEl.style.display = copper ? '' : 'none';
            copperModeEl.disabled = !copper;
            if (netRowEl) netRowEl.style.display = copper && copperModeEl.value === 'add' ? '' : 'none';
            if (lineRowEl) lineRowEl.style.display = filledEl?.checked ? 'none' : '';
        };

        lineEl?.addEventListener('input', () => {
            defaults.lineWidth = normalizedBoardShapeLineWidth(
                { kind, layer: layerEl?.value || currentLayer },
                lineEl.value,
            );
            if (Number(lineEl.value) < defaults.lineWidth) lineEl.value = defaults.lineWidth.toFixed(2);
            updateShapeDrawPreview(app, app._lastCrosshairWorld || app._shapeDraw?.points.at(-1));
        });
        cornerRadiusEl?.addEventListener('input', () => {
            defaults.cornerRadius = Math.min(25, Math.max(0, Number(cornerRadiusEl.value) || 0));
            cornerRadiusEl.value = defaults.cornerRadius.toFixed(2);
            updateShapeDrawPreview(app, app._lastCrosshairWorld || app._shapeDraw?.points.at(-1));
        });
        filledEl?.addEventListener('change', () => {
            defaults.filled = !!filledEl.checked;
            updateShapeDrawPreview(app, app._lastCrosshairWorld || app._shapeDraw?.points.at(-1));
            syncAvailability();
        });
        platedEl?.addEventListener('change', () => {
            defaults.plated = !!platedEl.checked;
        });
        netEl?.addEventListener('change', () => {
            defaults.net = netEl.value.trim();
        });
        netMenuEl?.addEventListener('click', (event) => {
            const option = /** @type {HTMLButtonElement|null} */ (event.target instanceof Element ? event.target.closest('button[data-net]') : null);
            if (!option || !netEl) return;
            netEl.value = option.dataset.net || '';
            netEl.dispatchEvent(new Event('change'));
            netMenuEl.open = false;
        });
        netMenuEl?.addEventListener('toggle', () => {
            if (netMenuEl.open) syncNetMenuSelection(netMenuEl, netEl);
        });
        layerEl?.addEventListener('change', () => {
            const next = resolveShapeDrawLayer(app, layerEl.value);
            if (isLayerLocked(next)) {
                layerEl.value = app._shapeDraw?.layer || app.activeLayer;
                syncAvailability();
                return;
            }
            app.activeLayer = next;
            app._setPcbStatus?.();
            if (app._shapeDraw?.kind === kind) app._shapeDraw.layer = next;
            updateShapeDrawPreview(app, app._lastCrosshairWorld || app._shapeDraw?.points.at(-1));
            syncAvailability();
            showBoardShapeToolProperties(app, kind);
        });
        copperModeEl?.addEventListener('change', () => {
            defaults.copperMode = normalizeShapeCopperMode(copperModeEl.value);
            updateShapeDrawPreview(app, app._lastCrosshairWorld || app._shapeDraw?.points.at(-1));
        });
        syncAvailability();
        app._setActiveRibbonTab?.('pcb-properties');
}

/** Write a full snapshot back onto a shape (used by ModifyBoardShapeCommand). */
export function applyShapeSnapshot(shape, state) {
    if (state.kind) shape.kind = state.kind;
    if (shape.kind === 'image' && state.artwork) shape.artwork = state.artwork;
    applyShapeGeometry(shape, state.geom);
    if (['line', 'rect', 'polygon'].includes(shape.kind)) {
        shape.cornerRadius = Math.max(0, Number(state.cornerRadius) || 0);
        shape.nodeCornerRadii = { ...(state.nodeCornerRadii || {}) };
    }
    shape.layer = state.layer;
    shape.lineWidth = state.lineWidth;
    shape.segmentWidths = { ...(state.segmentWidths || {}) };
    shape.segmentBulges = { ...(state.segmentBulges || {}) };
    shape.filled = !!state.filled;
    shape.copperMode = normalizeShapeCopperMode(state.copperMode);
    shape.plated = !!state.plated;
    shape.net = String(state.net || '');
}

function showImageProperties(app, shape, items) {
    app._setPcbPropsTitle?.('Image');
    const width = Math.hypot(shape.points[1].x - shape.points[0].x, shape.points[1].y - shape.points[0].y);
    const height = Math.hypot(shape.points[3].x - shape.points[0].x, shape.points[3].y - shape.points[0].y);
    const rotation = ((-Math.atan2(shape.points[1].y - shape.points[0].y,
        shape.points[1].x - shape.points[0].x) * 180 / Math.PI) % 360 + 360) % 360;
    const layers = PCB_LAYERS.filter(layer => PICTURE_LAYERS.includes(layer.id));
    const names = [...new Set([...boardNetNames(app), String(shape.net || '')])].filter(Boolean).sort();
    const imageNetOptions = names.map(name => {
        const escaped = name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
        return `<option value="${escaped}">${escaped}</option>`;
    }).join('');
    items.innerHTML = `
        <div class="prop-row"><label>Layer</label><select id="pcbPropImageLayer">${layers.map(layer =>
            `<option value="${layer.id}"${layer.id === shape.layer ? ' selected' : ''}${isLayerLocked(layer.id) ? ' disabled' : ''}>${layer.name}</option>`).join('')}</select></div>
        <div class="prop-row"><label>Width (mm)</label><input id="pcbPropImageWidth" type="number" min="0.1" max="500" step="0.1" value="${width.toFixed(2)}"></div>
        <div class="prop-row"><label>Height (mm)</label><input id="pcbPropImageHeight" type="number" min="0.1" max="500" step="0.1" value="${height.toFixed(2)}"></div>
        <div class="prop-row"><label>Rotation (°)</label><input id="pcbPropImageRot" type="number" step="1" data-number-format="rotation" value="${Math.round(rotation) % 360}"></div>
        <div class="prop-row"><label for="pcbPropImageInvert">Invert</label><input id="pcbPropImageInvert" type="checkbox"${shape.artwork.invert ? ' checked' : ''}></div>
        <div class="prop-row"><label for="pcbPropImageFlipHorizontal">Flip Horizontal</label><input id="pcbPropImageFlipHorizontal" type="checkbox"${shape.artwork.flipHorizontal ? ' checked' : ''}></div>
        <div class="prop-row"><label for="pcbPropImageFlipVertical">Flip Vertical</label><input id="pcbPropImageFlipVertical" type="checkbox"${shape.artwork.flipVertical ? ' checked' : ''}></div>
        ${shape.layer.endsWith('copper') ? `<div class="prop-row"><label>Net</label><select id="pcbPropImageNet"><option value="">Unassigned</option>${imageNetOptions}</select></div>` : ''}`;
    const commit = mutate => {
        const before = shapeSnapshot(shape);
        mutate();
        const after = shapeSnapshot(shape);
        applyShapeSnapshot(shape, before);
        if (JSON.stringify(before) !== JSON.stringify(after)) app.history.execute(new ModifyBoardShapeCommand(app, shape, before, after));
        else showImageProperties(app, shape, items);
    };
    const layerInput = /** @type {HTMLSelectElement} */ (document.getElementById('pcbPropImageLayer'));
    for (const [id, property] of [
        ['pcbPropImageInvert', 'invert'],
        ['pcbPropImageFlipHorizontal', 'flipHorizontal'],
        ['pcbPropImageFlipVertical', 'flipVertical'],
    ]) {
        const input = /** @type {HTMLInputElement|null} */ (document.getElementById(id));
        input?.addEventListener('change', () => commit(() => {
            shape.artwork = { ...shape.artwork, [property]: input.checked };
        }));
    }
    layerInput?.addEventListener('change', () => {
        if (!PICTURE_LAYERS.includes(layerInput.value) || isLayerLocked(layerInput.value)) return;
        commit(() => { shape.layer = layerInput.value; });
    });
    for (const [id, dimension] of [['pcbPropImageWidth', width], ['pcbPropImageHeight', height]]) {
        const input = /** @type {HTMLInputElement} */ (document.getElementById(String(id)));
        bindPictureRefreshHold(app, input);
        const resizePreview = createBoardShapePropertyPreview(app, [shape], { liveDrag: true });
        bindPropertyPreviewCancel(input, resizePreview, () => showImageProperties(app, shape, items));
        let lastValue = Number(dimension);
        const previewResize = () => {
            const value = input.valueAsNumber;
            const factor = value / Number(dimension);
            if (!Number.isFinite(factor) || value < 0.1 || Math.max(width, height) * factor > 500) return;
            resizePreview.update(before => {
                applyShapeSnapshot(shape, before[0]);
                const center = { x: (shape.points[0].x + shape.points[2].x) / 2, y: (shape.points[0].y + shape.points[2].y) / 2 };
                shape.points = shape.points.map(point => ({ x: center.x + (point.x - center.x) * factor,
                    y: center.y + (point.y - center.y) * factor }));
            });
            lastValue = value;
            const pairedId = id === 'pcbPropImageWidth' ? 'pcbPropImageHeight' : 'pcbPropImageWidth';
            const pairedInput = /** @type {HTMLInputElement} */ (document.getElementById(pairedId));
            if (pairedInput) pairedInput.value = ((id === 'pcbPropImageWidth' ? height : width) * factor).toFixed(2);
        };
        input?.addEventListener('input', previewResize);
        input?.addEventListener('change', () => {
            if (!Number.isFinite(input.valueAsNumber)) {
                resizePreview.cancel();
                showImageProperties(app, shape, items);
                return;
            }
            previewResize();
            input.value = lastValue.toFixed(2);
            if (!resizePreview.commit()) showImageProperties(app, shape, items);
        });
    }
    const rotationInput = /** @type {HTMLInputElement} */ (document.getElementById('pcbPropImageRot'));
    bindPictureRefreshHold(app, rotationInput);
    const rotationPreview = createBoardShapePropertyPreview(app, [shape], { liveDrag: true });
    bindPropertyPreviewCancel(rotationInput, rotationPreview, () => showImageProperties(app, shape, items));
    const previewRotation = () => {
        const value = parseFloat(rotationInput.value);
        if (!Number.isFinite(value)) return;
        const next = ((Math.round(value) % 360) + 360) % 360;
        rotationPreview.update(before => {
            applyShapeSnapshot(shape, before[0]);
            const radians = -(next - rotation) * Math.PI / 180;
            const cosine = Math.cos(radians);
            const sine = Math.sin(radians);
            const center = { x: (shape.points[0].x + shape.points[2].x) / 2,
                y: (shape.points[0].y + shape.points[2].y) / 2 };
            shape.points = shape.points.map(point => ({
                x: center.x + (point.x - center.x) * cosine - (point.y - center.y) * sine,
                y: center.y + (point.x - center.x) * sine + (point.y - center.y) * cosine,
            }));
        });
    };
    rotationInput?.addEventListener('input', previewRotation);
    rotationInput?.addEventListener('change', () => {
        if (!Number.isFinite(rotationInput.valueAsNumber)) {
            rotationPreview.cancel();
            showImageProperties(app, shape, items);
            return;
        }
        previewRotation();
        if (!rotationPreview.commit()) showImageProperties(app, shape, items);
    });
    const wrapRotation = () => {
        const value = parseFloat(rotationInput.value);
        if (!Number.isFinite(value)) return;
        const wrapped = ((Math.round(value) % 360) + 360) % 360;
        if (wrapped !== value) rotationInput.value = String(wrapped);
    };
    rotationInput?.addEventListener('input', wrapRotation);
    rotationInput?.addEventListener('change', wrapRotation);
    const netInput = /** @type {HTMLSelectElement} */ (document.getElementById('pcbPropImageNet'));
    if (netInput) {
        netInput.value = shape.net || '';
        netInput.addEventListener('change', () => commit(() => { shape.net = netInput.value.trim(); }));
    }
    app._setActiveRibbonTab?.('pcb-properties');
}

export function showBoardShapeProperties(app, shape) {
    const items = app._pcbPropsItems?.();
    if (!items || !shape) return;
    syncPcbSelection(app);
    app._setPcbStatus?.();

    const propertyTargets = () => {
        const selected = getPcbSelection(app, 'shape');
        return selected.length > 0 ? selected : [shape];
    };
    const initialTargets = propertyTargets();
    const outlineTarget = initialTargets.length === 1 && shape.layer === 'board-outline';
    const hasOutline = initialTargets.some(target => target.layer === 'board-outline');
    const outlineBounds = outlineTarget ? boardBoundary(app) : null;
    if (initialTargets.some(target => target.kind === 'image')) {
        if (initialTargets.length === 1) showImageProperties(app, shape, items);
        else {
            app._setPcbPropsTitle?.(`${initialTargets.length} Selected`);
            items.innerHTML = '';
        }
        return;
    }
    const selectedSegment = initialTargets.length === 1
        && app._selectedBoardShapeSegment?.shapeId === shape.id
        ? app._selectedBoardShapeSegment.segment
        : null;
    const selectedNode = initialTargets.length === 1
        && app._selectedBoardShapeNode?.shapeId === shape.id
        && shape.points?.[app._selectedBoardShapeNode.index]
        ? app._selectedBoardShapeNode.index
        : null;
    const mixedKind = initialTargets.some((target) => target.kind !== initialTargets[0].kind);
    const segmentLabel = shape.kind === 'arc' || boardShapeSegmentBulge(shape, selectedSegment) ? 'Arc' : 'Line';
    const standalone = shape.kind === 'arc' || (shape.kind === 'line' && shape.points.length === 2);
    app._setPcbPropsTitle?.(selectedNode != null
        ? `${shapeKindLabel(shape.kind)} Node`
        : selectedSegment != null
            ? `${segmentLabel}${standalone ? '' : ' Segment'}`
        : mixedKind ? 'Mixed' : shapeKindLabel(initialTargets[0].kind));
    const lineWidthMinimum = Math.max(...initialTargets.map((target) => boardShapeLineWidthMinimum(target)));
    const initialLineWidth = selectedSegment == null
        ? normalizedBoardShapeLineWidth(initialTargets[0], initialTargets[0].lineWidth)
        : boardShapeSegmentWidth(shape, selectedSegment);
    const mixedLineWidth = selectedSegment == null && initialTargets.some(
        (target) => Math.abs(normalizedBoardShapeLineWidth(target, target.lineWidth) - initialLineWidth) >= 1e-9,
    );
    const mixedFill = initialTargets.some((target) => !!target.filled !== !!initialTargets[0].filled);
    const allCircleTargets = initialTargets.every((target) => target.kind === 'circle');
    const initialDiameter = allCircleTargets ? circleFilledRadius(initialTargets[0]) * 2 : 0;
    const mixedDiameter = allCircleTargets && initialTargets.some(
        (target) => Math.abs(circleFilledRadius(target) * 2 - initialDiameter) >= 1e-9,
    );
    const diameterMinimum = () => Number(Math.max(...propertyTargets().map(
        (target) => boardShapeLineWidthMinimum(target) + 0.1,
    )).toFixed(6));
    const allRoundedTargets = initialTargets.every((target) => ['line', 'rect', 'polygon'].includes(target.kind));
    const targetCornerRadius = (target) => target.kind === 'rect'
        ? rectCornerRadius(target)
        : polygonCornerRadius(target);
    const initialCornerRadius = targetCornerRadius(shape);
    const mixedCornerRadius = initialTargets.some(
        (target) => Math.abs(targetCornerRadius(target) - initialCornerRadius) >= 1e-9,
    );

    const currentLayer = String(shape.layer || 'top-silk');
    const mixedLayer = initialTargets.some((target) => String(target.layer || 'top-silk') !== currentLayer);
    const holeTargets = initialTargets.filter((target) => target.layer === 'hole');
    const showFill = !hasOutline && initialTargets.every((target) => target.layer !== 'hole' && target.kind !== 'line');
    const showLineWidth = !hasOutline && initialTargets.every(
        (target) => target.layer !== 'hole' || target.kind === 'line',
    );
    const showPlated = initialTargets.every((target) => target.layer === 'hole');
    const mixedPlated = holeTargets.some((target) => !!target.plated !== !!holeTargets[0]?.plated);
    const legacyCurrentOpt = !mixedLayer && PROP_HIDDEN_LAYERS.has(currentLayer)
        ? `<option value="${currentLayer}" selected hidden></option>`
        : '';
    const layerOpts = PCB_LAYERS
        .filter((l) => !PROP_HIDDEN_LAYERS.has(l.id))
        .map((l) => `<option value="${l.id}"${!mixedLayer && l.id === currentLayer ? ' selected' : ''}>${l.name}</option>`);
    const layerOptionsHtml = [legacyCurrentOpt, ...layerOpts].join('');
    const isCopperLayer = (id) => id === 'top-copper' || id === 'bottom-copper';
    const showCopperMode = initialTargets.every((target) => isCopperLayer(target.layer));
    const initialCopperMode = normalizeShapeCopperMode(shape.copperMode);
    const mixedCopperMode = initialTargets.some(
        (target) => normalizeShapeCopperMode(target.copperMode) !== initialCopperMode,
    );
    const initialNet = String(shape.net || '');
    const mixedNet = initialTargets.some((target) => String(target.net || '') !== initialNet);
    const shapeNetOptions = netOptions(app, mixedNet ? '' : initialNet);
    const showNet = showCopperMode && initialTargets.every(
        (target) => normalizeShapeCopperMode(target.copperMode) === 'add',
    );
    const showBulge = initialTargets.length === 1 && selectedNode == null
        && (shape.kind === 'arc' || (selectedSegment != null && boardShapeSegmentBulge(shape, selectedSegment) !== 0));
    const bulgeHtml = showBulge
        ? `<div class="prop-row"><label for="pcbPropShapeBulge">Bulge</label><input type="number" id="pcbPropShapeBulge" min="-1" max="1" step="0.05" value="${formatNumberInputValue(editableShapeBulge(shape, selectedSegment))}"></div>`
        : '';

    items.innerHTML = selectedNode != null
        ? `<div class="prop-row"><label>X (mm)</label><span id="pcbPropShapeNodeX">${formatNumberInputValue(shape.points[selectedNode].x)}</span></div>
                <div class="prop-row"><label>Y (mm)</label><span id="pcbPropShapeNodeY">${formatNumberInputValue(shape.points[selectedNode].y)}</span></div>
                <div class="prop-row"><label>Corner Radius (mm)</label><input type="number" id="pcbPropShapeNodeCornerRadius" min="0" max="25" step="0.5" value="${formatNumberInputValue(boardShapeNodeCornerRadius(shape, selectedNode))}"></div>`
        : selectedSegment != null
        ? `${hasOutline ? '' : `<div class="prop-row" id="pcbPropShapeLineWidthRow"><label>Width (mm)</label><input type="number" id="pcbPropShapeLineWidth" min="${lineWidthMinimum}" step="0.05" value="${initialLineWidth.toFixed(2)}"></div>`}${bulgeHtml}`
        : `
            ${hasOutline ? '' : `<div class="prop-row"><label>Layer</label><select id="pcbPropShapeLayer">${mixedLayer ? '<option value="" selected disabled>Mixed</option>' : ''}${layerOptionsHtml}</select></div>`}
            ${outlineTarget ? `<div class="prop-row"><label>Outline</label><select id="pcbPropOutlineKind">${['rect', 'polygon', 'circle'].map(kind => `<option value="${kind}"${kind === shape.kind ? ' selected' : ''}>${shapeKindLabel(kind)}</option>`).join('')}</select></div>` : ''}
            ${outlineTarget && shape.kind === 'rect' ? `<div class="prop-row"><label>Width (mm)</label><input id="pcbPropOutlineWidth" type="number" min="0.1" step="1" value="${formatNumberInputValue(outlineBounds.w)}"></div><div class="prop-row"><label>Height (mm)</label><input id="pcbPropOutlineHeight" type="number" min="0.1" step="1" value="${formatNumberInputValue(outlineBounds.h)}"></div>` : ''}
            ${showFill ? `<label class="prop-row prop-toggle"><input type="checkbox" id="pcbPropShapeFilled"${shape.filled ? ' checked' : ''}><span>Fill</span></label>` : ''}
            ${showPlated ? `<label class="prop-row prop-toggle"><input type="checkbox" id="pcbPropShapePlated"${!mixedPlated && holeTargets[0]?.plated ? ' checked' : ''}><span>Plated</span></label>` : ''}
            ${showCopperMode ? `<div class="prop-row" id="pcbPropShapeCopperModeRow"><label>Copper Mode</label><select id="pcbPropShapeCopperMode">${mixedCopperMode ? '<option value="" selected disabled>Mixed</option>' : ''}<option value="add"${!mixedCopperMode && initialCopperMode === 'add' ? ' selected' : ''}>Add Copper</option><option value="remove-copper"${!mixedCopperMode && initialCopperMode === 'remove-copper' ? ' selected' : ''}>Remove Copper</option><option value="remove-solder-mask"${!mixedCopperMode && initialCopperMode === 'remove-solder-mask' ? ' selected' : ''}>Remove Solder Mask</option><option value="remove-copper-mask"${!mixedCopperMode && initialCopperMode === 'remove-copper-mask' ? ' selected' : ''}>Remove Copper + Mask</option></select></div>` : ''}
            ${showNet ? `<div class="prop-row"><label>Net</label><span class="prop-net-control"><input type="text" id="pcbPropShapeNet" value="${mixedNet ? '' : initialNet.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" placeholder="${mixedNet ? 'Mixed' : 'None'}"><details class="prop-net-menu"><summary aria-label="Select existing net"></summary><div>${shapeNetOptions}</div></details></span></div>` : ''}
            ${allRoundedTargets ? `<div class="prop-row"><label>Corner Radius (mm)</label><input type="number" id="pcbPropShapeCornerRadius" min="0" max="25" step="0.5" value="${mixedCornerRadius ? '' : initialCornerRadius.toFixed(2)}"${mixedCornerRadius ? ' placeholder="Mixed"' : ''}></div>` : ''}
            ${showLineWidth ? `<div class="prop-row" id="pcbPropShapeLineWidthRow"><label>Width (mm)</label><input type="number" id="pcbPropShapeLineWidth" min="${lineWidthMinimum}" step="0.05" value="${mixedLineWidth ? '' : initialLineWidth.toFixed(2)}"${mixedLineWidth ? ' placeholder="Mixed"' : ''}></div>` : ''}
            ${allCircleTargets ? `<div class="prop-row"><label for="pcbPropShapeDiameter">Outer Diameter (mm)</label><input type="number" id="pcbPropShapeDiameter" min="${diameterMinimum()}" step="0.05" value="${mixedDiameter ? '' : initialDiameter.toFixed(2)}"${mixedDiameter ? ' placeholder="Mixed"' : ''}></div>` : ''}
            ${bulgeHtml}
        `;

    if (outlineTarget) app._setPcbPropsTitle?.(selectedNode != null ? 'Board Outline Node' : selectedSegment != null ? 'Board Outline Segment' : 'Board Outline');
    for (const [id, axis, dimension] of [
        ['pcbPropOutlineWidth', 'x', 'w'],
        ['pcbPropOutlineHeight', 'y', 'h'],
    ]) {
        const input = /** @type {HTMLInputElement|null} */ (document.getElementById(String(id)));
        input?.addEventListener('change', () => {
            if (isLayerLocked(shape.layer) || !Number.isFinite(input.valueAsNumber) || input.valueAsNumber < 0.1) return;
            const before = shapeSnapshot(shape);
            const bounds = boardBoundary(app);
            const factor = input.valueAsNumber / bounds[dimension];
            shape.points = shape.points.map(point => ({ ...point, [axis]: bounds[axis] + (point[axis] - bounds[axis]) * factor }));
            const after = shapeSnapshot(shape);
            applyShapeSnapshot(shape, before);
            app.history.execute(new ModifyBoardShapeCommand(app, shape, before, after));
        });
    }
    const outlineKind = /** @type {HTMLSelectElement|null} */ (document.getElementById('pcbPropOutlineKind'));
    outlineKind?.addEventListener('change', () => {
        if (isLayerLocked(shape.layer) || shape.kind === outlineKind.value || !['rect', 'polygon', 'circle'].includes(outlineKind.value)) return;
        const before = shapeSnapshot(shape);
        const bounds = boardBoundary(app);
        const keepCorners = shape.kind === 'rect' && outlineKind.value === 'polygon';
        const points = keepCorners ? shape.points.map(point => ({ ...point })) : shapeOutline(shape);
        shape.kind = outlineKind.value;
        if (!keepCorners) {
            shape.segmentBulges = {};
            shape.nodeCornerRadii = {};
            shape.cornerRadius = 0;
        }
        applyShapeGeometry(shape, shape.kind === 'circle'
            ? { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2, radius: Math.min(bounds.w, bounds.h) / 2 }
            : { points: shape.kind === 'polygon' ? points : [
                { x: bounds.x, y: bounds.y }, { x: bounds.x + bounds.w, y: bounds.y },
                { x: bounds.x + bounds.w, y: bounds.y + bounds.h }, { x: bounds.x, y: bounds.y + bounds.h }] });
        const after = shapeSnapshot(shape);
        applyShapeSnapshot(shape, before);
        app.history.execute(new ModifyBoardShapeCommand(app, shape, before, after));
    });
    const bulgeEl = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropShapeBulge'));
    const bulgePreview = createBoardShapePropertyPreview(app, [shape], { liveDrag: true });
    const previewBulge = () => {
        if (!bulgeEl || !Number.isFinite(bulgeEl.valueAsNumber)) return;
        const value = Number(formatNumberInputValue(Math.max(-1, Math.min(1, bulgeEl.valueAsNumber))));
        if (value === editableShapeBulge(shape, selectedSegment)) return;
        bulgePreview.update(() => {
            if (shape.kind === 'arc') shape.bulge = bulgePointFromRatio(shape.start, shape.end, value);
            else if (selectedSegment != null) {
                shape.segmentBulges ||= {};
                shape.segmentBulges[selectedSegment] = value;
            }
        });
    };
    const commitBulge = () => {
        if (!bulgeEl) return;
        if (!Number.isFinite(bulgeEl.valueAsNumber)) { bulgePreview.cancel(); return; }
        previewBulge();
        formatNumberInput(bulgeEl);
        bulgePreview.update(() => normalizeStraightArc(shape, selectedSegment));
        bulgePreview.commit();
    };
    bulgeEl?.addEventListener('input', previewBulge);
    bulgeEl?.addEventListener('change', commitBulge);
    bulgeEl?.addEventListener('blur', () => {
        queueMicrotask(() => {
            if (bulgePreview.active) commitBulge();
        });
    });

    const commit = (mutate) => {
        const before = propertyTargets().map((target) => ({ target, state: shapeSnapshot(target) }));
        for (const { target } of before) {
            mutate(target);
            if (isMaskLayer(target.layer)) target.filled = true;
            target.copperMode = normalizeShapeCopperMode(target.copperMode);
        }
        const changed = before.filter(({ target, state }) => JSON.stringify(state) !== JSON.stringify(shapeSnapshot(target)));
        if (!changed.length) return;
        const commands = changed.map(({ target, state }) => {
            const after = shapeSnapshot(target);
            applyShapeSnapshot(target, state);
            return new ModifyBoardShapeCommand(app, target, state, after);
        });
        app.history.execute(commands.length === 1 ? commands[0] : new CompoundCommand(commands));
        app._refreshPcbSelectionHighlights?.();
    };
    const lineWidthPreview = createBoardShapePropertyPreview(app, propertyTargets());
    const diameterPreview = createBoardShapePropertyPreview(app, propertyTargets().filter(target => target.kind === 'circle'));
    const cornerRadiusPreview = createBoardShapePropertyPreview(app, propertyTargets().filter(target => ['line', 'rect', 'polygon'].includes(target.kind)));
    const nodeCornerRadiusPreview = createBoardShapePropertyPreview(app, [shape]);
    const previewCornerRadius = () => {
        if (!cornerRadiusEl || !Number.isFinite(cornerRadiusEl.valueAsNumber)) return;
        const radius = Math.min(25, Math.max(0, cornerRadiusEl.valueAsNumber));
        cornerRadiusEl.value = radius.toFixed(2);
        const targets = propertyTargets().filter((target) => ['line', 'rect', 'polygon'].includes(target.kind));
        if (targets.every((target) => Math.abs(targetCornerRadius(target) - radius) < 1e-9
            && !Object.keys(target.nodeCornerRadii || {}).length)) return;
        cornerRadiusPreview.update(() => {
            for (const target of targets) {
                target.cornerRadius = radius;
                target.nodeCornerRadii = {};
            }
        });
    };

    const previewNodeCornerRadius = () => {
        if (!nodeCornerRadiusEl || selectedNode == null || !Number.isFinite(nodeCornerRadiusEl.valueAsNumber)) return;
        const radius = Math.min(25, Math.max(0, nodeCornerRadiusEl.valueAsNumber));
        nodeCornerRadiusEl.value = radius.toFixed(2);
        if (Math.abs(boardShapeNodeCornerRadius(shape, selectedNode) - radius) < 1e-9) return;
        nodeCornerRadiusPreview.update(() => setBoardShapeNodeCornerRadius(shape, selectedNode, radius));
    };

    const diameterEl = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropShapeDiameter'));
    const syncDiameter = () => {
        if (!diameterEl) return;
        const targets = propertyTargets();
        const diameter = circleFilledRadius(targets[0]) * 2;
        const mixed = targets.some((target) => Math.abs(circleFilledRadius(target) * 2 - diameter) >= 1e-9);
        diameterEl.min = String(diameterMinimum());
        diameterEl.value = mixed ? '' : diameter.toFixed(2);
        diameterEl.placeholder = mixed ? 'Mixed' : '';
    };
    const previewDiameter = () => {
        if (!diameterEl || !Number.isFinite(diameterEl.valueAsNumber)) return;
        const diameter = Number(diameterEl.valueAsNumber.toFixed(6));
        if (diameter < diameterMinimum()) return;
        const targets = propertyTargets().filter((target) => target.kind === 'circle');
        if (targets.every((target) => Math.abs(circleFilledRadius(target) * 2 - diameter) < 1e-9)) return;
        diameterPreview.update(before => {
            targets.forEach((target, index) => {
                target.lineWidth = Math.min(normalizedBoardShapeLineWidth(target, before[index].lineWidth), diameter / 2);
                target.radius = Math.max(0.05, diameter / 2);
            });
        });
        if (lineEl) {
            const width = targets[0].lineWidth;
            const mixed = targets.some((target) => Math.abs(target.lineWidth - width) >= 1e-9);
            lineEl.value = mixed ? '' : width.toFixed(2);
            lineEl.placeholder = mixed ? 'Mixed' : '';
        }
    };
    const seedMixedDiameter = () => {
        if (!diameterEl || Number.isFinite(diameterEl.valueAsNumber)) return;
        diameterEl.value = (circleFilledRadius(propertyTargets()[0]) * 2).toFixed(2);
    };
    let steppingDiameter = false;
    diameterEl?.addEventListener('pointerdown', () => { steppingDiameter = true; });
    for (const eventName of ['pointerup', 'pointercancel', 'pointerleave', 'keyup', 'blur']) {
        diameterEl?.addEventListener(eventName, () => { steppingDiameter = false; });
    }
    diameterEl?.addEventListener('keydown', (event) => {
        steppingDiameter = event.key === 'ArrowUp' || event.key === 'ArrowDown';
        if (steppingDiameter) seedMixedDiameter();
    });
    diameterEl?.addEventListener('input', () => {
        if (steppingDiameter && Number.isFinite(diameterEl.valueAsNumber)) {
            diameterEl.value = diameterEl.valueAsNumber.toFixed(2);
        }
        previewDiameter();
    });
    diameterEl?.addEventListener('change', () => {
        if (!Number.isFinite(diameterEl.valueAsNumber)) { diameterPreview.cancel(); syncDiameter(); return; }
        if (Number.isFinite(diameterEl.valueAsNumber)) {
            diameterEl.value = Math.max(diameterMinimum(), diameterEl.valueAsNumber).toFixed(2);
        }
        previewDiameter();
        syncDiameter();
        diameterPreview.commit();
    });
    const lineEl = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropShapeLineWidth'));
    const lineRowEl = /** @type {HTMLDivElement|null} */ (document.getElementById('pcbPropShapeLineWidthRow'));
    const cornerRadiusEl = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropShapeCornerRadius'));
    const nodeCornerRadiusEl = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropShapeNodeCornerRadius'));
    const filledEl = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropShapeFilled'));
    const platedEl = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropShapePlated'));
    const layerEl = /** @type {HTMLSelectElement|null} */ (document.getElementById('pcbPropShapeLayer'));
    const copperModeRowEl = /** @type {HTMLDivElement|null} */ (document.getElementById('pcbPropShapeCopperModeRow'));
    const copperModeEl = /** @type {HTMLSelectElement|null} */ (document.getElementById('pcbPropShapeCopperMode'));
    const netEl = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropShapeNet'));
    const netMenuEl = /** @type {HTMLDetailsElement|null} */ (document.querySelector('.prop-net-menu'));
    for (const input of [diameterEl, lineEl, cornerRadiusEl, nodeCornerRadiusEl, bulgeEl]) bindPictureRefreshHold(app, input);
    for (const [input, preview] of [[diameterEl, diameterPreview], [lineEl, lineWidthPreview],
        [cornerRadiusEl, cornerRadiusPreview], [nodeCornerRadiusEl, nodeCornerRadiusPreview], [bulgeEl, bulgePreview]]) {
        bindPropertyPreviewCancel(input, preview, () => showBoardShapeProperties(app, shape));
    }
    if (filledEl) {
        filledEl.checked = mixedFill ? false : !!shape.filled;
        filledEl.indeterminate = mixedFill;
    }
    if (platedEl) {
        platedEl.checked = mixedPlated ? false : !!holeTargets[0]?.plated;
        platedEl.indeterminate = mixedPlated;
    }
    let fillIsMixed = mixedFill;

    const syncCopperModeAvailability = () => {
        if (!copperModeEl || !layerEl || !copperModeRowEl) return;
        const targets = propertyTargets();
        const mixed = targets.some(
            (target) => normalizeShapeCopperMode(target.copperMode) !== normalizeShapeCopperMode(shape.copperMode),
        );
        const hasCopperTarget = targets.some((target) => isCopperLayer(target.layer));
        const allCopperTargets = targets.every((target) => isCopperLayer(target.layer));
        copperModeRowEl.style.display = hasCopperTarget ? '' : 'none';
        copperModeEl.disabled = !allCopperTargets;
        copperModeEl.value = mixed ? '' : normalizeShapeCopperMode(shape.copperMode);
        // A hole-layer shape is a board cutout — "Filled" doesn't apply.
        if (filledEl) filledEl.disabled = layerEl.value === 'hole';
        if (lineRowEl) lineRowEl.style.display = targets.every((target) => !!target.filled) ? 'none' : '';
    };

    const previewLineWidth = () => {
        if (!lineEl || !Number.isFinite(lineEl.valueAsNumber)) return;
        const targets = propertyTargets();
        const minimum = Math.max(...targets.map((target) => boardShapeLineWidthMinimum(target)));
        const maximum = selectedSegment == null
            ? Math.min(...targets.map((target) => target.kind === 'circle' ? circleFilledRadius(target) : Infinity))
            : Infinity;
        const v = Math.max(minimum, Math.min(maximum, lineEl.valueAsNumber));
        if (lineEl.valueAsNumber !== v) lineEl.value = v.toFixed(2);
        if (selectedSegment != null && Math.abs(v - boardShapeSegmentWidth(shape, selectedSegment)) < 1e-9) return;
        if (selectedSegment == null
            && targets.every((target) => Math.abs(v - (Number(target.lineWidth) || 0.2)) < 1e-9
                && !Object.keys(target.segmentWidths || {}).length)) return;
        lineWidthPreview.update(() => {
            for (const target of targets) {
                if (selectedSegment != null && target.kind !== 'arc') {
                    target.segmentWidths ||= {};
                    if (Math.abs(v - normalizedBoardShapeLineWidth(target, target.lineWidth)) < 1e-9) {
                        delete target.segmentWidths[selectedSegment];
                    } else {
                        target.segmentWidths[selectedSegment] = v;
                    }
                } else {
                    target.lineWidth = v;
                    target.segmentWidths = {};
                }
            }
        });
        syncDiameter();
    };
    const seedMixedLineWidth = () => {
        if (!lineEl || Number.isFinite(lineEl.valueAsNumber)) return;
        lineEl.value = initialLineWidth.toFixed(2);
    };
    // Native number steppers may retain an empty mixed value, leaving
    // valueAsNumber as NaN and bypassing the batch preview entirely.
    let steppingLineWidth = false;
    lineEl?.addEventListener('pointerdown', () => {
        steppingLineWidth = true;
        seedMixedLineWidth();
    });
    for (const eventName of ['pointerup', 'pointercancel', 'pointerleave', 'keyup', 'blur']) {
        lineEl?.addEventListener(eventName, () => { steppingLineWidth = false; });
    }
    lineEl?.addEventListener('keydown', (event) => {
        steppingLineWidth = event.key === 'ArrowUp' || event.key === 'ArrowDown';
        if (steppingLineWidth) seedMixedLineWidth();
    });
    lineEl?.addEventListener('input', () => {
        if (steppingLineWidth && Number.isFinite(lineEl.valueAsNumber)) {
            lineEl.value = lineEl.valueAsNumber.toFixed(2);
        }
        previewLineWidth();
    });
    lineEl?.addEventListener('change', () => {
        if (!Number.isFinite(lineEl.valueAsNumber)) { lineWidthPreview.cancel(); return; }
        if (Number.isFinite(lineEl.valueAsNumber)) lineEl.value = lineEl.valueAsNumber.toFixed(2);
        previewLineWidth();
        lineWidthPreview.commit();
    });
    cornerRadiusEl?.addEventListener('input', previewCornerRadius);
    cornerRadiusEl?.addEventListener('change', () => {
        if (!Number.isFinite(cornerRadiusEl.valueAsNumber)) { cornerRadiusPreview.cancel(); return; }
        previewCornerRadius();
        cornerRadiusPreview.commit();
    });
    nodeCornerRadiusEl?.addEventListener('input', previewNodeCornerRadius);
    nodeCornerRadiusEl?.addEventListener('change', () => {
        if (!Number.isFinite(nodeCornerRadiusEl.valueAsNumber)) { nodeCornerRadiusPreview.cancel(); return; }
        previewNodeCornerRadius();
        nodeCornerRadiusPreview.commit();
    });
    filledEl?.addEventListener('change', () => {
        const v = !!filledEl.checked;
        fillIsMixed = false;
        filledEl.indeterminate = false;
        filledEl.checked = v;
        if (propertyTargets().every((target) => v === !!target.filled)) return;
        commit((target) => { target.filled = v; });
    });
    platedEl?.addEventListener('change', () => {
        const plated = !!platedEl.checked;
        platedEl.indeterminate = false;
        if (propertyTargets().filter((target) => target.layer === 'hole').every(
            (target) => plated === !!target.plated,
        )) return;
        commit((target) => {
            if (target.layer === 'hole') target.plated = plated;
        });
    });
    layerEl?.addEventListener('change', () => {
        const next = layerEl.value;
        if (!next || propertyTargets().every((target) => next === target.layer)) return;
        if (isLayerLocked(next)) {
            layerEl.value = shape.layer;
            syncCopperModeAvailability();
            return;
        }
        commit((target) => {
            target.layer = next;
            target.lineWidth = normalizedBoardShapeLineWidth(target, target.lineWidth);
        });
        syncCopperModeAvailability();
        showBoardShapeProperties(app, shape);
    });
    copperModeEl?.addEventListener('change', () => {
        if (copperModeEl.disabled) return;
        const next = normalizeShapeCopperMode(copperModeEl.value);
        if (!copperModeEl.value || propertyTargets().every(
            (target) => next === normalizeShapeCopperMode(target.copperMode),
        )) return;
        commit((target) => { target.copperMode = next; });
        syncCopperModeAvailability();
    });
    netEl?.addEventListener('change', () => {
        const next = netEl.value.trim();
        const targets = propertyTargets();
        if (targets.length === 1 && next && targets[0].kind === 'line') {
            const track = convertBoardLineToTrack(app, targets[0], next);
            if (track) return;
        }
        if (targets.every((target) => String(target.net || '') === next)) return;
        commit((target) => { target.net = next; });
    });
    netMenuEl?.addEventListener('click', (event) => {
        const option = /** @type {HTMLButtonElement|null} */ (event.target instanceof Element ? event.target.closest('button[data-net]') : null);
        if (!option || !netEl) return;
        netEl.value = option.dataset.net || '';
        netEl.dispatchEvent(new Event('change'));
        netMenuEl.open = false;
    });
    netMenuEl?.addEventListener('toggle', () => {
        if (netMenuEl.open) syncNetMenuSelection(netMenuEl, netEl);
    });

    syncCopperModeAvailability();
    app._setActiveRibbonTab?.('pcb-properties');
}

function syncShapeBulgeProperty(app, shape) {
    const input = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropShapeBulge'));
    if (!input) return;
    const segment = app._selectedBoardShapeSegment?.shapeId === shape.id
        ? app._selectedBoardShapeSegment.segment : null;
    input.value = String(editableShapeBulge(shape, segment));
    formatNumberInput(input);
}

function syncCircleDiameterProperty(app, shape) {
    if (shape.kind !== 'circle') return;
    const input = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropShapeDiameter'));
    if (!input) return;
    const selected = getPcbSelection(app, 'shape');
    const targets = selected.length ? selected : [shape];
    if (!targets.every((target) => target.kind === 'circle')) return;
    const diameter = circleFilledRadius(targets[0]) * 2;
    const mixed = targets.some((target) => Math.abs(circleFilledRadius(target) * 2 - diameter) >= 1e-9);
    input.value = mixed ? '' : diameter.toFixed(2);
    input.placeholder = mixed ? 'Mixed' : '';
}

export function refreshBoardShapeProperties(app, shape) {
    if (shape && isPcbSelected(app, 'shape', shape)) {
        showBoardShapeProperties(app, shape);
    }
}

// ── Copper cuts ──────────────────────────────────────────────────────────────

/**
 * SVG sub-paths for board shapes that subtract copper on the given copper
 * layer. Returns { count, d } to fold into PCBApp._updateCopperCuts.
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

export function serializeBoardShapes(app, { compactArtwork = true, roundGeometry = true } = {}) {
    const artworkIndices = new Map();
    return (app.boardShapes || []).map((s, index) => {
        if (s?.type === 'fill') return s.toJSON();
        const number = value => roundGeometry && Number.isFinite(value) ? r4(value) : value;
        const point = value => ({ x: number(value.x), y: number(value.y) });
        const numbers = values => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, number(value)]));
        const base = {
            id: s.id,
            geometryVersion: s.kind === 'circle' ? 2 : 1,
            kind: s.kind,
            layer: s.layer,
            lineWidth: number(s.lineWidth),
            filled: !!s.filled,
            copperMode: normalizeShapeCopperMode(s.copperMode),
            plated: !!s.plated,
            net: String(s.net || ''),
        };
        if (Object.keys(s.segmentWidths || {}).length) base.segmentWidths = numbers(s.segmentWidths);
        if (Object.keys(s.segmentBulges || {}).length) base.segmentBulges = numbers(s.segmentBulges);
        if (Object.keys(s.nodeCornerRadii || {}).length) base.nodeCornerRadii = numbers(s.nodeCornerRadii);
        if (s.kind === 'rect') base.cornerRadius = number(rectCornerRadius(s));
        else if (s.kind === 'polygon' || s.kind === 'line') base.cornerRadius = number(polygonCornerRadius(s));
        if (s.kind === 'arc') {
            return { ...base, start: point(s.start), end: point(s.end), bulge: point(s.bulge) };
        }
        if (s.kind === 'circle') {
            return { ...base, x: number(s.x), y: number(s.y), radius: number(s.radius) };
        }
        if (s.kind === 'image') {
            if (!compactArtwork) return { ...base, name: s.name, artwork: structuredClone(s.artwork), points: s.points.map(point) };
            const encoded = encodePictureArtwork(s.artwork);
            const key = JSON.stringify(encoded);
            const previous = artworkIndices.get(key);
            const artwork = previous === undefined ? encoded : { encoding: 'reference-v1', index: previous };
            if (previous === undefined) artworkIndices.set(key, index);
            return { ...base, name: s.name, artwork, points: s.points.map(point) };
        }
        return { ...base, points: (s.points || []).map(point) };
    });
}

const pt = (p) => ({ x: Number(p?.x) || 0, y: Number(p?.y) || 0 });

export function loadBoardShapes(app, arr, { render = true, strict = false } = {}) {
    if (!Array.isArray(arr)) return;
    const loadedArtwork = new Map();
    for (const [index, sd] of arr.entries()) {
        if (sd?.type === 'fill') {
            try {
                const fill = CopperFill.fromJSON(sd);
                updateFillIdCounter(fill.id);
                app.boardShapes.push(fill);
            } catch (err) {
                if (strict) throw err;
                console.warn('Skipping malformed copper fill during load:', err);
            }
            continue;
        }
        const kind = SHAPE_KINDS.has(sd?.kind) ? sd.kind : null;
        if (!kind) {
            if (strict) throw new Error(`Unknown board shape kind: ${sd?.kind}`);
            continue;
        }
        const base = {
            id: String(sd.id || `pshape_${app._shapeIdCounter++}`),
            kind,
            layer: String(sd.layer || 'top-silk'),
            lineWidth: Math.max(0.05, Number(sd.lineWidth) || (app._shapeDefaults?.lineWidth ?? 0.2)),
            filled: !!sd.filled,
            copperMode: normalizeShapeCopperMode(sd.copperMode),
            plated: !!sd.plated,
            net: String(sd.net || ''),
        };
        if (sd.segmentWidths && typeof sd.segmentWidths === 'object') {
            base.segmentWidths = Object.fromEntries(Object.entries(sd.segmentWidths)
                .filter(([index, width]) => Number.isInteger(Number(index)) && Number(width) >= 0.05)
                .map(([index, width]) => [index, Number(width)]));
        }
        if (sd.segmentBulges && typeof sd.segmentBulges === 'object') {
            base.segmentBulges = Object.fromEntries(Object.entries(sd.segmentBulges)
                .filter(([segment, bulge]) => Number.isInteger(Number(segment))
                    && Number.isFinite(Number(bulge)) && Math.abs(Number(bulge)) >= BULGE_EPS)
                .map(([segment, bulge]) => [segment, Math.max(-1, Math.min(1, Number(bulge)))]));
        }
        if (sd.nodeCornerRadii && typeof sd.nodeCornerRadii === 'object') {
            base.nodeCornerRadii = Object.fromEntries(Object.entries(sd.nodeCornerRadii)
                .filter(([index, radius]) => Number.isInteger(Number(index)) && Number(radius) >= 0)
                .map(([index, radius]) => [index, Number(radius)]));
        }
        if (['line', 'rect', 'polygon'].includes(kind)) {
            base.cornerRadius = Math.max(0, Number(sd.cornerRadius) || 0);
        }
        let shape;
        if (kind === 'arc') {
            shape = { ...base, start: pt(sd.start), end: pt(sd.end), bulge: pt(sd.bulge) };
        } else if (kind === 'circle') {
            const radius = Math.max(0.05, Number(sd.radius) || 0);
            if (!radius) continue;
            shape = { ...base, x: Number(sd.x) || 0, y: Number(sd.y) || 0, radius };
        } else {
            const pts = Array.isArray(sd.points) ? sd.points.map(pt) : [];
            if (pts.length < (kind === 'line' ? 2 : 3)) {
                if (strict) throw new Error(`Insufficient points in board shape: ${sd.id}`);
                continue;
            }
            shape = { ...base, points: pts };
        }
        if (kind === 'image') {
            try {
                validatePicturePoints(sd.points, { coordinateTolerance: 0.00005 });
                if (!PICTURE_LAYERS.includes(shape.layer)) throw new Error('Invalid image layer.');
                if (sd.artwork?.encoding === 'reference-v1') {
                    if (!Number.isInteger(sd.artwork.index) || sd.artwork.index >= index || !loadedArtwork.has(sd.artwork.index)) {
                        throw new Error('Invalid image artwork reference.');
                    }
                    shape.artwork = structuredClone(loadedArtwork.get(sd.artwork.index));
                } else shape.artwork = decodePictureArtwork(sd.artwork);
                loadedArtwork.set(index, shape.artwork);
                shape.name = String(sd.name || 'Image');
                shape.filled = true;
            } catch (error) {
                if (strict) throw error;
                console.warn('Skipping malformed image during load:', error);
                continue;
            }
        }
        if (sd.geometryVersion !== 2 && kind === 'circle' && shape.layer !== 'board-outline') {
            shape.radius += shape.lineWidth / 2;
        }
        app.boardShapes.push(shape);
        if (render) renderBoardShape(app, shape);
        const n = /pshape_(\d+)/.exec(shape.id);
        if (n) app._shapeIdCounter = Math.max(app._shapeIdCounter, Number(n[1]) + 1);
    }
}
