/**
 * Free-standing PCB board shapes: rectangle, polygon, arc and circle.
 *
 * Modelled on the circle tool (see PCBApp._renderCircle and friends) but
 * generalised so the three new shapes share one code path. Shapes are plain
 * objects stored in `app.boardShapes`; geometry-specific bits (path, outline,
 * hit-test) dispatch on `shape.kind`.
 *
 * Shape object shape:
 *   common: { id, kind:'rect'|'polygon'|'arc'|'circle', layer, lineWidth, filled, copperMode, plated }
 *   rect:   + { cornerRadius }
 *   rect/polygon: + { points: [{x,y}, ...] }   (closed)
 *   arc:          + { start:{x,y}, end:{x,y}, bulge:{x,y} }
 *   circle:       + { x, y, radius }
 */

import { circumcircle, pointInPolygon, distanceToSegment } from '../../core/geometry.js';
import { isLayerLocked, isLayerVisible, PCB_LAYERS } from './layers.js';
import {
    AddBoardShapeCommand,
    RemoveBoardShapeCommand,
    MoveBoardShapeCommand,
    ModifyBoardShapeCommand,
} from './shape-commands.js';
import { CompoundCommand } from './track-commands.js';
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
const SHAPE_KINDS = new Set(['rect', 'polygon', 'arc', 'circle']);
const HOLE_BORDER_WIDTH = 0.05;

/** Round to 4 dp for compact, stable path/serialisation output. */
const r4 = (n) => Math.round(n * 10000) / 10000;

/** Human-friendly title for the Properties panel. */
export function shapeKindLabel(kind) {
    return kind === 'rect' ? 'Rectangle'
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

/** Outline points used for fill hit-testing, copper cuts and bounds. */
export function shapeOutline(shape) {
    if (shape.kind === 'arc') return arcSamples(shape);
    if (shape.kind === 'circle') return circleOutline(shape);
    if (shape.kind === 'rect') return roundedRectOutline(shape);
    return (shape.points || []).map((p) => ({ x: p.x, y: p.y }));
}

/** Outline edges as [p, q] pairs (closed for rect/polygon, open for arc). */
function shapeSegments(shape) {
    if (shape.kind === 'arc') {
        const s = arcSamples(shape);
        const segs = [];
        for (let i = 0; i < s.length - 1; i++) segs.push([s[i], s[i + 1]]);
        return segs;
    }
    const pts = shapeOutline(shape);
    const segs = [];
    for (let i = 0; i < pts.length; i++) segs.push([pts[i], pts[(i + 1) % pts.length]]);
    return segs;
}

/** Bounds including the visible line width, for shared selection queries. */
export function boardShapeBounds(shape) {
    const outline = shapeOutline(shape);
    const halfWidth = Math.max(0.05, Number(shape.lineWidth) || 0.2) / 2;
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
    const edgeTolerance = Math.max(tolerance, (Number(shape.lineWidth) || 0.2) / 2 + 0.12);
    return shapeSegments(shape).some(([a, b]) => distanceToSegment(worldPos, a, b) <= edgeTolerance);
}

/**
 * SVG path data for a shape. rect/polygon are always closed; an arc is closed
 * (chord) only when `close` is set (filled rendering).
 */
export function shapePathD(shape, { close = false } = {}) {
    if (shape.kind === 'arc') {
        const g = arcGeom(shape);
        if (!g) {
            return `M ${r4(shape.start.x)} ${r4(shape.start.y)} L ${r4(shape.end.x)} ${r4(shape.end.y)}`;
        }
        const { dir, total } = arcSweep(shape, g);
        const largeArc = total > Math.PI ? 1 : 0;
        const sweep = dir > 0 ? 1 : 0;
        const rad = r4(g.radius);
        let d = `M ${r4(shape.start.x)} ${r4(shape.start.y)}`
            + ` A ${rad} ${rad} 0 ${largeArc} ${sweep} ${r4(shape.end.x)} ${r4(shape.end.y)}`;
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
    if (shape.kind === 'rect' && rectCornerRadius(shape) > 0) {
        const bounds = rectBounds(shape);
        const radius = rectCornerRadius(shape);
        if (!bounds) return '';
        const { minX, maxX, minY, maxY } = bounds;
        return `M ${r4(minX + radius)} ${r4(minY)}`
            + ` L ${r4(maxX - radius)} ${r4(minY)}`
            + ` Q ${r4(maxX)} ${r4(minY)} ${r4(maxX)} ${r4(minY + radius)}`
            + ` L ${r4(maxX)} ${r4(maxY - radius)}`
            + ` Q ${r4(maxX)} ${r4(maxY)} ${r4(maxX - radius)} ${r4(maxY)}`
            + ` L ${r4(minX + radius)} ${r4(maxY)}`
            + ` Q ${r4(minX)} ${r4(maxY)} ${r4(minX)} ${r4(maxY - radius)}`
            + ` L ${r4(minX)} ${r4(minY + radius)}`
            + ` Q ${r4(minX)} ${r4(minY)} ${r4(minX + radius)} ${r4(minY)} Z`;
    }
    const pts = shape.points || [];
    if (!pts.length) return '';
    let d = `M ${r4(pts[0].x)} ${r4(pts[0].y)}`;
    for (let i = 1; i < pts.length; i++) d += ` L ${r4(pts[i].x)} ${r4(pts[i].y)}`;
    return d + ' Z';
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

function translateGeometry(geom, dx, dy) {
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
    const filled = isHoleLayer
        ? true
        : isCopperLayer
            ? ((isCopperAdd || isCopperRemoval) && !!shape.filled)
            : (!!shape.filled || isMaskLayer || isDocumentLayer);
    const fillColor = isHoleLayer ? 'var(--bg-canvas, #000000)' : layerColor;
    const fillOpacity = isHoleLayer || isDocumentLayer ? '1' : isCopperAdd ? '0.9' : '0.18';
    const baseStroke = isCopperRemoval ? (REMOVAL_COLORS[copperMode] || CUT_RING) : layerColor;
    const strokeWidth = isHoleLayer
        ? HOLE_BORDER_WIDTH
        : Math.max(0.05, Number(shape.lineWidth) || 0.2);
    const targetLayer = isCopperKnockout
        ? (layer === 'bottom-copper' ? 'bottom-copper-knockout' : 'top-copper-knockout')
        : layer;
    return { filled, fillColor, fillOpacity, baseStroke, strokeWidth, isHoleLayer, isCopperRemoval, isCopperKnockout, targetLayer };
}

/** True when a shape reads as a solid region for hit-testing. */
export function shapeIsFilled(shape) {
    const layer = String(shape.layer || 'top-silk');
    // A hole-layer shape is a board cutout — its whole interior is clickable.
    if (layer === 'hole') return true;
    const isCopperLayer = layer === 'top-copper' || layer === 'bottom-copper';
    if (isCopperLayer) {
        const m = normalizeShapeCopperMode(shape.copperMode);
        if (m === 'remove-copper' || m === 'remove-copper-mask') return true;
        if (m === 'add') return !!shape.filled;
    }
    return !!shape.filled || isMaskOrDocLayer(layer);
}

// ── Render ───────────────────────────────────────────────────────────────────

export function renderBoardShape(app, shape, opts = {}) {
    removeBoardShapeElement(app, shape.id);
    const el = document.createElementNS(NS, 'path');
    const isSelected = isPcbSelected(app, 'shape', shape);
    const isHovered = !!(app._hoveredShape && app._hoveredShape.id === shape.id);
    const st = shapeStyle(shape);
    el.setAttribute('d', shapePathD(shape, { close: st.filled }));
    const canvasHatch = st.isCopperRemoval && st.filled;
    el.setAttribute('fill', st.filled
        ? (canvasHatch ? 'none' : st.isCopperRemoval ? app._ensureCopperRemovalHatch?.(shape.copperMode) || st.fillColor : st.fillColor)
        : 'none');
    if (st.filled) el.setAttribute('fill-opacity', st.isCopperRemoval ? '1' : st.fillOpacity);
    el.setAttribute('stroke', isSelected ? shapeSelectionColor(shape) : isHovered ? shapeHoverColor(shape) : st.baseStroke);
    el.setAttribute('stroke-width', String(st.isHoleLayer ? st.strokeWidth : st.filled ? 0.06 : st.strokeWidth));
    el.setAttribute('stroke-linejoin', 'round');
    el.setAttribute('stroke-linecap', 'round');
    if (st.isCopperKnockout && !isSelected && !st.filled) el.setAttribute('stroke-dasharray', '0.6 0.45');
    app._getLayerGroup(st.targetLayer)?.appendChild(el);
    app._shapeElements.set(shape.id, el);
    app._scheduleRemovalHatchRender?.();
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

export function removeBoardShapeElement(app, id) {
    const el = app._shapeElements.get(id);
    if (el?.parentNode) el.parentNode.removeChild(el);
    app._shapeElements.delete(id);
    app._scheduleRemovalHatchRender?.();
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
    const prev = app._selectedShape;
    const next = shape || null;
    if (prev === next || (prev && next && prev.id === next.id)) return;
    app._selectedShape = next;
    if (next && !isPcbSelected(app, 'shape', next)) {
        setPcbSelection(app, [{ kind: 'shape', object: next }]);
    }
    app._syncClipboardButtons?.();
    if (prev && app.boardShapes.includes(prev)) renderBoardShape(app, prev);
    if (next) renderBoardShape(app, next);
    clearBoardShapeHandles(app);
    if (next) renderBoardShapeHandles(app, next);
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

/** Anchors exposed through the common PCB selection adapter contract. */
export function getBoardShapeAnchors(shape) {
    return shapeHandlePoints(shape).map((anchor) => ({
        ...anchor,
        id: anchor.key,
        cursor: anchor.cursor || 'nwse-resize',
        round: anchor.key === 'bulge',
        fill: anchor.key === 'bulge' ? '#33dd77' : '#ffffff',
    }));
}

/** Move one anchor through the existing geometry and rendering path. */
export function moveBoardShapeAnchor(app, shape, anchorId, worldPos) {
    const before = cloneShapeGeometry(shape);
    applyVertexResize(shape, { before, handle: anchorId }, app._snapToGrid(worldPos));
    renderBoardShape(app, shape, { liveDrag: true });
}

/** Full SelectionManager adapter for rectangle, polygon, and arc objects. */
export function createBoardShapeSelectionAdapter(app, shape, id) {
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
        beginAnchorDrag(_anchorId, worldPos) { return startBoardShapeDrag(app, shape, worldPos); },
        updateAnchorDrag(worldPos) { handleBoardShapeDrag(app, worldPos); },
        endAnchorDrag(commit) { endBoardShapeDrag(app, commit); },
        beginMove(worldPos) { return startBoardShapeDrag(app, shape, worldPos); },
        updateMove(worldPos) { handleBoardShapeDrag(app, worldPos); },
        endMove(commit) { endBoardShapeDrag(app, commit); },
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

/** Apply a live vertex/anchor drag to a shape's geometry, keeping rects rectangular. */
function applyVertexResize(shape, drag, snap) {
    if (shape.kind === 'arc') {
        if (drag.handle === 'start') shape.start = { x: snap.x, y: snap.y };
        else if (drag.handle === 'end') shape.end = { x: snap.x, y: snap.y };
        else shape.bulge = { x: snap.x, y: snap.y };
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

export function deleteSelectedBoardShape(app) {
    const s = app._selectedShape;
    if (!s) return false;
    if (isLayerLocked(s.layer)) return false;
    app.history.execute(new RemoveBoardShapeCommand(app, s));
    selectBoardShape(app, null);
    app._clearProperties?.();
    return true;
}

// ── Drag (move whole shape) ──────────────────────────────────────────────────

export function startBoardShapeDrag(app, shape, worldPos) {
    if (!shape || isLayerLocked(shape.layer)) return false;
    // Grabbing a resize handle edits that vertex; otherwise move the whole shape.
    const handle = hitTestBoardShapeVertex(app, shape, worldPos);
    const before = cloneShapeGeometry(shape);
    app._shapeDrag = {
        id: shape.id,
        mode: handle != null ? 'vertex' : 'move',
        handle,
        startWorld: { x: worldPos.x, y: worldPos.y },
        before,
    };
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
        const snap = app._snapToGrid(worldPos);
        applyVertexResize(s, d, snap);
        const handle = shapeHandlePoints(s).find((point) => point.key === d.handle);
        app.viewport?.setCrosshair(handle || snap);
        renderBoardShape(app, s, { liveDrag: true });
        renderBoardShapeHandles(app, s);
        return;
    }
    const dx = worldPos.x - d.startWorld.x;
    const dy = worldPos.y - d.startWorld.y;
    // Snap by the shape's anchor point so the whole shape lands on the grid.
    const anchor = geomAnchor(d.before);
    const snapped = app._snapToGrid({ x: anchor.x + dx, y: anchor.y + dy });
    applyShapeGeometry(s, translateGeometry(d.before, snapped.x - anchor.x, snapped.y - anchor.y));
    app.viewport?.setCrosshair(snapped);
    renderBoardShape(app, s, { liveDrag: true });
    renderBoardShapeHandles(app, s);
}

export function endBoardShapeDrag(app, commit) {
    const d = app._shapeDrag;
    app._shapeDrag = null;
    app.viewport?.hideCrosshair();
    if (!d) return;
    const s = app.boardShapes.find((x) => x.id === d.id);
    if (!s) return;
    const after = cloneShapeGeometry(s);
    const moved = JSON.stringify(after) !== JSON.stringify(d.before);
    // Roll back first, then commit through history so undo is exact.
    applyShapeGeometry(s, d.before);
    renderBoardShape(app, s);
    if (!moved || !commit) {
        renderBoardShapeHandles(app, s);
        return;
    }
    app.history.execute(new MoveBoardShapeCommand(app, s, d.before, after));
    renderBoardShapeHandles(app, s);
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
    preview.setAttribute('stroke', '#66b3ff');
    preview.setAttribute('stroke-width', '0.2');
    preview.setAttribute('stroke-dasharray', '2 2');
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
    if (d.kind === 'rect') {
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
            dstr = shapePathD({ kind: 'arc', start: d.points[0], end: d.points[1], bulge: p });
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
        lineWidth: app._shapeDefaults?.lineWidth ?? 0.2,
        filled: alwaysFilled || !!app._shapeDefaults?.filled,
        copperMode: normalizeShapeCopperMode(app._shapeDefaults?.copperMode),
        plated: layer === 'hole' && !!app._shapeDefaults?.plated,
        net: layer === 'top-copper' || layer === 'bottom-copper'
            ? String(app._shapeDefaults?.net || '')
            : '',
        cornerRadius: d.kind === 'rect' ? Math.max(0, Number(app._shapeDefaults?.cornerRadius) || 0) : undefined,
    };

    let shape = null;
    if (d.kind === 'rect') {
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
        shape = { ...base, filled: false, start: { ...s }, end: { ...e }, bulge: { ...b } };
    } else if (d.kind === 'polygon') {
        const pts = dedupePoints(d.points);
        if (pts.length < 3) return;
        shape = { ...base, points: pts };
    }
    if (!shape) return;
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
        geom: cloneShapeGeometry(shape),
        cornerRadius: rectCornerRadius(shape),
        layer: shape.layer,
        lineWidth: Math.max(0.05, Number(shape.lineWidth) || 0.2),
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
 * @param {'rect'|'polygon'|'arc'} kind
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
        const showFill = currentLayer !== 'hole';
        const showLineWidth = currentLayer !== 'hole';

        app._setPcbPropsTitle?.(`New ${shapeKindLabel(kind)}`);
        items.innerHTML = `
            <div class="prop-row"><label>Layer</label><select id="pcbToolShapeLayer">${layerOptionsHtml}</select></div>
            ${showFill ? `<label class="prop-row prop-toggle"><input type="checkbox" id="pcbToolShapeFilled"${defaults.filled ? ' checked' : ''}><span>Fill</span></label>` : ''}
            ${currentLayer === 'hole' ? `<label class="prop-row prop-toggle"><input type="checkbox" id="pcbToolShapePlated"${defaults.plated ? ' checked' : ''}><span>Plated</span></label>` : ''}
            <div class="prop-row" id="pcbToolShapeCopperModeRow"><label>Copper Mode</label><select id="pcbToolShapeCopperMode"><option value="add"${initialCopperMode === 'add' ? ' selected' : ''}>Add Copper</option><option value="remove-copper"${initialCopperMode === 'remove-copper' ? ' selected' : ''}>Remove Copper</option><option value="remove-solder-mask"${initialCopperMode === 'remove-solder-mask' ? ' selected' : ''}>Remove Solder Mask</option><option value="remove-copper-mask"${initialCopperMode === 'remove-copper-mask' ? ' selected' : ''}>Remove Copper + Mask</option></select></div>
            <div class="prop-row" id="pcbToolShapeNetRow"><label>Net</label><span class="prop-net-control"><input type="text" id="pcbToolShapeNet" value="${initialNet}" placeholder="None"><details class="prop-net-menu"><summary aria-label="Select existing net"></summary><div>${toolNetOptions}</div></details></span></div>
            ${kind === 'rect' ? `<div class="prop-row"><label>Corner Radius (mm)</label><input type="number" id="pcbToolShapeCornerRadius" min="0" step="0.05" value="${Math.max(0, Number(defaults.cornerRadius) || 0).toFixed(2)}"></div>` : ''}
            ${showLineWidth ? `<div class="prop-row" id="pcbToolShapeLineWidthRow"><label>Line Thickness (mm)</label><input type="number" id="pcbToolShapeLineWidth" min="0.05" step="0.05" value="${Math.max(0.05, Number(defaults.lineWidth) || 0.2).toFixed(2)}"></div>` : ''}
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
            defaults.lineWidth = Math.max(0.05, Number(lineEl.value) || 0.2);
            updateShapeDrawPreview(app, app._lastCrosshairWorld || app._shapeDraw?.points.at(-1));
        });
        cornerRadiusEl?.addEventListener('input', () => {
            defaults.cornerRadius = Math.max(0, Number(cornerRadiusEl.value) || 0);
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
            if (!option) return;
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
    applyShapeGeometry(shape, state.geom);
    if (shape.kind === 'rect') shape.cornerRadius = Math.max(0, Number(state.cornerRadius) || 0);
    shape.layer = state.layer;
    shape.lineWidth = state.lineWidth;
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
    const mixedKind = initialTargets.some((target) => target.kind !== initialTargets[0].kind);
    app._setPcbPropsTitle?.(mixedKind ? 'Mixed' : shapeKindLabel(initialTargets[0].kind));
    const initialLineWidth = Number(initialTargets[0].lineWidth) || 0.2;
    const mixedLineWidth = initialTargets.some(
        (target) => Math.abs((Number(target.lineWidth) || 0.2) - initialLineWidth) >= 1e-9,
    );
    const mixedFill = initialTargets.some((target) => !!target.filled !== !!initialTargets[0].filled);
    const allRectTargets = initialTargets.every((target) => target.kind === 'rect');
    const initialCornerRadius = rectCornerRadius(shape);
    const mixedCornerRadius = initialTargets.some(
        (target) => Math.abs(rectCornerRadius(target) - initialCornerRadius) >= 1e-9,
    );

    const currentLayer = String(shape.layer || 'top-silk');
    const mixedLayer = initialTargets.some((target) => String(target.layer || 'top-silk') !== currentLayer);
    const holeTargets = initialTargets.filter((target) => target.layer === 'hole');
    const showFill = initialTargets.every((target) => target.layer !== 'hole');
    const showLineWidth = initialTargets.every((target) => target.layer !== 'hole');
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

    items.innerHTML = `
        <div class="prop-row"><label>Layer</label><select id="pcbPropShapeLayer">${mixedLayer ? '<option value="" selected disabled>Mixed</option>' : ''}${layerOptionsHtml}</select></div>
        ${showFill ? `<label class="prop-row prop-toggle"><input type="checkbox" id="pcbPropShapeFilled"${shape.filled ? ' checked' : ''}><span>Fill</span></label>` : ''}
        ${showPlated ? `<label class="prop-row prop-toggle"><input type="checkbox" id="pcbPropShapePlated"${!mixedPlated && holeTargets[0]?.plated ? ' checked' : ''}><span>Plated</span></label>` : ''}
        ${showCopperMode ? `<div class="prop-row" id="pcbPropShapeCopperModeRow"><label>Copper Mode</label><select id="pcbPropShapeCopperMode">${mixedCopperMode ? '<option value="" selected disabled>Mixed</option>' : ''}<option value="add"${!mixedCopperMode && initialCopperMode === 'add' ? ' selected' : ''}>Add Copper</option><option value="remove-copper"${!mixedCopperMode && initialCopperMode === 'remove-copper' ? ' selected' : ''}>Remove Copper</option><option value="remove-solder-mask"${!mixedCopperMode && initialCopperMode === 'remove-solder-mask' ? ' selected' : ''}>Remove Solder Mask</option><option value="remove-copper-mask"${!mixedCopperMode && initialCopperMode === 'remove-copper-mask' ? ' selected' : ''}>Remove Copper + Mask</option></select></div>` : ''}
        ${showNet ? `<div class="prop-row"><label>Net</label><span class="prop-net-control"><input type="text" id="pcbPropShapeNet" value="${mixedNet ? '' : initialNet.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" placeholder="${mixedNet ? 'Mixed' : 'None'}"><details class="prop-net-menu"><summary aria-label="Select existing net"></summary><div>${shapeNetOptions}</div></details></span></div>` : ''}
        ${allRectTargets ? `<div class="prop-row"><label>Corner Radius (mm)</label><input type="number" id="pcbPropShapeCornerRadius" min="0" step="0.05" value="${mixedCornerRadius ? '' : initialCornerRadius.toFixed(2)}"${mixedCornerRadius ? ' placeholder="Mixed"' : ''}></div>` : ''}
        ${showLineWidth ? `<div class="prop-row" id="pcbPropShapeLineWidthRow"><label>Line Thickness (mm)</label><input type="number" id="pcbPropShapeLineWidth" min="0.05" step="0.05" value="${mixedLineWidth ? '' : initialLineWidth.toFixed(2)}"${mixedLineWidth ? ' placeholder="Mixed"' : ''}></div>` : ''}
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
        const targets = propertyTargets().filter((target) => target.kind === 'rect');
        if (targets.every((target) => Math.abs(rectCornerRadius(target) - radius) < 1e-9)) return;
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

    const lineEl = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropShapeLineWidth'));
    const lineRowEl = /** @type {HTMLDivElement|null} */ (document.getElementById('pcbPropShapeLineWidthRow'));
    const cornerRadiusEl = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropShapeCornerRadius'));
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
        const v = Math.max(0.05, lineEl.valueAsNumber);
        const targets = propertyTargets();
        if (targets.every((target) => Math.abs(v - (Number(target.lineWidth) || 0.2)) < 1e-9)) return;
        lineWidthBefore ||= targets.map((target) => ({ target, state: shapeSnapshot(target) }));
        for (const target of targets) {
            target.lineWidth = v;
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
        commit((target) => { target.layer = next; });
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
        if (propertyTargets().every((target) => String(target.net || '') === next)) return;
        commit((target) => { target.net = next; });
    });
    netMenuEl?.addEventListener('click', (event) => {
        const option = /** @type {HTMLButtonElement|null} */ (event.target instanceof Element ? event.target.closest('button[data-net]') : null);
        if (!option) return;
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
        const outline = shapeOutline(s);
        if (outline.length < 3) continue;
        d += ` M ${r4(outline[0].x)} ${r4(outline[0].y)}`;
        for (let i = 1; i < outline.length; i++) d += ` L ${r4(outline[i].x)} ${r4(outline[i].y)}`;
        d += ' Z';
        count++;
    }
    return { count, d };
}

// ── Serialisation ────────────────────────────────────────────────────────────

export function serializeBoardShapes(app) {
    return (app.boardShapes || []).map((s) => {
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
        if (s.kind === 'rect') base.cornerRadius = rectCornerRadius(s);
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
        if (kind === 'rect') base.cornerRadius = Math.max(0, Number(sd.cornerRadius) || 0);
        let shape;
        if (kind === 'arc') {
            shape = { ...base, start: pt(sd.start), end: pt(sd.end), bulge: pt(sd.bulge) };
        } else if (kind === 'circle') {
            const radius = Math.max(0.05, Number(sd.radius) || 0);
            if (!radius) continue;
            shape = { ...base, x: Number(sd.x) || 0, y: Number(sd.y) || 0, radius };
        } else {
            const pts = Array.isArray(sd.points) ? sd.points.map(pt) : [];
            if (pts.length < 3) continue;
            shape = { ...base, points: pts };
        }
        app.boardShapes.push(shape);
        renderBoardShape(app, shape);
        const n = /pshape_(\d+)/.exec(shape.id);
        if (n) app._shapeIdCounter = Math.max(app._shapeIdCounter, Number(n[1]) + 1);
    }
}
