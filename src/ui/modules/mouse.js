/**
 * Mouse event binding and state-machine dispatcher.
 *
 * ALL mouse interaction is routed through this file.  Viewport exposes
 * startPan/updatePan/endPan methods; there are no competing handlers.
 *
 * Right-click flow (browser order: mousedown -> mouseup -> contextmenu):
 *   mousedown button=2  -> start pan + record position
 *   mousemove           -> update pan if active
 *   mouseup button=2    -> end pan; if no movement, dispatch 'rightclick'
 *   contextmenu         -> just preventDefault (suppress browser menu)
 */

import { STATE_TABLE, getEventPositions, resolveState } from './mouse-states.js';

export { clearDragState } from './drag.js';

const RIGHT_CLICK_THRESHOLD = 3;

function dispatch(app, eventName, event, positions) {
    if (!app.interactionState || !STATE_TABLE[app.interactionState]) {
        const resolved = resolveState(app);
        console.warn('[mouse] auto-resolved state to', resolved);
        app.interactionState = resolved;
    }
    const handler = STATE_TABLE[app.interactionState]?.[eventName];
    if (handler) handler(app, event, positions);
}

export function bindMouseEvents(app) {
    const svg = app.viewport.svg;
    app.interactionState = resolveState(app);

    // mousedown
    svg.addEventListener('mousedown', (e) => {
        if (e.button === 2) {
            app.viewport.startPan(e.clientX, e.clientY);
            app._rightClickStart = { x: e.clientX, y: e.clientY };
            return;
        }
        const positions = getEventPositions(e, app.viewport);
        dispatch(app, 'mousedown', e, positions);
    });

    // mousemove
    svg.addEventListener('mousemove', (e) => {
        app.viewport.trackMouse(e);
        if (app.viewport.isPanning) {
            app.viewport.updatePan(e.clientX, e.clientY);
        }
        const positions = getEventPositions(e, app.viewport);
        dispatch(app, 'mousemove', e, positions);
    });

    // mouseup  ALL buttons, on window
    window.addEventListener('mouseup', (e) => {
        if (e.button === 2) {
            app.viewport.endPan();
            const start = app._rightClickStart;
            app._rightClickStart = null;
            if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) <= RIGHT_CLICK_THRESHOLD) {
                const positions = getEventPositions(e, app.viewport);
                dispatch(app, 'rightclick', e, positions);
            }
            return;
        }
        const positions = getEventPositions(e, app.viewport);
        dispatch(app, 'mouseup', e, positions);
    });

    // contextmenu  just suppress the browser menu
    svg.addEventListener('contextmenu', (e) => {
        e.preventDefault();
    });

    // click
    svg.addEventListener('click', (e) => {
        const positions = getEventPositions(e, app.viewport);
        dispatch(app, 'click', e, positions);
    });

    // dblclick
    svg.addEventListener('dblclick', (e) => {
        const positions = getEventPositions(e, app.viewport);
        dispatch(app, 'dblclick', e, positions);
    });
}
