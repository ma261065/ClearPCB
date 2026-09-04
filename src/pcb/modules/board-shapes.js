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

import { circumcircle, pointInPolygon, distanceToSegment } from '../../core/geometry.js';
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
import { clearAxisGlow, renderAxisGlow } from './axis-glow.js';
import {
    getPcbSelection,
    hitTestPcbSelection,
    isPcbSelected,
    registerPcbSelectionAdapter,
    setPcbSelection,
    syncPcbSelection,
} from './selection-registry.js';
import { clearPcbSelectionAnchors, renderPcbSelectionAnchors } from './selection-anchors.js';

const NS = 'http://www.w3.org/2000/svg';
const SHAPE_KINDS = new Set(['line', 'rect', 'polygon', 'arc', 'circle']);
const HOLE_BORDER_WIDTH = 0.05;
const REMOVAL_OUTLINE_WIDTH_PX = 1;

/** Round to 4 dp for compact, stable path/serialisation output. */
const r4 = (n) => Math.round(n * 10000) / 10000;

/** Human-friendly title for the Properties panel. */
export function shapeKindLabel(kind) {
    return kind === 'line' ? 'Line'
        : kind === 'rect' ? 'Rectangle'
        : kind === 'polygon' ? 'Polygon'
            : kind === 'arc' ? 'Arc'
                : kind === 'circle' ? 'Circle'
                : 'Shape';
}

/** Normalise a copper mode string (back-compatible with old circle modes). */
export function normalizeShapeCopperMode(mode) {
    const m = String(mode || 'add');
    if (m === 'remove-copper' || m === 'remove-solder-mask' || m === 'remove-copper-mask') return m;
    if (m === 'remove') return 'remove-copper-mask';
    if (m === 'remove-mask') return 'remove-solder-mask';
    return 'add';
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

function trackMatchesSourceBoardShape(track) {
    const source = track?.sourceBoardShape;
    if (source?.kind !== 'line' || !Array.isArray(source.points) || source.points.length < 2) return false;
    if (track.nodes.size !== source.points.length || track.edges.size !== source.points.length - 1
        || track.padConnections.size) return false;
    const width = Math.max(0.05, Number(source.lineWidth) || 0.2);
    return source.points.every((point, index) => {
        const node = track.nodes.get(`n${index}`);
        const edge = index ? track.edges.get(`e${index - 1}`) : null;
        return node && node.x === point.x && node.y === point.y
            && (!edge || (edge.from === `n${index - 1}` && edge.to === `n${index}`
                && track.getEdgeLayer(`e${index - 1}`) === source.layer
                && track.getEdgeWidth(`e${index - 1}`) === width));
    });
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
    const visitedEdges = new Set();
    let previousNodeId = null;
    let nodeId = endpoints[0];
    let layer = null;
    let width = null;
    while (nodeId) {
        const node = track.nodes.get(nodeId);
        if (!node) return null;
        points.push({ x: node.x, y: node.y });
        const next = (adjacency.get(nodeId) || []).find((edge) => edge.nodeId !== previousNodeId);
        if (!next) break;
        if (visitedEdges.has(next.edgeId)) return null;
        const edgeLayer = track.getEdgeLayer(next.edgeId);
        const edgeWidth = track.getEdgeWidth(next.edgeId);
        if ((layer !== null && edgeLayer !== layer) || (width !== null && edgeWidth !== width)) return null;
        visitedEdges.add(next.edgeId);
        layer = edgeLayer;
        width = edgeWidth;
        previousNodeId = nodeId;
        nodeId = next.nodeId;
    }
    return visitedEdges.size === track.edges.size && points.length === track.nodes.size
        ? { points, layer, width }
        : null;
}

export function canRestoreTrackToSourceBoardShape(track) {
    return trackMatchesSourceBoardShape(track) || !!simpleTrackLinePoints(track);
}

export function restoreTrackToSourceBoardShape(app, track) {
    if (!app.tracks?.includes(track)) return false;
    const hasSourceShape = trackMatchesSourceBoardShape(track);
    const source = hasSourceShape
        ? JSON.parse(JSON.stringify(track.sourceBoardShape))
        : simpleTrackLinePoints(track);
    if (!source) return false;
    const shape = hasSourceShape ? source : {
        id: `pshape_${app._shapeIdCounter++}`,
        kind: 'line',
        layer: source.layer,
        lineWidth: source.width,
        filled: false,
        copperMode: 'add',
        plated: false,
        net: '',
        points: source.points,
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
        sourceBoardShape: sourceBoardShapeForTrack(shape),
    });
    selectBoardShape(app, null);
    app.history.execute(new CompoundCommand([
        new RemoveBoardShapeCommand(app, shape),
        new AddTrackCommand(app, track),
    ]));
    setPcbSelection(app, [{ kind: 'track', object: track }]);
    app._refreshPcbSelectionHighlights?.();
    return track;
}

function isMaskOrDocLayer(layer) {
    const l = String(layer || '');
    return l === 'top-mask' || l === 'bottom-mask'
        || l === 'document' || l === 'top-document' || l === 'bottom-document';
}

// ── Geometry ────────────────────────────────────────────────────────────────

function normAngle(a) {
    let v = a % (2 * Math.PI);
    if (v < 0) v += 2 * Math.PI;
    return v;
}

function arcChordFrame(start, end) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    if (length < 1e-9) return null;
    return {
        midpoint: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 },
        normal: { x: -dy / length, y: dx / length },
        length,
    };
}

function projectArcBulge(start, end, point) {
    const frame = arcChordFrame(start, end);
    if (!frame) return { ...point };
    const offset = (point.x - frame.midpoint.x) * frame.normal.x
        + (point.y - frame.midpoint.y) * frame.normal.y;
    const clamped = Math.max(-frame.length / 2, Math.min(frame.length / 2, offset));
    return {
        x: frame.midpoint.x + frame.normal.x * clamped,
        y: frame.midpoint.y + frame.normal.y * clamped,
    };
}

function arcBulgeRatio(shape) {
    const frame = arcChordFrame(shape.start, shape.end);
    if (!frame) return 0;
    const offset = (shape.bulge.x - frame.midpoint.x) * frame.normal.x
        + (shape.bulge.y - frame.midpoint.y) * frame.normal.y;
    return Math.max(-0.5, Math.min(0.5, offset / frame.length));
}

function arcBulgeFromRatio(start, end, ratio) {
    const frame = arcChordFrame(start, end);
    if (!frame) return { ...start };
    const offset = ratio * frame.length;
    return {
        x: frame.midpoint.x + frame.normal.x * offset,
        y: frame.midpoint.y + frame.normal.y * offset,
    };
}

/** Circumcircle-derived centre/radius for an arc, or null when collinear. */
function arcGeom(shape) {
    return circumcircle(shape.start, shape.bulge, shape.end);
}

/**
 * Walk angles from start through bulge to end. Returns { a1, dir, total }
 * where the arc spans `total` radians from `a1` in direction `dir` (+1/-1),
 * guaranteeing the bulge control point lies on the swept arc.
 */
function arcSweep(shape, g) {
    const a1 = Math.atan2(shape.start.y - g.cy, shape.start.x - g.cx);
    const a2 = Math.atan2(shape.bulge.y - g.cy, shape.bulge.x - g.cx);
    const a3 = Math.atan2(shape.end.y - g.cy, shape.end.x - g.cx);
    const ccw2 = normAngle(a2 - a1);
    const ccw3 = normAngle(a3 - a1);
    // If, walking CCW from start, we reach the bulge before the end, the arc
    // sweeps CCW; otherwise it sweeps CW.
    if (ccw2 < ccw3) return { a1, dir: 1, total: ccw3 };
    return { a1, dir: -1, total: 2 * Math.PI - ccw3 };
}

/** Canonical circle geometry for a board-shape arc. */
export function boardShapeArcGeometry(shape) {
    if (shape?.kind !== 'arc') return null;
    const g = arcGeom(shape);
    if (!g) return null;
    const { a1, dir, total } = arcSweep(shape, g);
    return {
        cx: g.cx,
        cy: g.cy,
        radius: g.radius,
        startAngle: a1,
        endAngle: a1 + dir * total,
        counterclockwise: dir < 0,
    };
}

/** Tessellate an arc into points (start → … → end), passing through the bulge. */
function arcSamples(shape, segments = 48) {
    const g = arcGeom(shape);
    if (!g) return [{ ...shape.start }, { ...shape.end }];
    const { a1, dir, total } = arcSweep(shape, g);
    const pts = [];
    for (let i = 0; i <= segments; i++) {
        const a = a1 + dir * total * (i / segments);
        pts.push({ x: g.cx + g.radius * Math.cos(a), y: g.cy + g.radius * Math.sin(a) });
    }
    return pts;
}

function rectBounds(shape) {
    const points = shape.points || [];
    if (points.length < 2) return null;
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    return {
        minX: Math.min(...xs), maxX: Math.max(...xs),
        minY: Math.min(...ys), maxY: Math.max(...ys),
    };
}

/** True when four ordered vertices form an axis-aligned rectangular cycle. */
function pointsFormAxisAlignedRect(points) {
    if (!Array.isArray(points) || points.length !== 4) return false;
    const epsilon = 1e-6;
    for (let index = 0; index < 4; index++) {
        const point = points[index];
        const next = points[(index + 1) % 4];
        const nextNext = points[(index + 2) % 4];
        const horizontal = Math.abs(point.y - next.y) <= epsilon && Math.abs(point.x - next.x) > epsilon;
        const vertical = Math.abs(point.x - next.x) <= epsilon && Math.abs(point.y - next.y) > epsilon;
        if (!horizontal && !vertical) return false;
        const nextHorizontal = Math.abs(next.y - nextNext.y) <= epsilon && Math.abs(next.x - nextNext.x) > epsilon;
        if (horizontal === nextHorizontal) return false;
    }
    return true;
}

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
    } else if (pointsFormAxisAlignedRect(points)) {
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
    if (shape.kind !== 'line' || !Array.isArray(shape.points) || shape.points.length < 4) return false;
    const lastIndex = shape.points.length - 1;
    if (handle !== 0 && handle !== lastIndex) return false;
    const otherIndex = handle === 0 ? lastIndex : 0;
    const endpoint = shape.points[handle];
    const other = shape.points[otherIndex];
    if (Math.hypot(endpoint.x - other.x, endpoint.y - other.y) >= 0.15) return false;
    shape.points.splice(handle, 1);
    shape.kind = 'polygon';
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
    const firstPoints = firstEndpoint === first.points.length - 1
        ? first.points.map((point) => ({ ...point }))
        : [...first.points].reverse().map((point) => ({ ...point }));
    const secondPoints = secondEndpoint === 0
        ? second.points.map((point) => ({ ...point }))
        : [...second.points].reverse().map((point) => ({ ...point }));
    return {
        ...first,
        id: `pshape_${app._shapeIdCounter++}`,
        points: [...firstPoints, ...secondPoints.slice(1)],
        net: '',
    };
}

/** Clamp a rectangle's corner radius to its current dimensions. */
export function rectCornerRadius(shape) {
    if (shape?.kind !== 'rect') return 0;
    const bounds = rectBounds(shape);
    if (!bounds) return 0;
    return Math.max(0, Math.min(
        Number(shape.cornerRadius) || 0,
        (bounds.maxX - bounds.minX) / 2,
        (bounds.maxY - bounds.minY) / 2,
    ));
}

/** Corner radius shared by every node of a closed polygon. */
export function polygonCornerRadius(shape) {
    return shape?.kind === 'polygon' ? Math.max(0, Number(shape.cornerRadius) || 0) : 0;
}

export function boardShapeNodeCornerRadius(shape, index) {
    const fallback = shape?.kind === 'rect' ? rectCornerRadius(shape) : polygonCornerRadius(shape);
    return Math.max(0, Number(shape?.nodeCornerRadii?.[index] ?? fallback) || 0);
}

export function setBoardShapeNodeCornerRadius(shape, index, radius) {
    if (!['rect', 'polygon'].includes(shape?.kind) || !shape.points?.[index]) return;
    const fallback = shape.kind === 'rect' ? rectCornerRadius(shape) : polygonCornerRadius(shape);
    const value = Math.max(0, Number(radius) || 0);
    shape.nodeCornerRadii ||= {};
    if (Math.abs(value - fallback) < 1e-9) delete shape.nodeCornerRadii[index];
    else shape.nodeCornerRadii[index] = value;
}

function roundedPolygonCorners(shape) {
    const points = shape.points || [];
    const hasRadius = points.some((_, index) => boardShapeNodeCornerRadius(shape, index) > 0);
    if (points.length < 3 || !hasRadius) return [];
    return points.map((vertex, index) => {
        const previous = points[(index + points.length - 1) % points.length];
        const next = points[(index + 1) % points.length];
        const previousDx = previous.x - vertex.x;
        const previousDy = previous.y - vertex.y;
        const nextDx = next.x - vertex.x;
        const nextDy = next.y - vertex.y;
        const previousLength = Math.hypot(previousDx, previousDy);
        const nextLength = Math.hypot(nextDx, nextDy);
        const inset = Math.min(boardShapeNodeCornerRadius(shape, index), previousLength / 2, nextLength / 2);
        if (inset < 0.01 || previousLength < 0.01 || nextLength < 0.01) {
            return { vertex, entry: { ...vertex }, exit: { ...vertex }, rounded: false };
        }
        return {
            vertex,
            rounded: true,
            entry: {
                x: vertex.x + previousDx / previousLength * inset,
                y: vertex.y + previousDy / previousLength * inset,
            },
            exit: {
                x: vertex.x + nextDx / nextLength * inset,
                y: vertex.y + nextDy / nextLength * inset,
            },
        };
    });
}

function sampleRoundedPolygonCorner(corner, segments = 8) {
    if (!corner.rounded) return [{ ...corner.vertex }];
    const points = [{ ...corner.entry }];
    for (let index = 1; index <= segments; index++) {
        const t = index / segments;
        const inverse = 1 - t;
        points.push({
            x: inverse * inverse * corner.entry.x
                + 2 * inverse * t * corner.vertex.x + t * t * corner.exit.x,
            y: inverse * inverse * corner.entry.y
                + 2 * inverse * t * corner.vertex.y + t * t * corner.exit.y,
        });
    }
    return points;
}

function roundedPolygonOutline(shape, segments = 8) {
    const corners = roundedPolygonCorners(shape);
    if (!corners.length) return (shape.points || []).map((point) => ({ ...point }));
    return corners.flatMap((corner) => sampleRoundedPolygonCorner(corner, segments));
}

function roundedPolygonPath(shape) {
    const corners = roundedPolygonCorners(shape);
    if (!corners.length) return '';
    const parts = [`M ${r4(corners[0].entry.x)} ${r4(corners[0].entry.y)}`];
    for (const corner of corners) {
        if (corner !== corners[0]) parts.push(`L ${r4(corner.entry.x)} ${r4(corner.entry.y)}`);
        if (corner.rounded) {
            parts.push(`Q ${r4(corner.vertex.x)} ${r4(corner.vertex.y)} ${r4(corner.exit.x)} ${r4(corner.exit.y)}`);
        }
    }
    parts.push('Z');
    return parts.join(' ');
}

function roundedRectOutline(shape, segments = 8) {
    const bounds = rectBounds(shape);
    const radius = rectCornerRadius(shape);
    if (!bounds || radius <= 0) return (shape.points || []).map((point) => ({ ...point }));
    const corners = [
        { x: bounds.minX + radius, y: bounds.minY + radius, start: Math.PI, end: Math.PI * 1.5 },
        { x: bounds.maxX - radius, y: bounds.minY + radius, start: -Math.PI / 2, end: 0 },
        { x: bounds.maxX - radius, y: bounds.maxY - radius, start: 0, end: Math.PI / 2 },
        { x: bounds.minX + radius, y: bounds.maxY - radius, start: Math.PI / 2, end: Math.PI },
    ];
    const points = [];
    for (const corner of corners) {
        for (let index = 0; index <= segments; index++) {
            const angle = corner.start + (corner.end - corner.start) * (index / segments);
            points.push({ x: corner.x + radius * Math.cos(angle), y: corner.y + radius * Math.sin(angle) });
        }
    }
    return points;
}

function circleOutline(shape, segments = 48) {
    const radius = Math.max(0.05, Number(shape.radius) || 0);
    const points = [];
    for (let index = 0; index < segments; index++) {
        const angle = Math.PI * 2 * (index / segments);
        points.push({
            x: shape.x + radius * Math.cos(angle),
            y: shape.y + radius * Math.sin(angle),
        });
    }
    return points;
}

export function circleFilledRadius(shape) {
    const radius = Math.max(0.05, Number(shape?.radius) || 0);
    const halfWidth = Math.max(0.05, Number(shape?.lineWidth) || 0.2) / 2;
    return radius + halfWidth;
}

function offsetClosedOutline(points, distance) {
    if (!Array.isArray(points) || points.length < 3 || Math.abs(distance) < 1e-9) {
        return (points || []).map((point) => ({ ...point }));
    }
    let area = 0;
    for (let index = 0; index < points.length; index++) {
        const current = points[index];
        const next = points[(index + 1) % points.length];
        area += current.x * next.y - next.x * current.y;
    }
    const orientation = area >= 0 ? 1 : -1;
    const normals = points.map((point, index) => {
        const next = points[(index + 1) % points.length];
        const dx = next.x - point.x;
        const dy = next.y - point.y;
        const length = Math.hypot(dx, dy) || 1;
        return { x: orientation * dy / length, y: orientation * -dx / length };
    });
    return points.map((point, index) => {
        const previousNormal = normals[(index + points.length - 1) % points.length];
        const nextNormal = normals[index];
        const mx = previousNormal.x + nextNormal.x;
        const my = previousNormal.y + nextNormal.y;
        const magnitude = Math.hypot(mx, my);
        if (magnitude < 1e-9) {
            return { x: point.x + nextNormal.x * distance, y: point.y + nextNormal.y * distance };
        }
        const ux = mx / magnitude;
        const uy = my / magnitude;
        const denominator = ux * nextNormal.x + uy * nextNormal.y;
        const scale = Math.abs(denominator) < 1e-9 ? distance : distance / denominator;
        return { x: point.x + ux * scale, y: point.y + uy * scale };
    });
}

function arcOutlineAtOffset(shape, offset) {
    const geometry = arcGeom(shape);
    if (!geometry) return [{ ...shape.start }, { ...shape.end }];
    const { a1, dir, total } = arcSweep(shape, geometry);
    const radius = Math.max(0.001, geometry.radius + offset);
    const points = [];
    for (let index = 0; index <= 48; index++) {
        const angle = a1 + dir * total * (index / 48);
        points.push({
            x: geometry.cx + radius * Math.cos(angle),
            y: geometry.cy + radius * Math.sin(angle),
        });
    }
    return points;
}

function filledShapeOutline(shape, offset) {
    if (shape.kind === 'arc') return arcOutlineAtOffset(shape, offset);
    if (shape.kind === 'circle') return circleOutline({ ...shape, radius: Math.max(0.05, shape.radius + offset), filled: false });
    if (shape.kind === 'rect' && !Object.keys(shape.nodeCornerRadii || {}).length) {
        const bounds = rectBounds(shape);
        if (!bounds) return [];
        return roundedRectOutline({
            ...shape,
            points: [
                { x: bounds.minX - offset, y: bounds.minY - offset },
                { x: bounds.maxX + offset, y: bounds.minY - offset },
                { x: bounds.maxX + offset, y: bounds.maxY + offset },
                { x: bounds.minX - offset, y: bounds.maxY + offset },
            ],
            cornerRadius: Math.max(0, rectCornerRadius(shape) + offset),
            filled: false,
        });
    }
    if ((shape.kind === 'rect' || shape.kind === 'polygon')
        && roundedPolygonCorners(shape).length) {
        return offsetClosedOutline(roundedPolygonOutline(shape), offset);
    }
    return offsetClosedOutline(shape.points || [], offset);
}

/** Outline points used for fill hit-testing, copper cuts and bounds. */
export function shapeOutline(shape) {
    if (shape.kind === 'arc') return arcSamples(shape);
    if (shape.kind === 'circle') return circleOutline(shape);
    if (shape.kind === 'rect') {
        return Object.keys(shape.nodeCornerRadii || {}).length
            ? roundedPolygonOutline(shape)
            : roundedRectOutline(shape);
    }
    if (shape.kind === 'polygon' && roundedPolygonCorners(shape).length) return roundedPolygonOutline(shape);
    return (shape.points || []).map((p) => ({ x: p.x, y: p.y }));
}

/** Outline edges as [p, q] pairs (closed for rect/polygon, open for arcs/lines). */
function shapeSegments(shape) {
    if (shape.kind === 'arc') {
        const s = arcSamples(shape);
        const segs = [];
        for (let i = 0; i < s.length - 1; i++) segs.push([s[i], s[i + 1]]);
        return segs;
    }
    const pts = shapeOutline(shape);
    const segs = [];
    const closed = shape.kind !== 'line';
    for (let i = 0; i < pts.length - (closed ? 0 : 1); i++) {
        segs.push([pts[i], pts[(i + 1) % pts.length]]);
    }
    return segs;
}

function boardShapeStrokeSegments(shape) {
    if ((shape.kind === 'polygon' || (shape.kind === 'rect' && Object.keys(shape.nodeCornerRadii || {}).length))
        && roundedPolygonCorners(shape).length) {
        const corners = roundedPolygonCorners(shape);
        const straightSegments = corners.map((corner, index) => ({
            start: { ...corner.exit },
            end: { ...corners[(index + 1) % corners.length].entry },
            lineWidth: boardShapeSegmentWidth(shape, index),
            logicalSegment: index,
        }));
        const cornerSegments = corners.flatMap((corner) => {
            const points = sampleRoundedPolygonCorner(corner);
            return points.slice(0, -1).map((start, index) => ({
                start,
                end: points[index + 1],
                lineWidth: normalizedBoardShapeLineWidth(shape, shape.lineWidth),
                logicalSegment: null,
            }));
        });
        return [...cornerSegments, ...straightSegments];
    }
    if (shape.kind !== 'rect' || rectCornerRadius(shape) <= 0) {
        return shapeSegments(shape).map(([start, end], index) => ({
            start, end, lineWidth: boardShapeSegmentWidth(shape, index), logicalSegment: index,
        }));
    }
    const radius = rectCornerRadius(shape);
    const points = shape.points || [];
    const straightSegments = points.map((start, index) => {
        const end = points[(index + 1) % points.length];
        const length = Math.hypot(end.x - start.x, end.y - start.y) || 1;
        const inset = Math.min(radius, length / 2);
        const dx = (end.x - start.x) / length;
        const dy = (end.y - start.y) / length;
        return {
            start: { x: start.x + dx * inset, y: start.y + dy * inset },
            end: { x: end.x - dx * inset, y: end.y - dy * inset },
            lineWidth: boardShapeSegmentWidth(shape, index),
            logicalSegment: index,
        };
    });
    const outline = roundedRectOutline(shape);
    const cornerSegments = [];
    for (let index = 0; index < outline.length; index++) {
        // Every ninth edge bridges two sampled corners and is replaced by the
        // corresponding logical straight edge above.
        if (index % 9 === 8) continue;
        cornerSegments.push({
            start: outline[index],
            end: outline[(index + 1) % outline.length],
            lineWidth: normalizedBoardShapeLineWidth(shape, shape.lineWidth),
            logicalSegment: null,
        });
    }
    return [...cornerSegments, ...straightSegments];
}

function openStrokeOutline(points, halfWidth) {
    if (!Array.isArray(points) || points.length < 2) return [];
    const normals = [];
    for (let index = 0; index < points.length - 1; index++) {
        const dx = points[index + 1].x - points[index].x;
        const dy = points[index + 1].y - points[index].y;
        const length = Math.hypot(dx, dy) || 1;
        normals.push({ x: -dy / length, y: dx / length });
    }
    const offsetPoint = (index, side) => {
        const point = points[index];
        if (index === 0) {
            return { x: point.x + normals[0].x * halfWidth * side, y: point.y + normals[0].y * halfWidth * side };
        }
        if (index === points.length - 1) {
            const normal = normals[normals.length - 1];
            return { x: point.x + normal.x * halfWidth * side, y: point.y + normal.y * halfWidth * side };
        }
        const previous = normals[index - 1];
        const next = normals[index];
        const mx = previous.x + next.x;
        const my = previous.y + next.y;
        const magnitude = Math.hypot(mx, my);
        if (magnitude < 1e-9) return { x: point.x + next.x * halfWidth * side, y: point.y + next.y * halfWidth * side };
        const ux = mx / magnitude;
        const uy = my / magnitude;
        const denominator = ux * next.x + uy * next.y;
        const distance = Math.abs(denominator) < 1e-9 ? halfWidth : halfWidth / denominator;
        return { x: point.x + ux * distance * side, y: point.y + uy * distance * side };
    };
    const left = points.map((_, index) => offsetPoint(index, 1));
    const right = points.map((_, index) => offsetPoint(index, -1));
    const outline = [...left];
    const capSegments = 12;
    const end = points[points.length - 1];
    const endBefore = points[points.length - 2];
    const endAngle = Math.atan2(end.y - endBefore.y, end.x - endBefore.x);
    for (let index = 1; index <= capSegments; index++) {
        const angle = endAngle + Math.PI / 2 - Math.PI * index / capSegments;
        outline.push({ x: end.x + Math.cos(angle) * halfWidth, y: end.y + Math.sin(angle) * halfWidth });
    }
    outline.push(...right.slice(0, -1).reverse());
    const start = points[0];
    const startAfter = points[1];
    const startAngle = Math.atan2(startAfter.y - start.y, startAfter.x - start.x);
    for (let index = 1; index < capSegments; index++) {
        const angle = startAngle - Math.PI / 2 - Math.PI * index / capSegments;
        outline.push({ x: start.x + Math.cos(angle) * halfWidth, y: start.y + Math.sin(angle) * halfWidth });
    }
    return outline;
}

function outlinePathD(points) {
    if (!Array.isArray(points) || points.length < 3) return '';
    let d = `M ${r4(points[0].x)} ${r4(points[0].y)}`;
    for (let index = 1; index < points.length; index++) d += ` L ${r4(points[index].x)} ${r4(points[index].y)}`;
    return d + ' Z';
}

/** Compound path for the physical area removed by a copper-mode shape. */
export function boardShapeRemovalPathD(shape) {
    const geometry = resolveBoardShapeGeometry(shape);
    const halfWidth = geometry.lineWidth / 2;
    if (geometry.filled) {
        const outline = shape.kind === 'circle'
            ? circleOutline({ ...shape, radius: geometry.circle?.outerRadius ?? shape.radius + halfWidth, filled: false })
            : offsetClosedOutline(shapeOutline(shape), halfWidth);
        return outlinePathD(outline);
    }
    if (shape.kind === 'circle') {
        const outer = circleOutline({ ...shape, radius: shape.radius + halfWidth, filled: false });
        const inner = circleOutline({ ...shape, radius: Math.max(0.001, shape.radius - halfWidth), filled: false }).reverse();
        return outlinePathD(outer) + ' ' + outlinePathD(inner);
    }
    if (!geometry.filled && geometry.strokeSegments.length) {
        return geometry.strokeSegments
            .map((segment) => outlinePathD(openStrokeOutline(
                [segment.start, segment.end], segment.lineWidth / 2)))
            .join(' ');
    }
    const centerline = shape.kind === 'arc' ? arcSamples(shape) : geometry.centerline;
    if (!geometry.centerlineClosed) return outlinePathD(openStrokeOutline(centerline, halfWidth));
    const outer = filledShapeOutline(shape, halfWidth);
    const inner = filledShapeOutline(shape, -halfWidth).reverse();
    return outlinePathD(outer) + ' ' + outlinePathD(inner);
}

/** Bounds including the visible line width, for shared selection queries. */
export function boardShapeBounds(shape) {
    const outline = shapeOutline(shape);
    const halfWidth = boardShapeMaxLineWidth(shape) / 2;
    if (!outline.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    let minX = outline[0].x, maxX = outline[0].x;
    let minY = outline[0].y, maxY = outline[0].y;
    for (const point of outline.slice(1)) {
        minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
        minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
    }
    return { minX: minX - halfWidth, minY: minY - halfWidth, maxX: maxX + halfWidth, maxY: maxY + halfWidth };
}

/** Shared point hit test for board shapes and their selection adapter. */
export function boardShapeHitTest(shape, worldPos, tolerance = 0) {
    if (!shape || !worldPos) return false;
    if (shapeIsFilled(shape) && pointInPolygon(worldPos, shapeOutline(shape))) return true;
    return boardShapeStrokeSegments(shape).some((segment) => {
        const edgeTolerance = Math.max(tolerance, segment.lineWidth / 2 + 0.12);
        return distanceToSegment(worldPos, segment.start, segment.end) <= edgeTolerance;
    });
}

/**
 * SVG path data for a shape. Rectangles and polygons are always closed; arcs
 * are closed only when `close` is set, and lines remain open.
 */
export function shapePathD(shape, { close = false } = {}) {
    if (shape.kind === 'arc') {
        const g = arcGeom(shape);
        if (!g) {
            return `M ${r4(shape.start.x)} ${r4(shape.start.y)} L ${r4(shape.end.x)} ${r4(shape.end.y)}`;
        }
        const cross = (shape.end.x - shape.start.x) * (shape.bulge.y - shape.start.y)
            - (shape.end.y - shape.start.y) * (shape.bulge.x - shape.start.x);
        const sweep = cross > 0 ? 0 : 1;
        const rad = r4(g.radius);
        let d = `M ${r4(shape.start.x)} ${r4(shape.start.y)}`
            + ` A ${rad} ${rad} 0 0 ${sweep} ${r4(shape.end.x)} ${r4(shape.end.y)}`;
        if (close) d += ' Z';
        return d;
    }
    if (shape.kind === 'circle') {
        const radius = Math.max(0.05, Number(shape.radius) || 0);
        const x = r4(shape.x);
        const y = r4(shape.y);
        const rad = r4(radius);
        return `M ${r4(shape.x - radius)} ${y}`
            + ` A ${rad} ${rad} 0 1 0 ${r4(shape.x + radius)} ${y}`
            + ` A ${rad} ${rad} 0 1 0 ${r4(shape.x - radius)} ${y} Z`;
    }
    if (shape.kind === 'rect' && rectCornerRadius(shape) > 0
        && !Object.keys(shape.nodeCornerRadii || {}).length) {
        const bounds = rectBounds(shape);
        const radius = rectCornerRadius(shape);
        if (!bounds) return '';
        const { minX, maxX, minY, maxY } = bounds;
        return `M ${r4(minX + radius)} ${r4(minY)}`
            + ` L ${r4(maxX - radius)} ${r4(minY)}`
            + ` A ${r4(radius)} ${r4(radius)} 0 0 1 ${r4(maxX)} ${r4(minY + radius)}`
            + ` L ${r4(maxX)} ${r4(maxY - radius)}`
            + ` A ${r4(radius)} ${r4(radius)} 0 0 1 ${r4(maxX - radius)} ${r4(maxY)}`
            + ` L ${r4(minX + radius)} ${r4(maxY)}`
            + ` A ${r4(radius)} ${r4(radius)} 0 0 1 ${r4(minX)} ${r4(maxY - radius)}`
            + ` L ${r4(minX)} ${r4(minY + radius)}`
            + ` A ${r4(radius)} ${r4(radius)} 0 0 1 ${r4(minX + radius)} ${r4(minY)} Z`;
    }
    if ((shape.kind === 'polygon' || shape.kind === 'rect') && roundedPolygonCorners(shape).length) {
        return roundedPolygonPath(shape);
    }
    const pts = shape.points || [];
    if (!pts.length) return '';
    let d = `M ${r4(pts[0].x)} ${r4(pts[0].y)}`;
    for (let i = 1; i < pts.length; i++) d += ` L ${r4(pts[i].x)} ${r4(pts[i].y)}`;
    return shape.kind === 'line' ? d : d + ' Z';
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
        shape.start = { ...geom.start };
        shape.end = { ...geom.end };
        shape.bulge = { ...geom.bulge };
    } else if (shape.kind === 'circle') {
        shape.x = geom.x;
        shape.y = geom.y;
        shape.radius = geom.radius;
    } else {
        shape.points = (geom.points || []).map((p) => ({ x: p.x, y: p.y }));
    }
}

function geomAnchor(geom) {
    return geom.points ? geom.points[0] : geom.start || geom;
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

/** Base display color for the shape's PCB layer. */
export function shapeLayerColor(shape) {
    return PCB_LAYERS.find((layer) => layer.id === shape?.layer)?.color || '#ffffff';
}

/** Selection is a lighter version of the owning layer, not a fixed side color. */
export function shapeSelectionColor(shape) {
    const color = shapeLayerColor(shape);
    const channels = color.match(/[\da-f]{2}/gi);
    if (!channels || channels.length !== 3) return color;
    return `#${channels.map((channel) => {
        const value = parseInt(channel, 16);
        return Math.round(value + (255 - value) * 0.35).toString(16).padStart(2, '0');
    }).join('')}`;
}

/** Hover is a subtle lightening of the owning layer color. */
export function shapeHoverColor(shape) {
    const color = shapeLayerColor(shape);
    const channels = color.match(/[\da-f]{2}/gi);
    if (!channels || channels.length !== 3) return color;
    return `#${channels.map((channel) => {
        const value = parseInt(channel, 16);
        return Math.round(value + (255 - value) * 0.18).toString(16).padStart(2, '0');
    }).join('')}`;
}

function shapeStyle(shape) {
    const layer = String(shape.layer || 'top-silk');
    const isHoleLayer = layer === 'hole';
    const isCopperLayer = layer === 'top-copper' || layer === 'bottom-copper';
    const isMaskLayer = layer === 'top-mask' || layer === 'bottom-mask';
    const isDocumentLayer = layer === 'document' || layer === 'top-document' || layer === 'bottom-document';
    const copperMode = normalizeShapeCopperMode(shape.copperMode);
    const isCopperAdd = isCopperLayer && copperMode === 'add';
    const isCopperRemoveOnly = isCopperLayer && copperMode === 'remove-copper';
    const isCopperRemoveSolderMask = isCopperLayer && copperMode === 'remove-solder-mask';
    const isCopperRemoveMask = isCopperLayer && copperMode === 'remove-copper-mask';
    const isCopperRemoval = isCopperRemoveOnly || isCopperRemoveSolderMask || isCopperRemoveMask;
    const isCopperKnockout = isCopperRemoveOnly || isCopperRemoveMask;
    const layerColor = shapeLayerColor(shape);
    const copperColor = layerColor;
    const filled = shapeIsFilled(shape);
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

/** True when a shape reads as a solid region for hit-testing. */
export function shapeIsFilled(shape) {
    if (shape?.kind === 'line') return false;
    const layer = String(shape.layer || 'top-silk');
    // A hole-layer shape is a board cutout — its whole interior is clickable.
    if (layer === 'hole') return true;
    const isCopperLayer = layer === 'top-copper' || layer === 'bottom-copper';
    if (isCopperLayer) {
        return !!shape.filled;
    }
    return !!shape.filled || isMaskOrDocLayer(layer);
}

/** Minimum manufacturable outline/slot width for a board shape. */
export function boardShapeLineWidthMinimum(shape) {
    return shape?.kind === 'line' && shape?.layer === 'hole' ? 0.8 : 0.05;
}

function normalizedBoardShapeLineWidth(shape, value) {
    const minimum = boardShapeLineWidthMinimum(shape);
    return Math.max(minimum, Number(value) || Math.max(0.2, minimum));
}

export function boardShapeSegmentWidth(shape, segment) {
    return normalizedBoardShapeLineWidth(shape,
        shape?.segmentWidths?.[segment] ?? shape?.lineWidth);
}

function boardShapeMaxLineWidth(shape) {
    const widths = Object.values(shape?.segmentWidths || {}).map(Number).filter(Number.isFinite);
    return Math.max(normalizedBoardShapeLineWidth(shape, shape?.lineWidth), ...widths);
}

/**
 * Resolve a board shape into the common geometry contract consumed by the
 * 2D/3D previews, Gerber exporter, and copper-fill engine.
 */
export function resolveBoardShapeGeometry(shape, options = {}) {
    const lineWidth = Math.max(0.05, Number(shape?.lineWidth) || 0.2);
    const filled = options.filled ?? shapeIsFilled(shape);
    const centerlineShape = { ...shape, filled: false };
    const centerline = shape?.kind === 'arc'
        ? arcSamples(shape)
        : shape?.kind === 'circle'
            ? circleOutline(centerlineShape)
            : shape?.kind === 'rect' || shape?.kind === 'polygon'
                ? shapeOutline(centerlineShape)
                : (shape?.points || []).map((point) => ({ ...point }));
    const centerlineClosed = shape?.kind === 'rect' || shape?.kind === 'polygon';
    const radius = Math.max(0.05, Number(shape?.radius) || 0);
    const areaOutline = filled && shape?.kind !== 'line'
        ? centerline.map((point) => ({ ...point }))
        : null;
    const strokeSegments = ['line', 'rect', 'polygon'].includes(shape?.kind)
        && Object.keys(shape?.segmentWidths || {}).length > 0
        ? boardShapeStrokeSegments(shape).map(({ start, end, lineWidth }) => ({
            start: { ...start }, end: { ...end }, lineWidth,
        }))
        : [];
    return {
        path: shape?.kind === 'circle' ? [] : centerline,
        pathClosed: filled || centerlineClosed,
        centerline,
        centerlineClosed,
        areaOutline,
        circle: shape?.kind === 'circle'
            ? { x: shape.x, y: shape.y, radius, outerRadius: filled ? radius + lineWidth / 2 : radius }
            : null,
        filled,
        lineWidth,
        strokeSegments,
        copperMode: normalizeShapeCopperMode(shape?.copperMode),
    };
}

// ── Render ───────────────────────────────────────────────────────────────────

export function renderBoardShape(app, shape, opts = {}) {
    removeBoardShapeElement(app, shape.id, { skipHatchUpdate: true });
    const selectedSegment = app._selectedBoardShapeSegment?.shapeId === shape.id
        && isPcbSelected(app, 'shape', shape)
        ? app._selectedBoardShapeSegment.segment
        : null;
    const supportsSegmentRendering = !shapeAffectsCopperCuts(shape)
        && ['line', 'rect', 'polygon'].includes(shape.kind);
    const renderAsSegments = supportsSegmentRendering
        && ((!shapeIsFilled(shape) && Object.keys(shape.segmentWidths || {}).length > 0)
            || selectedSegment != null);
    const el = document.createElementNS(NS, renderAsSegments ? 'g' : 'path');
    const isSelected = isPcbSelected(app, 'shape', shape)
        && app._selectedBoardShapeSegment?.shapeId !== shape.id;
    const isHovered = !!(app._hoveredShape && app._hoveredShape.id === shape.id)
        && app._selectedBoardShapeSegment?.shapeId !== shape.id;
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
    if (st.isCopperKnockout && !isSelected && !st.filled) el.setAttribute('stroke-dasharray', '0.6 0.45');
    el.setAttribute('data-board-shape-layer', shape.layer || '');
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
    if (!opts.liveDrag || st.isCopperRemoval) app._scheduleRemovalHatchRender?.();
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

/** Draggable anchor points for a shape: vertices, arc controls, or circle centre/radius. */
function shapeHandlePoints(shape) {
    if (shape.kind === 'arc') {
        return [
            { key: 'start', x: shape.start.x, y: shape.start.y },
            { key: 'end', x: shape.end.x, y: shape.end.y },
            { key: 'bulge', x: shape.bulge.x, y: shape.bulge.y },
        ];
    }
    if (shape.kind === 'circle') {
        return [
            { key: 'center', x: shape.x, y: shape.y, cursor: 'move' },
            { key: 'radius', x: shape.x + shape.radius, y: shape.y, cursor: 'ew-resize' },
        ];
    }
    return (shape.points || []).map((p, i) => ({ key: i, x: p.x, y: p.y }));
}

/** Midpoint insertion handles belong to editable open and closed polylines. */
function shapeMidpointHandles(shape) {
    if (!['line', 'polygon', 'rect'].includes(shape.kind) || !Array.isArray(shape.points) || shape.points.length < 2) return [];
    const count = shape.kind === 'line' ? shape.points.length - 1 : shape.points.length;
    return shape.points.slice(0, count).map((point, index) => {
        const next = shape.points[shape.kind === 'line' ? index + 1 : (index + 1) % shape.points.length];
        return {
            key: `mid:${index}`,
            x: (point.x + next.x) / 2,
            y: (point.y + next.y) / 2,
            midpoint: true,
            cursor: 'copy',
        };
    });
}

/** Anchors exposed through the common PCB selection adapter contract. */
export function getBoardShapeAnchors(shape) {
    const vertices = shapeHandlePoints(shape).map((anchor) => ({
        ...anchor,
        id: anchor.key,
        cursor: anchor.cursor || 'nwse-resize',
        round: anchor.key === 'bulge',
        fill: anchor.key === 'bulge' ? '#33dd77' : '#ffffff',
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
    applyBoardShapeVertexResize(shape, { before, handle: anchorId }, app._snapToGrid(worldPos));
    renderBoardShape(app, shape, { liveDrag: true });
}

function selectBoardShapeSegmentAt(app, shape, worldPos) {
    const segment = polygonSegmentIndexAt(shape, worldPos,
        Math.max(0.3, 8 / Math.max(0.01, app.viewport?.scale || 1)));
    app._selectedBoardShapeSegment = segment == null ? null : { shapeId: shape.id, segment };
    app._selectedBoardShapeNode = null;
    renderBoardShape(app, shape);
    if (segment == null) renderBoardShapeHandles(app, shape);
    else clearBoardShapeHandles(app);
    renderBoardShapeSegmentSelection(app);
    app._setPcbStatus?.();
    return segment;
}

/** Full SelectionManager adapter for rectangle, polygon, and arc objects. */
export function createBoardShapeSelectionAdapter(app, shape, id) {
    let moveOptions = {};
    return {
        id,
        kind: 'shape',
        object: shape,
        get visible() {
            return !isLayerLocked(shape.layer) && isLayerVisible(shape.layer);
        },
        getBounds() { return boardShapeBounds(shape); },
        hitTest(point, tolerance) { return boardShapeHitTest(shape, point, tolerance); },
        getAnchors() { return getBoardShapeAnchors(shape); },
        moveAnchor(anchorId, x, y) { moveBoardShapeAnchor(app, shape, anchorId, { x, y }); },
        beginAnchorDrag(anchorId, worldPos) { return startBoardShapeDrag(app, shape, worldPos, anchorId); },
        updateAnchorDrag(worldPos) { handleBoardShapeDrag(app, worldPos); },
        endAnchorDrag(commit, options = {}) {
            const drag = app._shapeDrag;
            if (commit && drag && !options.moved && !options.place
                && typeof drag.sourceAnchorId === 'number'
                && ['rect', 'polygon'].includes(shape.kind)) {
                app._selectedBoardShapeSegment = null;
                app._selectedBoardShapeNode = { shapeId: shape.id, index: drag.sourceAnchorId };
                showBoardShapeProperties(app, shape);
                renderBoardShapeHandles(app, shape);
                return { floating: true };
            }
            if (commit && drag && !options.moved && !options.place) {
                return { floating: true };
            }
            endBoardShapeDrag(app, commit);
        },
        beginMove(worldPos, options = {}) {
            const pressedSegment = polygonSegmentIndexAt(shape, worldPos,
                Math.max(0.3, 8 / Math.max(0.01, app.viewport?.scale || 1)));
            moveOptions = { ...options, pressedSegment };
            app._selectedBoardShapeNode = null;
            if (!options.alreadySelected) {
                app._boardShapeSegmentClickCandidate = pressedSegment == null
                    ? null
                    : { shapeId: shape.id, segment: pressedSegment };
            }
            return startBoardShapeDrag(app, shape, worldPos, null,
                { allowSegment: pressedSegment === options.selectedSegment?.segment });
        },
        updateMove(worldPos) { handleBoardShapeDrag(app, worldPos); },
        endMove(commit, options = {}) {
            endBoardShapeDrag(app, commit);
            if (!commit || options.moved || !moveOptions.alreadySelected) return;
            if (moveOptions.selectedSegment) {
                app._selectedBoardShapeSegment = null;
                app._boardShapeSegmentClickCandidate = moveOptions.pressedSegment == null
                    ? null
                    : { shapeId: shape.id, segment: moveOptions.pressedSegment };
                renderBoardShape(app, shape);
                renderBoardShapeHandles(app, shape);
                renderBoardShapeSegmentSelection(app);
                app._setPcbStatus?.();
            } else {
                const candidateMatches = app._boardShapeSegmentClickCandidate?.shapeId === shape.id
                    && app._boardShapeSegmentClickCandidate.segment === moveOptions.pressedSegment;
                if (candidateMatches && moveOptions.pressedSegment != null) {
                    selectBoardShapeSegmentAt(app, shape, options.startWorld);
                } else {
                    app._boardShapeSegmentClickCandidate = moveOptions.pressedSegment == null
                        ? null
                        : { shapeId: shape.id, segment: moveOptions.pressedSegment };
                }
            }
            showBoardShapeProperties(app, shape);
        },
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
        // Keep the diagonally-opposite corner fixed; rebuild an axis-aligned rect.
        const opp = drag.before.points[(drag.handle + 2) % 4];
        const minx = Math.min(snap.x, opp.x), maxx = Math.max(snap.x, opp.x);
        const miny = Math.min(snap.y, opp.y), maxy = Math.max(snap.y, opp.y);
        shape.points = [
            { x: minx, y: miny }, { x: maxx, y: miny },
            { x: maxx, y: maxy }, { x: minx, y: maxy },
        ];
        return;
    }
    if (Array.isArray(shape.points) && typeof drag.handle === 'number' && shape.points[drag.handle]) {
        shape.points[drag.handle] = { x: snap.x, y: snap.y };
    }
}

function polygonSegmentIndexAt(shape, worldPos, tolerance) {
    if (!['line', 'polygon', 'rect'].includes(shape.kind) || !Array.isArray(shape.points) || shape.points.length < 2) return null;
    let bestIndex = null;
    let bestDistance = tolerance;
    const count = shape.kind === 'line' ? shape.points.length - 1 : shape.points.length;
    for (let index = 0; index < count; index++) {
        const point = shape.points[index];
        const next = shape.points[shape.kind === 'line' ? index + 1 : (index + 1) % shape.points.length];
        const distance = distanceToSegment(worldPos, point, next);
        if (distance <= bestDistance) {
            bestDistance = distance;
            bestIndex = index;
        }
    }
    return bestIndex;
}

function polygonVertexSnap(app, before, index, worldPos, closed) {
    const points = before.points || [];
    if (points.length < 2) return app._snapToGrid(worldPos);
    const neighbours = [];
    if (index > 0 || closed) neighbours.push(points[(index + points.length - 1) % points.length]);
    if (index < points.length - 1 || closed) neighbours.push(points[(index + 1) % points.length]);
    if (!neighbours.length) return app._snapToGrid(worldPos);
    const fallback = app._snapToGrid(worldPos);
    const threshold = 8 / Math.max(0.01, app.viewport?.scale || 1);
    let best = null;
    for (const neighbour of neighbours) {
        const candidates = [
            { axis: 'horizontal', point: { x: fallback.x, y: neighbour.y } },
            { axis: 'vertical', point: { x: neighbour.x, y: fallback.y } },
        ];
        const dx = worldPos.x - neighbour.x;
        const dy = worldPos.y - neighbour.y;
        if (Math.abs(dx) >= Math.abs(dy)) {
            candidates.push({ axis: 'diagonal', point: { x: fallback.x, y: neighbour.y + (Math.sign(dy) || 1) * Math.abs(dx) } });
        } else {
            candidates.push({ axis: 'diagonal', point: { x: neighbour.x + (Math.sign(dx) || 1) * Math.abs(dy), y: fallback.y } });
        }
        for (const candidate of candidates) {
            const distance = Math.hypot(candidate.point.x - worldPos.x, candidate.point.y - worldPos.y);
            if (distance <= threshold && (!best || distance < best.distance)) {
                best = { ...candidate, distance };
            }
        }
    }
    return best?.point || fallback;
}

function polygonAxisKind(a, b) {
    const dx = Math.abs(b.x - a.x);
    const dy = Math.abs(b.y - a.y);
    if (dx < 1e-6) return 'vertical';
    if (dy < 1e-6) return 'horizontal';
    if (Math.abs(dx - dy) < 1e-6) return 'diagonal';
    return null;
}

function clearPolygonAxisIndicators(app) {
    clearAxisGlow(app);
}

function renderPolygonAxisIndicators(app, shape, indices, excludedSegments = []) {
    if (!['line', 'polygon'].includes(shape.kind) || !shape.points?.length) {
        clearAxisGlow(app);
        return;
    }
    const excluded = new Set(excludedSegments);
    const seen = new Set();
    const segments = [];
    for (const index of (Array.isArray(indices) ? indices : [indices])) {
        if (!Number.isInteger(index) || !shape.points[index]) continue;
        const point = shape.points[index];
        const neighbourIndices = [];
        if (index > 0 || shape.kind === 'polygon') neighbourIndices.push((index + shape.points.length - 1) % shape.points.length);
        if (index < shape.points.length - 1 || shape.kind === 'polygon') neighbourIndices.push((index + 1) % shape.points.length);
        for (const neighbourIndex of neighbourIndices) {
            const key = [index, neighbourIndex].sort((a, b) => a - b).join(':');
            if (seen.has(key)) continue;
            seen.add(key);
            const segmentIndex = shape.kind === 'line'
                ? Math.min(index, neighbourIndex)
                : neighbourIndex === (index + shape.points.length - 1) % shape.points.length
                    ? neighbourIndex
                    : index;
            if (excluded.has(segmentIndex)) continue;
            const neighbour = shape.points[neighbourIndex];
            const axis = polygonAxisKind(point, neighbour);
            if (!axis) continue;
            segments.push({
                a: point,
                b: neighbour,
                layerId: shape.layer,
                width: Math.max(0.05, Number(shape.lineWidth) || 0.2),
                axisKind: axis === 'horizontal' ? 'h' : axis === 'vertical' ? 'v' : 'd',
            });
        }
    }
    renderAxisGlow(app, segments);
}

/** Snap a parallel segment drag when either adjoining segment reaches H/V/45. */
function snapPolylineSegmentDrag(app, shape, before, segment, worldPos) {
    const points = before.points || [];
    const firstIndex = segment;
    const secondIndex = shape.kind === 'line' ? segment + 1 : (segment + 1) % points.length;
    const first = points[firstIndex];
    if (!first) return { dx: 0, dy: 0 };
    const raw = { x: worldPos.x - before.startWorld.x, y: worldPos.y - before.startWorld.y };
    const snappedStart = app._snapToGrid({ x: first.x + raw.x, y: first.y + raw.y });
    const fallback = { dx: snappedStart.x - first.x, dy: snappedStart.y - first.y };
    const threshold = 8 / Math.max(0.01, app.viewport?.scale || 1);
    const candidates = [];
    const addConstraints = (movingIndex, fixedIndex) => {
        if (fixedIndex < 0 || fixedIndex >= points.length) return;
        const moving = points[movingIndex];
        const fixed = points[fixedIndex];
        if (!moving || !fixed) return;
        const target = { x: moving.x + raw.x, y: moving.y + raw.y };
        const constrained = [
            { x: fallback.dx, y: fixed.y - moving.y },
            { x: fixed.x - moving.x, y: fallback.dy },
        ];
        const dx = target.x - fixed.x;
        const dy = target.y - fixed.y;
        if (Math.abs(dx) >= Math.abs(dy)) {
            constrained.push({ x: fallback.dx, y: fixed.y + (Math.sign(dy) || 1) * Math.abs(dx) - moving.y });
        } else {
            constrained.push({ x: fixed.x + (Math.sign(dx) || 1) * Math.abs(dy) - moving.x, y: fallback.dy });
        }
        for (const candidate of constrained) {
            const distance = Math.hypot(candidate.x - raw.x, candidate.y - raw.y);
            if (distance <= threshold) candidates.push({ ...candidate, distance });
        }
    };
    const closed = shape.kind !== 'line';
    addConstraints(firstIndex, firstIndex > 0 ? firstIndex - 1 : closed ? points.length - 1 : -1);
    addConstraints(secondIndex, secondIndex < points.length - 1 ? secondIndex + 1 : closed ? 0 : -1);
    const best = candidates.sort((a, b) => a.distance - b.distance)[0];
    return best ? { dx: best.x, dy: best.y } : fallback;
}

/** Remove redundant straight-through waypoints after a polyline edit. */
function collapseCollinearPolylinePoints(shape) {
    if (!['line', 'polygon'].includes(shape.kind) || !Array.isArray(shape.points)) return false;
    const closed = shape.kind === 'polygon';
    const minimum = closed ? 3 : 2;
    let changed = false;
    let keep = true;
    while (keep && shape.points.length > minimum) {
        keep = false;
        const points = shape.points;
        const start = closed ? 0 : 1;
        const end = closed ? points.length : points.length - 1;
        for (let index = start; index < end; index++) {
            const previous = points[(index + points.length - 1) % points.length];
            const point = points[index];
            const next = points[(index + 1) % points.length];
            const cross = Math.abs((point.x - previous.x) * (next.y - point.y)
                - (point.y - previous.y) * (next.x - point.x));
            const length = Math.hypot(next.x - previous.x, next.y - previous.y);
            if (length > 1e-9 && cross / length < 1e-6) {
                points.splice(index, 1);
                remapBoardShapeNodeRadii(shape, index, -1);
                changed = true;
                keep = true;
                break;
            }
        }
    }
    return changed;
}

function remapBoardShapeNodeRadii(shape, index, delta) {
    const remapped = {};
    for (const [key, radius] of Object.entries(shape.nodeCornerRadii || {})) {
        const nodeIndex = Number(key);
        if (!Number.isInteger(nodeIndex) || (delta < 0 && nodeIndex === index)) continue;
        remapped[nodeIndex < index ? nodeIndex : nodeIndex + delta] = radius;
    }
    shape.nodeCornerRadii = remapped;
}

function splitBoardShapeSegmentWidths(shape, segment) {
    const remapped = {};
    for (const [key, width] of Object.entries(shape.segmentWidths || {})) {
        const index = Number(key);
        if (!Number.isInteger(index)) continue;
        if (index < segment) remapped[index] = width;
        else if (index === segment) {
            remapped[index] = width;
            remapped[index + 1] = width;
        } else remapped[index + 1] = width;
    }
    shape.segmentWidths = remapped;
}

export function deleteSelectedBoardShape(app) {
    const s = getPcbSelection(app, 'shape')[0] || null;
    if (!s) return false;
    if (isLayerLocked(s.layer)) return false;
    app.history.execute(new RemoveBoardShapeCommand(app, s));
    selectBoardShape(app, null);
    app._clearProperties?.();
    return true;
}

// ── Drag (move whole shape) ──────────────────────────────────────────────────

export function startBoardShapeDrag(app, shape, worldPos, anchorId = null, options = {}) {
    if (!shape || isLayerLocked(shape.layer)) return false;
    const before = cloneShapeGeometry(shape);
    const beforeState = shapeSnapshot(shape);
    let handle = typeof anchorId === 'number' ? anchorId : hitTestBoardShapeVertex(app, shape, worldPos);
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
            splitBoardShapeSegmentWidths(shape, segment);
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
    if (mode !== 'segment') app._selectedBoardShapeSegment = null;
    renderBoardShapeSegmentSelection(app);
    app._setPcbStatus?.();
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
        startWorld: { x: worldPos.x, y: worldPos.y },
        before,
        beforeState,
        sourceAnchorId: anchorId,
        ratsnestNets,
        previousDeferDragOverlays: !!app._deferDragOverlays,
    };
    app._deferDragOverlays = true;
    const vertex = handle != null
        ? shapeHandlePoints(shape).find((point) => point.key === handle)
        : null;
    app.viewport?.setCrosshair(vertex || geomAnchor(before));
    return true;
}

export function handleBoardShapeDrag(app, worldPos) {
    const d = app._shapeDrag;
    if (!d) return;
    const s = app.boardShapes.find((x) => x.id === d.id);
    if (!s) return;
    if (d.mode === 'vertex') {
        const snap = ['line', 'polygon'].includes(s.kind) && typeof d.handle === 'number'
            ? polygonVertexSnap(app, d.before, d.handle, worldPos, d.beforeState.kind !== 'line')
            : app._snapToGrid(worldPos);
        applyBoardShapeVertexResize(s, d, snap);
        if (s.kind === 'polygon') normalizeBoardPolylineKind(s);
        else if (s.kind === 'line') closeBoardLineIfCoincident(s, d.handle);
        if (s.kind === 'line') {
            const target = findBoardLineJoinTarget(app, s, d.handle, worldPos);
            d.joinTarget = target;
            if (target) s.points[d.handle] = { ...target.point };
        }
        const handle = shapeHandlePoints(s).find((point) => point.key === d.handle);
        app.viewport?.setCrosshair(handle || snap);
        renderBoardShape(app, s, { liveDrag: true });
        renderBoardShapeHandles(app, s);
        if (['line', 'polygon'].includes(s.kind)) renderPolygonAxisIndicators(app, s, d.handle);
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
        app.viewport?.setCrosshair(s.points[firstIndex]);
        normalizeBoardPolylineKind(s);
        renderBoardShape(app, s, { liveDrag: true });
        renderBoardShapeHandles(app, s);
        renderBoardShapeSegmentSelection(app);
        if (['line', 'polygon'].includes(s.kind)) {
            renderPolygonAxisIndicators(app, s, [firstIndex, secondIndex], [d.segment]);
        }
        if (d.ratsnestNets) app._updateRatsnest?.({ nets: d.ratsnestNets });
        return;
    }
    const dx = worldPos.x - d.startWorld.x;
    const dy = worldPos.y - d.startWorld.y;
    // Snap by the shape's anchor point so the whole shape lands on the grid.
    const anchor = geomAnchor(d.before);
    const snapped = app._snapToGrid({ x: anchor.x + dx, y: anchor.y + dy });
    applyShapeGeometry(s, translateShapeGeometry(d.before, snapped.x - anchor.x, snapped.y - anchor.y));
    app.viewport?.setCrosshair(snapped);
    renderBoardShape(app, s, { liveDrag: true });
    renderBoardShapeHandles(app, s);
    if (d.ratsnestNets) app._updateRatsnest?.({ nets: d.ratsnestNets });
}

export function endBoardShapeDrag(app, commit) {
    const d = app._shapeDrag;
    app._shapeDrag = null;
    app.viewport?.hideCrosshair();
    clearPolygonAxisIndicators(app);
    if (!d) return;
    app._deferDragOverlays = d.previousDeferDragOverlays;
    const s = app.boardShapes.find((x) => x.id === d.id);
    if (!s) return;
    const target = d.joinTarget?.shape;
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
    if ((d.mode === 'vertex' || d.mode === 'segment') && !closedOpenLine) {
        collapseCollinearPolylinePoints(s);
    }
    const after = cloneShapeGeometry(s);
    const afterState = shapeSnapshot(s);
    const moved = JSON.stringify(afterState) !== JSON.stringify(d.beforeState);
    // Roll back first, then commit through history so undo is exact.
    applyShapeSnapshot(s, d.beforeState);
    renderBoardShape(app, s);
    if (!moved || !commit) {
        renderBoardShapeHandles(app, s);
        renderBoardShapeSegmentSelection(app);
        return;
    }
    const kindChanged = afterState.kind !== d.beforeState.kind;
    const segmentWidthsChanged = JSON.stringify(afterState.segmentWidths || {})
        !== JSON.stringify(d.beforeState.segmentWidths || {});
    app.history.execute(kindChanged || segmentWidthsChanged
        ? new ModifyBoardShapeCommand(app, s, d.beforeState, afterState)
        : new MoveBoardShapeCommand(app, s, d.before, after));
    renderBoardShapeHandles(app, s);
    renderBoardShapeSegmentSelection(app);
}

/** Open a polygon or rectangle at a vertex, preserving the ordered chain. */
export function openBoardShape(app, shape, vertexIndex = 0) {
    if (!shape || !['polygon', 'rect'].includes(shape.kind) || isLayerLocked(shape.layer)) return false;
    const points = shape.points || [];
    if (points.length < 3) return false;
    const before = shapeSnapshot(shape);
    const start = Math.max(0, Math.min(points.length - 1, Number(vertexIndex) || 0));
    shape.points = [...points.slice(start), ...points.slice(0, start)].map((point) => ({ ...point }));
    shape.kind = 'line';
    shape.filled = false;
    shape.cornerRadius = undefined;
    const after = shapeSnapshot(shape);
    applyShapeSnapshot(shape, before);
    app.history.execute(new ModifyBoardShapeCommand(app, shape, before, after));
    return true;
}

/** Delete a polyline vertex; a triangle reduces to an open two-point Line. */
export function deleteBoardShapeVertex(app, shape, vertexIndex) {
    if (!shape || !['line', 'polygon', 'rect'].includes(shape.kind) || isLayerLocked(shape.layer)) return false;
    const points = shape.points || [];
    if (!Number.isInteger(vertexIndex) || vertexIndex < 0 || vertexIndex >= points.length) return false;
    if (shape.kind === 'line' && points.length <= 2) return false;
    const before = shapeSnapshot(shape);
    if (shape.kind === 'rect') {
        shape.kind = 'polygon';
        shape.cornerRadius = undefined;
    }
    shape.points.splice(vertexIndex, 1);
    remapBoardShapeNodeRadii(shape, vertexIndex, -1);
    normalizeBoardPolylineKind(shape);
    const after = shapeSnapshot(shape);
    applyShapeSnapshot(shape, before);
    app.history.execute(new ModifyBoardShapeCommand(app, shape, before, after));
    return true;
}

/** Remove the currently-open board-shape context menu. */
export function dismissBoardShapeContextMenu() {
    const menu = document.getElementById('pcbBoardShapeContextMenu');
    if (!menu) return;
    const handlers = /** @type {any} */ (menu)._dismiss;
    if (handlers) {
        document.removeEventListener('mousedown', handlers.dismiss, { capture: true });
        document.removeEventListener('keydown', handlers.onKey, { capture: true });
    }
    menu.remove();
}

/** Show topology actions for a Line, Polygon, or Rectangle. */
export function showBoardShapeContextMenu(app, shape, clientX, clientY, worldPos) {
    dismissBoardShapeContextMenu();
    if (!shape || !['line', 'polygon', 'rect'].includes(shape.kind) || isLayerLocked(shape.layer)) return;
    selectBoardShape(app, shape);
    const vertexIndex = hitTestBoardShapeVertex(app, shape, worldPos);
    const items = [];
    if (shape.kind === 'polygon' || shape.kind === 'rect') {
        items.push({ text: 'Open shape', onClick: () => openBoardShape(app, shape, typeof vertexIndex === 'number' ? vertexIndex : 0) });
    }
    if (typeof vertexIndex === 'number'
        && !(shape.kind === 'line' && shape.points.length <= 2)) {
        items.push({ text: 'Delete vertex', onClick: () => deleteBoardShapeVertex(app, shape, vertexIndex) });
    }
    if (!items.length) return;

    const menu = document.createElement('div');
    menu.id = 'pcbBoardShapeContextMenu';
    menu.style.cssText = `position:fixed;z-index:10000;background:#2b2b2b;border:1px solid #555;border-radius:4px;padding:2px 0;box-shadow:0 2px 8px rgba(0,0,0,0.4);min-width:120px;left:${clientX}px;top:${clientY}px;`;
    for (const item of items) {
        const element = document.createElement('div');
        element.textContent = item.text;
        element.style.cssText = 'padding:6px 16px;color:#eee;cursor:pointer;font:13px/1.4 system-ui,sans-serif;white-space:nowrap;';
        element.addEventListener('mouseenter', () => { element.style.background = '#3a3a3a'; });
        element.addEventListener('mouseleave', () => { element.style.background = ''; });
        element.addEventListener('click', () => {
            dismissBoardShapeContextMenu();
            item.onClick();
            app._refreshPcbSelectionHighlights?.();
        });
        menu.appendChild(element);
    }
    menu.addEventListener('contextmenu', (event) => event.preventDefault());
    document.body.appendChild(menu);
    const dismiss = (event) => {
        if (!menu.contains(/** @type {Node|null} */ (event.target))) dismissBoardShapeContextMenu();
    };
    const onKey = (event) => {
        if (event.key === 'Escape') dismissBoardShapeContextMenu();
    };
    setTimeout(() => {
        document.addEventListener('mousedown', dismiss, { capture: true });
        document.addEventListener('keydown', onKey, { capture: true });
    }, 0);
    /** @type {any} */ (menu)._dismiss = { dismiss, onKey };
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

function rectPreviewPath(a, b, cornerRadius = 0) {
    const minx = Math.min(a.x, b.x), maxx = Math.max(a.x, b.x);
    const miny = Math.min(a.y, b.y), maxy = Math.max(a.y, b.y);
    return shapePathD({
        kind: 'rect',
        cornerRadius,
        points: [
            { x: minx, y: miny }, { x: maxx, y: miny },
            { x: maxx, y: maxy }, { x: minx, y: maxy },
        ],
    });
}

/** Left-click while a shape tool is active. */
export function shapeDrawClick(app, kind, worldPos) {
    if (!SHAPE_KINDS.has(kind)) return;
    const snap = app._snapToGrid(worldPos);
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
    d.points.push({ x: snap.x, y: snap.y });
    if ((kind === 'rect' || kind === 'circle') && d.points.length >= 2) finishShapeDraw(app);
    else if (kind === 'arc' && d.points.length >= 3) finishShapeDraw(app);
    else updateShapeDrawPreview(app, worldPos);
}

/** Live preview as the cursor moves (cursor acts as the pending next point). */
export function updateShapeDrawPreview(app, worldPos) {
    const d = app._shapeDraw;
    if (!d) return;
    const p = app._snapToGrid(worldPos);
    let dstr = '';
    if (d.kind === 'line') {
        const points = [...d.points, p];
        dstr = `M ${points[0].x} ${points[0].y}` + points.slice(1).map((point) => ` L ${point.x} ${point.y}`).join('');
    } else if (d.kind === 'rect') {
        dstr = rectPreviewPath(d.points[0], p, app._shapeDefaults?.cornerRadius);
    } else if (d.kind === 'circle') {
        dstr = shapePathD({
            kind: 'circle',
            x: d.points[0].x,
            y: d.points[0].y,
            radius: Math.hypot(p.x - d.points[0].x, p.y - d.points[0].y),
        });
    } else if (d.kind === 'arc') {
        if (d.points.length === 1) {
            dstr = `M ${d.points[0].x} ${d.points[0].y} L ${p.x} ${p.y}`;
        } else {
            const bulge = projectArcBulge(d.points[0], d.points[1], p);
            dstr = shapePathD({ kind: 'arc', start: d.points[0], end: d.points[1], bulge });
        }
    } else if (d.kind === 'polygon') {
        const pts = [...d.points, p];
        dstr = `M ${pts[0].x} ${pts[0].y}` + pts.slice(1).map((q) => ` L ${q.x} ${q.y}`).join('');
        if (d.points.length >= 2) dstr += ` L ${d.points[0].x} ${d.points[0].y}`;
    }
    d.preview?.setAttribute('d', dstr);
    if (d.preview) {
        const st = shapeStyle({
            layer: d.layer,
            filled: !!app._shapeDefaults?.filled,
            copperMode: app._shapeDefaults?.copperMode,
        });
        d.preview.setAttribute('fill', st.filled ? st.fillColor : 'none');
        if (st.filled) d.preview.setAttribute('fill-opacity', st.fillOpacity);
        else d.preview.removeAttribute('fill-opacity');
    }
}

/** Remove the live preview element and clear draw state. */
export function cancelShapeDraw(app) {
    const d = app._shapeDraw;
    if (!d) return;
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
    const point = app._snapToGrid(worldPos);
    if (draw.kind === 'line' || draw.kind === 'polygon') {
        draw.points.push({ x: point.x, y: point.y });
    } else if ((draw.kind === 'rect' || draw.kind === 'circle') && draw.points.length === 1) {
        draw.points.push({ x: point.x, y: point.y });
    } else if (draw.kind === 'arc' && draw.points.length === 2) {
        draw.points.push({ x: point.x, y: point.y });
    } else {
        return false;
    }
    finishShapeDraw(app);
    return true;
}

/** Commit the in-progress draw into a board shape. */
export function finishShapeDraw(app) {
    const d = app._shapeDraw;
    if (!d) return;
    if (d.preview?.parentNode) d.preview.parentNode.removeChild(d.preview);
    app._shapeDraw = null;

    const layer = d.layer || app.activeLayer;
    const alwaysFilled = isMaskOrDocLayer(layer);
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

    let shape = null;
    if (d.kind === 'line') {
        const points = dedupePoints(d.points);
        if (points.length < 2 || points.every((point) => Math.hypot(point.x - points[0].x, point.y - points[0].y) < 0.05)) return;
        shape = { ...base, points };
    } else if (d.kind === 'rect') {
        const a = d.points[0], b = d.points[1];
        if (!a || !b) return;
        const minx = Math.min(a.x, b.x), maxx = Math.max(a.x, b.x);
        const miny = Math.min(a.y, b.y), maxy = Math.max(a.y, b.y);
        if (maxx - minx < 0.05 || maxy - miny < 0.05) return;
        shape = {
            ...base,
            points: [
                { x: minx, y: miny }, { x: maxx, y: miny },
                { x: maxx, y: maxy }, { x: minx, y: maxy },
            ],
        };
    } else if (d.kind === 'circle') {
        const [center, edge] = d.points;
        if (!center || !edge) return;
        const radius = Math.hypot(edge.x - center.x, edge.y - center.y);
        if (radius < 0.05) return;
        shape = { ...base, x: center.x, y: center.y, radius };
    } else if (d.kind === 'arc') {
        const [s, e, b] = d.points;
        if (!s || !e || !b) return;
        if (Math.hypot(e.x - s.x, e.y - s.y) < 0.05) return;
        shape = { ...base, filled: false, start: { ...s }, end: { ...e }, bulge: projectArcBulge(s, e, b) };
    } else if (d.kind === 'polygon') {
        const pts = dedupePoints(d.points);
        if (pts.length < 3) return;
        shape = { ...base, points: pts };
    }
    if (!shape) return;
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

/** Drop consecutive (and wrap-around) near-duplicate vertices. */
function dedupePoints(points) {
    const out = [];
    for (const p of points) {
        const last = out[out.length - 1];
        if (last && Math.hypot(p.x - last.x, p.y - last.y) < 1e-4) continue;
        out.push({ x: p.x, y: p.y });
    }
    if (out.length >= 2) {
        const first = out[0], last = out[out.length - 1];
        if (Math.hypot(first.x - last.x, first.y - last.y) < 1e-4) out.pop();
    }
    return out;
}

// ── Properties panel ─────────────────────────────────────────────────────────

const PROP_HIDDEN_LAYERS = new Set([
    'top-paste', 'bottom-paste',
    'top-mask', 'bottom-mask',
    'board-outline',
    'document', 'top-document', 'bottom-document',
]);

function netOptions(app, current = '') {
    const netNames = new Set((app.netlist || []).map((entry) => String(entry.net || '')).filter(Boolean));
    for (const source of [app.tracks, app.vias, app.boardShapes, app.copperFills]) {
        for (const item of source || []) {
            const net = String(item?.net || '');
            if (net) netNames.add(net);
        }
    }
    const names = [...netNames].sort();
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
        geom: cloneShapeGeometry(shape),
        cornerRadius: shape.kind === 'rect' ? rectCornerRadius(shape) : polygonCornerRadius(shape),
        nodeCornerRadii: { ...(shape.nodeCornerRadii || {}) },
        layer: shape.layer,
        lineWidth: Math.max(0.05, Number(shape.lineWidth) || 0.2),
        segmentWidths: { ...(shape.segmentWidths || {}) },
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
            ${kind === 'rect' ? `<div class="prop-row"><label>Corner Radius (mm)</label><input type="number" id="pcbToolShapeCornerRadius" min="0" step="0.5" value="${Math.max(0, Number(defaults.cornerRadius) || 0).toFixed(2)}"></div>` : ''}
            ${showLineWidth ? `<div class="prop-row" id="pcbToolShapeLineWidthRow"><label>Line Thickness (mm)</label><input type="number" id="pcbToolShapeLineWidth" min="${lineWidthMinimum}" step="0.05" value="${toolLineWidth.toFixed(2)}"></div>` : ''}
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
            defaults.cornerRadius = Math.max(0, Number(cornerRadiusEl.value) || 0);
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
    applyShapeGeometry(shape, state.geom);
    if (shape.kind === 'rect' || shape.kind === 'polygon') {
        shape.cornerRadius = Math.max(0, Number(state.cornerRadius) || 0);
        shape.nodeCornerRadii = { ...(state.nodeCornerRadii || {}) };
    }
    shape.layer = state.layer;
    shape.lineWidth = state.lineWidth;
    shape.segmentWidths = { ...(state.segmentWidths || {}) };
    shape.filled = !!state.filled;
    shape.copperMode = normalizeShapeCopperMode(state.copperMode);
    shape.plated = !!state.plated;
    shape.net = String(state.net || '');
}

export function showBoardShapeProperties(app, shape) {
    const items = app._pcbPropsItems?.();
    if (!items || !shape) return;
    syncPcbSelection(app);

    const propertyTargets = () => {
        const selected = getPcbSelection(app, 'shape');
        return selected.length > 0 ? selected : [shape];
    };
    const initialTargets = propertyTargets();
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
    app._setPcbPropsTitle?.(selectedNode != null
        ? 'Node'
        : selectedSegment != null ? 'Segment'
        : mixedKind ? 'Mixed' : shapeKindLabel(initialTargets[0].kind));
    const lineWidthMinimum = Math.max(...initialTargets.map((target) => boardShapeLineWidthMinimum(target)));
    const initialLineWidth = selectedSegment == null
        ? normalizedBoardShapeLineWidth(initialTargets[0], initialTargets[0].lineWidth)
        : boardShapeSegmentWidth(shape, selectedSegment);
    const mixedLineWidth = selectedSegment == null && initialTargets.some(
        (target) => Math.abs(normalizedBoardShapeLineWidth(target, target.lineWidth) - initialLineWidth) >= 1e-9,
    );
    const mixedFill = initialTargets.some((target) => !!target.filled !== !!initialTargets[0].filled);
    const allRoundedTargets = initialTargets.every((target) => target.kind === 'rect' || target.kind === 'polygon');
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
    const showFill = initialTargets.every((target) => target.layer !== 'hole' && target.kind !== 'line');
    const showLineWidth = initialTargets.every(
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

    items.innerHTML = selectedNode != null
        ? `<div class="prop-row"><label>Corner Radius (mm)</label><input type="number" id="pcbPropShapeNodeCornerRadius" min="0" step="0.5" value="${boardShapeNodeCornerRadius(shape, selectedNode).toFixed(2)}"></div>`
        : selectedSegment != null
        ? `<div class="prop-row" id="pcbPropShapeLineWidthRow"><label>Line Thickness (mm)</label><input type="number" id="pcbPropShapeLineWidth" min="${lineWidthMinimum}" step="0.05" value="${initialLineWidth.toFixed(2)}"></div>`
        : `
            <div class="prop-row"><label>Layer</label><select id="pcbPropShapeLayer">${mixedLayer ? '<option value="" selected disabled>Mixed</option>' : ''}${layerOptionsHtml}</select></div>
            ${showFill ? `<label class="prop-row prop-toggle"><input type="checkbox" id="pcbPropShapeFilled"${shape.filled ? ' checked' : ''}><span>Fill</span></label>` : ''}
            ${showPlated ? `<label class="prop-row prop-toggle"><input type="checkbox" id="pcbPropShapePlated"${!mixedPlated && holeTargets[0]?.plated ? ' checked' : ''}><span>Plated</span></label>` : ''}
            ${showCopperMode ? `<div class="prop-row" id="pcbPropShapeCopperModeRow"><label>Copper Mode</label><select id="pcbPropShapeCopperMode">${mixedCopperMode ? '<option value="" selected disabled>Mixed</option>' : ''}<option value="add"${!mixedCopperMode && initialCopperMode === 'add' ? ' selected' : ''}>Add Copper</option><option value="remove-copper"${!mixedCopperMode && initialCopperMode === 'remove-copper' ? ' selected' : ''}>Remove Copper</option><option value="remove-solder-mask"${!mixedCopperMode && initialCopperMode === 'remove-solder-mask' ? ' selected' : ''}>Remove Solder Mask</option><option value="remove-copper-mask"${!mixedCopperMode && initialCopperMode === 'remove-copper-mask' ? ' selected' : ''}>Remove Copper + Mask</option></select></div>` : ''}
            ${showNet ? `<div class="prop-row"><label>Net</label><span class="prop-net-control"><input type="text" id="pcbPropShapeNet" value="${mixedNet ? '' : initialNet.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" placeholder="${mixedNet ? 'Mixed' : 'None'}"><details class="prop-net-menu"><summary aria-label="Select existing net"></summary><div>${shapeNetOptions}</div></details></span></div>` : ''}
            ${allRoundedTargets ? `<div class="prop-row"><label>Corner Radius (mm)</label><input type="number" id="pcbPropShapeCornerRadius" min="0" step="0.5" value="${mixedCornerRadius ? '' : initialCornerRadius.toFixed(2)}"${mixedCornerRadius ? ' placeholder="Mixed"' : ''}></div>` : ''}
            ${showLineWidth ? `<div class="prop-row" id="pcbPropShapeLineWidthRow"><label>Line Thickness (mm)</label><input type="number" id="pcbPropShapeLineWidth" min="${lineWidthMinimum}" step="0.05" value="${mixedLineWidth ? '' : initialLineWidth.toFixed(2)}"${mixedLineWidth ? ' placeholder="Mixed"' : ''}></div>` : ''}
        `;

    const commit = (mutate) => {
        const before = propertyTargets().map((target) => ({ target, state: shapeSnapshot(target) }));
        for (const { target } of before) {
            mutate(target);
            if (isMaskOrDocLayer(target.layer)) target.filled = true;
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
    let lineWidthBefore = null;
    let cornerRadiusBefore = null;
    let nodeCornerRadiusBefore = null;
    const commitLineWidthPreview = () => {
        if (!lineWidthBefore) return;
        const before = lineWidthBefore;
        lineWidthBefore = null;
        const changed = before.filter(({ target, state }) => JSON.stringify(state) !== JSON.stringify(shapeSnapshot(target)));
        if (!changed.length) return;
        const commands = changed.map(({ target, state }) => {
            const after = shapeSnapshot(target);
            applyShapeSnapshot(target, state);
            return new ModifyBoardShapeCommand(app, target, state, after);
        });
        app.history.execute(commands.length === 1 ? commands[0] : new CompoundCommand(commands));
    };
    const previewCornerRadius = () => {
        if (!cornerRadiusEl || !Number.isFinite(cornerRadiusEl.valueAsNumber)) return;
        const radius = Math.max(0, cornerRadiusEl.valueAsNumber);
        cornerRadiusEl.value = radius.toFixed(2);
        const targets = propertyTargets().filter((target) => target.kind === 'rect' || target.kind === 'polygon');
        if (targets.every((target) => Math.abs(targetCornerRadius(target) - radius) < 1e-9)) return;
        cornerRadiusBefore ||= targets.map((target) => ({ target, state: shapeSnapshot(target) }));
        for (const target of targets) {
            target.cornerRadius = radius;
            renderBoardShape(app, target);
        }
        app._refreshPcbSelectionHighlights?.();
        app._refreshFills?.();
    };
    const commitCornerRadiusPreview = () => {
        if (!cornerRadiusBefore) return;
        const before = cornerRadiusBefore;
        cornerRadiusBefore = null;
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

    const previewNodeCornerRadius = () => {
        if (!nodeCornerRadiusEl || selectedNode == null || !Number.isFinite(nodeCornerRadiusEl.valueAsNumber)) return;
        const radius = Math.max(0, nodeCornerRadiusEl.valueAsNumber);
        nodeCornerRadiusEl.value = radius.toFixed(2);
        if (Math.abs(boardShapeNodeCornerRadius(shape, selectedNode) - radius) < 1e-9) return;
        nodeCornerRadiusBefore ||= shapeSnapshot(shape);
        setBoardShapeNodeCornerRadius(shape, selectedNode, radius);
        renderBoardShape(app, shape);
        app._refreshPcbSelectionHighlights?.();
        app._refreshFills?.();
    };
    const commitNodeCornerRadiusPreview = () => {
        if (!nodeCornerRadiusBefore) return;
        const before = nodeCornerRadiusBefore;
        nodeCornerRadiusBefore = null;
        const after = shapeSnapshot(shape);
        applyShapeSnapshot(shape, before);
        app.history.execute(new ModifyBoardShapeCommand(app, shape, before, after));
    };

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
        const v = Math.max(minimum, lineEl.valueAsNumber);
        if (lineEl.valueAsNumber < v) lineEl.value = v.toFixed(2);
        if (selectedSegment != null && Math.abs(v - boardShapeSegmentWidth(shape, selectedSegment)) < 1e-9) return;
        if (selectedSegment == null
            && targets.every((target) => Math.abs(v - (Number(target.lineWidth) || 0.2)) < 1e-9)) return;
        lineWidthBefore ||= targets.map((target) => ({ target, state: shapeSnapshot(target) }));
        for (const target of targets) {
            if (selectedSegment != null) {
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
            renderBoardShape(app, target);
        }
        app._refreshPcbSelectionHighlights?.();
        app._refreshFills?.();
    };
    const seedMixedLineWidth = () => {
        if (!lineEl || Number.isFinite(lineEl.valueAsNumber)) return;
        lineEl.value = initialLineWidth.toFixed(2);
    };
    // Native number steppers may retain an empty mixed value, leaving
    // valueAsNumber as NaN and bypassing the batch preview entirely.
    lineEl?.addEventListener('pointerdown', seedMixedLineWidth);
    lineEl?.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') seedMixedLineWidth();
    });
    lineEl?.addEventListener('input', () => {
        previewLineWidth();
    });
    lineEl?.addEventListener('change', () => {
        previewLineWidth();
        commitLineWidthPreview();
    });
    cornerRadiusEl?.addEventListener('input', previewCornerRadius);
    cornerRadiusEl?.addEventListener('change', () => {
        previewCornerRadius();
        commitCornerRadiusPreview();
    });
    nodeCornerRadiusEl?.addEventListener('input', previewNodeCornerRadius);
    nodeCornerRadiusEl?.addEventListener('change', () => {
        previewNodeCornerRadius();
        commitNodeCornerRadiusPreview();
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
        const geometry = resolveBoardShapeGeometry(s);
        if (s.layer !== 'hole') {
            const removalPath = boardShapeRemovalPathD(s);
            if (!removalPath) continue;
            d += ` ${removalPath}`;
            count++;
            continue;
        }
        if (geometry.filled) {
            const outline = geometry.circle
                ? circleOutline({ ...s, radius: geometry.circle.outerRadius, filled: false })
                : geometry.areaOutline || [];
            if (outline.length < 3) continue;
            appendLoop(outline);
        } else if (s.kind === 'circle') {
            const halfWidth = geometry.lineWidth / 2;
            appendLoop(circleOutline({ ...s, radius: s.radius + halfWidth, filled: false }));
            appendLoop(circleOutline({ ...s, radius: Math.max(0.001, s.radius - halfWidth), filled: false }).reverse());
        } else if (s.kind === 'arc') {
            const halfWidth = geometry.lineWidth / 2;
            appendLoop([
                ...arcOutlineAtOffset(s, halfWidth),
                ...arcOutlineAtOffset(s, -halfWidth).reverse(),
            ]);
        } else if (geometry.centerlineClosed) {
            appendLoop(filledShapeOutline(s, geometry.lineWidth / 2));
            appendLoop(filledShapeOutline(s, -geometry.lineWidth / 2).reverse());
        } else {
            continue;
        }
        count++;
    }
    return { count, d };
}

// ── Serialisation ────────────────────────────────────────────────────────────

export function serializeBoardShapes(app) {
    return (app.boardShapes || []).map((s) => {
        if (s?.type === 'fill') return s.toJSON();
        const base = {
            id: s.id,
            kind: s.kind,
            layer: s.layer,
            lineWidth: s.lineWidth,
            filled: !!s.filled,
            copperMode: normalizeShapeCopperMode(s.copperMode),
            plated: !!s.plated,
            net: String(s.net || ''),
        };
        if (Object.keys(s.segmentWidths || {}).length) base.segmentWidths = { ...s.segmentWidths };
        if (Object.keys(s.nodeCornerRadii || {}).length) base.nodeCornerRadii = { ...s.nodeCornerRadii };
        if (s.kind === 'rect') base.cornerRadius = rectCornerRadius(s);
        else if (s.kind === 'polygon') base.cornerRadius = polygonCornerRadius(s);
        if (s.kind === 'arc') {
            return { ...base, start: { ...s.start }, end: { ...s.end }, bulge: { ...s.bulge } };
        }
        if (s.kind === 'circle') {
            return { ...base, x: s.x, y: s.y, radius: s.radius };
        }
        return { ...base, points: (s.points || []).map((p) => ({ x: p.x, y: p.y })) };
    });
}

const pt = (p) => ({ x: Number(p?.x) || 0, y: Number(p?.y) || 0 });

export function loadBoardShapes(app, arr) {
    if (!Array.isArray(arr)) return;
    for (const sd of arr) {
        if (sd?.type === 'fill') {
            try {
                const fill = CopperFill.fromJSON(sd);
                updateFillIdCounter(fill.id);
                app.boardShapes.push(fill);
            } catch (err) {
                console.warn('Skipping malformed copper fill during load:', err);
            }
            continue;
        }
        const kind = SHAPE_KINDS.has(sd?.kind) ? sd.kind : null;
        if (!kind) continue;
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
        if (sd.nodeCornerRadii && typeof sd.nodeCornerRadii === 'object') {
            base.nodeCornerRadii = Object.fromEntries(Object.entries(sd.nodeCornerRadii)
                .filter(([index, radius]) => Number.isInteger(Number(index)) && Number(radius) >= 0)
                .map(([index, radius]) => [index, Number(radius)]));
        }
        if (kind === 'rect' || kind === 'polygon') {
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
            if (pts.length < (kind === 'line' ? 2 : 3)) continue;
            shape = { ...base, points: pts };
        }
        app.boardShapes.push(shape);
        renderBoardShape(app, shape);
        const n = /pshape_(\d+)/.exec(shape.id);
        if (n) app._shapeIdCounter = Math.max(app._shapeIdCounter, Number(n[1]) + 1);
    }
}
