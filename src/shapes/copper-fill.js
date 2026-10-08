/**
 * CopperFill – a flood-filled copper pour region on a single copper layer.
 *
 * The user draws a closed outline polygon; the PCB editor floods that
 * region with copper, clearing the configured clearance around any
 * *other-net* copper (tracks / vias / pads) and merging solidly into
 * *same-net* copper. The actual poured geometry is computed on the fly
 * (see src/pcb/modules/copper-fill-geom.js) and is NOT stored here — this
 * class only holds the user-authored region (outline + layer + net).
 *
 * Positioned in world coordinates (mm). Like Via, CopperFill is a
 * lightweight data class: it does not extend Shape and is rendered by
 * src/pcb/modules/copper-fill-render.js rather than the schematic Shape
 * pipeline.
 */

import { closedShapeOutline } from './closed-outline.js';
import { collapseRoundedPolygon } from './path-operations.js';
import { rectangleFrameFromPoints, rectangleFramePoints, pointsFormRectangle } from './rectangle-frame.js';
import { IdAllocator } from '../core/id-allocator.js';

const fillIds = new IdAllocator('fill');
/** @param {number} value */
const round4 = value => Math.round(value * 10000) / 10000;

// Hit tests and bounds read the rounded outline on every pointer query; fills are
// edited in place, so the memo key is rebuilt from every outline input on each read.
const outlineCache = new WeakMap();

/** @typedef {{x:number, y:number}} Point */
/** @typedef {{minX:number, minY:number, maxX:number, maxY:number}} Bounds */
/**
 * @typedef {Object} CopperFillOptions
 * @property {string} [id]
 * @property {string} [layer]
 * @property {string} [net]
 * @property {Point[]} [outline]
 * @property {'polygon'|'rect'|'circle'|string} [kind]
 * @property {number} [cornerRadius]
 * @property {Record<string, number>} [nodeCornerRadii]
 * @property {Record<string, number>} [segmentBulges]
 * @property {number|string} [x]
 * @property {number|string} [y]
 * @property {number|string} [radius]
 * @property {boolean} [locked]
 * @property {boolean} [visible]
 */
/** @typedef {{key:string, points:Point[], bounds:Bounds|null}} OutlineCacheEntry */
/** @typedef {ReturnType<CopperFill['captureState']>} CopperFillState */
/** @typedef {{type:string, id:string, l:string, x?:number, y?:number, w?:number, h?:number, rot?:number, rev?:boolean, pts?:number[][], n?:string, lk?:boolean, v?:boolean, kind?:string, cornerRadius?:number, radius?:number, points?:Point[], nodeCornerRadii?:Record<string, number>, segmentBulges?:Record<string, number>}} SerializedCopperFill */

/** @param {Record<string, unknown>|null|undefined} record */
function recordKey(record) {
    let key = '';
    if (record) for (const name in record) key += `${name}:${record[name]},`;
    return key;
}

/** @param {CopperFill} fill @returns {OutlineCacheEntry} */
function resolvedOutline(fill) {
    let key = `${fill.kind}|${fill.x}|${fill.y}|${fill.radius}|${fill.cornerRadius}|`
        + `${recordKey(fill.nodeCornerRadii)}|${recordKey(fill.segmentBulges)}|`;
    for (const point of fill.outline) key += `${point.x},${point.y};`;
    let cached = outlineCache.get(fill);
    if (cached?.key !== key) outlineCache.set(fill, cached = { key, points: fill.getOutline(), bounds: null });
    return cached;
}

/** @param {Record<string, unknown>} data @param {string} compact @param {string} long @returns {unknown} */
function storedField(data, compact, long) {
    if (Object.hasOwn(data, compact) && Object.hasOwn(data, long)) {
        throw new Error(`Ambiguous copper-fill fields: ${compact} and ${long}.`);
    }
    return Object.hasOwn(data, compact) ? data[compact] : data[long];
}

/** Normalize edited fill topology while retaining circles as their own primitive. */
/** @param {CopperFill|null|undefined} fill */
export function normalizeCopperFillKind(fill) {
    if (!fill || fill.kind === 'circle') return false;
    const before = fill.kind;
    const hasCurves = Object.values(fill.segmentBulges || {}).some(value => Math.abs(value) >= 1e-4);
    fill.kind = pointsFormRectangle(fill.outline) && !hasCurves ? 'rect' : 'polygon';
    return fill.kind !== before;
}

/** Reset the fill ID counter (for testing / new-document). */
export function resetFillIdCounter() {
    fillIds.reset();
}

/** Update the fill ID counter so newly-issued IDs don't collide on load. */
/** @param {string} id */
export function updateFillIdCounter(id) {
    fillIds.observe(id);
}

export class CopperFill {
    /** @param {CopperFillOptions} [options] */
    constructor(options = {}) {
        /** @type {string} */
        this.id = fillIds.claim(options.id);
        this.type = 'fill';
        /** @type {string} */
        this.layer = options.layer === 'bottom-copper' ? 'bottom-copper' : 'top-copper';
        this.net = typeof options.net === 'string' ? options.net : '';
        /** @type {Point[]} */
        this.outline = Array.isArray(options.outline)
            ? options.outline.map((p) => ({ x: Number(p.x) || 0, y: Number(p.y) || 0 }))
            : [];
        this.locked = !!options.locked;
        this.visible = options.visible !== undefined ? options.visible : true;
        /** @type {string} */
        this.kind = typeof options.kind === 'string' && ['rect', 'circle'].includes(options.kind) ? options.kind : 'polygon';
        this.cornerRadius = Math.max(0, Number(options.cornerRadius) || 0);
        this.nodeCornerRadii = { ...(options.nodeCornerRadii || {}) };
        this.segmentBulges = { ...(options.segmentBulges || {}) };
        this.x = Number(options.x) || 0;
        this.y = Number(options.y) || 0;
        this.radius = Math.max(0.05, Number(options.radius) || 1);
        if (options.kind === undefined) normalizeCopperFillKind(this);
    }

    /** Move the whole region by (dx, dy) in world units. */
    /** @param {number} dx @param {number} dy */
    move(dx, dy) {
        if (this.kind === 'circle') {
            this.x += dx;
            this.y += dy;
        }
        for (const p of this.outline) {
            p.x += dx;
            p.y += dy;
        }
    }

    /** Axis-aligned bounds of the outline, or null when empty. */
    getBounds() {
        const resolved = resolvedOutline(this);
        if (resolved.points.length === 0) return null;
        if (!resolved.bounds) {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const p of resolved.points) {
                if (p.x < minX) minX = p.x;
                if (p.y < minY) minY = p.y;
                if (p.x > maxX) maxX = p.x;
                if (p.y > maxY) maxY = p.y;
            }
            resolved.bounds = { minX, minY, maxX, maxY };
        }
        return { ...resolved.bounds };
    }

    /** Point-in-polygon test against the outline (world coords). */
    /** @param {number} x @param {number} y */
    containsPoint(x, y) {
        const pts = resolvedOutline(this).points;
        const n = pts.length;
        if (n < 3) return false;
        let inside = false;
        for (let i = 0, j = n - 1; i < n; j = i++) {
            const xi = pts[i].x, yi = pts[i].y;
            const xj = pts[j].x, yj = pts[j].y;
            const intersect = ((yi > y) !== (yj > y))
                && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }

    /** Distance from a point to the nearest outline edge (world coords). */
    /** @param {number} x @param {number} y */
    distanceToEdge(x, y) {
        const pts = resolvedOutline(this).points;
        const n = pts.length;
        if (n < 2) return Infinity;
        let best = Infinity;
        for (let i = 0, j = n - 1; i < n; j = i++) {
            const d = distPointSeg(x, y, pts[j].x, pts[j].y, pts[i].x, pts[i].y);
            if (d < best) best = d;
        }
        return best;
    }

    get points() { return this.outline; }
    set points(points) { this.outline = points; }

    getOutline() { return closedShapeOutline(this); }

    /** Detached, full-precision resolved boundary; pour computation belongs to consumers. */
    captureCopperGeometry() {
        return { id: this.id, type: 'fill', layer: this.layer, net: this.net,
            outline: /** @type {Point[]} */ (this.getOutline()).map(point => ({ x: point.x, y: point.y })) };
    }

    clone() {
        const { id, ...state } = this.captureState();
        return new CopperFill(state);
    }

    /** Capture state for undo/redo. */
    captureState() {
        return {
            id: this.id,
            layer: this.layer,
            net: this.net,
            outline: this.outline.map((p) => ({ x: p.x, y: p.y })),
            locked: this.locked,
            visible: this.visible,
            kind: this.kind,
            cornerRadius: this.cornerRadius,
            nodeCornerRadii: { ...this.nodeCornerRadii },
            segmentBulges: { ...this.segmentBulges },
            x: this.x, y: this.y, radius: this.radius,
        };
    }

    /** Restore state from captureState() output. */
    /** @param {Partial<CopperFillState>} state */
    applyState(state) {
        if (state.layer === 'top-copper' || state.layer === 'bottom-copper') this.layer = state.layer;
        if (typeof state.net === 'string') this.net = state.net;
        if (Array.isArray(state.outline)) {
            this.outline = state.outline.map((p) => ({ x: Number(p.x) || 0, y: Number(p.y) || 0 }));
        }
        if (typeof state.locked === 'boolean') this.locked = state.locked;
        if (typeof state.visible === 'boolean') this.visible = state.visible;
        this.kind = typeof state.kind === 'string' && ['rect', 'circle'].includes(state.kind) ? state.kind : 'polygon';
        this.cornerRadius = Math.max(0, Number(state.cornerRadius) || 0);
        this.nodeCornerRadii = { ...(state.nodeCornerRadii || {}) };
        this.segmentBulges = { ...(state.segmentBulges || {}) };
        this.x = Number(state.x) || 0;
        this.y = Number(state.y) || 0;
        this.radius = Math.max(0.05, Number(state.radius) || 1);
    }

    /** Serialise to compact JSON. */
    toJSON() {
        /** @type {SerializedCopperFill} */
        const out = {
            type: 'fill',
            id: this.id,
            l: this.layer,
        };
        if (this.kind === 'rect') {
            const frame = rectangleFrameFromPoints(this.outline);
            Object.assign(out, { x: frame.x, y: frame.y, w: frame.width, h: frame.height, rot: frame.rotation });
            if (frame.reversed) out.rev = true;
        } else out.pts = this.outline.map((p) => [round4(p.x), round4(p.y)]);
        if (this.net) out.n = this.net;
        if (this.locked) out.lk = true;
        if (!this.visible) out.v = false;
        out.kind = this.kind;
        if (this.cornerRadius) out.cornerRadius = round4(this.cornerRadius);
        for (const field of /** @type {Array<'nodeCornerRadii'|'segmentBulges'>} */ (['nodeCornerRadii', 'segmentBulges'])) {
            if (Object.keys(this[field]).length) out[field] = Object.fromEntries(
                Object.entries(this[field]).map(([key, value]) => [key, round4(value)]));
        }
        if (this.kind === 'circle') Object.assign(out, { x: round4(this.x), y: round4(this.y), radius: round4(this.radius) });
        if (this.kind === 'polygon') {
            const path = { ...out, points: (out.pts || []).map(([x, y]) => ({ x, y })) };
            if (collapseRoundedPolygon(path)) {
                out.pts = path.points.map(({ x, y }) => [x, y]);
                for (const field of /** @type {Array<'nodeCornerRadii'|'segmentBulges'>} */ (['nodeCornerRadii', 'segmentBulges'])) {
                    if (path[field]) out[field] = path[field];
                    else delete out[field];
                }
            }
        }
        return out;
    }

    /** Deserialise from compact JSON produced by toJSON(). */
    /** @param {Record<string, unknown>} data */
    static fromJSON(data) {
        const points = /** @type {Array<[number, number]>} */ (storedField(data, 'pts', 'points'));
        const record = /** @type {Partial<SerializedCopperFill> & Record<string, unknown>} */ (data);
        let outline;
        if (record.kind === 'rect') {
            const hasPoints = Object.hasOwn(data, 'pts') || Object.hasOwn(data, 'points');
            const hasFrame = ['x', 'y', 'w', 'width', 'h', 'height', 'rot', 'rotation', 'rev', 'reversed']
                .some(key => Object.hasOwn(data, key));
            if (hasPoints === hasFrame) {
                throw new Error('Rectangular copper fill requires exactly one rectangle frame or legacy points.');
            }
            if (hasFrame) {
                outline = rectangleFramePoints({
                    x: record.x, y: record.y,
                    width: storedField(record, 'w', 'width'),
                    height: storedField(record, 'h', 'height'),
                    rotation: storedField(record, 'rot', 'rotation'),
                    reversed: storedField(record, 'rev', 'reversed'),
                });
            } else {
                if (!Array.isArray(points) || points.some(point => !Array.isArray(point)
                    || point.length !== 2 || !point.every(Number.isFinite))) {
                    throw new Error('Rectangular copper-fill points require finite [x, y] tuples.');
                }
                outline = points.map(point => ({ x: point[0], y: point[1] }));
                rectangleFrameFromPoints(outline);
            }
        } else outline = points.map((p) => ({ x: p[0], y: p[1] }));
        return new CopperFill({
            kind: record.kind, cornerRadius: record.cornerRadius,
            nodeCornerRadii: record.nodeCornerRadii, segmentBulges: record.segmentBulges,
            ...(record.kind === 'rect' ? {} : { x: record.x, y: record.y, radius: record.radius }),
            id: record.id,
            layer: /** @type {string|undefined} */ (storedField(record, 'l', 'layer')),
            net: /** @type {string|undefined} */ (storedField(record, 'n', 'net')),
            outline,
            locked: /** @type {boolean|undefined} */ (storedField(record, 'lk', 'locked')),
            visible: /** @type {boolean|undefined} */ (storedField(record, 'v', 'visible')),
        });
    }
}

/** Distance from point (px,py) to segment (ax,ay)-(bx,by). */
/** @param {number} px @param {number} py @param {number} ax @param {number} ay @param {number} bx @param {number} by */
function distPointSeg(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(px - ax, py - ay);
    let t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
