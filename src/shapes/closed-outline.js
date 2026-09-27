import { CORNER_CHORD_TOLERANCE, roundedPathCorners, sampleRoundedCorner } from './rounded-path.js';
import { BULGE_EPS, sampleArcEdge } from './arc-edge.js';

export function closedShapeOutline(shape) {
    const points = shape.points || shape.outline || [];
    if (shape.kind === 'circle') {
        const radius = Math.max(0.05, Number(shape.radius) || 0);
        return Array.from({ length: 48 }, (_, index) => {
            const angle = Math.PI * 2 * index / 48;
            return { x: shape.x + radius * Math.cos(angle), y: shape.y + radius * Math.sin(angle) };
        });
    }
    if (points.length < 3) return points.map(point => ({ ...point }));
    const bulge = index => {
        const value = Number(shape.segmentBulges?.[index]);
        return Number.isFinite(value) && Math.abs(value) >= BULGE_EPS ? Math.max(-1, Math.min(1, value)) : 0;
    };
    let radius = Math.max(0, Number(shape.cornerRadius) || 0);
    if (shape.kind === 'rect') {
        const minX = Math.min(...points.map(point => point.x)), maxX = Math.max(...points.map(point => point.x));
        const minY = Math.min(...points.map(point => point.y)), maxY = Math.max(...points.map(point => point.y));
        radius = Math.min(radius, (maxX - minX) / 2, (maxY - minY) / 2);
        if (radius > 0 && !Object.keys(shape.nodeCornerRadii || {}).length) {
            const segments = Math.max(16, Math.ceil(Math.PI / (8 * Math.asin(Math.sqrt(Math.min(1, CORNER_CHORD_TOLERANCE / (2 * radius)))))));
            return [
                { x: minX + radius, y: minY + radius, angle: Math.PI },
                { x: maxX - radius, y: minY + radius, angle: -Math.PI / 2 },
                { x: maxX - radius, y: maxY - radius, angle: 0 },
                { x: minX + radius, y: maxY - radius, angle: Math.PI / 2 },
            ].flatMap(center => Array.from({ length: segments + 1 }, (_, index) => {
                const angle = center.angle + Math.PI / 2 * index / segments;
                return { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) };
            }));
        }
    }
    const radii = points.map((_, index) => bulge((index + points.length - 1) % points.length) || bulge(index)
        ? 0 : Math.max(0, Number(shape.nodeCornerRadii?.[index] ?? radius) || 0));
    if (radii.some(value => value > 0)) {
        const corners = roundedPathCorners(points, radii, true);
        return corners.flatMap((corner, index) => [
            ...sampleRoundedCorner(corner),
            ...sampleArcEdge(corner.exit, corners[(index + 1) % corners.length].entry, bulge(index), 64),
        ]);
    }
    const sampled = [{ ...points[0] }];
    for (let index = 0; index < points.length; index++) {
        sampled.push(...sampleArcEdge(points[index], points[(index + 1) % points.length], bulge(index), 64));
    }
    sampled.pop();
    return sampled;
}