/** Shared adapter-driven anchor rendering and hit testing for PCB selection. */

import { getPcbSelectionEntries } from './selection-registry.js';

const HANDLE_CLASS = 'pcb-selection-anchors';
const NS = 'http://www.w3.org/2000/svg';

function anchorId(anchor) {
    return anchor.id ?? anchor.key;
}

function anchorSize(app) {
    return 8 / Math.max(0.01, app.viewport?.scale || 1);
}

/** Return the selected adapter anchor under point, or null. */
export function hitTestPcbSelectionAnchor(app, point, kinds = null) {
    const allowed = kinds ? new Set(kinds) : null;
    const tolerance = anchorSize(app);
    for (const adapter of getPcbSelectionEntries(app)) {
        if (allowed && !allowed.has(adapter.kind)) continue;
        for (const anchor of adapter.getAnchors?.() || []) {
            if (Math.hypot(anchor.x - point.x, anchor.y - point.y) <= tolerance) {
                return { adapter, anchor, anchorId: anchorId(anchor) };
            }
        }
    }
    return null;
}

/** Rebuild all selected adapter anchor handles at the current viewport scale. */
export function renderPcbSelectionAnchors(app) {
    clearPcbSelectionAnchors(app);
    const overlay = app._getLayerGroup?.('selection-overlay');
    if (!overlay) return;
    const size = anchorSize(app);
    const half = size / 2;
    for (const adapter of getPcbSelectionEntries(app)) {
        if (!adapter.visible || !adapter.getAnchors) continue;
        const group = document.createElementNS(NS, 'g');
        group.setAttribute('class', HANDLE_CLASS);
        group.setAttribute('data-selection-id', adapter.id);
        for (const anchor of adapter.getAnchors()) {
            if (anchor.hidden) continue;
            const handle = document.createElementNS(NS, anchor.round ? 'circle' : 'rect');
            if (anchor.round) {
                handle.setAttribute('cx', String(anchor.x));
                handle.setAttribute('cy', String(anchor.y));
                handle.setAttribute('r', String(size / 2));
            } else {
                handle.setAttribute('x', String(anchor.x - half));
                handle.setAttribute('y', String(anchor.y - half));
                handle.setAttribute('width', String(size));
                handle.setAttribute('height', String(size));
            }
            handle.setAttribute('fill', anchor.fill || '#ffffff');
            handle.setAttribute('stroke', anchor.stroke || adapter.anchorColor || '#3399ff');
            handle.setAttribute('stroke-width', String(1 / Math.max(0.01, app.viewport?.scale || 1)));
            handle.setAttribute('vector-effect', 'non-scaling-stroke');
            handle.setAttribute('data-anchor-id', String(anchorId(anchor)));
            handle.style.cursor = anchor.cursor || 'move';
            group.appendChild(handle);
        }
        overlay.appendChild(group);
    }
}

/** Remove every adapter-driven anchor overlay. */
export function clearPcbSelectionAnchors(app) {
    app._getLayerGroup?.('selection-overlay')?.querySelectorAll(`.${HANDLE_CLASS}`).forEach((element) => element.remove());
}
