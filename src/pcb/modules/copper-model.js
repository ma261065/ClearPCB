import { placementPose, padFlashOutline } from '../../shared/pcb/board-geometry.js';
/** @typedef {import('./pcb-editor-api.js').PcbBoard} PcbBoard */
/** @typedef {{x: number, y: number, width?: number, height?: number, w?: number, h?: number, size?: number, ratio?: number, shape?: string, rotation?: number, drill?: number, layers?: string, layer?: string, id?: string}} CopperPadLike */
/** @typedef {{dx: number, dy: number, width?: number, height?: number, shape?: string, drill?: number, layer?: string, slotLength?: number, slotAngle?: number, padId?: string|number, number?: string|number}} PlacementPadOffset */

/** @param {CopperPadLike} pad */
export function padCopperOutline(pad) {
    return padFlashOutline({ x: pad.x, y: pad.y, w: pad.width, h: pad.height, shape: pad.shape }, 0.001, true);
}

/** @param {PcbBoard} app */
export function resolveCopperPads(app, { physical = false } = {}) {
    const outline = physical ? /** @param {CopperPadLike} pad */ (pad) => padFlashOutline({ x: pad.x, y: pad.y,
        w: pad.width, h: pad.height, shape: pad.shape }, 1e-4) : padCopperOutline;
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
                const padOffset = /** @type {PlacementPadOffset} */ (offset);
                const point = pose.xf(padOffset.dx, padOffset.dy);
                const width = padOffset.width || 1.2;
                const height = padOffset.height || 1.2;
                const worldWidth = Math.abs(pose.cos) * width + Math.abs(pose.sin) * height;
                const worldHeight = Math.abs(pose.sin) * width + Math.abs(pose.cos) * height;
                const drill = padOffset.drill || 0;
                const layer = drill > 0 ? 'both' : padOffset.layer || 'top';
                const halfSlot = Math.max(0, ((padOffset.slotLength || 0) - drill) / 2);
                const angle = padOffset.slotAngle || 0;
                const slotStart = pose.xf(padOffset.dx - halfSlot * Math.cos(angle), padOffset.dy - halfSlot * Math.sin(angle));
                const slotEnd = pose.xf(padOffset.dx + halfSlot * Math.cos(angle), padOffset.dy + halfSlot * Math.sin(angle));
                pads.push({
                    ...point, componentId, padId: String(padOffset.padId ?? padOffset.number), number: String(padOffset.number),
                    drill,
                    slot: halfSlot > 0 ? { x1: slotStart.x, y1: slotStart.y, x2: slotEnd.x, y2: slotEnd.y } : null,
                    net: nets.get(`${componentId}|${padOffset.number}`) || '', layer,
                    width: worldWidth, height: worldHeight, hw: worldWidth / 2, hh: worldHeight / 2,
                    shape: padOffset.shape || 'rect', reference: placement.reference || placement.name || componentId,
                    outline: outline({ x: padOffset.dx, y: padOffset.dy, width, height, shape: padOffset.shape })
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
    for (const pad of app.pads || []) {
        const width = Number.isFinite(pad.width) ? pad.width
            : pad.size * (['stadium', 'rectangle', 'oval'].includes(pad.shape) ? pad.ratio || 2 : 1);
        const height = Number.isFinite(pad.height) ? pad.height : pad.size;
        const shape = pad.shape === 'round' ? 'circle'
            : pad.shape === 'oval' ? 'ellipse'
                : pad.shape === 'stadium' ? 'oval' : 'rect';
        const angle = -(pad.rotation || 0) * Math.PI / 180;
        const contour = padFlashOutline({
            x: pad.x, y: pad.y, w: width, h: height, shape, rad: angle,
        }, physical ? 1e-4 : undefined);
        pads.push({
            x: pad.x, y: pad.y, componentId: null, padId: pad.id, number: pad.id,
            drill: pad.drill, net: pad.net || '', layer: pad.layers,
            width, height, hw: width / 2, hh: height / 2,
            shape, rotation: pad.rotation || 0, reference: pad.id, outline: contour,
        });
    }
    for (const pad of pads) pad.outline ||= outline(pad);
    return pads;
}

/** @param {string} layer */
export const copperLayer = (layer) => layer === 'both' || layer === 'all' ? 'all'
    : layer === 'bottom' || layer === 'bottom-copper' ? 'bottom-copper' : 'top-copper';