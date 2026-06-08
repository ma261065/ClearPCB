/**
 * Box (marquee) selection for the PCB editor.
 *
 * Mirrors the schematic editor's rubber-band select: drag on empty canvas
 * with the Select tool to enclose objects. Fully-enclosed components,
 * tracks and vias become a multi-selection that can be:
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
import { drawTrackHalo, drawViaHalo, removeHalosByClass } from './track-select.js';
import { renderTrack, renderVia } from './track-render.js';
import { isLayerLocked, isViaLocked } from './layers.js';
import {
    CompoundCommand,
    RemoveTrackCommand,
    RemoveViaCommand,
    MovePlacementCommand,
    MoveViaCommand,
    ModifyTrackGraphCommand,
    repositionPadConnectedNodes,
} from './track-commands.js';

/** Pixel distance the pointer must travel before a marquee starts. */
const START_THRESHOLD_PX = 3;
/** CSS classes for the multi-selection halos (distinct from single-select). */
const TRACK_HALO_CLASS = 'pcb-box-track-sel';
const VIA_HALO_CLASS = 'pcb-box-via-sel';
const COMP_HALO_CLASS = 'pcb-box-comp-sel';

/* ───────────────────────────── state ───────────────────────────── */

/** Ensure the multi-selection container exists on the app. */
function _sel(app) {
    if (!app._boxSel) {
        app._boxSel = { comps: new Set(), tracks: new Set(), vias: new Set() };
    }
    return app._boxSel;
}

/** Any objects currently box-selected? */
export function hasBoxSelection(app) {
    const s = app._boxSel;
    return !!s && (s.comps.size > 0 || s.tracks.size > 0 || s.vias.size > 0);
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
}

/** Discard a pending (not-yet-started) box-select arm. */
export function disarmBoxSelect(app) {
    app._boxSelectArm = null;
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
        return;
    }
    removeBoxSelectElement(app);
    app._boxSelectActive = false;
    app._boxSelectArm = null;
    app.drag = null;
}

/* ─────────────────────── containment test ───────────────────────── */

/** Replace the selection sets with everything fully inside `bounds`. */
function _computeEnclosed(app, bounds) {
    const s = _sel(app);
    s.comps.clear();
    s.tracks.clear();
    s.vias.clear();
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
        if (allInside) s.comps.add(compId);
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
        if (allInside) s.tracks.add(t);
    }

    // Vias: centre (± radius) inside the rectangle. Skip when locked.
    if (!isViaLocked()) {
        for (const v of app.vias) {
            const r = (v.diameter || 0.6) / 2;
            if (v.x - r >= minX && v.x + r <= maxX && v.y - r >= minY && v.y + r <= maxY) {
                s.vias.add(v);
            }
        }
    }
}

/* ─────────────────────── highlight rendering ─────────────────────── */

/** Draw halos for every selected object (clears old halos first). */
function _applyHighlights(app) {
    _clearHighlights(app);
    const s = _sel(app);
    for (const compId of s.comps) _drawCompHighlight(app, compId);
    for (const t of s.tracks) drawTrackHalo(app, t, TRACK_HALO_CLASS);
    for (const v of s.vias) drawViaHalo(app, v, VIA_HALO_CLASS);
}

/** Remove all box-selection halos from the DOM. */
function _clearHighlights(app) {
    removeHalosByClass(app, TRACK_HALO_CLASS);
    removeHalosByClass(app, VIA_HALO_CLASS);
    for (const [, pl] of app.placements) {
        if (pl.elements) {
            for (const el of pl.elements) el.querySelector(`.${COMP_HALO_CLASS}`)?.remove();
        }
    }
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
    const s = _sel(app);
    s.comps.clear();
    s.tracks.clear();
    s.vias.clear();
}

/* ─────────────────────────── group drag ─────────────────────────── */

/**
 * True when `worldPos` lands on a member of the current box-selection —
 * i.e. clicking there should start a group drag rather than a fresh
 * single selection.
 */
export function pointInBoxSelection(app, worldPos) {
    if (!hasBoxSelection(app)) return false;
    const s = app._boxSel;
    // Match the single-select feel: tracks/vias get a few pixels of slack
    // so the user doesn't have to click dead-centre to grab the group.
    const worldTol = 6 / (app.viewport?.scale || 1);

    // A selected component: pointer within a pad's reach (matches the
    // single-select 10 mm tolerance feel by reusing pad proximity).
    for (const compId of s.comps) {
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
    for (const v of s.vias) {
        const r = (v.diameter || 0.6) / 2 + worldTol;
        if (Math.hypot(v.x - worldPos.x, v.y - worldPos.y) <= r) return true;
    }
    // A selected track segment.
    for (const t of s.tracks) {
        for (const [eid, e] of t.edges) {
            const a = t.nodes.get(e.from);
            const b = t.nodes.get(e.to);
            if (!a || !b) continue;
            const half = (t.getEdgeWidth ? t.getEdgeWidth(eid) : t.width || 0.2) / 2 + worldTol;
            if (_pointSegDist(worldPos, a, b) <= half) return true;
        }
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
    const s = _sel(app);
    const comps = [];
    for (const compId of s.comps) {
        const pl = app.placements.get(compId);
        if (pl) comps.push({ id: compId, x: pl.x, y: pl.y });
    }
    const vias = [];
    for (const v of s.vias) vias.push({ via: v, x: v.x, y: v.y });
    const tracks = [];
    for (const t of s.tracks) {
        const nodes = new Map();
        for (const [nid, n] of t.nodes) nodes.set(nid, { x: n.x, y: n.y });
        tracks.push({ track: t, nodes, before: t.captureState() });
    }
    app._groupDrag = { startWorld: { x: worldPos.x, y: worldPos.y }, comps, vias, tracks };
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
        const nx = c.x + dx, ny = c.y + dy;
        pl.x = nx; pl.y = ny;
        for (const el of pl.elements) el.setAttribute('transform', `translate(${nx}, ${ny})`);
        const halo = app._padHaloGroups?.get(c.id);
        if (halo) halo.setAttribute('transform', `translate(${nx}, ${ny})`);
        for (const off of (pl.padOffsets || [])) {
            pl.pads.set(off.number, { x: nx + off.dx, y: ny + off.dy });
        }
        repositionPadConnectedNodes(app, c.id);
    }
    for (const vEntry of g.vias) {
        vEntry.via.x = vEntry.x + dx;
        vEntry.via.y = vEntry.y + dy;
        renderVia(vEntry.via, (id) => app._getLayerGroup(id));
    }
    for (const tEntry of g.tracks) {
        for (const [nid, start] of tEntry.nodes) {
            const n = tEntry.track.nodes.get(nid);
            if (n) { n.x = start.x + dx; n.y = start.y + dy; }
        }
        renderTrack(tEntry.track, (id) => app._getLayerGroup(id), _trackOpts(app, tEntry.track));
    }
    app._updateRatsnest?.();
    _applyHighlights(app);
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
    for (const t of g.tracks) {
        const after = t.track.captureState();
        // Only record a move if something actually shifted.
        const moved = JSON.stringify(after) !== JSON.stringify(t.before);
        if (moved) cmds.push(new ModifyTrackGraphCommand(app, t.track, t.before, after));
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
    const s = app._boxSel;
    const cmds = [];
    for (const t of s.tracks) cmds.push(new RemoveTrackCommand(app, t));
    for (const v of s.vias) cmds.push(new RemoveViaCommand(app, v));

    // Clear the selection (and its halos) before mutating the model.
    clearBoxSelection(app);

    if (cmds.length === 0) return false;
    app.history?.execute(cmds.length === 1 ? cmds[0] : new CompoundCommand(cmds));
    return true;
}
