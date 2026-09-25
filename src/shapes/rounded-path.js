import { arcEdgeContinuation, sampleArcEdge } from './arc-edge.js';

export const CORNER_CHORD_TOLERANCE = 0.001;

export function roundedPathCorners(points, radii, closed = false, circular = false) {
    return points.map((vertex, index) => {
        const sharp = { vertex, entry: { ...vertex }, exit: { ...vertex }, rounded: false };
        if (points.length < 3 || (!closed && (index === 0 || index === points.length - 1))) return sharp;
        const previous = points[(index + points.length - 1) % points.length];
        const next = points[(index + 1) % points.length];
        const previousLength = Math.hypot(previous.x - vertex.x, previous.y - vertex.y);
        const nextLength = Math.hypot(next.x - vertex.x, next.y - vertex.y);
        const inset = Math.min(radii[index] || 0, previousLength / 2, nextLength / 2);
        if (inset < 0.01 || previousLength < 0.01 || nextLength < 0.01) return sharp;
        return {
            vertex, rounded: true,
            bulge: circular ? -Math.sign((vertex.x - previous.x) * (next.y - vertex.y)
                - (vertex.y - previous.y) * (next.x - vertex.x)) * Math.tan(Math.PI / 8) : 0,
            entry: { x: vertex.x + (previous.x - vertex.x) * inset / previousLength,
                y: vertex.y + (previous.y - vertex.y) * inset / previousLength },
            exit: { x: vertex.x + (next.x - vertex.x) * inset / nextLength,
                y: vertex.y + (next.y - vertex.y) * inset / nextLength },
        };
    });
}

export function roundedCornerContinuation(corner, format = value => value) {
    return corner.bulge ? arcEdgeContinuation(corner.entry, corner.exit, corner.bulge)
        : `Q ${format(corner.vertex.x)} ${format(corner.vertex.y)} ${format(corner.exit.x)} ${format(corner.exit.y)}`;
}

export function roundedPathData(corners, closed = false, bulges = [], format = value => value) {
    if (!corners.length) return '';
    const parts = [`M ${format(corners[0].entry.x)} ${format(corners[0].entry.y)}`];
    for (const [index, corner] of corners.entries()) {
        if (index > 0) parts.push(arcEdgeContinuation(corners[index - 1].exit, corner.entry, bulges[index - 1] || 0));
        if (corner.rounded) {
            parts.push(roundedCornerContinuation(corner, format));
        }
    }
    if (closed) parts.push(arcEdgeContinuation(corners.at(-1).exit, corners[0].entry, bulges[corners.length - 1] || 0), 'Z');
    return parts.join(' ');
}

export function sampleRoundedCorner(corner, segments = undefined) {
    if (!corner.rounded) return [{ ...corner.vertex }];
    if (corner.bulge) {
        const radius = Math.hypot(corner.entry.x - corner.vertex.x, corner.entry.y - corner.vertex.y);
        segments ??= Math.max(16, Math.ceil(Math.PI / (8 * Math.asin(Math.sqrt(Math.min(1, CORNER_CHORD_TOLERANCE / (2 * radius)))))));
        return [{ ...corner.entry }, ...sampleArcEdge(corner.entry, corner.exit, corner.bulge, segments * 4)];
    }
    const curvature = Math.hypot(
        (corner.entry.x - corner.vertex.x) + (corner.exit.x - corner.vertex.x),
        (corner.entry.y - corner.vertex.y) + (corner.exit.y - corner.vertex.y));
    segments ??= Math.max(16, 2 * Math.ceil(Math.sqrt(curvature / (4 * CORNER_CHORD_TOLERANCE)) / 2));
    return Array.from({ length: segments + 1 }, (_, index) => {
        const fraction = index / segments;
        const inverse = 1 - fraction;
        return {
            x: inverse * inverse * corner.entry.x + 2 * inverse * fraction * corner.vertex.x + fraction * fraction * corner.exit.x,
            y: inverse * inverse * corner.entry.y + 2 * inverse * fraction * corner.vertex.y + fraction * fraction * corner.exit.y,
        };
    });
}