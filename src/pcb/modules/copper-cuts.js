import { boardShapeCopperCuts, getBoardShapeRotationPreview } from './board-shapes.js';
import { setCopperFillClip } from './copper-fill-render.js';
import { areDragOverlaysDeferred } from './refresh-state.js';
import { isPcbPasteActive } from './pcb-paste.js';
import { boardDimensions } from '../../shared/pcb/board-outline.js';
import { ensureSvgDefs } from './svg-defs.js';

/*
 * Copper cuts: the per-side SVG clip-paths that remove copper under copper-removal
 * shapes and board holes. The clip cache is owned here, per editor; other modules ask
 * hasCopperCuts() whether any cut is active. (Removal shapes' hatching is in
 * removal-hatch.js.)
 */

const cutStates = new WeakMap();

/**
 * Per-editor state. `applied` holds the clip path string last applied per side
 * (`null` = cleared, `undefined` = not yet computed); `geometry` the resolved cut
 * geometry per side; `active` whether any side has a cut.
 */
function cutState(app) {
    let state = cutStates.get(app);
    if (!state) {
        cutStates.set(app, state = {
            applied: { top: undefined, bottom: undefined }, geometry: {}, active: false, defs: null,
        });
    }
    return state;
}

/** The copper-cut caches, for tests. */
export function copperCutState(app) {
    return cutState(app);
}

/** Whether any copper cut is applied, so view changes know to re-fit the clip. */
export function hasCopperCuts(app) {
    return cutStates.get(app)?.active || false;
}

/**
 * Rebuild the per-side SVG clip-paths that cut copper where "remove
 * copper" circles sit, and apply (or clear) them on copper groups and
 * poured-copper paths. The cut reveals the canvas behind — no board-colour fill is
 * painted — so a track or pour passing through a removal circle reads as
 * genuinely removed, matching the 2D/3D board views.
 *
 * A clip-path (not a <mask>) is used deliberately: clipping is vector and
 * resolution-independent, so it stays exact at any zoom. A raster mask
 * blows past the GPU's maximum texture size when zoomed in and gets
 * silently dropped, which made the copper "fill back in".
 */
export function updateCopperCuts(app, { geometryChanged = true } = {}) {
    const defs = ensureSvgDefs(app);
    if (!defs) return;
    const state = cutState(app);
    state.defs = defs;
    const groups = app.existingLayerGroups();
    const NS = 'http://www.w3.org/2000/svg';
    // Size the outer rectangle to the visible viewport (plus a one-screen
    // margin) rather than a fixed huge constant. The browser rasterises a
    // clip-path at the size of its bounding box; a giant rectangle makes
    // that raster exceed the GPU limit once zoomed in and the clip is
    // silently dropped (copper "fills back in"). A viewport-sized rect
    // keeps the raster ~screen-sized at any zoom. Off-screen copper that
    // falls outside the rect is clipped away, but it is off-screen anyway.
    const vb = app.viewport?.getVisibleBounds?.();
    let x0, y0, x1, y1;
    if (vb && Number.isFinite(vb.minX) && vb.maxX > vb.minX && vb.maxY > vb.minY) {
        const mx = vb.maxX - vb.minX;
        const my = vb.maxY - vb.minY;
        x0 = vb.minX - mx; x1 = vb.maxX + mx;
        y0 = vb.minY - my; y1 = vb.maxY + my;
    } else {
        const { width, height } = boardDimensions(app);
        const m = Math.max(width || 100, height || 80);
        x0 = -m; x1 = (width || 100) + m;
        y0 = -(height || 80) - m; y1 = m;
    }
    const r4 = (n) => Math.round(n * 10000) / 10000;
    // Rebuilding the clip-path <path> and re-setting the clip-path attribute
    // invalidates the copper layer's raster, forcing a full repaint of every
    // track and pour. Most calls (hover, re-select, dragging an unrelated
    // element, re-render-all) produce identical geometry, so a string compare
    // against the last-applied path lets us skip all DOM work and the repaint.
    const applied = state.applied;
    const geometryCache = state.geometry;
    const deferGeometry = areDragOverlaysDeferred(app) || getBoardShapeRotationPreview(app);
    let any = false;
    for (const side of ['top', 'bottom']) {
        const copperLayer = `${side}-copper`;
        const fillLayer = `${side}-fill`;
        const clipId = `pcb-copper-cut-${side}`;
        // Keep cutouts aligned with deferred pours until the drag commits or cancels.
        // Viewport changes can still resize the outer clip without moving its holes.
        const shapeCuts = (!geometryChanged || deferGeometry) && geometryCache[side]
            ? geometryCache[side]
            : (geometryCache[side] = boardShapeCopperCuts(isPcbPasteActive(app) ? app.pcbDocument : app, copperLayer));
        const existing = defs.querySelector(`#${clipId}`);
        if (shapeCuts.count === 0) {
            // Nothing to cut on this side. Only touch the DOM if we weren't
            // already in the cleared state.
            if (applied[side] !== null) {
                if (existing) existing.remove();
                groups.get(copperLayer)?.removeAttribute('clip-path');
                setCopperFillClip(groups.get(fillLayer), null);
                applied[side] = null;
            }
            continue;
        }
        any = true;
        // Outer rectangle keeps everything; board-shape removal sub-paths
        // toggle holes with even-odd fill.
        let d = `M ${r4(x0)} ${r4(y0)} L ${r4(x1)} ${r4(y0)} L ${r4(x1)} ${r4(y1)} L ${r4(x0)} ${r4(y1)} Z`;
        if (shapeCuts.d) d += ` ${shapeCuts.d}`;
        // Identical geometry already applied (and the clip element still
        // present) → skip the rebuild + re-apply, avoiding the repaint.
        if (applied[side] === d && existing) continue;
        const clip = existing || document.createElementNS(NS, 'clipPath');
        clip.setAttribute('id', clipId);
        clip.setAttribute('clipPathUnits', 'userSpaceOnUse');
        while (clip.firstChild) clip.removeChild(clip.firstChild);
        const path = document.createElementNS(NS, 'path');
        path.setAttribute('d', d);
        path.setAttribute('clip-rule', 'evenodd');
        clip.appendChild(path);
        if (!existing) defs.appendChild(clip);
        groups.get(copperLayer)?.setAttribute('clip-path', `url(#${clipId})`);
        setCopperFillClip(groups.get(fillLayer), clipId);
        applied[side] = d;
    }
    state.active = any;
}

/**
 * Drop the copper-cut clip-paths when the board is cleared; they are rebuilt as
 * removal shapes re-render.
 */
export function clearCopperCuts(app) {
    const state = cutState(app);
    const groups = app.existingLayerGroups();
    for (const side of ['top', 'bottom']) {
        state.defs?.querySelector(`#pcb-copper-cut-${side}`)?.remove();
        groups.get(`${side}-copper`)?.removeAttribute('clip-path');
        setCopperFillClip(groups.get(`${side}-fill`), null);
    }
    // The DOM is now in the cleared (no-cut) state; keep the applied-path cache in
    // sync so the next updateCopperCuts re-applies cuts from scratch.
    state.applied = { top: null, bottom: null };
    state.active = false;
}
