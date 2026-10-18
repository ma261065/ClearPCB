import { spatialPairs } from '../../core/spatial-pairs.js';
import { sampleArcEdge } from '../../shapes/arc-edge.js';
/** @typedef {import('./schematic-editor-api.js').SchematicEditor} SchematicEditor */
/** @typedef {import('../../shapes/wire.js').Wire} Wire */
/** @typedef {{x:number,y:number}} Point */
/** @typedef {{wire:Wire, order:number, edgeId:string, a:Point, b:Point, edgeA:Point, edgeB:Point, width:number}} WireSegment */

const NS = 'http://www.w3.org/2000/svg';
const EPS = 1e-6;
const states = new WeakMap();

/** @param {WireSegment} segment */
const bounds = segment => ({
    minX: Math.min(segment.a.x, segment.b.x), minY: Math.min(segment.a.y, segment.b.y),
    maxX: Math.max(segment.a.x, segment.b.x), maxY: Math.max(segment.a.y, segment.b.y),
});

/** @param {Point} first @param {Point} second */
const samePoint = (first, second) => Math.hypot(first.x - second.x, first.y - second.y) <= EPS;

/** @param {WireSegment} first @param {WireSegment} second */
function crossing(first, second) {
    const adx = first.b.x - first.a.x, ady = first.b.y - first.a.y;
    const bdx = second.b.x - second.a.x, bdy = second.b.y - second.a.y;
    const denominator = adx * bdy - ady * bdx;
    if (Math.abs(denominator) <= 1e-12) return null;
    const dx = second.a.x - first.a.x, dy = second.a.y - first.a.y;
    const t = (dx * bdy - dy * bdx) / denominator;
    const u = (dx * ady - dy * adx) / denominator;
    if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null;
    const point = { x: first.a.x + t * adx, y: first.a.y + t * ady };
    // A crossing at an authored node is a junction/T-junction candidate, not a crossover.
    if ([first.edgeA, first.edgeB, second.edgeA, second.edgeB].some(endpoint => samePoint(point, endpoint))) return null;
    return point;
}

/** @param {SVGGElement} group @param {Point} start @param {Point} end @param {string} stroke @param {number} width @param {string} className */
function appendLine(group, start, end, stroke, width, className) {
    const line = document.createElementNS(NS, 'line');
    line.setAttribute('x1', String(start.x)); line.setAttribute('y1', String(start.y));
    line.setAttribute('x2', String(end.x)); line.setAttribute('y2', String(end.y));
    line.setAttribute('stroke', stroke);
    line.setAttribute('stroke-width', String(width));
    line.setAttribute('stroke-linecap', 'butt');
    line.setAttribute('pointer-events', 'none');
    line.setAttribute('class', className);
    group.appendChild(line);
    return line;
}

/** @param {SchematicEditor} app */
function crossingGroup(app) {
    let group = states.get(app);
    if (!group) {
        group = createCueGroup();
        states.set(app, group);
    }
    if (group.parentNode !== app.viewport.contentLayer) app.viewport.contentLayer.appendChild(group);
    else app.viewport.contentLayer.appendChild(group);
    group.replaceChildren();
    return group;
}

function createCueGroup() {
    const group = document.createElementNS(NS, 'g');
    group.setAttribute('class', 'wire-crossing-cues');
    group.setAttribute('pointer-events', 'none');
    return group;
}

/** Gap (mm) printed beside the upper wire at an unjoined crossing: a wire's width, so it shows on paper. */
export const EXPORT_CROSSING_GAP = 0.25;

/**
 * Draw a local one-pixel canvas border beside the visually upper wire at each
 * electrically unjoined interior crossing.
 * @param {SchematicEditor} app
 */
export function renderWireCrossings(app) {
    const scale = Math.max(0.01, app.viewport.scale || 1);
    appendCrossingCues(app, crossingGroup(app), 1 / scale, 'var(--sch-background, #1e1e1e)');
}

/**
 * Crossing cues for print and PDF: the same borders in paper white, a fixed
 * physical gap wide rather than one screen pixel, so they survive monochrome
 * export and read as a break on paper.
 * @param {SchematicEditor} app
 * @param {string} [paper]
 * @returns {SVGGElement}
 */
export function exportWireCrossingCues(app, paper = '#ffffff') {
    const group = createCueGroup();
    appendCrossingCues(app, group, EXPORT_CROSSING_GAP, paper);
    return group;
}

/**
 * @param {SchematicEditor} app
 * @param {SVGGElement} group
 * @param {number} border - border width in world units
 * @param {string} stroke
 */
function appendCrossingCues(app, group, border, stroke) {
    /** @type {WireSegment[]} */
    const segments = [];
    for (const [order, shape] of app.shapes.entries()) {
        if (shape.type !== 'wire' || shape.visible === false) continue;
        const wire = /** @type {Wire} */ (shape);
        for (const [edgeId, edge] of wire.edges) {
            const edgeA = wire.nodes.get(edge.from), edgeB = wire.nodes.get(edge.to);
            if (!edgeA || !edgeB) continue;
            const bulge = Number(wire.getEdgeAttr(edgeId, 'bulge')) || 0;
            const points = bulge ? [edgeA, ...sampleArcEdge(edgeA, edgeB, bulge, 32)] : [edgeA, edgeB];
            const width = Math.max(Number(wire.getEdgeAttr(edgeId, 'width')) || wire.lineWidth, border);
            for (let index = 0; index < points.length - 1; index++) {
                segments.push({ wire, order, edgeId, a: points[index], b: points[index + 1], edgeA, edgeB, width });
            }
        }
    }
    const seen = new Set();
    for (const [first, second] of spatialPairs(segments, bounds, 0)) {
        if (first.wire === second.wire) continue;
        const point = crossing(first, second);
        if (!point) continue;
        const firstSelected = !!app.selection?.isSelected?.(first.wire);
        const secondSelected = !!app.selection?.isSelected?.(second.wire);
        const top = firstSelected !== secondSelected
            ? firstSelected ? first : second
            : first.order > second.order ? first : second;
        const bottom = top === first ? second : first;
        const key = [first.wire.id, second.wire.id].sort().join('|')
            + `|${Math.round(point.x * 10000)},${Math.round(point.y * 10000)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const dx = top.b.x - top.a.x, dy = top.b.y - top.a.y;
        const length = Math.hypot(dx, dy);
        const bdx = bottom.b.x - bottom.a.x, bdy = bottom.b.y - bottom.a.y;
        const bottomLength = Math.hypot(bdx, bdy);
        if (length <= EPS || bottomLength <= EPS) continue;
        const unit = { x: dx / length, y: dy / length };
        const normal = { x: -unit.y, y: unit.x };
        const bottomNormal = { x: -bdy / bottomLength, y: bdx / bottomLength };
        const signedSine = unit.x * bottomNormal.x + unit.y * bottomNormal.y;
        if (Math.abs(signedSine) <= EPS) continue;
        const sideOffset = top.width / 2 + border / 2;
        const crossingRadius = bottom.width / 2 + border;
        for (const side of [-1, 1]) {
            const offset = { x: normal.x * sideOffset * side, y: normal.y * sideOffset * side };
            const offsetFromBottom = offset.x * bottomNormal.x + offset.y * bottomNormal.y;
            const firstDistance = (-crossingRadius - offsetFromBottom) / signedSine;
            const secondDistance = (crossingRadius - offsetFromBottom) / signedSine;
            const range = {
                start: Math.min(firstDistance, secondDistance),
                end: Math.max(firstDistance, secondDistance),
            };
            const line = appendLine(group,
                { x: point.x + unit.x * range.start + offset.x, y: point.y + unit.y * range.start + offset.y },
                { x: point.x + unit.x * range.end + offset.x, y: point.y + unit.y * range.end + offset.y },
                stroke, border, 'wire-crossing-border');
            line.setAttribute('data-wire-id', top.wire.id);
        }
    }
}
