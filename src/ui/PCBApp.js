// PCBApp.js - PCB Editor Application

import { serializePcb, preparePcb, loadPcb } from '../pcb/modules/project-state.js';
import { AutorouterSession } from '../pcb/modules/autorouter-session.js';
import { ComponentProperties } from '../pcb/modules/component-properties.js';
import { bindPcbControls } from '../pcb/modules/controls.js';
import { Viewport } from '../core/Viewport.js';
import { snapToViewportGrid } from '../core/grid-snap.js';
import { PcbDocument } from '../core/PcbDocument.js';
import { isEditorActive, isEditorStale, setEditorActive, setEditorStale } from '../pcb/modules/pcb-editor-api.js';
import { loadAndApplyTheme } from '../shared/ui/theme.js';
import { showAlert } from '../shared/ui/modal.js';
import { renderFootprint, REF_DEFAULT_SIZE, REF_DEFAULT_STROKE } from '../shared/pcb/footprint.js';
import { updateGridDropdown, restoreGridSettings, serializeGridSettings } from '../shared/ui/viewport.js';
import { setInlineTextInputActive } from '../shared/ui/inline-text-overlay.js';
import { pcbLayerName, isLayerLocked, isLayerVisible, isViaVisible, isCopperFillLocked, isCopperFillVisible, applyLayerPrefsToRender } from '../pcb/modules/layers.js';
import { exportDSN, importSES } from '../pcb/modules/dsn.js';
import { disposeDrcRefresh, invalidateDrcRefresh } from '../pcb/modules/drc-refresh.js';
import {
    disposeDrc,
    drcShouldRun,
    initDrc,
    peekDrcPresentation,
    scheduleDrc,
    setDrcRatlines,
} from '../pcb/modules/drc-state.js';
import { cancelPcbPosePreviews, disposePcbPropertyEditors, hasPcbEditInProgress } from '../pcb/modules/edit-lifecycle.js';
import { isPcbDrawing } from '../pcb/modules/pcb-interactions.js';
import { handlePcbKeyDown } from '../pcb/modules/keyboard.js';
import { showSaveToast } from '../pcb/modules/save-toast.js';
import { cancelPcbDrawingMode, syncPcbToolBlocks, updateCursorForTool } from '../pcb/modules/tool-lifecycle.js';
import { pcbToolLayer, pcbToolTip, refreshPcbToolFollow } from '../pcb/modules/pcb-tools.js';
import { buildCopperObstacles } from '../pcb/modules/copper-obstacles.js';
import { buildRouteInput } from '../pcb/modules/route-input.js';
import { hasFabricationContent } from '../pcb/modules/fabrication-snapshot.js';
import { openPanelizeDialog, renderPanelPreview } from '../pcb/modules/panelization-ui.js';
import { generateGerberArchive, showGerberProgress } from '../pcb/modules/gerber-export.js';
import { generateBOM, generatePickAndPlace } from '../pcb/modules/assembly.js';
import { openBoard3DViewer } from '../pcb/modules/board3d.js';
import { savePcbPdf, printPcb, projectBaseName, savePcbBlob } from '../pcb/modules/pcb-export.js';
import { tracksFromAutorouterResult } from '../pcb/modules/autorouter-adapter.js';
import { renderTrack, renderVia, removeTrackElements, removeViaElements } from '../pcb/modules/track-render.js';
import { refreshTrackDrawPreview, reconcileRatsnest } from '../pcb/modules/track-draw.js';
import { refreshTrackSelectionHalo, getSelectedTrack, getSelectedVia, dismissTrackContextMenu, trackIsSelectable } from '../pcb/modules/track-select.js';
import {
    getVertexDrag,
} from '../pcb/modules/track-drag.js';
import { AddTrackCommand, ReplaceRoutesCommand, renderRoutedCopper, RotatePlacementCommand, SetPlacementLockedCommand, FlipPlacementCommand, SetPlacementSideCommand, SetPlacementRefVisibleCommand, renderPlacementPose, renderPlacementSide, applyPlacementRefVisible, placementTransform } from '../pcb/modules/track-commands.js';
import { serializePcbText } from '../core/pcb-text.js';
import { RemoveTextCommand, EditTextCommand } from '../pcb/modules/text-commands.js';
import { cancelShapeDraw, renderBoardShape } from '../pcb/modules/board-shapes.js';
import { renderPcbSelectionAnchors } from '../pcb/modules/selection-anchors.js';
import { boardShapeLocked, createPcbHistory, isPcbObjectLayerLocked, isPcbObjectLocked, lockedRoutedCopper, showUnlockMenu } from '../pcb/modules/object-locks.js';
import { renderPropertyActions, renderPropertyFields } from '../shared/ui/property-fields.js';
import { refreshAxisGlow } from '../pcb/modules/axis-glow.js';
import { scheduleFillRefresh, invalidateFillRefresh, disposeFillRefresh } from '../pcb/modules/fill-refresh.js';
import {
    refreshBoxSelectionHighlights,
    deleteBoxSelection,
} from '../pcb/modules/box-select.js';
import {
    showPcbSelectionProperties,
    finishSelectionInteraction,
} from '../pcb/modules/selection-interaction.js';
import { getPcbSelection, isPcbSelected, setPcbSelection } from '../pcb/modules/selection-registry.js';
import { worldToPlacementLocal } from '../pcb/modules/ref-text-geometry.js';
import { CommandHistory } from '../core/CommandHistory.js';
import { Track } from '../shapes/track.js';
import { Via } from '../shapes/via.js';
import { Pad } from '../shapes/pad.js';
import { CopperFill } from '../shapes/copper-fill.js';
import { renderPad } from '../pcb/modules/pad.js';
import '../pcb/modules/pad-selection.js';
import { renderCopperFill } from '../pcb/modules/copper-fill-render.js';
import { updateCopperCuts, clearCopperCuts, hasCopperCuts } from '../pcb/modules/copper-cuts.js';
import { initDebugTooltip } from '../pcb/modules/debug-tooltip.js';
import { bindPcbMouseEvents } from '../pcb/modules/mouse.js';
import '../pcb/modules/layer-changes.js';
import { RemoveFillCommand, ModifyFillCommand } from '../pcb/modules/copper-fill-commands.js';
import { startFillEditAt, updateFillEdit, endFillEdit, deleteFocusedFillPart } from '../pcb/modules/copper-fill-edit.js';
import { openComponent3DPopout, showComponentPopup, updatePcbCulling } from '../pcb/modules/component-selection.js';
import { clearTextElements, refreshText as refreshPcbText, renderText } from '../pcb/modules/pcb-text-render.js';
import { drawRefOverlay, endRefDrag, isRefTextLocked, refreshRefHighlight, rerenderRef, RotateRefTextCommand, SetRefStyleCommand } from '../pcb/modules/ref-text-selection.js';
import { cancelHoverUpdate } from '../pcb/modules/pcb-hover.js';
import { displayedCollection } from '../pcb/modules/displayed-collections.js';
import { preparePcbPaste, beginPcbPaste, cancelPcbPaste, isPcbPasteActive } from '../pcb/modules/pcb-paste.js';
import { getBoardOutline, boardBoundary } from '../shared/pcb/board-outline.js';
import { getPropertyEditor, setPropertyEditor } from '../pcb/modules/property-editors.js';
import { getBoardViewPanel, getLastBoard2DSide, isFillRefreshPending, noteEditSettled, onRefreshSuspended, refreshBoardViewPanel, setLastBoard2DSide } from '../pcb/modules/refresh-state.js';
import {
    drawBoardOutline,
    initializeBoardOutlineState,
    isBoardOutlineDrawn as boardOutlineDrawn,
    renderBoardOutlineHandles,
    showBoardDimensionsDialog,
    showBoardOutlineProperties,
} from '../pcb/modules/board-outline-resize.js';
import { showTextProperties, bindStrokeTextProps } from '../pcb/modules/text-properties.js';
import { showPadEditor } from '../pcb/modules/pad-properties.js';
import { clearPadPreview, getPadPreviewWorld, getPadToolDefaults, updatePadPreview } from '../pcb/modules/pad-tool.js';
import { clearViaPreview, clearViaRing } from '../pcb/modules/via-tool.js';
import { multiPropertyCapabilities, showMultiSelectionProperties } from '../pcb/modules/multi-selection-properties.js';
import { activeTextInlineEdit, startTextInlineEdit, endTextInlineEdit } from '../pcb/modules/text-inline-edit.js';
import { showClearances, refreshClearanceHalos, refreshViaClearance } from '../pcb/modules/clearance-overlay.js';
import { hideNetTooltip } from '../pcb/modules/net-tooltip.js';

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
 * @typedef {import('../core/pcb-placement-geometry.js').BoardPad} BoardPad
 * @typedef {import('../core/netlist.js').NetlistEntry} NetlistEntry
 * @typedef {import('../core/pcb-text.js').PcbText} PcbText
 * @typedef {import('../pcb/modules/autorouter-common.js').RouteInput} RouteInput
 * @typedef {import('../pcb/modules/autorouter-common.js').RouteResult} RouteResult
 * @typedef {'component'|'reftext'|'track'|'via'|'pad'|'shape'|'text'|'fill'} PcbSelectionKind
 * @typedef {import('../pcb/modules/selection-registry.js').PcbSelectionEntry} PcbSelectionEntry
 * @typedef {{tracks: ReturnType<Track['toJSON']>[], vias: ReturnType<Via['toJSON']>[], pads: ReturnType<Pad['toJSON']>[],
 *   shapes: any[], texts: ReturnType<typeof serializePcbText>[], fills: ReturnType<CopperFill['captureState']>[]}} PcbClipboardPayload
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
        this._lastHaloScale = undefined;
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

        /** @type {SVGGElement|null} Group containing all placed footprints */
        this._footprintGroup = null;
        /** @type {SVGGElement|null} Group containing ratsnest lines */
        this._ratsnestGroup = null;
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
        /** @type {number|null} Debounce timer for live rebuilds while PCB pane is active */
        this._syncTimer = null;
        /** True after the first sync (governs fitToBounds) */
        this._hasContent = false;
        initializeBoardOutlineState(this, !!getBoardOutline(this));
        /** @type {Record<string, HTMLElement|undefined>|null} Ribbon control elements (set by controls.js) */
        this.ui = null;

        // ── Selection & drag state ────────────────────────────
        /** @type {PcbClipboardPayload|null} In-memory PCB clipboard payload. */
        this._pcbClipboard = null;
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
            onRefused: error => showSaveToast(this, error.message),
        });
        /** @type {AutorouterSession|null} Lazily created owner of routing session and temporary presentation. */
        this._autorouter = null;
        /** Document-change hook installed by ProjectDocument. @type {(() => void)|null} */
        this.onDocumentChanged = null;
        /** @type {RouteInput|null} Stored test board RouteInput for direct routing. */
        this._testBoardRouteInput = null;
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
            this._syncFromSchematic();
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
        if (isEditorStale(this)) this._syncFromSchematic();
        if (isFillRefreshPending(this)) this.refreshFills();
        if (peekDrcPresentation(this)?.pending || drcShouldRun(this)) scheduleDrc(this);

        this.setPcbStatus();
        if (this.viewport) {
            this.viewport._notifyViewChanged?.();
        }

        // Board outline setup. The outline is part of the document and is
        // (re)drawn by _renderPersistentObjects whenever the layer DOM is
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
        this._autorouter?.dispose();
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

    /** Whether there is any pasteable payload on the PCB clipboard. */
    _hasPcbClipboardData() {
        const c = this._pcbClipboard;
        return !!c && (
            (c.tracks?.length || 0) > 0
            || (c.vias?.length || 0) > 0
            || (c.pads?.length || 0) > 0
            || (c.shapes?.length || 0) > 0
            || (c.texts?.length || 0) > 0
            || (c.fills?.length || 0) > 0
        );
    }

    hasPcbClipboardData() {
        return this._hasPcbClipboardData();
    }

    /** Whether current selection can be copied/cut from PCB. */
    _canCopyCutPcbSelection() {
        return getPcbSelection(this, 'track').length > 0
            || getPcbSelection(this, 'via').length > 0
            || getPcbSelection(this, 'pad').length > 0
            || getPcbSelection(this, 'shape').some(/** @param {any} shape */ (shape) => shape.layer !== 'board-outline')
            || getPcbSelection(this, 'text').length > 0
            || getPcbSelection(this, 'fill').length > 0;
    }

    canCopyCutPcbSelection() {
        return this._canCopyCutPcbSelection();
    }

    canUndoPcbHistory() {
        return isPcbPasteActive(this) || !!this.history?.canUndo?.();
    }
    /** Select every visible PCB object not on a locked layer; individually locked objects are included. */
    selectAll() {
        window.getSelection?.()?.removeAllRanges();
        /** @type {PcbSelectionEntry[]} */
        const selected = [];
        /**
         * @param {PcbSelectionKind} kind
         * @param {any} object
         */
        const add = (kind, object) => {
            if (!isPcbObjectLayerLocked(this, kind, object)) selected.push({ kind, object });
        };
        for (const [componentId] of this.placements) add('component', componentId);
        for (const track of this.tracks) {
            if (trackIsSelectable(track)) add('track', track);
        }
        if (isViaVisible()) {
            for (const via of this.vias) if (via.visible !== false) add('via', via);
        }
        for (const pad of this.pads || []) {
            if (pad.visible !== false) add('pad', pad);
        }
        for (const shape of this.boardShapes) {
            if (shape?.type === 'fill') {
                if (shape.visible !== false && isCopperFillVisible(shape.layer)) add('fill', shape);
            } else if (shape && isLayerVisible(shape.layer)) {
                add('shape', shape);
            }
        }
        for (const text of this.texts.values()) {
            if (isLayerVisible(text.layer)) add('text', text);
        }
        setPcbSelection(this, selected);
        refreshBoxSelectionHighlights(this);
        showPcbSelectionProperties(this);
        this.syncClipboardButtons();
    }

    /** Enable/disable PCB ribbon clipboard buttons to match current state. */
    syncClipboardButtons() {
        this.refreshPcbRibbon?.();
    }

    /**
     * Build a clipboard payload from current PCB selection.
     * Components/reference labels are intentionally excluded.
     * @param {{unlockedOnly?: boolean}} [options] Cut copies only what it can remove.
     */
    _capturePcbClipboardSelection({ unlockedOnly = false } = {}) {
        /** @type {PcbClipboardPayload} */
        const payload = { tracks: [], vias: [], pads: [], shapes: [], texts: [], fills: [] };
        /**
         * @param {PcbSelectionKind} kind
         * @returns {any[]}
         */
        const selected = kind => getPcbSelection(this, kind)
            .filter(/** @param {any} object */ (object) => !unlockedOnly || !isPcbObjectLocked(this, kind, object));
        for (const track of selected('track')) payload.tracks.push(track.toJSON());
        for (const via of selected('via')) payload.vias.push(via.toJSON());
        for (const pad of selected('pad')) payload.pads.push(pad.toJSON());
        for (const shape of selected('shape')) {
            if (shape.layer !== 'board-outline') payload.shapes.push(JSON.parse(JSON.stringify(shape)));
        }
        for (const text of selected('text')) payload.texts.push(serializePcbText(text));
        for (const fill of selected('fill')) payload.fills.push(fill.captureState());
        if (!payload.tracks.length && !payload.vias.length && !payload.pads.length && !payload.shapes.length
            && !payload.texts.length && !payload.fills.length) return null;
        return payload;
    }

    /**
     * Copy currently-selected PCB entities (except components).
     * @param {{unlockedOnly?: boolean}} [options]
     */
    copySelection(options) {
        const payload = this._capturePcbClipboardSelection(options);
        if (!payload) {
            const componentId = getPcbSelection(this, 'component')[0] || getPcbSelection(this, 'reftext')[0];
            if (componentId) {
                showComponentPopup(this, componentId,
                    "Components can't be copied from PCB. Copy them in the schematic editor.");
            }
            this.syncClipboardButtons();
            return false;
        }
        this._pcbClipboard = payload;
        this.syncClipboardButtons();
        return true;
    }

    /** Cut currently-selected PCB entities (copy + remove). */
    cutSelection() {
        if (isPcbPasteActive(this)) { cancelPcbPaste(this); return true; }
        if (!this.copySelection({ unlockedOnly: true })) return false;
        const deleted = deleteBoxSelection(this);
        if (deleted) this.clearProperties();
        this.syncClipboardButtons();
        return deleted;
    }

    /** Stage the current PCB clipboard payload at the cursor without authoring it. */
    pasteSelection() {
        if (!this._hasPcbClipboardData()) {
            this.syncClipboardButtons();
            return false;
        }
        const pasted = preparePcbPaste(this, this._pcbClipboard);
        const started = beginPcbPaste(this, pasted);
        this.syncClipboardButtons();
        return started;
    }

    /**
     * Create the canvas viewport; headless tests substitute their own.
     * @param {HTMLElement} container
     */
    _createViewport(container) {
        return new Viewport(container);
    }

    /** After every history change: refresh derived pours, dirty state, buttons and selection overlays. */
    _onHistoryChanged() {
        invalidateFillRefresh(this);
        this.markDirty();
        this.syncPcbHistoryButtons?.();
        refreshBoxSelectionHighlights(this);
    }

    /** Panning dismisses the net tooltip; clearance halos stay visible throughout. */
    _bindViewportPanHooks() {
        /** @type {Viewport} */ (this.viewport).onPanStart = () => {
            hideNetTooltip(this);
        };
    }

    /** Create the canvas viewport on first use; loading may render before the tab is shown. */
    ensureViewport() {
        if (this.viewport || !this.canvasContainer) return;

        this.viewport = this._createViewport(this.canvasContainer);

        this.viewport.onMouseMove = (worldPos, snappedPos) => {
            if (!isEditorActive(this)) return;
            if (this.status.cursorPos) {
                this.status.cursorPos.textContent = `${worldPos.x.toFixed(2)}, ${(-worldPos.y).toFixed(2)} mm`;
            }
            if (this.status.gridSnap) {
                this.status.gridSnap.textContent = `${snappedPos.x.toFixed(2)}, ${(-snappedPos.y).toFixed(2)} mm`;
            }
        };

        /** @type {{scaleChanged?: boolean, boundsChanged?: boolean}|null} */
        let pendingView = null;
        let viewRaf = 0;
        const flushViewUpdate = () => {
            viewRaf = 0;
            const view = pendingView;
            pendingView = null;
            if (!view || !isEditorActive(this)) return;

            // Selection halo node handles are sized in screen pixels, so they
            // must be redrawn when the zoom scale changes to stay constant on
            // screen. (Pan doesn't change scale, so skip the churn then.)
            const sc = this.viewport?.scale || 1;
            if (sc !== this._lastHaloScale && (getSelectedTrack(this) || getSelectedVia(this))) {
                this._lastHaloScale = sc;
                refreshTrackSelectionHalo(this);
            }
            if (view.scaleChanged && getPcbSelection(this).length) {
                refreshBoxSelectionHighlights(this);
            }
            if (view.scaleChanged) {
                renderBoardOutlineHandles(this);
                refreshAxisGlow(this);
                refreshTrackDrawPreview(this);
            }
            refreshPcbToolFollow(this);
            updatePcbCulling(this);
            if (hasCopperCuts(this)) this.updateCopperCuts({ geometryChanged: false });
            if (peekDrcPresentation(this)?.selectedId) peekDrcPresentation(this)?.updateConnector();
        };

        this.viewport.onInteractionStart = (kind) => {
            cancelHoverUpdate(this);
            if (kind !== 'pointer' && viewRaf) {
                cancelAnimationFrame(viewRaf);
                viewRaf = 0;
            }
            hideNetTooltip(this);
        };

        this.viewport.onViewChanged = (view) => {
            if (!isEditorActive(this)) return;
            // A track context menu is anchored to a screen position but refers
            // to a board location; any zoom or pan (wheel, +/- keys, arrow-key
            // pan, buttons, drag) makes it stale, so dismiss it on view change.
            // Guard on an actual move: endPan() fires this callback even for a
            // zero-distance right-click, which would otherwise instantly close
            // the context menu the right-click just opened.
            if (!view || view.scaleChanged || view.boundsChanged) dismissTrackContextMenu();
            // The net tooltip is anchored to a screen point over hovered copper;
            // any pan/zoom invalidates that screen anchor, so dismiss on view move.
            if (!view || view.scaleChanged || view.boundsChanged) hideNetTooltip(this);
            this._updateViewportStatus();
            pendingView = pendingView
                ? {
                    ...view,
                    scaleChanged: pendingView.scaleChanged || view.scaleChanged,
                    boundsChanged: pendingView.boundsChanged || view.boundsChanged,
                }
                : view;
            if (!viewRaf) viewRaf = requestAnimationFrame(flushViewUpdate);
        };

        // Throttled footprint culling during an active pan (Viewport rAF).
        this.viewport.onViewportCull = () => {
            if (!isEditorActive(this)) return;
            updatePcbCulling(this);
            // Keep the copper-removal clip rectangle following the viewport
            // during a live pan (viewBox moves without firing onViewChanged).
            if (hasCopperCuts(this)) this.updateCopperCuts({ geometryChanged: false });
            // The viewBox moves continuously during a pan without firing
            // onViewChanged, so keep the DRC leader anchored here too.
            if (peekDrcPresentation(this)?.selectedId) peekDrcPresentation(this)?.updateConnector();
        };

        this._bindViewportPanHooks();

        // Bind mouse events for panning
        this._bindMouseEvents();
        this.viewport.svg.addEventListener('unlock-shape', (event) => {
            const { shape: owner, clientX, clientY } = /** @type {CustomEvent} */ (event).detail || {};
            if (owner?.kind) showUnlockMenu(this, owner.kind, owner.object, clientX, clientY);
        });

        // Create SVG layer groups (one <g> per PCB layer, in z-order)
        this._createLayerGroups();

        // Push any restored eye/lock state (from a prior session) into the
        // freshly-created render groups so the artwork matches the panel.
        applyLayerPrefsToRender(this);

        restoreGridSettings(this, this.pcbDocument.settings || {});

        // Apply current theme to the viewport
        this.viewport.updateTheme();
        this._updateViewportStatus();
    }

    /** Wire the canvas's mouse events (pcb/modules/mouse.js); a seam tests bind through. */
    _bindMouseEvents() {
        bindPcbMouseEvents(this);
    }

    _updateViewportStatus() {
        if (!this.viewport) return;
        if (this.status.viewportInfo) {
            this.status.viewportInfo.textContent = `${this.viewport.viewBox.width.toFixed(0)} × ${this.viewport.viewBox.height.toFixed(0)} mm`;
        }
        if (this.status.zoomPercent) {
            this.status.zoomPercent.textContent = `${Math.round(this.viewport.zoom * 100)}%`;
        }
        // Hide net-name labels on tracks below 200% zoom — at low zoom
        // they're tiny and just add visual noise.
        if (this.viewport.svg) {
            this.viewport.svg.classList.toggle('pcb-zoom-low', this.viewport.zoom < 2);
        }
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
        return !!this._autorouter?.active || hasPcbEditInProgress(this);
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
    _updateGridDropdown() {
        if (!this.viewport || !this.ui?.gridSize) return;
        updateGridDropdown(this);
    }

    /**
     * Create an SVG <g> for every PCB layer and add them to the viewport
     * in bottom-to-top z-order.  The groups persist across syncs — only
     * their children are cleared and rebuilt.
     */
    _createLayerGroups() {
        if (this._layerGroups.size > 0) return;  // already created

        // Layer z-order (bottom to top): outline, masks, paste, copper, silk, doc, holes, rats
        const zOrder = [
            'board-outline',
            'bottom-mask', 'top-mask',
            'bottom-paste', 'top-paste',
            // Copper pours sit directly beneath their copper layer so
            // tracks and pads paint on top of the flood fill.
            'bottom-fill', 'bottom-copper',
            // Pad numbers sit just above their copper layer so a track routed
            // to a pad never hides its number (visibility follows the copper).
            'bottom-pad-numbers',
            // Copper-removal "knockouts" (circles set to remove copper) sit
            // above all copper/pads on that side so they visually cut the
            // copper — a track passing through reads as removed, matching the
            // 2D/3D board views.
            'bottom-copper-knockout',
            'top-fill', 'top-copper',
            'top-pad-numbers',
            'top-copper-knockout',
            'bottom-copper-pad-drills', 'top-copper-pad-drills',
            'vias',
            // Track labels remain readable where a connected track terminates
            // beneath a via, while still following copper-layer visibility.
            'bottom-copper-track-labels',
            'top-copper-track-labels',
            'bottom-silk', 'top-silk',
            // Level-of-detail placeholders: one solid rect per footprint, shown
            // (in place of the footprint's full geometry) when zoomed out far
            // enough that the detail is sub-pixel. Sits above copper/silk so the
            // block reads clearly; hidden whenever the real geometry is shown.
            'fp-lod',
            'bottom-document',
            'top-document',
            // Board cutouts must cover every board-art layer, including vias.
            'hole',
            'ratlines',
            // Overlays — non-editable visual aids drawn on top of everything
            // (clearance halos, etc.). Must be last in z-order.
            'clearance-overlay',
            // Selection-overlay — track node handles etc. sit above ALL
            // copper, vias and overlays so they stay visible
            // even when a via covers the node they mark.
            'selection-overlay',
            // DRC-overlay — design-rule violation markers (dotted leaders /
            // rings) sit above everything else so they're always visible.
            'drc-overlay',
        ];

        for (const id of zOrder) {
            const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            g.setAttribute('class', `pcb-layer-${id}`);
            g.setAttribute('data-layer', id);
            /** @type {Viewport} */ (this.viewport).addContent(g);
            this._layerGroups.set(id, g);
        }
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

    _getComponentProperties() {
        return getPropertyEditor(this, 'component') ?? setPropertyEditor(this, 'component', new ComponentProperties({
            getPlacement: /** @param {string} id */ (id) => this.placements.get(id),
            isActive: () => isEditorActive(this),
            isSelected: /** @param {string} kind @param {string} id */ (kind, id) => isPcbSelected(this, kind, id),
            openPanel: (panel, owner) => this.openPropertyPanel(panel, owner),
            refreshPanel: panel => this.refreshPropertyPanel(panel),
            layerLabel: /** @param {string} layer */ (layer) => this.layerLabel(layer),
            bindStrokeText: (model, spec) => this._bindStrokeTextProps(model, spec),
            rotate: (id, before, after) => this.history.execute(new RotatePlacementCommand(this, id, before, after)),
            setLocked: (id, locked) => {
                finishSelectionInteraction(this, false);
                this.history.execute(new SetPlacementLockedCommand(this, id, locked));
            },
            setReferenceVisible: /** @param {string} id @param {boolean} visible */ (id, visible) => this._setComponentRefVisible(id, visible),
            setSide: /** @param {string} id @param {string} side */ (id, side) => this._setPlacementSide(id, /** @type {'top'|'bottom'} */ (side)),
            flip: /** @param {string} id @param {string} axis */ (id, axis) => this.flipComponent(id, /** @type {'H'|'V'} */ (axis)),
            open3D: /** @param {string} id */ (id) => openComponent3DPopout(this, id),
            renderReference: /** @param {string} id */ (id) => this.rerenderRef(id),
            drawReferenceOverlay: (id, tether) => this.drawRefOverlay(id, tether),
            setReferenceStyle: (id, before, after) => this.history.execute(new SetRefStyleCommand(this, id, before, after)),
        }));
    }

    /**
     * Show properties for a single placed component.
     * @param {string} compId
     */
    showComponentProperties(compId) {
        return PCBApp.prototype._getComponentProperties.call(this).showComponent(compId);
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

    /**
     * Move a component to the top or bottom copper side via the history stack.
     * @param {string} compId
     * @param {'top'|'bottom'} side
     */
    _setPlacementSide(compId, side) {
        const pl = this.placements.get(compId);
        if (!pl || pl.locked) return;
        const cur = pl.side === 'bottom' ? 'bottom' : 'top';
        if (cur === side) return;
        this.history.execute(new SetPlacementSideCommand(this, compId, side));
    }

    /**
     * Show or hide a component's reference designator via the history stack.
     * @param {string} compId
     * @param {boolean} visible
     */
    _setComponentRefVisible(compId, visible) {
        const pl = this.placements.get(compId);
        if (!pl || pl.locked) return;
        if ((pl.refVisible !== false) === !!visible) return;
        this.history.execute(new SetPlacementRefVisibleCommand(this, compId, !!visible));
    }

    _bindThemeToggle() {
        window.addEventListener('clearpcb-theme-changed', () => {
            this.viewport?.updateTheme?.();
            for (const compId of getPcbSelection(this, 'reftext')) refreshRefHighlight(this, compId);
            this.refreshPcbRibbon?.();
        });
    }

    // ── Schematic → PCB sync ──────────────────────────────────────

    /**
     * Mark the PCB as needing a rebuild.  If the PCB pane is currently
     * active the rebuild is scheduled via a short debounce so rapid
     * schematic edits don't cause per-keystroke rebuilds.
     */
    onSchematicChanged() {
        this.cancelAutoRoute?.('Routing cancelled because the schematic changed.');
        setEditorStale(this, true);
        if (!isEditorActive(this)) return;

        // Debounce: rebuild after 300 ms of inactivity
        if (this._syncTimer !== null) clearTimeout(this._syncTimer);
        this._syncTimer = setTimeout(() => this._syncFromSchematic(), 300);
    }

    /**
     * Rebuild the PCB content from the current schematic state.
     */
    _syncFromSchematic() {
        if (!isEditorActive(this)) {
            setEditorStale(this, true);
            if (this._syncTimer !== null) clearTimeout(this._syncTimer);
            return;
        }
        if (this._syncTimer !== null) clearTimeout(this._syncTimer);

        const project = this.project;
        const schematic = project?.schematicDocument;
        if (!schematic) {
            setEditorStale(this, true);
            return;
        }
        setEditorStale(this, false);

        this.ensureViewport();

        const { placements, netlist } = project.synchronizePcbLayout();
        this.netlist = netlist;

        // Clear previous PCB content
        this._clearPCBContent();

        // Re-render persistent model objects that _clearPCBContent wiped
        // from the layer groups but whose models survive the rebuild
        // (texts, tracks, vias — e.g. restored from an autosave, or a
        // routed test board with no schematic components). This must run
        // BEFORE the components-empty early-return below, otherwise a
        // component-less board (e.g. test board) leaves recovered tracks
        // in the model — they hit-test on hover but stay invisible.
        this._renderPersistentObjects({ renderShapes: placements.size === 0 });

        if (placements.size === 0) {
            // Persistent copper shapes can carry nets without any schematic
            // components. Their SVG was restored above, so rebuild their
            // ratlines before this component-less-board early return.
            this.refreshClearanceHalos();
            this.updateRatsnest();
            this.setStatus('No components in schematic');
            refreshBoardViewPanel(this);
            return;
        }

        // Ratsnest goes to its own layer group
        this._ratsnestGroup = this.getLayerGroup('ratlines');

        // Place footprints (elements distributed to correct layer groups)
        this._placeFootprints(placements);

        // Keep free-standing board shapes above freshly placed footprint
        // artwork after a schematic-driven rebuild.
        for (const s of this.boardShapes) {
            if (s.type === 'fill' || (boardOutlineDrawn(this) && s.layer === 'board-outline')) continue;
            renderBoardShape(this, s, { skipCopperUpdate: true });
        }
        this.updateCopperCuts?.();

        // Draw ratsnest
        this.refreshClearanceHalos();
        this.updateRatsnest();

        // Only fit-to-content on the first sync so we don't
        // reset the user's pan/zoom on every change
        if (!this._hasContent) {
            this._fitToPlacedContent();
            this._hasContent = true;
        }

        const netCount = netlist.length;
        this.setStatus(`${placements.size} component(s), ${netCount} net(s)`);

        // A schematic-driven rebuild (e.g. a component added or deleted) does
        // not pass through the PCB history, so refresh any open 3D view here.
        refreshBoardViewPanel(this);
    }

    /**
     * Re-render the persistent board model (texts, tracks, vias) into the
     * layer groups. Their SVG is wiped by _clearPCBContent on every
     * schematic rebuild, but the underlying models survive (and may have
     * been restored from an autosave before the first sync). Without this
     * the objects exist in the model — hit-testing/hover still work — but
     * are invisible. Idempotent: removes any stale SVG first.
     */
    _renderPersistentObjects({ renderShapes = true } = {}) {
        const getGroup = /** @param {string} id */ (id) => this.getLayerGroup(id);

        // Board outline. Its model (width/height/radius) survives the rebuild
        // but its SVG is wiped by _clearPCBContent, so redraw it here.
        if (boardOutlineDrawn(this)) {
            drawBoardOutline(this);
        }

        // Free-standing texts.
        clearTextElements(this);
        for (const t of this.texts.values()) {
            renderText(this, t);
        }

        // Tracks and vias.
        const routeParams = this.getRoutingParams?.();
        for (const t of this.tracks) {
            removeTrackElements(t);
            renderTrack(t, getGroup, {
                viaDiameter: routeParams?.viaDiameter,
                viaDrill: routeParams?.viaDrill,
                hideNetLabel: t === getSelectedTrack(this) || t === getVertexDrag(this)?.track,
            });
        }
        for (const v of this.vias) {
            removeViaElements(v);
            renderVia(v, getGroup);
        }
        for (const pad of this.pads || []) renderPad(pad, getGroup);
        // Free-standing board shapes; CopperFill entries render separately.
        for (const s of this.boardShapes) {
            if (!renderShapes || s.type === 'fill'
                || (boardOutlineDrawn(this) && s.layer === 'board-outline')) continue;
            renderBoardShape(this, s, { skipCopperUpdate: true });
        }
        if (renderShapes) this.updateCopperCuts?.();
        if (getPcbSelection(this).length) refreshBoxSelectionHighlights(this);

        // Copper pours. Their model (copperFills) survives the rebuild but
        // their SVG is wiped by _clearPCBContent, so re-pour them here. This
        // is coalesced to one recompute on the next frame, by which point any
        // footprint placement in the same sync pass has finished, so the pour
        // clips against the up-to-date obstacles.
        if (this.copperFills.length) {
            this.refreshFills();
        }
    }

    /**
     * Remove all PCB footprint and ratsnest content from layer groups.
     */
    _clearPCBContent() {
        disposeDrcRefresh(this);
        setDrcRatlines(this, []);
        // Clear children of layer groups (but keep the groups themselves)
        for (const [, g] of this._layerGroups) {
            while (g.firstChild) g.removeChild(g.firstChild);
        }
        // Drop any reference-text selection/overlay tied to the old placements.
        endRefDrag(this, false);
        drawRefOverlay(this, null, false);
        this._footprintGroup = null;
        this._ratsnestGroup = null;
        this.placements.clear();
        clearCopperCuts(this);
    }

    /**
     * Render model-resolved footprints on the PCB canvas.
     * @param {Map<string, Placement & {geometry: any}>} placements - Resolved physical placements and footprint geometry.
     */
    _placeFootprints(placements) {
        for (const [compId, resolved] of placements) {
            const { geometry: fpGeom, ...placement } = resolved;
            // Render SVG (returns Map<layerId, SVGGElement>)
            const fpLayers = this._renderFootprint(fpGeom, /** @type {Placement & {reference: string}} */ (placement));

            // Distribute each layer's group to the correct SVG layer
            /** @type {SVGGElement[]} */
            const elements = [];
            for (const [layerId, layerGroup] of fpLayers) {
                this.getLayerGroup(layerId).appendChild(layerGroup);
                elements.push(layerGroup);
            }

            this.placements.set(compId, {
                ...placement, elements,
                bounds: fpGeom.courtyard || fpGeom.outline,
                model3dPlacement: fpGeom.model3d || null,
            });
            this._buildLodPlaceholder(compId);
        }

        // Apply mirror / bottom-side overrides now that all elements exist
        // (rotation and position were baked into renderFootprint above).
        for (const compId of placements.keys()) {
            const pl = this.placements.get(compId);
            if (!pl) continue;
            if (pl.side === 'bottom') renderPlacementSide(this, compId, 'bottom');
            if (pl.refVisible === false) applyPlacementRefVisible(this, compId, false);
            // Pads and track bonds are already synchronized by the model.
            if (pl.mirror || pl.side === 'bottom' || pl.rotation || pl.refDx || pl.refDy || pl.refRot) {
                renderPlacementPose(this, compId);
            }
            if (pl.refSize !== REF_DEFAULT_SIZE || pl.refStrokeWidth !== REF_DEFAULT_STROKE) this.rerenderRef(compId);
        }
    }

    /**
     * Render one resolved footprint's SVG layer groups (a seam for headless tests).
     * @param {any} geometry
     * @param {Placement & {reference: string}} placement
     */
    _renderFootprint(geometry, placement) {
        return renderFootprint(geometry, placement.reference, placement.x, placement.y, placement.rotation);
    }

    /**
     * Create (once) the single level-of-detail placeholder rect for a
     * placement, covering its footprint bounds. Hidden by default; the cull
     * pass reveals it (and hides the real geometry) when the footprint is too
     * small to show detail. Re-created if it doesn't yet exist.
     * @param {string} compId
     */
    _buildLodPlaceholder(compId) {
        const pl = this.placements.get(compId);
        if (!pl || !pl.bounds) return;
        const NS = 'http://www.w3.org/2000/svg';
        const rect = document.createElementNS(NS, 'rect');
        rect.setAttribute('class', 'pcb-fp-lod culled');
        rect.setAttribute('x', String(pl.bounds.x));
        rect.setAttribute('y', String(pl.bounds.y));
        rect.setAttribute('width', String(pl.bounds.width));
        rect.setAttribute('height', String(pl.bounds.height));
        rect.setAttribute('pointer-events', 'none');
        rect.setAttribute('transform', placementTransform(pl));
        this.getLayerGroup('fp-lod').appendChild(rect);
        pl.lodEl = rect;
        pl._culled = false;
        pl._lodFar = false;
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
     * Fit the viewport to show all placed content.
     */
    _fitToPlacedContent() {
        if (!this.viewport || !this.placements.size) return;

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [, pl] of this.placements) {
            for (const [, pad] of pl.pads) {
                minX = Math.min(minX, pad.x - 2);
                minY = Math.min(minY, pad.y - 2);
                maxX = Math.max(maxX, pad.x + 2);
                maxY = Math.max(maxY, pad.y + 2);
            }
        }

        if (!Number.isFinite(minX)) return;

        const padding = 10;
        this.viewport.fitToBounds(
            minX - padding, minY - padding,
            maxX + padding, maxY + padding
        );
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

    /**
     * Restore saved placement models, then replace only their footprint artwork.
     * Used when overrides are loaded after footprints were already rendered.
     */
    applyPlacementOverrides() {
        const project = /** @type {ProjectDocument} */ (this.project);
        const placements = project.restorePcbPlacementOverrides(this.placements.keys());
        for (const compId of placements.keys()) {
            const pl = /** @type {Placement} */ (this.placements.get(compId));
            for (const element of pl.elements || []) element.remove();
            pl.lodEl?.remove();
        }
        this._placeFootprints(placements);
        this.updateRatsnest?.();
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

    /**
     * Select a component (or deselect if null).
     * Adds/removes a highlight outline on all layer groups for that component.
     * @param {string|null} compId
     */
    selectComponent(compId) {
        const previousCompId = getPcbSelection(this, 'component')[0] || null;
        if (previousCompId === compId) {
            if (!compId) renderPcbSelectionAnchors(this);
            return;
        }
        // Remove old selection highlight
        if (previousCompId) {
            const oldPl = this.placements.get(previousCompId);
            if (oldPl?.elements) {
                for (const el of oldPl.elements) {
                    el.querySelector('.pcb-selection-highlight')?.remove();
                }
            }
        }

        setPcbSelection(this, compId ? [{ kind: 'component', object: compId }] : []);
        this.syncClipboardButtons?.();

        if (!compId) {
            renderPcbSelectionAnchors(this);
            /** @type {Viewport} */ (this.viewport).svg.style.cursor = 'default';
            return;
        }

        // Add highlight rect to the first layer group (usually top-copper)
        const pl = this.placements.get(compId);
        if (!pl?.elements?.length) return;

        // Use the stored footprint bounds (courtyard or outline)
        const b = pl.bounds;
        if (!b) return;

        const NS = 'http://www.w3.org/2000/svg';
        const highlight = document.createElementNS(NS, 'rect');
        highlight.setAttribute('class', 'pcb-selection-highlight');
        highlight.setAttribute('x', String(b.x));
        highlight.setAttribute('y', String(b.y));
        highlight.setAttribute('width', String(b.width));
        highlight.setAttribute('height', String(b.height));
        highlight.setAttribute('fill', 'rgba(51,153,255,0.15)');
        highlight.setAttribute('stroke', '#3399ff');
        highlight.setAttribute('stroke-width', '0.2');
        highlight.setAttribute('pointer-events', 'none');
        pl.elements[0].appendChild(highlight);
        renderPcbSelectionAnchors(this);

        /** @type {Viewport} */ (this.viewport).svg.style.cursor = pl.locked ? 'default' : 'grab';
        // Ensure the selected footprint shows full detail even when zoomed out
        // far enough that it would otherwise be collapsed to its LOD placeholder.
        updatePcbCulling(this);
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

    /**
     * Select/deselect a text. Pass null to clear.
     * @param {object|null} text
     */
    selectText(text) {
        const prev = /** @type {PcbText|null} */ (getPcbSelection(this, 'text')[0] || null);
        const next = /** @type {PcbText|null} */ (text || null);
        // No-op when selection doesn't change — important because
        // refreshText removes & re-creates the SVG element, which
        // breaks the browser's same-target requirement for `dblclick`.
        if (prev === next || (prev && next && prev.id === next.id)) return;
        setPcbSelection(this, next ? [{ kind: 'text', object: next }] : []);
        this.syncClipboardButtons?.();
        if (prev && (!next || prev.id !== next.id)) this.refreshText(prev.id);
        if (next) this.refreshText(next.id);
        else renderPcbSelectionAnchors(this);
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

    /**
     * Show the properties panel for a selected reference designator. Mirrors
     * the Text-object panel (Type/Layer/Size/Rotation/Line W) and reuses the
     * same field-binding helper, but the Reference string and Layer are
     * read-only — only Size, Rotation and Line W can be edited.
     * @param {string|null} compId
     */
    showRefProperties(compId) {
        return PCBApp.prototype._getComponentProperties.call(this).showReference(compId);
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

    /** Routing adapters expose model operations, never the application itself. */
    _getAutorouter() {
        if (!this._autorouter) this._autorouter = new AutorouterSession({
            readBoard: () => ({
                active: isEditorActive(this),
                editing: hasPcbEditInProgress(this) || isPcbDrawing(this),
                model: this.pcbDocument, placements: this.placements, netlist: this.netlist,
                undo: this.history.undoStack, redo: this.history.redoStack,
                rules: this.getRoutingParams(),
            }),
            takeRouteInput: () => {
                const testInput = this._testBoardRouteInput;
                const input = testInput || this._buildRouteInput();
                this._testBoardRouteInput = null;
                if (testInput) input.copperObstacles = buildCopperObstacles(this);
                return input;
            },
            getRouterMode: () => this._getRouterMode(),
            adoptResult: result => this._renderRouteResult(/** @type {RouteResult} */ (result)),
            reconcileRatsnest: () => reconcileRatsnest(this),
            sessionEnded: () => noteEditSettled(this),
            setStatus: message => this.setStatus(message),
            presentation: {
                getProgressHost: () => this.status.modeStatus,
                getLayerGroup: id => this.getLayerGroup(id),
                getSvg: () => /** @type {SVGElement|null} */ (this.viewport?.svg),
                getRoutingParams: () => this.getRoutingParams(),
                refreshClearanceHalos: () => this.refreshClearanceHalos(),
            },
        });
        return this._autorouter;
    }

    runAutoRoute() { return this._getAutorouter().run(); }

    /** @param {string|null} [message] */
    cancelAutoRoute(message = null) {
        const autorouter = this._autorouter;
        if (autorouter) /** @type {(message?: string|null) => void} */ (autorouter.cancel).call(autorouter, message);
    }

    // ── Auto Router ───────────────────────────────────────────────

    /**
     * Load a test board JSON file and auto-route it.
     * Bypasses the normal placement/netlist pipeline — feeds RouteInput
     * directly to the autorouter and renders the results.
     * @param {string} filename - test board filename (e.g. 'test-board.json')
     */
    async loadTestBoard(filename) {
        try {
            const resp = await fetch(filename);
            if (!resp.ok) throw new Error(`Failed to fetch ${filename}: ${resp.status}`);
            const routeInput = /** @type {RouteInput} */ (await resp.json());

            // Clear existing board state
            this.clearRoutes();
            this._clearAllPlacements();

            // Render pads as visual indicators
            this._renderTestBoardPads(routeInput);

            // Set up netlist/placements so ratsnest works
            this._setupTestBoardState(routeInput);

            // Rebuild ratsnest
            if (!this._ratsnestGroup) {
                this._ratsnestGroup = this.getLayerGroup('ratlines');
            }
            this.refreshClearanceHalos();
            this.updateRatsnest();

            // Fit viewport to board bounds
            if (routeInput.bounds && this.viewport) {
                const b = routeInput.bounds;
                const margin = 5;
                this.viewport.fitToBounds(
                    b.minX - margin, b.minY - margin,
                    b.maxX + margin, b.maxY + margin
                );
            }

            this.setStatus(`Loaded ${filename} — ${routeInput.connections.length} nets, click Auto Route to route`);

            // Store the original route input so runAutoRoute uses it directly
            // instead of rebuilding from placements/netlist
            this._testBoardRouteInput = routeInput;

        } catch (err) {
            this.setStatus(`Error loading test board: ${err.message}`);
            console.error(err);
        }
    }

    /**
     * Render test board pads as SVG rectangles for visual reference.
     * @param {RouteInput} routeInput
     */
    _renderTestBoardPads(routeInput) {
        const NS = 'http://www.w3.org/2000/svg';
        const topCopper = this.getLayerGroup('top-copper');
        const bottomCopper = this.getLayerGroup('bottom-copper');
        const pads = routeInput.allObstaclePads || [];
        for (const pad of pads) {
            const rect = document.createElementNS(NS, 'rect');
            rect.setAttribute('class', 'pcb-test-pad');
            rect.setAttribute('x', String(pad.x - pad.width / 2));
            rect.setAttribute('y', String(pad.y - pad.height / 2));
            rect.setAttribute('width', String(pad.width));
            rect.setAttribute('height', String(pad.height));
            rect.setAttribute('fill', pad.layer === 'bottom' ? '#0066ff' : '#ff6633');
            rect.setAttribute('opacity', '0.8');
            const parent = pad.layer === 'bottom' ? bottomCopper : topCopper;
            parent.appendChild(rect);
        }
    }

    /**
     * Set up internal state (placements, netlist) from a RouteInput
     * so that ratsnest and auto-route work correctly.
     * @param {RouteInput} routeInput
     */
    _setupTestBoardState(routeInput) {
        this.placements = new Map();
        this.netlist = [];

        // Build minimal placements from allObstaclePads
        // Group pads into a single virtual component
        // Pad layers follow the footprint/autorouter convention:
        // 'top' | 'bottom' | 'both' (short form). Track layers use the
        // long SVG-layer-id form ('top-copper'/'bottom-copper').
        const padOffsets = /** @type {PadOffset[]} */ ((routeInput.allObstaclePads || []).map((p, i) => ({
            number: String(i),
            dx: p.x,
            dy: p.y,
            width: p.width,
            height: p.height,
            layer: p.layer === 'bottom' ? 'bottom' : p.layer === 'both' ? 'both' : 'top',
        })));
        /** @type {Map<string|number, BoardPad>} */
        const padMap = new Map();
        for (const off of padOffsets) {
            padMap.set(off.number, { x: off.dx, y: off.dy });
        }
        this.placements.set('TestBoard', {
            x: 0, y: 0, name: 'TestBoard',
            pads: padMap,
            padOffsets,
            elements: [],
            bounds: routeInput.bounds || { minX: 0, minY: 0, maxX: 100, maxY: 100 },
        });

        // Build netlist from connections
        for (const conn of routeInput.connections) {
            const pins = conn.pads.map(p => {
                // Find matching pad index
                const allPads = routeInput.allObstaclePads || [];
                const idx = allPads.findIndex(op =>
                    Math.abs(op.x - p.x) < 0.01 && Math.abs(op.y - p.y) < 0.01
                );
                return { componentId: 'TestBoard', pinNumber: String(idx >= 0 ? idx : 0) };
            });
            this.netlist.push({ net: conn.net, pins });
        }
    }

    /**
     * Remove all placement SVG elements.
     */
    _clearAllPlacements() {
        if (!this.viewport?.svg) return;
        for (const el of this.viewport.svg.querySelectorAll('.pcb-test-pad')) {
            el.remove();
        }
    }

    /**
     * Convert placements + netlist into the input format for our A* router.
     * @returns {import('../pcb/modules/autorouter-common.js').RouteInput}
     */
    _buildRouteInput() {
        return buildRouteInput(this);
    }

    /**
     * Dump the current route input as JSON to clipboard (for test board generation).
     * Usage:  bootstrap.pcbApp.dumpRouteInput()
     * Then paste into a file.
     */
    async dumpRouteInput(filename = 'route-input.json') {
        const input = this._testBoardRouteInput || this._buildRouteInput();
        const json = JSON.stringify(input);
        try {
            await navigator.clipboard.writeText(json);
            const obstaclePads = /** @type {NonNullable<RouteInput['allObstaclePads']>} */ (input.allObstaclePads);
            console.log(`Route input copied to clipboard (${input.connections.length} nets, ${obstaclePads.length} pads). Paste into ${filename}`);
        } catch (e) {
            const w = window.open('', '_blank');
            if (w) {
                // Use DOM APIs (never document.write with interpolated JSON)
                // so any special characters in the payload can't break out
                // of the <pre>.
                const pre = w.document.createElement('pre');
                pre.textContent = json;
                w.document.body.appendChild(pre);
            }
            console.log(`Clipboard failed — opened in new tab. Save as ${filename}`);
        }
    }

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



    /**
     * Select (or clear) the active pour and refresh its highlight.
     * @param {CopperFill|null} fill
     */
    selectFill(fill) {
        const prev = getPcbSelection(this, 'fill')[0] || null;
        if (prev === fill) {
            if (fill) renderPcbSelectionAnchors(this);
            return;
        }
        const next = fill || null;
        setPcbSelection(this, next ? [{ kind: 'fill', object: next }] : []);
        this.syncClipboardButtons?.();
        // Re-render the previously- and newly-selected fills to update the
        // boundary highlight.
        const getGroup = /** @param {string} id */ (id) => this.getLayerGroup(id);
        if (prev) {
            renderCopperFill(prev, getGroup, { selected: false });
        }
        if (next) {
            renderCopperFill(next, getGroup,
                { selected: true });
            if (isPcbSelected(this, 'fill', next)) renderPcbSelectionAnchors(this);
        }
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

    /** Delete the selected pour (Delete/Backspace). */
    deleteSelectedFill() {
        const fill = getPcbSelection(this, 'fill')[0] || null;
        if (!fill) return false;
        if (fill.locked || isLayerLocked(fill.layer)
            || isCopperFillLocked(fill.layer)) return false;
        if (deleteFocusedFillPart(this, fill)) return true;
        this.history.execute(new RemoveFillCommand(this, fill));
        return true;
    }

    /**
     * Render the Properties-tab editor for a selected copper pour. The pour
     * has two editable attributes: its net (same-net copper is joined, other
     * nets are cleared) and its copper layer. Both commit through a single
     * ModifyFillCommand for clean undo/redo.
     */
    /**
     * Render routing result onto copper layers and hide routed ratlines.
     *
     * Converts the autorouter's raw {tracks, vias} payload into Track and
     * Via model instances stored on this.tracks / this.vias, then renders
     * those via the track-render module. All downstream selection/edit/
     * undo operations operate on the model, not on raw SVG.
     *
     * @param {import('../pcb/modules/autorouter-common.js').RouteResult} result
     */
    _renderRouteResult(result) {
        const params = this.getRoutingParams();
        const { tracks, vias } = tracksFromAutorouterResult(result, {
            trackWidth: params.trackWidth,
            viaDiameter: params.viaDiameter,
            viaDrill: params.viaDrill,
            placements: this.placements,
        });
        // Locked copper was routed around as fixed copper; keep it alongside the result.
        const kept = lockedRoutedCopper(this);
        this.history.execute(new ReplaceRoutesCommand(this, [...kept.tracks, ...tracks], [...kept.vias, ...vias],
            result.failedConnections));
    }

    /**
     * Clear routed tracks/vias and restore ratlines. Locked copper stays.
     */
    clearRoutes() {
        this.cancelAutoRoute();

        const kept = lockedRoutedCopper(this);
        const command = new ReplaceRoutesCommand(this, kept.tracks, kept.vias);
        command.description = 'Clear routed copper';
        if (this.pcbDocument.tracks.length > kept.tracks.length || this.pcbDocument.vias.length > kept.vias.length) {
            this.history.execute(command);
        } else renderRoutedCopper(this);
        this.setStatus(kept.tracks.length || kept.vias.length ? 'Routes cleared; locked copper kept' : 'Routes cleared');
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
     * Export the current board as a Specctra DSN file and trigger download.
     */
    exportDSN() {
        if (!this.placements.size || !this.netlist.length) {
            this.setStatus('Nothing to export');
            return;
        }

        const params = this.getRoutingParams();
        const dsn = exportDSN({
            placements: this.placements,
            netlist: this.netlist,
            trackWidth: params.trackWidth,
            clearance: params.clearance,
            viaDiameter: params.viaDiameter,
        });

        const blob = new Blob([dsn], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'board.dsn';
        a.click();
        URL.revokeObjectURL(url);

        this.setStatus('DSN exported — open in Freerouting, then Import SES');
    }

    /**
     * Export the current board as a ZIP of Gerber + Excellon drill files.
     * Files included: top/bottom copper, top silkscreen, board outline,
     * and an Excellon drill file.
     */
    openPanelize() {
        this.ensureViewport();
        openPanelizeDialog(this);
    }

    async exportGerber() {
        if (this._exportGerberPending) return;
        if (!hasFabricationContent(this)) {
            this.setStatus('Nothing to export');
            return;
        }
        this._exportGerberPending = true;
        const suggestedName = `${projectBaseName(this, 'untitled')}-gerber.zip`;
        try {
            let fileCount = 0;
            const saved = await savePcbBlob(async () => {
                const result = await generateGerberArchive(this);
                fileCount = result.fileCount;
                /** @type {(label: string|null, value?: number|null) => void} */ (showGerberProgress)('Saving ZIP', 100);
                return result.blob;
            }, suggestedName, {
                description: 'Gerber ZIP archive',
                accept: { 'application/zip': ['.zip'] },
            });
            if (saved) this.setStatus(`Gerbers exported (${fileCount} files)`);
        } catch (err) {
            console.error('Gerber export failed:', err);
            this.setStatus(`Gerber export failed: ${err?.message || err}`);
        } finally {
            showGerberProgress(/** @type {string} */ (/** @type {unknown} */ (null)));
            this._exportGerberPending = false;
        }
    }

    /**
     * Export the Bill of Materials as a CSV file.
     */
    exportBOM() {
        if (!this.placements.size) {
            this.setStatus('No components to export');
            return;
        }
        let blob;
        try {
            const csv = generateBOM(this.placements);
            blob = new Blob([csv], { type: 'text/csv' });
        } catch (err) {
            console.error('BOM export failed:', err);
            this.setStatus(`BOM export failed: ${err?.message || err}`);
            return;
        }
        const suggestedName = `${projectBaseName(this, 'untitled')}-bom.csv`;
        savePcbBlob(blob, suggestedName, {
            description: 'CSV file',
            accept: { 'text/csv': ['.csv'] },
        }).then(saved => {
            if (saved) this.setStatus(`BOM exported (${this.placements.size} parts)`);
        }).catch(err => {
            console.error('BOM save failed:', err);
            this.setStatus(`BOM save failed: ${err?.message || err}`);
        });
    }

    /**
     * Export the Pick-and-Place (centroid) file as a CSV.
     */
    exportPickAndPlace() {
        if (!this.placements.size) {
            this.setStatus('No components to export');
            return;
        }
        let blob;
        try {
            const csv = generatePickAndPlace(this.placements);
            blob = new Blob([csv], { type: 'text/csv' });
        } catch (err) {
            console.error('Pick-and-place export failed:', err);
            this.setStatus(`Pick-and-place export failed: ${err?.message || err}`);
            return;
        }
        const suggestedName = `${projectBaseName(this, 'untitled')}-pick-and-place.csv`;
        savePcbBlob(blob, suggestedName, {
            description: 'CSV file',
            accept: { 'text/csv': ['.csv'] },
        }).then(saved => {
            if (saved) this.setStatus(`Pick-and-place exported (${this.placements.size} parts)`);
        }).catch(err => {
            console.error('Pick-and-place save failed:', err);
            this.setStatus(`Pick-and-place save failed: ${err?.message || err}`);
        });
    }

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

    /**
     * Prompt user to select an SES file and import routed tracks.
     */
    importSES() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.ses';
        input.addEventListener('change', () => {
            const file = input.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                const text = /** @type {string} */ (reader.result);
                const result = importSES(text);
                if (!result.tracks.length) {
                    this.setStatus('No routes found in SES file');
                    return;
                }
                this.cancelAutoRoute();
                // Log first track for debugging coordinates
                if (result.tracks.length) {
                    const t = result.tracks[0];
                    console.log(`[SES] First track: net=${t.net} layer=${t.layer} pts=${t.points.length}`, t.points);
                    // Log placement coords for comparison
                    for (const [, pl] of this.placements) {
                        for (const [num, pos] of pl.pads) {
                            console.log(`[SES] Pad ${pl.reference}-${num} at (${pos.x.toFixed(2)}, ${pos.y.toFixed(2)})`);
                            break;
                        }
                        break;
                    }
                }
                // Render imported tracks (and their vias)
                this._renderRouteResult({ tracks: result.tracks, vias: result.vias || [], failed: [] });
                this.setStatus(`Imported ${result.tracks.length} track(s), ${result.vias?.length || 0} via(s) from SES`);
            };
            reader.readAsText(file);
        });
        input.click();
    }
}
