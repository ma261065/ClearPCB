/**
 * Shape classes index
 */

export { Shape } from './Shape.js';
export { Line } from './Line.js';
export { Circle } from './Circle.js';
export { Rect } from './Rect.js';
export { Arc } from './Arc.js';
export { Pad } from './Pad.js';
export { Via } from './Via.js';
export { Polygon } from './Polygon.js';

// Shape factory for deserializing
const shapeClasses = {
    line: () => import('./Line.js').then(m => m.Line),
    circle: () => import('./Circle.js').then(m => m.Circle),
    rect: () => import('./Rect.js').then(m => m.Rect),
    arc: () => import('./Arc.js').then(m => m.Arc),
    pad: () => import('./Pad.js').then(m => m.Pad),
    via: () => import('./Via.js').then(m => m.Via),
    polygon: () => import('./Polygon.js').then(m => m.Polygon)
};

import { Line } from './Line.js';
import { Circle } from './Circle.js';
import { Rect } from './Rect.js';
import { Arc } from './Arc.js';
import { Pad } from './Pad.js';
import { Via } from './Via.js';
import { Polygon } from './Polygon.js';

const shapeRegistry = {
    line: Line,
    circle: Circle,
    rect: Rect,
    arc: Arc,
    pad: Pad,
    via: Via,
    polygon: Polygon
};

/**
 * Create a shape from JSON data
 */
export function createShape(data) {
    const ShapeClass = shapeRegistry[data.type];
    if (!ShapeClass) {
        throw new Error(`Unknown shape type: ${data.type}`);
    }
    return new ShapeClass(data);
}