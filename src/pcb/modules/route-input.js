import { buildCopperObstacles } from './copper-obstacles.js';
import { boardShapeBounds, normalizeShapeCopperMode } from '../../shared/pcb/board-shape-geometry.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */
/** @typedef {import('../../core/pcb-placement-geometry.js').PadOffset} PadOffset */
/** @typedef {{x: number, y: number, width: number, height: number, layer?: 'top'|'bottom'|'both', shape?: 'rect'|'ellipse', alternates?: RoutePad[]}} RoutePad */

/**
 * Convert the board's placements, netlist and copper shapes into the autorouter's
 * input: connections (with multi-pad alternates and filled copper shapes as
 * terminals), every pad as an obstacle, fixed copper obstacles, design rules and
 * routing bounds. Reads only the editor's public board state.
 * @param {PcbEditor} app
 * @returns {import('./autorouter-common.js').RouteInput}
 */
export function buildRouteInput(app) {
    // Build connections with pad positions and sizes.
    // Pad layers are already in the router's 'top'|'bottom'|'both' form
    // (set by footprint.js); no translation needed.
    /** @type {Array<{net: string, pads: RoutePad[]}>} */
    const connections = [];
    /** @type {Map<string, RoutePad[]>} */
    const shapeTerminalsByNet = new Map();
    for (const shape of app.boardShapes || []) {
        if (shape?.type === 'fill') continue;
        const net = String(shape?.net || '');
        if (!net || !shape.filled || (shape.layer !== 'top-copper' && shape.layer !== 'bottom-copper')) continue;
        if (normalizeShapeCopperMode(shape.copperMode) !== 'add') continue;
        const bounds = boardShapeBounds(shape);
        const terminals = shapeTerminalsByNet.get(net) || [];
        terminals.push({
            x: (bounds.minX + bounds.maxX) / 2,
            y: (bounds.minY + bounds.maxY) / 2,
            width: bounds.maxX - bounds.minX,
            height: bounds.maxY - bounds.minY,
            layer: shape.layer === 'top-copper' ? 'top' : 'bottom',
            shape: shape.kind === 'circle' ? 'ellipse' : 'rect',
        });
        shapeTerminalsByNet.set(net, terminals);
    }
    for (const entry of app.netlist) {
        const pads = [];
        for (const pin of entry.pins) {
            const pl = app.placements.get(pin.componentId);
            if (!pl) continue;
            // Multi-pad pins (e.g. thermal/centre pads of TQFN/SOIC-with-EP
            // share a pin number across many physical pads). Collect ALL
            // matching offsets — first becomes the primary endpoint, the
            // rest go into `alternates` so the router can land on any of
            // them. Without this we'd only see the arbitrary last-inserted
            // pad from the placement Map, often a hemmed-in centre pad
            // that's hard or impossible to reach.
            const matches = /** @type {PadOffset[]} */ (pl.padOffsets || []).filter(o => o.number === pin.pinNumber);
            if (matches.length === 0) continue;
            /** @param {PadOffset} off @returns {RoutePad} */
            const padFor = (off) => ({
                x: pl.x + off.dx,
                y: pl.y + off.dy,
                width: off.width || 1.0,
                height: off.height || 1.0,
                layer: /** @type {'top'|'bottom'|'both'} */ (off.layer || 'top'),
                shape: /** @type {'rect'|'ellipse'} */ (off.shape || 'rect'),
            });
            /** @type {RoutePad} */
            const primary = padFor(matches[0]);
            if (matches.length > 1) {
                primary.alternates = matches.slice(1).map(padFor);
            }
            pads.push(primary);
        }
        pads.push(...(shapeTerminalsByNet.get(entry.net) || []));
        if (pads.length >= 2) {
            connections.push({ net: entry.net, pads });
        }
    }

    // Collect ALL pads from every component as obstacles
    // (not just the ones in the netlist — unconnected pads must block too)
    /** @type {RoutePad[]} */
    const allObstaclePads = [];
    for (const [, pl] of app.placements) {
        for (const off of (pl.padOffsets || [])) {
            allObstaclePads.push({
                x: pl.x + off.dx,
                y: pl.y + off.dy,
                width: off.width || 1.0,
                height: off.height || 1.0,
                layer: /** @type {'top'|'bottom'|'both'} */ (off.layer || 'top'),
                shape: /** @type {'rect'|'ellipse'} */ (off.shape || 'rect'),
            });
        }
    }

    // Fixed copper features the router must avoid but never rip up. Copper
    // text decomposes into per-stroke segment obstacles; silk text is not
    // copper and is ignored. Future copper shapes (rects, arcs, pours,
    // imported artwork) append their own segment/pad obstacles here.
    const copperObstacles = buildCopperObstacles(app);

    // Compute bounds
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [, pl] of app.placements) {
        for (const [, pad] of pl.pads) {
            minX = Math.min(minX, pad.x - 5);
            minY = Math.min(minY, pad.y - 5);
            maxX = Math.max(maxX, pad.x + 5);
            maxY = Math.max(maxY, pad.y + 5);
        }
    }

    const params = app.getRoutingParams();
    return {
        connections,
        allObstaclePads,
        copperObstacles,
        trackWidth: params.trackWidth,
        clearance: params.clearance,
        viaDiameter: params.viaDiameter,
        gridStep: 0.5,
        bounds: { minX, maxX, minY, maxY },
    };
}
