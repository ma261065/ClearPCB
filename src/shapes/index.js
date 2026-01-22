/**
 * Shape classes index
 */

export { Shape } from './shape.js';
export { Line } from './line.js';
export { Circle } from './circle.js';
export { Rect } from './rect.js';
export { Arc } from './arc.js';
export { Pad } from './pad.js';
export { Via } from './via.js';
export { Polygon } from './polygon.js';

// Shape factory for deserializing
const shapeClasses = {
    line: () => import('./line.js').then(m => m.Line),
    circle: () => import('./circle.js').then(m => m.Circle),
    rect: () => import('./rect.js').then(m => m.Rect),
    arc: () => import('./arc.js').then(m => m.Arc),
    pad: () => import('./pad.js').then(m => m.Pad),
    via: () => import('./via.js').then(m => m.Via),
    polygon: () => import('./polygon.js').then(m => m.Polygon)
};

import { Line } from './line.js';
import { Circle } from './circle.js';
import { Rect } from './rect.js';
import { Arc } from './arc.js';
import { Pad } from './pad.js';
import { Via } from './via.js';
import { Polygon } from './polygon.js';

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