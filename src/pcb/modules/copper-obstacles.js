import { pcbTextObstacles } from './pcb-text.js';
import { boardShapeBounds, resolveBoardShapeGeometry } from '../../shared/pcb/board-shape-geometry.js';
import { resolveTrackSegments } from '../../shapes/track-geometry.js';
import { lockedRoutedCopper } from './object-locks.js';

const ROUTER_LAYERS = { 'top-copper': 'top', 'bottom-copper': 'bottom' };

/**
 * The router's fixed copper obstacles from the live board: copper text strokes,
 * copper shapes as pads (filled) or stroke segments (outlines), and locked tracks
 * and vias, which routing keeps.
 * @param {any} app
 * @returns {import('./autorouter-common.js').CopperObstacle[]}
 */
export function buildCopperObstacles(app) {
    /** @type {import('./autorouter-common.js').CopperObstacle[]} */
    const obstacles = [];
    const locked = lockedRoutedCopper(app);
    for (const track of locked.tracks) {
        for (const segment of resolveTrackSegments(track)) {
            const layer = ROUTER_LAYERS[segment.layer];
            if (!layer) continue;
            obstacles.push({ kind: 'segment', x1: segment.start.x, y1: segment.start.y,
                x2: segment.end.x, y2: segment.end.y, width: segment.width, layer, net: String(track.net || '') });
        }
    }
    for (const via of locked.vias) {
        const diameter = Number(via.diameter) || 0.6;
        obstacles.push({ kind: 'pad', x: via.x, y: via.y, width: diameter, height: diameter,
            layer: 'both', shape: 'ellipse', net: String(via.net || '') });
    }
    for (const text of app.texts.values()) {
        if (text.layer === 'top-copper' || text.layer === 'bottom-copper') obstacles.push(...pcbTextObstacles(text));
    }
    for (const shape of app.boardShapes || []) {
        if (shape?.type === 'fill' || !['top-copper', 'bottom-copper'].includes(shape?.layer)) continue;
        const geometry = resolveBoardShapeGeometry(shape);
        if (geometry.copperMode !== 'add') continue;
        const layer = shape.layer === 'top-copper' ? 'top' : 'bottom';
        const net = String(shape.net || '');
        if (geometry.filled) {
            const bounds = boardShapeBounds(shape);
            obstacles.push({ kind: 'pad', x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2,
                width: bounds.maxX - bounds.minX, height: bounds.maxY - bounds.minY, layer, net,
                shape: shape.kind === 'circle' ? 'ellipse' : 'rect' });
            continue;
        }
        const points = geometry.centerline;
        const closed = geometry.centerlineClosed || !!geometry.circle;
        const segments = geometry.strokeSegments.length ? geometry.strokeSegments
            : points.slice(0, closed ? points.length : -1).map((start, index) => ({
                start, end: points[(index + 1) % points.length], lineWidth: geometry.lineWidth,
            }));
        for (const segment of segments) {
            obstacles.push({ kind: 'segment', x1: segment.start.x, y1: segment.start.y,
                x2: segment.end.x, y2: segment.end.y, width: segment.lineWidth, layer, net });
        }
    }
    return obstacles;
}