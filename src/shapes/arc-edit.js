import { bulgeRatio, circumcircle } from '../core/geometry.js';

export function controlArcGeometry(shape) {
    const circle = circumcircle(shape.start, shape.bulge, shape.end);
    if (!circle) return null;
    const normalize = angle => ((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const startAngle = Math.atan2(shape.start.y - circle.cy, shape.start.x - circle.cx);
    const bulgeAngle = Math.atan2(shape.bulge.y - circle.cy, shape.bulge.x - circle.cx);
    const endAngle = Math.atan2(shape.end.y - circle.cy, shape.end.x - circle.cx);
    const span = normalize(endAngle - startAngle);
    const counterclockwise = normalize(bulgeAngle - startAngle) >= span;
    return { ...circle, startAngle, endAngle: startAngle + (counterclockwise ? -(2 * Math.PI - span) : span), counterclockwise };
}

export function sampleControlArc(shape, segments = 48) {
    const geometry = controlArcGeometry(shape);
    if (!geometry) return [{ ...shape.start }, { ...shape.end }];
    return Array.from({ length: segments + 1 }, (_, index) => {
        const angle = geometry.startAngle + (geometry.endAngle - geometry.startAngle) * index / segments;
        return { x: geometry.cx + geometry.radius * Math.cos(angle), y: geometry.cy + geometry.radius * Math.sin(angle) };
    });
}

export function arcChordFrame(start, end) {
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

export function snapArcBulgeToChord(start, end, point, snapped, threshold) {
    const frame = arcChordFrame(start, end);
    if (!frame) return snapped;
    const offset = (point.x - frame.midpoint.x) * frame.normal.x
        + (point.y - frame.midpoint.y) * frame.normal.y;
    return Math.abs(offset) <= threshold || Number(bulgeRatio(start, end, snapped).toFixed(2)) === 0
        ? frame.midpoint : snapped;
}

export function projectArcBulge(start, end, point) {
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

export function arcBulgeRatio(shape) {
    const frame = arcChordFrame(shape.start, shape.end);
    if (!frame) return 0;
    const offset = (shape.bulge.x - frame.midpoint.x) * frame.normal.x
        + (shape.bulge.y - frame.midpoint.y) * frame.normal.y;
    return Math.max(-0.5, Math.min(0.5, offset / frame.length));
}

export function arcBulgeFromRatio(start, end, ratio) {
    const frame = arcChordFrame(start, end);
    if (!frame) return { ...start };
    const offset = ratio * frame.length;
    return {
        x: frame.midpoint.x + frame.normal.x * offset,
        y: frame.midpoint.y + frame.normal.y * offset,
    };
}