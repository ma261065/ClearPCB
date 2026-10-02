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
import { cloneShapeGeometry, translateShapeGeometry, applyShapeGeometry, renderBoardShape,
    removeBoardShapeElement, showBoardShapeProperties } from './board-shapes.js';
import { renderTrack, renderVia, removeTrackElements, removeViaElements } from './track-render.js';
import { renderPad, removePadElements } from './pad.js';
import { renderCopperFill, removeCopperFillElements } from './copper-fill-render.js';
import { isLayerLocked, isLayerVisible, isViaLocked, isViaVisible, isCopperFillLocked, isCopperFillVisible } from './layers.js';
import { getPcbSelectionEntries, setPcbSelection, syncPcbSelection } from './selection-registry.js';
import { renderPcbSelectionAnchors } from './selection-anchors.js';
import { reconcileRatsnest } from './track-draw.js';
import { trackIsSelectable } from './track-select.js';
import { showPcbSelectionProperties } from './selection-interaction.js';
import { isFillRefreshPending, setFillRefreshPending } from './refresh-state.js';

const kinds = ['tracks', 'vias', 'pads', 'shapes', 'texts', 'fills'];

export function preparePcbPaste(app, clipboard) {
    let shapeId = app.pcbDocument.shapeIdCounter;
    const used = new Set(app.pcbDocument.boardShapes.map(shape => shape.id));
    const nextShapeId = () => {
        while (used.has(`pshape_${shapeId}`)) shapeId++;
        return `pshape_${shapeId++}`;
    };
    return {
        tracks: (clipboard.tracks || []).map(data => {
            const json = structuredClone(data);
            delete json.id; delete json.i;
            const track = createShape(json);
            if (!(track instanceof Track)) throw new Error('PCB clipboard contains an invalid track.');
            return track;
        }),
        vias: (clipboard.vias || []).map(data => Via.fromJSON({ ...data, id: undefined })),
        pads: (clipboard.pads || []).map(data => Pad.fromJSON({ ...data, id: undefined })),
        shapes: (clipboard.shapes || []).map(({ artwork, ...shape }) => ({
            ...structuredClone(shape), ...(artwork ? { artwork } : {}), id: nextShapeId(),
        })),
        texts: (clipboard.texts || []).map(data => createPcbText({ ...data, id: undefined })),
        fills: (clipboard.fills || []).map(data => new CopperFill({ ...structuredClone(data), id: undefined })),
    };
}

function editable(payload) {
    const layerEditable = layer => !isLayerLocked(layer) && isLayerVisible(layer);
    return payload.tracks.every(trackIsSelectable)
        && payload.vias.every(via => !via.locked && via.visible !== false && !isViaLocked() && isViaVisible())
        && payload.pads.every(pad => !pad.locked && pad.visible !== false
            && padLayers(pad).every(layer => !isLayerLocked(layer)) && padLayers(pad).some(isLayerVisible))
        && [...payload.shapes, ...payload.texts].every(shape => !shape.locked && shape.visible !== false && layerEditable(shape.layer))
        && payload.fills.every(fill => !fill.locked && fill.visible !== false && !isLayerLocked(fill.layer)
            && !isCopperFillLocked(fill.layer) && isCopperFillVisible(fill.layer));
}

export function isPcbPasteEditable(app) {
    return !app._pasteDrop || editable(app._pasteDrop.payload);
}

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

function removeArtwork(app, payload) {
    payload.tracks.forEach(removeTrackElements);
    payload.vias.forEach(removeViaElements);
    payload.pads.forEach(removePadElements);
    for (const shape of payload.shapes) {
        removeBoardShapeElement(app, shape.id, { skipHatchUpdate: true });
        const current = app.pcbDocument.boardShapes.find(item => item.id === shape.id && item !== shape);
        if (current) renderBoardShape(app, current, { liveDrag: true, skipCopperUpdate: true });
    }
    for (const text of payload.texts) {
        app._removeTextElement(text.id);
        const current = app.pcbDocument.texts.get(text.id);
        if (current && current !== text) app.refreshText(text.id);
        else {
            const clearance = app._boardShapeClearanceCache?.get(text.id);
            for (const element of clearance?.elements || []) element.remove();
            app._boardShapeClearanceCache?.delete(text.id);
        }
    }
    for (const fill of payload.fills) {
        removeCopperFillElements(fill, id => app.getLayerGroup(id));
        const current = app.pcbDocument.boardShapes.find(item => item.id === fill.id && item !== fill);
        if (current?.type === 'fill') renderCopperFill(current, id => app.getLayerGroup(id));
    }
}

function renderPayload(app, payload, preview) {
    const layer = id => app.getLayerGroup(id);
    for (const track of payload.tracks) renderTrack(track, layer, {
        viaDiameter: app.getRoutingParams?.()?.viaDiameter, viaDrill: app.getRoutingParams?.()?.viaDrill,
    });
    payload.vias.forEach(via => renderVia(via, layer));
    payload.pads.forEach(pad => renderPad(pad, layer));
    for (const shape of payload.shapes) renderBoardShape(app, shape,
        { liveDrag: preview, skipCopperUpdate: preview, interactionOnly: preview });
    for (const text of payload.texts) app.refreshText(text.id);
    for (const fill of payload.fills) renderCopperFill(fill, layer, { outlineOnly: preview });
}

function refreshAuthoredPaste(app) {
    app.updateCopperCuts?.();
    app.refreshClearanceHalos?.();
    reconcileRatsnest(app);
    if (!app._suspendBoardViewRefresh) app._board3d?.refresh?.();
}

class PastePcbCommand {
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
        const applied = [], counter = this.document.shapeIdCounter;
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

export function beginPcbPaste(app, source, { select = false } = {}) {
    if (app._active === false) throw new Error('Cannot start a paste while the PCB editor is inactive.');
    app._cancelPosePreviews?.();
    cancelPcbPaste(app);
    const payload = Object.fromEntries(kinds.map(kind => [kind, [...(source[kind] || [])]]));
    if (!kinds.some(kind => payload[kind].length)) throw new Error('PCB paste requires at least one entity.');
    assertFresh(app.pcbDocument, payload);
    if (!editable(payload)) { app.setStatus?.('Cannot paste onto a hidden or locked layer.'); return false; }
    app.clearProperties?.();
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
    const state = {
        model, payload, select,
        selection: getPcbSelectionEntries(app).map(entry => ({ kind: entry.kind, object: entry.object })),
        anchorWorld: { x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
            y: points.reduce((sum, p) => sum + p.y, 0) / points.length },
        tracks: payload.tracks.map(track => ({ track, nodes: new Map([...track.nodes].map(([id, p]) => [id, { x: p.x, y: p.y }])) })),
        terminals: [...payload.vias, ...payload.pads, ...payload.texts].map(item => ({ item, x: item.x, y: item.y })),
        shapes: payload.shapes.map(shape => ({ shape, before: cloneShapeGeometry(shape) })),
        fills: payload.fills.map(fill => ({ fill, before: fill.captureState() })),
        preview: {
            tracks: [...model.tracks, ...payload.tracks], vias: [...model.vias, ...payload.vias],
            pads: [...model.pads, ...payload.pads], texts: new Map([...model.texts, ...payload.texts.map(text => [text.id, text])]),
            boardShapes: [...model.boardShapes, ...payload.shapes, ...payload.fills],
        },
        flags: Object.fromEntries(['_deferDragOverlays', '_suspendFillRefresh', '_suspendBoardViewRefresh',
            '_deferredShapeCopperCuts'].map(key => [key, app[key]])),
        fillPending: isFillRefreshPending(app),
    };
    app._pasteDrop = state;
    app._deferDragOverlays = app._suspendFillRefresh = app._suspendBoardViewRefresh = true;
    try {
        app._syncHistoryButtons?.();
        if (select) setPcbSelection(app, payload.shapes.map(object => ({ kind: 'shape', object })));
        updatePcbPaste(app, app.viewport?.currentMouseWorld || { x: 0, y: 0 });
    } catch (error) {
        cancelPcbPaste(app);
        throw error;
    }
    return !!app._pasteDrop;
}

export function updatePcbPaste(app, world) {
    const state = app._pasteDrop;
    if (!state) return;
    try {
        if (app.pcbDocument !== state.model) throw new Error('The paste document is no longer available.');
        if (app._active === false || !editable(state.payload)) { cancelPcbPaste(app); return; }
        if (!Number.isFinite(world?.x) || !Number.isFinite(world?.y)) throw new Error('PCB paste requires a finite pointer position.');
        const position = app._snapToGrid(world), dx = position.x - state.anchorWorld.x, dy = position.y - state.anchorWorld.y;
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
            fill.outline.forEach((point, index) => { point.x = before.outline[index].x + dx; point.y = before.outline[index].y + dy; });
        }
        renderPayload(app, state.payload, true);
        if (state.select) renderPcbSelectionAnchors(app);
    } catch (error) {
        cancelPcbPaste(app);
        throw error;
    }
}

function release(app, state) {
    const pendingFill = isFillRefreshPending(app);
    app._pasteDrop = null;
    Object.assign(app, state.flags);
    // Pours owed before the paste, or requested during it, remain owed.
    setFillRefreshPending(app, state.fillPending || pendingFill);
    app._updateCursorForTool?.();
    app.syncClipboardButtons?.();
    app._syncHistoryButtons?.();
}

function resumePendingFill(app) {
    if (isFillRefreshPending(app) && !app._deferDragOverlays && !app._suspendFillRefresh) app.refreshFills?.();
}

export function cancelPcbPaste(app) {
    const state = app._pasteDrop;
    if (!state) return;
    try {
        app._pasteDrop = null;
        removeArtwork(app, state.payload);
        if (state.select) setPcbSelection(app, state.selection);
        else syncPcbSelection(app);
        renderPcbSelectionAnchors(app);
    } finally { release(app, state); }
    resumePendingFill(app);
    if (app.pcbDocument === state.model && app._active !== false) showPcbSelectionProperties(app);
}

export function endPcbPaste(app) {
    const state = app._pasteDrop;
    if (!state) return;
    if (app._active === false || !editable(state.payload)) { cancelPcbPaste(app); return; }
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
        if (!command.applied && app._pasteDrop !== state) {
            removeArtwork(app, state.payload);
            if (state.select) setPcbSelection(app, state.selection);
        }
        throw error;
    } finally {
        if (app._pasteDrop === state) cancelPcbPaste(app);
        else if (!command.applied) resumePendingFill(app);
    }
}
