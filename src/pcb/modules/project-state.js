import { renderTrack, renderVia, removeTrackElements, removeViaElements } from './track-render.js';
import { reconcileRatsnest } from './track-draw.js';
import { clearTrackSelection, getSelectedTrack } from './track-select.js';
import { cancelShapeDraw, endBoardShapeDrag, getBoardShapeDrag, removeBoardShapeElement, renderBoardShape } from './board-shapes.js';
import { clearTextElements, renderText } from './pcb-text-render.js';
import { getBoardOutline } from '../../shared/pcb/board-outline.js';
import { renderPad, removePadElements } from './pad.js';
import { serializeGridSettings, restoreGridSettings } from '../../shared/ui/viewport.js';
import { renderPanelPreview, resetPanelPreview } from './panelization-ui.js';
import { resetPcbSelection, syncPcbSelection } from './selection-registry.js';
import { clearPcbSelectionAnchors } from './selection-anchors.js';
import { refreshDesignSettings } from './design-settings.js';
import { PcbDocument } from '../../core/PcbDocument.js';
import { disposePcbPropertyEditors } from './edit-lifecycle.js';
import { setHoveredBoardShape } from './board-shape-state.js';
import { refreshBoardView } from './refresh-state.js';
import { isEditorActive } from './pcb-editor-api.js';
import { clearDrcResults, resetDrc } from './drc-state.js';
import { closeBoardDimensionsDialog, drawBoardOutline, selectBoardOutline, setBoardOutlineDrawn } from './board-outline-resize.js';
import { clearFillGroups } from './fill-refresh.js';

/** @param {any} app */
export function serializePcb(app) {
    return app.pcbDocument.serialize(serializeGridSettings(app.viewport));
}

export function preparePcb(data) {
    return PcbDocument.prepare(data);
}

/** @param {any} app */
export function loadPcb(app, data, prepared = preparePcb(data)) {
    app._cancelAutoRoute?.();
    if (prepared.data) data = prepared.data;
    resetPanelPreview(app);
    app.panelization = null;
    const render = isEditorActive(app);
    if (!render) app._stale = true;
    // Need a viewport in place before we can render into layer
    // groups (autosave-recovery may call this before the user has
    // ever activated the PCB tab).
    app._ensureViewport();
    app._cancelPosePreviews?.();
    disposePcbPropertyEditors(app);
    app._cancelDrawingMode?.();
    closeBoardDimensionsDialog(app);
    // Deselection can redraw old objects, so do it before removing their SVG.
    resetPcbSelection(app);
    clearPcbSelectionAnchors(app);
    clearTrackSelection(app);
    // Remove entity SVG before clearing the model.
    for (const t of app.tracks) removeTrackElements(t);
    for (const v of app.vias) removeViaElements(v);
    for (const pad of app.pads) removePadElements(pad);
    clearTextElements(app);
    for (const id of app._shapeElements.keys()) removeBoardShapeElement(app, id);
    app.pcbDocument.clear();
    resetDrc(app);
    setHoveredBoardShape(app, null);
    cancelShapeDraw(app);
    if (getBoardShapeDrag(app)) endBoardShapeDrag(app, false);
    app.updateCopperCuts?.();
    // Copper pours live in boardShapes; clear their SVG state.
    clearFillGroups(app);
    app.history.clear?.();

    // A new/opened document invalidates any current DRC results, so close
    // the problem panel and clear its marker/leader.
    clearDrcResults(app);

    // Reset the board outline to "undrawn" so a document without board
    // dimensions (a brand-new board) prompts for them on activation, and a
    // loaded document gets a clean slate before its outline is restored.
    selectBoardOutline(app, false);
    app.getLayerGroup('board-outline')
        ?.querySelector('.pcb-board-outline')?.remove();
    setBoardOutlineDrawn(app, false);

    if (!data) {
        app.placements.clear();
        app.netlist = [];
        syncPcbSelection(app);
        app.markSectionClean();
        refreshBoardView(app);
        return;
    }

    app.pcbDocument.loadContent(data, prepared);
    if (data.design) refreshDesignSettings(app);
    restoreGridSettings(app, data.settings);

    // Restore the saved board outline so it survives save/reopen and
    // autosave-recovery (the dimensions are part of the document).
    if (getBoardOutline(prepared) || (data.board && data.board.width > 0 && data.board.height > 0)) {
        if (render) drawBoardOutline(app);
        else setBoardOutlineDrawn(app, true);
    }

    if (data.placements && typeof data.placements === 'object') {
        if (render && app.placements.size) app._applyPlacementOverrides();
    }

    for (const track of app.tracks) {
        if (render) renderTrack(track, (id) => app.getLayerGroup(id), {
            viaDiameter: app.getRoutingParams?.()?.viaDiameter,
            viaDrill: app.getRoutingParams?.()?.viaDrill,
            hideNetLabel: track === getSelectedTrack(app),
        });
    }
    for (const via of app.vias) {
        if (render) renderVia(via, (id) => app.getLayerGroup(id));
    }
    for (const pad of app.pads) {
        if (render) renderPad(pad, (id) => app.getLayerGroup(id));
    }
    for (const shape of prepared.boardShapes) {
        if (!render || shape.type === 'fill' || shape.layer === 'board-outline') continue;
        renderBoardShape(app, shape, { skipCopperUpdate: true });
    }
    if (render) app.updateCopperCuts?.();
    for (const text of app.texts.values()) {
        if (render) renderText(app, text);
    }
    // Re-evaluate ratlines once the model is in place.
    if (render) {
        app.refreshClearanceHalos?.();
        reconcileRatsnest(app);
        // Compute and render the pours now that obstacles are loaded.
        app.refreshFills();
    }
    // Loading a document is not a user edit — start from a clean slate so
    // a freshly opened/recovered board isn't immediately treated as having
    // unsaved PCB changes (which would re-trigger autosave after a save).
    app.panelization = prepared.panelization;
    syncPcbSelection(app);
    if (render) renderPanelPreview(app);
    app._isDirty = false;
}
