import { renderTrack, renderVia, removeTrackElements, removeViaElements } from './track-render.js';
import { reconcileRatsnest } from './track-draw.js';
import { clearTrackSelection, getSelectedTrack } from './track-select.js';
import { removeBoardShapeElement, renderBoardShape } from './board-shapes.js';
import { getBoardOutline } from './board-outline.js';
import { renderPad, removePadElements } from './pad.js';
import { serializeGridSettings, restoreGridSettings } from '../../ui/modules/viewport.js';
import { renderPanelPreview, resetPanelPreview } from './panelization-ui.js';
import { resetPcbSelection, syncPcbSelection } from './selection-registry.js';
import { clearPcbSelectionAnchors } from './selection-anchors.js';
import { refreshDesignSettings } from './design-settings.js';
import { PcbDocument } from '../../core/PcbDocument.js';

/** @param {any} app */
export function serializePcb(app) {
    return app.pcbDocument.serialize(serializeGridSettings(app.viewport));
}

export function preparePcb(data) {
    return PcbDocument.prepare(data);
}

/** @param {any} app */
export function loadPcb(app, data, prepared = preparePcb(data)) {
    if (prepared.data) data = prepared.data;
    resetPanelPreview(app);
    app.panelization = null;
    const render = app._active !== false;
    if (!render) app._stale = true;
    // Need a viewport in place before we can render into layer
    // groups (autosave-recovery may call this before the user has
    // ever activated the PCB tab).
    app._ensureViewport();
    app._cancelDrawingMode?.();
    app._closeBoardDimensionsDialog?.();
    // Deselection can redraw old objects, so do it before removing their SVG.
    resetPcbSelection(app);
    clearPcbSelectionAnchors(app);
    clearTrackSelection(app);
    // Remove entity SVG before clearing the model.
    for (const t of app.tracks) removeTrackElements(t);
    for (const v of app.vias) removeViaElements(v);
    for (const pad of app.pads) removePadElements(pad);
    for (const id of app._textElements.keys()) app._removeTextElement(id);
    for (const id of app._shapeElements.keys()) removeBoardShapeElement(app, id);
    app.pcbDocument.clear();
    app._hoveredShape = null;
    app._shapeDraw = null;
    app._shapeDrag = null;
    app._updateCopperCuts?.();
    // Copper pours live in boardShapes; clear their SVG state.
    app._clearFillGroups?.();
    app.history.clear?.();

    // A new/opened document invalidates any current DRC results, so close
    // the problem panel and clear its marker/leader.
    app._closeDRCPanel?.();
    app._drcSelectedId = null;
    app._clearDRCMarker?.();
    app._drcViolations = [];

    // Reset the board outline to "undrawn" so a document without board
    // dimensions (a brand-new board) prompts for them on activation, and a
    // loaded document gets a clean slate before its outline is restored.
    app._selectBoardOutline?.(false);
    app._getLayerGroup('board-outline')
        ?.querySelector('.pcb-board-outline')?.remove();
    app._boardOutlineDrawn = false;

    if (!data) {
        app.placements.clear();
        app.netlist = [];
        syncPcbSelection(app);
        app.markSectionClean();
        app._board3d?.refresh?.();
        return;
    }

    app.pcbDocument.loadContent(data, prepared);
    if (data.design) refreshDesignSettings(app);
    restoreGridSettings(app, data.settings);

    // Restore the saved board outline so it survives save/reopen and
    // autosave-recovery (the dimensions are part of the document).
    if (getBoardOutline(prepared) || (data.board && data.board.width > 0 && data.board.height > 0)) {
        if (render) app._drawBoardOutline();
        else app._boardOutlineDrawn = true;
    }

    if (data.placements && typeof data.placements === 'object') {
        if (render && app.placements.size) app._applyPlacementOverrides();
    }

    for (const track of app.tracks) {
        if (render) renderTrack(track, (id) => app._getLayerGroup(id), {
            viaDiameter: app._getRoutingParams?.()?.viaDiameter,
            viaDrill: app._getRoutingParams?.()?.viaDrill,
            hideNetLabel: track === getSelectedTrack(app),
        });
    }
    for (const via of app.vias) {
        if (render) renderVia(via, (id) => app._getLayerGroup(id));
    }
    for (const pad of app.pads) {
        if (render) renderPad(pad, (id) => app._getLayerGroup(id));
    }
    for (const shape of prepared.boardShapes) {
        if (!render || shape.type === 'fill' || shape.layer === 'board-outline') continue;
        renderBoardShape(app, shape, { skipCopperUpdate: true });
    }
    if (render) app._updateCopperCuts?.();
    for (const text of app.texts.values()) {
        if (render) app._renderText(text);
    }
    // Re-evaluate ratlines once the model is in place.
    if (render) {
        app._refreshClearanceHalos?.();
        reconcileRatsnest(app);
        // Compute and render the pours now that obstacles are loaded.
        app._refreshFills();
    }
    // Loading a document is not a user edit — start from a clean slate so
    // a freshly opened/recovered board isn't immediately treated as having
    // unsaved PCB changes (which would re-trigger autosave after a save).
    app.panelization = prepared.panelization;
    syncPcbSelection(app);
    if (render) renderPanelPreview(app);
    app._isDirty = false;
}
