/**
 * Geometry of a placement's reference designator, and the transforms between
 * a footprint's authored-local frame and the board. The module owns the
 * rendered reference element/layout-box cache keyed by placement identity.
 */
import { REF_DEFAULT_SIZE } from '../../shared/pcb/footprint.js';
import { measureText as measureStrokeText } from '../../shared/pcb/stroke-font.js';
import { isLayerVisible } from './layers.js';
import { isPlacementMirrored } from '../../shared/pcb/board-geometry.js';

/** @typedef {{x:number,y:number}} Point */
/** @typedef {{bx:number,by:number,bw:number,bh:number,cx:number,cy:number}} RefBox */
/** @typedef {{element: Element|null, box: RefBox|null}} RefTextGeometryCache */
/** @typedef {{x:number,y:number,rotation?:number,side?:string,mirror?:boolean,refDx?:number,refDy?:number,refRot?:number,refSize?:number,reference?:string,refVisible?:boolean,elements?: Element[]}} RefPlacement */

/** Hit-test margin around a reference box, in mm (matches the drawn selection box). */
export const REF_BOX_PAD = 0.6;
/** @type {WeakMap<object, RefTextGeometryCache>} */
const refTextGeometry = new WeakMap();

/** @param {object} placement */
function ensureRefTextGeometry(placement) {
    let cache = refTextGeometry.get(placement);
    if (!cache) {
        cache = { element: null, box: null };
        refTextGeometry.set(placement, cache);
    }
    return cache;
}

/**
 * Seed or replace the cached reference text element and layout box for a placement.
 * @param {RefPlacement} placement
 * @param {Element|null} element
 * @param {RefBox|null} box
 */
export function setRefTextGeometryCache(placement, element, box) {
    if (!element && !box) {
        refTextGeometry.delete(placement);
        return;
    }
    const cache = ensureRefTextGeometry(placement);
    cache.element = element;
    cache.box = box;
}

/** @param {RefPlacement|null|undefined} placement */
export function refTextElement(placement) {
    return placement ? refTextGeometry.get(placement)?.element || null : null;
}

/** @param {RefPlacement|null|undefined} placement */
export function cachedRefBox(placement) {
    return placement ? refTextGeometry.get(placement)?.box || null : null;
}

/** @param {RefPlacement} placement */
export function invalidateRefBox(placement) {
    const cache = refTextGeometry.get(placement);
    if (cache) cache.box = null;
}

/**
 * Board point to the placement's authored-local frame: undo translate, rotate, mirror.
 * @param {Point} worldPos
 * @param {RefPlacement} pl placement
 * @returns {Point}
 */
export function worldToPlacementLocal(worldPos, pl) {
    let px = worldPos.x - pl.x;
    let py = worldPos.y - pl.y;
    const rot = pl.rotation || 0;
    if (rot) {
        const rad = rot * Math.PI / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        const rx = px * cos + py * sin;
        const ry = -px * sin + py * cos;
        px = rx; py = ry;
    }
    // scale(-1,1) is its own inverse.
    if (isPlacementMirrored(pl)) px = -px;
    return { x: px, y: py };
}

/**
 * Authored-local footprint point to the board, the inverse of worldToPlacementLocal:
 * mirror, rotate, translate.
 * @param {RefPlacement} pl placement
 * @param {number} lx
 * @param {number} ly
 * @returns {Point}
 */
export function placementLocalToWorld(pl, lx, ly) {
    let px = isPlacementMirrored(pl) ? -lx : lx;
    let py = ly;
    const rot = pl.rotation || 0;
    if (rot) {
        const rad = rot * Math.PI / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        const rx = px * cos - py * sin;
        const ry = px * sin + py * cos;
        px = rx; py = ry;
    }
    return { x: px + pl.x, y: py + pl.y };
}

/**
 * A placement's reference element and its footprint-local box `{bx,by,bw,bh,cx,cy}`
 * (the same frame as worldToPlacementLocal and the pad offsets), cached by this
 * module. Null when the footprint has no reference group.
 * @param {RefPlacement} pl placement
 * @returns {RefBox|null}
 */
export function refBox(pl) {
    if (!pl) return null;
    const cache = ensureRefTextGeometry(pl);
    if (cache.box && cache.element?.isConnected) return cache.box;
    let el = null;
    for (const layer of (pl.elements || [])) {
        el = layer.querySelector?.('[data-fp-ref]');
        if (el) break;
    }
    if (!el) return null;
    const bx = parseFloat(el.getAttribute('data-ref-bx') || '');
    const by = parseFloat(el.getAttribute('data-ref-by') || '');
    const bw = parseFloat(el.getAttribute('data-ref-bw') || '');
    const bh = parseFloat(el.getAttribute('data-ref-bh') || '');
    const cx = parseFloat(el.getAttribute('data-mx-center') || '');
    const cy = parseFloat(el.getAttribute('data-ref-cy') || '');
    if (![bx, by, bw, bh, cx, cy].every(Number.isFinite)) return null;
    cache.element = el;
    cache.box = { bx, by, bw, bh, cx, cy };
    return cache.box;
}

/** Board centre of a reference, including its offset (rotation about the centre leaves it fixed).
 * @param {RefPlacement} pl
 * @param {RefBox} box
 * @returns {Point}
 */
export function refCenterWorld(pl, box) {
    return placementLocalToWorld(pl, box.cx + (pl.refDx || 0), box.cy + (pl.refDy || 0));
}

/**
 * Board corners of the reference's inline-edit rectangle. Keep these metrics
 * identical to the inline editor's caret box (text-inline-edit.js).
 * @param {RefPlacement} pl
 * @param {RefBox} box
 * @returns {Point[]|null}
 */
export function refEditBoxWorldCorners(pl, box) {
    const size = pl.refSize || REF_DEFAULT_SIZE;
    const width = measureStrokeText(pl.reference || '', size);
    const baseX = box.cx - width / 2;
    const baseY = parseFloat(refTextElement(pl)?.getAttribute('data-ref-anchor-y') || '');
    if (!Number.isFinite(baseY)) return null;

    const padX = size * 0.15;
    const padTop = size * 0.25;
    const padBot = size * 1.0;
    const referenceAngle = (pl.refRot || 0) * Math.PI / 180;
    const cosine = Math.cos(referenceAngle), sine = Math.sin(referenceAngle);
    return [
        [baseX - padX, baseY - size - padTop],
        [baseX + width + padX, baseY - size - padTop],
        [baseX + width + padX, baseY + padBot],
        [baseX - padX, baseY + padBot],
    ].map(([x, y]) => {
        const deltaX = x - box.cx, deltaY = y - box.cy;
        let localX = box.cx + deltaX * cosine - deltaY * sine;
        const localY = box.cy + deltaX * sine + deltaY * cosine;
        if (pl.mirror) localX = 2 * box.cx - localX;
        return placementLocalToWorld(pl, localX + (pl.refDx || 0), localY + (pl.refDy || 0));
    });
}

/**
 * The topmost component whose visible reference box contains a board point, or null.
 * @param {Map<string, RefPlacement>} placements
 * @param {Point} worldPos
 * @param {(pl: RefPlacement) => RefBox|null} [boxOf] reference box lookup (the editor passes its own)
 * @returns {string|null}
 */
export function hitTestRefText(placements, worldPos, boxOf = refBox) {
    let hit = null;
    for (const [compId, pl] of placements) {
        if (pl.refVisible === false) continue;
        if (!isLayerVisible(pl.side === 'bottom' ? 'bottom-silk' : 'top-silk')) continue;
        const box = boxOf(pl);
        if (!box) continue;
        // Undo placement, reference offset, user counter-mirror, then reference rotation.
        const local = worldToPlacementLocal(worldPos, pl);
        let ax = local.x - (pl.refDx || 0);
        let ay = local.y - (pl.refDy || 0);
        if (pl.mirror) ax = 2 * box.cx - ax;
        const rr = pl.refRot || 0;
        if (rr) {
            const rad = -rr * Math.PI / 180;
            const cos = Math.cos(rad), sin = Math.sin(rad);
            const ox = ax - box.cx, oy = ay - box.cy;
            ax = box.cx + ox * cos - oy * sin;
            ay = box.cy + ox * sin + oy * cos;
        }
        if (ax >= box.bx - REF_BOX_PAD && ax <= box.bx + box.bw + REF_BOX_PAD
            && ay >= box.by - REF_BOX_PAD && ay <= box.by + box.bh + REF_BOX_PAD) {
            hit = compId;
        }
    }
    return hit;
}
