// PCBApp.js - PCB Editor Application

import { serializePcb, preparePcb, loadPcb } from '../pcb/modules/project-state.js';
import { bindPcbControls } from '../pcb/modules/controls.js';
import { Viewport } from '../core/Viewport.js';
import { ensurePcbViewport } from '../pcb/modules/viewport-host.js';
import { snapToViewportGrid } from '../core/grid-snap.js';
import { errorMessage } from '../core/errors.js';
import { PcbDocument } from '../core/PcbDocument.js';
import { isEditorActive, isEditorStale, setEditorActive, setEditorStale } from '../pcb/modules/pcb-editor-api.js';
import { loadAndApplyTheme } from '../shared/ui/theme.js';
import { showAlert } from '../shared/ui/modal.js';
import { updateGridDropdown, serializeGridSettings } from '../shared/ui/viewport.js';
import { setInlineTextInputActive } from '../shared/ui/inline-text-overlay.js';
import { isLayerVisible, pcbLayerName } from '../pcb/modules/layers.js';
import { disposeDrcRefresh, invalidateDrcRefresh } from '../pcb/modules/drc-refresh.js';
import {
    disposeDrc,
    drcShouldRun,
    initDrc,
    peekDrcPresentation,
    scheduleDrc,
} from '../pcb/modules/drc-state.js';
import { cancelPcbPosePreviews, disposePcbPropertyEditors, hasPcbEditInProgress } from '../pcb/modules/edit-lifecycle.js';
import { handlePcbKeyDown } from '../pcb/modules/keyboard.js';
import { showSaveToast } from '../pcb/modules/save-toast.js';
import { cancelPcbDrawingMode, syncPcbToolBlocks, updateCursorForTool } from '../pcb/modules/tool-lifecycle.js';
import { pcbToolLayer, pcbToolTip } from '../pcb/modules/pcb-tools.js';
import { renderPanelPreview } from '../pcb/modules/panelization-ui.js';
import { openBoard3DViewer } from '../pcb/modules/board3d.js';
import { savePcbPdf, printPcb } from '../pcb/modules/pcb-export.js';
import { refreshTrackDrawPreview } from '../pcb/modules/track-draw.js';
import { reconcileRatsnest } from '../pcb/modules/ratsnest.js';
import { refreshTrackSelectionHalo } from '../pcb/modules/copper-halos.js';
import { AddTrackCommand, FlipPlacementCommand, RotatePlacementCommand } from '../pcb/modules/track-commands.js';
import { RemoveTextCommand, EditTextCommand } from '../pcb/modules/text-commands.js';
import { cancelShapeDraw } from '../pcb/modules/board-shape-draw.js';
import { renderPcbSelectionAnchors } from '../pcb/modules/selection-anchors.js';
import { boardShapeLocked, createPcbHistory } from '../pcb/modules/object-locks.js';
import { renderPropertyActions, renderPropertyFields } from '../shared/ui/property-fields.js';
import { refreshAxisGlow } from '../pcb/modules/axis-glow.js';
import { scheduleFillRefresh, invalidateFillRefresh, disposeFillRefresh } from '../pcb/modules/fill-refresh.js';
import {
    refreshBoxSelectionHighlights,
    deleteBoxSelection,
} from '../pcb/modules/box-select.js';
import { selectAllPcbObjects, selectPcbComponent, selectPcbText } from '../pcb/modules/selection-actions.js';
import { hasPcbClipboardData, canCopyCutPcbSelection, copyPcbSelection, cutPcbSelection, pastePcbSelection } from '../pcb/modules/pcb-clipboard.js';
import {
    showPcbSelectionProperties,
    finishSelectionInteraction,
} from '../pcb/modules/selection-interaction.js';
import { getPcbSelection, isPcbSelected } from '../pcb/modules/selection-registry.js';
import { worldToPlacementLocal } from '../pcb/modules/ref-text-geometry.js';
import { CommandHistory } from '../core/CommandHistory.js';
import { Track } from '../shapes/track.js';
import { Via } from '../shapes/via.js';
import { Pad } from '../shapes/pad.js';
import '../pcb/modules/pad-selection.js';
import { updateCopperCuts } from '../pcb/modules/copper-cuts.js';
import { initDebugTooltip } from '../pcb/modules/debug-tooltip.js';
import { bindPcbMouseEvents } from '../pcb/modules/mouse.js';
import '../pcb/modules/layer-changes.js';
import { ModifyFillCommand } from '../pcb/modules/copper-fill-commands.js';
import { startFillEditAt, updateFillEdit, endFillEdit, deleteSelectedFill as deleteFocusedOrSelectedFill } from '../pcb/modules/copper-fill-edit.js';
import { updatePcbCulling } from '../pcb/modules/component-selection.js';
import { refreshText as refreshPcbText } from '../pcb/modules/pcb-text-render.js';
import { drawRefOverlay, isRefTextLocked, refreshRefHighlight, rerenderRef, RotateRefTextCommand } from '../pcb/modules/ref-text-selection.js';
import { displayedCollection } from '../pcb/modules/displayed-collections.js';
import { isPcbPasteActive } from '../pcb/modules/pcb-paste.js';
import { getBoardOutline, boardBoundary } from '../shared/pcb/board-outline.js';
import { scheduleSchematicPcbSync, syncFromSchematic, renderPcbFootprint, applyPlacementOverrides as applyPlacementOverridesFromSchematic, initializeSchematicSyncState } from '../pcb/modules/schematic-sync.js';
import { getPropertyEditor, setPropertyEditor } from '../pcb/modules/property-editors.js';
import { getBoardViewPanel, getLastBoard2DSide, isFillRefreshPending, onRefreshSuspended, refreshBoardViewPanel, setLastBoard2DSide } from '../pcb/modules/refresh-state.js';
import {
    initializeBoardOutlineState,
    isBoardOutlineDrawn as boardOutlineDrawn,
    showBoardDimensionsDialog,
    showBoardOutlineProperties,
} from '../pcb/modules/board-outline-resize.js';
import { showTextProperties, bindStrokeTextProps } from '../pcb/modules/text-properties.js';
import { getComponentProperties } from '../pcb/modules/component-properties-host.js';
import { showPadEditor } from '../pcb/modules/pad-properties.js';
import { clearPadPreview, getPadPreviewWorld, getPadToolDefaults, updatePadPreview } from '../pcb/modules/pad-tool.js';
import { clearViaPreview, clearViaRing } from '../pcb/modules/via-tool.js';
import { multiPropertyCapabilities, showMultiSelectionProperties } from '../pcb/modules/multi-selection-properties.js';
import { activeTextInlineEdit, startTextInlineEdit, endTextInlineEdit } from '../pcb/modules/text-inline-edit.js';
import { showClearances, refreshClearanceHalos, refreshViaClearance } from '../pcb/modules/clearance-overlay.js';
import { hideNetTooltip } from '../pcb/modules/net-tooltip.js';
import { isAutorouterActive, runAutoRoute as runAutoRouteAction, cancelAutoRoute as cancelAutoRouteAction, disposeAutorouter, clearRoutes as clearPcbRoutes } from '../pcb/modules/autorouter-actions.js';
import { selectPcbFill } from '../pcb/modules/copper-fill-selection.js';

/**
 * Padding (mm) added around a reference designator's tight glyph bounding box
 * for both its selection outline and its drag grab region, so the box sits
 * comfortably around the label instead of touching the strokes.
 */

// Raising a suspension invalidates in-flight derived work on the editor, as its
// former property setters did. Other objects (test doubles) are unaffected.
onRefreshSuspended('overlays', /** @param {unknown} app */ (app) => {
    if (!(app instanceof PCBApp)) return;
    invalidateFillRefresh(app);
    invalidateDrcRefresh(app);
});
onRefreshSuspended('fill', /** @param {unknown} app */ (app) => {
    if (app instanceof PCBApp) invalidateDrcRefresh(app);
});

/**
 * Put the crosshair on a dragged footprint's placement origin: the point the grid snaps,
 * so the crosshair always sits on the grid point the part is moving to.
 * @param {import('../pcb/modules/pcb-editor-api.js').PcbEditor} app
 * @param {import('../core/pcb-placement-geometry.js').Placement|null|undefined} pl
 */
function showFootprintCrosshair(app, pl) {
    if (!pl || !app.viewport?.setCrosshair) return;
    app.viewport.setCrosshair({ x: pl.x, y: pl.y });
}

/**
 * PCB editor application.
 *
 * Keeps the PCB canvas in sync with the schematic: whenever the
 * schematic changes (undo/redo, shape add/remove, file load) the
 * PCB is marked stale and rebuilt the next time the pane becomes
 * visible.  If the PCB pane is already visible the rebuild happens
 * immediately (debounced).
 *
 * @typedef {ReturnType<import('../core/PcbDesignSettings.js').PcbDesignSettings['getRoutingParams']>} RoutingParams
 * @typedef {{x: number, y: number}} Point
 * @typedef {import('../pcb/modules/pcb-editor-api.js').PcbEditor} PcbEditor
 * @typedef {import('../core/ProjectDocument.js').ProjectDocument} ProjectDocument
 * @typedef {import('../core/pcb-placement-geometry.js').Placement} Placement
 * @typedef {import('../core/pcb-placement-geometry.js').PadOffset} PadOffset
 * @typedef {import('../core/netlist.js').NetlistEntry} NetlistEntry
 * @typedef {import('../core/pcb-text.js').PcbText} PcbText
 * @typedef {import('../shapes/copper-fill.js').CopperFill} CopperFill
 * @typedef {import('../pcb/modules/selection-registry.js').PcbSelectionValue} PcbSelectionEntry
 * @typedef {{id: string, content: string, x: number, y: number, size: number, rotation: number, strokeWidth: number, layer: string, [key: string]: any}} InlineTextModel
 * @typedef {{componentId?: string|null, isNewPlacement?: boolean, select?: () => void, prepare?: () => void,
 *   render?: () => void, transform?: () => string, localX?: (point: Point) => number, [key: string]: any}} InlineTextOptions
 */

/**
 * Every net on the board or in the netlist, sorted.
 * @param {PcbEditor} app
 * @returns {string[]}
 */
function boardNetNames(app) {
    const names = new Set((app.netlist || []).map(/** @param {NetlistEntry} entry */ (entry) => String(entry.net || '')).filter(Boolean));
    for (const source of [app.tracks, app.vias, app.pads, app.boardShapes, app.copperFills]) {
        for (const item of source || []) {
            const net = String(item?.net || '');
            if (net) names.add(net);
        }
    }
    return [...names].sort();
}

export default class PCBApp {
    // While a preview runs, these are its detached copies (displayed-collections.js).
    get tracks() { return displayedCollection(this, 'tracks'); }
    set tracks(value) { this.pcbDocument.tracks = value; }
    get vias() { return displayedCollection(this, 'vias'); }
    set vias(value) { this.pcbDocument.vias = value; }
    get pads() { return displayedCollection(this, 'pads'); }
    set pads(value) { this.pcbDocument.pads = value; }
    get texts() { return displayedCollection(this, 'texts'); }
    set texts(value) { this.pcbDocument.texts = value; }
    get boardShapes() { return displayedCollection(this, 'boardShapes'); }
    set boardShapes(value) { this.pcbDocument.boardShapes = value; }
    get panelization() { return this.pcbDocument.panelization; }
    set panelization(value) { this.pcbDocument.loadPanelization(value); }

    /** CopperFill entries owned by the canonical board-shape collection. */
    get copperFills() {
        return this.pcbDocument.copperFills;
    }

    /** @param {import('../core/ProjectDocument.js').ProjectDocument} [project] */
    constructor(project) {
        this.project = project || null;
        this.pcbDocument = project ? project.pcbDocument : new PcbDocument();
        this.placementState = this.pcbDocument.placementState;
        this.designSettings = this.pcbDocument.designSettings;
        this.ribbon = document.getElementById('ribbonPCB');
        this.canvasContainer = document.getElementById('pcbCanvasContainer');
        this.status = {
            cursorPos: document.getElementById('pcbCursorPos'),
            gridSnap: document.getElementById('pcbGridSnap'),
            viewportInfo: document.getElementById('pcbViewportInfo'),
            zoomPercent: document.getElementById('pcbZoomPercent'),
            tipStatus: document.getElementById('pcbStatusTip'),
            modeStatus: document.getElementById('pcbModeStatus'),
            docTitle: document.getElementById('pcbDocTitle')
        };

        this._initialized = false;
        setEditorActive(this, false);
        /** @type {Viewport|null} */
        this.viewport = null;
        /** @type {number|undefined} Last zoom scale used to size selected-track halos. */
        this.lastHaloScale = undefined;
        /** @type {(() => void)|null} Refresh the ribbon's view toggles (set by controls.js). */
        this.syncPcbViewToggles = null;
        this.currentTool = 'select';
        this.activeLayer = 'top-copper';
        /** @type {(() => void)|null} Refreshes renderer-owned PCB ribbon state. */
        this.refreshPcbRibbon = null;
        /** @type {((tabId: string, userInitiated?: boolean) => void)|null} */
        this.activatePcbRibbonTab = null;
        /** @type {(() => void)|null} Retains the measured PCB ribbon height. */
        this.retainPcbRibbonHeight = null;

        /**
         * SVG <g> elements keyed by layer id.
         * @type {Map<string, SVGGElement>}
         */
        this._layerGroups = new Map();
        /**
         * Placed footprint data for ratsnest computation.
         * Map of componentId → { x, y, pads: Map<padId, {x,y,number}>, element }
         * where padId uniquely identifies a physical pad (it equals the pad
         * number except for duplicate-numbered pads, which get a "#k" suffix).
         * @type {Map<string, import('../core/pcb-placement-geometry.js').Placement>}
         */
        this.placements = new Map();
        /**
         * User-customised footprint positions, keyed by component id. The
         * placement Map itself is rebuilt from the schematic on every sync
         * (grid auto-layout), so manual moves must be remembered here and
         * persisted, otherwise a moved footprint snaps back to its grid slot
         * after autosave + reload.
         * This aliases the project-owned saved placement state.
         * @type {Map<string, import('../core/PcbPlacementState.js').PlacementOverride>}
         */
        this._placementOverrides = this.placementState.overrides;
        /** @type {import('../core/netlist.js').NetlistEntry[]} Cached netlist from last sync */
        this.netlist = [];

        /** Currently selected CopperFill, or null. */
        /** True when the schematic has changed since last PCB rebuild */
        setEditorStale(this, true);
        initializeSchematicSyncState(this);
        initializeBoardOutlineState(this, !!getBoardOutline(this));
        /** @type {Record<string, HTMLElement|undefined>|null} Ribbon control elements (set by controls.js) */
        this.ui = null;

        // ── Selection & drag state ────────────────────────────
        // Board-shape SVG elements, hover, node/segment focus and tool defaults live in the board-shape modules.

        /**
         * Undo/redo for PCB-side edits (tracks, vias, vertex drags,
         * property tweaks), guarded by the lock gate. Separate from the
         * schematic's history.
         * @type {CommandHistory}
         */
        this.history = createPcbHistory(this, {
            // Flag PCB as having unsaved changes so the schematic-side
            // autosave (which serialises the combined document) fires.
            // Setting a private flag here \u2014 rather than calling
            // schematic.fileManager.setDirty() \u2014 avoids triggering
            // the schematic\u2192PCB stale-sync listener that would
            // otherwise rebuild and wipe PCB-only edits.
            onChanged: () => this._onHistoryChanged(),
            onRefused: error => showSaveToast(this, errorMessage(error)),
        });
        /** Document-change hook installed by ProjectDocument. @type {(() => void)|null} */
        this.onDocumentChanged = null;
    }

    initialize() {
        if (this._initialized) return;

        bindPcbControls(this);
        initDebugTooltip(this);
        this._bindThemeToggle();
        loadAndApplyTheme();
        this.refreshPcbRibbon?.();
        initDrc(this);

        this._initialized = true;
    }

    preload() {
        if (isEditorActive(this) || !isEditorStale(this)) return false;
        this.initialize();
        this.ensureViewport();
        setEditorActive(this, true);
        try {
            syncFromSchematic(this);
        } finally {
            setEditorActive(this, false);
        }
        return !isEditorStale(this);
    }

    /**
     * Whether this is the active editor. For the schematic editor's keyboard, which stands
     * aside while the PCB is active and may not import PCB modules (pcb-editor-api.js).
     * @returns {boolean}
     */
    isActive() {
        return isEditorActive(this);
    }

    activate() {
        this.initialize();
        setEditorActive(this, true);
        setInlineTextInputActive(activeTextInlineEdit(this)?.input, true);

        const retainRibbonHeight = this.retainPcbRibbonHeight || /** @type {{_retainRibbonHeight?: () => void}} */ (this)._retainRibbonHeight;
        retainRibbonHeight?.();
        this.ensureViewport();
        updateCursorForTool(this);
        this.refreshPcbRibbon?.();
        this.viewport?._onResize?.();
        peekDrcPresentation(this)?.activate();
        this._updateViewportStatus();
        this.syncPcbViewToggles?.();
        updateGridDropdown(this);

        // Rebuild if schematic changed while we were away
        if (isEditorStale(this)) syncFromSchematic(this);
        if (isFillRefreshPending(this)) this.refreshFills();
        if (peekDrcPresentation(this)?.pending || drcShouldRun(this)) scheduleDrc(this);

        this.setPcbStatus();
        if (this.viewport) {
            this.viewport._notifyViewChanged?.();
        }

        // Board outline setup. The outline is part of the document and is
        // (re)drawn by schematic-sync whenever the layer DOM is
        // built or rebuilt. If no dimensions exist yet this is a brand-new
        // board, so prompt the user for them.
        if (!boardOutlineDrawn(this)) {
            this._showBoardDimensionsDialog();
        }
    }

    deactivate() {
        this.cancelAutoRoute?.();
        setInlineTextInputActive(activeTextInlineEdit(this)?.input, false);
        cancelPcbPosePreviews(this);
        cancelPcbDrawingMode(this);
        setEditorActive(this, false);
        peekDrcPresentation(this)?.deactivate();
        disposeFillRefresh(this);
        disposeDrcRefresh(this);
    }

    dispose() {
        disposeAutorouter(this);
        disposeFillRefresh(this, { terminal: true });
        disposeDrc(this);
    }

    setPcbStatus() {
        // The tool's layer may have changed: its ribbon button shows whether that layer is blocked.
        syncPcbToolBlocks(this);
        if (!this.status.modeStatus) return;
        const rawTool = this.currentTool || 'select';
        const toolLabel = rawTool.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        const layer = pcbToolLayer(this, rawTool);
        const layerLabel = layer ? pcbLayerName(layer) : 'Top Copper';
        if (this.status.tipStatus) {
            const tip = pcbToolTip(this, rawTool);
            this.status.tipStatus.hidden = !tip;
            this.status.tipStatus.textContent = tip;
        }
        this.status.modeStatus.textContent = `${toolLabel} | ${layerLabel}`;
        this.syncClipboardButtons?.();
        this.syncPcbHistoryButtons?.();
    }

    syncPcbHistoryButtons() {
        this.refreshPcbRibbon?.();
    }


    hasPcbClipboardData() {
        return hasPcbClipboardData(this);
    }

    canCopyCutPcbSelection() {
        return canCopyCutPcbSelection(this);
    }

    canUndoPcbHistory() {
        return isPcbPasteActive(this) || !!this.history?.canUndo?.();
    }
    selectAll() {
        selectAllPcbObjects(this);
    }

    /** Enable/disable PCB ribbon clipboard buttons to match current state. */
    syncClipboardButtons() {
        this.refreshPcbRibbon?.();
    }


    /** @param {{unlockedOnly?: boolean}} [options] */
    copySelection(options) {
        return copyPcbSelection(this, options);
    }

    cutSelection() {
        return cutPcbSelection(this);
    }

    pasteSelection() {
        return pastePcbSelection(this);
    }

    /** @param {HTMLElement} container */
    createViewport(container) {
        return new Viewport(container);
    }

    /** Legacy seam for tests. */
    /** @param {HTMLElement} container */
    _createViewport(container) {
        return this.createViewport(container);
    }

    /** After every history change: refresh derived pours, dirty state, buttons and selection overlays. */
    _onHistoryChanged() {
        invalidateFillRefresh(this);
        this.markDirty();
        this.syncPcbHistoryButtons?.();
        refreshBoxSelectionHighlights(this);
    }

    bindViewportPanHooks() {
        if (!this.viewport) return;
        this.viewport.onPanStart = () => {
            hideNetTooltip(this);
        };
    }

    /** Legacy seam for tests. */
    _bindViewportPanHooks() {
        this.bindViewportPanHooks();
    }

    ensureViewport() {
        ensurePcbViewport(this);
    }

    bindMouseEvents() {
        bindPcbMouseEvents(this);
    }

    /** Legacy seam for tests and tools. */
    _bindMouseEvents() {
        this.bindMouseEvents();
    }

    updateViewportStatus() {
        if (!this.viewport) return;
        if (this.status.viewportInfo) {
            this.status.viewportInfo.textContent = `${this.viewport.viewBox.width.toFixed(0)} × ${this.viewport.viewBox.height.toFixed(0)} mm`;
        }
        if (this.status.zoomPercent) {
            this.status.zoomPercent.textContent = `${Math.round(this.viewport.zoom * 100)}%`;
        }
        // Hide net-name labels on tracks below 200% zoom. At low zoom they're tiny
        // and make every hover/drag repaint many more SVG text nodes.
        this.viewport.svg?.classList.toggle('pcb-zoom-low', this.viewport.zoom < 2);
    }

    /** Legacy seam for tests. */
    _updateViewportStatus() {
        this.updateViewportStatus();
    }

    _clearViaRing() {
        clearViaRing(this);
    }

    _clearPadPreview() {
        clearPadPreview(this);
    }

    _clearViaPreview() {
        clearViaPreview(this);
    }

    /** Public hook used by controls.setTool to abort an in-flight shape draw. */
    _cancelShapeDraw() {
        cancelShapeDraw(this);
    }

    /**
     * Rebuild the per-side copper-removal clip paths (see copper-cuts.js).
     * @param {{geometryChanged?: boolean}} [options]
     */
    updateCopperCuts(options) {
        updateCopperCuts(this, options);
    }

    /**
     * Central keyboard handler for PCB mode. Invoked by
     * AppBootstrap's window-capture dispatcher when this app is the
     * active mode. Returns `true` if the key was consumed (caller
     * should stop propagation), `false` to let other listeners run.
     *
     * Modes (highest priority first):
    *   - In-flight Track draw: Escape cancels, Enter finishes, Space inserts a via.
     *   - Selection / drag:     Ctrl+Z/Y undo/redo, Delete removes, Escape cancels.
     *
     * @param {KeyboardEvent} e
     * @returns {boolean} true if consumed
     */
    handleKeyDown(e) {
        return handlePcbKeyDown(this, e);
    }
    /**
     * @param {Track} track
     * @param {Via[]} [vias]
     */
    _commitTrack(track, vias = []) {
        this.history.execute(new AddTrackCommand(this, track, vias));
    }

    /**
     * Serialize authored PCB model state with current view preferences.
     * Generated footprint presentation is not persisted.
     */
    serialize() {
        return serializePcb(this);
    }

    // ── ProjectDocument view interface ────────────────────────────────

    /** Current preferences only; an uncreated viewport leaves loaded model preferences intact. */
    getViewSettings() {
        return serializeGridSettings(this.viewport);
    }

    /** @param {'new'|'open'|'import'} reason */
    onDocumentReplaced(reason) {
        this.setActiveRibbonTab?.('pcb-home');
        if (reason === 'new' && isEditorActive(this) && !boardOutlineDrawn(this)) {
            this._showBoardDimensionsDialog();
        }
    }

    /**
     * Retained direct-editor API; ProjectDocument serializes the PCB model itself.
     * Returns null when there is nothing to persist so the combined
     * document omits an empty `pcb` section.
     * @returns {object|null}
     */
    serializeSection() {
        return this.pcbDocument.serializeSection(this.getViewSettings());
    }

    /**
     * Restore this editor's slice of the document.
     * @param {object|null} data The PCB section (or null to clear).
     */
    prepareSection(data) {
        return preparePcb(data);
    }

    /**
     * @param {object|null} data
     * @param {ReturnType<typeof preparePcb>} [prepared]
     */
    loadSection(data, prepared) {
        loadPcb(this, data || null, prepared);
    }

    /**
     * Reset the PCB editor to empty (used by New).
     */
    clearSection() {
        this.loadFromData(null);
    }

    /**
     * Report whether the PCB has unsaved changes. This is the "extra"
     * dirtiness the shared FileManager can't see on its own, so PCB-only
     * edits still trigger autosave / unload warnings.
     * @returns {boolean}
     */
    isSectionDirty() {
        return !!this._isDirty;
    }

    /** Pending previews must finish before a user-visible save/export snapshot. */
    isSectionEditing() {
        return isAutorouterActive(this) || hasPcbEditInProgress(this);
    }

    /**
     * Mark the PCB section as having no unsaved changes. Called after the
     * combined document is successfully saved to disk, so the section's
     * dirty flag stops re-triggering autosave / the unsaved-changes warning.
     */
    markSectionClean() {
        this._isDirty = false;
    }

    /** @param {boolean} dirty */
    restoreSectionDirty(dirty) {
        if (dirty) this.markDirty();
        else this.markSectionClean();
    }

    /**
     * Flag PCB edits and notify the project; its UI host owns the shared title.
     */
    markDirty() {
        this.cancelAutoRoute?.('Routing cancelled because the board changed.');
        this._isDirty = true;
        renderPanelPreview(this);
        this.onDocumentChanged?.();
        // Keep the clearance overlay in sync after any committed edit (e.g. an
        // undo/redo that relocates a via leaves orphaned halos otherwise).
        this.refreshClearanceHalos?.();
        scheduleDrc(this);
    }

    /**
     * Restore PCB state previously produced by serialize(). Replaces any
     * existing tracks/vias and re-renders them.
     * @param {{tracks?: Array<unknown>, vias?: Array<unknown>}|null} data
     */
    loadFromData(data) {
        return loadPcb(this, data);
    }

    /**
     * Rebuild the grid-size dropdown for the current unit system.
     * Reuses the shared updateGridDropdown helper from viewport.js.
     */
    updateGridDropdown() {
        if (!this.viewport || !this.ui?.gridSize) return;
        updateGridDropdown(this);
    }


    /**
     * The layer and overlay groups created so far, by id (read-only; use getLayerGroup
     * to create one). Lets modules inspect a layer without creating it.
     * @returns {ReadonlyMap<string, SVGGElement>}
     */
    existingLayerGroups() {
        return this._layerGroups;
    }

    /**
     * Get the SVG group for a layer, creating it if needed.
     * @param {string} layerId
     * @returns {SVGGElement}
     */
    getLayerGroup(layerId) {
        let g = this._layerGroups.get(layerId);
        if (!g) {
            g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            g.setAttribute('class', `pcb-layer-${layerId}`);
            g.setAttribute('data-layer', layerId);
            /** @type {Viewport} */ (this.viewport).addContent(g);
            this._layerGroups.set(layerId, g);
        }
        return g;
    }


    fitToContent() {
        this.ensureViewport();
        const viewport = this.viewport;
        if (!viewport) return;

        const panel = this.panelization ? renderPanelPreview(this) : null;
        const bounds = panel?.bounds || boardBoundary(this);
        viewport.fitToBounds(
            Math.min(0, bounds.x) - 10,
            Math.min(0, bounds.y - (panel ? 12 : 0)),
            Math.max(0, bounds.x + bounds.w),
            Math.max(0, bounds.y + bounds.h) + 10,
            0, 'bottom-left',
        );
    }

    _bindRibbonTabs() {
        // Ribbon tabs are rendered and bound by shared/ui/ribbon.js from the
        // PCB ribbon description. This legacy seam remains for older tests.
    }

    // ── Board Outline ─────────────────────────────────────────────

    /** Ask for the board size on first entry (board-outline-resize.js); a seam tests stub. */
    _showBoardDimensionsDialog() {
        showBoardDimensionsDialog(this);
    }

    /** Read-only board outline state used by browser helpers and page readiness checks. */
    isBoardOutlineDrawn() {
        return boardOutlineDrawn(this);
    }

    // ── Properties Panel ──────────────────────────────────────────

    /**
     * Clear the properties panel to its default state.
     */
    clearProperties() {
        this.setPropertiesTitle('Properties');
        if (this.propertiesItems()) {
            this.refreshPropertyPanel({ title: 'Properties', fields: [], placeholder: 'Click an object to see its properties' });
        }
        this.syncClipboardButtons?.();
    }

    /**
     * Set the PCB Properties ribbon group title.
     * @param {string} title
     * @param {object|null} [owner] Canonical target retained by a same-object panel refresh.
     */
    setPropertiesTitle(title, owner = null) {
        disposePcbPropertyEditors(this, owner);
        const el = document.querySelector('#pcbPropsContent .ribbon-group-title');
        if (el) el.textContent = title || 'Properties';
    }

    /**
     * Return the `#pcbPropsItems` container, first stripping any component-only
     * sibling sections (Transform / 3D) so non-component property views render
     * with the base Properties group as the sole panel content.
     */
    propertiesItems() {
        const host = document.getElementById('pcbPropertiesPanel');
        if (host) renderPropertyActions(host, []);
        return document.getElementById('pcbPropsItems');
    }

    /** Bring the Properties ribbon tab to the front (after showing a panel). */
    showPropertiesTab() {
        this.setActiveRibbonTab('pcb-properties');
    }

    /**
     * Show a panel description (shared/ui/property-fields.js) as a new Properties
     * panel: release the previous panel's editors, then render it.
     * @param {import('../shared/ui/property-fields.js').PropertyPanel} panel
     * @param {object|null} [owner] Canonical target retained by a same-object panel refresh.
     * @returns {boolean} false when there is no panel to show it in
     */
    openPropertyPanel(panel, owner = null) {
        const items = this.propertiesItems();
        if (!items) return false;
        this.setPropertiesTitle(panel.title, owner);
        this.refreshPropertyPanel(panel);
        this.showPropertiesTab?.();
        return true;
    }

    /**
     * Re-render the open panel from a fresh description of it, keeping its editors and
     * the focused control. Action groups sit beside the Properties group.
     * @param {import('../shared/ui/property-fields.js').PropertyPanel} panel
     */
    refreshPropertyPanel(panel) {
        const items = document.getElementById('pcbPropsItems');
        if (items) renderPropertyFields(items, panel.fields, { placeholder: panel.placeholder });
        const host = document.getElementById('pcbPropertiesPanel');
        if (host) renderPropertyActions(host, panel.actions);
    }

    /**
     * Bring a ribbon tab to the front; does nothing before the ribbon is bound.
     * @param {string} tabId - `pcb-home`, `pcb-properties`, `pcb-design`, …
     */
    setActiveRibbonTab(tabId) {
        this.activatePcbRibbonTab?.(tabId);
    }

    /** Every net on the board or in the netlist, sorted: the Properties Net menu. */
    netNames() {
        return boardNetNames(this);
    }

    /** @param {Pad|null} pad */
    showPadProperties(pad) {
        if (pad) this._showPadEditor(pad);
    }

    /** @param {Pad} pad */
    _showPadEditor(pad) {
        showPadEditor(this, pad, {
            defaults: getPadToolDefaults(this),
            refreshPreview: () => { const world = getPadPreviewWorld(this); if (world) updatePadPreview(this, world); },
        });
    }

    /**
     * Show board outline properties and switch to Properties tab.
     */
    _showBoardOutlineProperties() {
        showBoardOutlineProperties(this);
    }


    /** @param {string} compId */
    showComponentProperties(compId) {
        return getComponentProperties(this).showComponent(compId);
    }

    /**
     * Rotate a component by ±90° (dir: 'L' or 'R') via the history stack.
     * Used by the properties panel buttons and the Space keyboard shortcut.
     * @param {string} compId
     * @param {'L'|'R'} dir
     */
    rotateComponent(compId, dir) {
        const pl = this.placements.get(compId);
        if (!pl || pl.locked) return;
        const cur = ((pl.rotation || 0) % 360 + 360) % 360;
        const next = ((cur + (dir === 'L' ? -90 : 90)) % 360 + 360) % 360;
        this.history.execute(new RotatePlacementCommand(this, compId, cur, next));
    }

    /**
     * Flip a component horizontally or vertically (axis: 'H' or 'V') via the
     * history stack. Used by the properties panel buttons and the X/Y keys.
     * @param {string} compId
     * @param {'H'|'V'} axis
     */
    flipComponent(compId, axis) {
        if (!this.placements.has(compId) || this.placements.get(compId)?.locked) return;
        this.history.execute(new FlipPlacementCommand(this, compId, axis));
    }


    _bindThemeToggle() {
        window.addEventListener('clearpcb-theme-changed', () => {
            this.viewport?.updateTheme?.();
            for (const compId of getPcbSelection(this, 'reftext')) refreshRefHighlight(this, compId);
            this.refreshPcbRibbon?.();
        });
    }

    // ── Schematic → PCB sync ──────────────────────────────────────

    onSchematicChanged() {
        scheduleSchematicPcbSync(this);
    }


    /**
     * @param {any} geometry
     * @param {Placement & {reference: string}} placement
     */
    renderFootprint(geometry, placement) {
        return renderPcbFootprint(geometry, placement);
    }

    /**
     * Rebuild the ratsnest lines from the current netlist and placements.
     * @param {{nets?: Iterable<string>, skipFillRefresh?: boolean}} [opts]
     */
    updateRatsnest(opts) {
        // Net-based rebuild — draws guide lines between every disconnected
        // cluster of same-net copper (pads, tracks and vias alike). When
        // `opts.nets` is supplied (live footprint drag) only those nets are
        // recomputed; every other net's ratlines are left untouched.
        reconcileRatsnest(this, /** @type {{nets?: Set<string>, skipFillRefresh?: boolean}|undefined} */ (opts));
    }


    /**
     * Show a modal message, as the schematic editor's alert does.
     * @param {string} message
     * @param {{title?: string}} [options]
     */
    alert(message, options = {}) {
        return showAlert(message, options);
    }

    /**
     * Update the PCB status bar text.
     * @param {string} text
     */
    setStatus(text) {
        if (this.status.modeStatus) {
            this.status.modeStatus.textContent = text;
        }
    }

    // ── Selection & Drag ──────────────────────────────────────────

    /**
     * Convert a mouse event to world coordinates.
     * @param {MouseEvent} e
     * @returns {{x: number, y: number}}
     */
    screenToWorld(e) {
        // Use the viewport's cached rect rather than calling
        // getBoundingClientRect() directly. The hover code mutates the SVG
        // (halo polylines) every frame, which marks layout dirty; a fresh
        // getBoundingClientRect() would then force a synchronous reflow of
        // the whole board on each mousemove — cheap when zoomed out but
        // expensive when zoomed in, which is why hover lagged after zoom.
        // The SVG element's own rect only changes on resize (handled by the
        // 50 ms cache), not on pan/zoom or content edits.
        const viewport = /** @type {Viewport} */ (this.viewport);
        const rect = viewport._getCachedRect();
        return viewport.screenToWorld({
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
        });
    }

    /**
     * See worldToPlacementLocal in pcb/modules/ref-text-geometry.js.
     * @param {Point} worldPos
     * @param {Placement} pl
     */
    _worldToPlacementLocal(worldPos, pl) {
        return worldToPlacementLocal(worldPos, pl);
    }

    applyPlacementOverrides() {
        applyPlacementOverridesFromSchematic(this);
    }

    /**
     * Remember a footprint's current position as a manual override so it
     * survives schematic re-syncs and is persisted across reloads. Called
     * whenever a placement is moved (drag, box-select, undo/redo).
     * @param {string} compId
     */
    _recordPlacementOverride(compId) {
        const pl = this.placements.get(compId);
        if (!pl) return;
        this.placementState.record(compId, pl);
        this.markDirty();
    }

    /** @param {string|null} compId */
    selectComponent(compId) {
        selectPcbComponent(this, compId);
    }

    // ── Text annotations ─────────────────────────────────────────

    /**
     * Attract nearby coordinates to displayed grid lines, leaving the rest free.
     * @param {Point} p
     */
    snapToGrid(p) {
        return snapToViewportGrid(p, this.viewport);
    }


    /**
     * Re-render an existing text in place (e.g. after a property change).
     * @param {string} id
     */
    refreshText(id) {
        refreshPcbText(this, id);
    }

    /** @param {object|null} text */
    selectText(text) {
        selectPcbText(this, text);
    }

    // ── Reference-designator move / rotate ────────────────────
    // A component's reference (e.g. "R3") is rendered as part of its
    // footprint but can be repositioned and rotated relative to the body,
    // mirroring the schematic editor. The label text itself comes from the
    // schematic; reference edits update that source through its property command.

    /**
     * Rotate the selected reference designator by 90° (through history).
     * @param {string} compId
     */
    rotateRefText(compId) {
        getPropertyEditor(this, 'component')?.commit();
        const pl = this.placements.get(compId);
        if (!pl || isRefTextLocked(pl)) return;
        const cur = ((pl.refRot || 0) % 360 + 360) % 360;
        const next = (cur + 90) % 360;
        this.history.execute(new RotateRefTextCommand(this, compId, cur, next));
        this.drawRefOverlay(compId, false);
        if (isPcbSelected(this, 'reftext', compId)) this.showRefProperties(compId);
    }

    /**
     * The layer panel's name for a layer, so every menu and label matches the panel.
     * @param {string} layer
     */
    layerLabel(layer) {
        return pcbLayerName(layer);
    }

    /** @param {unknown} s */
    _escapeAttr(s) {
        /** @type {Record<string, string>} */
        const entities = { '&':'&amp;', '"':'&quot;', '<':'&lt;', '>':'&gt;' };
        return String(s ?? '').replace(/[&"<>]/g, c => entities[c]);
    }

    /**
     * Show properties for the given text and switch to Properties tab.
     * Editing pushes EditTextCommand on `change` (not per keystroke) so
     * undo collapses each edit into one entry.
     * @param {object} text
     */
    showTextProperties(text) {
        showTextProperties(this, /** @type {PcbText} */ (text), () => activeTextInlineEdit(this),
            (textId, symbol) => this._insertInlineTextSymbol(textId, symbol));
    }

    /**
     * @param {string} textId
     * @param {string} symbol
     */
    _insertInlineTextSymbol(textId, symbol) {
        const edit = activeTextInlineEdit(this);
        if (!edit || edit.text?.id !== textId) return false;
        const input = edit.input;
        const selectionStart = input.selectionStart ?? input.value.length;
        const selectionEnd = input.selectionEnd ?? selectionStart;
        input.value = input.value.slice(0, selectionStart) + symbol + input.value.slice(selectionEnd);
        const position = selectionStart + symbol.length;
        try { input.setSelectionRange(position, position); } catch { /* Some test doubles do not implement selections. */ }
        const event = typeof Event === 'function' ? new Event('input', { bubbles: true }) : { type: 'input', bubbles: true };
        input.dispatchEvent(event);
        input.focus?.();
        return true;
    }

    /**
     * Shared field-binding machinery for the stroke-text style panels (Text
     * objects and reference designators). For each spec field it wires the
     * input/change events so edits update the selected preview (via spec.preview)
     * and collapse into a single undo entry on commit (via spec.commit). A
     * snapshot of the model is taken on the first keystroke so spec.commit
     * can diff against the pre-edit state.
     * @param {any} model object whose fields the inputs drive
     * @param {any} spec field descriptions and preview/commit hooks
     */
    _bindStrokeTextProps(model, spec) {
        return bindStrokeTextProps(this, model, spec);
    }

    /** @param {string|null} compId */
    showRefProperties(compId) {
        if (!compId) return false;
        return getComponentProperties(this).showReference(compId);
    }

    /** @param {string|null} compId */
    rerenderRef(compId) {
        return rerenderRef(this, /** @type {string} */ (compId));
    }

    /**
     * Presentation service for reference-text interactions and history commands, like
     * rerenderRef: draw the selection overlay for `compId` (null clears it).
     * @param {string|null} compId
     * @param {boolean} withTether
     */
    drawRefOverlay(compId, withTether) {
        drawRefOverlay(this, compId, withTether);
    }

    refreshComponent3D() {
        refreshBoardViewPanel(this);
    }

    /**
     * Delete the currently-selected text (if any). Called from the
     * Delete-key handler. Returns true if it consumed the keystroke.
     */
    _deleteSelectedText() {
        const text = getPcbSelection(this, 'text')[0] || null;
        if (!text || boardShapeLocked(text) || !isLayerVisible(text.layer)) return false;
        const id = text.id;
        this.history.execute(new RemoveTextCommand(this, id));
        this.clearProperties?.();
        return true;
    }

    /**
     * Begin in-place editing of a PCB text annotation. Overlays an HTML
     * <input> positioned over the text via a <foreignObject>. Commits on
     * Enter or blur, cancels on Escape.
     * @param {InlineTextModel} text
     * @param {Point|null} [worldPos] - if given, the caret is
     *   placed at the character nearest this click point; otherwise it
     *   goes to the end of the text.
     * @param {InlineTextOptions} [opts] - Component-text hooks; see startTextInlineEdit.
     */
    _startTextInlineEdit(text, worldPos, opts) {
        return startTextInlineEdit(this, text, /** @type {Point|undefined} */ (worldPos), opts);
    }

    /**
     * @param {InlineTextModel} text
     * @param {Point|null} [worldPos]
     * @param {InlineTextOptions} [opts]
     */
    startTextInlineEdit(text, worldPos, opts) {
        return this._startTextInlineEdit(text, worldPos, opts);
    }

    /**
     * Finish in-place text editing. If `commit`, pushes an EditTextCommand
     * with the new content. Always tears down the overlay.
     * @param {boolean} commit
     */
    _endTextInlineEdit(commit) {
        return endTextInlineEdit(this, commit);
    }

    /** @param {PcbSelectionEntry} entry */
    _pcbMultiPropertyCapabilities(entry) {
        return multiPropertyCapabilities(this, entry);
    }

    /**
     * Show the editable intersection of properties for any PCB multi-selection.
     * @param {PcbSelectionEntry[]} entries
     */
    showMultiSelectionProperties(entries) {
        showMultiSelectionProperties(this, entries);
    }

    /** Redraw the selection halos and lock overlays after an externally driven edit. */
    refreshSelectionHighlights() {
        refreshBoxSelectionHighlights(this);
    }


    runAutoRoute() { return runAutoRouteAction(this); }

    /** @param {string|null} [message] */
    cancelAutoRoute(message = null) {
        cancelAutoRouteAction(this, message);
    }

    // ── Auto Router ───────────────────────────────────────────────


    /**
     * Toggle a faint ghost halo showing the clearance band around every
    * pad, via, track, and copper/hole shape. The halo width equals the **Clearance** value
     * from the routing tab — i.e. the minimum copper-to-copper gap any
     * other net's copper must keep from this object's edge.
     *
     * Pad shapes (rect / ellipse / oval) are honored. Halos are drawn
     * beneath copper so they don't obscure the board.
     *
     * Wired to the "Clearance" toggle button in the routing tab. Also
     * callable from the console: `bootstrap.pcbApp.showClearances(true|false)`.
     *
     * @param {boolean} [show] - explicit on/off; omit to toggle.
     * @param {Track|null} [liveTrack] - update only this track's rendered clearance during a drag.
     */
    showClearances(show, liveTrack) {
        return showClearances(this, show, liveTrack);
    }

    /**
     * Read canonical millimetre values, independent of ribbon display rounding.
     */
    getRoutingParams() {
        return this.designSettings.getRoutingParams();
    }

    _getRouterMode() {
        return this.designSettings.values.router;
    }

    /**
     * If the clearance overlay is currently visible, redraw it. Call this
     * after any operation that adds, removes, or relocates tracks/vias so the
     * halos stay in sync (rip-ups in particular leave orphaned halos otherwise).
     */
    refreshClearanceHalos() {
        return refreshClearanceHalos(this);
    }

    /** @param {Via|null} [via] */
    _refreshViaClearance(via) {
        return refreshViaClearance(this, via);
    }

    /* ──────────────────── Copper fill (pours) ─────────────────────── */

    /**
     * Schedule a recompute + re-render of all copper pours, coalesced to
     * one pass per animation frame. This is the live-refresh hook called
     * from reconcileRatsnest() (every copper mutation) and on routing-
     * parameter changes, as well as during fill editing.
     */
    refreshFills() {
        invalidateDrcRefresh(this);
        return scheduleFillRefresh(this);
    }

    /**
     * Resolve a pad's net from the netlist (componentId + pad number).
     * @param {string} componentId
     * @param {string|number} number
     */
    _padNetLookup(componentId, number) {
        if (!Array.isArray(this.netlist)) return '';
        for (const entry of this.netlist) {
            if (!entry?.pins) continue;
            for (const pin of entry.pins) {
                if (pin.componentId === componentId && String(pin.pinNumber) === String(number)) {
                    return entry.net || '';
                }
            }
        }
        return '';
    }


    /** @param {CopperFill|null} fill */
    selectFill(fill) {
        selectPcbFill(this, fill);
    }

    /**
     * Begin a drag of the selected pour: grab the nearest vertex (within
     * tolerance) for a vertex edit, otherwise move the whole region if the
     * click lands inside it. Returns true if a drag was started.
     * @param {CopperFill} fill
     * @param {Point} worldPos
     * @param {MouseEvent} e
     */
    _startFillDrag(fill, worldPos, e) {
        return startFillEditAt(this, fill, worldPos);
    }

    /**
     * Update a live pour drag (vertex move or whole-region translate).
     * @param {Point} world
     */
    _handleFillDrag(world) {
        updateFillEdit(this, world);
    }

    /** Commit a pour drag as an undoable ModifyFillCommand. */
    _endFillDrag(commit = true) {
        endFillEdit(this, commit);
    }

    deleteSelectedFill() {
        return deleteFocusedOrSelectedFill(this);
    }

    /**
     * Render the Properties-tab editor for a selected copper pour. The pour
     * has two editable attributes: its net (same-net copper is joined, other
     * nets are cleared) and its copper layer. Both commit through a single
     * ModifyFillCommand for clean undo/redo.
     */


    clearRoutes() {
        clearPcbRoutes(this);
    }

    // ── PDF / Print ───────────────────────────────────────────────

    /**
     * Export the PCB to a vector PDF sized to the board outline.
     * @returns {Promise<void>}
     */
    async savePdf() {
        await savePcbPdf(this);
    }

    /**
     * Print the PCB via a hidden iframe sized to the board outline.
     * @returns {Promise<void>}
     */
    async print() {
        await printPcb(this);
    }

    // ── Specctra DSN / SES ────────────────────────────────────────


    /**
     * Toggle the interactive 3D board visualiser. The toolbar 3D View button
     * opens/shows it when hidden and hides it when visible; the button stays
     * highlighted while the panel is active. The 3D and 2D views share one
     * panel, so opening 3D simply re-aims the shared panel.
     */
    open3DView() {
        const p = getBoardViewPanel(this);
        if (p && !p.closed) {
            if (!p.hidden && p.view === '3d') { p.hide?.(); return; }
            if (p.hidden) p.show?.();
            p.setView?.('3d');
            return;
        }
        openBoard3DViewer(this, { view: '3d' });
    }

    currentBoardView() {
        const p = getBoardViewPanel(this);
        return p && !p.closed && !p.hidden ? p.view : null;
    }

    last2DSide() {
        return getLastBoard2DSide(this);
    }

    /**
     * Toggle the flat 2D board visualiser for one side. Reuses the same sliding
     * panel as the 3D view (the two buttons are mutually exclusive): clicking
     * the active side hides the panel; any other state opens/switches it to
     * `side`.
     * @param {'top'|'bottom'} [side]
     */
    open2DView(side = 'top') {
        setLastBoard2DSide(this, side);
        const p = getBoardViewPanel(this);
        if (p && !p.closed) {
            if (!p.hidden && p.view === side) { p.hide?.(); return; }
            if (p.hidden) p.show?.();
            p.setView?.(side);
            return;
        }
        openBoard3DViewer(this, { view: side });
    }


}
