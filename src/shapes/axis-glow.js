import { BULGE_EPS } from './arc-edge.js';
import { pointsBounds } from './path-geometry.js';

const NS = 'http://www.w3.org/2000/svg';
const COLLINEAR_GLOW_COLOR = '#0072B2';

/**
 * @typedef {{x: number, y: number}} Point
 * @typedef {string} AxisKind
 * @typedef {{
 *   a: Point,
 *   b: Point,
 *   width?: number,
 *   axisKind?: AxisKind|null,
 *   collinear?: boolean,
 *   square?: boolean,
 *   frozen?: boolean,
 *   layerId?: string,
 *   haloMarginPx?: number|null,
 * }} AxisSegment
 * @typedef {{
 *   viewport?: ({scale?: number, contentLayer?: Element}|null),
 *   getLayerGroup?: Function,
 * }} AxisGlowApp
 * @typedef {{
 *   halos: Element[]|null,
 *   top: Element[]|null,
 *   resolved: Array<{segment: AxisSegment, dashKind: string}>|null,
 * }} AxisGlowState
 */

/** @type {WeakMap<object, AxisGlowState>} */
const axisGlowState = new WeakMap();

/** @param {AxisGlowApp} app */
export function getAxisGlowState(app) {
    let state = axisGlowState.get(app);
    if (!state) {
        state = { halos: null, top: null, resolved: null };
        axisGlowState.set(app, state);
    }
    return state;
}

/**
 * @param {Point} a
 * @param {Point} b
 * @returns {AxisKind|null}
 */
export function axisAlignment(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return null;
    const adx = Math.abs(dx);
    const ady = Math.abs(dy);
    const tolerance = 1e-4;
    if (ady / len < tolerance) return 'h';
    if (adx / len < tolerance) return 'v';
    if (Math.abs(adx - ady) / len < tolerance) return 'd';
    return null;
}

/**
 * @param {Point[]} points
 * @param {boolean} closed
 * @param {number[]} indices
 * @param {number[]|Record<number, number>} [widths]
 * @param {number[]|Record<number, number>} [bulges]
 * @param {number[]} [excluded]
 * @returns {any[]} Legacy guide arrays are consumed by unannotated drawing preview code.
 */
export function pathAlignmentSegments(points, closed, indices, widths = [], bulges = [], excluded = []) {
    const count = closed ? points.length : points.length - 1;
    const selected = new Set();
    const collinear = new Set();
    for (const index of indices) {
        if (!Number.isInteger(index) || !points[index]) continue;
        const previous = (index + points.length - 1) % points.length;
        const incoming = closed || index > 0 ? previous : -1;
        const outgoing = index < count ? index : -1;
        if (incoming >= 0) selected.add(incoming);
        if (outgoing >= 0) selected.add(outgoing);
    }
    const junctions = new Set([...selected].flatMap(index => [index, (index + 1) % points.length]));
    for (const index of junctions) {
        const previous = (index + points.length - 1) % points.length;
        const incoming = closed || index > 0 ? previous : -1;
        const outgoing = index < count ? index : -1;
        if (incoming < 0 || outgoing < 0 || Math.abs(bulges[incoming] || 0) >= BULGE_EPS
            || Math.abs(bulges[outgoing] || 0) >= BULGE_EPS) continue;
        const point = points[index], before = points[previous], after = points[(index + 1) % points.length];
        const first = { x: before.x - point.x, y: before.y - point.y };
        const second = { x: after.x - point.x, y: after.y - point.y };
        const lengths = Math.hypot(first.x, first.y) * Math.hypot(second.x, second.y);
        if (lengths > 1e-12 && first.x * second.x + first.y * second.y < 0
            && Math.abs(first.x * second.y - first.y * second.x) / lengths < 1e-4) {
            collinear.add(incoming);
            collinear.add(outgoing);
            selected.add(incoming);
            selected.add(outgoing);
        }
    }
    return [...selected].flatMap(index => {
        if (excluded.includes(index) || Math.abs(bulges[index] || 0) >= BULGE_EPS) return [];
        const a = points[index], b = points[(index + 1) % points.length];
        const axisKind = axisAlignment(a, b);
        return axisKind || collinear.has(index)
            ? [{ a, b, width: widths[index] ?? 0.2, axisKind, collinear: collinear.has(index) }] : [];
    });
}

/**
 * @param {AxisGlowApp} app
 * @param {AxisSegment} segment
 */
function layerFor(app, segment) {
    return app.getLayerGroup ? /** @type {Element|null} */ (app.getLayerGroup(segment.layerId)) : app.viewport?.contentLayer;
}

/**
 * @param {Point[]} points
 * @param {number[]} [widths]
 * @returns {any[]} Legacy guide arrays are consumed by unannotated drawing preview code.
 */
export function squareAlignmentSegments(points, widths = []) {
    if (points.length !== 4) return [];
    const bounds = pointsBounds(points);
    const width = bounds.maxX - bounds.minX;
    const height = bounds.maxY - bounds.minY;
    if (width <= 0.01 || height <= 0.01 || Math.abs(width - height) > 1e-9) return [];
    return points.map((point, index) => ({ a: point, b: points[(index + 1) % points.length],
        width: widths[index] ?? 0.25, square: true }));
}

/**
 * @param {AxisGlowApp} app
 * @param {Array<AxisSegment|[Point, Point]|object>|null|undefined} guides
 */
export function renderGuideLines(app, guides) {
    renderAxisGlow(app, (guides || []).map(guide => {
        const segment = Array.isArray(guide)
            ? { a: guide[0], b: guide[1], collinear: !axisAlignment(guide[0], guide[1]) } : guide;
        return { width: 0.25, .../** @type {AxisSegment} */ (segment) };
    }));
}

/**
 * @param {AxisGlowApp} app
 * @param {Array<AxisSegment|object>|null|undefined} segments
 */
export function renderAxisGlow(app, segments) {
    clearAxisGlow(app);
    const state = getAxisGlowState(app);
    const resolved = [];
    const halos = [];
    for (const item of segments || []) {
        const segment = /** @type {AxisSegment} */ (item);
        let color;
        if (segment.collinear || segment.square) color = COLLINEAR_GLOW_COLOR;
        else if (segment.frozen) continue;
        else {
            const axis = segment.axisKind ?? axisAlignment(segment.a, segment.b);
            if (!axis) continue;
            color = axis === 'd' ? '#CC79A7' : '#E69F00';
        }
        const parent = layerFor(app, segment);
        if (!parent) continue;
        const dashKind = segment.square ? 'solid' : segment.collinear ? 'dotted'
            : (segment.axisKind ?? axisAlignment(segment.a, segment.b)) === 'd' ? 'dashed' : 'solid';
        const halo = makeAxisGlowHalo(app, segment, color);
        parent.insertBefore(halo, parent.firstChild);
        halos.push(halo);
        resolved.push({ segment, dashKind });
    }
    state.halos = halos;
    state.resolved = resolved;
    renderAxisGlowTop(app);
}

/** @param {AxisGlowApp} app */
export function renderAxisGlowTop(app) {
    const state = getAxisGlowState(app);
    for (const element of state.top || []) element.remove();
    const centerlines = [];
    for (const { segment, dashKind } of state.resolved || []) {
        const parent = layerFor(app, segment);
        if (!parent) continue;
        const centerline = makeAxisGlowCenterline(app, segment, dashKind);
        parent.appendChild(centerline);
        centerlines.push(centerline);
    }
    state.top = centerlines;
}

/** @param {AxisGlowApp} app */
export function refreshAxisGlow(app) {
    const resolved = /** @type {Array<{segment: AxisSegment}>|null} */ (getAxisGlowState(app).resolved);
    const segments = resolved?.map(entry => entry.segment);
    if (segments) renderAxisGlow(app, segments);
}

/** @param {AxisGlowApp} app */
export function clearAxisGlow(app) {
    const state = getAxisGlowState(app);
    for (const element of state.halos || []) element.remove();
    for (const element of state.top || []) element.remove();
    state.halos = null;
    state.top = null;
    state.resolved = null;
}

/**
 * @param {AxisGlowApp} app
 * @param {AxisSegment} segment
 * @param {string} color
 * @param {SVGLineElement} [line]
 */
export function makeAxisGlowHalo(app, segment, color, line = document.createElementNS(NS, 'line')) {
    const scale = Math.max(0.01, app.viewport?.scale || 1);
    const width = segment.width || 0.2;
    const ring = segment.haloMarginPx != null
        ? segment.haloMarginPx / scale
        : Math.max(4 / scale, width * 0.25);
    line.setAttribute('class', 'pcb-track-preview');
    line.setAttribute('x1', String(segment.a.x));
    line.setAttribute('y1', String(segment.a.y));
    line.setAttribute('x2', String(segment.b.x));
    line.setAttribute('y2', String(segment.b.y));
    line.setAttribute('stroke', color);
    line.setAttribute('stroke-width', String(width + ring * 2));
    line.setAttribute('stroke-linecap', 'round');
    line.setAttribute('stroke-opacity', '0.7');
    line.setAttribute('pointer-events', 'none');
    return line;
}

/**
 * @param {AxisGlowApp} app
 * @param {AxisSegment} segment
 * @param {string} dashKind
 * @param {SVGLineElement} [line]
 */
export function makeAxisGlowCenterline(app, segment, dashKind, line = document.createElementNS(NS, 'line')) {
    const scale = app.viewport?.scale || 1;
    line.setAttribute('class', 'pcb-track-preview');
    line.setAttribute('x1', String(segment.a.x));
    line.setAttribute('y1', String(segment.a.y));
    line.setAttribute('x2', String(segment.b.x));
    line.setAttribute('y2', String(segment.b.y));
    line.setAttribute('stroke', '#ffffff');
    line.setAttribute('stroke-width', String(1.5 / scale));
    line.setAttribute('stroke-linecap', dashKind === 'dotted' ? 'round' : 'butt');
    if (dashKind === 'dotted') line.setAttribute('stroke-dasharray', `${0.01 / scale} ${6 / scale}`);
    else if (dashKind === 'dashed') line.setAttribute('stroke-dasharray', `${8 / scale} ${6 / scale}`);
    else line.removeAttribute('stroke-dasharray');
    line.setAttribute('stroke-opacity', '0.95');
    line.setAttribute('pointer-events', 'none');
    return line;
}