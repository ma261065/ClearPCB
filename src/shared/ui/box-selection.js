/**
 * The box-selection marquee both editors draw: a dashed rectangle from the press point
 * to the cursor, in the viewport's content layer. Each editor's marquee and its start
 * point are kept here, keyed by the editor, so callers pass the start once.
 */

/** @typedef {{x: number, y: number}} Point */
/** @typedef {{viewport: {scale: number, contentLayer: Element}|null}} MarqueeHost */

/** @type {WeakMap<object, {element: SVGRectElement, start: Point}>} */
const marquees = new WeakMap();

/**
 * Start a marquee at `start` (world coordinates), replacing any the editor already has.
 * @param {MarqueeHost} app
 * @param {Point} start
 */
export function createBoxSelectElement(app, start) {
    removeBoxSelectElement(app);
    const viewport = app.viewport;
    if (!viewport) return;
    const element = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    element.setAttribute('fill', 'rgba(51, 153, 255, 0.15)');
    element.setAttribute('stroke', '#3399ff');
    element.setAttribute('stroke-width', String(1 / viewport.scale));
    element.setAttribute('stroke-dasharray', `${4 / viewport.scale} ${4 / viewport.scale}`);
    element.style.pointerEvents = 'none';
    viewport.contentLayer.appendChild(element);
    marquees.set(app, { element, start: { x: start.x, y: start.y } });
}

/**
 * Stretch the marquee from its start point to the cursor.
 * @param {object} app
 * @param {Point} currentPos - Cursor position in world coordinates.
 */
export function updateBoxSelectElement(app, currentPos) {
    const marquee = marquees.get(app);
    if (!marquee) return;
    const { x, y, width, height } = rectangle(marquee.start, currentPos);
    marquee.element.setAttribute('x', String(x));
    marquee.element.setAttribute('y', String(y));
    marquee.element.setAttribute('width', String(width));
    marquee.element.setAttribute('height', String(height));
}

/**
 * Remove the editor's marquee, if it has one.
 * @param {object} app
 */
export function removeBoxSelectElement(app) {
    marquees.get(app)?.element.remove();
    marquees.delete(app);
}

/**
 * The world-space box from the marquee's start point to the cursor (from the cursor
 * alone when no marquee is open).
 * @param {object} app
 * @param {Point} currentPos - Cursor position in world coordinates.
 * @returns {{minX: number, minY: number, maxX: number, maxY: number}}
 */
export function getBoxSelectBounds(app, currentPos) {
    const { x, y, width, height } = rectangle(marquees.get(app)?.start || currentPos, currentPos);
    return { minX: x, minY: y, maxX: x + width, maxY: y + height };
}

/** @param {Point} a @param {Point} b */
function rectangle(a, b) {
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
}
