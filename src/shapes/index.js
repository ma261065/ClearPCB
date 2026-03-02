/**
 * Shape classes index
 */

export { Shape, updateIdCounter, resetIdCounter } from './shape.js';
export { Line } from './line.js';
export { Wire } from './wire.js';
export { Circle } from './circle.js';
export { Rect } from './rect.js';
export { Arc } from './arc.js';
export { Polygon } from './polygon.js';
export { Text } from './text.js';

import { Line } from './line.js';
import { Wire } from './wire.js';
import { Circle } from './circle.js';
import { Rect } from './rect.js';
import { Arc } from './arc.js';
import { Polygon } from './polygon.js';
import { Text } from './text.js';

const shapeRegistry = {
    line: Line,
    wire: Wire,
    circle: Circle,
    rect: Rect,
    arc: Arc,
    polygon: Polygon,
    text: Text
};

/** Map short serialisation keys back to constructor-friendly long names. */
const SHORT_KEYS = {
    c: 'color', l: 'layer', lw: 'lineWidth', v: 'visible', lk: 'locked',
    pts: 'points', cn: 'connections', n: 'net', jn: 'junctions',
    nd: 'graphNodes', ed: 'graphEdges', pc: 'pinConnections',
    r: 'radius', w: 'width', h: 'height', cr: 'cornerRadius',
    f: 'fill', fc: 'fillColor', fa: 'fillAlpha', cl: 'closed',
    sp: 'startPoint', ep: 'endPoint', bp: 'bulgePoint',
    t: 'text', fs: 'fontSize', ff: 'fontFamily', ta: 'textAnchor',
    cid: 'componentId', fk: 'fieldKey',
};

function expandShapeData(data) {
    const out = {};
    for (const [k, v] of Object.entries(data)) {
        out[SHORT_KEYS[k] || k] = v;
    }
    // Unflatten flat point arrays: [x0,y0,x1,y1,...] → [{x,y},...]
    if (Array.isArray(out.points) && typeof out.points[0] === 'number') {
        const flat = out.points;
        const pts = [];
        for (let i = 0; i < flat.length - 1; i += 2) pts.push({ x: flat[i], y: flat[i + 1] });
        out.points = pts;
    }
    return out;
}

/**
 * Create a shape from JSON data
 */
export function createShape(data) {
    const expanded = expandShapeData(data);
    const ShapeClass = shapeRegistry[expanded.type];
    if (!ShapeClass) {
        throw new Error(`Unknown shape type: ${expanded.type}`);
    }
    return new ShapeClass(expanded);
}