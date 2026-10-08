import { serializeBoardShapes } from './pcb-board-shapes.js';
import { serializePcbText } from './pcb-text.js';

/** Capture detached, full-precision entities from canonical or explicit collections. */
/**
 * @typedef {{
 *   tracks: Array<{captureCopperGeometry(): any}>,
 *   copperFills: Array<{captureCopperGeometry(): any}>,
 *   vias: Array<{id: string, x: number, y: number, diameter: number, drill: number, net: string}>,
 *   pads?: Array<{captureState(): any}>,
 *   texts: Map<any, any>,
 *   boardShapes: any[],
 * }} PcbGeometrySource
 */
/**
 * @param {any} source Snapshot callers include legacy app facades as well as PcbDocument.
 */
export function capturePcbGeometry(source) {
    const typedSource = /** @type {PcbGeometrySource} */ (source);
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
