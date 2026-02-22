/**
 * Clipboard module — copy, cut, paste for shapes and components
 */
import { DeleteShapesCommand, DeleteComponentsCommand, BatchCommand, PasteCommand } from '../../core/CommandHistory.js';
import { Component } from '../../components/Component.js';
import { createShape } from '../../shapes/index.js';

// Internal clipboard (array of serialised items)
let clipboard = [];
// Pre-built ghost SVG captured at copy time (avoids expensive rebuild on paste)
let clipboardGhostSvg = null;

/**
 * Compute the centroid of the given items (shapes + components).
 */
function centroid(items) {
    let sx = 0, sy = 0, n = 0;
    for (const item of items) {
        const b = item.getBounds?.();
        if (b) {
            sx += (b.minX + b.maxX) / 2;
            sy += (b.minY + b.maxY) / 2;
            n++;
        } else if (typeof item.x === 'number' && typeof item.y === 'number') {
            sx += item.x;
            sy += item.y;
            n++;
        }
    }
    return n > 0 ? { x: sx / n, y: sy / n } : { x: 0, y: 0 };
}

/**
 * Serialise a shape or component into a plain object that can be stored
 * on the clipboard and later reconstituted.
 */
function serialiseItem(item, origin) {
    if (item.definition) {
        // Component
        const json = item.toJSON();
        // Store position relative to selection centroid
        json._clipX = item.x - origin.x;
        json._clipY = item.y - origin.y;
        json._clipType = 'component';
        // Store full definition so we can recreate it
        json._definition = item.definition;
        return json;
    } else {
        // Shape
        const json = item.toJSON();
        // Compute offset relative to centroid
        const b = item.getBounds?.();
        if (b) {
            json._clipX = (b.minX + b.maxX) / 2 - origin.x;
            json._clipY = (b.minY + b.maxY) / 2 - origin.y;
        } else {
            json._clipX = 0;
            json._clipY = 0;
        }
        json._clipType = 'shape';
        return json;
    }
}

/**
 * Copy the current selection to the clipboard.
 */
export function copySelection(app) {
    const selection = app.selection.getSelection();
    if (selection.length === 0) return;

    const origin = centroid(selection);
    clipboard = selection.map(item => serialiseItem(item, origin));

    // Build ghost SVG now by cloning rendered elements (cheap DOM cloneNode)
    _buildGhostFromSelection(selection, origin);
}

/**
 * Cut the current selection (copy then delete).
 */
export function cutSelection(app) {
    const selection = app.selection.getSelection();
    if (selection.length === 0) return;

    // Only cut unlocked items
    const cuttable = selection.filter(item => !item.locked);
    if (cuttable.length === 0) return;

    const origin = centroid(cuttable);
    clipboard = cuttable.map(item => serialiseItem(item, origin));

    // Build ghost SVG before deleting (elements still in DOM)
    _buildGhostFromSelection(cuttable, origin);

    // Delete via undo-able commands (same logic as deleteSelected)
    app.selection.clearSelection();

    const shapes = [];
    const components = [];

    for (const item of cuttable) {
        if (app.shapes.includes(item)) {
            // Skip component field texts — don't cut those independently
            if (item.parentComponent && item.fieldKey) continue;
            shapes.push(item);
        } else if (app.components.includes(item)) {
            components.push(item);
        }
    }

    if (shapes.length > 0 && components.length > 0) {
        const batch = new BatchCommand('Cut selection');
        batch.add(new DeleteShapesCommand(app, shapes));
        batch.add(new DeleteComponentsCommand(app, components));
        app.history.execute(batch);
    } else if (shapes.length > 0) {
        app.history.execute(new DeleteShapesCommand(app, shapes));
    } else if (components.length > 0) {
        app.history.execute(new DeleteComponentsCommand(app, components));
    }

    app.renderShapes(true);
}

// ── Paste preview mode ───────────────────────────────────────────

/**
 * Build a ghost SVG group from the current selection by cloning their
 * already-rendered DOM elements.  Stored in clipboardGhostSvg for reuse.
 */
function _buildGhostFromSelection(selection, origin) {
    const ghost = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    for (const item of selection) {
        if (!item.element) continue;
        const clone = item.element.cloneNode(true);
        ghost.appendChild(clone);
    }

    // Offset the whole group so the centroid sits at (0,0)
    ghost.setAttribute('transform', `translate(${-origin.x}, ${-origin.y})`);

    // Wrap in another group so the outer translate positions in world space
    const wrapper = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    wrapper.style.opacity = '0.5';
    wrapper.style.pointerEvents = 'none';
    wrapper.classList.add('paste-preview');
    wrapper.appendChild(ghost);

    clipboardGhostSvg = wrapper;
}

/**
 * Begin paste-preview mode: show a ghost that follows the cursor.
 */
export function beginPastePreview(app) {
    if (clipboard.length === 0) return;

    // Cancel any in-progress placement or drawing
    if (app.placingComponent) app._cancelComponentPlacement();
    if (app.isDrawing) app._cancelDrawing();

    // Clone the pre-built ghost (fast single cloneNode)
    const ghost = clipboardGhostSvg
        ? clipboardGhostSvg.cloneNode(true)
        : _buildGhostFallback(app);

    app.viewport.contentLayer.appendChild(ghost);
    app.pastePreviewGroup = ghost;
    app.pastingClipboard = true;
    app.viewport.svg.style.cursor = 'crosshair';

    // Position at current mouse so it doesn't flash at the origin
    const mousePos = app.viewport.currentMouseWorld;
    if (mousePos) {
        const snapped = app.viewport.getSnappedPosition(mousePos);
        ghost.setAttribute('transform', `translate(${snapped.x}, ${snapped.y})`);
    }
}

/**
 * Fallback ghost builder (only used if clipboardGhostSvg is somehow null).
 */
function _buildGhostFallback(app) {
    const ghost = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    ghost.style.opacity = '0.5';
    ghost.style.pointerEvents = 'none';
    ghost.classList.add('paste-preview');

    for (const data of clipboard) {
        if (data._clipType === 'component') {
            const def = data._definition;
            if (!def) continue;
            const temp = new Component(def, {
                x: data._clipX,
                y: data._clipY,
                rotation: data.rotation || 0,
                mirror: data.mirror || false,
                reference: data.reference || 'U?'
            });
            ghost.appendChild(temp.createSymbolElement());
        } else {
            const clonedData = structuredClone(data);
            delete clonedData.id;
            delete clonedData._clipType;
            offsetShapeData(clonedData, clonedData._clipX || 0, clonedData._clipY || 0);
            delete clonedData._clipX;
            delete clonedData._clipY;
            const tempShape = createShape(clonedData);
            if (tempShape) ghost.appendChild(tempShape.render(app.viewport.scale));
        }
    }
    return ghost;
}

/**
 * Move the paste preview ghost to follow the cursor.
 */
export function updatePastePreview(app, worldPos) {
    if (!app.pastePreviewGroup || !app.pastingClipboard) return;
    app.pastePreviewGroup.setAttribute('transform', `translate(${worldPos.x}, ${worldPos.y})`);
}

/**
 * Confirm paste: instantiate items at the given world position.
 */
export function confirmPaste(app, worldPos) {
    if (!app.pastingClipboard || clipboard.length === 0) return;

    const snapped = app.viewport.getSnappedPosition(worldPos);

    const pastedShapes = [];
    const pastedComponents = [];

    for (const data of clipboard) {
        if (data._clipType === 'component') {
            const def = data._definition;
            if (!def) continue;
            const comp = new Component(def, {
                x: snapped.x + data._clipX,
                y: snapped.y + data._clipY,
                rotation: data.rotation || 0,
                mirror: data.mirror || false,
                reference: app._generateReference(def),
                value: data.value,
                showReference: data.showReference,
                showValue: data.showValue,
                properties: data.properties
            });
            pastedComponents.push(comp);
        } else {
            // structuredClone is faster than JSON round-trip and handles all types
            const clone = structuredClone(data);
            const { id, _clipX, _clipY, _clipType, ...shapeData } = clone;
            offsetShapeData(shapeData, snapped.x + _clipX, snapped.y + _clipY);

            const shape = createShape(shapeData);
            if (shape) {
                pastedShapes.push(shape);
            }
        }
    }

    if (pastedShapes.length > 0 || pastedComponents.length > 0) {
        // Single command — updateSelectableItems called once, not per item
        app.history.execute(new PasteCommand(app, pastedShapes, pastedComponents));
        // Batch selection — notifySelectionChanged fires once, not per item
        const allPasted = [...pastedShapes, ...pastedComponents];
        app.selection.selectMultiple(allPasted, false);
        app.renderShapes(true);
        app.fileManager.setDirty(true);
    }

    cancelPaste(app);
}

/**
 * Cancel paste-preview mode without placing.
 */
export function cancelPaste(app) {
    if (app.pastePreviewGroup) {
        app.pastePreviewGroup.remove();
        app.pastePreviewGroup = null;
    }
    app.pastingClipboard = false;
    app.viewport.svg.style.cursor = '';
}

/**
 * Reposition shape data so its centre lands on (tx, ty).
 * Different shape types store position differently.
 */
function offsetShapeData(data, tx, ty) {
    const type = data.type;

    if (type === 'line') {
        const cx = (data.x1 + data.x2) / 2;
        const cy = (data.y1 + data.y2) / 2;
        const dx = tx - cx;
        const dy = ty - cy;
        data.x1 += dx; data.y1 += dy;
        data.x2 += dx; data.y2 += dy;
    } else if (type === 'polygon' || type === 'wire') {
        if (data.points && data.points.length > 0) {
            let sx = 0, sy = 0;
            for (const p of data.points) { sx += p.x; sy += p.y; }
            const cx = sx / data.points.length;
            const cy = sy / data.points.length;
            const dx = tx - cx;
            const dy = ty - cy;
            for (const p of data.points) { p.x += dx; p.y += dy; }
        }
    } else if (type === 'arc') {
        // Arc stores startPoint, endPoint, bulgePoint
        if (data.startPoint && data.endPoint && data.bulgePoint) {
            const cx = (data.startPoint.x + data.endPoint.x + data.bulgePoint.x) / 3;
            const cy = (data.startPoint.y + data.endPoint.y + data.bulgePoint.y) / 3;
            const dx = tx - cx;
            const dy = ty - cy;
            data.startPoint.x += dx; data.startPoint.y += dy;
            data.endPoint.x += dx; data.endPoint.y += dy;
            data.bulgePoint.x += dx; data.bulgePoint.y += dy;
        }
    } else if (type === 'rect') {
        // Rect stores x, y, width, height  — x,y is top-left
        const cx = data.x + data.width / 2;
        const cy = data.y + data.height / 2;
        data.x += tx - cx;
        data.y += ty - cy;
    } else {
        // circle, text, via, pad — use x, y as centre
        data.x = tx;
        data.y = ty;
    }
}

export function hasClipboard() {
    return clipboard.length > 0;
}
