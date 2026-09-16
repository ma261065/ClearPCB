import { resolveBoardShapeGeometry, boardShapeArcGeometry, normalizeShapeCopperMode } from './board-shapes.js';
import { pcbTextSegments } from './pcb-text.js';
import { pictureRegions } from './picture-raster.js';

export function collectCopperArtwork(app, { pictureBounds = false } = {}) {
    const segments = [], areas = [], circles = [], arcs = [];
    const isCopper = (layer) => layer === 'top-copper' || layer === 'bottom-copper';
    const layerName = (layer) => layer === 'bottom-copper' ? 'bottom' : 'top';
    const stroke = (start, end, width, meta, index) => segments.push({
        ...meta, kind: 'track', uid: `${meta.keyId}:${index}`, trackId: meta.keyId,
        ax: start.x, ay: start.y, bx: end.x, by: end.y, hw: width / 2,
    });
    for (const text of app.texts?.values?.() || []) {
        if (!isCopper(text.layer)) continue;
        const meta = { keyId: `text:${text.id}`, net: '', layer: layerName(text.layer), label: 'Copper text' };
        let index = 0;
        for (const [start, end] of pcbTextSegments(text)) stroke(start, end, text.strokeWidth || 0.15, meta, index++);
    }
    for (const shape of app.boardShapes || []) {
        if (!isCopper(shape.layer) || shape.type === 'fill') continue;
        if (normalizeShapeCopperMode(shape.copperMode) !== 'add') continue;
        const meta = { keyId: `shape:${shape.id}`, net: shape.net || '', layer: layerName(shape.layer), label: 'Copper shape' };
        if (shape.kind === 'image') {
            if (pictureBounds) {
                areas.push({ ...meta, label: 'Copper image', kind: 'area', uid: meta.keyId,
                    outer: shape.points.map(point => ({ ...point })), holes: [], x: shape.points[0].x, y: shape.points[0].y });
                continue;
            }
            pictureRegions(shape).forEach(({ outer, holes }, index) => areas.push({ ...meta, kind: 'area',
                uid: `${meta.keyId}:${index}`, outer, holes, x: outer[0].x, y: outer[0].y }));
            continue;
        }
        const geometry = resolveBoardShapeGeometry(shape);
        const points = geometry.centerline;
        const arc = boardShapeArcGeometry(shape);
        if (arc) {
            arcs.push({ ...meta, kind: 'arc', uid: meta.keyId, x: arc.cx, y: arc.cy,
                radius: arc.radius, startAngle: arc.startAngle, endAngle: arc.endAngle,
                hw: geometry.lineWidth / 2, filled: geometry.filled });
            continue;
        }
        if (geometry.circle) {
            circles.push({ ...meta, kind: 'circle', uid: meta.keyId,
                x: geometry.circle.x, y: geometry.circle.y,
                outerRadius: geometry.circle.radius + geometry.lineWidth / 2,
                innerRadius: geometry.filled ? 0 : Math.max(0, geometry.circle.radius - geometry.lineWidth / 2) });
            continue;
        }
        if (geometry.filled && geometry.areaOutline?.length >= 3) {
            areas.push({ ...meta, kind: 'area', uid: meta.keyId, outer: geometry.areaOutline, holes: [],
                x: points[0].x, y: points[0].y });
        }
        if (geometry.strokeSegments?.length) {
            geometry.strokeSegments.forEach((segment, index) => stroke(segment.start, segment.end, segment.lineWidth, meta, index));
        } else {
            const closed = geometry.pathClosed || !!geometry.circle;
            for (let index = 0; index < points.length - (closed ? 0 : 1); index++) {
                stroke(points[index], points[(index + 1) % points.length], geometry.lineWidth, meta, index);
            }
        }
    }
    const fills = app.copperFills || (app.boardShapes || []).filter((shape) => shape.type === 'fill');
    for (const fill of fills) {
        if (!isCopper(fill.layer)) continue;
        for (const [index, polygon] of (fill._computed || []).entries()) {
            if (!polygon.outer?.length) continue;
            areas.push({ kind: 'area', uid: `fill:${fill.id}:${index}`, keyId: `fill:${fill.id}`,
                label: 'Copper pour', net: fill.net || '', layer: layerName(fill.layer),
                outer: polygon.outer, holes: polygon.holes || [], x: polygon.outer[0].x, y: polygon.outer[0].y });
        }
    }
    return { segments, areas, circles, arcs };
}