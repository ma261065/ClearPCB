import { collectDrcInputs } from './drc.js';
import { normalizeShapeCopperMode } from '../../shared/pcb/board-shape-geometry.js';
import { fillRefreshError, isFillRefreshPending } from './refresh-state.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */

const featureFields = ['kind', 'pin', 'componentId', 'padId', 'number', 'drill', 'slot', 'net', 'layer',
    'width', 'height', 'hw', 'hh', 'shape', 'rotation', 'reference', 'outline', 'uid', 'label', 'keyId',
    'trackId', 'ax', 'ay', 'bx', 'by', 'x', 'y', 'r', 'diameter', 'outer', 'holes', 'radius',
    'startAngle', 'endAngle', 'filled', 'outerRadius', 'innerRadius'];
const shapeFields = ['id', 'type', 'kind', 'layer', 'copperMode', 'x', 'y', 'radius', 'start', 'end',
    'bulge', 'points', 'outline', 'lineWidth', 'cornerRadius', 'nodeCornerRadii', 'segmentWidths',
    'segmentBulges', 'filled', 'artwork'];
const pick = (object, fields) => Object.fromEntries(fields.filter(key => key in object).map(key => [key, object[key]]));

/**
 * Full-precision physical DTOs, detached once, with no model/SVG references or file serialization.
 * @param {PcbEditor} app
 */
export function captureDrcInputs(app, rules = {}) {
    const model = app.pcbDocument;
    const inputs = collectDrcInputs({
        tracks: model.tracks, pads: model.pads, vias: model.vias, texts: model.texts,
        boardShapes: model.boardShapes, copperFills: model.copperFills,
        placements: app.placements, netlist: app.netlist,
    }, rules, { pending: isFillRefreshPending(app), error: fillRefreshError(app) });
    const anonymousTracks = new Map();
    inputs.copper = /** @type {any} */ (Object.fromEntries(Object.entries(inputs.copper).map(([kind, features]) => [
        kind, features.map(feature => {
            // Pads may carry legacy placement metadata; other collectors emit explicit physical fields.
            const data = kind === 'pads' ? pick(feature, featureFields) : { ...feature };
            delete data.ref;
            if (data.trackId && typeof data.trackId === 'object') {
                if (!anonymousTracks.has(data.trackId)) anonymousTracks.set(data.trackId, {});
                data.trackId = anonymousTracks.get(data.trackId);
            }
            return data;
        }),
    ])));
    inputs.boardShapes = inputs.boardShapes.filter(shape => ['top-copper', 'bottom-copper'].includes(shape.layer)
        && ['remove-copper', 'remove-copper-mask'].includes(normalizeShapeCopperMode(shape.copperMode)))
        .map(shape => pick(shape, shapeFields));
    inputs.rules = { clearance: rules.clearance, minAnnularRing: rules.minAnnularRing,
        ratlines: (rules.ratlines || []).map(({ net, x1, y1, x2, y2 }) => ({ net, x1, y1, x2, y2 })) };
    return structuredClone(inputs);
}
