import { pointInPolygon, distanceToSegment } from '../../core/geometry.js';
import { roundedPathCorners, sampleRoundedCorner as sampleRoundedPolygonCorner, roundedPathData } from '../../shapes/rounded-path.js';
import { controlArcGeometry, sampleControlArc } from '../../shapes/arc-edit.js';
import { pathStrokeSegments, hitTestStrokeSegments, pointsBounds, circleOuterRadius, circleHitTest } from '../../shapes/path-geometry.js';
import { primitiveShapePath } from '../../shapes/shape-drawing.js';
import ClipperLib from '../../../assets/vendor/clipper.esm.js';
import { pictureContours, pictureCirclePathD } from './picture-raster.js';
import { BULGE_EPS, arcEdgeContinuation, sampleArcEdge } from '../../shapes/arc-edge.js';
import { closedShapeOutline } from '../../shapes/closed-outline.js';

const r4 = (n) => Math.round(n * 10000) / 10000;

/** Normalise a copper mode string (back-compatible with old circle modes). */
export function normalizeShapeCopperMode(mode) {
    const m = String(mode || 'add');
    if (m === 'remove-copper' || m === 'remove-solder-mask' || m === 'remove-copper-mask') return m;
    if (m === 'remove') return 'remove-copper-mask';
    if (m === 'remove-mask') return 'remove-solder-mask';
    return 'add';
}

export function isMaskLayer(layer) {
    const l = String(layer || '');
    return l === 'top-mask' || l === 'bottom-mask';
}

/** Canonical circle geometry for a board-shape arc. */
export function boardShapeArcGeometry(shape) {
    if (shape?.kind !== 'arc') return null;
    return controlArcGeometry(shape);
}

/** Tessellate an arc into points (start → … → end), passing through the bulge. */
function arcSamples(shape, segments = 48) {
    return sampleControlArc(shape, segments);
}

/**
 * Walk angles from start through bulge to end. Returns { a1, dir, total }
 * where the arc spans `total` radians from `a1` in direction `dir` (+1/-1),
 * guaranteeing the bulge control point lies on the swept arc.
 */
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

/** Corner radius shared by every node of a closed polygon. */
export function polygonCornerRadius(shape) {
    return ['line', 'polygon'].includes(shape?.kind) ? Math.max(0, Number(shape.cornerRadius) || 0) : 0;
}

export function boardShapeNodeCornerRadius(shape, index) {
    const fallback = shape?.kind === 'rect' ? rectCornerRadius(shape) : polygonCornerRadius(shape);
    return Math.max(0, Number(shape?.nodeCornerRadii?.[index] ?? fallback) || 0);
}

function roundedPolygonCorners(shape) {
    const points = shape.points || [];
    const hasRadius = points.some((_, index) => boardShapeNodeCornerRadius(shape, index) > 0);
    if (points.length < 3 || !hasRadius) return [];
    const radii = points.map((_, index) => boardShapeSegmentBulge(shape, (index + points.length - 1) % points.length)
        || boardShapeSegmentBulge(shape, index) ? 0 : boardShapeNodeCornerRadius(shape, index));
    return roundedPathCorners(points, radii, shape.kind !== 'line');
}

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

function roundedPolygonPath(shape) {
    const corners = roundedPolygonCorners(shape);
    return roundedPathData(corners, shape.kind !== 'line',
        corners.map((_, index) => boardShapeSegmentBulge(shape, index)), r4);
}

export function circleOutline(shape, segments = 48) {
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
    return circleOuterRadius(shape);
}

export function boardShapeSegmentBulge(shape, segment) {
    const value = Number(shape?.segmentBulges?.[segment]);
    return Number.isFinite(value) && Math.abs(value) >= BULGE_EPS
        ? Math.max(-1, Math.min(1, value))
        : 0;
}

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

/** Outline points used for fill hit-testing, copper cuts and bounds. */
export function shapeOutline(shape) {
    if (['rect', 'polygon', 'circle'].includes(shape.kind)) return closedShapeOutline(shape);
    if (shape.kind === 'arc') return arcSamples(shape);
    if (shape.kind === 'line' && roundedPolygonCorners(shape).length) return roundedPolygonOutline(shape);
    if (shape.kind === 'line' && Object.keys(shape.segmentBulges || {}).length) {
        return sampledBoardShapePoints(shape);
    }
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

export function boardShapeStrokeSegments(shape) {
    if (['line', 'polygon', 'rect'].includes(shape.kind)) {
        const points = shape.points || [];
        return pathStrokeSegments(points, shape.kind !== 'line',
            points.map((_, index) => boardShapeSegmentWidth(shape, index)),
            points.map((_, index) => boardShapeSegmentBulge(shape, index)),
            points.map((_, index) => boardShapeNodeCornerRadius(shape, index)),
            normalizedBoardShapeLineWidth(shape, shape.lineWidth),
            shape.kind === 'rect' && !Object.keys(shape.nodeCornerRadii || {}).length);
    }
    return shapeSegments(shape).map(([start, end], index) => ({
        start, end, lineWidth: boardShapeSegmentWidth(shape, index), logicalSegment: index,
    }));
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

function shapeHasUnroundedCorners(shape) {
    return ['rect', 'polygon'].includes(shape.kind)
        && !Object.keys(shape.segmentBulges || {}).length
        && !(Number(shape.cornerRadius) > 0)
        && !Object.values(shape.nodeCornerRadii || {}).some((radius) => Number(radius) > 0);
}

function closedShapeContours(shape, filled, lineWidth) {
    if (!['rect', 'polygon'].includes(shape.kind) || shape.points?.length < 3) return null;
    const scale = 10000;
    const path = shapeOutline(shape).map((point) => ({ X: Math.round(point.x * scale), Y: Math.round(point.y * scale) }));
    const strokes = [];
    if (Object.keys(shape.segmentWidths || {}).length || Object.keys(shape.segmentBulges || {}).length) {
        for (const segment of boardShapeStrokeSegments(shape)) {
            const offset = new ClipperLib.ClipperOffset(10, 0.001 * scale);
            offset.AddPath([segment.start, segment.end].map((point) => ({ X: Math.round(point.x * scale), Y: Math.round(point.y * scale) })),
                ClipperLib.JoinType.jtRound, ClipperLib.EndType.etOpenRound);
            const paths = [];
            offset.Execute(paths, segment.lineWidth * scale / 2);
            strokes.push(...paths);
        }
    } else if (shapeHasUnroundedCorners(shape)) {
        for (let index = 0; index < path.length; index++) {
            const offset = new ClipperLib.ClipperOffset(10, 0.001 * scale);
            offset.AddPath([path[index], path[(index + 1) % path.length]],
                ClipperLib.JoinType.jtRound, ClipperLib.EndType.etOpenRound);
            const paths = [];
            offset.Execute(paths, lineWidth * scale / 2);
            strokes.push(...paths);
        }
    } else {
        const offset = new ClipperLib.ClipperOffset(10, 0.001 * scale);
        offset.AddPath(path, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedLine);
        offset.Execute(strokes, lineWidth * scale / 2);
    }
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

export function boardShapeFilledRemovalOutlines(shape) {
    const geometry = resolveBoardShapeGeometry(shape);
    if (shape.kind === 'image') return geometry.physicalContours;
    if (['rect', 'polygon'].includes(shape.kind)) return closedShapeContours(shape, true, geometry.lineWidth) || [];
    const halfWidth = geometry.lineWidth / 2;
    if (shape.kind === 'circle') {
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
    const outlines = [];
    offset.Execute(outlines, halfWidth * scale);
    return outlines.map((outline) => outline.map((point) => ({
        x: point.X / scale, y: point.Y / scale,
    })));
}

/** Compound path for the physical area removed by a copper-mode shape. */
export function boardShapeRemovalPathD(shape) {
    if (shape.kind === 'image') {
        const circles = pictureCirclePathD(shape);
        if (circles !== null) return circles;
    }
    const geometry = resolveBoardShapeGeometry(shape);
    if (geometry.physicalContours) return geometry.physicalContours.map(outlinePathD).join(' ');
    const halfWidth = geometry.lineWidth / 2;
    if (geometry.filled) {
        return boardShapeFilledRemovalOutlines(shape).map(outlinePathD).join(' ');
    }
    if (shape.kind === 'circle') {
        const outer = shapePathD(shape);
        const innerRadius = shape.radius - geometry.lineWidth;
        return innerRadius > 0 ? outer + ' ' + shapePathD({ ...shape, radius: innerRadius }) : outer;
    }
    if (!geometry.filled && geometry.strokeSegments.length) {
        return geometry.strokeSegments
            .map((segment) => outlinePathD(openStrokeOutline(
                [segment.start, segment.end], segment.lineWidth / 2)))
            .join(' ');
    }
    const centerline = shape.kind === 'arc' ? arcSamples(shape) : geometry.centerline;
    if (!geometry.centerlineClosed) return outlinePathD(openStrokeOutline(centerline, halfWidth));
    return '';
}

/** Bounds including the visible line width, for shared selection queries. */
export function boardShapeBounds(shape) {
    const outline = shapeOutline(shape);
    if (['rect', 'polygon'].includes(shape.kind)) {
        outline.push(...(resolveBoardShapeGeometry(shape).physicalContours || []).flat());
    }
    const halfWidth = ['line', 'arc'].includes(shape.kind) ? boardShapeMaxLineWidth(shape) / 2 : 0;
    return pointsBounds(outline, halfWidth);
}

/** Shared point hit test for board shapes and their selection adapter. */
export function boardShapeHitTest(shape, worldPos, tolerance = 0) {
    if (!shape || !worldPos) return false;
    if (shape.kind === 'image') {
        return pointInPolygon(worldPos, shape.points) || shape.points.some((point, index) =>
            distanceToSegment(worldPos, point, shape.points[(index + 1) % 4]) <= tolerance);
    }
    if (shape.kind === 'circle') {
        return circleHitTest(shape, worldPos, tolerance, shapeIsFilled(shape), boardShapeMaxLineWidth(shape));
    }
    if (['rect', 'polygon'].includes(shape.kind)) {
        const contours = resolveBoardShapeGeometry(shape).physicalContours || [];
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
 */
export function shapePathD(shape, { close = false } = {}) {
    if (shape.kind === 'arc' || shape.kind === 'circle') return primitiveShapePath(shape, close);
    if (shape.kind === 'rect' && rectCornerRadius(shape) > 0
        && !Object.keys(shape.nodeCornerRadii || {}).length) {
        return primitiveShapePath({ ...shape, cornerRadius: rectCornerRadius(shape) });
    }
    if (['line', 'polygon', 'rect'].includes(shape.kind) && roundedPolygonCorners(shape).length) {
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
        d += ` ${arcEdgeContinuation(pts.at(-1), pts[0], boardShapeSegmentBulge(shape, pts.length - 1))}`;
    }
    return shape.kind === 'line' ? d : d + ' Z';
}

/** True when a shape reads as a solid region for hit-testing. */
export function shapeIsFilled(shape) {
    if (shape?.kind === 'image') return true;
    if (shape?.kind === 'line') return false;
    const layer = String(shape.layer || 'top-silk');
    // A hole-layer shape is a board cutout — its whole interior is clickable.
    if (layer === 'hole') return true;
    const isCopperLayer = layer === 'top-copper' || layer === 'bottom-copper';
    if (isCopperLayer) {
        return !!shape.filled;
    }
    return !!shape.filled || isMaskLayer(layer);
}

/** Minimum manufacturable outline/slot width for a board shape. */
export function boardShapeLineWidthMinimum(shape) {
    return shape?.kind === 'line' && shape?.layer === 'hole' ? 0.8 : 0.05;
}

export function normalizedBoardShapeLineWidth(shape, value) {
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
    const radius = Math.max(0.05, Number(shape?.radius) || 0);
    const lineWidth = Math.min(shape?.kind === 'circle' ? radius : Infinity, Math.max(0.05, Number(shape?.lineWidth) || 0.2));
    const filled = options.filled ?? shapeIsFilled(shape);
    const centerlineShape = { ...shape, filled: false };
    const centerline = shape?.kind === 'arc'
        ? arcSamples(shape)
        : shape?.kind === 'circle'
            ? circleOutline(centerlineShape)
            : ['line', 'rect', 'polygon'].includes(shape?.kind)
                ? shapeOutline(centerlineShape)
                : (shape?.points || []).map((point) => ({ ...point }));
    const centerlineClosed = ['rect', 'polygon', 'image'].includes(shape?.kind);
    const areaOutline = filled && shape?.kind !== 'line'
        ? centerline.map((point) => ({ ...point }))
        : null;
    const strokeSegments = ['line', 'rect', 'polygon'].includes(shape?.kind)
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
        areaOutline,
        image: shape?.kind === 'image' ? shape : null,
        get physicalContours() {
            return shape?.kind === 'image' ? pictureContours(shape) : closedShapeContours(shape, filled, lineWidth);
        },
        circle: shape?.kind === 'circle'
            ? { x: shape.x, y: shape.y, radius: radius - lineWidth / 2, outerRadius: radius }
            : null,
        filled,
        lineWidth,
        strokeSegments,
        copperMode: normalizeShapeCopperMode(shape?.copperMode),
    };
}
