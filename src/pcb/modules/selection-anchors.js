/** Shared adapter-driven anchor rendering and hit testing for PCB selection. */

import { getPcbSelectionEntries } from './selection-registry.js';
import { isRotationHandleDragActive, ROTATION_CURSOR } from './rotation-handle.js';
import { createLockIcon, lockIconMetrics, LOCK_GAP } from '../../core/ui-helpers.js';
import { boundsOutline, lockPositionOutsideOutline } from '../../core/lock-position.js';
import { getLastPointerWorld } from './cursor-state.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */
/** @typedef {{x: number, y: number}} Point */
/** @typedef {import('./selection-registry.js').SelectionAnchor} SelectionAnchor */

export { lockPositionOutsideOutline };

const HANDLE_CLASS = 'pcb-selection-anchors';
const NS = 'http://www.w3.org/2000/svg';
const ROTATION_ICON_URL = new URL('../../../assets/icons/RotateIcon.svg', import.meta.url).href;

/** @param {SelectionAnchor} anchor */
function anchorId(anchor) {
    return anchor.id ?? anchor.key;
}

/** @param {PcbEditor} app */
function anchorSize(app) {
    return 8 / Math.max(0.01, app.viewport?.scale || 1);
}

/**
 * Return the selected adapter anchor under point, or null.
 * @param {PcbEditor} app
 * @param {Point} point
 * @param {Iterable<string>|null} [kinds]
 */
export function hitTestPcbSelectionAnchor(app, point, kinds = null) {
    const allowed = kinds ? new Set(kinds) : null;
    const tolerance = anchorSize(app);
    const selected = getPcbSelectionEntries(app);
    const hideRotation = selected.length > 1 || isRotationHandleDragActive(app);
    for (const adapter of selected) {
        if (!adapter.visible || (allowed && !allowed.has(adapter.kind))) continue;
        for (const anchor of adapter.getAnchors?.() || []) {
            if (anchor.symbol === 'rotate' && hideRotation) continue;
            const hitRadius = Math.max(tolerance, (anchor.sizePx || 8) / (2 * Math.max(0.01, app.viewport?.scale || 1)));
            if (Math.hypot(anchor.x - point.x, anchor.y - point.y) <= hitRadius) {
                return { adapter, anchor, anchorId: anchorId(anchor) };
            }
        }
    }
    return null;
}

/**
 * Rebuild all selected adapter anchor handles at the current viewport scale.
 * @param {PcbEditor} app
 */
export function renderPcbSelectionAnchors(app) {
    clearPcbSelectionAnchors(app);
    const overlay = app.getLayerGroup('selection-overlay');
    if (!overlay) return;
    const size = anchorSize(app);
    const scale = Math.max(0.01, app.viewport?.scale || 1);
    const { size: lockSize } = lockIconMetrics(scale);
    const selected = getPcbSelectionEntries(app);
    const hideRotation = selected.length > 1 || isRotationHandleDragActive(app);
    for (const adapter of selected) {
        if (!adapter.visible) continue;
        if (adapter.locked) {
            const bounds = adapter.getBounds?.();
            if (!bounds) continue;
            const pointerWorld = getLastPointerWorld(app) || { x: bounds.minX, y: bounds.minY };
            const position = adapter.getLockPosition?.(pointerWorld, scale)
                || lockPositionOutsideOutline(boundsOutline(bounds), pointerWorld, scale)
                || {
                    x: bounds.minX - LOCK_GAP - lockSize,
                    y: bounds.minY - LOCK_GAP - lockSize * 0.6,
                };
            const owner = { element: overlay, kind: adapter.kind, object: adapter.object };
            overlay.appendChild(createLockIcon(
                position.x,
                position.y,
                owner,
                'pcb-selection-lock-icon',
                scale,
            ));
            continue;
        }
        if (!adapter.getAnchors) continue;
        const group = document.createElementNS(NS, 'g');
        group.setAttribute('class', HANDLE_CLASS);
        group.setAttribute('data-selection-id', adapter.id);
        const editPath = adapter.getEditPath?.();
        if (editPath) {
            const path = document.createElementNS(NS, 'path');
            path.setAttribute('d', editPath);
            path.setAttribute('fill', 'none');
            path.setAttribute('stroke', adapter.anchorColor || '#ffffff');
            path.setAttribute('stroke-width', '1');
            path.setAttribute('vector-effect', 'non-scaling-stroke');
            path.setAttribute('pointer-events', 'none');
            group.appendChild(path);
        }
        for (const anchor of adapter.getAnchors()) {
            if (anchor.hidden || (anchor.symbol === 'rotate' && hideRotation)) continue;
            const isMidpoint = anchor.symbol === 'plus';
            const isRotation = anchor.symbol === 'rotate';
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
            handle.setAttribute('stroke-width', String(anchor.strokeWidthPx || 1));
            handle.setAttribute('vector-effect', 'non-scaling-stroke');
            handle.setAttribute('data-anchor-id', String(anchorId(anchor)));
            handle.style.cursor = isRotationHandleDragActive(app) ? ROTATION_CURSOR : (anchor.cursor || 'move');
            if (isRotation) {
                const title = document.createElementNS(NS, 'title');
                title.textContent = 'Rotate';
                handle.appendChild(title);
                handle.setAttribute('aria-label', 'Rotate');
            }
            group.appendChild(handle);
            if (anchor.selected) {
                const ring = document.createElementNS(NS, 'circle');
                ring.setAttribute('class', 'pcb-node-selection-ring');
                ring.setAttribute('cx', String(anchor.x));
                ring.setAttribute('cy', String(anchor.y));
                ring.setAttribute('r', String(half + 4 / scale));
                ring.setAttribute('fill', 'none');
                ring.setAttribute('stroke', '#3399ff');
                ring.setAttribute('stroke-width', '2');
                ring.setAttribute('vector-effect', 'non-scaling-stroke');
                ring.setAttribute('pointer-events', 'none');
                group.appendChild(ring);
            }
            if (isRotation) {
                const icon = document.createElementNS(NS, 'image');
                icon.setAttribute('href', ROTATION_ICON_URL);
                icon.setAttribute('x', '-9');
                icon.setAttribute('y', '-9');
                icon.setAttribute('width', '18');
                icon.setAttribute('height', '18');
                icon.setAttribute('transform', `translate(${anchor.x} ${anchor.y}) scale(${1 / scale})`);
                icon.setAttribute('pointer-events', 'none');
                group.appendChild(icon);
            }
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

/**
 * Remove every adapter-driven anchor overlay.
 * @param {PcbEditor} app
 */
export function clearPcbSelectionAnchors(app) {
    const overlay = app.getLayerGroup('selection-overlay');
    overlay?.querySelectorAll(`.${HANDLE_CLASS}`).forEach((element) => element.remove());
    overlay?.querySelectorAll('.pcb-selection-lock-icon').forEach((element) => element.remove());
}
