import { renderTrack, renderVia, removeTrackElements, removeViaElements } from './track-render.js';
import { reconcileRatsnest } from './track-draw.js';
import { clearTrackSelection, getSelectedTrack } from './track-select.js';
import { serializeBoardShapes, loadBoardShapes, removeBoardShapeElement, renderBoardShape } from './board-shapes.js';
import { validBoardOutline, getBoardOutline, syncBoardOutlineDimensions } from './board-outline.js';
import { renderPad, removePadElements } from './pad.js';
import { updateFillIdCounter } from '../../shapes/copper-fill.js';
import { serializeGridSettings, restoreGridSettings } from '../../ui/modules/viewport.js';
import { panelSettings } from './panelization.js';
import { renderPanelPreview, resetPanelPreview } from './panelization-ui.js';
import { defaultPcbStackup } from '../../core/project-format.js';
import { compactProjectAliases } from '../../core/project-field-aliases.js';
import { hasRectangleFrame, rectangleFramePoints } from '../../shapes/rectangle-frame.js';
import { resetPcbSelection, syncPcbSelection } from './selection-registry.js';
import { clearPcbSelectionAnchors } from './selection-anchors.js';
import { applyDesignSettings } from './design-settings.js';
import { PcbDesignSettings } from '../../core/PcbDesignSettings.js';
import { PcbDocument } from '../../core/PcbDocument.js';

const round4 = value => Number.isFinite(value) ? Math.round(value * 10000) / 10000 : value;

/** @param {any} app */
export function serializePcb(app) {
    const pcb = {
        stackup: defaultPcbStackup(),
        board: {
            width: round4(app._boardWidth),
            height: round4(app._boardHeight),
            radius: round4(app._boardRadius),
        },
        design: app.designSettings.serialize(),
        ...(app.panelization ? { panelization: panelSettings(app.panelization) } : {}),
        settings: serializeGridSettings(app.viewport),
        ...app.pcbDocument.serializeEntities(),
        boardShapes: serializeBoardShapes(app),
        placements: app.placementState.serialize(),
    };
    return compactProjectAliases({ pcb }).pcb;
}

export function preparePcb(data) {
    const entities = PcbDocument.prepareEntities(data);
    data = entities.data;
    if (data?.design) new PcbDesignSettings().update(data.design);
    const panelization = data?.panelization ? panelSettings(data.panelization) : null;
    for (const shape of data?.boardShapes || []) {
        const outline = shape.kind === 'rect' && hasRectangleFrame(shape)
            ? { ...shape, points: rectangleFramePoints(shape) } : shape;
        if (shape.layer === 'board-outline' && !validBoardOutline(outline)) {
            throw new Error('The board outline must be one closed rectangle, polygon, or circle.');
        }
    }
    const stage = { boardShapes: [], _shapeIdCounter: 1 };
    loadBoardShapes(stage, data?.boardShapes, { render: false, strict: true });
    const outlines = stage.boardShapes.filter(shape => shape.layer === 'board-outline');
    if (outlines.length > 1 || outlines.some(shape => !validBoardOutline(shape))) {
        throw new Error('The board outline must be one closed rectangle, polygon, or circle.');
    }
    return { ...entities,
        boardShapes: stage.boardShapes, shapeIdCounter: stage._shapeIdCounter, panelization };
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
    app.pcbDocument.clearEntities();
    for (const id of app._shapeElements.keys()) removeBoardShapeElement(app, id);
    app.boardShapes.length = 0;
    app._shapeIdCounter = 1;
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
    app._boardWidth = 100;
    app._boardHeight = 80;
    app._boardRadius = 0;

    // Restore manual footprint position overrides. These are applied when
    // _placeFootprints rebuilds the placements from the schematic; if
    // placements already exist (sync ran first), re-apply immediately.
    app._placementOverrides.clear();

    if (!data) {
        app.placements.clear();
        app.netlist = [];
        syncPcbSelection(app);
        app.markSectionClean();
        app._board3d?.refresh?.();
        return;
    }

    // Restore per-project design parameters (track/clearance/via sizes,
    // units, router) onto the ribbon inputs.
    app._applyProjectDesignParams(data.design);
    restoreGridSettings(app, data.settings);

    // Restore the saved board outline so it survives save/reopen and
    // autosave-recovery (the dimensions are part of the document).
    if (getBoardOutline(prepared) || (data.board && data.board.width > 0 && data.board.height > 0)) {
        app._boardWidth = data.board?.width || 100;
        app._boardHeight = data.board?.height || 80;
        app._boardRadius = data.board?.radius || 0;
        const outline = prepared.boardShapes.find(shape => shape.layer === 'board-outline');
        if (outline) app.boardShapes.push(outline);
        if (outline) syncBoardOutlineDimensions(app);
        if (render) app._drawBoardOutline();
        else app._boardOutlineDrawn = true;
    }

    if (data.placements && typeof data.placements === 'object') {
        app.placementState.load(data.placements);
        if (render && app.placements.size) app._applyPlacementOverrides();
    }

    app.pcbDocument.loadEntities(data, prepared);
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
    app._shapeIdCounter = prepared.shapeIdCounter;
    for (const shape of prepared.boardShapes) {
        if (!app.boardShapes.includes(shape)) app.boardShapes.push(shape);
        if (shape.type === 'fill') updateFillIdCounter(shape.id);
        else if (render) renderBoardShape(app, shape, { skipCopperUpdate: true });
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
    app.panelization = prepared.panelization ? { ...prepared.panelization } : null;
    syncPcbSelection(app);
    if (render) renderPanelPreview(app);
    app._isDirty = false;
}

/** @param {any} app */
export function applyProjectDesignParams(app, design) {
    applyDesignSettings(app, design);
}
