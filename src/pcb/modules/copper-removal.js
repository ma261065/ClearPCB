import ClipperLib from '../../../assets/vendor/clipper.esm.js';
import { resolveBoardShapeGeometry, boardShapeArcGeometry, normalizeShapeCopperMode } from './board-shapes.js';
import { contourRegions } from './region-geometry.js';
import { spatialCrossPairs } from '../../core/spatial-pairs.js';

const SCALE = 1e6;
const TOLERANCE = 1e-4;
const toPath = ring => ring.map(point => ({ X: Math.round(point.x * SCALE), Y: Math.round(point.y * SCALE) }));
const fromPath = ring => ring.map(point => ({ x: point.X / SCALE, y: point.Y / SCALE }));
const fromTree = tree => ClipperLib.JS.PolyTreeToExPolygons(tree).map(region => ({
    outer: fromPath(region.outer), holes: region.holes.map(fromPath),
}));

function regionPaths(regions) {
    return regions.flatMap(region => [region.outer, ...region.holes].map((ring, index) => {
        const path = toPath(ring);
        if (ClipperLib.Clipper.Orientation(path) !== (index === 0)) path.reverse();
        return path;
    }));
}

function combine(regions, clips = []) {
    if (!regions.length) return [];
    const clipper = new ClipperLib.Clipper();
    clipper.AddPaths(regionPaths(regions), ClipperLib.PolyType.ptSubject, true);
    if (clips.length) clipper.AddPaths(regionPaths(clips), ClipperLib.PolyType.ptClip, true);
    const tree = new ClipperLib.PolyTree();
    clipper.Execute(clips.length ? ClipperLib.ClipType.ctDifference : ClipperLib.ClipType.ctUnion,
        tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
    return fromTree(tree);
}

function circleRing(x, y, radius) {
    const count = Math.max(16, Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - TOLERANCE / radius))));
    return Array.from({ length: count }, (_, index) => ({
        x: x + radius * Math.cos(index * 2 * Math.PI / count),
        y: y + radius * Math.sin(index * 2 * Math.PI / count),
    }));
}

function strokeRegions(points, width, closed = false) {
    if (!points.length || !(width > 0)) return [];
    if (points.length === 1 || points.every(point => point.x === points[0].x && point.y === points[0].y)) {
        return [{ outer: circleRing(points[0].x, points[0].y, width / 2), holes: [] }];
    }
    const offset = new ClipperLib.ClipperOffset(2, TOLERANCE * SCALE);
    offset.AddPath(toPath(points), ClipperLib.JoinType.jtRound,
        closed ? ClipperLib.EndType.etClosedLine : ClipperLib.EndType.etOpenRound);
    const paths = new ClipperLib.Paths();
    offset.Execute(paths, width * SCALE / 2);
    return contourRegions(paths.map(fromPath));
}

function shapeRegions(shape) {
    const geometry = resolveBoardShapeGeometry(shape);
    const arc = boardShapeArcGeometry(shape);
    if (arc) return featureRegions({ kind: 'arc', x: arc.cx, y: arc.cy, radius: arc.radius,
        startAngle: arc.startAngle, endAngle: arc.endAngle, hw: geometry.lineWidth / 2, filled: geometry.filled });
    const contours = geometry.physicalContours;
    if (contours) return contourRegions(contours);
    if (geometry.circle) {
        const circle = geometry.circle;
        const inner = geometry.filled ? 0 : Math.max(0, circle.radius - geometry.lineWidth / 2);
        return [{ outer: circleRing(circle.x, circle.y, circle.outerRadius),
            holes: inner > 0 ? [circleRing(circle.x, circle.y, inner)] : [] }];
    }
    const regions = geometry.filled && geometry.areaOutline?.length >= 3
        ? [{ outer: geometry.areaOutline, holes: [] }] : [];
    if (geometry.strokeSegments?.length) {
        for (const segment of geometry.strokeSegments) {
            regions.push(...strokeRegions([segment.start, segment.end], segment.lineWidth));
        }
    } else regions.push(...strokeRegions(geometry.centerline, geometry.lineWidth, geometry.pathClosed));
    return combine(regions);
}

function featureRegions(feature) {
    if (feature.kind === 'area') return [{ outer: feature.outer, holes: feature.holes || [] }];
    if (feature.kind === 'pad' || feature.kind === 'via') {
        const outer = feature.kind === 'pad' ? feature.outline : circleRing(feature.x, feature.y, feature.r);
        const bore = feature.drill > 0 ? feature.slot
            ? strokeRegions([{ x: feature.slot.x1, y: feature.slot.y1 }, { x: feature.slot.x2, y: feature.slot.y2 }], feature.drill)
            : [{ outer: circleRing(feature.x, feature.y, feature.drill / 2), holes: [] }] : [];
        return combine([{ outer, holes: [] }], bore);
    }
    if (feature.kind === 'circle') return [{ outer: circleRing(feature.x, feature.y, feature.outerRadius),
        holes: feature.innerRadius > 0 ? [circleRing(feature.x, feature.y, feature.innerRadius)] : [] }];
    if (feature.kind === 'arc') {
        const sweep = feature.endAngle - feature.startAngle;
        const step = 2 * Math.acos(Math.max(-1, 1 - TOLERANCE / feature.radius));
        const count = Math.max(2, Math.ceil(Math.abs(sweep) / step));
        const points = Array.from({ length: count + 1 }, (_, index) => {
            const angle = feature.startAngle + sweep * index / count;
            return { x: feature.x + feature.radius * Math.cos(angle), y: feature.y + feature.radius * Math.sin(angle) };
        });
        return combine([
            ...(feature.filled ? [{ outer: points, holes: [] }] : []),
            ...strokeRegions(points, feature.hw * 2, feature.filled),
        ]);
    }
    return strokeRegions([{ x: feature.ax, y: feature.ay }, { x: feature.bx, y: feature.by }], feature.hw * 2);
}

export function subtractCopperArtwork(features, boardShapes, bounds) {
    const cuts = [];
    for (const shape of boardShapes || []) {
        if (!['top-copper', 'bottom-copper'].includes(shape.layer)
            || !['remove-copper', 'remove-copper-mask'].includes(normalizeShapeCopperMode(shape.copperMode))) continue;
        for (const region of shapeRegions(shape)) cuts.push({ ...region, kind: 'area',
            layer: shape.layer === 'bottom-copper' ? 'bottom' : 'top' });
    }
    if (!cuts.length) return features;
    const candidates = new Map();
    for (const [feature, cut] of spatialCrossPairs(features, cuts, bounds)) {
        if (feature.layer !== 'both' && feature.layer !== cut.layer) continue;
        if (!candidates.has(feature)) candidates.set(feature, []);
        candidates.get(feature).push(cut);
    }
    if (!candidates.size) return features;
    return features.flatMap(feature => {
        const nearby = candidates.get(feature);
        if (!nearby) return [feature];
        const regions = featureRegions(feature);
        return (feature.layer === 'both' ? ['top', 'bottom'] : [feature.layer]).flatMap(layer => {
            const clips = nearby.filter(cut => cut.layer === layer);
            if (!clips.length) return [{ ...feature, layer, source: feature }];
            return combine(regions, clips).map(region => ({ ...feature, ...region,
                kind: 'area', originalKind: feature.kind, layer, source: feature,
                x: region.outer[0].x, y: region.outer[0].y }));
        });
    });
}