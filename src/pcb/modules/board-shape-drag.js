/**
 * Dragging board shapes, their nodes and segments: the live preview, grid and axis snapping
 * with its indicators, and the undoable command on release. The drag is the _shapeDrag
 * interaction slot, which this module owns.
 */
import { beginDragSession, refreshDragRatlines, releaseDragSession } from './drag-session.js';
import { bulgeRatio } from '../../core/geometry.js';
import { projectArcBulge, snapArcBulgeToChord, arcBulgeRatio, arcBulgeFromRatio } from '../../shapes/arc-edit.js';
import { pathSegmentAt } from '../../shapes/path-geometry.js';
import { joinPaths, closePathIfCoincident, resizeRectanglePoints } from '../../shapes/path-operations.js';
import { cloneShapeGeometry, applyShapeGeometry } from '../../core/pcb-board-shapes.js';
import { isLayerVisible } from './layers.js';
import { boardShapeLocked } from './object-locks.js';
import { RemoveBoardShapeCommand } from './shape-commands.js';
import { CompoundCommand } from './track-commands.js';
import { clearAxisGlow, renderAxisGlow, pathAlignmentSegments, squareAlignmentSegments } from '../../shapes/axis-glow.js';
import { pathContinuationConstraints, pathSegmentConstraints } from '../../shapes/path-snap.js';
import { syncPcbSelection } from './selection-registry.js';
import { renderPcbSelectionAnchors } from './selection-anchors.js';
import { finishSelectionInteraction, getSelectionInteraction, setSelectionInteraction } from './selection-interaction.js';
import { snapPathPoint, snapPathTranslation } from './path-edit.js';
import { resizePicturePoints } from '../../shared/pcb/picture-raster.js';
import { cancelPictureCopperRefresh, isShapeClearancePending, schedulePictureCopperRefresh } from './picture-refresh.js';
import { BULGE_EPS } from '../../shapes/arc-edge.js';
import { getPropertyEditor } from './property-editors.js';
import { getPcbInteraction, setPcbInteraction } from './pcb-interactions.js';
import { normalizeShapeCopperMode, boardShapeSegmentBulge, boardShapeSegmentWidth } from '../../shared/pcb/board-shape-geometry.js';
import { beginBoardShapePointerPreview, collapseCollinearPolylinePoints, dragProfile, editProfile, editableShapeBulge, finishBoardShapeRotationPreview, getBoardShapeRotationPreview, nextBoardShapeId, normalizeBoardPolylineKind, normalizeStraightArc, remapBoardShapeNodeRadii, selectBoardShape, shapeHandlePoints, splitBoardShapeSegmentMetadata, translateShapeGeometry } from './board-shapes.js';
import { addBoardShapeOrTrackCommand, copperPathReplacementCommands, selectReplacementTracks } from './track-shape-conversion.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */
/** @typedef {import('../../shapes/track.js').Track} Track */
/** @typedef {{x: number, y: number, [key: string]: any}} Point */
/** @typedef {import('../../core/pcb-board-shapes.js').BoardShape} BoardShape */
/** @typedef {import('../../core/pcb-board-shapes.js').BoardPathShape} BoardPathShape */
/** @typedef {import('../../core/pcb-board-shapes.js').BoardShapeGeometry} BoardShapeGeometry */
/** @typedef {import('./board-shapes.js').BoardShapeEditProfile} BoardShapeEditProfile */
/** @typedef {Record<string, any>} BoardShapeDrag */

/** @param {PcbEditor} app */
function snapActive(app) {
    let snap = !!app.viewport?.snapToGrid;
    if (app.viewport?.shiftHeld && app.viewport?.gridVisible) snap = !snap;
    return snap;
}

/**
 * The active board-shape drag (`{ original, mode, ... }`), or null.
 * @param {PcbEditor} app
 */
export function getBoardShapeDrag(app) {
    return getPcbInteraction(app, '_shapeDrag');
}

/**
 * Close an open Line when its two endpoints are intentionally coincident.
 * @param {BoardShape} shape
 * @param {number|string|null} handle
 */
function closeBoardLineIfCoincident(shape, handle) {
    if (typeof handle !== 'number' || shape.kind !== 'line'
        || !closePathIfCoincident(/** @type {BoardPathShape} */ (shape), handle)) return false;
    normalizeBoardPolylineKind(shape);
    return true;
}

/**
 * Find a compatible open-Line endpoint to merge with the dragged endpoint.
 * @param {PcbEditor} app
 * @param {BoardShape} shape
 * @param {number|string|null} handle
 * @param {Point} worldPos
 */
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

/**
 * Combine two open Lines whose selected endpoints have been snapped together.
 * @param {PcbEditor} app
 * @param {BoardShape} first
 * @param {number} firstEndpoint
 * @param {BoardShape} second
 * @param {number} secondEndpoint
 */
function mergeBoardLines(app, first, firstEndpoint, second, secondEndpoint) {
    return /** @type {BoardShape} */ (/** @type {unknown} */ ({
        ...joinPaths(/** @type {BoardPathShape} */ (first), firstEndpoint,
            /** @type {BoardPathShape} */ (second), secondEndpoint),
        id: nextBoardShapeId(app),
        net: '',
    }));
}

// â”€â”€ Geometry clone / translate (shared by drag + commands) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** @param {BoardShapeGeometry} geom */
function geomAnchor(geom) {
    return geom.points ? geom.points[0] : geom.start || { x: geom.x, y: geom.y };
}

/**
 * Return the handle key (vertex index, or 'start'/'end'/'bulge') near worldPos, else null.
 * @param {PcbEditor} app
 * @param {BoardShape} shape
 * @param {Point} worldPos
 */
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

/**
 * Apply a live vertex/anchor drag to a shape's geometry, keeping shape invariants.
 * @param {BoardShape} shape
 * @param {BoardShapeDrag} drag
 * @param {Point} snap
 */
export function applyBoardShapeVertexResize(shape, drag, snap) {
    const segmentBulge = typeof drag.handle === 'string' ? /^bulge:(\d+)$/.exec(drag.handle) : null;
    if (segmentBulge && (shape.kind === 'line' || shape.kind === 'polygon')) {
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

/**
 * @param {BoardShape} shape
 * @param {Point} worldPos
 * @param {number} tolerance
 */
export function polygonSegmentIndexAt(shape, worldPos, tolerance) {
    if (shape.kind !== 'line' && shape.kind !== 'polygon' && shape.kind !== 'rect' || !Array.isArray(shape.points) || shape.points.length < 2) return null;
    const count = shape.kind === 'line' ? shape.points.length - 1 : shape.points.length;
    return pathSegmentAt(worldPos, /** @type {any} */ (shape.points.slice(0, count).map((start, id) => ({
        id, start, end: shape.points[(id + 1) % shape.points.length],
        bulge: boardShapeSegmentBulge(shape, id), lineWidth: boardShapeSegmentWidth(shape, id),
    }))), tolerance);
}

/**
 * @param {PcbEditor} app
 * @param {BoardShapeGeometry} before
 * @param {number} index
 * @param {Point} worldPos
 * @param {boolean} closed
 * @param {boolean} [requireGrid]
 * @param {number[]} [bulges]
 */
function polygonVertexSnap(app, before, index, worldPos, closed, requireGrid = false, bulges = []) {
    const points = before.points || [];
    if (points.length < 2) return snapPathPoint(app, worldPos);
    const neighbours = [];
    if (index > 0 || closed) neighbours.push(points[(index + points.length - 1) % points.length]);
    if (index < points.length - 1 || closed) neighbours.push(points[(index + 1) % points.length]);
    return snapPathPoint(app, worldPos, neighbours, false, pathContinuationConstraints(points, closed, index, bulges));
}

/** @param {PcbEditor} app */
function clearPolygonAxisIndicators(app) {
    clearAxisGlow(app);
}

/** @param {BoardShape} shape */
export function boardSquareIndicators(shape) {
    if (shape.kind !== 'rect') return [];
    return squareAlignmentSegments(shape.points || [],
        (shape.points || []).map(/** @param {any} _ @param {number} index */ (_, index) => boardShapeSegmentWidth(shape, index)))
        .map(segment => ({ ...segment, layerId: shape.layer }));
}

/**
 * @param {PcbEditor} app
 * @param {BoardShape} shape
 * @param {number|string|Array<number|string>} indices
 * @param {number[]} [excludedSegments]
 * @param {number|null} [haloMarginPx]
 */
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
        const segment = bulgeSegment ?? 0;
        const pathShape = /** @type {BoardPathShape} */ (shape);
        renderAxisGlow(app, [{
            a: shape.kind === 'arc' ? shape.start : pathShape.points[segment],
            b: shape.kind === 'arc' ? shape.end : pathShape.points[(segment + 1) % pathShape.points.length],
            layerId: shape.layer,
            width: boardShapeSegmentWidth(shape, segment),
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
    if (shape.kind === 'circle' || shape.kind === 'image' || !shape.points?.length) {
        clearAxisGlow(app);
        return;
    }
    const pathShape = /** @type {BoardPathShape} */ (shape);
    const segments = pathAlignmentSegments(pathShape.points, pathShape.kind !== 'line',
        /** @type {number[]} */ (Array.isArray(indices) ? indices : [indices]),
        pathShape.points.map(/** @param {any} _ @param {number} index */ (_, index) => boardShapeSegmentWidth(shape, index)),
        pathShape.points.map(/** @param {any} _ @param {number} index */ (_, index) => boardShapeSegmentBulge(shape, index)), excludedSegments)
        .map(segment => ({ ...segment, layerId: shape.layer, haloMarginPx }));
    renderAxisGlow(app, segments);
}

/**
 * Snap a parallel segment drag when either adjoining segment reaches H/V/45.
 * @param {PcbEditor} app
 * @param {BoardShape} shape
 * @param {BoardShapeGeometry} before
 * @param {number} segment
 * @param {Point} worldPos
 */
function snapPolylineSegmentDrag(app, shape, before, segment, worldPos) {
    const points = before.points || [];
    const firstIndex = segment;
    const secondIndex = shape.kind === 'line' ? segment + 1 : (segment + 1) % points.length;
    const first = points[firstIndex];
    if (!first) return { dx: 0, dy: 0 };
    const closed = shape.kind !== 'line';
    const segmentBulges = Object.assign([], shape.segmentBulges || {});
    const constraints = pathSegmentConstraints(points, closed, segment, segmentBulges);
    const startWorld = /** @type {Point} */ (before.startWorld);
    const delta = snapPathTranslation(app, [points[firstIndex], points[secondIndex]],
        { x: worldPos.x - startWorld.x, y: worldPos.y - startWorld.y }, [], constraints);
    return { dx: delta.x, dy: delta.y };
}

// â”€â”€ Drag (move whole shape) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * @param {PcbEditor} app
 * @param {BoardShape} shape
 * @param {Point} worldPos
 * @param {number|string|null} [anchorId]
 * @param {{whole?: boolean, allowSegment?: boolean, segment?: number, editProfile?: BoardShapeEditProfile}} [options]
 */
export function startBoardShapeDrag(app, shape, worldPos, anchorId = null, options = {}) {
    const profile = editProfile(options.editProfile);
    shape = profile.canonical(app, shape);
    getPropertyEditor(app, profile.editorKey)?.commit();
    if (!profile.canEdit(app, shape)) return false;
    const activeDrag = getBoardShapeDrag(app);
    if (activeDrag?.preparing && activeDrag.original === shape) return true;
    if (activeDrag) throw new Error('Finish the current shape drag before starting another.');
    if (!!getBoardShapeRotationPreview(app)) {
        if (!finishSelectionInteraction(app, true)) finishBoardShapeRotationPreview(app, true);
    }
    profile.prepareDrag?.(app, shape);
    const before = cloneShapeGeometry(shape);
    const beforeState = profile.capture(shape);
    let handle = anchorId != null ? anchorId : options.whole ? null : hitTestBoardShapeVertex(app, shape, worldPos);
    const midpointMatch = typeof anchorId === 'string' ? /^mid:(\d+)$/.exec(anchorId) : null;
    if (midpointMatch) profile.setNodeFocus(app, null);
    let mode = handle != null ? 'vertex' : 'move';
    let segment = null;
    const drag = {
        original: shape, shape, id: shape.id, before, beforeState, editProfile: profile,
        startWorld: { x: worldPos.x, y: worldPos.y }, sourceAnchorId: anchorId,
    };
    if ((shape.kind === 'line' || shape.kind === 'polygon' || shape.kind === 'rect') && midpointMatch) {
        segment = Number(midpointMatch[1]);
        const pathShape = /** @type {BoardPathShape} */ (shape);
        if (segment >= 0 && segment < pathShape.points.length) {
            shape = beginBoardShapePointerPreview(app, drag);
            const previewPath = /** @type {BoardPathShape} */ (shape);
            const next = previewPath.points[(segment + 1) % previewPath.points.length];
            const point = previewPath.points[segment];
            if (shape.kind === 'rect') {
                /** @type {import('../../core/pcb-board-shapes.js').BoardShapeBase} */ (shape).kind = 'polygon';
            }
            splitBoardShapeSegmentMetadata(shape, segment);
            remapBoardShapeNodeRadii(shape, segment + 1, 1);
            previewPath.points.splice(segment + 1, 0, { x: (point.x + next.x) / 2, y: (point.y + next.y) / 2 });
            handle = segment + 1;
            mode = 'vertex';
        }
    } else if (options.allowSegment && (shape.kind === 'line' || shape.kind === 'polygon' || shape.kind === 'rect') && handle == null) {
        segment = Number.isInteger(options.segment)
            ? options.segment
            : polygonSegmentIndexAt(shape, worldPos, Math.max(0.3, 8 / Math.max(0.01, app.viewport?.scale || 1)));
        if (segment != null) {
            mode = 'segment';
            profile.setSegmentFocus(app, { shapeId: shape.id, segment });
        }
    }
    const bulgeMatch = typeof handle === 'string' ? /^bulge:(\d+)$/.exec(handle) : null;
    if (bulgeMatch || shape.kind === 'arc' && handle === 'bulge') {
        profile.setNodeFocus(app, null);
        profile.setSegmentFocus(app, { shapeId: shape.id, segment: bulgeMatch ? Number(bulgeMatch[1]) : 0 });
        profile.showProperties(app, shape);
    } else if (mode !== 'segment') profile.setSegmentFocus(app, null);
    profile.renderSegmentSelection(app);
    setPcbInteraction(app, '_shapeDrag', Object.assign(drag, {
        mode,
        handle,
        segment,
        vertexBefore: cloneShapeGeometry(shape),
        session: beginDragSession(app, { nets: profile.dragRatsnestNets?.(shape) }),
    }));
    app.setPcbStatus();
    if (profile.kind === 'shape' && (mode === 'vertex' || mode === 'segment')) schedulePictureCopperRefresh(app, shape);
    const vertex = midpointMatch ? /** @type {BoardPathShape} */ (shape).points[/** @type {number} */ (handle)] : handle != null
        ? shapeHandlePoints(shape).find((point) => point.key === handle)
        : null;
    app.viewport?.setCrosshair?.(vertex || (mode === 'move' ? /** @type {Point} */ (geomAnchor(before)) : worldPos));
    return true;
}

/**
 * @param {PcbEditor} app
 * @param {Point} worldPos
 */
export function handleBoardShapeDrag(app, worldPos) {
    const d = getBoardShapeDrag(app);
    if (!d) return;
    const profile = dragProfile(d);
    if (!Number.isFinite(worldPos?.x) || !Number.isFinite(worldPos?.y)) {
        endBoardShapeDrag(app, false);
        throw new Error('Shape drag requires a finite position.');
    }
    if (!profile.canEdit(app, d.original)) {
        endBoardShapeDrag(app, false);
        return;
    }
    if (!d.preview && worldPos.x === d.startWorld.x && worldPos.y === d.startWorld.y) return;
    const modifiers = `${!!app.viewport?.shiftHeld}:${!!app.viewport?.gridVisible}:${app.viewport?.gridSize}:${app.viewport?.scale}:${app.viewport?.snapToGrid}:${snapActive(app)}`;
    if (d.lastPoint?.x === worldPos.x && d.lastPoint?.y === worldPos.y && d.lastModifiers === modifiers) return;
    d.lastPoint = { ...worldPos };
    d.lastModifiers = modifiers;
    const s = beginBoardShapePointerPreview(app, d);
    const before = d.editBefore || d.before, beforeKind = d.editKind || d.beforeState.kind;
    if (profile.kind === 'shape' && (d.mode === 'vertex' || d.mode === 'segment')) schedulePictureCopperRefresh(app, s);
    if (d.mode === 'vertex') {
        const polylineDrag = (['line', 'polygon'].includes(beforeKind) && typeof d.handle === 'number')
            || (typeof d.sourceAnchorId === 'string' && d.sourceAnchorId.startsWith('mid:'));
        const editingSegmentBulge = typeof d.handle === 'string' && d.handle.startsWith('bulge:');
        const editingArcEndpoint = s.kind === 'arc' && (d.handle === 'start' || d.handle === 'end');
        let snap = editingSegmentBulge ? snapPathPoint(app, worldPos, []) : polylineDrag && typeof d.handle === 'number'
            ? polygonVertexSnap(app, d.vertexBefore || before, d.handle, worldPos, beforeKind !== 'line',
                snapActive(app) ?? app.viewport?.snapToGrid !== false, s.segmentBulges || [])
            : editingArcEndpoint
                ? polygonVertexSnap(app, { points: [before.start, before.end] }, d.handle === 'start' ? 0 : 1,
                    worldPos, false, snapActive(app) ?? app.viewport?.snapToGrid !== false)
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
            s.points = d.vertexBefore.points.map(/** @param {Point} point @param {number} index */ (point, index) => index === d.handle ? { ...snap } : { ...point });
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
        app.viewport?.setCrosshair?.(handle || snap);
        profile.render(app, s, { liveDrag: true });
        profile.renderHandles(app, s);
        profile.renderSegmentSelection(app);
        profile.syncProperties(app, s);
        if (['line', 'polygon', 'rect', 'arc'].includes(s.kind)) renderPolygonAxisIndicators(app, s, d.handle);
        refreshDragRatlines(app, d.session);
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
        app.viewport?.setCrosshair?.({ x: d.startWorld.x + dx, y: d.startWorld.y + dy });
        normalizeBoardPolylineKind(s);
        profile.render(app, s, { liveDrag: true });
        profile.renderHandles(app, s);
        profile.renderSegmentSelection(app);
        if (['line', 'polygon', 'rect'].includes(s.kind)) {
            renderPolygonAxisIndicators(app, s, [firstIndex, secondIndex], [d.segment]);
        }
        refreshDragRatlines(app, d.session);
        return;
    }
    const dx = worldPos.x - d.startWorld.x;
    const dy = worldPos.y - d.startWorld.y;
    // Snap by the shape's anchor point so the whole shape lands on the grid.
    const anchor = /** @type {Point} */ (geomAnchor(d.before));
    const delta = snapPathTranslation(app, d.before.points || [anchor], { x: dx, y: dy }, [anchor]);
    const snapped = { x: anchor.x + delta.x, y: anchor.y + delta.y };
    applyShapeGeometry(s, translateShapeGeometry(d.before, delta.x, delta.y));
    app.viewport?.setCrosshair?.(snapped);
    profile.render(app, s, { liveDrag: true });
    profile.renderHandles(app, s);
    renderAxisGlow(app, boardSquareIndicators(s));
    refreshDragRatlines(app, d.session);
}

/**
 * @param {PcbEditor} app
 * @param {boolean} commit
 */
export function endBoardShapeDrag(app, commit) {
    const d = getBoardShapeDrag(app);
    if (!d) return;
    const profile = dragProfile(d);
    setPcbInteraction(app, '_shapeDrag', null);
    const interaction = getSelectionInteraction(app);
    if (interaction?.adapter?.kind === profile.kind
        || (interaction?.mode === 'move-adapter' && interaction.entry.kind === profile.kind)) setSelectionInteraction(app, null);
    app.setPcbStatus();
    app.viewport?.hideCrosshair?.();
    clearPolygonAxisIndicators(app);
    releaseDragSession(app, d.session);
    const s = d.shape, original = d.original;
    const originals = profile.collection(app);
    const present = originals.includes(original);
    if (d.splitRemainder) profile.remove(app, d.splitRemainder);
    let committed = false;
    try {
        if (commit && !present) throw new Error(profile.missingDragMessage);
        if (!commit || !d.preview || !profile.canEdit(app, original)) return;
        if (d.splitBeforeState) {
            const first = s.points[0], last = d.splitOrigin || s.points.at(-1);
            if (Math.hypot(first.x - last.x, first.y - last.y) < 1e-9) return;
        }
        const target = profile.kind === 'shape' && !d.splitBeforeState ? d.joinTarget?.shape : null;
        if (s.kind === 'line' && target) {
            if (!originals.includes(target)) throw new Error('Cannot join a missing board shape.');
            if (boardShapeLocked(target) || !isLayerVisible(target.layer)) return;
            const merged = mergeBoardLines(app, s, /** @type {number} */ (d.handle), target, d.joinTarget.endpoint);
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
        const afterState = profile.capture(s);
        if (JSON.stringify(afterState) === JSON.stringify(d.beforeState)
            || !profile.valid(app, s)) return;
        const command = profile.makeCommand(app, original, d.beforeState, afterState, s, d);
        const replacement = profile.kind === 'shape' ? copperPathReplacementCommands(app, original, s) : null;
        const remainder = d.splitRemainder ? addBoardShapeOrTrackCommand(app, d.splitRemainder) : null;
        const commands = [...(replacement ? replacement.commands : [command]), ...(remainder ? [remainder.command] : [])];
        if (replacement) selectBoardShape(app, null);
        app.history.execute(commands.length === 1 ? commands[0] : new CompoundCommand(commands));
        committed = true;
        const tracks = /** @type {Track[]} */ ([replacement?.track, remainder?.track].filter(Boolean));
        if (tracks.length) selectReplacementTracks(app, tracks);
    } finally {
        if (!committed) {
            if (d.splitBeforeState) profile.setNodeFocus(app, null);
            if (present) {
                if (profile.kind === 'shape') schedulePictureCopperRefresh(app, isShapeClearancePending(app, original) ? original : undefined);
                profile.render(app, original, { liveDrag: true });
                profile.showProperties(app, original);
            } else {
                profile.remove(app, original);
                syncPcbSelection(app);
                renderPcbSelectionAnchors(app);
            }
            if (profile.kind === 'shape') cancelPictureCopperRefresh(app);
        }
        profile.afterCommit(app, original, committed, d);
    }
}
