import { stringToPolylines, measureText } from './stroke-font.js';
import { placementPose } from './board-geometry.js';

export const REF_DEFAULT_SIZE = 0.9;
export const REF_DEFAULT_STROKE = 0.15;

export function referenceAnchor(outline) {
    return { cx: outline ? outline.x + outline.width / 2 : 0, baseY: (outline ? outline.y : -2) - 0.8 };
}

export function layoutReferenceText(ref, cx, baseY, size = REF_DEFAULT_SIZE, strokeWidth = REF_DEFAULT_STROKE) {
    const width = measureText(ref, size);
    const baseX = cx - width / 2;
    const polylines = stringToPolylines(ref, baseX, baseY, size, false).filter(poly => poly.length >= 2);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const poly of polylines) {
        for (const point of poly) {
            minX = Math.min(minX, point.x);
            minY = Math.min(minY, point.y);
            maxX = Math.max(maxX, point.x);
            maxY = Math.max(maxY, point.y);
        }
    }
    if (!Number.isFinite(minX)) {
        minX = baseX; maxX = baseX + width;
        minY = baseY - size; maxY = baseY;
    }
    return { polylines, size, strokeWidth, baseY,
        box: { bx: minX, by: minY, bw: maxX - minX, bh: maxY - minY, cx, cy: (minY + maxY) / 2 } };
}

export function resolveReferenceText(placement) {
    if (!placement?.reference || placement.refVisible === false) return null;
    const anchor = referenceAnchor(placement.outline);
    const layout = layoutReferenceText(placement.reference, anchor.cx, anchor.baseY,
        Number(placement.refSize) > 0 ? placement.refSize : REF_DEFAULT_SIZE,
        Number(placement.refStrokeWidth) > 0 ? placement.refStrokeWidth : REF_DEFAULT_STROKE);
    const pose = placementPose(placement);
    const angle = (placement.refRot || 0) * Math.PI / 180;
    const cosine = Math.cos(angle), sine = Math.sin(angle);
    const { cx, cy } = layout.box;
    const polylines = layout.polylines.map(poly => poly.map(point => {
        const dx = point.x - cx, dy = point.y - cy;
        let x = cx + dx * cosine - dy * sine;
        const y = cy + dx * sine + dy * cosine;
        if (placement.mirror) x = 2 * cx - x;
        return pose.xf(x + (placement.refDx || 0), y + (placement.refDy || 0));
    }));
    return { polylines, strokeWidth: layout.strokeWidth,
        layer: placement.side === 'bottom' ? 'bottom-silk' : 'top-silk' };
}