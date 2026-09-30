import { serializeBoardShapes } from './pcb-board-shapes.js';
import { serializePcbText } from './pcb-text.js';

/** Capture detached, full-precision entities from canonical or explicit collections. */
export function capturePcbGeometry(source) {
    const tracks = source.tracks.map(track => track.captureCopperGeometry());
    const fills = source.copperFills.map(fill => fill.captureCopperGeometry());
    return {
        tracks,
        vias: source.vias.map(via => ({ id: via.id, x: via.x, y: via.y,
            diameter: via.diameter, drill: via.drill, net: via.net })),
        pads: (source.pads || []).map(pad => structuredClone(pad.captureState())),
        texts: [...source.texts.values()].map(serializePcbText),
        fills,
        boardShapes: serializeBoardShapes({ boardShapes: source.boardShapes.filter(shape => shape.type !== 'fill') },
            { compactArtwork: false, roundGeometry: false, parametricRectangles: false }),
    };
}
