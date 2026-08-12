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
        if (!adapter.visible || (allowed && !allowed.has(adapter.kind))) continue;
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
    const scale = Math.max(0.01, app.viewport?.scale || 1);
    for (const adapter of getPcbSelectionEntries(app)) {
        if (!adapter.visible || !adapter.getAnchors) continue;
        const group = document.createElementNS(NS, 'g');
        group.setAttribute('class', HANDLE_CLASS);
        group.setAttribute('data-selection-id', adapter.id);
        for (const anchor of adapter.getAnchors()) {
            if (anchor.hidden) continue;
            const isMidpoint = anchor.symbol === 'plus';
            const handleSize = isMidpoint ? 11 / scale : (anchor.sizePx || 8) / scale;
            const half = handleSize / 2;
            const anchorColor = isMidpoint ? '#1565c0' : (anchor.stroke || adapter.anchorColor || '#3399ff');
            const handle = document.createElementNS(NS, anchor.round ? 'circle' : 'rect');
            if (anchor.round) {
                handle.setAttribute('cx', String(anchor.x));
                handle.setAttribute('cy', String(anchor.y));
                handle.setAttribute('r', String(half));
            } else {
                handle.setAttribute('x', String(anchor.x - half));
                handle.setAttribute('y', String(anchor.y - half));
                handle.setAttribute('width', String(handleSize));
                handle.setAttribute('height', String(handleSize));
            }
            handle.setAttribute('fill', anchor.fill || '#ffffff');
            handle.setAttribute('stroke', anchorColor);
            handle.setAttribute('stroke-width', String((anchor.strokeWidthPx || 1) / scale));
            handle.setAttribute('vector-effect', 'non-scaling-stroke');
            handle.setAttribute('data-anchor-id', String(anchorId(anchor)));
            handle.style.cursor = anchor.cursor || 'move';
            group.appendChild(handle);
            if (isMidpoint) {
                const plusSize = half * 1.1;
                for (const [x1, y1, x2, y2] of [
                    [anchor.x - plusSize, anchor.y, anchor.x + plusSize, anchor.y],
                    [anchor.x, anchor.y - plusSize, anchor.x, anchor.y + plusSize],
                ]) {
                    const plus = document.createElementNS(NS, 'line');
                    plus.setAttribute('x1', String(x1));
                    plus.setAttribute('y1', String(y1));
                    plus.setAttribute('x2', String(x2));
                    plus.setAttribute('y2', String(y2));
                    plus.setAttribute('stroke', anchorColor);
                    plus.setAttribute('stroke-width', String(1.5 / scale));
                    plus.setAttribute('stroke-linecap', 'round');
                    plus.setAttribute('pointer-events', 'none');
                    group.appendChild(plus);
                }
            }
        }
        overlay.appendChild(group);
    }
}

/** Remove every adapter-driven anchor overlay. */
export function clearPcbSelectionAnchors(app) {
    app._getLayerGroup?.('selection-overlay')?.querySelectorAll(`.${HANDLE_CLASS}`).forEach((element) => element.remove());
}
