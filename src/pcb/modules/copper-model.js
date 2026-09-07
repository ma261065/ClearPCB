import { placementPose } from './board-geometry.js';

export function padCopperOutline(pad) {
    const halfWidth = pad.width / 2, halfHeight = pad.height / 2;
    if (!['round', 'circle', 'ellipse', 'oval'].includes(pad.shape)) {
        return [
            { x: pad.x - halfWidth, y: pad.y - halfHeight },
            { x: pad.x + halfWidth, y: pad.y - halfHeight },
            { x: pad.x + halfWidth, y: pad.y + halfHeight },
            { x: pad.x - halfWidth, y: pad.y + halfHeight },
        ];
    }
    const segments = 48;
    const enclosure = 1 / Math.cos(Math.PI / segments);
    const radius = Math.min(halfWidth, halfHeight);
    return Array.from({ length: segments }, (_, index) => {
        const angle = index * 2 * Math.PI / segments;
        const cosine = Math.cos(angle), sine = Math.sin(angle);
        return pad.shape === 'oval' ? {
            x: pad.x + Math.sign(cosine) * (halfWidth - radius) + radius * enclosure * cosine,
            y: pad.y + Math.sign(sine) * (halfHeight - radius) + radius * enclosure * sine,
        } : {
            x: pad.x + halfWidth * enclosure * cosine,
            y: pad.y + halfHeight * enclosure * sine,
        };
    });
}

export function resolveCopperPads(app) {
    const nets = new Map();
    for (const entry of app.netlist || []) {
        for (const pin of entry.pins || []) nets.set(`${pin.componentId}|${pin.pinNumber}`, entry.net || '');
    }
    const pads = [];
    for (const [componentId, placement] of app.placements || []) {
        const pose = placementPose(placement);
        const offsets = placement.padOffsets;
        if (offsets?.length) {
            for (const offset of offsets) {
                const point = pose.xf(offset.dx, offset.dy);
                const width = offset.width || 1.2;
                const height = offset.height || 1.2;
                const worldWidth = Math.abs(pose.cos) * width + Math.abs(pose.sin) * height;
                const worldHeight = Math.abs(pose.sin) * width + Math.abs(pose.cos) * height;
                const layer = offset.drill > 0 ? 'both' : offset.layer || 'top';
                pads.push({
                    ...point, componentId, padId: String(offset.padId ?? offset.number), number: String(offset.number),
                    net: nets.get(`${componentId}|${offset.number}`) || '', layer,
                    width: worldWidth, height: worldHeight, hw: worldWidth / 2, hh: worldHeight / 2,
                    shape: offset.shape || 'rect', reference: placement.reference || placement.name || componentId,
                    outline: padCopperOutline({ x: offset.dx, y: offset.dy, width, height, shape: offset.shape })
                        .map((vertex) => pose.xf(vertex.x, vertex.y)),
                });
            }
        } else {
            for (const [padId, point] of placement.pads || []) {
                const number = String(point.number ?? padId);
                pads.push({ ...point, componentId, padId: String(padId), number,
                    net: nets.get(`${componentId}|${number}`) || '', layer: point.layer || 'top',
                    width: point.width || 1.2, height: point.height || 1.2,
                    hw: (point.width || 1.2) / 2, hh: (point.height || 1.2) / 2,
                    shape: point.shape || 'rect', reference: placement.reference || componentId });
            }
        }
    }
    for (const pad of pads) pad.outline ||= padCopperOutline(pad);
    return pads;
}

export const copperLayer = (layer) => layer === 'both' || layer === 'all' ? 'all'
    : layer === 'bottom' || layer === 'bottom-copper' ? 'bottom-copper' : 'top-copper';