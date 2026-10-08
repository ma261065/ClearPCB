import { beginDragSession, releaseDragSession } from './drag-session.js';
import { createShape } from '../../shapes/index.js';
import { Track } from '../../shapes/track.js';
import { Via } from '../../shapes/via.js';
import { Pad } from '../../shapes/pad.js';
import { CopperFill } from '../../shapes/copper-fill.js';
import { padLayers } from '../../shapes/pad-geometry.js';
import { AddTrackCommand } from '../../core/pcb-track-commands.js';
import { AddViaCommand } from '../../core/pcb-via-commands.js';
import { AddPadCommand } from '../../core/pcb-pad-commands.js';
import { AddBoardShapeCommand } from '../../core/pcb-shape-commands.js';
import { AddTextCommand } from '../../core/pcb-text-commands.js';
import { AddFillCommand } from '../../core/pcb-fill-commands.js';
import { batchDerivedUpdates } from '../../core/DerivedUpdates.js';
import { createPcbText } from './pcb-text.js';
import { removeTextElement } from './pcb-text-render.js';
import { isCopperPathShape, trackFromBoardShape } from '../../shared/pcb/copper-path-tracks.js';
import { cloneShapeGeometry, applyShapeGeometry } from '../../core/pcb-board-shapes.js';
import { translateShapeGeometry } from './board-shapes.js';
import { renderBoardShape, removeBoardShapeElement } from './board-shape-render.js';
import { updateCursorForTool } from './tool-lifecycle.js';
import { showBoardShapeProperties } from './board-shape-properties.js';
import { renderTrack, renderVia, removeTrackElements, removeViaElements } from './track-render.js';
import { renderPad, removePadElements } from './pad.js';
import { renderCopperFill, removeCopperFillElements } from './copper-fill-render.js';
import { isLayerLocked, isLayerVisible, isViaLocked, isViaVisible, isCopperFillLocked, isCopperFillVisible } from './layers.js';
import { getPcbSelectionEntries, setPcbSelection, syncPcbSelection } from './selection-registry.js';
import { renderPcbSelectionAnchors } from './selection-anchors.js';
import { reconcileRatsnest } from './ratsnest.js';
import { trackIsSelectable } from './track-select.js';
import { showPcbSelectionProperties } from './selection-interaction.js';
import { areDragOverlaysDeferred, isBoardViewRefreshSuspended, isFillRefreshPending, isFillRefreshSuspended, setFillRefreshPending, setFillRefreshSuspended, refreshBoardView } from './refresh-state.js';
import { isEditorActive } from './pcb-editor-api.js';
import { cancelPcbPosePreviews } from './edit-lifecycle.js';
import { forgetBoardShapeClearance, getBoardShapeClearance } from './clearance-overlay.js';
import { areShapeCopperCutsDeferred, setShapeCopperCutsDeferred } from './picture-refresh.js';
import { getPcbInteraction, setPcbInteraction } from './pcb-interactions.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */
/** @typedef {import('../../core/PcbDocument.js').PcbDocument} PcbDocument */
/** @typedef {{tracks:any[], vias:any[], pads:any[], shapes:any[], texts:any[], fills:any[], [kind:string]: any[]}} PcbPastePayload */
/** @typedef {{x:number,y:number}} Point */

/** @type {Array<keyof PcbPastePayload>} */
const kinds = ['tracks', 'vias', 'pads', 'shapes', 'texts', 'fills'];

/** @param {PcbEditor} app @param {any} clipboard @returns {PcbPastePayload} */
export function preparePcbPaste(app, clipboard) {
    let shapeId = app.pcbDocument.shapeIdCounter;
    const used = new Set(app.pcbDocument.boardShapes.map(shape => shape.id));
    const nextShapeId = () => {
        while (used.has(`pshape_${shapeId}`)) shapeId++;
        return `pshape_${shapeId++}`;
    };
    // Copper paths copied as board shapes (older clipboards) paste as Tracks.
    const copperPaths = (clipboard.shapes || []).filter(isCopperPathShape);
    const payload = /** @type {PcbPastePayload} */ ({
        tracks: [...(clipboard.tracks || []).map(/** @param {any} data */ data => {
            const json = structuredClone(data);
            delete json.id; delete json.i;
            const track = createShape(json);
            if (!(track instanceof Track)) throw new Error('PCB clipboard contains an invalid track.');
            return track;
        }), ...copperPaths.map(/** @param {any} shape */ shape => trackFromBoardShape(structuredClone(shape)))],
        vias: (clipboard.vias || []).map(/** @param {any} data */ data => Via.fromJSON({ ...data, id: undefined })),
        pads: (clipboard.pads || []).map(/** @param {any} data */ data => Pad.fromJSON({ ...data, id: undefined })),
        shapes: (clipboard.shapes || []).filter(/** @param {any} shape */ shape => !copperPaths.includes(shape)).map(/** @param {any} item */ ({ artwork, ...shape }) => ({
            ...structuredClone(shape), ...(artwork ? { artwork } : {}), id: nextShapeId(),
        })),
        texts: (clipboard.texts || []).map(/** @param {any} data */ data => createPcbText({ ...data, id: undefined })),
        fills: (clipboard.fills || []).map(/** @param {any} data */ data => new CopperFill({ ...structuredClone(data), id: undefined })),
    });
    // Pasted copies are new objects, so they start unlocked.
    for (const kind of kinds) for (const item of payload[kind]) item.locked = false;
    return payload;
}

/** @param {PcbPastePayload} payload */
function editable(payload) {
    /** @param {string} layer */
    const layerEditable = layer => !isLayerLocked(layer) && isLayerVisible(layer);
    return payload.tracks.every(trackIsSelectable)
        && payload.vias.every(via => !via.locked && via.visible !== false && !isViaLocked() && isViaVisible())
        && payload.pads.every(pad => !pad.locked && pad.visible !== false
            && padLayers(pad).every(layer => !isLayerLocked(layer)) && padLayers(pad).some(isLayerVisible))
        && [...payload.shapes, ...payload.texts].every(shape => !shape.locked && shape.visible !== false && layerEditable(shape.layer))
        && payload.fills.every(fill => !fill.locked && fill.visible !== false && !isLayerLocked(fill.layer)
            && !isCopperFillLocked(fill.layer) && isCopperFillVisible(fill.layer));
}

/**
 * Whether a floating paste is being placed.
 * @param {PcbEditor} app
 */
export function isPcbPasteActive(app) {
    return !!getPcbPaste(app);
}

/** @param {PcbEditor} app @returns {any} */
export function getPcbPaste(app) {
    return getPcbInteraction(app, '_pasteDrop');
}

/** @param {PcbEditor} app */
export function getPcbPastePreview(app) {
    return getPcbPaste(app)?.preview || null;
}

/** @param {PcbEditor} app */
export function isPcbPasteEditable(app) {
    const state = getPcbPaste(app);
    return !state || editable(state.payload);
}

/** @param {PcbDocument} document @param {PcbPastePayload} payload */
function assertFresh(document, payload) {
    for (const [current, added] of [[document.tracks, payload.tracks], [document.vias, payload.vias],
        [document.pads, payload.pads], [document.boardShapes, [...payload.shapes, ...payload.fills]],
        [[...document.texts.values()], payload.texts]]) {
        const ids = new Set(current.map(item => item.id));
        for (const item of added) {
            if (!item.id || ids.has(item.id)) throw new Error('PCB paste requires fresh, unique entities.');
            ids.add(item.id);
        }
    }
    if (payload.shapes.some(shape => shape.layer === 'board-outline')) throw new Error('The board outline cannot be pasted.');
}

/** @param {PcbEditor} app @param {PcbPastePayload} payload */
function removeArtwork(app, payload) {
    /** @param {string} id */
    const layer = id => app.getLayerGroup(id);
    payload.tracks.forEach(removeTrackElements);
    payload.vias.forEach(removeViaElements);
    payload.pads.forEach(removePadElements);
    for (const shape of payload.shapes) {
        removeBoardShapeElement(app, shape.id);
        const current = app.pcbDocument.boardShapes.find(item => item.id === shape.id && item !== shape);
        if (current) renderBoardShape(app, current, { liveDrag: true, skipCopperUpdate: true });
    }
    for (const text of payload.texts) {
        removeTextElement(app, text.id);
        const current = app.pcbDocument.texts.get(text.id);
        if (current && current !== text) app.refreshText(text.id);
        else {
            const clearance = getBoardShapeClearance(app, text.id);
            for (const element of clearance?.elements || []) element.remove();
            forgetBoardShapeClearance(app, text.id);
        }
    }
    for (const fill of payload.fills) {
        removeCopperFillElements(fill, layer);
        const current = app.pcbDocument.boardShapes.find(item => item.id === fill.id && item !== fill);
        if (current?.type === 'fill') renderCopperFill(/** @type {import('../../shapes/copper-fill.js').CopperFill} */ (/** @type {unknown} */ (current)), layer);
    }
}

/** @param {PcbEditor} app @param {PcbPastePayload} payload @param {boolean} preview */
function renderPayload(app, payload, preview) {
    /** @param {string} id */
    const layer = id => app.getLayerGroup(id);
    for (const track of payload.tracks) renderTrack(track, layer, {
        viaDiameter: app.getRoutingParams()?.viaDiameter, viaDrill: app.getRoutingParams()?.viaDrill,
    });
    payload.vias.forEach(via => renderVia(via, layer));
    payload.pads.forEach(pad => renderPad(pad, layer));
    for (const shape of payload.shapes) renderBoardShape(app, shape,
        { liveDrag: preview, skipCopperUpdate: preview, interactionOnly: preview });
    for (const text of payload.texts) app.refreshText(text.id);
    for (const fill of payload.fills) renderCopperFill(fill, layer, { outlineOnly: preview });
}

/** @param {PcbEditor} app */
function refreshAuthoredPaste(app) {
    app.updateCopperCuts();
    app.refreshClearanceHalos();
    reconcileRatsnest(app);
    if (!isBoardViewRefreshSuspended(app)) refreshBoardView(app);
}

class PastePcbCommand {
    /** @param {PcbEditor} app @param {PcbPastePayload} payload */
    constructor(app, payload) {
        this.description = 'Paste PCB objects';
        this.app = app;
        this.document = app.pcbDocument;
        this.payload = payload;
        this.applied = false;
        this.commands = [
            ...payload.tracks.map(item => new AddTrackCommand(this.document, item)),
            ...payload.vias.map(item => new AddViaCommand(this.document, item)),
            ...payload.pads.map(item => new AddPadCommand(this.document, item)),
            ...payload.shapes.map(item => new AddBoardShapeCommand(this.document, item)),
            ...payload.texts.map(item => new AddTextCommand(this.document, item)),
            ...payload.fills.map(item => new AddFillCommand(this.document, item)),
        ];
    }

    execute() {
        if (this.app.pcbDocument !== this.document) throw new Error('The paste document is no longer available.');
        assertFresh(this.document, this.payload);
        /** @type {Array<any>} */
        const applied = [];
        const counter = this.document.shapeIdCounter;
        try {
            batchDerivedUpdates(this.app, () => {
                for (const command of this.commands) { applied.push(command); command.execute(); }
                renderPayload(this.app, this.payload, false);
                syncPcbSelection(this.app);
                refreshAuthoredPaste(this.app);
            });
            this.applied = true;
        } catch (error) {
            for (const command of applied.reverse()) {
                if (command instanceof AddTextCommand && !this.document.texts.has(command.text.id)) continue;
                command.undo();
            }
            if (this.document.shapeIdCounter !== counter) this.document.shapeIdCounter = counter;
            removeArtwork(this.app, this.payload);
            syncPcbSelection(this.app);
            refreshAuthoredPaste(this.app);
            throw error;
        }
    }

    undo() {
        batchDerivedUpdates(this.app, () => {
            for (const command of [...this.commands].reverse()) command.undo();
            removeArtwork(this.app, this.payload);
            syncPcbSelection(this.app);
            refreshAuthoredPaste(this.app);
        });
        this.applied = false;
    }
}

/** @param {PcbEditor} app @param {PcbPastePayload} source @param {{select?: boolean}} [options] */
export function beginPcbPaste(app, source, { select = false } = {}) {
    if (!isEditorActive(app)) throw new Error('Cannot start a paste while the PCB editor is inactive.');
    cancelPcbPosePreviews(app);
    cancelPcbPaste(app);
    const payload = /** @type {PcbPastePayload} */ (Object.fromEntries(kinds.map(kind => [kind, [...(source[kind] || [])]])));
    if (!kinds.some(kind => payload[kind].length)) throw new Error('PCB paste requires at least one entity.');
    assertFresh(app.pcbDocument, payload);
    if (!editable(payload)) { app.setStatus('Cannot paste onto a hidden or locked layer.'); return false; }
    app.clearProperties();
    const points = [
        ...payload.tracks.flatMap(track => [...track.nodes.values()]),
        ...payload.vias, ...payload.pads, ...payload.texts,
        ...payload.shapes.flatMap(shape => shape.kind === 'circle' ? [shape] : shape.points || [shape.start, shape.end, shape.bulge]),
        ...payload.fills.flatMap(fill => fill.kind === 'circle' ? [fill] : fill.outline),
    ];
    if (!points.length || points.some(point => !Number.isFinite(point?.x) || !Number.isFinite(point?.y))) {
        throw new Error('PCB paste geometry requires finite positions.');
    }
    const model = app.pcbDocument;
    /** @type {any} */
    const state = {
        model, payload, select,
        selection: getPcbSelectionEntries(app).map(/** @param {{kind:string, object:any}} entry */ entry => ({ kind: entry.kind, object: entry.object })),
        anchorWorld: { x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
            y: points.reduce((sum, p) => sum + p.y, 0) / points.length },
        tracks: payload.tracks.map(track => ({ track, nodes: new Map([...track.nodes].map(([id, p]) => [id, { x: p.x, y: p.y }])) })),
        terminals: [...payload.vias, ...payload.pads, ...payload.texts].map(item => ({ item, x: item.x, y: item.y })),
        shapes: payload.shapes.map(shape => ({ shape, before: cloneShapeGeometry(shape) })),
        fills: payload.fills.map(fill => ({ fill, before: fill.captureState() })),
        preview: {
            tracks: [...model.tracks, ...payload.tracks], vias: [...model.vias, ...payload.vias],
            pads: [...model.pads, ...payload.pads], texts: new Map([...model.texts, ...payload.texts.map(text => /** @type {[string, any]} */ ([text.id, text]))]),
            boardShapes: [...model.boardShapes, ...payload.shapes, ...payload.fills],
        },
        flags: { deferredShapeCopperCuts: areShapeCopperCutsDeferred(app) },
        suspensions: { fill: isFillRefreshSuspended(app) },
        fillPending: isFillRefreshPending(app),
    };
    setPcbInteraction(app, '_pasteDrop', state);
    setFillRefreshSuspended(app, true);
    state.session = beginDragSession(app, { suspendBoardView: true });
    try {
        app.syncPcbHistoryButtons();
        if (select) setPcbSelection(app, payload.shapes.map(object => ({ kind: 'shape', object })));
        updatePcbPaste(app, app.viewport?.currentMouseWorld || { x: 0, y: 0 });
    } catch (error) {
        cancelPcbPaste(app);
        throw error;
    }
    return !!getPcbPaste(app);
}

/** @param {PcbEditor} app @param {Point} world */
export function updatePcbPaste(app, world) {
    const state = getPcbPaste(app);
    if (!state) return;
    try {
        if (app.pcbDocument !== state.model) throw new Error('The paste document is no longer available.');
        if (!isEditorActive(app) || !editable(state.payload)) { cancelPcbPaste(app); return; }
        if (!Number.isFinite(world?.x) || !Number.isFinite(world?.y)) throw new Error('PCB paste requires a finite pointer position.');
        const position = app.snapToGrid(world), dx = position.x - state.anchorWorld.x, dy = position.y - state.anchorWorld.y;
        if (dx === state.dx && dy === state.dy) return;
        state.dx = dx; state.dy = dy;
        app.viewport?.setCrosshair(position);
        if (app.viewport?.svg) app.viewport.svg.style.cursor = 'crosshair';
        for (const { track, nodes } of state.tracks) {
            for (const [id, point] of nodes) {
                const node = track.nodes.get(id);
                if (!node) throw new Error('A pasted track node is no longer available.');
                node.x = point.x + dx; node.y = point.y + dy;
            }
            track.invalidate();
        }
        for (const { item, x, y } of state.terminals) { item.x = x + dx; item.y = y + dy; }
        for (const { shape, before } of state.shapes) applyShapeGeometry(shape, translateShapeGeometry(before, dx, dy));
        for (const { fill, before } of state.fills) {
            if (fill.kind === 'circle') { fill.x = before.x + dx; fill.y = before.y + dy; }
            fill.outline.forEach((/** @type {Point} */ point, /** @type {number} */ index) => { point.x = before.outline[index].x + dx; point.y = before.outline[index].y + dy; });
        }
        renderPayload(app, state.payload, true);
        if (state.select) renderPcbSelectionAnchors(app);
    } catch (error) {
        cancelPcbPaste(app);
        throw error;
    }
}

/** @param {PcbEditor} app @param {any} state */
function release(app, state) {
    const pendingFill = isFillRefreshPending(app);
    setPcbInteraction(app, '_pasteDrop', null);
    releaseDragSession(app, state.session);
    setFillRefreshSuspended(app, state.suspensions.fill);
    setShapeCopperCutsDeferred(app, state.flags.deferredShapeCopperCuts);
    // Pours owed before the paste, or requested during it, remain owed.
    setFillRefreshPending(app, state.fillPending || pendingFill);
    updateCursorForTool(app);
    app.syncClipboardButtons();
    app.syncPcbHistoryButtons();
}

/** @param {PcbEditor} app */
function resumePendingFill(app) {
    if (isFillRefreshPending(app) && !areDragOverlaysDeferred(app) && !isFillRefreshSuspended(app)) app.refreshFills();
}

/** @param {PcbEditor} app */
export function cancelPcbPaste(app) {
    const state = getPcbPaste(app);
    if (!state) return;
    try {
        setPcbInteraction(app, '_pasteDrop', null);
        removeArtwork(app, state.payload);
        if (state.select) setPcbSelection(app, state.selection);
        else syncPcbSelection(app);
        renderPcbSelectionAnchors(app);
    } finally { release(app, state); }
    resumePendingFill(app);
    if (app.pcbDocument === state.model && isEditorActive(app)) showPcbSelectionProperties(app);
}

/** @param {PcbEditor} app */
export function endPcbPaste(app) {
    const state = getPcbPaste(app);
    if (!state) return;
    if (!isEditorActive(app) || !editable(state.payload)) { cancelPcbPaste(app); return; }
    const command = new PastePcbCommand(app, state.payload);
    try {
        if (app.pcbDocument !== state.model) throw new Error('The paste document is no longer available.');
        for (const { track, nodes } of state.tracks) {
            if (track.nodes.size !== nodes.size || [...nodes.keys()].some(id => !track.nodes.has(id))) {
                throw new Error('A pasted track node is no longer available.');
            }
        }
        assertFresh(state.model, state.payload);
        release(app, state);
        app.history.execute(command);
        if (state.select && state.payload.shapes.length === 1) showBoardShapeProperties(app, state.payload.shapes[0]);
        else showPcbSelectionProperties(app);
    } catch (error) {
        if (!command.applied && getPcbPaste(app) !== state) {
            removeArtwork(app, state.payload);
            if (state.select) setPcbSelection(app, state.selection);
        }
        throw error;
    } finally {
        if (getPcbPaste(app) === state) cancelPcbPaste(app);
        else if (!command.applied) resumePendingFill(app);
    }
}
