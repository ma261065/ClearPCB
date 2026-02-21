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