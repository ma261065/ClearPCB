import { beginPcbAnchorInteraction } from './selection-interaction.js';
import { findNearbyPad, resolveGridMagnetSnap, snapNodeToAxis, snapNodeToCollinear } from './track-draw.js';

export function pathMoveInteraction({ segmentAt, selectedSegment, selectSegment, begin, update, end }) {
    let candidate = null;
    let refine = false;
    return {
        getSelectedSegment: selectedSegment,
        beginMove(point, options = {}) {
            candidate = segmentAt(point);
            refine = !!options.alreadySelected;
            return begin(point, candidate != null && candidate === options.selectedSegment ? candidate : null);
        },
        updateMove: update,
        endMove(commit, options = {}) {
            end(commit);
            if (commit && !options.moved && refine && candidate != null) selectSegment(candidate);
        },
    };
}

export function beginPathSplit(app, adapter, anchorId, prepare) {
    const original = adapter.beginAnchorDrag;
    adapter.beginAnchorDrag = (id, point, options) => {
        const started = original(id, point, options);
        if (started) {
            prepare();
            if (adapter.kind === 'shape') {
                app._selectedBoardShapeNode = null;
                app._selectedBoardShapeSegment = null;
            } else if (adapter.kind === 'track') app._trackEdit = null;
        }
        return started;
    };
    const anchor = adapter.getAnchors().find(item => item.id === anchorId);
    return !!anchor && beginPcbAnchorInteraction(app, adapter, anchor, anchor, true);
}

export function snapPathPoint(app, point, neighbours = [], pads = false) {
    if (app.viewport?.shiftHeld) return { x: point.x, y: point.y };
    const threshold = 8 / Math.max(0.01, app.viewport?.scale || 1);
    const pad = pads ? findNearbyPad(app, point, threshold) : null;
    if (pad) return { x: pad.x, y: pad.y };
    const { x, y } = resolveGridMagnetSnap(app, point);
    const grid = { x, y };
    const collinear = snapNodeToCollinear(point, neighbours, threshold);
    if (collinear) {
        if (Math.abs(neighbours[0].x - neighbours[1].x) < 1e-9) return { x: collinear.x, y: grid.y };
        if (Math.abs(neighbours[0].y - neighbours[1].y) < 1e-9) return { x: grid.x, y: collinear.y };
        return collinear;
    }
    return snapNodeToAxis(point, neighbours, threshold, grid);
}

export function snapPathTranslation(app, points, delta, neighbours = [], constraints = []) {
    if (app.viewport?.shiftHeld) return delta;
    const threshold = 8 / Math.max(0.01, app.viewport?.scale || 1);
    let best = null;
    for (const point of points) {
        const target = { x: point.x + delta.x, y: point.y + delta.y };
        const pad = findNearbyPad(app, target, threshold);
        if (!pad) continue;
        const distance = Math.hypot(pad.x - target.x, pad.y - target.y);
        if (!best || distance < best.distance) best = { x: pad.x - point.x, y: pad.y - point.y, distance };
    }
    if (best) return best;
    const anchor = points[0];
    if (!anchor) return delta;
    for (const { index, neighbours: fixed } of constraints) {
        const point = points[index];
        const target = { x: point.x + delta.x, y: point.y + delta.y };
        const collinear = snapNodeToCollinear(target, fixed, threshold);
        const aligned = collinear || snapNodeToAxis(target, fixed, threshold, target);
        const distance = Math.hypot(aligned.x - target.x, aligned.y - target.y);
        const onAxis = fixed.some(neighbour => Math.abs(target.x - neighbour.x) < 1e-9
            || Math.abs(target.y - neighbour.y) < 1e-9
            || Math.abs(Math.abs(target.x - neighbour.x) - Math.abs(target.y - neighbour.y)) < 1e-9);
        if ((collinear || onAxis || distance > 1e-9) && (!best || distance < best.distance)) best = { x: aligned.x - point.x, y: aligned.y - point.y, distance };
    }
    if (best) return best;
    const target = snapPathPoint(app, { x: anchor.x + delta.x, y: anchor.y + delta.y }, neighbours);
    return { x: target.x - anchor.x, y: target.y - anchor.y };
}

export function pathContextActions({ node, segment, curved, split, deleteNode, convert, deleteSegment, deleteObject, label }) {
    if (node) return [
        split && { text: 'Split', onClick: split },
        deleteNode && { text: 'Delete node', onClick: deleteNode },
    ].filter(Boolean);
    return [
        segment && convert && { text: `Convert to ${curved ? 'Line' : 'Arc'} Segment`, onClick: convert },
        segment && deleteSegment && { text: 'Delete segment', onClick: deleteSegment },
        deleteObject && { text: `Delete ${label}`, onClick: deleteObject },
    ].filter(Boolean);
}

export function dismissPathContextMenu(id) {
    const menu = document.getElementById(id);
    if (!menu) return;
    const handlers = menu._dismiss;
    if (handlers) {
        document.removeEventListener('mousedown', handlers.dismiss, { capture: true });
        document.removeEventListener('keydown', handlers.onKey, { capture: true });
    }
    menu.remove();
}

export function showPathContextMenu(id, items, clientX, clientY, refresh = () => {}) {
    dismissPathContextMenu(id);
    if (!items.length) return;
    const menu = document.createElement('div');
    menu.id = id;
    menu.style.cssText = `position:fixed;z-index:10000;background:#2b2b2b;border:1px solid #555;border-radius:4px;padding:2px 0;box-shadow:0 2px 8px rgba(0,0,0,0.4);min-width:120px;left:${clientX}px;top:${clientY}px;`;
    for (const item of items) {
        const element = document.createElement('div');
        element.textContent = item.text;
        element.style.cssText = 'padding:6px 16px;color:#eee;cursor:pointer;font:13px/1.4 system-ui,sans-serif;white-space:nowrap;';
        element.addEventListener('mouseenter', () => { element.style.background = '#3a3a3a'; });
        element.addEventListener('mouseleave', () => { element.style.background = ''; });
        element.addEventListener('click', event => { dismissPathContextMenu(id); item.onClick(event); refresh(); });
        menu.appendChild(element);
    }
    menu.addEventListener('contextmenu', event => event.preventDefault());
    document.body.appendChild(menu);
    const dismiss = event => { if (!menu.contains(event.target)) dismissPathContextMenu(id); };
    const onKey = event => { if (event.key === 'Escape') dismissPathContextMenu(id); };
    setTimeout(() => {
        if (document.getElementById(id) !== menu) return;
        document.addEventListener('mousedown', dismiss, { capture: true });
        document.addEventListener('keydown', onKey, { capture: true });
    }, 0);
    menu._dismiss = { dismiss, onKey };
    return menu;
}