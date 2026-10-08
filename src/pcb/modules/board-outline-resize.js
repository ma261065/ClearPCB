import { beginDragSession, releaseDragSession } from './drag-session.js';
import { isLayerLocked, isLayerVisible, setPcbLayerLocked } from './layers.js';
import { showBoardShapeProperties } from './board-shape-properties.js';
import { SetBoardOutlineCommand } from './track-commands.js';
import { snapToViewportGrid } from '../../core/grid-snap.js';
import { clearBoardDimensionPreview, getBoardDimensionPreview, getBoardOutline, rectangleBoardOutline,
    boardBoundary, boardDimensions, setBoardDimensionPreview } from '../../shared/pcb/board-outline.js';
import { removeBoardShapeElement, renderBoardShape, selectBoardShape } from './board-shapes.js';
import { getPropertyEditor, releasePropertyEditor, setPropertyEditor } from './property-editors.js';
import { areDragOverlaysDeferred, isBoardViewRefreshSuspended, setBoardViewRefreshSuspended, refreshBoardView } from './refresh-state.js';
import { getPcbInteraction, setPcbInteraction } from './pcb-interactions.js';
import { renderPanelPreview } from './panelization-ui.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */
/** @typedef {import('../../shared/ui/property-fields.js').PropertyField} PropertyField */
/** @typedef {import('../../shared/ui/property-fields.js').PropertyPanel} PropertyPanel */

const boardOutlineStates = new WeakMap();

/** @param {PcbEditor} app */
function state(app) {
    let next = boardOutlineStates.get(app);
    if (!next) {
        // The editor initialises this in its constructor; anything else starts undrawn.
        next = { drawn: false, selected: false };
        boardOutlineStates.set(app, next);
    }
    return next;
}

/** @param {PcbEditor} app */
export function initializeBoardOutlineState(app, drawn = !!getBoardOutline(app)) {
    boardOutlineStates.set(app, { drawn: !!drawn, selected: false });
}

/** @param {PcbEditor} app */
export function isBoardOutlineDrawn(app) {
    return !!state(app).drawn;
}

/** @param {PcbEditor} app */
export function setBoardOutlineDrawn(app, drawn) {
    state(app).drawn = !!drawn;
}

/**
 * Whether the board outline is selected.
 * @param {PcbEditor} app
 */
export function isBoardOutlineSelected(app) {
    return !!state(app).selected;
}

/** @param {PcbEditor} app */
export function setBoardOutlineSelected(app, selected) {
    state(app).selected = !!selected;
}

/**
 * Test if a world point is near the board outline edge.
 * @param {PcbEditor} app
 */
export function hitTestBoardOutline(app, pos) {
    if (getBoardOutline(app)) return false;
    if (!isBoardOutlineDrawn(app)) return false;
    // The board outline lives on the 'board-outline' layer; don't allow
    // selecting/hovering it while that layer is locked or hidden.
    if (isLayerLocked('board-outline') || !isLayerVisible('board-outline')) return false;
    const { width: w, height: h } = boardDimensions(app);
    // In SVG coords (Y-down), board goes from (0, -h) to (w, 0)
    const x1 = 0, y1 = -h;
    const x2 = w, y2 = 0;
    const tol = 1.5; // mm hit tolerance

    // Near any edge?
    const nearLeft = Math.abs(pos.x - x1) < tol && pos.y >= y1 - tol && pos.y <= y2 + tol;
    const nearRight = Math.abs(pos.x - x2) < tol && pos.y >= y1 - tol && pos.y <= y2 + tol;
    const nearTop = Math.abs(pos.y - y1) < tol && pos.x >= x1 - tol && pos.x <= x2 + tol;
    const nearBottom = Math.abs(pos.y - y2) < tol && pos.x >= x1 - tol && pos.x <= x2 + tol;
    return nearLeft || nearRight || nearTop || nearBottom;
}

/**
 * Set board outline hover state.
 * @param {PcbEditor} app
 */
export function hoverBoardOutline(app, hovered) {
    const outline = app.getLayerGroup('board-outline').querySelector('.pcb-board-outline');
    if (!outline) return;
    if (isBoardOutlineSelected(app)) return; // don't override selection highlight
    if (hovered) {
        outline.setAttribute('stroke', '#ffe066');
        outline.setAttribute('stroke-width', '0.35');
    } else {
        outline.setAttribute('stroke', '#f1c40f');
        outline.setAttribute('stroke-width', '0.2');
    }
}

/**
 * Draw (or redraw) the board outline on the board-outline layer.
 * @param {PcbEditor} app
 */
export function drawBoardOutline(app) {
    const layer = app.getLayerGroup('board-outline');
    const old = layer.querySelector('.pcb-board-outline');
    if (old) old.remove();
    const shape = getBoardOutline(app);
    if (!shape) {
        setBoardOutlineDrawn(app, false);
        return;
    }
    renderBoardShape(app, shape, { liveDrag: !!getBoardDimensionPreview(app) || areDragOverlaysDeferred(app) });
    const wasDrawn = isBoardOutlineDrawn(app);
    setBoardOutlineDrawn(app, true);
    renderPanelPreview(app);
    if (!wasDrawn && app.viewport && !getBoardDimensionPreview(app)) {
        const bounds = boardBoundary(app);
        app.viewport.fitToBounds(bounds.x, bounds.y, bounds.x + bounds.w, bounds.y + bounds.h, 5);
    }
}

/**
 * Set board outline selection state.
 * @param {PcbEditor} app
 */
export function selectBoardOutline(app, selected) {
    const shape = getBoardOutline(app);
    if (shape && selected) {
        selectBoardShape(app, shape);
        return;
    }
    if (!selected) endBoardOutlineResize(app, false);
    if (!selected) getPropertyEditor(app, 'boardDimension')?.dispose();
    setBoardOutlineSelected(app, selected);
    renderBoardOutlineHandles(app);
    // Without an outline shape nothing is drawn to restyle (drawBoardOutline removes the element).
    if (!shape) return;
    const outline = app.getLayerGroup('board-outline').querySelector('.pcb-board-outline');
    if (!outline) return;
    if (selected) {
        outline.setAttribute('stroke', '#ffffff');
        outline.setAttribute('stroke-width', '0.4');
        outline.setAttribute('stroke-dasharray', '1.5,0.8');
    } else {
        outline.setAttribute('stroke', '#f1c40f');
        outline.setAttribute('stroke-width', '0.2');
        outline.removeAttribute('stroke-dasharray');
    }
}

/** @param {PcbEditor} app */
export function syncBoardOutlineInputs(app) {
    const editor = getPropertyEditor(app, 'boardDimension');
    if (typeof editor?.sync === 'function') editor.sync();
}

export { getBoardDimensionPreview } from '../../shared/pcb/board-outline.js';

/**
 * Properties for the board outline: the outline shape's panel, or board size fields before one exists.
 * @param {PcbEditor} app
 */
export function showBoardOutlineProperties(app) {
    const editor = getPropertyEditor(app, 'boardDimension');
    if (typeof editor?.dispose === 'function') editor.dispose();
    const outline = getBoardOutline(app);
    if (outline) {
        showBoardShapeProperties(app, outline);
        return;
    }
    let binding = null;
    const refresh = () => app.refreshPropertyPanel?.(describe());
    /** @returns {PropertyPanel} */
    const describe = () => {
        const board = getBoardDimensionPreview(app)?.board ?? app.pcbDocument.board;
        const locked = isLayerLocked('board-outline') || !isLayerVisible('board-outline');
        /** @returns {PropertyField} */
        const number = (key, id, label, min, step) => ({
            key, id, type: 'number', label, value: board[key], min, step, disabled: locked,
            format: value => Number(value).toFixed(2),
            parse: text => {
                const value = text.trim() === '' ? NaN : Number(text);
                binding?.setValid(key, Number.isFinite(value));
                return value;
            },
            normalize: value => Math.max(min, value),
            preview: value => binding?.preview(key, value),
            commit: () => binding?.commit(),
            cancel: () => { const active = binding?.active; binding?.cancel(); return active; },
        });
        return {
            title: 'Board Outline',
            fields: [
                { key: 'locked', id: 'pcbPropOutlineLocked', type: 'checkbox', label: 'Locked',
                    value: isLayerLocked('board-outline'), commit: value => { setPcbLayerLocked(app, 'board-outline', value); refresh(); } },
                number('width', 'pcbPropBoardW', 'Width (mm)', 5, 1),
                number('height', 'pcbPropBoardH', 'Height (mm)', 5, 1),
                number('radius', 'pcbPropBoardR', 'Corner Radius (mm)', 0, 0.5),
            ],
        };
    };
    if (!app.openPropertyPanel?.(describe())) return;
    binding = bindBoardDimensionProperties(app, refresh);
    refresh();
}

/** @param {PcbEditor} app */
export function previewBoardDimensions(app, dimensions) {
    if (!['width', 'height', 'radius'].every(key => Number.isFinite(dimensions[key]))) throw new Error('Board dimensions must be finite.');
    if (dimensions.width <= 0 || dimensions.height <= 0 || dimensions.radius < 0) {
        throw new Error('Board dimensions must be positive with a nonnegative radius.');
    }
    const current = getBoardDimensionPreview(app)?.board || app.pcbDocument.board;
    if (['width', 'height', 'radius'].every(key => dimensions[key] === current[key])) return false;
    let preview = getBoardDimensionPreview(app);
    if (!preview) {
        const model = app.pcbDocument, original = getBoardOutline(model);
        const outline = rectangleBoardOutline(current.width, current.height, current.radius);
        if (original) outline.id = original.id;
        preview = {
            model, original, originalBoard: model.board, before: { ...model.board }, board: { ...model.board }, outline,
            boardShapes: original ? model.boardShapes.map(shape => shape === original ? outline : shape)
                : [...model.boardShapes, outline],
            // The board view is handed back after the commit, overlays before it.
            previousSuspend: !!isBoardViewRefreshSuspended(app), session: beginDragSession(app),
            wasDrawn: isBoardOutlineDrawn(app),
        };
        setBoardDimensionPreview(app, preview);
        setBoardViewRefreshSuspended(app, true);
    }
    Object.assign(preview.board, dimensions);
    const { width, height, radius } = dimensions;
    preview.outline.cornerRadius = radius;
    for (const [index, point] of preview.outline.points.entries()) {
        point.x = index === 1 || index === 2 ? width : 0;
        point.y = index < 2 ? -height : 0;
    }
    try {
        drawBoardOutline(app);
        renderBoardOutlineHandles(app);
    } catch (error) {
        finishBoardDimensionPreview(app);
        throw error;
    }
    return true;
}

/** @param {PcbEditor} app */
export function finishBoardDimensionPreview(app, commit = false) {
    const preview = clearBoardDimensionPreview(app);
    if (!preview) return;
    setBoardOutlineDrawn(app, preview.wasDrawn);
    let committed = false;
    try {
        if (commit && !isLayerLocked('board-outline') && isLayerVisible('board-outline')) {
            if (app.pcbDocument !== preview.model || app.pcbDocument.board !== preview.originalBoard
                || getBoardOutline(app.pcbDocument) !== preview.original) {
                throw new Error('The board outline is no longer available.');
            }
            if (['width', 'height', 'radius'].some(key => preview.before[key] !== preview.board[key])) {
                releaseDragSession(app, preview.session);
                app.history.execute(new SetBoardOutlineCommand(app, preview.before, preview.board));
                committed = true;
            }
        }
    } finally {
        try {
            if (!committed) {
                removeBoardShapeElement(app, preview.outline.id, { preserveInteraction: true });
                drawBoardOutline(app);
            }
        } finally {
            setBoardViewRefreshSuspended(app, preview.previousSuspend);
            releaseDragSession(app, preview.session);
            renderBoardOutlineHandles(app);
        }
    }
    if (committed && !isBoardViewRefreshSuspended(app)) refreshBoardView(app);
}

/** @param {PcbEditor} app */
export function bindBoardDimensionProperties(app, refresh = () => {}) {
    let disposed = false;
    const invalid = new Set();
    const binding = {
        get active() { return !!getBoardDimensionPreview(app); },
        sync: refresh,
        setValid(key, valid) {
            if (valid) invalid.delete(key);
            else invalid.add(key);
        },
        preview(key, value) {
            if (disposed) return false;
            const minimum = key === 'radius' ? 0 : 5;
            if (isLayerLocked('board-outline') || !isLayerVisible('board-outline')) { binding.cancel(); return false; }
            if (!Number.isFinite(value)) return false;
            const current = getBoardDimensionPreview(app)?.board || app.pcbDocument.board;
            try {
                const changed = previewBoardDimensions(app, { ...current, [key]: Math.max(minimum, value) });
                refresh();
                return changed;
            } catch (error) {
                binding.cancel();
                throw error;
            }
        },
        commit() {
            if (disposed) return;
            if (invalid.size) {
                binding.cancel();
                return;
            }
            try { finishBoardDimensionPreview(app, true); } finally { refresh(); }
        },
        cancel() {
            if (disposed) return;
            try { finishBoardDimensionPreview(app); } finally { refresh(); }
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
    return binding;
}

/** @param {PcbEditor} app */
export function boardOutlineHandles(app) {
    if (!isBoardOutlineSelected(app) || !isBoardOutlineDrawn(app)
        || isLayerLocked('board-outline') || !isLayerVisible('board-outline')) return [];
    const { width, height } = boardDimensions(app);
    return [
        { id: 'height', x: width / 2, y: -height, cursor: 'ns-resize' },
        { id: 'width', x: width, y: -height / 2, cursor: 'ew-resize' },
        { id: 'both', x: width, y: -height, cursor: 'nesw-resize' },
    ];
}

/** @param {PcbEditor} app */
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

/** @param {PcbEditor} app */
export function hitTestBoardOutlineHandle(app, point) {
    const tolerance = 8 / Math.max(0.01, app.viewport?.scale || 1);
    return boardOutlineHandles(app).find(handle => Math.hypot(handle.x - point.x, handle.y - point.y) <= tolerance) || null;
}

/** @param {PcbEditor} app */
export function beginBoardOutlineResize(app, point) {
    getPropertyEditor(app, 'boardDimension')?.commit();
    if (getBoardOutlineResize(app)) endBoardOutlineResize(app, false);
    const handle = hitTestBoardOutlineHandle(app, point);
    if (!handle) return false;
    setPcbInteraction(app, '_boardOutlineResize', {
        handle: handle.id, start: { ...point },
        before: boardDimensions(app),
        previousSuspend: !!isBoardViewRefreshSuspended(app),
    });
    setBoardViewRefreshSuspended(app, true);
    return true;
}

/** @param {PcbEditor} app */
export function getBoardOutlineResize(app) {
    return getPcbInteraction(app, '_boardOutlineResize');
}

/** @param {PcbEditor} app */
export function updateBoardOutlineResize(app, point) {
    const drag = getBoardOutlineResize(app);
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
    getPropertyEditor(app, 'boardDimension')?.sync();
}

/** @param {PcbEditor} app */
export function endBoardOutlineResize(app, commit = true) {
    const drag = getBoardOutlineResize(app);
    if (!drag) return;
    setPcbInteraction(app, '_boardOutlineResize', null);
    try {
        finishBoardDimensionPreview(app, commit);
    } finally {
        setBoardViewRefreshSuspended(app, drag.previousSuspend);
        syncBoardOutlineInputs(app);
        showBoardOutlineProperties(app);
        if (!isBoardViewRefreshSuspended(app)) refreshBoardView(app);
    }
}

const dimensionDialogs = new WeakMap();

/**
 * The open Board Dimensions dialog's overlay, or null.
 * @param {PcbEditor} app
 */
export function boardDimensionsDialog(app) {
    return dimensionDialogs.get(app) || null;
}

/**
 * Close the Board Dimensions dialog, if open; a later OK in it changes nothing.
 * @param {PcbEditor} app
 */
export function closeBoardDimensionsDialog(app) {
    dimensionDialogs.get(app)?.remove();
    dimensionDialogs.delete(app);
}

/**
 * Ask for the board's size (rectangle with corner radius, or circle) when a new board
 * is first shown. OK runs one undoable SetBoardOutlineCommand, or just draws the default
 * outline (and marks the document dirty) when the defaults are kept.
 * @param {PcbEditor} app
 */
export function showBoardDimensionsDialog(app) {
    if (dimensionDialogs.has(app)) return;
    getPropertyEditor(app, 'boardDimension')?.commit();
    if (getBoardOutlineResize(app)) endBoardOutlineResize(app);
    const size = boardDimensions(app);
    const overlay = document.createElement('div');
    overlay.className = 'app-modal-overlay';
    overlay.innerHTML = `
        <div class="app-modal" style="min-width:300px">
            <div class="app-modal-title">Board Dimensions</div>
            <div class="app-modal-message">Enter the board size in millimetres.</div>
            <label for="boardDlgShape" style="font-size:11px;color:var(--text-secondary)">Shape</label>
            <select class="app-modal-input" id="boardDlgShape">
                <option value="rect">Rectangle</option>
                <option value="circle">Circle</option>
            </select>
            <div id="boardDlgRectangleSizes" style="display:flex;gap:10px;margin-top:10px">
                <div style="flex:1">
                    <label for="boardDlgWidth" style="font-size:11px;color:var(--text-secondary)">Width (mm)</label>
                    <input class="app-modal-input" id="boardDlgWidth" type="number" value="${size.width}" min="5" step="1" style="margin-top:2px">
                </div>
                <div style="flex:1">
                    <label for="boardDlgHeight" style="font-size:11px;color:var(--text-secondary)">Height (mm)</label>
                    <input class="app-modal-input" id="boardDlgHeight" type="number" value="${size.height}" min="5" step="1" style="margin-top:2px">
                </div>
                <div style="flex:1">
                    <label for="boardDlgRadius" style="font-size:11px;color:var(--text-secondary)">Corner Radius (mm)</label>
                    <input class="app-modal-input" id="boardDlgRadius" type="number" value="${Number(size.radius).toFixed(2)}" min="0" step="0.5" style="margin-top:2px">
                </div>
            </div>
            <div id="boardDlgCircleSizes" style="display:none;margin-top:10px">
                <label for="boardDlgDiameter" style="font-size:11px;color:var(--text-secondary)">Diameter (mm)</label>
                <input class="app-modal-input" id="boardDlgDiameter" type="number" value="${Math.min(size.width, size.height)}" min="5" step="1" style="margin-top:2px">
            </div>
            <div class="app-modal-message" style="margin-top:10px">Tip: Edit the board outline after creation for more complex shapes</div>
            <div class="app-modal-actions">
                <button class="app-modal-btn app-modal-ok" id="boardDlgOk">OK</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    dimensionDialogs.set(app, overlay);

    const shapeInput = /** @type {HTMLSelectElement} */ (overlay.querySelector('#boardDlgShape'));
    const rectangleSizes = /** @type {HTMLElement} */ (overlay.querySelector('#boardDlgRectangleSizes'));
    const circleSizes = /** @type {HTMLElement} */ (overlay.querySelector('#boardDlgCircleSizes'));
    const diameterInput = /** @type {HTMLInputElement} */ (overlay.querySelector('#boardDlgDiameter'));
    const widthInput = /** @type {HTMLInputElement} */ (overlay.querySelector('#boardDlgWidth'));
    const heightInput = /** @type {HTMLInputElement} */ (overlay.querySelector('#boardDlgHeight'));
    const radiusInput = /** @type {HTMLInputElement} */ (overlay.querySelector('#boardDlgRadius'));
    const okBtn = overlay.querySelector('#boardDlgOk');

    shapeInput.addEventListener('change', () => {
        const circle = shapeInput.value === 'circle';
        rectangleSizes.style.display = circle ? 'none' : 'flex';
        circleSizes.style.display = circle ? 'block' : 'none';
    });
    diameterInput.addEventListener('input', () => diameterInput.setCustomValidity(''));

    radiusInput?.addEventListener('input', () => {
        if (Number.isFinite(radiusInput.valueAsNumber)) {
            radiusInput.value = Math.max(0, radiusInput.valueAsNumber).toFixed(2);
        }
    });

    setTimeout(() => {
        if (dimensionDialogs.get(app) === overlay) {
            (shapeInput.value === 'circle' ? diameterInput : widthInput).focus();
        }
    }, 50);

    const accept = () => {
        // A dialog replaced or closed by a document change must not touch the new board.
        if (dimensionDialogs.get(app) !== overlay) return;
        const w = parseFloat(widthInput?.value) || 100;
        const h = parseFloat(heightInput?.value) || 80;
        const r = parseFloat(radiusInput?.value) || 0;
        const { width, height, radius } = boardDimensions(app);
        const before = { width, height, radius };
        const diameter = parseFloat(diameterInput.value);
        const circle = shapeInput.value === 'circle';
        if (circle && (!Number.isFinite(diameter) || diameter < 5)) {
            diameterInput.setCustomValidity('Enter a diameter of at least 5 mm.');
            diameterInput.reportValidity();
            return;
        }
        const after = circle ? {
            width: diameter,
            height: diameter,
            radius: 0,
            outline: {
                id: 'board-outline', kind: 'circle', layer: 'board-outline', lineWidth: 0.2,
                filled: false, x: diameter / 2, y: -diameter / 2, radius: diameter / 2,
            },
        } : {
            width: Math.max(5, w),
            height: Math.max(5, h),
            radius: Math.max(0, r),
        };
        if (circle || before.width !== after.width || before.height !== after.height || before.radius !== after.radius) {
            app.history.execute(new SetBoardOutlineCommand(app, before, after));
        } else if (!isBoardOutlineDrawn(app)) {
            // Dimensions unchanged from defaults, so no command runs — but
            // the outline still needs its first draw, and the document must
            // be flagged dirty so the autosave captures the new board.
            app.pcbDocument.ensureBoardOutline();
            drawBoardOutline(app);
            app.markDirty();
        }
        closeBoardDimensionsDialog(app);
    };

    okBtn?.addEventListener('click', accept);
    overlay.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') accept();
    });
}
