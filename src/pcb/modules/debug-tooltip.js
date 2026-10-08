/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */
/*
 * The footprint debug tooltip: when "Show footprint shape data" (Help tab) is on, hovering
 * near a component's pads shows its raw footprint shape strings. A stationary right-click
 * pins the tooltip in place; a second one (or its close button) hides it. Its element and
 * visibility are owned here, per editor.
 */

const tooltipStates = new WeakMap();

/** @param {PcbEditor} app */
function tooltipState(app) {
    let state = tooltipStates.get(app);
    if (!state) tooltipStates.set(app, state = { element: null, enabled: false, visible: false, pinned: false });
    return state;
}

/**
 * The tooltip's element and flags, for tests.
 * @param {PcbEditor} app
 */
export function debugTooltipState(app) {
    return tooltipState(app);
}

function hide(state) {
    if (state.element) state.element.style.display = 'none';
    state.visible = false;
}

/**
 * Create the tooltip element (reusing the schematic's CSS classes) and bind its checkbox.
 * @param {PcbEditor} app
 */
export function initDebugTooltip(app) {
    const state = tooltipState(app);
    if (state.element) return;
    const el = document.createElement('div');
    el.className = 'component-code-tooltip';
    el.style.display = 'none';
    el.innerHTML = `
        <div class="component-code-tooltip-title">Footprint Shapes</div>
        <button class="component-code-tooltip-close" title="Close">×</button>
        <textarea class="component-code-tooltip-text" readonly></textarea>
    `;
    el.addEventListener('click', (e) => {
        if (e.target instanceof Element && e.target.classList.contains('component-code-tooltip-close')) {
            hide(state);
            state.pinned = false;
        }
    });
    document.body.appendChild(el);
    state.element = el;

    const cb = document.getElementById('pcbDebugTooltip');
    cb?.addEventListener('change', (e) => {
        state.enabled = /** @type {HTMLInputElement} */ (e.target).checked;
        if (!state.enabled) hide(state);
    });
}

/**
 * A right-button press over the visible tooltip pins it, or hides a pinned one.
 * @param {PcbEditor} app
 * @returns {boolean} Whether the press was consumed.
 */
export function toggleDebugTooltipPin(app) {
    const state = tooltipStates.get(app);
    if (!state?.enabled || !state.visible) return false;
    if (state.pinned) {
        state.pinned = false;
        hide(state);
    } else {
        state.pinned = true;
    }
    return true;
}

/**
 * Show/hide the debug tooltip based on mouse position over a footprint.
 * @param {PcbEditor} app
 * @param {MouseEvent} e
 */
export function updateDebugTooltip(app, e) {
    const state = tooltipStates.get(app);
    if (!state?.enabled) return;
    if (state.pinned) return;  // Don't move while pinned
    const tooltip = state.element;

    const rect = app.viewport.svg.getBoundingClientRect();
    const worldPos = app.viewport.screenToWorld({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top
    });
    if (!worldPos) return;

    // Find the closest component placement
    let closest = null;
    let closestDist = 15; // mm tolerance
    for (const [compId, pl] of app.placements) {
        for (const [, pad] of pl.pads) {
            const d = Math.hypot(pad.x - worldPos.x, pad.y - worldPos.y);
            if (d < closestDist) {
                closestDist = d;
                closest = compId;
            }
        }
    }

    if (!closest) {
        if (state.visible) hide(state);
        return;
    }

    const shapes = app.project?.getComponentInfo(closest)?.footprintShapes;
    if (!Array.isArray(shapes) || shapes.length === 0) return;

    const textEl = /** @type {HTMLTextAreaElement|null} */ (
        tooltip.querySelector('.component-code-tooltip-text')
    );
    if (textEl && tooltip.dataset.compId !== closest) {
        textEl.value = shapes
            .filter(s => typeof s === 'string')
            .join('\n');
        tooltip.dataset.compId = closest;
    }

    const pad = 12;
    const maxX = window.innerWidth - tooltip.offsetWidth - pad;
    const maxY = window.innerHeight - tooltip.offsetHeight - pad;
    tooltip.style.left = `${Math.min(e.clientX + pad, Math.max(pad, maxX))}px`;
    tooltip.style.top = `${Math.min(e.clientY + pad, Math.max(pad, maxY))}px`;
    tooltip.style.display = 'block';
    state.visible = true;
}
