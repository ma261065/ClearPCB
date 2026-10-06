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

import { STATE_TABLE, clearPendingShapeSegmentToggle, getEventPositions, hasPendingShapeSegmentToggle, resolveState } from './draw-states.js';
import { DRAWING_SHAPES } from '../../shapes/shape-drawing.js';
import { snapShapeDrawingPoint } from './shape-snap.js';

export { clearDragState } from './drag.js';

const RIGHT_CLICK_THRESHOLD = 3;
const mouseState = new WeakMap();

function stateFor(app) {
    let state = mouseState.get(app);
    if (!state) {
        state = { rightClickStart: null, rightPanGesture: false };
        mouseState.set(app, state);
    }
    return state;
}

function dispatch(app, eventName, event, positions) {
    if (DRAWING_SHAPES.has(app.currentTool)) positions.snapped = snapShapeDrawingPoint(app, positions.worldPos);
    if (!app.interactionState || !STATE_TABLE[app.interactionState]) {
        app.interactionState = resolveState(app);
    }
    const handler = STATE_TABLE[app.interactionState]?.[eventName];
    if (handler) handler(app, event, positions);
}

export function bindMouseEvents(app) {
    const svg = app.viewport.svg;
    app.interactionState = resolveState(app);
    let segmentClickHandled = false;

    // mousedown
    svg.addEventListener('mousedown', (e) => {
        app.viewport.onInteractionStart?.('pointer');
        if (e.button === 0) {
            segmentClickHandled = false;
            clearPendingShapeSegmentToggle(app);
        }
        if (e.button === 2) {
            const state = stateFor(app);
            app.viewport.startPan(e.clientX, e.clientY);
            state.rightClickStart = { x: e.clientX, y: e.clientY };
            // Mark this gesture so the contextmenu it generates is suppressed
            // even if the button is released outside the canvas (over other
            // page chrome), where the svg-scoped handler below never fires.
            state.rightPanGesture = true;
            return;
        }
        const positions = getEventPositions(e, app.viewport);
        // Lock icons sit beside the part of a locked object nearest this press.
        if (app.selection) app.selection.lockPointer = { x: positions.worldPos.x, y: positions.worldPos.y };
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
            const state = stateFor(app);
            const start = state.rightClickStart;
            state.rightClickStart = null;
            if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) <= RIGHT_CLICK_THRESHOLD) {
                const positions = getEventPositions(e, app.viewport);
                dispatch(app, 'rightclick', e, positions);
            }
            return;
        }
        const positions = getEventPositions(e, app.viewport);
        dispatch(app, 'mouseup', e, positions);
        if (e.button === 0 && app.interactionState === 'idle' && !app.didDrag && !app.skipClickSelection
            && hasPendingShapeSegmentToggle(app)) {
            dispatch(app, 'click', e, positions);
            segmentClickHandled = true;
        }
    });

    // contextmenu  just suppress the browser menu
    svg.addEventListener('contextmenu', (e) => {
        e.preventDefault();
    });

    // A right-button pan can be released outside the canvas (over other page
    // chrome). The browser then fires `contextmenu` on that element, not the
    // svg, showing the default page menu. Suppress it at the window level for
    // any gesture that began as a right-button pan on the canvas.
    window.addEventListener('contextmenu', (e) => {
        const state = stateFor(app);
        if (state.rightPanGesture) {
            state.rightPanGesture = false;
            e.preventDefault();
        }
    }, true);

    // click
    svg.addEventListener('click', (e) => {
        if (segmentClickHandled) {
            segmentClickHandled = false;
            return;
        }
        const positions = getEventPositions(e, app.viewport);
        dispatch(app, 'click', e, positions);
    });

    // dblclick
    svg.addEventListener('dblclick', (e) => {
        const positions = getEventPositions(e, app.viewport);
        dispatch(app, 'dblclick', e, positions);
    });
}
