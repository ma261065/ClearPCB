import { isLayerLocked, isLayerVisible, setPcbLayerLocked } from './layers.js';
import { showBoardShapeProperties } from './board-shape-properties.js';
import { SetBoardOutlineCommand } from './track-commands.js';
import { snapToViewportGrid } from '../../core/grid-snap.js';
import { getBoardOutline, rectangleBoardOutline, boardDimensions } from '../../shared/pcb/board-outline.js';
import { removeBoardShapeElement } from './board-shapes.js';
import { getPropertyEditor, releasePropertyEditor, setPropertyEditor } from './property-editors.js';
import { areDragOverlaysDeferred, isBoardViewRefreshSuspended, setBoardViewRefreshSuspended, setDragOverlaysDeferred, refreshBoardView } from './refresh-state.js';

const dimensionPreviews = new WeakMap();

export function getBoardDimensionPreview(app) {
    return dimensionPreviews.get(app);
}

/** Properties for the board outline: the outline shape's panel, or board size fields before one exists. */
export function showBoardOutlineProperties(app) {
    getPropertyEditor(app, 'boardDimension')?.dispose();
    const outline = getBoardOutline(app);
    if (outline) {
        showBoardShapeProperties(app, outline);
        return;
    }
    const items = app.propertiesItems();
    if (!items) return;
    app.setPropertiesTitle('Board Outline');
    const board = getBoardDimensionPreview(app)?.board ?? app.pcbDocument.board;
    items.innerHTML = `
        <label class="prop-row prop-toggle" data-prop="locked"><input type="checkbox" id="pcbPropOutlineLocked"${isLayerLocked('board-outline') ? ' checked' : ''}><span>Locked</span></label>
        <div class="prop-row" data-prop="width"><label>Width (mm)</label><input type="number" id="pcbPropBoardW" value="${Number(board.width).toFixed(2)}" min="5" step="1"></div>
        <div class="prop-row" data-prop="height"><label>Height (mm)</label><input type="number" id="pcbPropBoardH" value="${Number(board.height).toFixed(2)}" min="5" step="1"></div>
        <div class="prop-row" data-prop="cornerRadius"><label>Corner Radius (mm)</label><input type="number" id="pcbPropBoardR" value="${Number(board.radius).toFixed(2)}" min="0" step="0.5"></div>
    `;
    const lockedEl = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropOutlineLocked'));
    lockedEl?.addEventListener('change', () => {
        setPcbLayerLocked(app, 'board-outline', lockedEl.checked);
    });
    bindBoardDimensionProperties(app, items);
    app.showPropertiesTab?.();
}

export function previewBoardDimensions(app, dimensions) {
    if (!['width', 'height', 'radius'].every(key => Number.isFinite(dimensions[key]))) throw new Error('Board dimensions must be finite.');
    if (dimensions.width <= 0 || dimensions.height <= 0 || dimensions.radius < 0) {
        throw new Error('Board dimensions must be positive with a nonnegative radius.');
    }
    const current = getBoardDimensionPreview(app)?.board || app.pcbDocument.board;
    if (['width', 'height', 'radius'].every(key => dimensions[key] === current[key])) return false;
    let preview = dimensionPreviews.get(app);
    if (!preview) {
        const model = app.pcbDocument, original = getBoardOutline(model);
        const outline = rectangleBoardOutline(current.width, current.height, current.radius);
        if (original) outline.id = original.id;
        preview = {
            model, original, originalBoard: model.board, before: { ...model.board }, board: { ...model.board }, outline,
            boardShapes: original ? model.boardShapes.map(shape => shape === original ? outline : shape)
                : [...model.boardShapes, outline],
            previousSuspend: !!isBoardViewRefreshSuspended(app), previousDefer: !!areDragOverlaysDeferred(app),
            wasDrawn: app._boardOutlineDrawn,
        };
        dimensionPreviews.set(app, preview);
        setBoardViewRefreshSuspended(app, true);
        setDragOverlaysDeferred(app, true);
    }
    Object.assign(preview.board, dimensions);
    const { width, height, radius } = dimensions;
    preview.outline.cornerRadius = radius;
    for (const [index, point] of preview.outline.points.entries()) {
        point.x = index === 1 || index === 2 ? width : 0;
        point.y = index < 2 ? -height : 0;
    }
    try {
        app._drawBoardOutline();
        renderBoardOutlineHandles(app);
    } catch (error) {
        finishBoardDimensionPreview(app);
        throw error;
    }
    return true;
}

export function finishBoardDimensionPreview(app, commit = false) {
    const preview = dimensionPreviews.get(app);
    if (!preview) return;
    dimensionPreviews.delete(app);
    app._boardOutlineDrawn = preview.wasDrawn;
    let committed = false;
    try {
        if (commit && !isLayerLocked('board-outline') && isLayerVisible('board-outline')) {
            if (app.pcbDocument !== preview.model || app.pcbDocument.board !== preview.originalBoard
                || getBoardOutline(app.pcbDocument) !== preview.original) {
                throw new Error('The board outline is no longer available.');
            }
            if (['width', 'height', 'radius'].some(key => preview.before[key] !== preview.board[key])) {
                setDragOverlaysDeferred(app, preview.previousDefer);
                app.history.execute(new SetBoardOutlineCommand(app, preview.before, preview.board));
                committed = true;
            }
        }
    } finally {
        try {
            if (!committed) {
                removeBoardShapeElement(app, preview.outline.id, { preserveInteraction: true, skipHatchUpdate: true });
                app._drawBoardOutline();
            }
        } finally {
            setBoardViewRefreshSuspended(app, preview.previousSuspend);
            setDragOverlaysDeferred(app, preview.previousDefer);
            renderBoardOutlineHandles(app);
        }
    }
    if (committed && !isBoardViewRefreshSuspended(app)) refreshBoardView(app);
}

export function bindBoardDimensionProperties(app, items) {
    let disposed = false;
    const fields = [['pcbPropBoardW', 'width', 5], ['pcbPropBoardH', 'height', 5], ['pcbPropBoardR', 'radius', 0]];
    const inputs = fields.map(([id, key, minimum]) => ({ input: items.querySelector('#' + id), key, minimum, displayed: '' }));
    const remember = () => { for (const entry of inputs) if (entry.input) entry.displayed = entry.input.value; };
    const reset = () => {
        for (const { input, key } of inputs) if (input) {
            input.value = String(app.pcbDocument.board[key]);
            input.setCustomValidity?.('');
        }
        remember();
    };
    const binding = {
        get active() { return !!getBoardDimensionPreview(app); },
        sync: remember,
        commit() {
            if (disposed) return;
            if (inputs.some(({ input }) => input && !Number.isFinite(parseFloat(input.value)))) {
                binding.cancel();
                return;
            }
            try { finishBoardDimensionPreview(app, true); } finally { reset(); }
        },
        cancel() {
            if (disposed) return;
            try { finishBoardDimensionPreview(app); } finally { reset(); }
        },
        dispose() {
            if (disposed) return;
            try { binding.cancel(); } finally {
                disposed = true;
                releasePropertyEditor(app, 'boardDimension', binding);
            }
        },
    };
    setPropertyEditor(app, 'boardDimension', binding);
    remember();
    const update = entry => {
        if (disposed) return false;
        if (isLayerLocked('board-outline') || !isLayerVisible('board-outline')) { binding.cancel(); return false; }
        const value = parseFloat(entry.input.value);
        if (!Number.isFinite(value)) { entry.input.setCustomValidity?.('Enter a finite board dimension.'); return false; }
        entry.input.setCustomValidity?.('');
        const current = getBoardDimensionPreview(app)?.board || app.pcbDocument.board;
        const next = entry.input.value === entry.displayed ? app.pcbDocument.board[entry.key] : Math.max(entry.minimum, value);
        try {
            previewBoardDimensions(app, { ...current, [entry.key]: next });
        } catch (error) {
            binding.cancel();
            throw error;
        }
        return true;
    };
    for (const entry of inputs) if (entry.input) {
        entry.input.addEventListener('input', () => update(entry));
        entry.input.addEventListener('change', () => { update(entry); binding.commit(); });
        entry.input.addEventListener('keydown', event => {
            if (disposed || event.key !== 'Escape') return;
            binding.cancel();
            event.preventDefault();
            event.stopPropagation();
        });
    }
    return binding;
}

export function boardOutlineHandles(app) {
    if (!app._boardOutlineSelected || !app._boardOutlineDrawn
        || isLayerLocked('board-outline') || !isLayerVisible('board-outline')) return [];
    const { width, height } = boardDimensions(app);
    return [
        { id: 'height', x: width / 2, y: -height, cursor: 'ns-resize' },
        { id: 'width', x: width, y: -height / 2, cursor: 'ew-resize' },
        { id: 'both', x: width, y: -height, cursor: 'nesw-resize' },
    ];
}

export function renderBoardOutlineHandles(app) {
    const overlay = app.getLayerGroup?.('selection-overlay');
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
    getPropertyEditor(app, 'boardDimension')?.commit();
    if (app._boardOutlineResize) endBoardOutlineResize(app, false);
    const handle = hitTestBoardOutlineHandle(app, point);
    if (!handle) return false;
    app._boardOutlineResize = {
        handle: handle.id, start: { ...point },
        before: boardDimensions(app),
        previousSuspend: !!isBoardViewRefreshSuspended(app),
    };
    setBoardViewRefreshSuspended(app, true);
    return true;
}

export function updateBoardOutlineResize(app, point) {
    const drag = app._boardOutlineResize;
    if (!drag) return;
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
        endBoardOutlineResize(app, false);
        throw new Error('Board outline resize requires a finite position.');
    }
    if (isLayerLocked('board-outline') || !isLayerVisible('board-outline')) {
        endBoardOutlineResize(app, false);
        return;
    }
    const delta = snapToViewportGrid({ x: point.x - drag.start.x, y: point.y - drag.start.y }, app.viewport);
    const width = drag.handle === 'height' ? drag.before.width
        : Math.max(5, drag.before.width + delta.x);
    const height = drag.handle === 'width' ? drag.before.height
        : Math.max(5, drag.before.height - delta.y);
    if (width === boardDimensions(app).width && height === boardDimensions(app).height) return;
    try {
        previewBoardDimensions(app, { width, height, radius: drag.before.radius });
    } catch (error) {
        endBoardOutlineResize(app, false);
        throw error;
    }
    for (const [id, value] of [['pcbPropBoardW', width], ['pcbPropBoardH', height]]) {
        const input = /** @type {HTMLInputElement|null} */ (document.getElementById(id));
        if (input) input.value = Number(value).toFixed(2);
    }
}

export function endBoardOutlineResize(app, commit = true) {
    const drag = app._boardOutlineResize;
    if (!drag) return;
    app._boardOutlineResize = null;
    try {
        finishBoardDimensionPreview(app, commit);
    } finally {
        setBoardViewRefreshSuspended(app, drag.previousSuspend);
        app._syncBoardOutlineInputs?.();
        app._showBoardOutlineProperties?.();
        if (!isBoardViewRefreshSuspended(app)) refreshBoardView(app);
    }
}