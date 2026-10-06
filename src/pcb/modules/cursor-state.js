import { resolveTrackSnap } from './track-draw.js';
import { getVertexDrag } from './track-drag.js';

const cursorState = new WeakMap();

function stateFor(app) {
    let state = cursorState.get(app);
    if (!state) {
        state = {};
        cursorState.set(app, state);
    }
    return state;
}

export function setLastPointerWorld(app, worldPos) {
    stateFor(app).lastPointerWorld = worldPos;
}

export function getLastPointerWorld(app) {
    return stateFor(app).lastPointerWorld;
}

export function getLastCrosshairWorld(app) {
    return stateFor(app).lastCrosshairWorld;
}

/**
 * Show/update the drawing crosshair at the snapped cursor position.
 * Delegates the actual H+V lines to the shared Viewport crosshair so
 * schematic and PCB behave identically (and clear of the rulers).
 */
export function updateCursorCrosshair(app, worldPos) {
    if (!app.viewport) return;
    const snap = app.currentTool === 'text'
        ? app.snapToGrid(worldPos) : resolveTrackSnap(app, worldPos, {});
    stateFor(app).lastCrosshairWorld = { x: worldPos.x, y: worldPos.y };
    app.viewport.setCrosshair({ x: snap.x, y: snap.y });
}

export function clearCursorCrosshair(app) {
    app.viewport?.hideCrosshair();
    stateFor(app).lastCrosshairWorld = null;
}

/**
 * Show/update the drawing crosshair at the position of the node being
 * dragged (single-node and plus-in-circle insertion drags). The node's
 * position has already been resolved by updateVertexDrag (grid / pad /
 * axis snap), so the crosshair lands exactly where the node will drop.
 * No-op for segment drags (two moving nodes, no single point).
 */
export function updateVertexDragCrosshair(app) {
    const drag = getVertexDrag(app);
    if (!drag || drag.mode !== 'node' || !app.viewport) return;
    const nd = drag.nodes?.[0];
    const n = nd && drag.track?.nodes?.get(nd.nodeId);
    if (n) app.viewport.setCrosshair({ x: n.x, y: n.y });
}
