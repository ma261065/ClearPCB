import { isLayerLocked, isLayerVisible } from './layers.js';
import { SetBoardOutlineCommand } from './track-commands.js';

export function boardOutlineHandles(app) {
    if (!app._boardOutlineSelected || !app._boardOutlineDrawn
        || isLayerLocked('board-outline') || !isLayerVisible('board-outline')) return [];
    const width = app._boardWidth;
    const height = app._boardHeight;
    return [
        { id: 'height', x: width / 2, y: -height, cursor: 'ns-resize' },
        { id: 'width', x: width, y: -height / 2, cursor: 'ew-resize' },
        { id: 'both', x: width, y: -height, cursor: 'nesw-resize' },
    ];
}

export function renderBoardOutlineHandles(app) {
    const overlay = app._getLayerGroup?.('selection-overlay');
    if (!overlay) return;
    overlay.querySelectorAll('.pcb-board-outline-handles').forEach(element => element.remove());
    const handles = boardOutlineHandles(app);
    if (!handles.length) return;
    const size = 8 / Math.max(0.01, app.viewport?.scale || 1);
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    group.setAttribute('class', 'pcb-board-outline-handles');
    for (const handle of handles) {
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', String(handle.x - size / 2));
        rect.setAttribute('y', String(handle.y - size / 2));
        rect.setAttribute('width', String(size));
        rect.setAttribute('height', String(size));
        rect.setAttribute('fill', '#ffffff');
        rect.setAttribute('stroke', '#3399ff');
        rect.setAttribute('stroke-width', '1');
        rect.setAttribute('vector-effect', 'non-scaling-stroke');
        rect.style.cursor = handle.cursor;
        group.appendChild(rect);
    }
    overlay.appendChild(group);
}

export function hitTestBoardOutlineHandle(app, point) {
    const tolerance = 8 / Math.max(0.01, app.viewport?.scale || 1);
    return boardOutlineHandles(app).find(handle => Math.hypot(handle.x - point.x, handle.y - point.y) <= tolerance) || null;
}

export function beginBoardOutlineResize(app, point) {
    const handle = hitTestBoardOutlineHandle(app, point);
    if (!handle) return false;
    app._boardOutlineResize = {
        handle: handle.id, start: { ...point },
        before: { width: app._boardWidth, height: app._boardHeight, radius: app._boardRadius },
        previousSuspend: !!app._suspendBoardViewRefresh,
    };
    app._suspendBoardViewRefresh = true;
    return true;
}

export function updateBoardOutlineResize(app, point) {
    const drag = app._boardOutlineResize;
    if (!drag) return;
    if (isLayerLocked('board-outline') || !isLayerVisible('board-outline')) {
        endBoardOutlineResize(app, false);
        return;
    }
    const grid = app.viewport?.snapToGrid ? app.viewport.gridSize : 0;
    const snap = value => grid > 0 ? Math.round(value / grid) * grid : value;
    const width = drag.handle === 'height' ? drag.before.width
        : Math.max(5, drag.before.width + snap(point.x - drag.start.x));
    const height = drag.handle === 'width' ? drag.before.height
        : Math.max(5, drag.before.height - snap(point.y - drag.start.y));
    if (width === app._boardWidth && height === app._boardHeight) return;
    app._boardWidth = width;
    app._boardHeight = height;
    app._drawBoardOutline();
    for (const [id, value] of [['pcbPropBoardW', width], ['pcbPropBoardH', height]]) {
        const input = /** @type {HTMLInputElement|null} */ (document.getElementById(id));
        if (input) input.value = Number(value).toFixed(2);
    }
}

export function endBoardOutlineResize(app, commit = true) {
    const drag = app._boardOutlineResize;
    if (!drag) return;
    app._boardOutlineResize = null;
    app._suspendBoardViewRefresh = drag.previousSuspend;
    const after = { width: app._boardWidth, height: app._boardHeight, radius: app._boardRadius };
    const changed = after.width !== drag.before.width || after.height !== drag.before.height;
    if (!commit) {
        app._boardWidth = drag.before.width;
        app._boardHeight = drag.before.height;
        app._boardRadius = drag.before.radius;
        app._drawBoardOutline();
    } else if (changed) {
        app.history.execute(new SetBoardOutlineCommand(app, drag.before, after));
        app._refreshFills?.();
    }
    app._showBoardOutlineProperties?.();
    app._board3d?.refresh?.();
}