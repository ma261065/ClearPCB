/**
 * Vertex/segment drag editing for a selected Track.
 *
 * Drag rules (chosen to match the schematic Wire conventions):
 *   - Mousedown on a Track node moves that single node.
 *   - Mousedown on a Track segment inserts a new node at the click
 *     position and drags it (effectively bending the segment).
 *   - Move snaps to grid; pad / track-node snap targets supersede grid
 *     when the cursor is within tolerance.
 *   - Mouseup commits a MoveVertexCommand to the history stack.
 *   - Escape cancels and restores the original position.
 */

import { renderTrack } from './track-render.js';
import { renderVia } from './track-render.js';
import {
    resolveTrackSnap,
    reconcileRatsnest,
} from './track-draw.js';
import { refreshTrackSelectionHalo } from './track-select.js';
import { MoveVertexCommand, MoveViaCommand, CompoundCommand } from './track-commands.js';

/** Screen-px hit tolerance for selecting a Track node to drag. */
const NODE_HIT_PX = 8;

function _opts(app) {
    return {
        viaDiameter: app._getRoutingParams?.()?.viaDiameter,
        viaDrill: app._getRoutingParams?.()?.viaDrill,
    };
}

/**
 * Hit-test a Track's nodes against the world position. Returns the
 * nodeId of the closest node within tolerance, else null.
 */
export function hitTestTrackNode(app, track, worldPos, pxTol = NODE_HIT_PX) {
    const scale = app.viewport?.scale || 1;
    const tol = pxTol / scale;
    let best = null;
    let bestD = tol;
    for (const [nid, n] of track.nodes) {
        const d = Math.hypot(n.x - worldPos.x, n.y - worldPos.y);
        if (d < bestD) { bestD = d; best = nid; }
    }
    return best;
}

/**
 * Find which edge of `track` the world position lies on (closest
 * perpendicular projection within `track.width/2 + tol`). Returns
 * { edgeId, edge, t } or null.
 */
export function hitTestTrackEdge(app, track, worldPos, pxTol = 6) {
    const scale = app.viewport?.scale || 1;
    const half = (track.width || 0.2) / 2 + pxTol / scale;
    let best = null;
    let bestD = half;
    for (const [eid, e] of track.edges) {
        const a = track.nodes.get(e.from);
        const b = track.nodes.get(e.to);
        if (!a || !b) continue;
        const vx = b.x - a.x, vy = b.y - a.y;
        const len2 = vx * vx + vy * vy;
        if (len2 < 1e-12) continue;
        let t = ((worldPos.x - a.x) * vx + (worldPos.y - a.y) * vy) / len2;
        if (t < 0 || t > 1) continue;
        const d = Math.hypot(worldPos.x - (a.x + t * vx), worldPos.y - (a.y + t * vy));
        if (d < bestD) { bestD = d; best = { edgeId: eid, edge: e, t }; }
    }
    return best;
}

/**
 * Begin a drag on the selected track. Returns true if a drag was
 * started, false if the click missed.
 */
export function startVertexDrag(app, track, worldPos) {
    let nodeId = hitTestTrackNode(app, track, worldPos);

    // If the click missed all nodes, try to bend a segment by splitting
    // its edge at the click and dragging the new node.
    if (!nodeId) {
        const hit = hitTestTrackEdge(app, track, worldPos);
        if (!hit) return false;
        const e = hit.edge;
        const a = track.nodes.get(e.from);
        const b = track.nodes.get(e.to);
        const px = a.x + hit.t * (b.x - a.x);
        const py = a.y + hit.t * (b.y - a.y);
        const layer = track.edgeLayers.get(hit.edgeId) || track.layer;
        // Insert a new node, two new edges, drop the old edge.
        nodeId = track.addNode(px, py);
        track.removeEdge(hit.edgeId);
        track.edgeLayers.delete(hit.edgeId);
        const e1 = track.addEdge(e.from, nodeId);
        const e2 = track.addEdge(nodeId, e.to);
        track.edgeLayers.set(e1, layer);
        track.edgeLayers.set(e2, layer);
    }

    const n = track.nodes.get(nodeId);
    app._vertexDrag = {
        track,
        nodeId,
        startX: n.x,
        startY: n.y,
        // Was this node attached to a pad? Hold onto the link; we'll
        // drop it if the user drags away from the original pad.
        padLink: track.padConnections.get(nodeId) || null,
    };
    return true;
}

/** Update the dragged node's position from the current mouse world pos. */
export function updateVertexDrag(app, worldPos) {
    const drag = app._vertexDrag;
    if (!drag) return;
    const snap = resolveTrackSnap(app, worldPos, { excludeTrack: drag.track });
    const n = drag.track.nodes.get(drag.nodeId);
    if (!n) return;
    n.x = snap.x;
    n.y = snap.y;

    // If the user landed on a pad, record/replace the pad connection.
    if (snap.snapType === 'pad' && snap.pad) {
        drag.track.padConnections.set(drag.nodeId, {
            componentId: snap.pad.componentId,
            pinNumber: snap.pad.pinNumber,
        });
    } else {
        drag.track.padConnections.delete(drag.nodeId);
    }

    renderTrack(drag.track, (id) => app._getLayerGroup(id), _opts(app));
    // Keep the selection halo glued to the new geometry.
    refreshTrackSelectionHalo(app);
}

/**
 * Commit the in-progress drag as a MoveVertexCommand, or revert if no
 * net movement.
 */
export function finishVertexDrag(app) {
    const drag = app._vertexDrag;
    if (!drag) return;
    app._vertexDrag = null;
    const n = drag.track.nodes.get(drag.nodeId);
    if (!n) return;
    const moved = Math.abs(n.x - drag.startX) > 1e-6 || Math.abs(n.y - drag.startY) > 1e-6;
    if (!moved) return;
    // Snap-back the model so the command's execute() can re-apply.
    const toX = n.x, toY = n.y;
    n.x = drag.startX;
    n.y = drag.startY;
    const cmd = new MoveVertexCommand(app, drag.track, drag.nodeId, drag.startX, drag.startY, toX, toY);
    app.history.execute(cmd);
    reconcileRatsnest(app);
}

/** Abort the in-progress drag and restore the original node position. */
export function cancelVertexDrag(app) {
    const drag = app._vertexDrag;
    if (!drag) return;
    app._vertexDrag = null;
    const n = drag.track.nodes.get(drag.nodeId);
    if (n) {
        n.x = drag.startX;
        n.y = drag.startY;
        renderTrack(drag.track, (id) => app._getLayerGroup(id), _opts(app));
    }
}

/* ──────────────────────────── via drag ──────────────────────────── */

/** Screen-px hit tolerance for picking up a Via to drag. */
const VIA_HIT_PX = 6;

/**
 * Hit-test a Via against the world position. Returns true if the
 * cursor is within the via's annular-ring radius (plus pixel tolerance).
 */
function _hitVia(app, via, worldPos, pxTol = VIA_HIT_PX) {
    const scale = app.viewport?.scale || 1;
    const r = (via.diameter || 0.6) / 2 + pxTol / scale;
    return Math.hypot(via.x - worldPos.x, via.y - worldPos.y) <= r;
}

/**
 * Begin a drag on the given (already-selected) Via if the click landed
 * on it. Captures any Track nodes colocated with the via so they drag
 * along — the via acts as a hinge that connected wires follow.
 */
export function startViaDrag(app, via, worldPos) {
    if (!via || !_hitVia(app, via, worldPos)) return false;
    // Find every Track node at the via's current (x, y). Track endpoints
    // and layer-change nodes commonly sit exactly on a via.
    const EPS = 1e-4;
    const attached = []; // [{track, nodeId, startX, startY}]
    for (const t of app.tracks) {
        for (const [nid, n] of t.nodes) {
            if (Math.abs(n.x - via.x) < EPS && Math.abs(n.y - via.y) < EPS) {
                attached.push({ track: t, nodeId: nid, startX: n.x, startY: n.y });
            }
        }
    }
    app._viaDrag = {
        via,
        startX: via.x,
        startY: via.y,
        attached,
    };
    return true;
}

/** Update the dragged via's position from the current mouse world pos. */
export function updateViaDrag(app, worldPos) {
    const drag = app._viaDrag;
    if (!drag) return;
    const snap = resolveTrackSnap(app, worldPos);
    drag.via.x = snap.x;
    drag.via.y = snap.y;
    renderVia(drag.via, (id) => app._getLayerGroup(id));
    // Drag attached track nodes in lock-step.
    const touched = new Set();
    for (const a of drag.attached) {
        const n = a.track.nodes.get(a.nodeId);
        if (!n) continue;
        n.x = snap.x;
        n.y = snap.y;
        touched.add(a.track);
    }
    for (const t of touched) {
        renderTrack(t, (id) => app._getLayerGroup(id), _opts(app));
    }
    refreshTrackSelectionHalo(app);
}

/**
 * Commit the in-progress via drag. Wraps the via move plus every
 * attached track-node move as a single compound history entry.
 */
export function finishViaDrag(app) {
    const drag = app._viaDrag;
    if (!drag) return;
    app._viaDrag = null;
    const moved = Math.abs(drag.via.x - drag.startX) > 1e-6
        || Math.abs(drag.via.y - drag.startY) > 1e-6;
    if (!moved) {
        // Restore any incidental sub-tolerance drift on track nodes.
        for (const a of drag.attached) {
            const n = a.track.nodes.get(a.nodeId);
            if (n) { n.x = a.startX; n.y = a.startY; }
        }
        return;
    }
    const toX = drag.via.x, toY = drag.via.y;
    // Snap-back the model so commands' execute() re-apply.
    drag.via.x = drag.startX;
    drag.via.y = drag.startY;
    for (const a of drag.attached) {
        const n = a.track.nodes.get(a.nodeId);
        if (n) { n.x = a.startX; n.y = a.startY; }
    }
    const cmds = [new MoveViaCommand(app, drag.via, drag.startX, drag.startY, toX, toY)];
    for (const a of drag.attached) {
        cmds.push(new MoveVertexCommand(app, a.track, a.nodeId, a.startX, a.startY, toX, toY));
    }
    app.history.execute(new CompoundCommand(cmds));
    reconcileRatsnest(app);
}

/** Abort the in-progress via drag and restore the original position. */
export function cancelViaDrag(app) {
    const drag = app._viaDrag;
    if (!drag) return;
    app._viaDrag = null;
    drag.via.x = drag.startX;
    drag.via.y = drag.startY;
    renderVia(drag.via, (id) => app._getLayerGroup(id));
    const touched = new Set();
    for (const a of drag.attached) {
        const n = a.track.nodes.get(a.nodeId);
        if (n) { n.x = a.startX; n.y = a.startY; touched.add(a.track); }
    }
    for (const t of touched) {
        renderTrack(t, (id) => app._getLayerGroup(id), _opts(app));
    }
    refreshTrackSelectionHalo(app);
}
