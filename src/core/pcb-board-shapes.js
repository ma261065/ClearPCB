import { CopperFill, updateFillIdCounter } from '../shapes/copper-fill.js';
import { collapseRoundedPolygon } from '../shapes/path-operations.js';
import { hasRectangleFrame, rectangleFrameFromPoints, rectangleFramePoints } from '../shapes/rectangle-frame.js';
import { BULGE_EPS } from '../shapes/arc-edge.js';
import { validBoardOutline } from '../shared/pcb/board-outline.js';
import { normalizeShapeCopperMode, rectCornerRadius, polygonCornerRadius } from '../shared/pcb/board-shape-geometry.js';
import { normalizePicturePoints, validatePicturePoints, PICTURE_LAYERS } from '../shared/pcb/picture-raster.js';
import { encodePictureArtwork, decodePictureArtwork } from '../shared/pcb/picture-storage.js';

export const SHAPE_KINDS = new Set(['line', 'rect', 'polygon', 'arc', 'circle', 'image']);
const r4 = n => Math.round(n * 10000) / 10000;
const pt = p => ({ x: Number(p?.x) || 0, y: Number(p?.y) || 0 });

/** Full-precision geometry snapshot for moves and edits. */
export function cloneShapeGeometry(shape) {
    if (shape.kind === 'arc') {
        return { start: { ...shape.start }, end: { ...shape.end }, bulge: { ...shape.bulge } };
    }
    if (shape.kind === 'circle') return { x: shape.x, y: shape.y, radius: shape.radius };
    return { points: (shape.points || []).map(p => ({ x: p.x, y: p.y })) };
}

export function applyShapeGeometry(shape, geom) {
    if (shape.kind === 'arc') {
        delete shape.points;
        shape.start = { ...geom.start };
        shape.end = { ...geom.end };
        shape.bulge = { ...geom.bulge };
    } else if (shape.kind === 'circle') {
        shape.x = geom.x;
        shape.y = geom.y;
        shape.radius = geom.radius;
    } else {
        delete shape.start;
        delete shape.end;
        delete shape.bulge;
        shape.points = (geom.points || []).map(p => ({ x: p.x, y: p.y }));
    }
}

/** Authored edit snapshot; image artwork is shared read-only, not copied. */
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
    };
}

export function applyShapeSnapshot(shape, state) {
    if (state.kind) shape.kind = state.kind;
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
}

export function serializeBoardShapes(state, { compactArtwork = true, roundGeometry = true, parametricRectangles = true } = {}) {
    const artworkIndices = new Map();
    return (state.boardShapes || []).map((s, index) => {
        if (s?.type === 'fill') return s.toJSON();
        const number = value => roundGeometry && Number.isFinite(value) ? r4(value) : value;
        const point = value => ({ x: number(value.x), y: number(value.y) });
        const numbers = values => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, number(value)]));
        const base = {
            id: s.id,
            kind: s.kind,
            layer: s.layer,
            lineWidth: number(s.lineWidth),
            filled: !!s.filled,
            copperMode: normalizeShapeCopperMode(s.copperMode),
            plated: !!s.plated,
            net: String(s.net || ''),
        };
        if (Object.keys(s.segmentWidths || {}).length) base.segmentWidths = numbers(s.segmentWidths);
        if (Object.keys(s.segmentBulges || {}).length) base.segmentBulges = numbers(s.segmentBulges);
        if (Object.keys(s.nodeCornerRadii || {}).length) base.nodeCornerRadii = numbers(s.nodeCornerRadii);
        if (s.kind === 'rect') base.cornerRadius = number(rectCornerRadius(s));
        else if (s.kind === 'polygon' || s.kind === 'line') base.cornerRadius = number(polygonCornerRadius(s));
        if (s.kind === 'arc') return { ...base, start: point(s.start), end: point(s.end), bulge: point(s.bulge) };
        if (s.kind === 'circle') return { ...base, x: number(s.x), y: number(s.y), radius: number(s.radius) };
        if (s.kind === 'image') {
            const geometry = parametricRectangles ? rectangleFrameFromPoints(s.points)
                : { points: s.points.map(value => ({ x: value.x, y: value.y })) };
            if (!compactArtwork) return { ...base, name: s.name, artwork: structuredClone(s.artwork), ...geometry };
            const encoded = encodePictureArtwork(s.artwork);
            const key = JSON.stringify(encoded);
            const previous = artworkIndices.get(key);
            const artwork = previous === undefined ? encoded : { encoding: 'reference-v1', index: previous };
            if (previous === undefined) artworkIndices.set(key, index);
            return { ...base, name: s.name, artwork, ...geometry };
        }
        if (s.kind === 'rect' && parametricRectangles) return { ...base, ...rectangleFrameFromPoints(s.points) };
        const saved = { ...base, points: (s.points || []).map(point) };
        if (roundGeometry && s.kind === 'polygon') {
            collapseRoundedPolygon(saved);
            if (s.layer === 'board-outline' && !validBoardOutline(saved)) {
                throw new Error('Cannot save board outline: rounding leaves an invalid closed outline.');
            }
        }
        return saved;
    });
}

/** Decode into a data-only stage; the caller owns adoption and rendering. */
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
        let shape;
        if ((kind === 'rect' || kind === 'image') && hasRectangleFrame(sd)) {
            if (Object.hasOwn(sd, 'points')) throw new Error('Rectangle records cannot contain both a frame and corner points.');
            shape = { ...base, points: rectangleFramePoints(sd) };
        } else if (kind === 'arc') {
            shape = { ...base, start: pt(sd.start), end: pt(sd.end), bulge: pt(sd.bulge) };
        } else if (kind === 'circle') {
            const radius = Math.max(0.05, Number(sd.radius) || 0);
            if (!radius) continue;
            shape = { ...base, x: Number(sd.x) || 0, y: Number(sd.y) || 0, radius };
        } else {
            const pts = Array.isArray(sd.points) ? sd.points.map(pt) : [];
            if (pts.length < (kind === 'line' ? 2 : 3)) {
                if (strict) throw new Error(`Insufficient points in board shape: ${sd.id}`);
                continue;
            }
            shape = { ...base, points: pts };
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
        if (n) state.shapeIdCounter = Math.max(state.shapeIdCounter, Number(n[1]) + 1);
    }
}
