import { pointInPolygon, distanceToSegment } from '../../core/geometry.js';
import { roundedPathCorners, sampleRoundedCorner as sampleRoundedPolygonCorner, roundedPathData } from '../../shapes/rounded-path.js';
import { controlArcGeometry, sampleControlArc } from '../../shapes/arc-edit.js';
import { pathStrokeSegments, hitTestStrokeSegments, pointsBounds, circleOuterRadius, circleHitTest, curveRatlineTargets } from '../../shapes/path-geometry.js';
import { primitiveShapePath } from '../../shapes/shape-drawing.js';
import ClipperLib from '../../../assets/vendor/clipper.esm.js';
import { pictureContours, pictureCirclePathD, pictureOutlineRings } from './picture-raster.js';
import { BULGE_EPS, arcEdgeContinuation, sampleArcEdge } from '../../shapes/arc-edge.js';
import { closedShapeOutline } from '../../shapes/closed-outline.js';

/**
 * @typedef {import('../../core/geometry.js').Point} Point
 * @typedef {import('../../shapes/path-geometry.js').StrokeSegment} StrokeSegment
 * @typedef {import('../../shapes/shape-drawing.js').PrimitiveShape} PrimitiveShape
 * @typedef {'line'|'rect'|'polygon'|'arc'|'circle'|'image'} BoardShapeKind
 * @typedef {'add'|'remove-copper'|'remove-solder-mask'|'remove-copper-mask'} BoardShapeCopperMode
 * @typedef {{[key: string]: number}} NumberRecord
 * @typedef {{X: number, Y: number}} IntPoint
 * @typedef {IntPoint[]} IntPath
 * @typedef {IntPath[]} IntPaths
 * @typedef {{minX: number, minY: number, maxX: number, maxY: number}} Bounds
 * @typedef {{key?: string, contours: Point[][], bounds?: Bounds|null}} ClosedContourEntry
 * @typedef {{id?: string, type?: string, kind?: BoardShapeKind|string, layer?: string|null, points?: Point[], start?: Point, end?: Point, bulge?: Point, x?: number, y?: number, radius?: number, lineWidth?: number, segmentWidths?: NumberRecord, segmentBulges?: NumberRecord, nodeCornerRadii?: NumberRecord, cornerRadius?: number, filled?: boolean, copperMode?: string, plated?: boolean, net?: string, locked?: boolean, [key: string]: unknown}} BoardShape
 * @typedef {BoardShape & {kind: 'line'|'rect'|'polygon'|'image', points: Point[]}} BoardPathShape
 * @typedef {BoardShape & {kind: 'arc', start: Point, end: Point, bulge: Point}} BoardArcShape
 * @typedef {BoardShape & {kind: 'circle', x: number, y: number, radius: number}} BoardCircleShape
 * @typedef {{path: Point[], pathClosed: boolean, centerline: Point[], centerlineClosed: boolean, areaOutline: Point[], image: BoardShape|null, physicalContours: Point[][], circle: {x: number, y: number, radius: number, outerRadius: number}|null, filled: boolean, lineWidth: number, strokeSegments: StrokeSegment[], copperMode: BoardShapeCopperMode}} ResolvedBoardShapeGeometry
 */

/** @param {number} n */
const r4 = (n) => Math.round(n * 10000) / 10000;

/** @param {BoardShape|null|undefined} shape @returns {shape is BoardArcShape} */
function isBoardArcShape(shape) { return shape?.kind === 'arc'; }

/** @param {BoardShape|null|undefined} shape @returns {shape is BoardCircleShape} */
function isBoardCircleShape(shape) { return shape?.kind === 'circle'; }

/** @param {BoardShape|null|undefined} shape @returns {shape is BoardPathShape} */
function isBoardPathShape(shape) {
    return shape?.kind === 'line' || shape?.kind === 'rect' || shape?.kind === 'polygon' || shape?.kind === 'image';
}

/** @param {BoardShape|null|undefined} shape @returns {shape is BoardPathShape & {kind: 'line'|'rect'|'polygon'}} */
function isBoardPolylineShape(shape) {
    return shape?.kind === 'line' || shape?.kind === 'rect' || shape?.kind === 'polygon';
}

/** @param {BoardShape|null|undefined} shape @returns {shape is BoardPathShape & {kind: 'rect'|'polygon'}} */
function isClosedBoardPathShape(shape) {
    return shape?.kind === 'rect' || shape?.kind === 'polygon';
}

/** Return a supported copper mode, defaulting invalid internal values to add. @param {unknown} mode @returns {BoardShapeCopperMode} */
export function normalizeShapeCopperMode(mode) {
    const m = String(mode || 'add');
    return m === 'remove-copper' || m === 'remove-solder-mask' || m === 'remove-copper-mask' ? m : 'add';
}

/** @param {unknown} layer */
export function isMaskLayer(layer) {
    const l = String(layer || '');
    return l === 'top-mask' || l === 'bottom-mask';
}

/** Canonical circle geometry for a board-shape arc. @param {BoardShape|null|undefined} shape */
export function boardShapeArcGeometry(shape) {
    if (!isBoardArcShape(shape)) return null;
    return controlArcGeometry(shape);
}

/** Tessellate an arc into points (start → … → end), passing through the bulge. @param {BoardArcShape} shape @param {number} [segments] @returns {Point[]} */
function arcSamples(shape, segments = 48) {
    return sampleControlArc(shape, segments);
}

/** Clamp a rectangle's corner radius to its current dimensions. @param {BoardShape|null|undefined} shape */
export function rectCornerRadius(shape) {
    if (shape?.kind !== 'rect') return 0;
    const points = shape.points || [];
    if (points.length !== 4) return 0;
    return Math.max(0, Math.min(
        Number(shape.cornerRadius) || 0,
        Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y) / 2,
        Math.hypot(points[3].x - points[0].x, points[3].y - points[0].y) / 2,
    ));
}

/** Corner radius shared by every node of a closed polygon. @param {BoardShape|null|undefined} shape */
export function polygonCornerRadius(shape) {
    return shape?.kind === 'line' || shape?.kind === 'polygon' ? Math.max(0, Number(shape.cornerRadius) || 0) : 0;
}

/** @param {BoardShape|null|undefined} shape @param {number} index */
export function boardShapeNodeCornerRadius(shape, index) {
    const fallback = shape?.kind === 'rect' ? rectCornerRadius(shape) : polygonCornerRadius(shape);
    return Math.max(0, Number(shape?.nodeCornerRadii?.[index] ?? fallback) || 0);
}

/** @param {BoardPathShape} shape */
function roundedPolygonCorners(shape) {
    const points = shape.points || [];
    const hasRadius = points.some((_, index) => boardShapeNodeCornerRadius(shape, index) > 0);
    if (points.length < 3 || !hasRadius) return [];
    const radii = points.map((_, index) => boardShapeSegmentBulge(shape, (index + points.length - 1) % points.length)
        || boardShapeSegmentBulge(shape, index) ? 0 : boardShapeNodeCornerRadius(shape, index));
    return roundedPathCorners(points, radii, shape.kind !== 'line');
}

/** @param {BoardPathShape} shape @param {number} [segments] @returns {Point[]} */
function roundedPolygonOutline(shape, segments = undefined) {
    const corners = roundedPolygonCorners(shape);
    if (!corners.length) return (shape.points || []).map((point) => ({ ...point }));
    return corners.flatMap((corner, index) => {
        const points = sampleRoundedPolygonCorner(corner, segments);
        if (index < corners.length - 1 || shape.kind !== 'line') {
            const next = corners[(index + 1) % corners.length];
            points.push(...sampleArcEdge(corner.exit, next.entry, boardShapeSegmentBulge(shape, index), 64));
        }
        return points;
    });
}

/** @param {BoardPathShape} shape */
function roundedPolygonPath(shape) {
    const corners = roundedPolygonCorners(shape);
    return roundedPathData(corners, shape.kind !== 'line',
        corners.map((_, index) => boardShapeSegmentBulge(shape, index)), r4);
}

/** @param {BoardShape} shape @param {number} [segments] @returns {Point[]} */
export function circleOutline(shape, segments = 48) {
    const circle = /** @type {BoardCircleShape} */ (shape);
    const radius = Math.max(0.05, Number(circle.radius) || 0);
    /** @type {Point[]} */
    const points = [];
    for (let index = 0; index < segments; index++) {
        const angle = Math.PI * 2 * (index / segments);
        points.push({
            x: circle.x + radius * Math.cos(angle),
            y: circle.y + radius * Math.sin(angle),
        });
    }
    return points;
}

/** @param {BoardShape} shape */
export function circleFilledRadius(shape) {
    return circleOuterRadius(shape);
}

/** @param {BoardShape|null|undefined} shape @param {number} segment */
export function boardShapeSegmentBulge(shape, segment) {
    const value = Number(shape?.segmentBulges?.[segment]);
    return Number.isFinite(value) && Math.abs(value) >= BULGE_EPS
        ? Math.max(-1, Math.min(1, value))
        : 0;
}

/** @param {BoardPathShape} shape @returns {Point[]} */
function sampledBoardShapePoints(shape) {
    const points = shape.points || [];
    if (!['line', 'polygon'].includes(shape.kind) || points.length < 2) {
        return points.map(point => ({ ...point }));
    }
    const count = shape.kind === 'line' ? points.length - 1 : points.length;
    const sampled = [{ ...points[0] }];
    for (let index = 0; index < count; index++) {
        const end = points[(index + 1) % points.length];
        sampled.push(...sampleArcEdge(points[index], end, boardShapeSegmentBulge(shape, index), 64));
    }
    if (shape.kind !== 'line') sampled.pop();
    return sampled;
}

/** Outline points used for fill hit-testing, copper cuts and bounds. @param {BoardShape} shape @returns {Point[]} */
export function shapeOutline(shape) {
    if (isClosedBoardPathShape(shape) || isBoardCircleShape(shape)) return closedShapeOutline(shape);
    if (isBoardArcShape(shape)) return arcSamples(shape);
    if (shape.kind === 'line' && roundedPolygonCorners(/** @type {BoardPathShape} */ (shape)).length) return roundedPolygonOutline(/** @type {BoardPathShape} */ (shape));
    if (shape.kind === 'line' && Object.keys(shape.segmentBulges || {}).length) {
        return sampledBoardShapePoints(/** @type {BoardPathShape} */ (shape));
    }
    return (shape.points || []).map((p) => ({ x: p.x, y: p.y }));
}

/** Rectangles without per-node radii round with circular arcs; other paths use quadratic corners. @param {BoardShape|null|undefined} shape */
export function boardShapeHasCircularCorners(shape) {
    return shape?.kind === 'rect' && !Object.keys(shape.nodeCornerRadii || {}).length;
}

/**
 * Ratline endpoints on a shape's drawn copper, by the same rule as Tracks:
 * nodes the copper passes through, plus a few points along every curve (rounded
 * corners and arc segments), never the off-copper node of a rounded corner.
 * @param {BoardShape} shape
 * @returns {Point[]}
 */
export function boardShapeRatlineTargets(shape) {
    if (isBoardArcShape(shape)) return curveRatlineTargets(arcSamples(shape));
    if (!isBoardPolylineShape(shape)) return shapeOutline(shape);
    const points = shape.points || [];
    const closed = shape.kind !== 'line';
    const bulges = points.map((_, index) => boardShapeSegmentBulge(shape, index));
    // Corners beside an arc segment stay sharp, as in pathStrokeSegments.
    const radii = points.map((_, index) => bulges[(index + points.length - 1) % points.length] || bulges[index]
        ? 0 : boardShapeNodeCornerRadius(shape, index));
    const corners = roundedPathCorners(points, radii, closed, boardShapeHasCircularCorners(shape));
    /** @type {Point[]} */
    const targets = [];
    corners.forEach((corner, index) => {
        targets.push(...curveRatlineTargets(sampleRoundedPolygonCorner(corner)));
        const next = corners[(index + 1) % corners.length];
        if (bulges[index] && (closed || index < corners.length - 1)) {
            targets.push(...curveRatlineTargets([corner.exit, ...sampleArcEdge(corner.exit, next.entry, bulges[index], 64)]));
        }
    });
    return targets;
}

/** Outline edges as [p, q] pairs (closed for rect/polygon, open for arcs/lines). @param {BoardShape} shape @returns {Array<[Point, Point]>} */
function shapeSegments(shape) {
    if (isBoardArcShape(shape)) {
        const s = arcSamples(shape);
        /** @type {Array<[Point, Point]>} */
        const segs = [];
        for (let i = 0; i < s.length - 1; i++) segs.push([s[i], s[i + 1]]);
        return segs;
    }
    const pts = shapeOutline(shape);
    /** @type {Array<[Point, Point]>} */
    const segs = [];
    const closed = shape.kind !== 'line';
    for (let i = 0; i < pts.length - (closed ? 0 : 1); i++) {
        segs.push([pts[i], pts[(i + 1) % pts.length]]);
    }
    return segs;
}

/** @param {BoardShape} shape @returns {StrokeSegment[]} */
export function boardShapeStrokeSegments(shape) {
    if (isBoardPolylineShape(shape)) {
        const points = shape.points || [];
        return pathStrokeSegments(points, shape.kind !== 'line',
            points.map((_, index) => boardShapeSegmentWidth(shape, index)),
            points.map((_, index) => boardShapeSegmentBulge(shape, index)),
            points.map((_, index) => boardShapeNodeCornerRadius(shape, index)),
            normalizedBoardShapeLineWidth(shape, shape.lineWidth),
            boardShapeHasCircularCorners(shape));
    }
    return shapeSegments(shape).map(([start, end], index) => ({
        start, end, lineWidth: boardShapeSegmentWidth(shape, index), logicalSegment: index,
    }));
}

/** @param {StrokeSegment[]} segments @param {number} scale @returns {IntPaths} */
function roundStrokePaths(segments, scale) {
    /** @type {IntPaths} */
    const paths = [];
    for (const { start, end, lineWidth } of segments) {
        const offset = new ClipperLib.ClipperOffset(2, 0.001 * scale);
        offset.AddPath([start, end].map(point => ({ X: Math.round(point.x * scale), Y: Math.round(point.y * scale) })),
            ClipperLib.JoinType.jtRound, ClipperLib.EndType.etOpenRound);
        /** @type {IntPaths} */
        const expanded = [];
        offset.Execute(expanded, lineWidth * scale / 2);
        paths.push(...expanded);
    }
    return paths;
}

/** @param {Point[]} points */
function outlinePathD(points) {
    if (!Array.isArray(points) || points.length < 3) return '';
    let d = `M ${r4(points[0].x)} ${r4(points[0].y)}`;
    for (let index = 1; index < points.length; index++) d += ` L ${r4(points[index].x)} ${r4(points[index].y)}`;
    return d + ' Z';
}

/** @param {BoardShape} shape */
function shapeHasUnroundedCorners(shape) {
    return isClosedBoardPathShape(shape)
        && !Object.keys(shape.segmentBulges || {}).length
        && !(Number(shape.cornerRadius) > 0)
        && !Object.values(shape.nodeCornerRadii || {}).some((radius) => Number(radius) > 0);
}

// Clipper contours cost milliseconds and are read by every selection hit test and
// bounds query, so each shape keeps its last two results (filled and outline-only
// variants), keyed on every geometry input. Shapes are mutated in place, so the
// key is rebuilt on each read rather than invalidated by callers.
/** @type {WeakMap<BoardShape, ClosedContourEntry[]>} */
const closedContourCache = new WeakMap();

/** @param {NumberRecord|null|undefined} record */
function recordKey(record) {
    let key = '';
    if (record) for (const name in record) key += `${name}:${record[name]},`;
    return key;
}

/** @param {BoardPathShape} shape @param {boolean} filled @param {number} lineWidth */
function closedContourKey(shape, filled, lineWidth) {
    let key = `${shape.kind}|${shape.layer}|${filled}|${lineWidth}|${shape.lineWidth}|${shape.cornerRadius}|`;
    for (const point of shape.points) key += `${point.x},${point.y};`;
    return `${key}|${recordKey(shape.nodeCornerRadii)}|${recordKey(shape.segmentBulges)}|${recordKey(shape.segmentWidths)}`;
}

/** @param {Point[][]} contours @returns {Point[][]} */
function freezeContours(contours) {
    for (const contour of contours) {
        for (const point of contour) Object.freeze(point);
        Object.freeze(contour);
    }
    return /** @type {Point[][]} */ (Object.freeze(contours));
}

/** Shared, frozen contours; callers must copy before modifying them. @param {BoardShape} shape @param {boolean} filled @param {number} lineWidth */
function closedShapeContours(shape, filled, lineWidth) {
    return closedShapeContourEntry(shape, filled, lineWidth)?.contours ?? null;
}

/** @param {BoardShape} shape @param {boolean} filled @param {number} lineWidth @returns {ClosedContourEntry|null} */
function closedShapeContourEntry(shape, filled, lineWidth) {
    if (!isClosedBoardPathShape(shape) || (shape.points?.length ?? Infinity) < 3) return null;
    const pathShape = shape;
    if (!Array.isArray(pathShape.points)) return { contours: computeClosedShapeContours(pathShape, filled, lineWidth) };
    const key = closedContourKey(pathShape, filled, lineWidth);
    let entries = closedContourCache.get(shape);
    const hit = entries?.find(entry => entry.key === key);
    if (hit) return hit;
    /** @type {ClosedContourEntry} */
    const entry = { key, contours: freezeContours(computeClosedShapeContours(pathShape, filled, lineWidth)), bounds: null };
    if (!entries) closedContourCache.set(shape, entries = []);
    entries.unshift(entry);
    if (entries.length > 2) entries.pop();
    return entry;
}

/** Physical contours of a rectangle or polygon with its resolved fill and line width. @param {BoardShape} shape */
function physicalClosedShapeEntry(shape) {
    return closedShapeContourEntry(shape, shapeIsFilled(shape), resolvedBoardShapeLineWidth(shape));
}

/** @param {BoardPathShape} shape @param {boolean} filled @param {number} lineWidth @returns {Point[][]} */
function computeClosedShapeContours(shape, filled, lineWidth) {
    const scale = 10000;
    const path = shapeOutline(shape).map((point) => ({ X: Math.round(point.x * scale), Y: Math.round(point.y * scale) }));
    /** @type {IntPaths} */
    const strokes = [];
    if (Object.keys(shape.segmentWidths || {}).length || Object.keys(shape.segmentBulges || {}).length) {
        strokes.push(...roundStrokePaths(boardShapeStrokeSegments(shape), scale));
    } else if (shapeHasUnroundedCorners(shape)) {
        for (let index = 0; index < path.length; index++) {
            const offset = new ClipperLib.ClipperOffset(10, 0.001 * scale);
            offset.AddPath([path[index], path[(index + 1) % path.length]],
                ClipperLib.JoinType.jtRound, ClipperLib.EndType.etOpenRound);
            /** @type {IntPaths} */
            const paths = [];
            offset.Execute(paths, lineWidth * scale / 2);
            strokes.push(...paths);
        }
    } else {
        const offset = new ClipperLib.ClipperOffset(10, 0.001 * scale);
        offset.AddPath(path, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedLine);
        offset.Execute(strokes, lineWidth * scale / 2);
    }
    /** @type {IntPaths} */
    const outlines = [];
    const clipper = new ClipperLib.Clipper();
    clipper.AddPaths(strokes, ClipperLib.PolyType.ptSubject, true);
    if (filled) {
        clipper.AddPaths(ClipperLib.Clipper.SimplifyPolygon(path, ClipperLib.PolyFillType.pftEvenOdd),
            ClipperLib.PolyType.ptClip, true);
    }
    clipper.Execute(ClipperLib.ClipType.ctUnion, outlines,
        ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftEvenOdd);
    return outlines.map((outline) => outline.map((point) => ({ x: point.X / scale, y: point.Y / scale })));
}

/** @param {BoardShape} shape @returns {Point[][]} */
export function boardShapeFilledRemovalOutlines(shape) {
    const geometry = resolveBoardShapeGeometry(shape);
    if (shape.kind === 'image') return /** @type {Point[][]} */ (geometry.physicalContours);
    if (isClosedBoardPathShape(shape)) return closedShapeContours(shape, true, geometry.lineWidth) || [];
    const halfWidth = geometry.lineWidth / 2;
    if (isBoardCircleShape(shape)) {
        return [circleOutline({ ...shape,
            radius: geometry.circle?.outerRadius ?? shape.radius + halfWidth, filled: false })];
    }
    const scale = 10000;
    const path = shapeOutline(shape).map((point) => ({
        X: Math.round(point.x * scale), Y: Math.round(point.y * scale),
    }));
    if (path.length < 3) return [];
    if (!ClipperLib.Clipper.Orientation(path)) path.reverse();
    const offset = new ClipperLib.ClipperOffset(2, 0.001 * scale);
    offset.AddPath(path, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
    /** @type {IntPaths} */
    const outlines = [];
    offset.Execute(outlines, halfWidth * scale);
    return outlines.map((outline) => outline.map((point) => ({
        x: point.X / scale, y: point.Y / scale,
    })));
}

/** Compound path for filling a shape's physical area with the even-odd rule, without a stroke. @param {BoardShape} shape */
export function boardShapeFillPathD(shape) {
    const rings = shape.kind === 'image' ? pictureOutlineRings(shape) : null;
    return rings ? rings.map(outlinePathD).join(' ') : boardShapeRemovalPathD(shape);
}

/** Compound path for the physical area removed by a copper-mode shape. @param {BoardShape} shape */
export function boardShapeRemovalPathD(shape) {
    if (shape.kind === 'image') {
        const circles = pictureCirclePathD(shape);
        if (circles !== null) return circles;
    }
    const geometry = resolveBoardShapeGeometry(shape);
    if (geometry.physicalContours) return geometry.physicalContours.map(outlinePathD).join(' ');
    if (geometry.filled) {
        return boardShapeFilledRemovalOutlines(shape).map(outlinePathD).join(' ');
    }
    if (isBoardCircleShape(shape)) {
        const outer = shapePathD(shape);
        const innerRadius = shape.radius - geometry.lineWidth;
        return innerRadius > 0 ? outer + ' ' + shapePathD({ ...shape, radius: innerRadius }) : outer;
    }
    if (!geometry.centerlineClosed) {
        const scale = 10000;
        const segments = geometry.strokeSegments.length ? geometry.strokeSegments
            : geometry.centerline.slice(1).map((end, index) => ({
                start: geometry.centerline[index], end, lineWidth: geometry.lineWidth,
            }));
        const union = new ClipperLib.Clipper();
        union.AddPaths(roundStrokePaths(segments, scale), ClipperLib.PolyType.ptSubject, true);
        /** @type {IntPaths} */
        const contours = [];
        union.Execute(ClipperLib.ClipType.ctUnion, contours,
            ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
        return contours.map(contour => outlinePathD(contour.map(point => ({
            x: point.X / scale, y: point.Y / scale,
        })))).join(' ');
    }
    return '';
}

/** Bounds including the visible line width, for shared selection queries. @param {BoardShape} shape */
export function boardShapeBounds(shape) {
    if (isClosedBoardPathShape(shape)) {
        const entry = physicalClosedShapeEntry(shape);
        if (entry) {
            entry.bounds ??= pointsBounds([...shapeOutline(shape), ...entry.contours.flat()], 0);
            return { ...entry.bounds };
        }
    }
    const outline = shapeOutline(shape);
    const halfWidth = shape.kind === 'line' || shape.kind === 'arc' ? boardShapeMaxLineWidth(shape) / 2 : 0;
    return pointsBounds(outline, halfWidth);
}

/** Shared point hit test for board shapes and their selection adapter. @param {BoardShape|null|undefined} shape @param {Point|null|undefined} worldPos @param {number} [tolerance] */
export function boardShapeHitTest(shape, worldPos, tolerance = 0) {
    if (!shape || !worldPos) return false;
    if (shape.kind === 'image') {
        const points = /** @type {Point[]} */ (shape.points);
        return pointInPolygon(worldPos, points) || points.some((point, index) =>
            distanceToSegment(worldPos, point, points[(index + 1) % 4]) <= tolerance);
    }
    if (isBoardCircleShape(shape)) {
        return circleHitTest(shape, worldPos, tolerance, shapeIsFilled(shape), boardShapeMaxLineWidth(shape));
    }
    if (isClosedBoardPathShape(shape)) {
        const contours = physicalClosedShapeEntry(shape)?.contours || [];
        if (contours.reduce((inside, contour) => inside !== pointInPolygon(worldPos, contour), false)) return true;
        return contours.some(contour => contour.some((point, index) =>
            distanceToSegment(worldPos, point, contour[(index + 1) % contour.length]) <= tolerance));
    }
    if (shapeIsFilled(shape) && pointInPolygon(worldPos, shapeOutline(shape))) return true;
    return hitTestStrokeSegments(worldPos, boardShapeStrokeSegments(shape), tolerance);
}

/**
 * SVG path data for a shape. Rectangles and polygons are always closed; arcs
 * are closed only when `close` is set, and lines remain open.
 * @param {BoardShape} shape
 * @param {{close?: boolean}} [options]
 */
export function shapePathD(shape, { close = false } = {}) {
    if (isBoardArcShape(shape) || isBoardCircleShape(shape)) return primitiveShapePath(/** @type {PrimitiveShape} */ (shape), close);
    if (shape.kind === 'rect' && rectCornerRadius(shape) > 0
        && !Object.keys(shape.nodeCornerRadii || {}).length) {
        return primitiveShapePath(/** @type {PrimitiveShape} */ ({ ...shape, cornerRadius: rectCornerRadius(shape) }));
    }
    if (isBoardPolylineShape(shape) && roundedPolygonCorners(shape).length) {
        return roundedPolygonPath(shape);
    }
    const pts = shape.points || [];
    if (!pts.length) return '';
    let d = `M ${r4(pts[0].x)} ${r4(pts[0].y)}`;
    for (let index = 0; index < pts.length - 1; index++) {
        const end = pts[index + 1];
        d += ` ${arcEdgeContinuation(pts[index], end, boardShapeSegmentBulge(shape, index))}`;
    }
    if (shape.kind !== 'line' && boardShapeSegmentBulge(shape, pts.length - 1)) {
        d += ` ${arcEdgeContinuation(/** @type {Point} */ (pts.at(-1)), pts[0], boardShapeSegmentBulge(shape, pts.length - 1))}`;
    }
    return shape.kind === 'line' ? d : d + ' Z';
}

/** True when a shape reads as a solid region for hit-testing. @param {BoardShape|null|undefined} shape */
export function shapeIsFilled(shape) {
    if (shape?.kind === 'image') return true;
    if (shape?.kind === 'line') return false;
    const layer = String((/** @type {BoardShape} */ (shape)).layer || 'top-silk');
    // A hole-layer shape is a board cutout — its whole interior is clickable.
    if (layer === 'hole') return true;
    const isCopperLayer = layer === 'top-copper' || layer === 'bottom-copper';
    if (isCopperLayer) {
        return !!(/** @type {BoardShape} */ (shape)).filled;
    }
    return !!(/** @type {BoardShape} */ (shape)).filled || isMaskLayer(layer);
}

/** Minimum manufacturable outline/slot width for a board shape. @param {BoardShape|null|undefined} shape */
export function boardShapeLineWidthMinimum(shape) {
    return shape?.kind === 'line' && shape?.layer === 'hole' ? 0.8 : 0.05;
}

/** @param {BoardShape|null|undefined} shape @param {unknown} value */
export function normalizedBoardShapeLineWidth(shape, value) {
    const minimum = boardShapeLineWidthMinimum(shape);
    return Math.max(minimum, Number(value) || Math.max(0.2, minimum));
}

/** @param {BoardShape|null|undefined} shape @param {number} segment */
export function boardShapeSegmentWidth(shape, segment) {
    return normalizedBoardShapeLineWidth(shape,
        shape?.segmentWidths?.[segment] ?? shape?.lineWidth);
}

/** @param {BoardShape|null|undefined} shape */
function boardShapeMaxLineWidth(shape) {
    const widths = Object.values(shape?.segmentWidths || {}).map(Number).filter(Number.isFinite);
    return Math.max(normalizedBoardShapeLineWidth(shape, shape?.lineWidth), ...widths);
}

/** Line width used by the physical geometry (circles cannot be thicker than their radius). @param {BoardShape|null|undefined} shape */
function resolvedBoardShapeLineWidth(shape) {
    const radius = Math.max(0.05, Number(shape?.radius) || 0);
    return Math.min(shape?.kind === 'circle' ? radius : Infinity, Math.max(0.05, Number(shape?.lineWidth) || 0.2));
}

/**
 * Resolve a board shape into the common geometry contract consumed by the
 * 2D/3D previews, Gerber exporter, and copper-fill engine.
 * @param {BoardShape} shape
 * @param {{filled?: boolean}} [options]
 * @returns {ResolvedBoardShapeGeometry}
 */
export function resolveBoardShapeGeometry(shape, options = {}) {
    const radius = Math.max(0.05, Number(shape?.radius) || 0);
    const lineWidth = resolvedBoardShapeLineWidth(shape);
    const filled = options.filled ?? shapeIsFilled(shape);
    const centerlineShape = { ...shape, filled: false };
    const centerline = isBoardArcShape(shape)
        ? arcSamples(shape)
        : isBoardCircleShape(shape)
            ? circleOutline(centerlineShape)
            : isBoardPolylineShape(shape)
                ? shapeOutline(centerlineShape)
                : (shape?.points || []).map((point) => ({ ...point }));
    const centerlineClosed = isClosedBoardPathShape(shape) || shape?.kind === 'image';
    const areaOutline = filled && shape?.kind !== 'line'
        ? centerline.map((point) => ({ ...point }))
        : null;
    const strokeSegments = isBoardPolylineShape(shape)
        && (Object.keys(shape?.segmentWidths || {}).length > 0
            || Object.keys(shape?.segmentBulges || {}).length > 0)
        ? boardShapeStrokeSegments(shape).map(({ start, end, lineWidth }) => ({
            start: { ...start }, end: { ...end }, lineWidth,
        }))
        : [];
    return {
        path: shape?.kind === 'circle' ? [] : centerline,
        pathClosed: filled || centerlineClosed,
        centerline,
        centerlineClosed,
        areaOutline: /** @type {Point[]} */ (areaOutline),
        image: shape?.kind === 'image' ? shape : null,
        get physicalContours() {
            return /** @type {Point[][]} */ (shape?.kind === 'image' ? pictureContours(shape) : closedShapeContours(shape, filled, lineWidth));
        },
        circle: isBoardCircleShape(shape)
            ? { x: shape.x, y: shape.y, radius: radius - lineWidth / 2, outerRadius: radius }
            : null,
        filled,
        lineWidth,
        strokeSegments,
        copperMode: normalizeShapeCopperMode(shape?.copperMode),
    };
}
