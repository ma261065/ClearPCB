import { beginPcbAnchorInteraction } from './selection-interaction.js';
import { findNearbyPad, resolveGridMagnetSnap } from './track-draw.js';
import { resolvePathPoint, resolvePathTranslation } from '../../shapes/path-snap.js';
export { pathMoveInteraction } from '../../shapes/path-interaction.js';

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

export function snapPathPoint(app, point, neighbours = [], pads = false, continuations = []) {
    if (app.viewport?.shiftHeld) return { x: point.x, y: point.y };
    const threshold = 8 / Math.max(0.01, app.viewport?.scale || 1);
    const pad = pads ? findNearbyPad(app, point, threshold) : null;
    if (pad) return { x: pad.x, y: pad.y };
    const { x, y } = resolveGridMagnetSnap(app, point);
    const grid = { x, y };
    return resolvePathPoint(point, neighbours, grid, threshold, null, continuations);
}

export function snapPathTranslation(app, points, delta, neighbours = [], constraints = []) {
    if (app.viewport?.shiftHeld) return delta;
    const threshold = 8 / Math.max(0.01, app.viewport?.scale || 1);
    return resolvePathTranslation(points, delta, neighbours, constraints, threshold,
        (point, tolerance) => findNearbyPad(app, point, tolerance),
        (point, fixed) => snapPathPoint(app, point, fixed));
}

export function pathContextActions({ node, segment, curved, standalone = false, split, deleteNode, convert, deleteSegment, deleteObject, label }) {
    if (node) return [
        split && { text: 'Split', onClick: split },
        deleteNode && { text: 'Delete node', onClick: deleteNode },
    ].filter(Boolean);
    return [
        segment && convert && { text: `Convert to ${curved ? 'Line' : 'Arc'}${standalone ? '' : ' Segment'}`, onClick: convert },
        segment && !standalone && deleteSegment && { text: 'Delete segment', onClick: deleteSegment },
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