/**
 * Box (marquee) selection for the PCB editor.
 *
 * Mirrors the schematic editor's rubber-band select: drag on empty canvas
 * with the Select tool to enclose objects. Fully-enclosed components,
 * tracks, vias, holes, and board shapes become a multi-selection that can be:
 *   - moved as a group (drag any selected member), and
 *   - deleted as a group via the Delete key — EXCEPT components, which are
 *     derived from the schematic netlist and are never deleted here.
 *
 * The marquee rectangle itself is drawn with the shared helpers in
 * ../../ui/modules/box-selection.js (it reads `app.drag.start`,
 * `app.viewport.scale` and `app.viewport.contentLayer`).
 */

import {
    createBoxSelectElement,
    updateBoxSelectElement,
    removeBoxSelectElement,
    getBoxSelectBounds,
} from '../../ui/modules/box-selection.js';
import { drawTrackHalo, drawViaHalo, drawHoleHalo, removeHalosByClass } from './track-select.js';
import { renderTrack, renderVia, renderHole } from './track-render.js';
import { isLayerLocked, isViaLocked } from './layers.js';
import {
    applyShapeGeometry,
    cloneShapeGeometry,
    boardShapeHitTest,
    renderBoardShape,
    shapeSelectionColor,
    shapeOutline,
    shapePathD,
} from './board-shapes.js';
import {
    CompoundCommand,
    RemoveTrackCommand,
    RemoveViaCommand,
    RemoveHoleCommand,
    MovePlacementCommand,
    MoveViaCommand,
    MoveHoleCommand,
    ModifyTrackGraphCommand,
    applyPlacementPose,
} from './track-commands.js';
import { MoveBoardShapeCommand, RemoveBoardShapeCommand } from './shape-commands.js';
import { clearPcbSelectionAnchors, renderPcbSelectionAnchors } from './selection-anchors.js';
import {
    clearPcbSelection,
    getPcbSelection,
    hasPcbSelection,
    setPcbSelection,
    togglePcbSelection,
} from './selection-registry.js';

/** Pixel distance the pointer must travel before a marquee starts. */
const START_THRESHOLD_PX = 3;
/** CSS classes for the multi-selection halos (distinct from single-select). */
const TRACK_HALO_CLASS = 'pcb-box-track-sel';
const VIA_HALO_CLASS = 'pcb-box-via-sel';
const HOLE_HALO_CLASS = 'pcb-box-hole-sel';
const COMP_HALO_CLASS = 'pcb-box-comp-sel';
const SHAPE_HALO_CLASS = 'pcb-box-shape-sel';

/* ───────────────────────────── state ───────────────────────────── */

/** Any objects currently box-selected? */
export function hasBoxSelection(app) {
    return hasPcbSelection(app);
}

/* ─────────────────────── arming / marquee ───────────────────────── */

/**
 * Arm a potential box-select. Called from mousedown on empty canvas; the
 * marquee only materialises once the pointer passes the drag threshold.
 * @param {object} app
 * @param {{x:number,y:number}} screen - clientX/clientY at mousedown
 * @param {{x:number,y:number}} world  - world coords at mousedown
 */
export function armBoxSelect(app, screen, world) {
    app._boxSelectArm = { screen, world };
    app._pcbSelectionInteraction = { mode: 'marquee-armed' };
    app._refreshPcbSelectionHighlights = () => refreshBoxSelectionHighlights(app);
}

/** Discard a pending (not-yet-started) box-select arm. */
export function disarmBoxSelect(app) {
    app._boxSelectArm = null;
    if (app._pcbSelectionInteraction?.mode === 'marquee-armed') {
        app._pcbSelectionInteraction = null;
    }
}

/** True while a marquee is actively being dragged. */
export function isBoxSelecting(app) {
    return !!app._boxSelectActive;
}

/**
 * Called on mousemove. If a box-select is armed and the pointer has moved
 * past the threshold, start the marquee. Returns true when the marquee is
 * active (so the caller should treat the move as a box-select update).
 * @param {object} app
 * @param {MouseEvent} e
 * @param {{x:number,y:number}} worldPos
 * @returns {boolean}
 */
export function maybeStartBoxSelect(app, e, worldPos) {
    if (app._boxSelectActive) {
        _updateMarquee(app, worldPos);
        return true;
    }
    const arm = app._boxSelectArm;
    if (!arm) return false;
    const ddx = e.clientX - arm.screen.x;
    const ddy = e.clientY - arm.screen.y;
    if (Math.hypot(ddx, ddy) < START_THRESHOLD_PX) return false;

    // Threshold crossed — begin the marquee. Clear any prior single
    // selection so the new box selection is the only highlighted thing.
    app._boxSelectActive = true;
    app._pcbSelectionInteraction = { mode: 'marquee' };
    app.drag = { start: { x: arm.world.x, y: arm.world.y } };
    clearBoxSelection(app);
    createBoxSelectElement(app);
    _updateMarquee(app, worldPos);
    return true;
}

/** Update the marquee rect + recompute the enclosed set + redraw halos. */
function _updateMarquee(app, worldPos) {
    updateBoxSelectElement(app, worldPos);
    const bounds = getBoxSelectBounds(app, worldPos);
    _computeEnclosed(app, bounds);
    _applyHighlights(app);
}

/** Finish the marquee: keep the selection, remove the rubber-band rect. */
export function finishBoxSelect(app) {
    if (!app._boxSelectActive) {
        app._boxSelectArm = null;
        if (app._pcbSelectionInteraction?.mode === 'marquee-armed') {
            app._pcbSelectionInteraction = null;
        }
        return false;
    }
    removeBoxSelectElement(app);
    app._boxSelectActive = false;
    app._boxSelectArm = null;
    if (app._pcbSelectionInteraction?.mode === 'marquee') {
        app._pcbSelectionInteraction = null;
    }
    app.drag = null;
    return hasBoxSelection(app);
}

/** Redraw the current marquee selection after an externally-driven edit. */
export function refreshBoxSelectionHighlights(app) {
    app._refreshPcbSelectionHighlights = () => refreshBoxSelectionHighlights(app);
    if (hasBoxSelection(app)) _applyHighlights(app);
}

/** Toggle one board shape in the active PCB multi-selection. */
export function toggleBoxShapeSelection(app, shape) {
    if (!shape) return;
    togglePcbSelection(app, 'shape', shape);
    _applyHighlights(app);
    app._syncClipboardButtons?.();
}

/* ─────────────────────── containment test ───────────────────────── */

/** Replace the selection sets with everything fully inside `bounds`. */
function _computeEnclosed(app, bounds) {
    const selected = [];
    const { minX, minY, maxX, maxY } = bounds;

    // Components: every pad must lie inside the rectangle.
    for (const [compId, pl] of app.placements) {
        if (!pl.pads || pl.pads.size === 0) continue;
        let allInside = true;
        for (const [, pad] of pl.pads) {
            if (pad.x < minX || pad.x > maxX || pad.y < minY || pad.y > maxY) {
                allInside = false;
                break;
            }
        }
        if (allInside) selected.push({ kind: 'component', object: compId });
    }

    // Tracks: every node must lie inside the rectangle. Locked-layer tracks
    // are never marquee-selectable.
    for (const t of app.tracks) {
        if (!t.nodes || t.nodes.size === 0) continue;
        if (isLayerLocked(t.layer)) continue;
        let allInside = true;
        for (const [, n] of t.nodes) {
            if (n.x < minX || n.x > maxX || n.y < minY || n.y > maxY) {
                allInside = false;
                break;
            }
        }
        if (allInside) selected.push({ kind: 'track', object: t });
    }

    // Vias: centre (± radius) inside the rectangle. Skip when locked.
    if (!isViaLocked()) {
        for (const v of app.vias) {
            const r = (v.diameter || 0.6) / 2;
            if (v.x - r >= minX && v.x + r <= maxX && v.y - r >= minY && v.y + r <= maxY) {
                selected.push({ kind: 'via', object: v });
            }
        }
    }

    // Holes: centre (± radius) inside the rectangle. Skip when the hole
    // layer is locked (read-only).
    if (!isLayerLocked('hole')) {
        for (const ho of (app.holes || [])) {
            const r = (ho.diameter || 0.8) / 2;
            if (ho.x - r >= minX && ho.x + r <= maxX && ho.y - r >= minY && ho.y + r <= maxY) {
                selected.push({ kind: 'hole', object: ho });
            }
        }
    }

    // Board shapes: every outline point must lie inside the marquee.
    for (const shape of (app.boardShapes || [])) {
        if (isLayerLocked(shape.layer)) continue;
        const outline = shapeOutline(shape);
        if (outline.length > 0 && outline.every((p) => p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY)) {
            selected.push({ kind: 'shape', object: shape });
        }
    }
    setPcbSelection(app, selected);
    app._syncClipboardButtons?.();
}

/* ─────────────────────── highlight rendering ─────────────────────── */

/** Draw halos for every selected object (clears old halos first). */
function _applyHighlights(app) {
    _clearHighlights(app);
    for (const compId of getPcbSelection(app, 'component')) _drawCompHighlight(app, compId);
    for (const track of getPcbSelection(app, 'track')) drawTrackHalo(app, track, TRACK_HALO_CLASS);
    for (const via of getPcbSelection(app, 'via')) drawViaHalo(app, via, VIA_HALO_CLASS);
    for (const hole of getPcbSelection(app, 'hole')) drawHoleHalo(app, hole, HOLE_HALO_CLASS);
    for (const shape of getPcbSelection(app, 'shape')) _drawShapeHighlight(app, shape);
    renderPcbSelectionAnchors(app);
}

/** Remove all box-selection halos from the DOM. */
function _clearHighlights(app) {
    removeHalosByClass(app, TRACK_HALO_CLASS);
    removeHalosByClass(app, VIA_HALO_CLASS);
    removeHalosByClass(app, HOLE_HALO_CLASS);
    app._getLayerGroup?.('selection-overlay')?.querySelectorAll(
        `.${SHAPE_HALO_CLASS}, .pcb-board-shape-handles`,
    ).forEach((el) => el.remove());
    clearPcbSelectionAnchors(app);
    for (const [, pl] of app.placements) {
        if (pl.elements) {
            for (const el of pl.elements) el.querySelector(`.${COMP_HALO_CLASS}`)?.remove();
        }
    }
}

function _drawShapeHighlight(app, shape) {
    const overlay = app._getLayerGroup?.('selection-overlay');
    if (!overlay) return;
    const halo = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    halo.setAttribute('class', SHAPE_HALO_CLASS);
    halo.setAttribute('d', shapePathD(shape, { close: shape.kind !== 'arc' }));
    halo.setAttribute('fill', 'none');
    halo.setAttribute('stroke', shapeSelectionColor(shape));
    halo.setAttribute('stroke-width', String(Math.max(0.3, (Number(shape.lineWidth) || 0.2) + 0.2)));
    halo.setAttribute('stroke-linejoin', 'round');
    halo.setAttribute('pointer-events', 'none');
    overlay.appendChild(halo);
}

/** Add a translucent rect over a component's footprint bounds. */
function _drawCompHighlight(app, compId) {
    const pl = app.placements.get(compId);
    if (!pl?.elements?.length || !pl.bounds) return;
    const b = pl.bounds;
    const NS = 'http://www.w3.org/2000/svg';
    const rect = document.createElementNS(NS, 'rect');
    rect.setAttribute('class', COMP_HALO_CLASS);
    rect.setAttribute('x', String(b.x));
    rect.setAttribute('y', String(b.y));
    rect.setAttribute('width', String(b.width));
    rect.setAttribute('height', String(b.height));
    rect.setAttribute('fill', 'rgba(51,153,255,0.15)');
    rect.setAttribute('stroke', '#3399ff');
    rect.setAttribute('stroke-width', '0.2');
    rect.setAttribute('pointer-events', 'none');
    pl.elements[0].appendChild(rect);
}

/** Clear the multi-selection and remove its halos. */
export function clearBoxSelection(app) {
    _clearHighlights(app);
    clearPcbSelection(app);
    app._syncClipboardButtons?.();
}

/* ─────────────────────────── group drag ─────────────────────────── */

/**
 * True when `worldPos` lands on a member of the current box-selection —
 * i.e. clicking there should start a group drag rather than a fresh
 * single selection.
 */
export function pointInBoxSelection(app, worldPos) {
    if (!hasBoxSelection(app)) return false;
    // Match the single-select feel: tracks/vias get a few pixels of slack
    // so the user doesn't have to click dead-centre to grab the group.
    const worldTol = 6 / (app.viewport?.scale || 1);

    // A selected component: pointer within a pad's reach (matches the
    // single-select 10 mm tolerance feel by reusing pad proximity).
    for (const compId of getPcbSelection(app, 'component')) {
        const pl = app.placements.get(compId);
        if (!pl) continue;
        if (pl.bounds) {
            const b = pl.bounds;
            if (worldPos.x >= pl.x + b.x && worldPos.x <= pl.x + b.x + b.width &&
                worldPos.y >= pl.y + b.y && worldPos.y <= pl.y + b.y + b.height) {
                return true;
            }
        }
    }
    // A selected via.
    for (const v of getPcbSelection(app, 'via')) {
        const r = (v.diameter || 0.6) / 2 + worldTol;
        if (Math.hypot(v.x - worldPos.x, v.y - worldPos.y) <= r) return true;
    }
    // A selected hole.
    for (const ho of getPcbSelection(app, 'hole')) {
        const r = (ho.diameter || 0.8) / 2 + worldTol;
        if (Math.hypot(ho.x - worldPos.x, ho.y - worldPos.y) <= r) return true;
    }
    // A selected track segment.
    for (const t of getPcbSelection(app, 'track')) {
        for (const [eid, e] of t.edges) {
            const a = t.nodes.get(e.from);
            const b = t.nodes.get(e.to);
            if (!a || !b) continue;
            const half = (t.getEdgeWidth ? t.getEdgeWidth(eid) : t.width || 0.2) / 2 + worldTol;
            if (_pointSegDist(worldPos, a, b) <= half) return true;
        }
    }
    for (const shape of getPcbSelection(app, 'shape')) {
        if (boardShapeHitTest(shape, worldPos, worldTol)) return true;
    }
    return false;
}

function _pointSegDist(p, a, b) {
    const vx = b.x - a.x, vy = b.y - a.y;
    const wx = p.x - a.x, wy = p.y - a.y;
    const len2 = vx * vx + vy * vy;
    if (len2 < 1e-12) return Math.hypot(wx, wy);
    let t = (wx * vx + wy * vy) / len2;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
}

/** Snapshot start positions of every selected object for a group drag. */
export function beginGroupDrag(app, worldPos) {
    const comps = [];
    for (const compId of getPcbSelection(app, 'component')) {
        const pl = app.placements.get(compId);
        if (pl) comps.push({ id: compId, x: pl.x, y: pl.y });
    }
    const vias = [];
    for (const v of getPcbSelection(app, 'via')) vias.push({ via: v, x: v.x, y: v.y });
    const holes = [];
    for (const ho of getPcbSelection(app, 'hole')) holes.push({ hole: ho, x: ho.x, y: ho.y });
    const tracks = [];
    for (const t of getPcbSelection(app, 'track')) {
        const nodes = new Map();
        for (const [nid, n] of t.nodes) nodes.set(nid, { x: n.x, y: n.y });
        tracks.push({ track: t, nodes, before: t.captureState() });
    }
    const shapes = [];
    for (const shape of getPcbSelection(app, 'shape')) shapes.push({ shape, before: cloneShapeGeometry(shape) });
    app._groupDrag = { startWorld: { x: worldPos.x, y: worldPos.y }, comps, vias, holes, tracks, shapes };
}

/** Live-update positions of every selected object during a group drag. */
export function updateGroupDrag(app, worldPos) {
    const g = app._groupDrag;
    if (!g) return;
    let dx = worldPos.x - g.startWorld.x;
    let dy = worldPos.y - g.startWorld.y;
    // Snap the shared delta (not each object) so relative layout is kept.
    if (app.viewport?.snapToGrid) {
        const gs = app.viewport.gridSize;
        dx = Math.round(dx / gs) * gs;
        dy = Math.round(dy / gs) * gs;
    }

    for (const c of g.comps) {
        const pl = app.placements.get(c.id);
        if (!pl) continue;
        pl.x = c.x + dx; pl.y = c.y + dy;
        applyPlacementPose(app, c.id);
    }
    for (const vEntry of g.vias) {
        vEntry.via.x = vEntry.x + dx;
        vEntry.via.y = vEntry.y + dy;
        renderVia(vEntry.via, (id) => app._getLayerGroup(id));
    }
    for (const hEntry of (g.holes || [])) {
        hEntry.hole.x = hEntry.x + dx;
        hEntry.hole.y = hEntry.y + dy;
        renderHole(hEntry.hole, (id) => app._getLayerGroup(id));
    }
    for (const tEntry of g.tracks) {
        for (const [nid, start] of tEntry.nodes) {
            const n = tEntry.track.nodes.get(nid);
            if (n) { n.x = start.x + dx; n.y = start.y + dy; }
        }
        renderTrack(tEntry.track, (id) => app._getLayerGroup(id), _trackOpts(app, tEntry.track));
    }
    for (const entry of (g.shapes || [])) {
        applyShapeGeometry(entry.shape, _translateShapeGeometry(entry.before, dx, dy));
        renderBoardShape(app, entry.shape, { liveDrag: true });
    }
    // Holes carry no net, so a holes-only drag leaves the ratsnest (and the
    // copper pours it re-pours) untouched — matching the single-hole drag,
    // where the fill void stays put until drop. Only reconcile when a
    // net-bearing object (component / via / track) actually moved.
    if (g.comps.length || g.vias.length || g.tracks.length) {
        app._updateRatsnest?.();
    }
    _applyHighlights(app);
}

function _translateShapeGeometry(geometry, dx, dy) {
    if (geometry.points) return { points: geometry.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
    return {
        start: { x: geometry.start.x + dx, y: geometry.start.y + dy },
        end: { x: geometry.end.x + dx, y: geometry.end.y + dy },
        bulge: { x: geometry.bulge.x + dx, y: geometry.bulge.y + dy },
    };
}

/** Commit a group drag as one undoable compound command. */
export function endGroupDrag(app) {
    const g = app._groupDrag;
    app._groupDrag = null;
    if (!g) return;
    const cmds = [];
    for (const c of g.comps) {
        const pl = app.placements.get(c.id);
        if (pl && (pl.x !== c.x || pl.y !== c.y)) {
            cmds.push(new MovePlacementCommand(app, c.id, c.x, c.y, pl.x, pl.y));
        }
    }
    for (const v of g.vias) {
        if (v.via.x !== v.x || v.via.y !== v.y) {
            cmds.push(new MoveViaCommand(app, v.via, v.x, v.y, v.via.x, v.via.y));
        }
    }
    for (const h of (g.holes || [])) {
        if (h.hole.x !== h.x || h.hole.y !== h.y) {
            cmds.push(new MoveHoleCommand(app, h.hole, h.x, h.y, h.hole.x, h.hole.y));
        }
    }
    for (const t of g.tracks) {
        const after = t.track.captureState();
        // Only record a move if something actually shifted.
        const moved = JSON.stringify(after) !== JSON.stringify(t.before);
        if (moved) cmds.push(new ModifyTrackGraphCommand(app, t.track, t.before, after));
    }
    for (const entry of (g.shapes || [])) {
        const after = cloneShapeGeometry(entry.shape);
        if (JSON.stringify(after) !== JSON.stringify(entry.before)) {
            cmds.push(new MoveBoardShapeCommand(app, entry.shape, entry.before, after));
        }
    }
    if (cmds.length === 0) {
        app._updateRatsnest?.();
        _applyHighlights(app);
        return;
    }
    // The model is already at the dragged-to state; execute() re-applies it
    // (idempotent), keeping the command the single source of truth.
    app.history?.execute(cmds.length === 1 ? cmds[0] : new CompoundCommand(cmds));
    _applyHighlights(app);
}

/** Cancel a supported-entity group drag and restore its initial geometry. */
export function cancelGroupDrag(app) {
    const g = app._groupDrag;
    app._groupDrag = null;
    if (!g) return;
    for (const entry of (g.shapes || [])) {
        applyShapeGeometry(entry.shape, entry.before);
        renderBoardShape(app, entry.shape);
    }
    _applyHighlights(app);
}

function _trackOpts(app, track) {
    const p = app._getRoutingParams?.() || {};
    return { viaDiameter: p.viaDiameter, viaDrill: p.viaDrill };
}

/* ─────────────────────────── deletion ───────────────────────────── */

/**
 * Delete the box-selected tracks and vias as one undoable action.
 * Components are intentionally NOT deleted (they are owned by the
 * schematic netlist). Returns true if anything was deleted.
 */
export function deleteBoxSelection(app) {
    if (!hasBoxSelection(app)) return false;
    const cmds = [];
    for (const t of getPcbSelection(app, 'track')) cmds.push(new RemoveTrackCommand(app, t));
    for (const v of getPcbSelection(app, 'via')) cmds.push(new RemoveViaCommand(app, v));
    for (const ho of getPcbSelection(app, 'hole')) cmds.push(new RemoveHoleCommand(app, ho));
    for (const shape of getPcbSelection(app, 'shape')) cmds.push(new RemoveBoardShapeCommand(app, shape));

    // Clear the selection (and its halos) before mutating the model.
    clearBoxSelection(app);

    if (cmds.length === 0) return false;
    app.history?.execute(cmds.length === 1 ? cmds[0] : new CompoundCommand(cmds));
    return true;
}
