/**
 * Interactive copper-fill region drawing for the PCB editor.
 *
 * Mirrors the Track drawing flow but produces a simple closed polygon
 * (the pour region). The committed region is wrapped in a CopperFill and
 * added to the canonical app.boardShapes collection via AddFillCommand; the actual poured
 * copper geometry is then computed live by the fill engine.
 *
 * Lifecycle (driven from PCBApp mouse/key handlers):
 *   1. tool = 'fill'
 *   2. first mousedown          → startFillDraw(app, world)
 *   3. mousemove                → updateFillDraw(app, world)   (rubber band)
 *   4. mousedown                → addFillWaypoint(app, world)
 *      Clicking near the first vertex (with ≥3 points) closes the region.
 *   5. double-click / Enter / right-click → finishFillDraw(app)
 *   6. Escape / tool-switch     → cancelFillDraw(app)
 */

import { CopperFill } from '../../shapes/copper-fill.js';
import { AddFillCommand } from './copper-fill-commands.js';
import { setPcbSelection } from './selection-registry.js';

const NS = 'http://www.w3.org/2000/svg';
const PREVIEW_CLASS = 'pcb-fill-preview';

/** Close-snap radius (world mm) for landing back on the first vertex. */
const CLOSE_TOL = 0.6;

function copperLayer(app) {
    return app._fillToolLayer === 'bottom-copper' ? 'bottom-copper' : 'top-copper';
}

function snap(app, world) {
    return app._snapToGrid ? app._snapToGrid(world) : { x: world.x, y: world.y };
}

/** Begin a new fill region at `world`. */
export function startFillDraw(app, world) {
    const p = snap(app, world);
    app._fillDraw = {
        points: [{ x: p.x, y: p.y }],
        layer: copperLayer(app),
        snap: { x: p.x, y: p.y },
    };
    renderPreview(app);
}

/** Add a waypoint; closing automatically when near the first vertex. */
export function addFillWaypoint(app, world) {
    const fd = app._fillDraw;
    if (!fd) return;
    const p = snap(app, world);
    // Close on click near the first vertex (need a real polygon first).
    if (fd.points.length >= 3) {
        const first = fd.points[0];
        if (Math.hypot(p.x - first.x, p.y - first.y) <= CLOSE_TOL) {
            finishFillDraw(app);
            return;
        }
    }
    // Ignore zero-length repeats.
    const last = fd.points[fd.points.length - 1];
    if (Math.hypot(p.x - last.x, p.y - last.y) < 1e-6) return;
    fd.points.push({ x: p.x, y: p.y });
    fd.snap = { x: p.x, y: p.y };
    renderPreview(app);
}

/** Update the rubber-band preview as the cursor moves. */
export function updateFillDraw(app, world) {
    const fd = app._fillDraw;
    if (!fd) return;
    const p = snap(app, world);
    fd.snap = { x: p.x, y: p.y };
    renderPreview(app);
}

/** Commit the region (≥3 points) as a CopperFill, else cancel. */
export function finishFillDraw(app) {
    const fd = app._fillDraw;
    if (!fd) return;
    clearPreview(app);
    app._fillDraw = null;
    if (fd.points.length < 3) return;
    const fill = new CopperFill({
        layer: fd.layer,
        net: '',
        outline: fd.points,
    });
    app.history.execute(new AddFillCommand(app, fill));
    // Select the new fill so the user can assign a net immediately.
    setPcbSelection(app, [{ kind: 'fill', object: fill }]);
    app._selectFill?.(fill);
    app._showFillProperties?.(fill);
}

/** Abort the in-progress region without committing. */
export function cancelFillDraw(app) {
    if (!app._fillDraw) return;
    clearPreview(app);
    app._fillDraw = null;
}

/* ───────────────────────────── preview ───────────────────────────── */

function previewGroup(app) {
    return app._getLayerGroup('selection-overlay');
}

function clearPreview(app) {
    const g = previewGroup(app);
    if (!g) return;
    for (const el of [...g.querySelectorAll(`.${PREVIEW_CLASS}`)]) el.remove();
}

function renderPreview(app) {
    clearPreview(app);
    const fd = app._fillDraw;
    if (!fd) return;
    const g = previewGroup(app);
    if (!g) return;
    const color = fd.layer === 'bottom-copper' ? '#3498db' : '#e74c3c';

    const pts = fd.points.slice();
    const cursor = fd.snap;
    const draft = cursor ? [...pts, cursor] : pts;

    // Closed preview polygon (filled faintly) once we have ≥3 points.
    if (draft.length >= 3) {
        const poly = document.createElementNS(NS, 'polygon');
        poly.setAttribute('class', PREVIEW_CLASS);
        poly.setAttribute('points', draft.map((p) => `${p.x},${p.y}`).join(' '));
        poly.setAttribute('fill', color);
        poly.setAttribute('fill-opacity', '0.15');
        poly.setAttribute('stroke', color);
        poly.setAttribute('stroke-width', '0.12');
        poly.setAttribute('stroke-dasharray', '0.6,0.4');
        g.appendChild(poly);
    } else if (draft.length === 2) {
        const line = document.createElementNS(NS, 'line');
        line.setAttribute('class', PREVIEW_CLASS);
        line.setAttribute('x1', draft[0].x);
        line.setAttribute('y1', draft[0].y);
        line.setAttribute('x2', draft[1].x);
        line.setAttribute('y2', draft[1].y);
        line.setAttribute('stroke', color);
        line.setAttribute('stroke-width', '0.12');
        line.setAttribute('stroke-dasharray', '0.6,0.4');
        g.appendChild(line);
    }

    // Vertex dots.
    for (const p of pts) {
        const dot = document.createElementNS(NS, 'circle');
        dot.setAttribute('class', PREVIEW_CLASS);
        dot.setAttribute('cx', p.x);
        dot.setAttribute('cy', p.y);
        dot.setAttribute('r', '0.18');
        dot.setAttribute('fill', color);
        g.appendChild(dot);
    }
}
