/**
 * Shape classes index
 */

export { Shape, updateIdCounter, resetIdCounter } from './shape.js';
export { PolylineGraph } from './polyline-graph.js';
export { Polyline, createLine, createPolygon, createRect } from './polyline.js';
// Backward-compatible aliases
export { Polyline as Line } from './polyline.js';
export { Polyline as Polygon } from './polyline.js';
export { Wire, bumpWireLabelCounter, resetWireLabelCounter, resetNetNameCounter, COLLINEAR_EPSILON } from './wire.js';
export { Track } from './track.js';
export { Via, resetViaIdCounter, updateViaIdCounter } from './via.js';
export { Circle } from './circle.js';
export { Rect } from './rect.js';
export { Arc } from './arc.js';
export { Text } from './text.js';
export { Net } from './net.js';
export { NoConnect } from './noconnect.js';

import { Polyline } from './polyline.js';
import { Wire } from './wire.js';
import { Track } from './track.js';
import { Via } from './via.js';
import { Circle } from './circle.js';
import { Rect } from './rect.js';
import { Arc } from './arc.js';
import { Text } from './text.js';
import { Net } from './net.js';
import { NoConnect } from './noconnect.js';

/**
 * @typedef {{type?: string, points?: unknown, labelOffset?: unknown, textOffset?: unknown, [key: string]: unknown}} ShapeData
 * @typedef {import('../core/SchematicDocument.js').SchematicDrawable|import('./track.js').Track} ShapeInstance
 * @typedef {new (options?: never) => unknown} ShapeConstructor
 */

/** @type {Record<string, ShapeConstructor>} */
const shapeRegistry = {
    polyline: Polyline,
    wire: Wire,
    track: Track,
    via: Via,
    circle: Circle,
    arc: Arc,
    text: Text,
    net: Net,
    noconnect: NoConnect
};

/** Map short serialisation keys back to constructor-friendly long names. */
/** @type {Record<string, string>} */
const SHORT_KEYS = {
    c: 'color', l: 'layer', lw: 'lineWidth', v: 'visible', lk: 'locked',
    pts: 'points', n: 'net',
    nd: 'graphNodes', ed: 'graphEdges', pc: 'pinConnections', wl: 'wireLabel',
    cn: 'cornerNodeIds', rev: 'reversed',
    el: 'edgeLayers', ew: 'edgeWidths', bg: 'edgeBulges', pdc: 'padConnections',
    sbs: 'sourceBoardShape',
    r: 'radius', w: 'width', h: 'height', cr: 'cornerRadius', ncr: 'nodeCornerRadii',
    f: 'fill', fc: 'fillColor', fa: 'fillAlpha', cl: 'closed', ir: 'isRect',
    sp: 'startPoint', ep: 'endPoint', bp: 'bulgePoint',
    t: 'text', fs: 'fontSize', ff: 'fontFamily', ta: 'textAnchor',
    cid: 'componentId', fk: 'fieldKey', rot: 'rotation',
    att: 'attachment', bd: 'border',
    pn: 'pinConnection', lo: 'labelOffset',
    nst: 'style', no: 'orientation', nto: 'textOffset',
};

/**
 * Expand short serialisation keys to constructor-friendly long names
 * and unflatten flat point arrays.
 * @param {ShapeData} data - Compact JSON shape data.
 * @returns {ShapeData} Expanded data ready for shape constructor.
 */
function expandShapeData(data) {
    /** @type {ShapeData} */
    const out = {};
    for (const [k, v] of Object.entries(data)) {
        out[SHORT_KEYS[k] || k] = v;
    }
    // Unflatten flat point arrays: [x0,y0,x1,y1,...] → [{x,y},...]
    if (Array.isArray(out.points) && typeof out.points[0] === 'number') {
        /** @type {number[]} */
        const flat = out.points;
        /** @type {Array<{x: number, y: number}>} */
        const pts = [];
        for (let i = 0; i < flat.length - 1; i += 2) pts.push({ x: flat[i], y: flat[i + 1] });
        out.points = pts;
    }
    // Unflatten labelOffset: [x, y] → {x, y}
    if (Array.isArray(out.labelOffset)) {
        out.labelOffset = { x: out.labelOffset[0] || 0, y: out.labelOffset[1] || 0 };
    }
    if (Array.isArray(out.textOffset)) {
        out.textOffset = { x: out.textOffset[0] || 0, y: out.textOffset[1] || 0 };
    }
    return out;
}

/**
 * Create a PCB track from JSON data.
 * @overload
 * @param {ShapeData & {type: 'track'}} data
 * @returns {Track}
 */
/**
 * Create a schematic shape from JSON data.
 * @overload
 * @param {ShapeData} data
 * @returns {import('../core/SchematicDocument.js').SchematicDrawable}
 */
/**
 * Create a shape from JSON data.
 * @param {ShapeData} data
 * @returns {ShapeInstance}
 */
export function createShape(data) {
    const expanded = expandShapeData(data);
    const type = typeof expanded.type === 'string' ? expanded.type : undefined;
    const ShapeClass = type ? shapeRegistry[type] : undefined;
    if (!ShapeClass) {
        throw new Error(`Unknown shape type: ${expanded.type}`);
    }
    return /** @type {ShapeInstance} */ (new ShapeClass(/** @type {never} */ (expanded)));
}