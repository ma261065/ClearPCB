/**
 * Clipboard module — copy, cut, paste for shapes and components
 */
import { DeleteShapesCommand, DeleteComponentsCommand, BatchCommand, PasteCommand } from './commands.js';
import { Component } from '../../components/Component.js';
import { createShape } from '../../shapes/index.js';
import { cloneEntityElement, componentPreviewElement, shapePreviewElement } from './schematic-view.js';
import { generateReference, isPlacingComponent } from './components.js';
import { isSchematicLocked } from '../../shapes/lock-owner.js';
import { isSchematicDrawingActive } from './drawing.js';
import { getSchematicInteraction, setSchematicInteraction } from './schematic-interactions.js';
/** @typedef {import('./schematic-editor-api.js').SchematicEditor} SchematicEditor */
/** @typedef {import('../../core/SchematicDocument.js').SchematicShape} SchematicShape */
/** @typedef {import('../../shapes/shape.js').Shape} Shape */
/** @typedef {{x: number, y: number}} Point */
/** @typedef {Record<string, any> & {_clipX: number, _clipY: number, _clipType: 'component'|'shape', _definition?: import('../../components/Component.js').ComponentDefinition}} ClipboardData */

// Internal clipboard (array of serialised items)
/** @type {ClipboardData[]} */
let clipboard = [];
// Pre-built ghost SVG captured at copy time (avoids expensive rebuild on paste)
/** @type {SVGGElement|null} */
let clipboardGhostSvg = null;

/** @param {SchematicEditor} app */
export function isPastingClipboard(app) {
    return !!getSchematicInteraction(app, 'pastingClipboard');
}

/**
 * @param {SchematicEditor} app
 * @param {boolean} active
 */
function setPastingClipboard(app, active) {
    setSchematicInteraction(app, 'pastingClipboard', active);
}

/**
 * Compute the centroid of the given items (shapes + components).
 * @param {SchematicShape[]} items
 * @returns {Point}
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
 * @param {SchematicShape} item
 * @param {Point} origin
 * @returns {ClipboardData}
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
        return /** @type {ClipboardData} */ (json);
    } else {
        // Shape
        const json = item.toJSON();
        // Compute offset using the same centroid that offsetShapeData uses,
        // so the ghost position matches the placed position exactly.
        const shapeCentroid = _getShapeDataCentroid(json);
        json._clipX = shapeCentroid.x - origin.x;
        json._clipY = shapeCentroid.y - origin.y;
        json._clipType = 'shape';
        return /** @type {ClipboardData} */ (json);
    }
}

/**
 * Copy the current selection to the clipboard.
 * @param {SchematicEditor} app
 */
export function copySelection(app) {
    const selection = app.selection.getSelection();
    if (selection.length === 0) return;

    // Deduplicate: skip field texts whose parent component is also selected,
    // since the component will recreate them on paste.
    const selectedSet = new Set(selection);
    const deduped = selection.filter(item =>
        !(item.parentComponent && item.fieldKey && selectedSet.has(item.parentComponent))
    );

    const origin = centroid(deduped);
    clipboard = deduped.map(item => serialiseItem(item, origin));

    // Build ghost SVG now by cloning rendered elements (cheap DOM cloneNode)
    _buildGhostFromSelection(deduped, origin);
}

/**
 * Cut the current selection (copy then delete).
 * @param {SchematicEditor} app
 */
export function cutSelection(app) {
    const selection = app.selection.getSelection();
    if (selection.length === 0) return;

    // Only cut unlocked items
    const cuttable = selection.filter(item => !isSchematicLocked(item));
    if (cuttable.length === 0) return;

    // Deduplicate: skip field texts whose parent component is also selected
    const cuttableSet = new Set(cuttable);
    const deduped = cuttable.filter(item =>
        !(item.parentComponent && item.fieldKey && cuttableSet.has(item.parentComponent))
    );

    const origin = centroid(deduped);
    clipboard = deduped.map(item => serialiseItem(item, origin));

    // Build ghost SVG before deleting (elements still in DOM)
    _buildGhostFromSelection(deduped, origin);

    // Delete via undo-able commands (same logic as runSchematicDeleteAction)
    app.selection.clearSelection();

    /** @type {Shape[]} */
    const shapes = [];
    /** @type {Component[]} */
    const components = [];

    for (const item of cuttable) {
        if (app.shapes.includes(item)) {
            // Skip component ref/value field texts — those can't be cut independently
            if (item.parentComponent && (item.fieldKey === 'reference' || item.fieldKey === 'value')) continue;
            shapes.push(/** @type {Shape} */ (item));
        } else if (app.components.includes(/** @type {Component} */ (item))) {
            components.push(/** @type {Component} */ (item));
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
 * @param {SchematicShape[]} selection
 * @param {Point} origin
 */
function _buildGhostFromSelection(selection, origin) {
    const ghost = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    for (const item of selection) {
        const clone = cloneEntityElement(item);
        if (clone) ghost.appendChild(clone);
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
 * @param {SchematicEditor} app
 */
export function beginPastePreview(app) {
    if (clipboard.length === 0) return;

    // Cancel any existing paste preview first (prevents orphaned ghost SVGs)
    if (isPastingClipboard(app)) {
        cancelPaste(app);
    }

    // Cancel any in-progress placement or drawing
    if (isPlacingComponent(app)) app.cancelComponentPlacement();
    if (isSchematicDrawingActive(app)) app.cancelDrawing();

    // Clone the pre-built ghost (fast single cloneNode)
    const ghost = /** @type {SVGGElement} */ (clipboardGhostSvg
        ? clipboardGhostSvg.cloneNode(true)
        : _buildGhostFallback(app));

    app.viewport.contentLayer.appendChild(ghost);
    app.pastePreviewGroup = ghost;
    setPastingClipboard(app, true);
    app.interactionState = 'placing';
    app.viewport.svg.style.cursor = 'crosshair';

    // Position at current mouse so it doesn't flash at the origin,
    // and show crosshair immediately (before the first mousemove).
    const mousePos = app.viewport.currentMouseWorld || { x: 0, y: 0 };
    const snapped = app.viewport.getSnappedPosition(mousePos);
    ghost.setAttribute('transform', `translate(${snapped.x}, ${snapped.y})`);
    app.showCrosshair?.();
    app.updateCrosshair?.(snapped);
}

/**
 * Fallback ghost builder (only used if clipboardGhostSvg is somehow null).
 * @param {SchematicEditor} app
 * @returns {SVGGElement}
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
                rotation: data.rot || 0,
                mirror: data.mir || false,
                reference: data.ref || 'U?',
                packageId: data.pkg,
            });
            ghost.appendChild(componentPreviewElement(temp));
        } else {
            const clonedData = /** @type {Record<string, any>} */ (structuredClone(data));
            delete clonedData.id;
            delete clonedData._clipType;
            offsetShapeData(clonedData, clonedData._clipX || 0, clonedData._clipY || 0);
            delete clonedData._clipX;
            delete clonedData._clipY;
            const tempShape = createShape(clonedData);
            if (tempShape) ghost.appendChild(shapePreviewElement(app, tempShape));
        }
    }
    return ghost;
}

/**
 * Move the paste preview ghost to follow the cursor.
 * @param {SchematicEditor} app
 * @param {Point} worldPos
 */
export function updatePastePreview(app, worldPos) {
    if (!app.pastePreviewGroup || !isPastingClipboard(app)) return;
    app.pastePreviewGroup.setAttribute('transform', `translate(${worldPos.x}, ${worldPos.y})`);
}

/**
 * Confirm paste: instantiate items at the given world position.
 * @param {SchematicEditor} app
 * @param {Point} worldPos
 */
export function confirmPaste(app, worldPos) {
    if (!isPastingClipboard(app) || clipboard.length === 0) return;

    const snapped = app.viewport.getSnappedPosition(worldPos);

    /** @type {Shape[]} */
    const pastedShapes = [];
    /** @type {Component[]} */
    const pastedComponents = [];

    for (const data of clipboard) {
        if (data._clipType === 'component') {
            const def = data._definition;
            if (!def) continue;
            const comp = new Component(def, {
                x: snapped.x + data._clipX,
                y: snapped.y + data._clipY,
                rotation: data.rot || 0,
                mirror: data.mir || false,
                reference: generateReference(app, def),
                value: data.val,
                packageId: data.pkg,
                showReference: data.sr,
                showValue: data.sv,
                properties: data.props
            });
            pastedComponents.push(comp);
        } else {
            // structuredClone is faster than JSON round-trip and handles all types
            const clone = structuredClone(data);
            // Pasted copies are new objects, so they start unlocked (as in the PCB editor).
            const { id, _clipX, _clipY, _clipType, cid, fk, att, lk, locked, ...shapeData } = clone;
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
 * @param {SchematicEditor} app
 */
export function cancelPaste(app) {
    if (app.pastePreviewGroup) {
        app.pastePreviewGroup.remove();
        app.pastePreviewGroup = null;
    }
    setPastingClipboard(app, false);
    app.interactionState = app.currentTool === 'select' ? 'idle' : 'toolActive';
    app.viewport.svg.style.cursor = '';

    // Paste preview always owns crosshair visibility while active.
    // On exit: hide in select mode, otherwise re-anchor to current cursor.
    const mousePos = app.viewport.currentMouseWorld || null;
    if (app.currentTool === 'select' && !isSchematicDrawingActive(app) && !isPlacingComponent(app)) {
        app.hideCrosshair?.();
    } else if (mousePos) {
        const snapped = app.viewport.getSnappedPosition(mousePos);
        app.showCrosshair?.();
        app.updateCrosshair?.(snapped);
    }
}

/**
 * Compute the centroid of serialized shape data, matching offsetShapeData logic.
 * @param {Record<string, any>} data
 * @returns {Point}
 */
function _getShapeDataCentroid(data) {
    const type = data.type;
    if (type === 'wire' && data.nd) {
        const nodeIds = Object.keys(data.nd);
        if (nodeIds.length > 0) {
            let sx = 0, sy = 0;
            for (const nid of nodeIds) { sx += data.nd[nid][0]; sy += data.nd[nid][1]; }
            return { x: sx / nodeIds.length, y: sy / nodeIds.length };
        }
    } else if ((type === 'line' || type === 'polygon' || type === 'polyline' || (type === 'wire' && data.pts)) && data.pts && data.pts.length >= 2) {
        let sx = 0, sy = 0;
        const n = data.pts.length / 2;
        for (let i = 0; i < data.pts.length; i += 2) { sx += data.pts[i]; sy += data.pts[i + 1]; }
        return { x: sx / n, y: sy / n };
    } else if (type === 'arc' && data.sp && data.ep && data.bp) {
        return {
            x: (data.sp.x + data.ep.x + data.bp.x) / 3,
            y: (data.sp.y + data.ep.y + data.bp.y) / 3
        };
    } else if (type === 'rect') {
        return { x: data.x + (data.w || 0) / 2, y: data.y + (data.h || 0) / 2 };
    }
    // text, circle, noconnect, net — x,y is the anchor
    return { x: data.x || 0, y: data.y || 0 };
}

/**
 * Reposition shape data so its centre lands on (tx, ty).
 * Different shape types store position differently.
 * @param {Record<string, any>} data
 * @param {number} tx
 * @param {number} ty
 */
function offsetShapeData(data, tx, ty) {
    const type = data.type;

    if (type === 'polyline' && data.ir === true && Array.isArray(data.cn)) {
        data.x = tx;
        data.y = ty;
    } else if (type === 'wire' && data.nd) {
        // Graph-based wire: nd is {nodeId: [x, y], ...}
        const nodeIds = Object.keys(data.nd);
        if (nodeIds.length > 0) {
            let sx = 0, sy = 0;
            for (const nid of nodeIds) { sx += data.nd[nid][0]; sy += data.nd[nid][1]; }
            const dx = tx - sx / nodeIds.length;
            const dy = ty - sy / nodeIds.length;
            for (const nid of nodeIds) { data.nd[nid][0] += dx; data.nd[nid][1] += dy; }
        }
    } else if (type === 'line' || type === 'polygon' || type === 'polyline' || (type === 'wire' && data.pts)) {
        // pts is a flat array [x0,y0,x1,y1,...]
        if (data.pts && data.pts.length >= 2) {
            let sx = 0, sy = 0, n = data.pts.length / 2;
            for (let i = 0; i < data.pts.length; i += 2) { sx += data.pts[i]; sy += data.pts[i + 1]; }
            const dx = tx - sx / n;
            const dy = ty - sy / n;
            for (let i = 0; i < data.pts.length; i += 2) { data.pts[i] += dx; data.pts[i + 1] += dy; }
        }
    } else if (type === 'arc') {
        if (data.sp && data.ep && data.bp) {
            const cx = (data.sp.x + data.ep.x + data.bp.x) / 3;
            const cy = (data.sp.y + data.ep.y + data.bp.y) / 3;
            const dx = tx - cx;
            const dy = ty - cy;
            data.sp.x += dx; data.sp.y += dy;
            data.ep.x += dx; data.ep.y += dy;
            data.bp.x += dx; data.bp.y += dy;
        }
    } else if (type === 'rect') {
        const w = data.w || 0;
        const h = data.h || 0;
        const cx = data.x + w / 2;
        const cy = data.y + h / 2;
        data.x += tx - cx;
        data.y += ty - cy;
    } else {
        // circle, text — use x, y as centre
        data.x = tx;
        data.y = ty;
    }
}

/**
 * Returns `true` if the internal clipboard array contains any items.
 * @returns {boolean}
 */
export function hasClipboard() {
    return clipboard.length > 0;
}
