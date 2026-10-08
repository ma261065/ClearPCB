import { CopperFill, updateFillIdCounter } from '../shapes/copper-fill.js';
import { collapseRoundedPolygon } from '../shapes/path-operations.js';
import { hasRectangleFrame, rectangleFrameFromPoints, rectangleFramePoints } from '../shapes/rectangle-frame.js';
import { BULGE_EPS } from '../shapes/arc-edge.js';
import { validBoardOutline } from '../shared/pcb/board-outline.js';
import { normalizeShapeCopperMode, rectCornerRadius, polygonCornerRadius } from '../shared/pcb/board-shape-geometry.js';
import { normalizePicturePoints, validatePicturePoints, PICTURE_LAYERS } from '../shared/pcb/picture-raster.js';
import { encodePictureArtwork, decodePictureArtwork } from '../shared/pcb/picture-storage.js';

/**
 * @typedef {import('./geometry.js').Point} Point
 * @typedef {import('../shared/pcb/picture-raster.js').PictureArtwork} PictureArtwork
 * @typedef {'line'|'rect'|'polygon'|'arc'|'circle'|'image'} BoardShapeKind
 * @typedef {'add'|'remove-copper'|'remove-solder-mask'|'remove-copper-mask'} BoardShapeCopperMode
 * @typedef {{[key: string]: number}} BoardShapeNumberMap
 * @typedef {{points?: Point[], start?: Point, end?: Point, bulge?: Point, x?: number, y?: number, radius?: number, startWorld?: Point}} BoardShapeGeometry
 * @typedef {{
 *   id: string,
 *   type?: string,
 *   kind: BoardShapeKind,
 *   layer: string,
 *   points?: Point[],
 *   start?: Point,
 *   end?: Point,
 *   bulge?: Point,
 *   x?: number,
 *   y?: number,
 *   radius?: number,
 *   lineWidth: number,
 *   filled: boolean,
 *   copperMode: BoardShapeCopperMode,
 *   plated: boolean,
 *   net: string,
 *   locked?: boolean,
 *   visible?: boolean,
 *   segmentWidths?: BoardShapeNumberMap,
 *   segmentBulges?: BoardShapeNumberMap,
 *   nodeCornerRadii?: BoardShapeNumberMap,
 *   cornerRadius?: number,
 *   name?: string,
 *   artwork?: PictureArtwork,
 *   width?: number,
 *   height?: number,
 *   rotation?: number,
 *   reversed?: boolean,
 * }} BoardShapeBase
 * @typedef {BoardShapeBase & {kind: 'line', points: Point[], cornerRadius?: number}} BoardLineShape
 * @typedef {BoardShapeBase & {kind: 'rect', points: Point[], cornerRadius: number}} BoardRectShape
 * @typedef {BoardShapeBase & {kind: 'polygon', points: Point[], cornerRadius: number}} BoardPolygonShape
 * @typedef {BoardShapeBase & {kind: 'image', points: Point[], name: string, artwork: PictureArtwork}} BoardImageShape
 * @typedef {BoardLineShape|BoardRectShape|BoardPolygonShape|BoardImageShape} BoardPathShape
 * @typedef {BoardShapeBase & {kind: 'arc', start: Point, end: Point, bulge: Point}} BoardArcShape
 * @typedef {BoardShapeBase & {kind: 'circle', x: number, y: number, radius: number}} BoardCircleShape
 * @typedef {BoardPathShape|BoardArcShape|BoardCircleShape} BoardShape
 * @typedef {{
 *   kind: BoardShapeKind,
 *   layer: string,
 *   lineWidth: number,
 *   filled: boolean,
 *   copperMode: BoardShapeCopperMode,
 *   plated: boolean,
 *   net: string,
 *   locked: boolean,
 *   segmentWidths: BoardShapeNumberMap,
 *   segmentBulges: BoardShapeNumberMap,
 *   nodeCornerRadii: BoardShapeNumberMap,
 *   cornerRadius: number,
 *   artwork?: PictureArtwork,
 *   geom: BoardShapeGeometry,
 *   [key: string]: unknown,
 * }} BoardShapeSnapshot
 * @typedef {BoardShape|CopperFill} BoardShapeEntry
 * @typedef {{boardShapes: BoardShapeEntry[], shapeIdCounter: number}} BoardShapeState
 * @typedef {Partial<BoardShapeBase> & {type?: string, l?: string, k?: string, f?: boolean, p?: boolean, n?: string, lk?: boolean, v?: boolean, r?: number, pts?: number[][]|Point[], sp?: Point, ep?: Point, bp?: Point, aw?: PictureArtwork, nm?: string, w?: number, h?: number, rot?: number, rev?: boolean}} SerializedBoardShape
 */

export const SHAPE_KINDS = new Set(['line', 'rect', 'polygon', 'arc', 'circle', 'image']);
/** @param {number} n */
const r4 = n => Math.round(n * 10000) / 10000;
/** @param {{x?: unknown, y?: unknown}|null|undefined} p */
const pt = p => ({ x: Number(p?.x) || 0, y: Number(p?.y) || 0 });
/** @param {Point} p */
const clonePoint = p => ({ x: p.x, y: p.y });

/** @param {BoardShapeEntry|null|undefined} shape @returns {shape is BoardShape} */
export function isBoardShape(shape) {
    return !!shape && shape.type !== 'fill';
}

/** Full-precision geometry snapshot for moves and edits. */
/** @param {BoardShape} shape @returns {BoardShapeGeometry} */
export function cloneShapeGeometry(shape) {
    if (shape.kind === 'arc') {
        return { start: { ...shape.start }, end: { ...shape.end }, bulge: { ...shape.bulge } };
    }
    if (shape.kind === 'circle') return { x: shape.x, y: shape.y, radius: shape.radius };
    return { points: (shape.points || []).map(clonePoint) };
}

/**
 * @param {BoardShape} shape
 * @param {BoardShapeGeometry} geom
 */
export function applyShapeGeometry(shape, geom) {
    if (shape.kind === 'arc') {
        const arc = /** @type {BoardArcShape} */ (/** @type {unknown} */ (geom));
        delete shape.points;
        shape.start = { ...arc.start };
        shape.end = { ...arc.end };
        shape.bulge = { ...arc.bulge };
    } else if (shape.kind === 'circle') {
        const circle = /** @type {BoardCircleShape} */ (/** @type {unknown} */ (geom));
        shape.x = circle.x;
        shape.y = circle.y;
        shape.radius = circle.radius;
    } else {
        delete shape.start;
        delete shape.end;
        delete shape.bulge;
        shape.points = (geom.points || []).map(clonePoint);
    }
}

/** Authored edit snapshot; image artwork is shared read-only, not copied. */
/** @param {BoardShape} shape @returns {BoardShapeSnapshot} */
export function captureBoardShapeState(shape) {
    return {
        kind: shape.kind,
        ...(shape.kind === 'image' ? { artwork: shape.artwork } : {}),
        geom: cloneShapeGeometry(shape),
        cornerRadius: shape.kind === 'rect' ? rectCornerRadius(shape) : polygonCornerRadius(shape),
        nodeCornerRadii: { ...(shape.nodeCornerRadii || {}) },
        layer: shape.layer,
        lineWidth: Math.max(0.05, Number(shape.lineWidth) || 0.2),
        segmentWidths: { ...(shape.segmentWidths || {}) },
        segmentBulges: { ...(shape.segmentBulges || {}) },
        filled: !!shape.filled,
        copperMode: normalizeShapeCopperMode(shape.copperMode),
        plated: !!shape.plated,
        net: String(shape.net || ''),
        locked: !!shape.locked,
    };
}

/**
 * @param {BoardShape} shape
 * @param {BoardShapeSnapshot} state
 */
export function applyShapeSnapshot(shape, state) {
    if (state.kind) /** @type {BoardShapeBase} */ (shape).kind = state.kind;
    if (shape.kind === 'image' && state.artwork) shape.artwork = state.artwork;
    applyShapeGeometry(shape, state.geom);
    if (['line', 'rect', 'polygon'].includes(shape.kind)) {
        shape.cornerRadius = Math.max(0, Number(state.cornerRadius) || 0);
        shape.nodeCornerRadii = { ...(state.nodeCornerRadii || {}) };
    }
    shape.layer = state.layer;
    shape.lineWidth = state.lineWidth;
    shape.segmentWidths = { ...(state.segmentWidths || {}) };
    shape.segmentBulges = { ...(state.segmentBulges || {}) };
    shape.filled = !!state.filled;
    shape.copperMode = normalizeShapeCopperMode(state.copperMode);
    shape.plated = !!state.plated;
    shape.net = String(state.net || '');
    shape.locked = !!state.locked;
}

/**
 * @param {{boardShapes?: BoardShapeEntry[]}} state
 * @param {{compactArtwork?: boolean, roundGeometry?: boolean, parametricRectangles?: boolean}} [options]
 */
export function serializeBoardShapes(state, { compactArtwork = true, roundGeometry = true, parametricRectangles = true } = {}) {
    const artworkIndices = new Map();
    return (state.boardShapes || []).map((s, index) => {
        if (!isBoardShape(s)) return /** @type {{toJSON: () => unknown}} */ (/** @type {unknown} */ (s)).toJSON();
        const shape = s;
        /** @param {number} value */
        const number = value => roundGeometry && Number.isFinite(value) ? r4(value) : value;
        /** @param {Point} value */
        const point = value => ({ x: number(value.x), y: number(value.y) });
        /** @param {Record<string, number>} values */
        const numbers = values => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, number(value)]));
        /** @type {BoardShapeBase} */
        const base = {
            id: shape.id,
            kind: shape.kind,
            layer: shape.layer,
            lineWidth: number(/** @type {number} */ (shape.lineWidth)),
            filled: !!shape.filled,
            copperMode: normalizeShapeCopperMode(shape.copperMode),
            plated: !!shape.plated,
            net: String(shape.net || ''),
        };
        if (shape.locked) base.locked = true;
        if (Object.keys(shape.segmentWidths || {}).length) base.segmentWidths = numbers(/** @type {BoardShapeNumberMap} */ (shape.segmentWidths));
        if (Object.keys(shape.segmentBulges || {}).length) base.segmentBulges = numbers(/** @type {BoardShapeNumberMap} */ (shape.segmentBulges));
        if (Object.keys(shape.nodeCornerRadii || {}).length) base.nodeCornerRadii = numbers(/** @type {BoardShapeNumberMap} */ (shape.nodeCornerRadii));
        if (shape.kind === 'rect') base.cornerRadius = number(rectCornerRadius(shape));
        else if (shape.kind === 'polygon' || shape.kind === 'line') base.cornerRadius = number(polygonCornerRadius(shape));
        if (shape.kind === 'arc') return { ...base, start: point(shape.start), end: point(shape.end), bulge: point(shape.bulge) };
        if (shape.kind === 'circle') return { ...base, x: number(shape.x), y: number(shape.y), radius: number(shape.radius) };
        if (shape.kind === 'image') {
            const geometry = parametricRectangles ? rectangleFrameFromPoints(shape.points)
                : { points: shape.points.map(clonePoint) };
            if (!compactArtwork) return { ...base, name: shape.name, artwork: structuredClone(shape.artwork), ...geometry };
            const encoded = encodePictureArtwork(shape.artwork);
            const key = JSON.stringify(encoded);
            const previous = artworkIndices.get(key);
            const artwork = previous === undefined ? encoded : { encoding: 'reference-v1', index: previous };
            if (previous === undefined) artworkIndices.set(key, index);
            return { ...base, name: shape.name, artwork, ...geometry };
        }
        if (shape.kind === 'rect' && parametricRectangles) return { ...base, ...rectangleFrameFromPoints(shape.points) };
        const saved = { ...base, points: (shape.points || []).map(point) };
        if (roundGeometry && shape.kind === 'polygon') {
            collapseRoundedPolygon(saved);
            if (shape.layer === 'board-outline' && !validBoardOutline(/** @type {BoardShape} */ (saved))) {
                throw new Error('Cannot save board outline: rounding leaves an invalid closed outline.');
            }
        }
        return saved;
    });
}

/** Decode into a data-only stage; the caller owns adoption and rendering. */
/**
 * @param {BoardShapeState} state Legacy loader stages come from several loosely typed callers.
 * @param {unknown} arr Persisted project JSON loaded from disk.
 * @param {{strict?: boolean, lineWidth?: number}} [options]
 */
export function loadBoardShapeData(state, arr, { strict = false, lineWidth = 0.2 } = {}) {
    if (!Array.isArray(arr)) return;
    const loadedArtwork = new Map();
    for (const [index, sd] of arr.entries()) {
        if (sd?.type === 'fill') {
            try {
                const fill = CopperFill.fromJSON(sd);
                updateFillIdCounter(fill.id);
                state.boardShapes.push(fill);
            } catch (err) {
                if (strict) throw err;
                console.warn('Skipping malformed copper fill during load:', err);
            }
            continue;
        }
        const kind = SHAPE_KINDS.has(sd?.kind) ? sd.kind : null;
        if (!kind) {
            if (strict) throw new Error(`Unknown board shape kind: ${sd?.kind}`);
            continue;
        }
        /** @type {BoardShapeBase} */
        const base = {
            id: String(sd.id || `pshape_${state.shapeIdCounter++}`),
            kind,
            layer: String(sd.layer || 'top-silk'),
            lineWidth: Math.max(0.05, Number(sd.lineWidth) || lineWidth),
            filled: !!sd.filled,
            copperMode: normalizeShapeCopperMode(sd.copperMode),
            plated: !!sd.plated,
            net: String(sd.net || ''),
        };
        if (sd.locked) base.locked = true;
        if (sd.segmentWidths && typeof sd.segmentWidths === 'object') {
            base.segmentWidths = Object.fromEntries(Object.entries(sd.segmentWidths)
                .filter(([index, width]) => Number.isInteger(Number(index)) && Number(width) >= 0.05)
                .map(([index, width]) => [index, Number(width)]));
        }
        if (sd.segmentBulges && typeof sd.segmentBulges === 'object') {
            base.segmentBulges = Object.fromEntries(Object.entries(sd.segmentBulges)
                .filter(([segment, bulge]) => Number.isInteger(Number(segment))
                    && Number.isFinite(Number(bulge)) && Math.abs(Number(bulge)) >= BULGE_EPS)
                .map(([segment, bulge]) => [segment, Math.max(-1, Math.min(1, Number(bulge)))]));
        }
        if (sd.nodeCornerRadii && typeof sd.nodeCornerRadii === 'object') {
            base.nodeCornerRadii = Object.fromEntries(Object.entries(sd.nodeCornerRadii)
                .filter(([index, radius]) => Number.isInteger(Number(index)) && Number(radius) >= 0)
                .map(([index, radius]) => [index, Number(radius)]));
        }
        if (['line', 'rect', 'polygon'].includes(kind)) base.cornerRadius = Math.max(0, Number(sd.cornerRadius) || 0);
        /** @type {BoardShape} */
        let shape;
        if ((kind === 'rect' || kind === 'image') && hasRectangleFrame(sd)) {
            if (Object.hasOwn(sd, 'points')) throw new Error('Rectangle records cannot contain both a frame and corner points.');
            shape = /** @type {BoardShape} */ ({ ...base, kind, points: rectangleFramePoints(sd) });
        } else if (kind === 'arc') {
            shape = /** @type {BoardArcShape} */ ({ ...base, kind, start: pt(sd.start), end: pt(sd.end), bulge: pt(sd.bulge) });
        } else if (kind === 'circle') {
            const radius = Math.max(0.05, Number(sd.radius) || 0);
            if (!radius) continue;
            shape = /** @type {BoardCircleShape} */ ({ ...base, kind, x: Number(sd.x) || 0, y: Number(sd.y) || 0, radius });
        } else {
            const pts = Array.isArray(sd.points) ? sd.points.map(pt) : [];
            if (pts.length < (kind === 'line' ? 2 : 3)) {
                if (strict) throw new Error(`Insufficient points in board shape: ${sd.id}`);
                continue;
            }
            shape = /** @type {BoardShape} */ ({ ...base, kind, points: pts });
        }
        if (kind === 'image') {
            try {
                try {
                    validatePicturePoints(hasRectangleFrame(sd) ? shape.points : sd.points);
                } catch {
                    if (hasRectangleFrame(sd)) throw new Error('Invalid image rectangle frame.');
                    shape.points = normalizePicturePoints(sd.points, { coordinateTolerance: 0.0001 });
                }
                if (!PICTURE_LAYERS.includes(shape.layer)) throw new Error('Invalid image layer.');
                if (sd.artwork?.encoding === 'reference-v1') {
                    if (!Number.isInteger(sd.artwork.index) || sd.artwork.index >= index || !loadedArtwork.has(sd.artwork.index)) {
                        throw new Error('Invalid image artwork reference.');
                    }
                    shape.artwork = structuredClone(loadedArtwork.get(sd.artwork.index));
                } else shape.artwork = decodePictureArtwork(sd.artwork);
                loadedArtwork.set(index, shape.artwork);
                shape.name = String(sd.name || 'Image');
                shape.filled = true;
            } catch (error) {
                if (strict) throw error;
                console.warn('Skipping malformed image during load:', error);
                continue;
            }
        }
        state.boardShapes.push(shape);
        const n = /pshape_(\d+)/.exec(shape.id);
        if (n) state.shapeIdCounter = Math.max(state.shapeIdCounter, Number(/** @type {string} */ (n[1])) + 1);
    }
}
