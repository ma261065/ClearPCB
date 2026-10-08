import { serializeBoardShapes } from './pcb-board-shapes.js';
import { serializePcbText } from './pcb-text.js';

/** Capture detached, full-precision entities from canonical or explicit collections. */
/**
 * @typedef {{
 *   tracks: Array<{captureCopperGeometry(): ReturnType<import('../shapes/track.js').Track['captureCopperGeometry']>}>,
 *   copperFills: Array<{captureCopperGeometry(): ReturnType<import('../shapes/copper-fill.js').CopperFill['captureCopperGeometry']>}>,
 *   vias: Array<{id: string, x: number, y: number, diameter: number, drill: number, net: string}>,
 *   pads?: Array<{captureState(): unknown}>,
 *   texts: Map<string, import('./pcb-text.js').PcbText>,
 *   boardShapes: import('./pcb-board-shapes.js').BoardShape[],
 * }} PcbGeometrySource
 */
/**
 * @param {PcbGeometrySource} source Snapshot callers include legacy app facades as well as PcbDocument.
 * @returns {{tracks: *[], fills: *[], vias: *[], pads: *[], texts: *[], boardShapes: *[]}}
 */
export function capturePcbGeometry(source) {
    const typedSource = source;
    const tracks = typedSource.tracks.map(track => track.captureCopperGeometry());
    const fills = typedSource.copperFills.map(fill => fill.captureCopperGeometry());
    return {
        tracks,
        vias: typedSource.vias.map(via => ({ id: via.id, x: via.x, y: via.y,
            diameter: via.diameter, drill: via.drill, net: via.net })),
        pads: (typedSource.pads || []).map(pad => structuredClone(pad.captureState())),
        texts: [...typedSource.texts.values()].map(serializePcbText),
        fills,
        boardShapes: serializeBoardShapes({ boardShapes: typedSource.boardShapes.filter(shape => shape.type !== 'fill') },
            { compactArtwork: false, roundGeometry: false, parametricRectangles: false }),
    };
}
