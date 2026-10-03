// @ts-nocheck — PCBApp uses loosely-typed Maps and nullable viewport access throughout
// PCBApp.js - PCB Editor Application

import { serializePcb, preparePcb, loadPcb } from '../pcb/modules/project-state.js';
import { AutorouterSession } from '../pcb/modules/autorouter-session.js';
import { ComponentProperties } from '../pcb/modules/component-properties.js';
import { bindPcbControls } from '../pcb/modules/controls.js';
import { Viewport } from '../core/Viewport.js';
import { snapToViewportGrid } from '../core/grid-snap.js';
import { displayRotationDegrees } from '../core/number-inputs.js';
import { PcbDocument } from '../core/PcbDocument.js';
import { commitDesignInput, renderDesignSettings } from '../pcb/modules/design-settings.js';
import { loadAndApplyTheme, toggleTheme as toggleSharedTheme, syncThemeToggleButtons } from '../shared/ui/theme.js';
import { renderFootprint, applyRefGeometry, REF_DEFAULT_SIZE, REF_DEFAULT_STROKE } from '../shared/pcb/footprint.js';
import { updateGridDropdown, restoreGridSettings, serializeGridSettings } from '../shared/ui/viewport.js';
import { setToolCursor } from '../shared/ui/cursor.js';
import { sortByPropertyOrder } from '../shared/ui/property-order.js';
import { bindRibbonHeight } from '../shared/ui/ribbon-height.js';
import { isUnmodifiedPrimaryDoublePress } from '../shared/ui/inline-edit-activation.js';
import {
    applyTextConnectionGuide,
    createInlineTextOverlay,
    setInlineTextInputActive,
} from '../shared/ui/inline-text-overlay.js';
import { PCB_LAYERS, PCB_OVERLAYS, PCB_COPPER_FILLS, isLayerLocked, isViaLocked, isLayerVisible, isViaVisible, pcbLayerHoverColor, pcbLayerSelectionColor, pcbLayerOptionHtml, refreshPcbLayerOptions, showLockedLayerBubble, isCopperFillLocked, isCopperFillVisible, saveLayerPrefs, setPcbCopperFillLocked, setPcbLayerLocked } from '../pcb/modules/layers.js';
import { exportDSN, importSES } from '../pcb/modules/dsn.js';
import { DrcPresentation } from '../pcb/modules/drc-presentation.js';
import { resolveDrcPairMarker } from '../pcb/modules/drc.js';
import { scheduleDrcRefresh, runDrcNow, invalidateDrcRefresh, disposeDrcRefresh } from '../pcb/modules/drc-refresh.js';
import { cancelPcbPosePreviews, disposePcbPropertyEditors, hasPcbEditInProgress } from '../pcb/modules/edit-lifecycle.js';
import { dispatchPcbPointerMove } from '../pcb/modules/pcb-interaction-routing.js';
import { isPcbDrawing } from '../pcb/modules/pcb-interactions.js';
import { runPcbDeleteAction, runPcbEscapeAction, runPcbHistoryAction, runPcbNudgeAction, savePcbProject } from '../pcb/modules/editor-actions.js';
import { PCB_CROSSHAIR_TOOLS, cancelPcbDrawingMode, preparePcbRibbonTransition } from '../pcb/modules/tool-lifecycle.js';
import { buildCopperObstacles } from '../pcb/modules/copper-obstacles.js';
import { hasFabricationContent } from '../pcb/modules/fabrication-snapshot.js';
import { openPanelizeDialog, renderPanelPreview } from '../pcb/modules/panelization-ui.js';
import { generateGerberArchive, showGerberProgress } from '../pcb/modules/gerber-export.js';
import { generateBOM, generatePickAndPlace } from '../pcb/modules/assembly.js';
import { openBoard3DViewer } from '../pcb/modules/board3d.js';
import { savePcbPdf, printPcb, projectBaseName } from '../pcb/modules/pcb-export.js';import { tracksFromAutorouterResult } from '../pcb/modules/autorouter-adapter.js';
import { renderTrack, renderVia, removeTrackElements, removeViaElements, buildTrackLayerRuns, hasTrackElements, hasViaElements } from '../pcb/modules/track-render.js';
import { startTrackDraw, updateTrackDraw, refreshTrackDrawPreview, addTrackWaypoint, finishTrackDraw, cancelTrackDraw, toggleTrackLayer, resolveTrackDrawSnap, resolveTrackSnap, showTrackSnapMarker, clearTrackSnapMarker, reconcileRatsnest } from '../pcb/modules/track-draw.js';
import { hitTestTrack, hitTestLockedTrack, selectTrackOrVia, clearTrackSelection, setHoverHighlight, showTrackContextMenu, refreshTrackSelectionHalo, getSelectedTrack, getSelectedVia, selectTrackSegment, dismissTrackContextMenu, applyNetToCopperSelection, trackIsSelectable } from '../pcb/modules/track-select.js';
import { getBoardShapeRotationPreview, getBoardShapePointerPreview, getBoardShapePropertyPreview, finishBoardShapeRotationPreview } from '../pcb/modules/board-shapes.js';
import {
    startVertexDrag,
    updateVertexDrag,
    finishVertexDrag,
    cancelVertexDrag,
    trackPointerTouchesLayer,
    startViaDrag,
    finishViaDrag,
    hitTestTrackNode,
    findSplittableTrackEdge,
    splitTrackObjectAtPoint,
    commitCollinearCleanup,
    hitTestTrackMidpoint,
    buildDrawnTrackCommands,
} from '../pcb/modules/track-drag.js';
import {
    AddTrackCommand,
    AddViaCommand,
    RemoveTrackCommand,
    ReplaceRoutesCommand,
    ModifyTrackGraphCommand,
    CompoundCommand,
    MovePlacementCommand,
    RotatePlacementCommand,
    SetPlacementLockedCommand,
    FlipPlacementCommand,
    SetPlacementSideCommand,
    SetPlacementRefVisibleCommand,
    MoveRefTextCommand,
    RotateRefTextCommand,
    SetRefStyleCommand,
    SetBoardOutlineCommand,
    ModifyViaCommand,
    previewPlacementPose,
    finishPlacementPreview,
    getPlacementPreviewTracks,
    getViaPropertyPreview,
    getTrackPropertyPreview,
    canonicalTrack,
    renderPlacementPose,
    renderPlacementSide,
    applyPlacementRefVisible,
    placementTransform,
    isPlacementMirrored,
} from '../pcb/modules/track-commands.js';
import { renderPcbText, pcbTextEditBox, pcbTextHitTest, textColorForLayer } from '../pcb/modules/pcb-text.js';
import { createPcbText, serializePcbText, TEXT_LAYERS } from '../core/pcb-text.js';
import { showAlert } from '../shared/ui/modal.js';
import { connectBoxOutlines } from '../core/geometry.js';
import {
    AddTextCommand,
    RemoveTextCommand,
    MoveTextCommand,
    EditTextCommand,
    getTextPosePreviewTexts,
    previewTextPose,
    finishTextPosePreview,
    beginTextContentPreview,
    beginTextPropertyPreview,
    finishTextPropertyPreview,
} from '../pcb/modules/text-commands.js';
import { shapeDrawClick, cancelShapeDraw, finishPolygonDraw, finishLineDraw, finishShapeDrawAtPoint, hitTestBoardShape, setBoardShapeHover, selectBoardShape, startBoardShapeDrag, endBoardShapeDrag, resolveShapeDrawLayer, boardShapeCopperCuts, renderBoardShape, hitTestBoardShapeVertex, showBoardShapeContextMenu, dismissBoardShapeContextMenu, captureBoardShapeState, applyShapeSnapshot } from '../pcb/modules/board-shapes.js';
import { showBoardShapeProperties, showBoardShapeToolProperties, refreshBoardShapeToolLayer } from '../pcb/modules/board-shape-properties.js';
import { ModifyBoardShapeCommand } from '../pcb/modules/shape-commands.js';
import { shapeOutline, normalizeShapeCopperMode, boardShapeRemovalPathD, boardShapeBounds } from '../shared/pcb/board-shape-geometry.js';
import { hitTestPcbSelectionAnchor, renderPcbSelectionAnchors } from '../pcb/modules/selection-anchors.js';
import { refreshAxisGlow } from '../pcb/modules/axis-glow.js';
import { buildFillContext } from '../pcb/modules/fill-context.js';
import { scheduleFillRefresh, recomputeFillsNow, invalidateFillRefresh, disposeFillRefresh } from '../pcb/modules/fill-refresh.js';
import { hasAny3DModel, openComponent3DFromData, buildComponent3DTitle } from '../components/model3d-source.js';
import {
    armBoxSelect,
    maybeStartBoxSelect,
    finishBoxSelect,
    refreshBoxSelectionHighlights,
    toggleBoxShapeSelection,
    clearBoxSelection,
    deselectHiddenPcbSelection,
    hasBoxSelection,
    pointInBoxSelection,
    beginGroupDrag,
    getGroupPreview,
    endGroupDrag,
    deleteBoxSelection,
} from '../pcb/modules/box-select.js';
import {
    beginSelectionInteraction,
    clearSelectionInteractionUi,
    showPcbSelectionProperties,
    finishSelectionInteraction,
    selectionInteractionCursor,
    placeFloatingSelectionInteraction,
} from '../pcb/modules/selection-interaction.js';
import { getPcbSelection, getPcbSelectionEntries, getPcbSelectionHits, isPcbSelected, setPcbSelection, syncPcbSelection } from '../pcb/modules/selection-registry.js';
import { measureText as measureStrokeText, stringToPolylines } from '../shared/pcb/stroke-font.js';
import { CommandHistory } from '../core/CommandHistory.js';
import { Track } from '../shapes/track.js';
import { Via } from '../shapes/via.js';
import { Pad } from '../shapes/pad.js';
import { CopperFill } from '../shapes/copper-fill.js';
import { padCopperPathD, padLayers, renderPad } from '../pcb/modules/pad.js';
import {
    AddPadCommand, ModifyPadCommand, getPadRotationPreview,
    getPadPropertyPreview, beginPadPropertyPreview, finishPadPropertyPreview, canonicalPad,
} from '../pcb/modules/pad-commands.js';
import '../pcb/modules/pad-selection.js';
import { boardShapeClearanceOutlines, pcbTextClearanceOutlines } from '../pcb/modules/copper-fill-geom.js';
import { bindPictureRefreshHold, schedulePictureCopperRefresh, shouldDeferShapeClearance } from '../pcb/modules/picture-refresh.js';
import { PICTURE_LAYERS } from '../shared/pcb/picture-raster.js';
import { renderCopperFill, fillGroupId, setCopperFillClip } from '../pcb/modules/copper-fill-render.js';
import { RemoveFillCommand, ModifyFillCommand } from '../pcb/modules/copper-fill-commands.js';
import '../pcb/modules/copper-fill-selection.js';
import { startFillEditAt, updateFillEdit, endFillEdit, showFillContextMenu,
    addFillGeometryProperties, deleteFocusedFillPart, canEditFill, showFillProperties } from '../pcb/modules/copper-fill-edit.js';
import '../pcb/modules/component-selection.js';
import '../pcb/modules/pcb-text-selection.js';
import { isRefTextLocked } from '../pcb/modules/ref-text-selection.js';
import {
    startFillDraw,
    addFillWaypoint,
    finishFillDraw,
    cancelFillDraw,
} from '../pcb/modules/copper-fill-draw.js';
import { preparePcbPaste, beginPcbPaste, updatePcbPaste, endPcbPaste, cancelPcbPaste, isPcbPasteEditable } from '../pcb/modules/pcb-paste.js';
import { getBoardOutline, boardBoundary } from '../shared/pcb/board-outline.js';
import { eachPropertyEditorOnLayer, getPropertyEditor, setPropertyEditor } from '../pcb/modules/property-editors.js';
import { areDragOverlaysDeferred, isFillRefreshPending, onRefreshSuspended, setDragOverlaysDeferred } from '../pcb/modules/refresh-state.js';
import {
    beginBoardOutlineResize, updateBoardOutlineResize, endBoardOutlineResize,
    renderBoardOutlineHandles, hitTestBoardOutlineHandle,
    getBoardDimensionPreview, bindBoardDimensionProperties, showBoardOutlineProperties,
} from '../pcb/modules/board-outline-resize.js';
import { getBoardShapeNodeFocus, getBoardShapeSegmentFocus } from '../pcb/modules/board-shape-state.js';
import { showTextToolProperties, showTextProperties, bindStrokeTextProps } from '../pcb/modules/text-properties.js';
import { showPadEditor } from '../pcb/modules/pad-properties.js';
import { multiPropertyCapabilities, showMultiSelectionProperties } from '../pcb/modules/multi-selection-properties.js';

/**
 * On-screen size (CSS px) of a footprint's bounding box below which it is
 * drawn as a single level-of-detail placeholder rect instead of its full
 * pad/silk/text geometry. Keeps zoomed-out pan/zoom fast on large boards.
 */
const PCB_LOD_PIXEL_THRESHOLD = 24;

/**
 * Padding (mm) added around a reference designator's tight glyph bounding box
 * for both its selection outline and its drag grab region, so the box sits
 * comfortably around the label instead of touching the strokes.
 */
const REF_BOX_PAD = 0.6;

function measureStrokeTextVerticalBounds(text, size, strokeWidth = 0) {
    const polylines = stringToPolylines(text, 0, 0, size, false);
    let top = Infinity;
    let bottom = -Infinity;
    for (const polyline of polylines) {
        for (const point of polyline) {
            top = Math.min(top, point.y);
            bottom = Math.max(bottom, point.y);
        }
    }
    if (!Number.isFinite(top) || !Number.isFinite(bottom)) {
        top = -size;
        bottom = 0;
    }
    const strokeRadius = Math.max(Number(strokeWidth) || 0, 0) / 2;
    return { top: top - strokeRadius, bottom: bottom + strokeRadius };
}

// Raising a suspension invalidates in-flight derived work on the editor, as its
// former property setters did. Other objects (test doubles) are unaffected.
onRefreshSuspended('overlays', app => {
    if (!(app instanceof PCBApp)) return;
    invalidateFillRefresh(app);
    invalidateDrcRefresh(app);
});
onRefreshSuspended('fill', app => {
    if (app instanceof PCBApp) invalidateDrcRefresh(app);
});

/** PCBApp method handling a primary-button press for each tool. */
const PCB_TOOL_PRESS_HANDLERS = Object.freeze({
    select: '_pressSelectTool',
    track: '_pressTrackTool',
    fill: '_pressFillTool',
    via: '_pressViaTool',
    pad: '_pressPadTool',
    line: '_pressShapeTool',
    circle: '_pressShapeTool',
    rect: '_pressShapeTool',
    polygon: '_pressShapeTool',
    arc: '_pressShapeTool',
    text: '_pressTextTool',
});

/**
 * PCB editor application.
 *
 * Keeps the PCB canvas in sync with the schematic: whenever the
 * schematic changes (undo/redo, shape add/remove, file load) the
 * PCB is marked stale and rebuilt the next time the pane becomes
 * visible.  If the PCB pane is already visible the rebuild happens
 * immediately (debounced).
 */
export default class PCBApp {
    get tracks() {
        return getGroupPreview(this)?.tracks || this._pasteDrop?.preview?.tracks || getPlacementPreviewTracks(this) || this._viaDrag?.preview?.tracks
            || this._vertexDrag?.preview?.tracks || getTrackPropertyPreview(this)?.tracks || this.pcbDocument.tracks;
    }
    set tracks(value) { this.pcbDocument.tracks = value; }
    get vias() { return getGroupPreview(this)?.vias || this._pasteDrop?.preview?.vias || this._viaDrag?.preview?.vias || getViaPropertyPreview(this)?.vias || this.pcbDocument.vias; }
    set vias(value) { this.pcbDocument.vias = value; }
    get pads() {
        return getGroupPreview(this)?.pads || this._pasteDrop?.preview?.pads || this._viaDrag?.preview?.pads || getPadRotationPreview(this)?.pads
            || getPadPropertyPreview(this)?.pads || this.pcbDocument.pads;
    }
    set pads(value) { this.pcbDocument.pads = value; }
    get texts() { return this._pasteDrop?.preview?.texts || getTextPosePreviewTexts(this) || this.pcbDocument.texts; }
    set texts(value) { this.pcbDocument.texts = value; }
    get boardShapes() { return getGroupPreview(this)?.boardShapes || this._pasteDrop?.preview?.boardShapes || getBoardDimensionPreview(this)?.boardShapes || getBoardShapePointerPreview(this)?.boardShapes || getBoardShapeRotationPreview(this)?.boardShapes || getBoardShapePropertyPreview(this)?.boardShapes || this.pcbDocument.boardShapes; }
    set boardShapes(value) { this.pcbDocument.boardShapes = value; }
    get _shapeIdCounter() { return this.pcbDocument.shapeIdCounter; }
    set _shapeIdCounter(value) { this.pcbDocument.shapeIdCounter = value; }
    get _boardWidth() { return getBoardDimensionPreview(this)?.board.width ?? this.pcbDocument.board.width; }
    set _boardWidth(value) { this.pcbDocument.board.width = value; }
    get _boardHeight() { return getBoardDimensionPreview(this)?.board.height ?? this.pcbDocument.board.height; }
    set _boardHeight(value) { this.pcbDocument.board.height = value; }
    get _boardRadius() { return getBoardDimensionPreview(this)?.board.radius ?? this.pcbDocument.board.radius; }
    set _boardRadius(value) { this.pcbDocument.board.radius = value; }
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
        this.themeToggle = document.getElementById('pcbThemeToggle');
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
        this._active = false;
        this.viewport = null;
        this.syncPcbViewToggles = null;
        this.currentTool = 'select';
        this.activeLayer = 'top-copper';

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
         * @type {Map<string, object>}
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
        /** Cached netlist from last sync */
        this.netlist = [];

        this._padDefaults = {
            shape: 'round', size: 1.5, drill: 0.8, ratio: 2,
            rotation: 0, layers: 'both', net: '',
        };

        /** Currently selected CopperFill, or null. */
        /** True when the schematic has changed since last PCB rebuild */
        this._stale = true;
        /** Debounce timer for live rebuilds while PCB pane is active */
        this._syncTimer = null;
        /** True after the first sync (governs fitToBounds) */
        this._hasContent = false;
        /** Whether a board outline exists, including before its first render. */
        this._boardOutlineDrawn = !!getBoardOutline(this);
        /** @type {HTMLDivElement|null} */
        this._boardDimensionsOverlay = null;
        /** Whether the board outline is currently selected */
        this._boardOutlineSelected = false;
        this._boardOutlineResize = null;
        /** UI element refs (set by controls.js) */
        this.ui = null;

        // ── Selection & drag state ────────────────────────────
        /** Component ID currently showing a hover outline, or null */
        this._hoveredComp = null;
        /** Drag state: { compId, startWorld, startPos } or null */
        this._drag = null;
        /**
         * Box (marquee) multi-selection state. Populated lazily by the
         * box-select module: { comps:Set, tracks:Set, vias:Set }.
         * @type {{comps:Set, tracks:Set, vias:Set}|null}
         */
        /** Pending marquee arm (before the drag threshold), or null */
        this._boxSelectArm = null;
        /** True while a marquee is actively being dragged */
        this._boxSelectActive = false;
        /** Group-drag state for a box selection, or null */
        this._groupDrag = null;

        /** SVG <g> elements keyed by text id for quick remove/replace. */
        this._textElements = new Map();
        /** Currently selected text object, or null. */
        /** Active text drag: { textId, startWorld, startPos } or null. */
        this._textDrag = null;
        /** Active reference-text drag: { compId, startWorld, startDx, startDy } or null. */
        this._refDrag = null;
        /** Overlay <g> for the ref-text selection box and drag tether. */
        this._refOverlay = null;
        /** Defaults for the Text tool (modifiable via tool options). */
        this._textDefaults = { size: 1.0, rotation: 0, layer: 'top-silk', strokeWidth: 0.15, border: false };
        /** Last typed content for the Text tool. */
        this._lastTextContent = 'Text';
        /** In-memory PCB clipboard payload. */
        this._pcbClipboard = null;
        /** SVG <path> elements keyed by shape id for quick remove/replace. */
        this._shapeElements = new Map();
        // Board-shape hover, node/segment focus and tool defaults live in board-shape-state.js.
        /** Number of selectable PCB objects under the pointer. */
        this._overlapHitCount = 0;
        /** Currently selected board shape, or null. */
        /** Active in-progress board-shape draw interaction, or null. */
        this._shapeDraw = null;
        /** Active board-shape drag: { id, startWorld, before } or null. */
        this._shapeDrag = null;
        /** Selected-track node/edge edit state (track-select.js), or null. */
        this._trackEdit = null;
        /** Active track vertex/edge drag (track-drag.js), or null. */
        this._vertexDrag = null;
        /** Active via drag (track-drag.js), or null. */
        this._viaDrag = null;
        /** Copper-fill outline being drawn, or null. */
        this._fillDraw = null;
        /** Active selection-anchor gesture (selection-interaction.js), or null. */
        this._pcbSelectionInteraction = null;
        /** Home-tab tool highlight sync, installed by bindPcbControls(). */
        this._syncPcbHomeToolHighlight = null;
        /** Active paste-drop interaction (pasted items glued to cursor). */
        this._pasteDrop = null;
        /** Screen position where the current right-button pan began. */
        this._rightPanStart = null;
        /** Consume the contextmenu event generated by a completed right-drag. */
        this._suppressNextContextMenu = false;

        /**
         * Undo/redo for PCB-side edits (tracks, vias, vertex drags,
         * property tweaks). Separate from the schematic's history.
         * @type {CommandHistory}
         */
        this.history = new CommandHistory({
            maxSize: 200,
            // Flag PCB as having unsaved changes so the schematic-side
            // autosave (which serialises the combined document) fires.
            // Setting a private flag here \u2014 rather than calling
            // schematic.fileManager.setDirty() \u2014 avoids triggering
            // the schematic\u2192PCB stale-sync listener that would
            // otherwise rebuild and wipe PCB-only edits.
            onChanged: () => this._onHistoryChanged(),
        });
        /** Debug tooltip for showing raw footprintShapes data */
        this._debugTooltip = null;
        this._debugTooltipVisible = false;
        this._debugTooltipPinned = false;
        this._showDebugTooltip = false;
        /** Transient message bubble shown over a component, or null. */
        this._componentPopup = null;
        /** Lazily created owner of routing session and temporary presentation. */
        this._autorouter = null;
        /** @type {object|null} Stored test board RouteInput for direct routing. */
        this._testBoardRouteInput = null;
    }

    initialize() {
        if (this._initialized) return;

        this._bindRibbonTabs();
        bindPcbControls(this);
        this._initDebugTooltip();
        this._bindThemeToggle();
        loadAndApplyTheme();
        syncThemeToggleButtons(['themeToggle', 'pcbThemeToggle']);
        this._initDRC();

        this._initialized = true;
    }

    preload() {
        if (this._active || !this._stale) return false;
        this.initialize();
        this._ensureViewport();
        this._active = true;
        try {
            this._syncFromSchematic();
        } finally {
            this._active = false;
        }
        return !this._stale;
    }

    activate() {
        this.initialize();
        this._active = true;
        setInlineTextInputActive(this._textEdit?.input, true);

        this._retainRibbonHeight?.();
        this._ensureViewport();
        this._updateCursorForTool();
        this._syncPcbHomeToolHighlight?.();
        this.viewport?._onResize?.();
        this._drcPresentation?.activate();
        this._updateViewportStatus();
        this.syncPcbViewToggles?.();
        updateGridDropdown(this);

        // Rebuild if schematic changed while we were away
        if (this._stale) this._syncFromSchematic();
        if (isFillRefreshPending(this)) this.refreshFills();
        if (this._drcPending || this._drcShouldRun()) this._scheduleDRC();

        this.setPcbStatus();
        if (this.viewport) {
            this.viewport._notifyViewChanged?.();
        }

        // Board outline setup. The outline is part of the document and is
        // (re)drawn by _renderPersistentObjects whenever the layer DOM is
        // built or rebuilt. If no dimensions exist yet this is a brand-new
        // board, so prompt the user for them.
        if (!this._boardOutlineDrawn) {
            this._showBoardDimensionsDialog();
        }
    }

    deactivate() {
        this._cancelAutoRoute?.();
        setInlineTextInputActive(this._textEdit?.input, false);
        this._cancelPosePreviews();
        this._cancelDrawingMode();
        this._active = false;
        this._drcPresentation?.deactivate();
        disposeFillRefresh(this);
        disposeDrcRefresh(this);
    }

    dispose() {
        this._autorouter?.dispose();
        this._fillRefreshDisposed = true;
        disposeFillRefresh(this);
        this._drcDisposed = true;
        disposeDrcRefresh(this);
        this._drcPresentation?.dispose();
    }

    setPcbStatus() {
        if (!this.status.modeStatus) return;
        const rawTool = this.currentTool || 'select';
        const shapeTool = ['line', 'circle', 'rect', 'polygon', 'arc'].includes(rawTool);
        const toolLabel = rawTool.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        const layer = rawTool === 'text' ? this._textDefaults?.layer || 'top-silk'
            : rawTool === 'fill' ? this._fillDraw?.layer || this._fillToolLayer || 'top-copper'
            : rawTool === 'track' ? this._trackDraw?.currentLayer || this._trackToolLayer || 'top-copper'
            : shapeTool ? this._shapeDraw?.layer || resolveShapeDrawLayer(this, this.activeLayer)
            : this.activeLayer;
        const layerLabel = layer?.replace(/-/g, ' ')?.replace(/\b\w/g, c => c.toUpperCase())
            || (shapeTool ? 'No unlocked layers' : 'Top Copper');
        const selectedShape = getPcbSelection(this, 'shape');
        const selectedTrack = getPcbSelection(this, 'track');
        const showSegmentTip = rawTool === 'select'
            && getPcbSelection(this).length === 1
            && !['vertex', 'segment'].includes(this._shapeDrag?.mode)
            && !this._vertexDrag
            && ((selectedShape.length === 1
                && ['line', 'rect', 'polygon'].includes(selectedShape[0]?.kind)
                && getBoardShapeSegmentFocus(this)?.shapeId !== selectedShape[0]?.id
                && getBoardShapeNodeFocus(this)?.shapeId !== selectedShape[0]?.id)
                || (selectedTrack.length === 1 && this._trackEdit?.track !== canonicalTrack(this, selectedTrack[0])));
        const showHoleTip = rawTool === 'circle' && layer === 'hole';
        const showOverlapTip = rawTool === 'select' && this._overlapHitCount > 1;
        const showTrackTip = rawTool === 'track';
        const showPadTip = rawTool === 'pad'
            || (rawTool === 'select' && getPcbSelection(this, 'pad').length === 1);
        const showReferenceTip = rawTool === 'select'
            && getPcbSelection(this).length === 1
            && getPcbSelection(this, 'reftext').length === 1;
        if (this.status.tipStatus) {
            this.status.tipStatus.hidden = !showOverlapTip && !showHoleTip && !showSegmentTip
                && !showTrackTip && !showPadTip && !showReferenceTip;
            this.status.tipStatus.textContent = showTrackTip
                ? 'Tip: Press SPACE to insert a via and switch to the other layer'
                : showReferenceTip
                ? 'Tip: Use SPACE to rotate text'
                : showPadTip
                ? 'Tip: Place a pad on the board edge to make a castellation'
                : showOverlapTip
                ? 'Tip: Shift+Click to cycle overlapping objects; Ctrl+Click for multi-selection'
                : showHoleTip
                ? 'Tip: A hole is just a circle on the hole layer'
                : showSegmentTip ? 'Tip: Click again to select a segment or node' : '';
        }
        this.status.modeStatus.textContent = `${toolLabel} | ${layerLabel}`;
        this.syncClipboardButtons?.();
        this._syncHistoryButtons?.();
    }

    /** Enable/disable PCB home-tab Undo/Redo buttons from history state. */
    _syncHistoryButtons() {
        const undoBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('pcbUndoBtn'));
        const redoBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('pcbRedoBtn'));
        const canUndo = !!this._pasteDrop || !!this.history?.canUndo?.();
        const canRedo = !!this.history?.canRedo?.();
        if (undoBtn) undoBtn.disabled = !canUndo;
        if (redoBtn) redoBtn.disabled = !canRedo;
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

    /** Whether current selection can be copied/cut from PCB. */
    _canCopyCutPcbSelection() {
        return getPcbSelection(this, 'track').length > 0
            || getPcbSelection(this, 'via').length > 0
            || getPcbSelection(this, 'pad').length > 0
            || getPcbSelection(this, 'shape').some(shape => shape.layer !== 'board-outline')
            || getPcbSelection(this, 'text').length > 0
            || getPcbSelection(this, 'fill').length > 0;
    }
    /** Select every currently visible, unlocked PCB object. */
    _selectAllPcb() {
        window.getSelection?.()?.removeAllRanges();
        const selected = [];
        for (const [componentId, placement] of this.placements) {
            if (placement.locked) continue;
            selected.push({ kind: 'component', object: componentId });
        }
        for (const track of this.tracks) {
            if (trackIsSelectable(track)) {
                selected.push({ kind: 'track', object: track });
            }
        }
        if (!isViaLocked() && isViaVisible()) {
            for (const via of this.vias) selected.push({ kind: 'via', object: via });
        }
        for (const pad of this.pads || []) {
            if (!pad.locked && pad.visible !== false) selected.push({ kind: 'pad', object: pad });
        }
        for (const shape of this.boardShapes) {
            if (shape?.type === 'fill') {
                if (!shape.locked && shape.visible !== false && !isLayerLocked(shape.layer)
                    && !isCopperFillLocked(shape.layer) && isCopperFillVisible(shape.layer)) {
                    selected.push({ kind: 'fill', object: shape });
                }
            } else if (shape && !isLayerLocked(shape.layer) && isLayerVisible(shape.layer)) {
                selected.push({ kind: 'shape', object: shape });
            }
        }
        for (const text of this.texts.values()) {
            if (!isLayerLocked(text.layer) && isLayerVisible(text.layer)) {
                selected.push({ kind: 'text', object: text });
            }
        }
        setPcbSelection(this, selected);
        refreshBoxSelectionHighlights(this);
        showPcbSelectionProperties(this);
        this.syncClipboardButtons();
    }

    /** Enable/disable PCB ribbon clipboard buttons to match current state. */
    syncClipboardButtons() {
        const canCopyCut = this._canCopyCutPcbSelection();
        const canPaste = this._hasPcbClipboardData();
        for (const id of ['pcbCopyHome', 'pcbCopyProps', 'pcbCutHome', 'pcbCutProps', 'pcbPasteHome', 'pcbPasteProps']) {
            const el = /** @type {HTMLButtonElement|null} */ (document.getElementById(id));
            if (!el) continue;
            if (id.includes('Paste')) el.disabled = !canPaste;
            else el.disabled = !canCopyCut;
        }
    }

    /**
     * Build a clipboard payload from current PCB selection.
     * Components/reference labels are intentionally excluded.
     */
    _capturePcbClipboardSelection() {
        const payload = { tracks: [], vias: [], pads: [], shapes: [], texts: [], fills: [] };
        for (const track of getPcbSelection(this, 'track')) payload.tracks.push(track.toJSON());
        for (const via of getPcbSelection(this, 'via')) payload.vias.push(via.toJSON());
        for (const pad of getPcbSelection(this, 'pad')) payload.pads.push(pad.toJSON());
        for (const shape of getPcbSelection(this, 'shape')) {
            if (shape.layer !== 'board-outline') payload.shapes.push(JSON.parse(JSON.stringify(shape)));
        }
        for (const text of getPcbSelection(this, 'text')) payload.texts.push(serializePcbText(text));
        for (const fill of getPcbSelection(this, 'fill')) payload.fills.push(fill.captureState());
        if (!payload.tracks.length && !payload.vias.length && !payload.pads.length && !payload.shapes.length
            && !payload.texts.length && !payload.fills.length) return null;
        return payload;
    }

    /** Copy currently-selected PCB entities (except components). */
    copySelection() {
        const payload = this._capturePcbClipboardSelection();
        if (!payload) {
            const componentId = getPcbSelection(this, 'component')[0] || getPcbSelection(this, 'reftext')[0];
            if (componentId) {
                this._showComponentPopup(componentId,
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
        if (this._pasteDrop) { this._cancelPasteDrop(); return true; }
        if (!this.copySelection()) return false;
        const deleted = deleteBoxSelection(this);
        if (deleted) this.clearProperties();
        this.syncClipboardButtons();
        return deleted;
    }

    /**
     * Start cursor-glued drop mode for freshly pasted entities. The pasted
     * objects move as one bundle with the cursor until the next left click.
     */
    _beginPasteDrop(payload, options) {
        return beginPcbPaste(this, payload, options);
    }

    /** Live-update the pasted bundle position while in paste-drop mode. */
    _updatePasteDrop(worldPos) {
        updatePcbPaste(this, worldPos);
    }

    /** Finish paste-drop mode and keep the pasted entities at their current position. */
    _endPasteDrop() {
        endPcbPaste(this);
    }

    /** Cancel paste-drop mode and remove the freshly pasted entities. */
    _cancelPasteDrop() {
        cancelPcbPaste(this);
    }

    /** Stage the current PCB clipboard payload at the cursor without authoring it. */
    pasteSelection() {
        if (!this._hasPcbClipboardData()) {
            this.syncClipboardButtons();
            return false;
        }
        const pasted = preparePcbPaste(this, this._pcbClipboard);
        const started = this._beginPasteDrop(pasted);
        this.syncClipboardButtons();
        return started;
    }

    /** Create the canvas viewport; headless tests substitute their own. */
    _createViewport(container) {
        return new Viewport(container);
    }

    /** After every history change: refresh derived pours, dirty state, buttons and selection overlays. */
    _onHistoryChanged() {
        invalidateFillRefresh(this);
        this._markDirty();
        this._syncHistoryButtons?.();
        refreshBoxSelectionHighlights(this);
    }

    /** Panning dismisses the net tooltip; clearance halos stay visible throughout. */
    _bindViewportPanHooks() {
        this.viewport.onPanStart = () => {
            this._hideNetTooltip();
        };
    }

    _ensureViewport() {
        if (this.viewport || !this.canvasContainer) return;

        this.viewport = this._createViewport(this.canvasContainer);

        this.viewport.onMouseMove = (worldPos, snappedPos) => {
            if (!this._active) return;
            if (this.status.cursorPos) {
                this.status.cursorPos.textContent = `${worldPos.x.toFixed(2)}, ${(-worldPos.y).toFixed(2)} mm`;
            }
            if (this.status.gridSnap) {
                this.status.gridSnap.textContent = `${snappedPos.x.toFixed(2)}, ${(-snappedPos.y).toFixed(2)} mm`;
            }
        };

        let pendingView = null;
        let viewRaf = 0;
        const flushViewUpdate = () => {
            viewRaf = 0;
            const view = pendingView;
            pendingView = null;
            if (!view || !this._active) return;

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
                this._syncCopperRemovalHatches();
            }
            this._scheduleRemovalHatchRender();
            if (this._lastCrosshairWorld && PCB_CROSSHAIR_TOOLS.has(this.currentTool)) {
                if (this.currentTool === 'via') {
                    this._updateViaPreview(this._lastCrosshairWorld);
                } else if (this.currentTool === 'pad') {
                    this._updatePadPreview(this._lastCrosshairWorld);
                } else {
                    this._updateCursorCrosshair(this._lastCrosshairWorld);
                }
            }
            this._updatePcbCulling();
            if (this._hasCopperCuts) this.updateCopperCuts({ geometryChanged: false });
            if (this._drcSelectedId) this._updateDRCConnector();
        };

        this.viewport.onInteractionStart = (kind) => {
            this._pendingHoverEvent = null;
            if (this._hoverRaf) {
                cancelAnimationFrame(this._hoverRaf);
                this._hoverRaf = 0;
            }
            if (kind !== 'pointer' && viewRaf) {
                cancelAnimationFrame(viewRaf);
                viewRaf = 0;
            }
            this._hideNetTooltip();
        };

        this.viewport.onViewChanged = (view) => {
            if (!this._active) return;
            // A track context menu is anchored to a screen position but refers
            // to a board location; any zoom or pan (wheel, +/- keys, arrow-key
            // pan, buttons, drag) makes it stale, so dismiss it on view change.
            // Guard on an actual move: endPan() fires this callback even for a
            // zero-distance right-click, which would otherwise instantly close
            // the context menu the right-click just opened.
            if (!view || view.scaleChanged || view.boundsChanged) dismissTrackContextMenu();
            // The net tooltip is anchored to a screen point over hovered copper;
            // any pan/zoom invalidates that screen anchor, so dismiss on view move.
            if (!view || view.scaleChanged || view.boundsChanged) this._hideNetTooltip();
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
            if (!this._active) return;
            this._updatePcbCulling();
            this._scheduleRemovalHatchRender();
            // Keep the copper-removal clip rectangle following the viewport
            // during a live pan (viewBox moves without firing onViewChanged).
            if (this._hasCopperCuts) this.updateCopperCuts({ geometryChanged: false });
            // The viewBox moves continuously during a pan without firing
            // onViewChanged, so keep the DRC leader anchored here too.
            if (this._drcSelectedId) this._updateDRCConnector();
        };

        this._bindViewportPanHooks();

        // Bind mouse events for panning
        this._bindMouseEvents();
        this.viewport.svg.addEventListener('unlock-shape', (event) => {
            const item = event.detail?.shape;
            const compId = item?.componentId;
            if (compId && this.placements.get(compId)?.locked) {
                this.history.execute(new SetPlacementLockedCommand(this, compId, false));
            } else {
                item?.unlock?.();
            }
        });

        // Create SVG layer groups (one <g> per PCB layer, in z-order)
        this._createLayerGroups();

        // Push any restored eye/lock state (from a prior session) into the
        // freshly-created render groups so the artwork matches the panel.
        this._applyLayerPrefsToRender();

        restoreGridSettings(this, this.pcbDocument.settings || {});

        // Apply current theme to the viewport
        this.viewport.updateTheme();
        this._updateViewportStatus();
    }

    /**
     * Wire up mouse events on the PCB viewport for panning,
     * component selection, and dragging.
     */
    _bindMouseEvents() {
        const svg = this.viewport.svg;
        if (!svg) return;

        svg.addEventListener('mousedown', (e) => {
            if (!this._active) return;
            this.viewport.onInteractionStart?.('pointer');
            this.viewport.shiftHeld = e.shiftKey;
            // Freshly pasted entities are glued to the cursor; the first
            // left-click drops them at their current position.
            if (this._pasteDrop && e.button === 0) {
                e.preventDefault();
                this._endPasteDrop();
                return;
            }
            // Midpoint and context-menu split/conversion previews drop on the next click.
            if (e.button === 0 && placeFloatingSelectionInteraction(this)) {
                this.viewport.hideCrosshair();
                svg.style.cursor = 'default';
                return;
            }
            // Switch ribbon back to Home tab on canvas click — but NOT
            // while we're drawing a track (the Track tool drives the
            // Properties tab so its width spinner stays visible), and
            // NOT while inline-editing text (the Properties tab hosts
            // the text's size/rotation spinners), and NOT on a right-button
            // press (that starts a pan — dragging the board must not switch
            // tabs, e.g. closing the Design tab's live DRC mid-pan).
            const propertiesToolActive = this.currentTool === 'track' || this.currentTool === 'via'
                || this.currentTool === 'line' || this.currentTool === 'circle'
                || this.currentTool === 'rect' || this.currentTool === 'polygon' || this.currentTool === 'arc';
            const worldPos = e.button === 0 && this.currentTool === 'select'
                ? this._screenToWorld(e)
                : null;
            if (worldPos && beginBoardOutlineResize(this, worldPos)) {
                e.preventDefault();
                svg.style.cursor = hitTestBoardOutlineHandle(this, worldPos)?.cursor || 'nesw-resize';
                return;
            }
            const selectedBoardShapeAnchor = worldPos && getPcbSelection(this, 'shape').some(
                (shape) => hitTestBoardShapeVertex(this, shape, worldPos) != null,
            );
            const selectedGroupHit = worldPos && hasBoxSelection(this)
                && pointInBoxSelection(this, worldPos);
            const selectedTextAnchor = worldPos && this._textEdit
                ? hitTestPcbSelectionAnchor(this, worldPos, ['text'])
                : null;
            const rotatingEditedText = selectedTextAnchor?.anchor?.symbol === 'rotate'
                && selectedTextAnchor.adapter?.object?.id === this._textEdit?.text?.id;
            if (!this._trackDraw && !this._textEdit && !propertiesToolActive
                && !selectedBoardShapeAnchor && !selectedGroupHit
                && e.button !== 2 && !e.ctrlKey && !e.metaKey) {
                const activeTab = this.ribbon?.querySelector('.ribbon-tab.active');
                if (activeTab instanceof HTMLElement && activeTab.dataset?.tab !== 'pcb-home') {
                    this.setActiveRibbonTab?.('pcb-home');
                }
            }
            // Inline text edit: any left-click on the canvas commits
            // the current edit. (Right-click is reserved for pan and
            // must not commit.) If the text tool is active, the
            // text-tool branch below will then place a new text.
            if (this._textEdit && e.button === 0 && !rotatingEditedText) {
                if (this._endTextInlineEdit(true) === false) return;
            }
            if (worldPos && isUnmodifiedPrimaryDoublePress(e)) {
                const textHit = this._hitTestText(worldPos);
                if (textHit) {
                    e.preventDefault();
                    this._selectText(textHit);
                    this._startTextInlineEdit(textHit, worldPos);
                    return;
                }
                if (this._tryEditReferenceAt(worldPos)) {
                    e.preventDefault();
                    return;
                }
            }
            // Right-click while drawing a track: defer the finish decision
            // to mouseup — if the user actually drags (pans), don't finish.
            // Either way, still let the standard pan handler below start a
            // pan immediately.
            if (e.button === 2 && this._trackDraw) {
                this._trackRightDown = { x: e.clientX, y: e.clientY };
            }
            if (e.button === 2 && this._fillDraw) {
                this._fillRightDown = { x: e.clientX, y: e.clientY };
            }
            if (e.button === 2 && this._shapeDraw) {
                this._shapeRightDown = { x: e.clientX, y: e.clientY };
            }
            if (e.button === 2 && this._showDebugTooltip && this._debugTooltipVisible) {
                if (this._debugTooltipPinned) {
                    this._debugTooltipPinned = false;
                    this._debugTooltip.style.display = 'none';
                    this._debugTooltipVisible = false;
                    return;
                }
                this._debugTooltipPinned = true;
                return;
            }
            const isPanButton = e.button === 1 || e.button === 2;
            const isPanTool = this.currentTool === 'pan' && e.button === 0;
            if (isPanButton || isPanTool) {
                e.preventDefault();
                if (e.button === 2) {
                    this._rightPanStart = { x: e.clientX, y: e.clientY };
                }
                this.viewport.startPan(e.clientX, e.clientY);
                return;
            }

            // Primary presses go to the active tool; see PCB_TOOL_PRESS_HANDLERS.
            if (e.button !== 0) return;
            const press = PCB_TOOL_PRESS_HANDLERS[this.currentTool];
            if (press) this[press](e, worldPos, selectedGroupHit);
        });

        svg.addEventListener('mousemove', (e) => {
            if (!this._active) return;
            this.viewport.shiftHeld = e.shiftKey;
            if (this.viewport.isPanning) {
                this.viewport.updatePan(e.clientX, e.clientY);
                // Keep tool crosshairs anchored under the cursor while panning.
                if (this.currentTool === 'via') {
                    this._updateViaPreview(this._screenToWorld(e));
                } else if (this.currentTool === 'pad') {
                    this._updatePadPreview(this._screenToWorld(e));
                } else if (PCB_CROSSHAIR_TOOLS.has(this.currentTool)) {
                    this._updateCursorCrosshair(this._screenToWorld(e));
                }
            } else if (dispatchPcbPointerMove(this, e)) {
                // An in-progress interaction consumed the move; see pcb-interactions.js.
            } else if (this.currentTool === 'select') {
                // A pending/active marquee owns the move; only fall back to
                // hover hit-testing when no box-select is in progress.
                if (maybeStartBoxSelect(this, e, this._screenToWorld(e))) {
                    // Marquee active — selection halos already updated.
                } else {
                    // Hover hit-testing is O(N) over every pad/track/text, so
                    // running it on each raw mousemove backs up the event queue
                    // on complex boards and the highlight lags the cursor.
                    // Coalesce to one pass per animation frame using the latest
                    // pointer position.
                    this._scheduleHoverUpdate(e);
                }
            } else if (this.currentTool === 'via') {
                this._updateViaPreview(this._screenToWorld(e));
            } else if (this.currentTool === 'pad') {
                this._updatePadPreview(this._screenToWorld(e));
            } else if (this.currentTool === 'track') {
                const snap = resolveTrackDrawSnap(this, this._screenToWorld(e), {});
                this._updateCursorCrosshair({ x: snap.x, y: snap.y });
                // Pre-draw hover uses the same hard copper targets as the
                // active route so the first press cannot change its snap.
                if (snap.snapType === 'pad' || snap.snapType === 'via'
                    || snap.snapType === 'track-node') {
                    showTrackSnapMarker(this, { x: snap.x, y: snap.y });
                } else {
                    clearTrackSnapMarker(this);
                }
            } else if (PCB_CROSSHAIR_TOOLS.has(this.currentTool)) {
                this._updateCursorCrosshair(this._screenToWorld(e));
            }
            this.viewport.trackMouse(e);
            this._updateDebugTooltip(e);
        });

        svg.addEventListener('dblclick', (e) => {
            if (!this._active) return;
            if (this._trackDraw) {
                e.preventDefault();
                finishTrackDraw(this);
                return;
            }
            if (this._fillDraw) {
                e.preventDefault();
                finishFillDraw(this);
                return;
            }
            if (this._shapeDraw && this._shapeDraw.kind === 'polygon') {
                e.preventDefault();
                finishPolygonDraw(this);
                return;
            }
            if (this._shapeDraw && this._shapeDraw.kind === 'line') {
                e.preventDefault();
                finishLineDraw(this);
                return;
            }
            if (this._textEdit) return; // already editing
            // Double-click a text → inline edit it.
            const worldPos = this._screenToWorld(e);
            const textHit = this._hitTestText(worldPos);
            if (textHit) {
                e.preventDefault();
                this._selectText(textHit);
                this._startTextInlineEdit(textHit, worldPos);
                return;
            }
            if (this.currentTool === 'select' && this._tryEditReferenceAt(worldPos)) {
                e.preventDefault();
                return;
            }
            // Double-clicking a LOCKED track/via is the natural "why can't I
            // select this?" gesture — explain it with a speech bubble.
            const lockedHit = hitTestLockedTrack(this, worldPos);
            if (lockedHit) {
                e.preventDefault();
                showLockedLayerBubble(this, lockedHit.layerId, { x: e.clientX, y: e.clientY });
                return;
            }
            // NOTE: double-click track-node insertion is handled in the
            // mousedown listener (via e.detail === 2) — starting a vertex
            // drag on the second click suppresses the `dblclick` event.
        });
        // Some pointer sequences (e.g. when the two clicks land on
        // different child elements with the layer-group hierarchy) cause
        // the browser to never fire a `dblclick`. Catch it manually via
        // `click` with `detail === 2` as a fallback.
        svg.addEventListener('click', (e) => {
            if (!this._active || e.detail !== 2) return;
            if (this._textEdit) return; // already editing
            const worldPos = this._screenToWorld(e);
            const textHit = this._hitTestText(worldPos);
            if (textHit) {
                e.preventDefault();
                this._selectText(textHit);
                this._startTextInlineEdit(textHit, worldPos);
                return;
            }
            if (this.currentTool === 'select' && this._tryEditReferenceAt(worldPos)) {
                e.preventDefault();
                return;
            }
            const lockedHit = hitTestLockedTrack(this, worldPos);
            if (lockedHit) {
                e.preventDefault();
                showLockedLayerBubble(this, lockedHit.layerId, { x: e.clientX, y: e.clientY });
                return;
            }
        });

        // Keyboard: Escape finishes (preserving committed segments),
        // PCB keyboard shortcuts are dispatched by AppBootstrap's
        // central window-capture listener via handleKeyDown() below —
        // no per-instance event registration here.

        const endInteraction = (button = 0, worldPos = null) => {
            if (!this._active) return;
            if (this.viewport.isPanning) {
                this.viewport.endPan();
                // Restore the tool's own cursor (Viewport.endPan resets
                // to 'grab' / default — text tool wants the T+crosshair).
                this._updateCursorForTool?.();
            }
            // Right/middle mouse drags pan the canvas. Releasing either must
            // leave an armed or active anchor drag untouched.
            if (button !== 0) return;
            if (this._boardOutlineResize) {
                if (worldPos) updateBoardOutlineResize(this, worldPos);
                endBoardOutlineResize(this);
                svg.style.cursor = 'default';
                return;
            }
            const finishedSelectionInteraction = finishSelectionInteraction(this, true, worldPos);
            if (finishedSelectionInteraction) {
                this._clearCursorCrosshair();
                svg.style.cursor = 'default';
            }
            if (this._groupDrag) {
                endGroupDrag(this);
                svg.style.cursor = 'default';
            }
            // Finish (or discard) a marquee box-select. Safe to call even
            // when nothing was armed — it just clears the pending state.
            const completedBoxSelection = finishBoxSelect(this);
            if (completedBoxSelection) showPcbSelectionProperties(this);
            if (this._drag) {
                this._endDrag();
            }
            if (this._textDrag) {
                this._endTextDrag();
            }
            if (this._shapeDrag && !finishedSelectionInteraction) {
                endBoardShapeDrag(this, true);
                this._clearCursorCrosshair();
                refreshBoxSelectionHighlights(this);
                svg.style.cursor = 'default';
            }
            if (this._refDrag) {
                this._endRefDrag();
            }
            if (this._vertexDrag && !finishedSelectionInteraction) {
                this._vertexDragDownScreen = null;
                const segmentClick = this._vertexDrag.mode === 'segment'
                    && !this._vertexDrag.userDragged
                    && this._segmentClickEdgeId;
                const segEdgeId = this._segmentClickEdgeId;
                finishVertexDrag(this);
                this.viewport.hideCrosshair();
                svg.style.cursor = 'default';
                const selectedTrack = getSelectedTrack(this);
                if (selectedTrack) {
                    const t = selectedTrack;
                    clearTrackSelection(this);
                    if (segmentClick && t.edges?.has(segEdgeId)) {
                        selectTrackSegment(this, t, segEdgeId);
                    } else {
                        selectTrackOrVia(this, { type: 'track', track: t });
                    }
                }
                this._segmentClickEdgeId = null;
            }
            if (this._viaDrag) {
                finishViaDrag(this);
                svg.style.cursor = 'default';
                // Refresh the halo on the moved via.
                const selectedVia = getSelectedVia(this);
                if (selectedVia) {
                    const v = selectedVia;
                    clearTrackSelection(this);
                    selectTrackOrVia(this, { type: 'via', via: v });
                }
            }
            if (this._fillDrag && !finishedSelectionInteraction) {
                this._endFillDrag();
                svg.style.cursor = 'default';
            }
        };

        // Drag/interaction termination is handled at the WINDOW level (not the
        // svg) so a release anywhere ends the gesture cleanly — and, combined
        // with the mouseleave handler below that keeps drags alive, a drag that
        // leaves the canvas and re-enters elsewhere continues seamlessly. This
        // matches the schematic editor's mouse model.
        window.addEventListener('mouseup', (e) => {
            if (!this._active) return;
            if (e.button === 2 && this._rightPanStart) {
                const dx = e.clientX - this._rightPanStart.x;
                const dy = e.clientY - this._rightPanStart.y;
                this._rightPanStart = null;
                if (Math.hypot(dx, dy) >= 4) {
                    this._suppressNextContextMenu = true;
                    setTimeout(() => { this._suppressNextContextMenu = false; }, 0);
                }
            }
            endInteraction(e.button, this._screenToWorld(e));
            // Left-click release just after starting a track: decide between
            // the two draw modes.
            //   • Released away from the start press → "drag mode": this
            //     release is the end point, so finish the track here.
            //   • Released roughly in place → "click mode": leave the draw
            //     running so the next click sets the end point.
            if (e.button === 0 && this._trackDraw && this._trackLeftDown) {
                const dx = e.clientX - this._trackLeftDown.x;
                const dy = e.clientY - this._trackLeftDown.y;
                this._trackLeftDown = null;
                if (Math.hypot(dx, dy) >= 4) {
                    const snap = this._trackDraw.snap;
                    if (snap) addTrackWaypoint(this, { x: snap.x, y: snap.y });
                    if (this._trackDraw) finishTrackDraw(this);
                }
            }
            // Right-click release while drawing a track: if the user
            // didn't pan (movement under threshold), treat it as "finish".
            if (e.button === 2 && this._trackDraw && this._trackRightDown) {
                const dx = e.clientX - this._trackRightDown.x;
                const dy = e.clientY - this._trackRightDown.y;
                this._trackRightDown = null;
                if (Math.hypot(dx, dy) < 4) {
                    // Commit a final waypoint at the cursor, then finish.
                    const snap = this._trackDraw.snap;
                    if (snap) addTrackWaypoint(this, { x: snap.x, y: snap.y });
                    if (this._trackDraw) finishTrackDraw(this);
                }
            }
            // Right-click release while drawing a fill: finish the region.
            if (e.button === 2 && this._fillDraw && this._fillRightDown) {
                const dx = e.clientX - this._fillRightDown.x;
                const dy = e.clientY - this._fillRightDown.y;
                this._fillRightDown = null;
                if (Math.hypot(dx, dy) < 4) finishFillDraw(this);
            }
            // A stationary right-click finishes PCB shape drawing at the
            // cursor; a right-drag remains viewport panning.
            if (e.button === 2 && this._shapeDraw && this._shapeRightDown) {
                const dx = e.clientX - this._shapeRightDown.x;
                const dy = e.clientY - this._shapeRightDown.y;
                this._shapeRightDown = null;
                if (Math.hypot(dx, dy) < 4) {
                    finishShapeDrawAtPoint(this, this._screenToWorld(e));
                }
            }
        });

        // No mouseleave handler: leaving the canvas must NOT end an active
        // pan (or any drag). Movement freezes while the cursor is outside
        // (svg gets no mousemove) and resumes seamlessly on re-entry; the
        // window-level mouseup above ends the gesture wherever it's released.
        // This matches the schematic editor, which has no mouseleave handler.

        window.addEventListener('contextmenu', (e) => {
            if (!this._active || !this._suppressNextContextMenu) return;
            this._suppressNextContextMenu = false;
            e.preventDefault();
            e.stopImmediatePropagation();
        }, { capture: true });

        svg.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            dismissBoardShapeContextMenu();
            // Track/via context menu — select tool only, and never while
            // drawing a track (right-click finishes the draw in that mode,
            // so there's no clash).
            if (!this._active) return;
            if (this.currentTool !== 'select' || this._trackDraw) return;
            const worldPos = this._screenToWorld(e);
            const fillAnchor = hitTestPcbSelectionAnchor(this, worldPos, ['fill']);
            if (fillAnchor) {
                if (this.viewport.isPanning) this.viewport.endPan();
                showFillContextMenu(this, fillAnchor.adapter.object, e.clientX, e.clientY, worldPos);
                return;
            }
            const hit = hitTestTrack(this, worldPos);
            if (hit) {
                // A right-click that started a pan must not leave the
                // viewport in panning state behind the menu.
                if (this.viewport.isPanning) this.viewport.endPan();
                showTrackContextMenu(this, hit, e.clientX, e.clientY, worldPos);
                return;
            }
            const shape = hitTestBoardShape(this, worldPos);
            if (shape) {
                if (this.viewport.isPanning) this.viewport.endPan();
                showBoardShapeContextMenu(this, shape, e.clientX, e.clientY, worldPos);
                return;
            }
            const fill = this._hitTestFill(worldPos);
            if (fill) {
                if (this.viewport.isPanning) this.viewport.endPan();
                showFillContextMenu(this, fill, e.clientX, e.clientY, worldPos);
                return;
            }
            // Otherwise, offer "Show 3D" when right-clicking a footprint that
            // carries a 3D model.
            const compId = this._hitTestComponent(worldPos);
            const pl = compId ? this.placements.get(compId) : null;
            if (compId && hasAny3DModel(pl)) {
                if (this.viewport.isPanning) this.viewport.endPan();
                this._showComponent3DMenu(compId, e.clientX, e.clientY);
            }
        });

        // Suppress browser context menu on PCB ribbon header & body.
        // (SchematicApp uses querySelector('.ribbon') which only catches the
        //  first match — the schematic ribbon — so we handle #ribbonPCB here.)
        document.getElementById('ribbonPCB')?.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    /**
     * Left-click with the select tool, in priority order: the shared selection
     * interaction, Ctrl/Cmd shape toggling, an active box selection, continuing
     * the current selection, then selecting what is under the pointer (tracks and
     * vias before shapes, text and components, since smaller targets win).
     */
    _pressSelectTool(e, worldPos, selectedGroupHit) {
        const additiveSelection = e.ctrlKey || e.metaKey;
        if (this._pressSelectionInteraction(e, worldPos, additiveSelection)) return;
        if (this._pressToggleShape(worldPos, additiveSelection)) return;
        if (this._pressBoxSelection(worldPos, selectedGroupHit)) return;
        if (this._pressCurrentSelection(e, worldPos)) return;
        this._pressNewTarget(e, worldPos);
    }

    /** Hand the press to the shared adapter controller (anchors, rotation, overlap cycling). */
    _pressSelectionInteraction(e, worldPos, additiveSelection) {
        const svg = this.viewport.svg;
        // Rectangle, arc, and circle selection is owned by the shared
        // adapter controller. Other PCB entities stay on their legacy
        // paths until their adapters implement the same contract.
        if (beginSelectionInteraction(this, worldPos, additiveSelection, e.shiftKey)) {
            setHoverHighlight(this, null);
            this._hoverComponent(null);
            this._hideNetTooltip();
            if (this._pcbSelectionInteraction) svg.style.cursor = selectionInteractionCursor(this);
            return true;
        }
        return false;
    }

    /** Ctrl/Cmd-click toggles a board shape in the multi-selection. */
    _pressToggleShape(worldPos, additiveSelection) {
        // Ctrl/Cmd-click mirrors the schematic editor's additive
        // selection. Promote the current single shape first, then
        // toggle the clicked shape in the marquee selection set.
        if (additiveSelection) {
            const shapeHit = hitTestBoardShape(this, worldPos);
            if (shapeHit) {
                const hasMultiSelection = hasBoxSelection(this);
                const previousShape = getPcbSelection(this, 'shape')[0] || null;
                if (!hasMultiSelection && previousShape?.id === shapeHit.id) {
                    selectBoardShape(this, null);
                    return true;
                }
                if (!hasMultiSelection && previousShape && previousShape.id !== shapeHit.id) {
                    toggleBoxShapeSelection(this, previousShape);
                }
                selectBoardShape(this, null);
                toggleBoxShapeSelection(this, shapeHit);
                this._hideNetTooltip();
                return true;
            }
        }
        return false;
    }

    /** Edit or drag an active box selection, or drop it when the press misses it. */
    _pressBoxSelection(worldPos, selectedGroupHit) {
        const svg = this.viewport.svg;
        // Box-selection group drag: clicking on any member of an
        // active multi-selection moves the whole group together.
        // Clicking elsewhere drops the multi-selection and falls
        // through to normal single-object selection below.
        if (hasBoxSelection(this)) {
            // Match schematic behavior: an anchor belonging to a
            // marquee-selected shape edits only that shape, rather
            // than moving the entire marquee selection.
            const shapeWithHandle = getPcbSelection(this, 'shape').find(
                (shape) => hitTestBoardShapeVertex(this, shape, worldPos) != null,
            );
            if (shapeWithHandle && startBoardShapeDrag(this, shapeWithHandle, worldPos)) {
                selectBoardShape(this, shapeWithHandle);
                setHoverHighlight(this, null);
                this._hoverComponent(null);
                this._hideNetTooltip();
                svg.style.cursor = 'grabbing';
                return true;
            }
            if (selectedGroupHit) {
                // Clear the hover halo before dragging: hover updates
                // are suppressed during a drag, so a leftover hover X
                // (e.g. on a hole/via) would otherwise sit at the
                // original position the whole drag.
                setHoverHighlight(this, null);
                this._hoverComponent(null);
                beginGroupDrag(this, worldPos);
                this._hideNetTooltip();
                svg.style.cursor = 'grabbing';
                return true;
            }
            clearBoxSelection(this);
        }
        return false;
    }

    /** Continue dragging the selected fill, track, via or shape; otherwise release it. */
    _pressCurrentSelection(e, worldPos) {
        const svg = this.viewport.svg;
        // Continue interacting with an already-selected fill: grab a
        // vertex or drag the whole region without re-clicking.
        const selectedFill = getPcbSelection(this, 'fill')[0] || null;
        if (selectedFill) {
            if (this._startFillDrag(selectedFill, worldPos, e)) {
                setHoverHighlight(this, null);
                this._hideNetTooltip();
                svg.style.cursor = 'grabbing';
                return true;
            }
        }
        // Any other click drops the current fill selection (it may be
        // re-selected below if the click lands on a fill region).
        this.selectFill(null);
        selectBoardShape(this, null);

        // If a track is already selected, try to start a vertex
        // drag on it before doing anything else — this lets the
        // user grab a node or bend a segment without re-clicking.
        const selectedTrack = getSelectedTrack(this);
        if (selectedTrack) {
            if (startVertexDrag(this, selectedTrack, worldPos)) {
                // A pure click (no drag) on a segment of the already-
                // selected track refines the selection down to just
                // that segment on mouse-up. Node grabs and drags are
                // unaffected.
                this._segmentClickEdgeId =
                    this._vertexDrag?.mode === 'segment' ? this._vertexDrag.edgeId : null;
                // Clear any lingering hover halo so it doesn't sit
                // at the original position while the drag is live
                // (hover updates are suppressed during a drag).
                setHoverHighlight(this, null);
                this._hideNetTooltip();
                this._vertexDragDownScreen = { x: e.clientX, y: e.clientY };
                this._updateVertexDragCrosshair();
                svg.style.cursor = 'grabbing';
                return true;
            }
        }
        // Same for a selected via: clicking on the via begins a
        // drag without losing the selection.
        const selectedVia = getSelectedVia(this);
        if (selectedVia) {
            if (startViaDrag(this, selectedVia, worldPos)) {
                setHoverHighlight(this, null);
                this._hideNetTooltip();
                svg.style.cursor = 'grabbing';
                return true;
            }
        }
        // Same for a selected free-standing board shape.
        const selectedShape = getPcbSelection(this, 'shape')[0] || null;
        if (selectedShape) {
            const selectedHit = hitTestBoardShape(this, worldPos);
            const onHandle = hitTestBoardShapeVertex(this, selectedShape, worldPos) != null;
            if (onHandle || (selectedHit && selectedHit.id === selectedShape.id)) {
                if (startBoardShapeDrag(this, selectedShape, worldPos)) {
                    setHoverHighlight(this, null);
                    this._hideNetTooltip();
                    svg.style.cursor = 'grabbing';
                    return true;
                }
            }
        }

        // The click isn't continuing a drag of the current
        // selection, so the selected track (if any) is about to be
        // deselected or replaced. Tidy away any redundant collinear
        // waypoints first — e.g. a node added by double-click but
        // never moved is collinear by definition and is removed here.
        if (selectedTrack) {
            commitCollinearCleanup(this, selectedTrack);
        }
        return false;
    }

    /** Select (and start dragging) the topmost target under the pointer, or arm a box select. */
    _pressNewTarget(e, worldPos) {
        const svg = this.viewport.svg;
        const trackHit = hitTestTrack(this, worldPos);
        if (trackHit) {
            this._hoverComponent(null);
            this._selectComponent(null);
            this._selectBoardOutline(false);
            selectTrackOrVia(this, trackHit);
            // Fresh whole-track selection — not a segment-refine click.
            this._segmentClickEdgeId = null;
            // Begin a drag immediately so click-and-drag works in
            // one motion (no separate select-then-drag click).
            if (trackHit.type === 'via') {
                if (startViaDrag(this, trackHit.via, worldPos)) {
                    this._hideNetTooltip();
                    svg.style.cursor = 'grabbing';
                }
            } else if (trackHit.type === 'track') {
                if (startVertexDrag(this, trackHit.track, worldPos, { allowMidpointInsert: false })) {
                    this._hideNetTooltip();
                    this._vertexDragDownScreen = { x: e.clientX, y: e.clientY };
                    this._updateVertexDragCrosshair();
                    svg.style.cursor = 'grabbing';
                }
            }
            return;
        }

        // Anything else clears any track selection first.
        clearTrackSelection(this);

        const shapeHit = hitTestBoardShape(this, worldPos);
        if (shapeHit) {
            this._selectComponent(null);
            this._selectBoardOutline(false);
            this._selectText(null);
            this._selectRefText(null);
            this.selectFill(null);
            selectBoardShape(this, shapeHit);
            showBoardShapeProperties(this, shapeHit);
            if (startBoardShapeDrag(this, shapeHit, worldPos)) {
                this._hideNetTooltip();
                svg.style.cursor = 'grabbing';
            }
            return;
        }
        selectBoardShape(this, null);
        const textHit = this._hitTestText(worldPos);
        if (textHit) {
            this._selectComponent(null);
            this._selectBoardOutline(false);
            this._selectText(textHit);
            this._showTextProperties(textHit);
            this._beginTextDrag(textHit, worldPos);
            svg.style.cursor = 'grabbing';
            return;
        }
        this._selectText(null);

        // Reference-designator text hit-test. The label sits on the
        // silkscreen above/around the body and can be dragged/rotated
        // independently of the component, so test it before the body.
        const refHit = this._hitTestRefText(worldPos);
        if (refHit) {
            this._selectComponent(null);
            this._selectBoardOutline(false);
            this._selectRefText(refHit);
            const dragging = this._beginRefTextDrag(refHit, worldPos);
            this._showRefProperties(refHit);
            svg.style.cursor = dragging ? 'grabbing' : 'default';
            return;
        }
        this._selectRefText(null);

        const hit = this._hitTestComponent(worldPos);
        if (hit) {
            this._selectComponent(hit);
            this._selectBoardOutline(false);
            this._showComponentProperties(hit);
            if (this._beginComponentDrag(hit, worldPos)) svg.style.cursor = 'grabbing';
        } else if (this._hitTestBoardOutline(worldPos)) {
            this._selectComponent(null);
            this.selectFill(null);
            this._selectBoardOutline(true);
            this._showBoardOutlineProperties();
        } else if (this._hitTestFill(worldPos)) {
            const fillHit = this._hitTestFill(worldPos);
            this._selectComponent(null);
            this._selectBoardOutline(false);
            this.selectFill(fillHit);
            this._showFillProperties(fillHit);
        } else {
            this._selectComponent(null);
            this._selectBoardOutline(false);
            this.selectFill(null);
            this.clearProperties();
            // Empty canvas: arm a box-select. The marquee only
            // materialises once the pointer crosses the drag
            // threshold (see the mousemove handler).
            armBoxSelect(this, { x: e.clientX, y: e.clientY }, worldPos);
        }
    }

    /**
     * Left-click with track tool: start a new track or add a waypoint.
     */
    _pressTrackTool(e) {
        const worldPos = this._screenToWorld(e);
        // Can't draw on a locked layer.
        if (!this._trackDraw && isLayerLocked(this._trackToolLayer || 'top-copper')) return;
        if (this._trackDraw) {
            addTrackWaypoint(this, worldPos);
        } else {
            startTrackDraw(this, worldPos);
            // Arm press-drag detection: if the user holds and releases
            // away from here it's "drag mode" (release ends the track);
            // a release in place is "click mode" (click again to end).
            this._trackLeftDown = { x: e.clientX, y: e.clientY };
        }
    }

    /**
     * Left-click with fill tool: start a new pour region or add a vertex.
     */
    _pressFillTool(e) {
        const worldPos = this._screenToWorld(e);
        if (!this._fillDraw && isLayerLocked(this._fillToolLayer || 'top-copper')) return;
        if (this._fillDraw) {
            addFillWaypoint(this, worldPos);
        } else {
            startFillDraw(this, worldPos);
        }
    }

    /**
     * Left-click with via tool: place a standalone via at the cursor.
     */
    _pressViaTool(e) {
        const worldPos = this._screenToWorld(e);
        // A via spans both copper layers — refuse if either is locked.
        if (isViaLocked()) return;
        const snap = resolveTrackSnap(this, worldPos, {});
        const p = this.getRoutingParams?.() || {};
        const diameter = Number.isFinite(p.viaDiameter) && p.viaDiameter > 0 ? p.viaDiameter : 0.6;
        const drill = Number.isFinite(p.viaDrill) && p.viaDrill > 0 ? p.viaDrill : 0.3;
        const selectedNet = String(this._viaToolNet || '').trim();

        if (snap.snapType === 'pad' || snap.snapType === 'track-node') {
            // Landed on an existing pad / track node: attach the via
            // there and inherit that net (the via sits on a node).
            const net = selectedNet || snap.pad?.net || snap.trackNode?.track?.net || '';
            const via = new Via({ x: snap.x, y: snap.y, diameter, drill, net });
            this.history.execute(new AddViaCommand(this, via));
        } else {
            // Mid-segment? Split the host track so the via lands on a
            // node of each resulting half (both keep the track's net).
            const split = findSplittableTrackEdge(this, worldPos);
            if (split) {
                const via = new Via({
                    x: split.px, y: split.py, diameter, drill,
                    net: selectedNet || split.track.net || '',
                });
                const parts = splitTrackObjectAtPoint(
                    split.track, split.edgeId, { x: split.px, y: split.py });
                if (parts && parts.length) {
                    const cmds = [new RemoveTrackCommand(this, split.track)];
                    for (const part of parts) cmds.push(new AddTrackCommand(this, part));
                    cmds.push(new AddViaCommand(this, via));
                    this.history.execute(new CompoundCommand(cmds));
                } else {
                    this.history.execute(new AddViaCommand(this, via));
                }

            } else {
                // Empty space: a standalone via with no net assignment.
                const via = new Via({ x: snap.x, y: snap.y, diameter, drill, net: selectedNet });
                this.history.execute(new AddViaCommand(this, via));
            }
        }
    }

    /**
     * Primary press with the pad tool.
     */
    _pressPadTool(e) {
        const snap = this._snapPadPlacement(this._screenToWorld(e));
        const pad = new Pad({ ...this._padDefaults, x: snap.x, y: snap.y });
        if (pad.layers === 'both'
            ? (isLayerLocked('top-copper') || isLayerLocked('bottom-copper'))
            : isLayerLocked(pad.layers)) return;
        this.history.execute(new AddPadCommand(this, pad));
        setPcbSelection(this, [{ kind: 'pad', object: pad }]);
        this._showPadProperties(pad);
        refreshBoxSelectionHighlights(this);
    }

    /**
     * Left-click with a shape tool: circle/rect = 2 clicks, arc = 3
     * clicks, and Line/Polygon accept vertices until double-click or Enter.
     */
    _pressShapeTool(e) {
        shapeDrawClick(this, this.currentTool, this._screenToWorld(e));
    }

    /**
     * Left-click with text tool: place a text at the cursor.
     */
    _pressTextTool(e) {
        const worldPos = this._screenToWorld(e);
        const snap = this._snapToGrid(worldPos);
        const layer = this._textDefaults.layer;
        // Don't place text on a locked layer.
        if (isLayerLocked(layer)) return;
        const text = createPcbText({
            content: '',
            x: snap.x,
            y: snap.y,
            size: this._textDefaults.size,
            rotation: this._textDefaults.rotation,
            layer,
            strokeWidth: this._textDefaults.strokeWidth,
            border: this._textDefaults.border,
        });
        this.history.execute(new AddTextCommand(this, text));
        // Select the freshly-placed text so the user can immediately
        // edit it in the Properties panel.
        this._selectText(text);
        this._showTextProperties(text);
        // Match the schematic editor: drop straight into inline
        // edit mode so the user can type the content right away.
        this._startTextInlineEdit(text, null, { isNewPlacement: true });
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

    _updateCursorForTool() {
        if (!this.viewport?.svg) return;
        if (this._pasteDrop) {
            this.viewport.svg.style.cursor = 'crosshair';
            this._clearViaRing();
            this._clearPadPreview();
            this._clearHoleRing();
            return;
        }
        const t = this.currentTool;
        if (PCB_CROSSHAIR_TOOLS.has(t)) {
            setToolCursor(this, t, this.viewport.svg);
            if (t !== 'via') this._clearViaRing();
            if (t !== 'pad') this._clearPadPreview();
            return;
        }
        this.viewport.svg.style.cursor =
            t === 'pan' ? 'grab' :
            'default';
        if (t !== 'via') this._clearViaRing();
        if (t !== 'pad') this._clearPadPreview();
        this._clearCursorCrosshair();
    }

    /**
     * Show/update the drawing crosshair at the snapped cursor position.
     * Delegates the actual H+V lines to the shared Viewport crosshair so
     * schematic and PCB behave identically (and clear of the rulers).
     */
    _updateCursorCrosshair(worldPos) {
        if (!this.viewport) return;
        const snap = this.currentTool === 'text'
            ? this._snapToGrid(worldPos) : resolveTrackSnap(this, worldPos, {});
        this._lastCrosshairWorld = { x: worldPos.x, y: worldPos.y };
        this.viewport.setCrosshair({ x: snap.x, y: snap.y });
    }

    _clearCursorCrosshair() {
        this.viewport?.hideCrosshair();
        this._lastCrosshairWorld = null;
    }

    /**
     * Show/update the drawing crosshair at the position of the node being
     * dragged (single-node and plus-in-circle insertion drags). The node's
     * position has already been resolved by updateVertexDrag (grid / pad /
     * axis snap), so the crosshair lands exactly where the node will drop.
     * No-op for segment drags (two moving nodes, no single point).
     */
    _updateVertexDragCrosshair() {
        const drag = this._vertexDrag;
        if (!drag || drag.mode !== 'node' || !this.viewport) return;
        const nd = drag.nodes?.[0];
        const n = nd && drag.track?.nodes?.get(nd.nodeId);
        if (n) this.viewport.setCrosshair({ x: n.x, y: n.y });
    }

    /**
     * Via tool preview: crosshair + outlined via (ring + drill) at the
     * snapped cursor position.
     */
    _updateViaPreview(worldPos) {
        this._updateCursorCrosshair(worldPos);
        const svg = this.viewport?.svg;
        if (!svg) return;
        const snap = resolveTrackSnap(this, worldPos, {});
        const p = this.getRoutingParams?.() || {};
        const dia = Number.isFinite(p.viaDiameter) && p.viaDiameter > 0 ? p.viaDiameter : 0.6;
        const drill = Number.isFinite(p.viaDrill) && p.viaDrill > 0 ? p.viaDrill : 0.3;
        const scale = this.viewport.scale || 1;
        const stroke = 1 / scale;

        let g = this._viaRingGroup;
        if (!g) {
            const NS = 'http://www.w3.org/2000/svg';
            // Read the accent color once per preview group; getComputedStyle
            // forces a style resolve and this runs on every mousemove.
            const accent = getComputedStyle(document.documentElement)
                .getPropertyValue('--accent-color').trim() || '#0098ff';
            g = document.createElementNS(NS, 'g');
            g.setAttribute('class', 'pcb-via-preview');
            g.setAttribute('pointer-events', 'none');
            const ring = document.createElementNS(NS, 'circle');
            ring.setAttribute('data-role', 'ring');
            ring.setAttribute('fill', 'none');
            ring.setAttribute('stroke', accent);
            const hole = document.createElementNS(NS, 'circle');
            hole.setAttribute('data-role', 'hole');
            hole.setAttribute('fill', 'none');
            hole.setAttribute('stroke', accent);
            g.appendChild(ring);
            g.appendChild(hole);
            svg.appendChild(g);
            this._viaRingGroup = g;
        }
        const ring = g.querySelector('[data-role="ring"]');
        const hole = g.querySelector('[data-role="hole"]');
        ring.setAttribute('cx', String(snap.x));
        ring.setAttribute('cy', String(snap.y));
        ring.setAttribute('r', String(dia / 2));
        ring.setAttribute('stroke-width', String(stroke * 1.5));
        hole.setAttribute('cx', String(snap.x));
        hole.setAttribute('cy', String(snap.y));
        hole.setAttribute('r', String(drill / 2));
        hole.setAttribute('stroke-width', String(stroke));
    }

    _clearViaRing() {
        if (this._viaRingGroup) {
            this._viaRingGroup.remove();
            this._viaRingGroup = null;
        }
    }

    _updatePadPreview(worldPos) {
        if (!this.viewport) return;
        const snap = this._snapPadPlacement(worldPos);
        this._lastCrosshairWorld = { x: worldPos.x, y: worldPos.y };
        this.viewport.setCrosshair({ x: snap.x, y: snap.y });
        const svg = this.viewport.svg;
        if (!svg) return;
        const scale = this.viewport.scale || 1;
        const stroke = 1 / scale;
        let group = this._padPreviewGroup;
        if (!group) {
            const NS = 'http://www.w3.org/2000/svg';
            const accent = getComputedStyle(document.documentElement)
                .getPropertyValue('--accent-color').trim() || '#0098ff';
            group = document.createElementNS(NS, 'g');
            group.setAttribute('class', 'pcb-pad-preview');
            group.setAttribute('pointer-events', 'none');
            const outline = document.createElementNS(NS, 'path');
            outline.setAttribute('data-role', 'outline');
            outline.setAttribute('fill', 'none');
            outline.setAttribute('stroke', accent);
            outline.setAttribute('fill-rule', 'evenodd');
            group.appendChild(outline);
            svg.appendChild(group);
            this._padPreviewGroup = group;
        }
        const outline = group.querySelector('[data-role="outline"]');
        outline.setAttribute('d', padCopperPathD({ ...this._padDefaults, x: snap.x, y: snap.y }));
        outline.setAttribute('stroke-width', String(stroke * 1.5));
    }

    _clearPadPreview() {
        if (this._padPreviewGroup) {
            this._padPreviewGroup.remove();
            this._padPreviewGroup = null;
        }
    }

    _clearViaPreview() {
        this._clearViaRing();
        this._clearCursorCrosshair();
    }

    _clearHolePreview() {
        this._clearHoleRing();
        this._clearCursorCrosshair();
    }

    /** Public hook used by controls.setTool to abort an in-flight track draw. */
    _cancelTrackDraw() {
        if (this._trackDraw) cancelTrackDraw(this);
        // Also drop the pre-draw hover snap marker (shown while hovering a
        // bondable target before the first click).
        clearTrackSnapMarker(this);
    }

    /** Public hook used by controls.setTool to abort an in-flight fill draw. */
    _cancelFillDraw() {
        if (this._fillDraw) cancelFillDraw(this);
    }

    /** Public hook used by controls.setTool to abort an in-flight shape draw. */
    _cancelShapeDraw() {
        cancelShapeDraw(this);
    }

    _cancelDrawingMode() {
        return cancelPcbDrawingMode(this);
    }

    /** Get (or lazily create) the shared <defs> in the editor SVG. */
    _ensureSvgDefs() {
        const svg = this.viewport?.svg;
        if (!svg) return null;
        if (this._svgDefs && this._svgDefs.isConnected) return this._svgDefs;
        let defs = svg.querySelector('defs');
        if (!defs) {
            defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
            svg.insertBefore(defs, svg.firstChild);
        }
        this._svgDefs = defs;
        return defs;
    }

    /** Return a mode-coloured cross-hatch paint for copper and mask removals. */
    _ensureCopperRemovalHatch(mode) {
        const defs = this._ensureSvgDefs();
        if (!defs) return '#8a929b';
        const colors = {
            'remove-copper': '#5f6770',
            'remove-solder-mask': '#8a6923',
            'remove-copper-mask': '#7c3b4c',
        };
        const color = colors[mode] || '#8a929b';
        const id = `pcb-copper-removal-hatch-${String(mode || 'remove-copper').replace(/[^a-z-]/g, '')}`;
        if (!defs.querySelector(`#${id}`)) {
            const NS = 'http://www.w3.org/2000/svg';
            const pattern = document.createElementNS(NS, 'pattern');
            pattern.setAttribute('id', id);
            pattern.setAttribute('patternUnits', 'userSpaceOnUse');
            pattern.setAttribute('patternContentUnits', 'userSpaceOnUse');
            pattern.setAttribute('width', '8');
            pattern.setAttribute('height', '8');
            const canvas = document.createElement('canvas');
            canvas.width = 32;
            canvas.height = 32;
            const context = canvas.getContext('2d');
            if (context) {
                context.strokeStyle = color;
                context.lineWidth = 5;
                context.beginPath();
                context.moveTo(0, 0); context.lineTo(32, 32);
                context.moveTo(32, 0); context.lineTo(0, 32);
                context.stroke();
            }
            const image = document.createElementNS(NS, 'image');
            image.setAttribute('width', '8');
            image.setAttribute('height', '8');
            image.setAttribute('href', canvas.toDataURL('image/png'));
            pattern.appendChild(image);
            defs.appendChild(pattern);
        }
        this._setCopperRemovalHatchMetrics(defs.querySelector(`#${id}`));
        return `url(#${id})`;
    }

    /** Keep the cached hatch tile at a stable screen-space size as SVG zooms. */
    _setCopperRemovalHatchMetrics(pattern) {
        if (!pattern) return;
        const scale = Math.max(0.01, this.viewport?.scale || 1);
        pattern.setAttribute('patternTransform', `scale(${1 / scale})`);
    }

    _syncCopperRemovalHatches() {
        const defs = this._svgDefs || this.viewport?.svg?.querySelector('defs');
        defs?.querySelectorAll('[id^="pcb-copper-removal-hatch-"]').forEach((pattern) => {
            this._setCopperRemovalHatchMetrics(pattern);
        });
    }

    /** Draw copper-removal hatches once into a composited screen-space bitmap. */
    _scheduleRemovalHatchRender() {
        if (this._removalHatchFrame) return;
        this._removalHatchFrame = requestAnimationFrame(() => {
            this._removalHatchFrame = 0;
            this._renderRemovalHatches();
        });
    }

    /** Draw copper-removal hatches once into a composited screen-space bitmap. */
    _renderRemovalHatches() {
        const viewport = this.viewport;
        const container = this.canvasContainer;
        if (!viewport || !container) return;
        if (!this._removalHatchCanvas) {
            const canvas = document.createElement('canvas');
            canvas.className = 'pcb-removal-hatch-overlay';
            canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;';
            container.insertBefore(canvas, viewport.rulerContainer || viewport.crosshairContainer || null);
            this._removalHatchCanvas = canvas;
        }
        const canvas = this._removalHatchCanvas;
        const rect = viewport._getCachedRect();
        const dpr = window.devicePixelRatio || 1;
        const width = Math.max(1, Math.round(rect.width * dpr));
        const height = Math.max(1, Math.round(rect.height * dpr));
        if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
        }
        const context = canvas.getContext('2d');
        if (!context) return;
        context.setTransform(dpr, 0, 0, dpr, 0, 0);
        context.clearRect(0, 0, rect.width, rect.height);
        const colors = {
            'remove-copper': '#5f6770',
            'remove-solder-mask': '#8a6923',
            'remove-copper-mask': '#7c3b4c',
        };
        this._removalHatchPatterns ||= new Map();
        const viewBox = viewport.viewBox;
        const scale = viewport.scale || 1;
        for (const shape of this.boardShapes || []) {
            if (!shape || shape.type === 'fill' || !isLayerVisible(shape.layer)) continue;
            if (shape.layer !== 'top-copper' && shape.layer !== 'bottom-copper') continue;
            const mode = normalizeShapeCopperMode(shape.copperMode);
            if (!colors[mode]) continue;
            const bounds = boardShapeBounds(shape);
            if (!bounds || bounds.maxX < viewBox.x || bounds.maxY < viewBox.y
                || bounds.minX > viewBox.x + viewBox.width || bounds.minY > viewBox.y + viewBox.height) continue;
            const path = boardShapeRemovalPathD(shape);
            if (!path) continue;
            context.save();
            context.setTransform(dpr * scale, 0, 0, dpr * scale, -viewBox.x * dpr * scale, -viewBox.y * dpr * scale);
            context.beginPath();
            context.clip(new Path2D(path), 'evenodd');
            context.setTransform(dpr, 0, 0, dpr, 0, 0);
            let pattern = this._removalHatchPatterns.get(mode);
            if (!pattern) {
                const tile = document.createElement('canvas');
                tile.width = 36;
                tile.height = 36;
                const tileContext = tile.getContext('2d');
                tileContext.strokeStyle = colors[mode];
                tileContext.lineWidth = 1.2;
                if (mode === 'remove-solder-mask') {
                    for (let offset = 0; offset <= 36; offset += 12) {
                        tileContext.beginPath();
                        tileContext.moveTo(offset, 0);
                        tileContext.lineTo(offset, 36);
                        tileContext.moveTo(0, offset);
                        tileContext.lineTo(36, offset);
                        tileContext.stroke();
                    }
                } else {
                    for (let offset = -36; offset <= 36; offset += 18) {
                        tileContext.beginPath();
                        tileContext.moveTo(offset, 0);
                        tileContext.lineTo(offset + 36, 36);
                        if (mode === 'remove-copper') {
                            tileContext.moveTo(offset, 36);
                            tileContext.lineTo(offset + 36, 0);
                        }
                        tileContext.stroke();
                    }
                }
                pattern = context.createPattern(tile, 'repeat');
                this._removalHatchPatterns.set(mode, pattern);
            }
            context.fillStyle = pattern;
            context.fillRect(0, 0, rect.width, rect.height);
            context.restore();
        }
    }

    /**
     * Rebuild the per-side SVG clip-paths that cut copper where "remove
    * copper" circles sit, and apply (or clear) them on copper groups and
    * poured-copper paths. The cut reveals the canvas behind — no board-colour fill is
     * painted — so a track or pour passing through a removal circle reads as
     * genuinely removed, matching the 2D/3D board views.
     *
     * A clip-path (not a <mask>) is used deliberately: clipping is vector and
     * resolution-independent, so it stays exact at any zoom. A raster mask
     * blows past the GPU's maximum texture size when zoomed in and gets
     * silently dropped, which made the copper "fill back in".
     */
    updateCopperCuts({ geometryChanged = true } = {}) {
        const defs = this._ensureSvgDefs();
        if (!defs) return;
        const NS = 'http://www.w3.org/2000/svg';
        // Size the outer rectangle to the visible viewport (plus a one-screen
        // margin) rather than a fixed huge constant. The browser rasterises a
        // clip-path at the size of its bounding box; a giant rectangle makes
        // that raster exceed the GPU limit once zoomed in and the clip is
        // silently dropped (copper "fills back in"). A viewport-sized rect
        // keeps the raster ~screen-sized at any zoom. Off-screen copper that
        // falls outside the rect is clipped away, but it is off-screen anyway.
        const vb = this.viewport?.getVisibleBounds?.();
        let x0, y0, x1, y1;
        if (vb && Number.isFinite(vb.minX) && vb.maxX > vb.minX && vb.maxY > vb.minY) {
            const mx = vb.maxX - vb.minX;
            const my = vb.maxY - vb.minY;
            x0 = vb.minX - mx; x1 = vb.maxX + mx;
            y0 = vb.minY - my; y1 = vb.maxY + my;
        } else {
            const m = Math.max(this._boardWidth || 100, this._boardHeight || 80);
            x0 = -m; x1 = (this._boardWidth || 100) + m;
            y0 = -(this._boardHeight || 80) - m; y1 = m;
        }
        const r4 = (n) => Math.round(n * 10000) / 10000;
        // Cache the last-applied clip path string per side. Rebuilding the
        // clip-path <path> and re-setting the clip-path attribute invalidates
        // the copper layer's raster, forcing a full repaint of every track and
        // pour. Most calls (hover, re-select, dragging an unrelated element,
        // re-render-all) produce identical geometry, so a string compare lets
        // us skip all DOM work and the repaint it would trigger. `null` is the
        // cleared (no-cut) state; `undefined` means "not yet computed".
        const cache = this._copperCutCache
            || (this._copperCutCache = { top: undefined, bottom: undefined });
        const geometryCache = this._copperCutGeometry || (this._copperCutGeometry = {});
        const deferGeometry = areDragOverlaysDeferred(this) || getBoardShapeRotationPreview(this);
        let any = false;
        for (const side of ['top', 'bottom']) {
            const copperLayer = `${side}-copper`;
            const fillLayer = `${side}-fill`;
            const clipId = `pcb-copper-cut-${side}`;
            // Keep cutouts aligned with deferred pours until the drag commits or cancels.
            // Viewport changes can still resize the outer clip without moving its holes.
            const shapeCuts = (!geometryChanged || deferGeometry) && geometryCache[side]
                ? geometryCache[side]
                : (geometryCache[side] = boardShapeCopperCuts(this._pasteDrop ? this.pcbDocument : this, copperLayer));
            const existing = defs.querySelector(`#${clipId}`);
            if (shapeCuts.count === 0) {
                // Nothing to cut on this side. Only touch the DOM if we weren't
                // already in the cleared state.
                if (cache[side] !== null) {
                    if (existing) existing.remove();
                    this._layerGroups.get(copperLayer)?.removeAttribute('clip-path');
                    setCopperFillClip(this._layerGroups.get(fillLayer), null);
                    cache[side] = null;
                }
                continue;
            }
            any = true;
            // Outer rectangle keeps everything; board-shape removal sub-paths
            // toggle holes with even-odd fill.
            let d = `M ${r4(x0)} ${r4(y0)} L ${r4(x1)} ${r4(y0)} L ${r4(x1)} ${r4(y1)} L ${r4(x0)} ${r4(y1)} Z`;
            // Append board-shape copper-removal sub-paths.
            if (shapeCuts.d) d += ` ${shapeCuts.d}`;
            // Identical geometry already applied (and the clip element still
            // present) → skip the rebuild + re-apply, avoiding the repaint.
            if (cache[side] === d && existing) continue;
            const clip = existing || document.createElementNS(NS, 'clipPath');
            clip.setAttribute('id', clipId);
            clip.setAttribute('clipPathUnits', 'userSpaceOnUse');
            while (clip.firstChild) clip.removeChild(clip.firstChild);
            const path = document.createElementNS(NS, 'path');
            path.setAttribute('d', d);
            path.setAttribute('clip-rule', 'evenodd');
            clip.appendChild(path);
            if (!existing) defs.appendChild(clip);
            this._layerGroups.get(copperLayer)?.setAttribute('clip-path', `url(#${clipId})`);
            setCopperFillClip(this._layerGroups.get(fillLayer), clipId);
            cache[side] = d;
        }
        // Remember whether any cut is active so view-change handlers know to
        // re-fit the clip rectangle to the new viewport on pan/zoom.
        this._hasCopperCuts = any;
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
        if (!this._active) return false;

        // Don't hijack keys when the user is typing in an input/textarea
        // (e.g. the Properties panel text fields). Otherwise Backspace
        // would delete the selected text instead of a character.
        const tgt = /** @type {HTMLElement} */ (e.target);
        if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.tagName === 'SELECT' || tgt.isContentEditable)) {
            return false;
        }
        // The window-capture dispatcher must let panel navigation reach its handler.
        if (tgt?.closest?.('#pcbDrcSlidePanel')
            && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return false;

        if (!e.ctrlKey && !e.metaKey && !e.altKey) {
            if (e.key === '+' || e.key === '=') {
                this.viewport.zoomIn();
                return true;
            }
            if (e.key === '-' || e.key === '_') {
                this.viewport.zoomOut();
                return true;
            }
        }

        // File save shortcuts (Ctrl+S / Ctrl+Alt+S). While PCB is active it owns
        // the keyboard, and the schematic keyboard handler bails out when PCB is
        // active — so Ctrl+S must be handled here. Otherwise it isn't consumed by
        // the app and falls through to the browser's native "Save page as…"
        // dialog instead of saving the project (matching the PCB ribbon Save
        // button, which calls project.save()/saveAs()).
        if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
            void savePcbProject(this, e.altKey);
            return true;
        }

        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'c' || e.key === 'C')) {
            if (this.copySelection()) return true;
            return false;
        }
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'x' || e.key === 'X')) {
            if (this.cutSelection()) return true;
            return false;
        }
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'v' || e.key === 'V')) {
            if (this.pasteSelection()) return true;
            return false;
        }
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'a' || e.key === 'A')) {
            this._selectAllPcb();
            return true;
        }

        // Track-draw mode owns Escape, Enter and Space.
        if (this._trackDraw) {
            if (e.key === 'Escape') {
                cancelTrackDraw(this);
                return true;
            }
            if (e.key === 'Enter') {
                finishTrackDraw(this);
                return true;
            }
            if (e.code === 'Space' || e.key === ' ') {
                const snap = this._trackDraw.snap;
                if (snap) addTrackWaypoint(this, { x: snap.x, y: snap.y });
                if (this._trackDraw) toggleTrackLayer(this);
                return true;
            }
            return false;
        }

        // Fill-draw mode owns Enter / Escape.
        if (this._fillDraw) {
            if (e.key === 'Enter') {
                finishFillDraw(this);
                return true;
            }
            if (e.key === 'Escape') {
                cancelFillDraw(this);
                return true;
            }
            return false;
        }

        // Shape-draw mode owns Escape and Enter.
        if (this._shapeDraw) {
            if (e.key === 'Escape') {
                cancelShapeDraw(this);
                return true;
            }
            if (e.key === 'Enter' && this._shapeDraw.kind === 'polygon') {
                finishPolygonDraw(this);
                return true;
            }
            if (e.key === 'Enter' && this._shapeDraw.kind === 'line') {
                finishLineDraw(this);
                return true;
            }
            if (e.key === 'Enter') {
                finishShapeDrawAtPoint(this, this._shapeDraw.cursorWorld);
                return true;
            }
            return false;
        }

        // Otherwise: history, delete, selection-cancel.
        const ctrl = e.ctrlKey || e.metaKey;
        if (!ctrl && !e.altKey && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
            return runPcbNudgeAction(this, e.key);
        }
        if (ctrl && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
            return runPcbHistoryAction(this, 'undo');
        }
        if (ctrl && ((e.key === 'y' || e.key === 'Y') || ((e.key === 'z' || e.key === 'Z') && e.shiftKey))) {
            return runPcbHistoryAction(this, 'redo');
        }
        if (e.key === 'Delete' || e.key === 'Backspace') {
            return runPcbDeleteAction(this);
        }
        if (e.key === 'Escape') return runPcbEscapeAction(this);
        // Component transform shortcuts (match the schematic editor):
        //   Space = rotate right, X = flip horizontal, Y = flip vertical.
        const selectedRef = getPcbSelection(this, 'reftext')[0] || null;
        const selectedComponent = getPcbSelection(this, 'component')[0] || null;
        if (selectedRef && this.placements.has(selectedRef)) {
            // A selected reference designator rotates with Space; the
            // component body shortcuts don't apply while the label is selected.
            if (e.code === 'Space' || e.key === ' ') {
                this._rotateRefText(selectedRef);
                e.preventDefault();
                return true;
            }
        }
        if (selectedComponent && this.placements.has(selectedComponent)) {
            if (e.code === 'Space' || e.key === ' ') {
                this._rotateComponent(selectedComponent, 'R');
                this._showComponentProperties(selectedComponent);
                e.preventDefault();
                return true;
            }
            if (e.key === 'x' || e.key === 'X') {
                this._flipComponent(selectedComponent, 'H');
                this._showComponentProperties(selectedComponent);
                e.preventDefault();
                return true;
            }
            if (e.key === 'y' || e.key === 'Y') {
                this._flipComponent(selectedComponent, 'V');
                this._showComponentProperties(selectedComponent);
                e.preventDefault();
                return true;
            }
        }
        if ((e.code === 'Space' || e.key === ' ') && !ctrl && !e.altKey
            && !getPcbSelection(this).length && !this._pasteDrop && !this._textEdit
            && !this._pcbSelectionInteraction && tgt?.tagName !== 'BUTTON') {
            this.fitToContent();
            return true;
        }
        return false;
    }
    _commitTrack(track, vias = []) {
        this.history.execute(new AddTrackCommand(this, track, vias));
    }

    /**
     * Commit one or more freshly drawn Track objects plus any
     * layer-transition Vias as a single undo step. A draw that toggled
     * copper layers mid-route produces several single-layer Tracks joined
     * by vias; grouping them and connected-copper Net adoption keeps undo/redo atomic.
     * @param {Track[]} tracks
     * @param {Via[]} [vias]
     * @param {object[]} [destinationShapes]
     */
    _commitTracks(tracks, vias = [], destinationShapes = []) {
        const list = Array.isArray(tracks) ? tracks : [tracks];
        // Fuse any drawn endpoint that lands on an existing same-net/
        // same-layer track node into that track, so joined tracks render
        // as one continuous polyline instead of two coincident objects.
        const command = buildDrawnTrackCommands(this, list, vias, destinationShapes);
        if (command === false) return false;
        if (command) this.history.execute(command);
        return true;
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
        if (reason === 'new' && this._active && !this._boardOutlineDrawn) {
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
        if (dirty) this._markDirty();
        else this.markSectionClean();
    }

    /**
     * Flag PCB edits and notify the project; its UI host owns the shared title.
     */
    _markDirty() {
        this._cancelAutoRoute?.('Routing cancelled because the board changed.');
        this._isDirty = true;
        renderPanelPreview(this);
        this.onDocumentChanged?.();
        // Keep the clearance overlay in sync after any committed edit (e.g. an
        // undo/redo that relocates a via leaves orphaned halos otherwise).
        this.refreshClearanceHalos?.();
        this._scheduleDRC();
    }

    /**
     * Show a transient "Saved" toast anchored to the PCB status-bar filename.
     * Mirrors the schematic editor's toast, but anchors to the PCB filename so
     * it appears in the right place while the PCB view is active (the schematic
     * docTitle is hidden then).
     * @param {string} [text]
     */
    _showSaveToast(text = 'Saved') {
        const anchor = this.status.docTitle || document.getElementById('pcbDocTitle');
        if (!anchor) return;
        const rect = anchor.getBoundingClientRect();
        const existing = document.getElementById('ribbon-save-toast');
        if (existing) existing.remove();
        const toast = document.createElement('div');
        toast.id = 'ribbon-save-toast';
        toast.className = 'ribbon-save-toast';
        toast.textContent = text;
        toast.style.left = `${rect.left + rect.width / 2}px`;
        toast.style.top = `${rect.top - 28}px`;
        document.body.appendChild(toast);
        requestAnimationFrame(() => toast.classList.add('show'));
        window.setTimeout(() => {
            toast.classList.remove('show');
            window.setTimeout(() => toast.remove(), 200);
        }, 900);
    }

    /**
     * Restore PCB state previously produced by serialize(). Replaces any
     * existing tracks/vias and re-renders them.
     * @param {{tracks?: Array, vias?: Array}|null} data
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
            this.viewport.addContent(g);
            this._layerGroups.set(id, g);
        }
    }

    /**
     * Sync the SVG render groups to the current (possibly session-restored)
     * layer-panel state. Run once after the groups are created.
     */
    _applyLayerPrefsToRender() {
        for (const l of PCB_LAYERS) {
            this._onLayerVisibilityChanged(l.id, l.visible);
            this._onLayerLockChanged(l.id, l.locked);
        }
        for (const f of PCB_COPPER_FILLS) {
            this._onCopperFillVisibilityChanged(f.id, f.visible);
            this._onCopperFillLockChanged(f.id, f.locked);
        }
        for (const ov of PCB_OVERLAYS) {
            this._onOverlayVisibilityChanged(ov.id, ov.visible);
        }
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
            this.viewport.addContent(g);
            this._layerGroups.set(layerId, g);
        }
        return g;
    }

    /**
     * Called by the layer panel when visibility is toggled.
     * @param {string} layerId
     * @param {boolean} visible
     */
    _onLayerVisibilityChanged(layerId, visible) {
        if (this._pasteDrop && !visible && !isPcbPasteEditable(this)) this._cancelPasteDrop();
        if (!visible && layerId === 'board-outline') {
            getPropertyEditor(this, 'boardDimension')?.dispose();
            endBoardOutlineResize(this, false);
        }
        if (!visible && this._groupDrag && getPcbSelectionEntries(this).some(entry => entry.visible === false)) {
            this._cancelPosePreviews();
        }
        if (!visible && this._shapeDrag?.original.layer === layerId) {
            if (!finishSelectionInteraction(this, false)) endBoardShapeDrag(this, false);
        }
        if (!visible && this._vertexDrag && trackPointerTouchesLayer(this, layerId)) {
            if (!finishSelectionInteraction(this, false)) cancelVertexDrag(this);
        }
        if (!visible && getBoardShapeRotationPreview(this)?.original.layer === layerId) {
            if (!finishSelectionInteraction(this, false)) finishBoardShapeRotationPreview(this);
        }
        if (!visible) eachPropertyEditorOnLayer(this, layerId, editor => editor.dispose());
        const g = this._layerGroups.get(layerId);
        if (g) {
            g.style.display = visible ? '' : 'none';
        }
        // Pad-number labels live on their own layer above each copper layer
        // (so tracks can't hide them); keep their visibility tied to the
        // copper side they belong to.
        if (layerId === 'top-copper' || layerId === 'bottom-copper') {
            const pn = this._layerGroups.get(layerId === 'bottom-copper' ? 'bottom-pad-numbers' : 'top-pad-numbers');
            if (pn) pn.style.display = visible ? '' : 'none';
            // Copper-removal knockouts belong to the copper they cut.
            const ko = this._layerGroups.get(layerId === 'bottom-copper' ? 'bottom-copper-knockout' : 'top-copper-knockout');
            if (ko) ko.style.display = visible ? '' : 'none';
            const labels = this._layerGroups.get(`${layerId}-track-labels`);
            if (labels) labels.style.display = visible ? '' : 'none';
            const drills = this._layerGroups.get(`${layerId}-pad-drills`);
            if (drills) drills.style.display = visible ? '' : 'none';
            this._scheduleRemovalHatchRender();
        }
        // Clearance overlay tracks per-layer visibility.
        if (this._clearancesVisible && ['top-copper', 'bottom-copper', 'vias', 'hole'].includes(layerId)) {
            this.showClearances(true);
        }
        // A newly-hidden layer must not keep anything on it selected or
        // hovered — hidden objects are non-interactive (can't be selected,
        // dragged or deleted), mirroring the locked-layer behaviour. Objects
        // that stay visible keep their selection.
        if (!visible) {
            const viaAffected = layerId === 'vias' && !isViaVisible();
            const selectedTrack = getSelectedTrack(this);
            const selectedVia = getSelectedVia(this);
            if ((selectedTrack && selectedTrack.layer === layerId) ||
                (selectedVia && viaAffected)) {
                clearTrackSelection(this);
                this.clearProperties();
            }
            // Single-object teardown (node focus, text refresh); multi-selections
            // are pruned below so objects on other layers stay selected.
            const single = getPcbSelectionEntries(this).length === 1;
            const selectedText = getPcbSelection(this, 'text')[0] || null;
            if (single && selectedText && selectedText.layer === layerId) {
                this._selectText(null);
                this.clearProperties();
            }
            const selectedShape = getPcbSelection(this, 'shape')[0] || null;
            if (single && selectedShape && selectedShape.layer === layerId) {
                selectBoardShape(this, null);
                this.clearProperties();
            }
            if (this._boardOutlineSelected && layerId === 'board-outline') {
                this._selectBoardOutline(false);
            }
            if (deselectHiddenPcbSelection(this)) showPcbSelectionProperties(this);
            setHoverHighlight(this, null);
        }
        this._refreshPcbSelectionHighlights?.();
        saveLayerPrefs();
    }

    /**
     * Called by the layer panel when a layer's lock is toggled.
     * @param {string} layerId
     * @param {boolean} locked
     */
    _onLayerLockChanged(layerId, locked) {
        if (this._pasteDrop && locked && !isPcbPasteEditable(this)) this._cancelPasteDrop();
        if (locked && layerId === 'board-outline') {
            getPropertyEditor(this, 'boardDimension')?.cancel();
            endBoardOutlineResize(this, false);
        }
        if (locked && this._groupDrag && getPcbSelectionEntries(this).some(entry => entry.locked)) {
            this._cancelPosePreviews();
        }
        if (locked && this._shapeDrag?.original.layer === layerId) {
            if (!finishSelectionInteraction(this, false)) endBoardShapeDrag(this, false);
        }
        if (locked && this._vertexDrag && trackPointerTouchesLayer(this, layerId)) {
            if (!finishSelectionInteraction(this, false)) cancelVertexDrag(this);
        }
        if (locked && getBoardShapeRotationPreview(this)?.original.layer === layerId) {
            if (!finishSelectionInteraction(this, false)) finishBoardShapeRotationPreview(this);
        }
        if (locked) eachPropertyEditorOnLayer(this, layerId, editor => editor.cancel());
        const draggingReference = this.placements?.get(this._refDrag?.compId);
        if (locked && draggingReference
            && (draggingReference.side === 'bottom' ? 'bottom-silk' : 'top-silk') === layerId) {
            if (!finishSelectionInteraction(this, false)) this._endRefDrag(false);
        }
        const draggingText = this.texts?.get(this._textDrag?.textId);
        if (locked && draggingText?.layer === layerId) {
            if (!finishSelectionInteraction(this, false)) this._endTextDrag(false);
        }
        const anchorInteraction = this._pcbSelectionInteraction;
        if (locked && anchorInteraction?.adapter?.kind === 'text'
            && anchorInteraction.adapter.object.layer === layerId) {
            finishSelectionInteraction(this, false);
        }
        const editingReference = this.placements?.get(this._textEdit?.options?.componentId);
        const editingLayer = editingReference
            ? (editingReference.side === 'bottom' ? 'bottom-silk' : 'top-silk') : this._textEdit?.text?.layer;
        if (locked && editingLayer === layerId) {
            this._endTextInlineEdit(false);
        }
        const g = this._layerGroups.get(layerId);
        if (g) g.style.opacity = '';
        if (layerId === 'top-copper' || layerId === 'bottom-copper') {
            const ko = this._layerGroups.get(layerId === 'bottom-copper' ? 'bottom-copper-knockout' : 'top-copper-knockout');
            if (ko) ko.style.opacity = '';
        }
        saveLayerPrefs();
        refreshPcbLayerOptions(layerId);
        refreshBoardShapeToolLayer(this);
        const checkbox = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropOutlineLocked'));
        if (checkbox) checkbox.checked = locked;
        this._refreshPcbSelectionHighlights?.();
        if (getPcbSelection(this, 'reftext').some(id => {
            const placement = this.placements.get(id);
            return placement && (placement.side === 'bottom' ? 'bottom-silk' : 'top-silk') === layerId;
        }) || getPcbSelection(this, 'text').some(text => text.layer === layerId)) showPcbSelectionProperties(this);
        setHoverHighlight(this, null);
    }

    /**
     * Overlay visibility callback (clearance halos, etc.). Wired from
     * `buildLayerPanel` via the Overlays section in the layer dropdown.
     * @param {string} overlayId
     * @param {boolean} visible
     */
    _onOverlayVisibilityChanged(overlayId, visible) {
        if (overlayId === 'clearance') {
            this.showClearances(visible);
        } else if (overlayId === 'ratlines') {
            // Ratlines have a real SVG layer group; toggle its display.
            const g = this._layerGroups.get('ratlines');
            if (g) g.style.display = visible ? '' : 'none';
            this._drcPresentation?.overlayVisibilityChanged();
        }
        saveLayerPrefs();
    }

    fitToContent() {
        this._ensureViewport();
        if (!this.viewport) return;

        const panel = this.panelization ? renderPanelPreview(this) : null;
        const bounds = panel?.bounds || boardBoundary(this);
        this.viewport.fitToBounds(
            Math.min(0, bounds.x) - 10,
            Math.min(0, bounds.y - (panel ? 12 : 0)),
            Math.max(0, bounds.x + bounds.w),
            Math.max(0, bounds.y + bounds.h) + 10,
            0, 'bottom-left',
        );
    }

    _bindRibbonTabs() {
        if (!this.ribbon) return;

        const tabs = this.ribbon.querySelectorAll('.ribbon-tab[data-tab]');
        const panels = this.ribbon.querySelectorAll('.ribbon-panel');
        let activeTabId = /** @type {HTMLElement|null} */ (
            this.ribbon.querySelector('.ribbon-tab.active')
        )?.dataset.tab || null;

        const retainRibbonHeight = bindRibbonHeight(this.ribbon);
        this._retainRibbonHeight = retainRibbonHeight;

        const setActive = (tabId, userInitiated = false) => {
            preparePcbRibbonTransition(this, activeTabId, tabId, userInitiated);
            retainRibbonHeight();
            tabs.forEach(tab => {
                const tabEl = /** @type {HTMLElement} */ (tab);
                tabEl.classList.toggle('active', tabEl.dataset.tab === tabId);
            });

            panels.forEach(panel => {
                const panelEl = /** @type {HTMLElement} */ (panel);
                panelEl.classList.toggle('active', panelEl.dataset.panel === tabId);
            });
            activeTabId = tabId;

            this.syncClipboardButtons?.();

            if (tabId === 'pcb-home') {
                this._syncPcbHomeToolHighlight?.();
            }

            // The DRC runs live only while the Design tab is active. The
            // slide-in problem panel, however, stays open across tab switches
            // — it's dismissed only by re-clicking the DRC button or its X.
            this._getDrcPresentation().setDesignActive(tabId === 'pcb-design');
        };

        this._activateRibbonTab = setActive;

        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                const tabEl = /** @type {HTMLElement} */ (tab);
                if (!tabEl.dataset.tab) return;
                setActive(tabEl.dataset.tab, true);
            });
        });
    }

    // ── Board Outline ─────────────────────────────────────────────

    _closeBoardDimensionsDialog() {
        this._boardDimensionsOverlay?.remove();
        this._boardDimensionsOverlay = null;
    }

    /**
     * Show a dialog asking for board dimensions on first entry.
     */
    _showBoardDimensionsDialog() {
        if (this._boardDimensionsOverlay) return;
        getPropertyEditor(this, 'boardDimension')?.commit();
        if (this._boardOutlineResize) endBoardOutlineResize(this);
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
                        <input class="app-modal-input" id="boardDlgWidth" type="number" value="${this._boardWidth}" min="5" step="1" style="margin-top:2px">
                    </div>
                    <div style="flex:1">
                        <label for="boardDlgHeight" style="font-size:11px;color:var(--text-secondary)">Height (mm)</label>
                        <input class="app-modal-input" id="boardDlgHeight" type="number" value="${this._boardHeight}" min="5" step="1" style="margin-top:2px">
                    </div>
                    <div style="flex:1">
                        <label for="boardDlgRadius" style="font-size:11px;color:var(--text-secondary)">Corner Radius (mm)</label>
                        <input class="app-modal-input" id="boardDlgRadius" type="number" value="${Number(this._boardRadius).toFixed(2)}" min="0" step="0.5" style="margin-top:2px">
                    </div>
                </div>
                <div id="boardDlgCircleSizes" style="display:none;margin-top:10px">
                    <label for="boardDlgDiameter" style="font-size:11px;color:var(--text-secondary)">Diameter (mm)</label>
                    <input class="app-modal-input" id="boardDlgDiameter" type="number" value="${Math.min(this._boardWidth, this._boardHeight)}" min="5" step="1" style="margin-top:2px">
                </div>
                <div class="app-modal-message" style="margin-top:10px">Tip: Edit the board outline after creation for more complex shapes</div>
                <div class="app-modal-actions">
                    <button class="app-modal-btn app-modal-ok" id="boardDlgOk">OK</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        this._boardDimensionsOverlay = overlay;

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
            if (this._boardDimensionsOverlay === overlay) {
                (shapeInput.value === 'circle' ? diameterInput : widthInput).focus();
            }
        }, 50);

        const accept = () => {
            if (this._boardDimensionsOverlay !== overlay) return;
            const w = parseFloat(widthInput?.value) || 100;
            const h = parseFloat(heightInput?.value) || 80;
            const r = parseFloat(radiusInput?.value) || 0;
            const before = {
                width: this._boardWidth,
                height: this._boardHeight,
                radius: this._boardRadius,
            };
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
                this.history.execute(new SetBoardOutlineCommand(this, before, after));
            } else if (!this._boardOutlineDrawn) {
                // Dimensions unchanged from defaults, so no command runs — but
                // the outline still needs its first draw, and the document must
                // be flagged dirty so the autosave captures the new board.
                this.pcbDocument.ensureBoardOutline();
                this._drawBoardOutline();
                this._markDirty();
            }
            this._closeBoardDimensionsDialog();
        };

        okBtn?.addEventListener('click', accept);
        overlay.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') accept();
        });
    }

    /**
     * Draw (or redraw) the board outline on the board-outline layer.
     */
    _drawBoardOutline() {
        const layer = this.getLayerGroup('board-outline');
        const old = layer.querySelector('.pcb-board-outline');
        if (old) old.remove();
        const shape = getBoardOutline(this);
        if (!shape) {
            this._boardOutlineDrawn = false;
            return;
        }
        renderBoardShape(this, shape, { liveDrag: !!getBoardDimensionPreview(this) || areDragOverlaysDeferred(this) });
        const wasDrawn = this._boardOutlineDrawn;
        this._boardOutlineDrawn = true;
        renderPanelPreview(this);
        if (!wasDrawn && this.viewport && !getBoardDimensionPreview(this)) {
            const bounds = boardBoundary(this);
            this.viewport.fitToBounds(bounds.x, bounds.y, bounds.x + bounds.w, bounds.y + bounds.h, 5);
        }
    }

    // ── Properties Panel ──────────────────────────────────────────

    /**
     * Test if a world point is near the board outline edge.
     */
    _hitTestBoardOutline(pos) {
        if (getBoardOutline(this)) return false;
        if (!this._boardOutlineDrawn) return false;
        // The board outline lives on the 'board-outline' layer; don't allow
        // selecting/hovering it while that layer is locked or hidden.
        if (isLayerLocked('board-outline') || !isLayerVisible('board-outline')) return false;
        const w = this._boardWidth, h = this._boardHeight;
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
     */
    _hoverBoardOutline(hovered) {
        const outline = this.getLayerGroup('board-outline').querySelector('.pcb-board-outline');
        if (!outline) return;
        if (this._boardOutlineSelected) return; // don't override selection highlight
        if (hovered) {
            outline.setAttribute('stroke', '#ffe066');
            outline.setAttribute('stroke-width', '0.35');
        } else {
            outline.setAttribute('stroke', '#f1c40f');
            outline.setAttribute('stroke-width', '0.2');
        }
    }

    /**
     * Set board outline selection state.
     */
    _selectBoardOutline(selected) {
        const shape = getBoardOutline(this);
        if (shape && selected) {
            selectBoardShape(this, shape);
            return;
        }
        if (!selected && this._boardOutlineResize) endBoardOutlineResize(this, false);
        if (!selected) getPropertyEditor(this, 'boardDimension')?.dispose();
        this._boardOutlineSelected = selected;
        renderBoardOutlineHandles(this);
        const outline = this.getLayerGroup('board-outline').querySelector('.pcb-board-outline');
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

    /**
     * Render extra tool controls inline within the Tools group on the
     * Home tab — same pattern as the schematic editor's
     * `.ribbon-shape-options` container.
     * @param {string} html - inner HTML for the options container
     * @param {(items: HTMLElement) => void} [bind] - optional listener wiring
     */
    _showToolOptions(html, bind) {
        const items = document.getElementById('pcbToolOptions');
        if (!items) return;
        items.innerHTML = html;
        bind?.(items);
    }

    _hideToolOptions() {
        const items = document.getElementById('pcbToolOptions');
        if (items) items.innerHTML = '';
    }

    /**
    * Show Fill tool options (copper-layer picker). If a pour outline is
    * already in progress, retarget it live.
     */
    _showFillToolOptions() {
        const cur = this._fillToolLayer === 'bottom-copper' ? 'bottom-copper' : 'top-copper';
        const opt = (id, name) => `<option value="${id}"${id === cur ? ' selected' : ''}>${name}</option>`;
        this._showToolOptions(
            `<label>Layer <select id="pcbToolFillLayer">${opt('top-copper', 'Top Copper')}${opt('bottom-copper', 'Bottom Copper')}</select></label>`,
            () => {
                const el = /** @type {HTMLSelectElement|null} */ (document.getElementById('pcbToolFillLayer'));
                el?.addEventListener('change', () => {
                    const next = el.value === 'bottom-copper' ? 'bottom-copper' : 'top-copper';
                    if (isLayerLocked(next)) {
                        el.value = this._fillToolLayer || 'top-copper';
                        return;
                    }
                    this._fillToolLayer = next;
                    if (this._fillDraw) this._fillDraw.layer = this._fillToolLayer;
                    this.setPcbStatus();
                });
            });
    }

    /**
     * Clear the properties panel to its default state.
     */
    clearProperties() {
        this.setPropertiesTitle('Properties');
        const items = this.propertiesItems();
        if (items) {
            items.innerHTML = '<span style="font-size:11px;color:var(--text-muted)">Click an object to see its properties</span>';
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
        getPropertyEditor(this, 'component')?.clearExtras();
        return document.getElementById('pcbPropsItems');
    }

    /** Bring the Properties ribbon tab to the front (after showing a panel). */
    showPropertiesTab() {
        this.setActiveRibbonTab('pcb-properties');
    }

    /**
     * Bring a ribbon tab to the front; does nothing before the ribbon is bound.
     * @param {string} tabId - `pcb-home`, `pcb-properties`, `pcb-design`, …
     */
    setActiveRibbonTab(tabId) {
        this._activateRibbonTab?.(tabId);
    }

    /** Build the shared editable Net dropdown used by PCB tool properties. */
    toolNetOptions(current = '') {
        const escape = (value) => String(value).replace(/[&<>"']/g, (char) => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
        ));
        const netNames = new Set((this.netlist || []).map((entry) => String(entry.net || '')).filter(Boolean));
        for (const source of [this.tracks, this.vias, this.pads, this.boardShapes, this.copperFills]) {
            for (const item of source || []) {
                const net = String(item?.net || '');
                if (net) netNames.add(net);
            }
        }
        const selected = String(current || '');
        const options = `<button type="button" data-net="">None</button>${[...netNames].sort().map((net) =>
            `<button type="button" data-net="${escape(net)}"${net === selected ? ' aria-current="true"' : ''}>${escape(net)}</button>`
        ).join('')}`;
        return { escape, options };
    }

    /** Bind an editable Net input and its picker menu to a tool-setting callback. */
    bindToolNetControl(items, inputId, onChange) {
        const netEl = /** @type {HTMLInputElement|null} */ (items.querySelector(`#${inputId}`));
        const menuEl = /** @type {HTMLDetailsElement|null} */ (items.querySelector('.prop-net-menu'));
        netEl?.addEventListener('change', () => onChange(netEl.value.trim()));
        menuEl?.addEventListener('click', (event) => {
            const option = /** @type {HTMLButtonElement|null} */ (event.target instanceof Element ? event.target.closest('button[data-net]') : null);
            if (!option || !netEl) return;
            netEl.value = option.dataset.net || '';
            netEl.dispatchEvent(new Event('change'));
            menuEl.open = false;
        });
        menuEl?.addEventListener('toggle', () => {
            if (!menuEl.open || !netEl) return;
            const current = netEl.value.trim();
            for (const option of menuEl.querySelectorAll('button[data-net]')) {
                option.toggleAttribute('aria-current', option.dataset.net === current);
            }
        });
    }

    /** Show Track draw defaults and live draw settings in Properties. */
    _showTrackDrawProperties() {
        this.setPcbStatus();
        const items = this.propertiesItems();
        if (!items) return;
        const ctx = this._trackDraw;
        const p = this.getRoutingParams?.() || {};
        const width = ctx?.width || (Number.isFinite(p.trackWidth) && p.trackWidth > 0 ? p.trackWidth : 0.2);
        const layer = ctx?.currentLayer || (this._trackToolLayer === 'bottom-copper' ? 'bottom-copper' : 'top-copper');
        const net = ctx?.net ?? String(this._trackToolNet || '');
        const { escape, options } = this.toolNetOptions(net);
        this.setPropertiesTitle('New Track');
        items.innerHTML = `
            <div class="prop-row" data-prop="layer"><label>Layer</label><select id="pcbPropTrackToolLayer"><option value="top-copper"${layer === 'top-copper' ? ' selected' : ''}>Top Copper</option><option value="bottom-copper"${layer === 'bottom-copper' ? ' selected' : ''}>Bottom Copper</option></select></div>
            <div class="prop-row" data-prop="net"><label>Net</label><span class="prop-net-control"><input type="text" id="pcbPropTrackToolNet" value="${escape(net)}" placeholder="None"><details class="prop-net-menu"><summary aria-label="Select existing net"></summary><div>${options}</div></details></span></div>
            <div class="prop-row" data-prop="lineWidth"><label>Width (mm)</label><input type="number" id="pcbPropTrackToolWidth" value="${width}" min="0.05" step="0.05" data-number-format="precise"></div>
        `;
        const layerEl = /** @type {HTMLSelectElement|null} */ (items.querySelector('#pcbPropTrackToolLayer'));
        const widthEl = /** @type {HTMLInputElement|null} */ (items.querySelector('#pcbPropTrackToolWidth'));
        this.bindToolNetControl(items, 'pcbPropTrackToolNet', (next) => {
            this._trackToolNet = next;
            if (ctx) {
                ctx.net = next;
                const last = ctx.points[ctx.points.length - 1];
                updateTrackDraw(this, ctx.snap ? { x: ctx.snap.x, y: ctx.snap.y } : last);
            }
        });
        layerEl?.addEventListener('change', () => {
            const next = layerEl.value === 'bottom-copper' ? 'bottom-copper' : 'top-copper';
            if (isLayerLocked(next)) {
                layerEl.value = layer;
                return;
            }
            this._trackToolLayer = next;
            if (ctx) ctx.currentLayer = next;
            this.setPcbStatus();
        });
        widthEl?.addEventListener('input', () => {
            if (!commitDesignInput(this, 'trackWidth', widthEl, 'mm')) return;
            const next = this.designSettings.values.trackWidth;
            renderDesignSettings(this);
            if (!ctx) return;
            ctx.width = next;
            const last = ctx.points[ctx.points.length - 1];
            updateTrackDraw(this, ctx.snap ? { x: ctx.snap.x, y: ctx.snap.y } : last);
        });
        widthEl?.addEventListener('change', () => {
            if (widthEl.validity.customError) widthEl.reportValidity();
        });
        this.setActiveRibbonTab?.('pcb-properties');
    }

    /** Show Via placement defaults in Properties. */
    _showViaToolProperties() {
        const items = this.propertiesItems();
        if (!items) return;
        const p = this.getRoutingParams?.() || {};
        const diameter = Number.isFinite(p.viaDiameter) && p.viaDiameter > 0 ? p.viaDiameter : 0.6;
        const drill = Number.isFinite(p.viaDrill) && p.viaDrill > 0 ? p.viaDrill : 0.3;
        const net = String(this._viaToolNet || '');
        const { escape, options } = this.toolNetOptions(net);
        this.setPropertiesTitle('New Via');
        items.innerHTML = `
            <div class="prop-row" data-prop="net"><label>Net</label><span class="prop-net-control"><input type="text" id="pcbPropViaToolNet" value="${escape(net)}" placeholder="None"><details class="prop-net-menu"><summary aria-label="Select existing net"></summary><div>${options}</div></details></span></div>
            <div class="prop-row" data-prop="diameter"><label>Diameter (mm)</label><input type="number" id="pcbPropViaToolDiameter" value="${diameter}" min="${drill}" step="0.05" data-number-format="precise"></div>
            <div class="prop-row" data-prop="drill"><label>Drill (mm)</label><input type="number" id="pcbPropViaToolDrill" value="${drill}" min="0.05" max="${diameter}" step="0.05" data-number-format="precise"></div>
        `;
        const diameterEl = /** @type {HTMLInputElement|null} */ (items.querySelector('#pcbPropViaToolDiameter'));
        const drillEl = /** @type {HTMLInputElement|null} */ (items.querySelector('#pcbPropViaToolDrill'));
        this.bindToolNetControl(items, 'pcbPropViaToolNet', (next) => { this._viaToolNet = next; });
        diameterEl?.addEventListener('input', () => {
            const next = parseFloat(diameterEl.value);
            if (Number.isFinite(next) && next > 0 && next < parseFloat(drillEl?.value || '0')) {
                diameterEl.value = drillEl.value;
            }
            if (!commitDesignInput(this, 'viaDiameter', diameterEl, 'mm')) return;
            if (drillEl) drillEl.max = diameterEl.value;
            renderDesignSettings(this);
            if (this._lastCrosshairWorld) this._updateViaPreview(this._lastCrosshairWorld);
        });
        drillEl?.addEventListener('input', () => {
            const next = parseFloat(drillEl.value);
            if (Number.isFinite(next) && next > parseFloat(diameterEl?.value || '0')) {
                drillEl.value = diameterEl.value;
            }
            if (!commitDesignInput(this, 'viaDrill', drillEl, 'mm')) return;
            if (diameterEl) diameterEl.min = drillEl.value;
            renderDesignSettings(this);
            if (this._lastCrosshairWorld) this._updateViaPreview(this._lastCrosshairWorld);
        });
        for (const element of [diameterEl, drillEl]) {
            element?.addEventListener('change', () => {
                if (element.validity.customError) element.reportValidity();
            });
        }
        this.setActiveRibbonTab?.('pcb-properties');
    }

    _showPadToolProperties() {
        this._showPadEditor(null);
    }

    _showPadProperties(pad) {
        if (pad) this._showPadEditor(pad);
    }

    _showPadEditor(pad) {
        showPadEditor(this, pad, {
            defaults: this._padDefaults,
            refreshPreview: () => { if (this._lastCrosshairWorld) this._updatePadPreview(this._lastCrosshairWorld); },
        });
    }

    /** Show Properties-tab defaults for a board shape being created. */
    _showBoardShapeToolProperties(kind) {
        showBoardShapeToolProperties(this, kind);
    }

    _syncBoardOutlineInputs() {
        for (const [id, value] of [
            ['pcbPropBoardW', this._boardWidth],
            ['pcbPropBoardH', this._boardHeight],
            ['pcbPropBoardR', this._boardRadius],
        ]) {
            const input = /** @type {HTMLInputElement|null} */ (document.getElementById(id));
            if (input) input.value = Number(value).toFixed(2);
        }
        getPropertyEditor(this, 'boardDimension')?.sync();
    }

    /**
     * Show board outline properties and switch to Properties tab.
     */
    _showBoardOutlineProperties() {
        showBoardOutlineProperties(this);
    }

    _getComponentProperties() {
        return getPropertyEditor(this, 'component') ?? setPropertyEditor(this, 'component', new ComponentProperties({
            getPlacement: id => this.placements.get(id),
            isActive: () => this._active !== false,
            isSelected: (kind, id) => isPcbSelected(this, kind, id),
            getItems: () => this.propertiesItems(),
            setTitle: title => this.setPropertiesTitle(title),
            activateTab: () => this.setActiveRibbonTab?.('pcb-properties'),
            layerLabel: layer => this.layerLabel(layer),
            bindStrokeText: (items, model, spec) => this._bindStrokeTextProps(items, model, spec),
            rotate: (id, before, after) => this.history.execute(new RotatePlacementCommand(this, id, before, after)),
            setLocked: (id, locked) => {
                finishSelectionInteraction(this, false);
                this.history.execute(new SetPlacementLockedCommand(this, id, locked));
            },
            setReferenceVisible: (id, visible) => this._setComponentRefVisible(id, visible),
            setSide: (id, side) => this._setPlacementSide(id, side),
            flip: (id, axis) => this._flipComponent(id, axis),
            open3D: id => this._openComponent3DPopout(id),
            renderReference: id => this._rerenderRef(id),
            drawReferenceOverlay: (id, tether) => this._drawRefOverlay(id, tether),
            setReferenceStyle: (id, before, after) => this.history.execute(new SetRefStyleCommand(this, id, before, after)),
        }));
    }

    _syncComponentRotationInput(compId) {
        getPropertyEditor(this, 'component')?.syncRotationInput(compId);
    }

    /** Show properties for a single placed component. */
    _showComponentProperties(compId) {
        return PCBApp.prototype._getComponentProperties.call(this).showComponent(compId);
    }


    /**
     * Show a small "Show 3D" context menu for a placed footprint that carries a
     * 3D OBJ model, at the given screen position. Takes the component id (not a
     * placement object) so the action resolves the *live* placement at click
     * time — mirroring the Properties button — and never acts on a placement
     * that was orphaned by an autosave/schematic re-sync between right-click
     * and selecting the menu item.
     * @param {string} compId
     * @param {number} clientX
     * @param {number} clientY
     */
    _showComponent3DMenu(compId, clientX, clientY) {
        if (!hasAny3DModel(this.placements.get(compId))) return;
        dismissTrackContextMenu();
        const menu = document.createElement('div');
        menu.id = 'pcbTrackContextMenu';
        menu.style.cssText = `position:fixed;z-index:10000;background:#2b2b2b;border:1px solid #555;border-radius:4px;padding:2px 0;box-shadow:0 2px 8px rgba(0,0,0,0.4);min-width:120px;left:${clientX}px;top:${clientY}px;`;
        const el = document.createElement('div');
        el.textContent = '\uD83E\uDDCA Show 3D';
        el.style.cssText = 'padding:6px 16px;color:#eee;cursor:pointer;font:13px/1.4 system-ui,sans-serif;white-space:nowrap;';
        el.addEventListener('mouseenter', () => { el.style.background = '#3a3a3a'; });
        el.addEventListener('mouseleave', () => { el.style.background = ''; });
        el.addEventListener('click', () => {
            dismissTrackContextMenu();
            this._openComponent3DPopout(compId);
        });
        menu.appendChild(el);
        menu.addEventListener('contextmenu', (e) => e.preventDefault());
        document.body.appendChild(menu);
        const dismiss = (e) => {
            if (!menu.contains(/** @type {Node|null} */ (e.target))) dismissTrackContextMenu();
        };
        const onKey = (e) => { if (e.key === 'Escape') dismissTrackContextMenu(); };
        setTimeout(() => {
            document.addEventListener('mousedown', dismiss, { capture: true });
            document.addEventListener('keydown', onKey, { capture: true });
        }, 0);
        /** @type {any} */ (menu)._dismiss = { dismiss, onKey };
    }

    /**
     * Open the interactive 3D model pop-out for a placement (or compId).
     * @param {string|object} placementOrId
     */
    _openComponent3DPopout(placementOrId) {
        const pl = typeof placementOrId === 'string'
            ? this.placements.get(placementOrId)
            : placementOrId;
        if (!hasAny3DModel(pl)) return;
        const title = buildComponent3DTitle(pl);
        openComponent3DFromData({ data: pl, title })
            .then((ok) => {
                if (!ok) console.warn('No renderable 3D model found for component');
            })
            .catch(err => console.error('Failed to open 3D pop-out:', err));
    }

    /**
     * Rotate a component by ±90° (dir: 'L' or 'R') via the history stack.
     * Used by the properties panel buttons and the Space keyboard shortcut.
     * @param {string} compId
     * @param {'L'|'R'} dir
     */
    _rotateComponent(compId, dir) {
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
    _flipComponent(compId, axis) {
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
            for (const compId of getPcbSelection(this, 'reftext')) this._refreshRefHighlight(compId);
        });
        if (!this.themeToggle) return;

        this.themeToggle.addEventListener('click', () => {
            const newTheme = toggleSharedTheme();
            syncThemeToggleButtons(['themeToggle', 'pcbThemeToggle'], newTheme);
        });
    }

    // ── Schematic → PCB sync ──────────────────────────────────────

    /**
     * Mark the PCB as needing a rebuild.  If the PCB pane is currently
     * active the rebuild is scheduled via a short debounce so rapid
     * schematic edits don't cause per-keystroke rebuilds.
     */
    onSchematicChanged() {
        this._cancelAutoRoute?.('Routing cancelled because the schematic changed.');
        this._stale = true;
        if (!this._active) return;

        // Debounce: rebuild after 300 ms of inactivity
        clearTimeout(this._syncTimer);
        this._syncTimer = setTimeout(() => this._syncFromSchematic(), 300);
    }

    /**
     * Rebuild the PCB content from the current schematic state.
     */
    _syncFromSchematic() {
        if (this._active === false) {
            this._stale = true;
            clearTimeout(this._syncTimer);
            return;
        }
        clearTimeout(this._syncTimer);

        const schematic = this.project?.schematicDocument;
        if (!schematic) {
            this._stale = true;
            return;
        }
        this._stale = false;

        this._ensureViewport();

        const { placements, netlist } = this.project.synchronizePcbLayout();
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
            this._board3d?.refresh?.();
            return;
        }

        // Ratsnest goes to its own layer group
        this._ratsnestGroup = this.getLayerGroup('ratlines');

        // Place footprints (elements distributed to correct layer groups)
        this._placeFootprints(placements);

        // Keep free-standing board shapes above freshly placed footprint
        // artwork after a schematic-driven rebuild.
        for (const s of this.boardShapes) {
            if (s.type === 'fill' || (this._boardOutlineDrawn && s.layer === 'board-outline')) continue;
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
        this._board3d?.refresh?.();
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
        const getGroup = (id) => this.getLayerGroup(id);

        // Board outline. Its model (width/height/radius) survives the rebuild
        // but its SVG is wiped by _clearPCBContent, so redraw it here.
        if (this._boardOutlineDrawn) {
            this._drawBoardOutline();
        }

        // Free-standing texts.
        this._textElements.clear();
        for (const t of this.texts.values()) {
            this._renderText(t);
        }

        // Tracks and vias.
        const routeParams = this.getRoutingParams?.();
        for (const t of this.tracks) {
            removeTrackElements(t);
            renderTrack(t, getGroup, {
                viaDiameter: routeParams?.viaDiameter,
                viaDrill: routeParams?.viaDrill,
                hideNetLabel: t === getSelectedTrack(this) || t === this._vertexDrag?.track,
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
                || (this._boardOutlineDrawn && s.layer === 'board-outline')) continue;
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
        this._drcRatlines = [];
        this._drcRatlinesModel = this.pcbDocument;
        // Clear children of layer groups (but keep the groups themselves)
        for (const [, g] of this._layerGroups) {
            while (g.firstChild) g.removeChild(g.firstChild);
        }
        // Drop any reference-text selection/overlay tied to the old placements.
        this._refDrag = null;
        if (this._refOverlay) {
            while (this._refOverlay.firstChild) this._refOverlay.removeChild(this._refOverlay.firstChild);
        }
        this._footprintGroup = null;
        this._ratsnestGroup = null;
        this.placements.clear();
        // Drop any copper-cut clip-paths; they are rebuilt as circles re-render.
        for (const side of ['top', 'bottom']) {
            this._svgDefs?.querySelector(`#pcb-copper-cut-${side}`)?.remove();
            this._layerGroups.get(`${side}-copper`)?.removeAttribute('clip-path');
            setCopperFillClip(this._layerGroups.get(`${side}-fill`), null);
        }
        // DOM is now in the cleared (no-cut) state; keep the path-string cache
        // in sync so the next updateCopperCuts re-applies cuts from scratch.
        this._copperCutCache = { top: null, bottom: null };
        this._hasCopperCuts = false;
    }

    /**
     * Render model-resolved footprints on the PCB canvas.
     * @param {Map} placements - Resolved physical placements and footprint geometry.
     */
    _placeFootprints(placements) {
        for (const [compId, resolved] of placements) {
            const { geometry: fpGeom, ...placement } = resolved;
            // Render SVG (returns Map<layerId, SVGGElement>)
            const fpLayers = this._renderFootprint(fpGeom, placement);

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
            if (pl.refSize !== REF_DEFAULT_SIZE || pl.refStrokeWidth !== REF_DEFAULT_STROKE) this._rerenderRef(compId);
        }
    }

    /** Render one resolved footprint's SVG layer groups (a seam for headless tests). */
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
     * Hide/show footprints based on whether they intersect the viewport, and
     * collapse on-screen footprints that are drawn very small to a single
     * placeholder rect. This keeps each SVG viewBox change from repainting the
     * tens of thousands of pad/silk/text nodes of a large board.
     */
    _updatePcbCulling() {
        if (!this.viewport || !this.placements.size) return;
        const vb = this.viewport.getVisibleBounds();
        const w = vb.maxX - vb.minX;
        const h = vb.maxY - vb.minY;
        const margin = Math.max(w, h) * 0.5; // 50% overdraw so nothing pops in
        const minX = vb.minX - margin, maxX = vb.maxX + margin;
        const minY = vb.minY - margin, maxY = vb.maxY + margin;
        const scale = this.viewport.scale;

        for (const [compId, pl] of this.placements) {
            const b = this._placementWorldBounds(pl);
            if (!b) continue;
            const inView = b.maxX >= minX && b.minX <= maxX &&
                           b.maxY >= minY && b.minY <= maxY;
            // Keep every selected footprint detailed so it stays editable.
            const px = Math.max(b.maxX - b.minX, b.maxY - b.minY) * scale;
            const far = inView && px < PCB_LOD_PIXEL_THRESHOLD
                && !isPcbSelected(this, 'component', compId);

            // Detail (real geometry) is visible only when in view AND not far.
            const detailHidden = !inView || far;
            if (detailHidden !== pl._culled) {
                pl._culled = detailHidden;
                for (const el of pl.elements) el.classList.toggle('culled', detailHidden);
            }
            // Placeholder is visible only when in view AND far.
            const lodShown = inView && far;
            if (lodShown === pl._lodFar) continue;
            pl._lodFar = lodShown;
            if (pl.lodEl) {
                if (lodShown) this._syncLodTransform(pl);
                pl.lodEl.classList.toggle('culled', !lodShown);
            }
        }
    }

    /**
     * Keep a placement's LOD placeholder rect aligned with the footprint's
     * current pose. Called when revealing it and whenever the footprint moves.
     * @param {object} pl
     */
    _syncLodTransform(pl) {
        if (!pl.lodEl) return;
        pl.lodEl.setAttribute('transform', placementTransform(pl));
    }

    /**
     * World-space AABB of a placement's footprint bounds (local courtyard/
     * outline rotated by the placement rotation and translated to position).
     * Cached and recomputed only when the placement's pose changes.
     * @param {object} pl
     * @returns {{minX:number,minY:number,maxX:number,maxY:number}|null}
     */
    _placementWorldBounds(pl) {
        const b = pl.bounds;
        if (!b) return null;
        const rot = pl.rotation || 0;
        const mx = isPlacementMirrored(pl) ? -1 : 1;
        const sig = `${pl.x}|${pl.y}|${rot}|${mx}`;
        if (pl._cullSig === sig && pl._cullBounds) return pl._cullBounds;
        const rad = rot * Math.PI / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        const corners = [
            [b.x, b.y],
            [b.x + b.width, b.y],
            [b.x, b.y + b.height],
            [b.x + b.width, b.y + b.height],
        ];
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [lx0, ly] of corners) {
            const lx = lx0 * mx;
            const wx = pl.x + lx * cos - ly * sin;
            const wy = pl.y + lx * sin + ly * cos;
            if (wx < minX) minX = wx;
            if (wx > maxX) maxX = wx;
            if (wy < minY) minY = wy;
            if (wy > maxY) maxY = wy;
        }
        pl._cullBounds = { minX, minY, maxX, maxY };
        pl._cullSig = sig;
        return pl._cullBounds;
    }

    /**
     * Force every footprint (and its placeholder) back to its detailed,
     * non-culled state. Used before measuring all artwork for fit-to-content,
     * since culled (display:none) groups report a zero bounding box. The next
     * view-change re-applies culling automatically.
     */
    _uncullAllPlacements() {
        for (const [, pl] of this.placements) {
            if (pl._culled) {
                pl._culled = false;
                for (const el of pl.elements) el.classList.remove('culled');
            }
            if (pl._lodFar) {
                pl._lodFar = false;
                if (pl.lodEl) pl.lodEl.classList.add('culled');
            }
        }
    }

    /**
     * Rebuild the ratsnest lines from the current netlist and placements.
     */
    updateRatsnest(opts) {
        // Net-based rebuild — draws guide lines between every disconnected
        // cluster of same-net copper (pads, tracks and vias alike). When
        // `opts.nets` is supplied (live footprint drag) only those nets are
        // recomputed; every other net's ratlines are left untouched.
        reconcileRatsnest(this, opts);
    }

    /**
     * Re-anchor the selected incomplete-connection marker's temporary ratline
     * to the live ratsnest geometry, so it follows whatever it connects to as
     * that copper is moved (just like a real ratline). Matches the marker to
     * the live ratline of the same net whose endpoints are nearest its current
     * ones, then redraws the marker.
     */
    _followDRCRatline() {
        return this._getDrcPresentation().followRatline();
    }

    /**
     * The set of net names a placement's pads belong to (from the netlist).
     * Used to scope the live ratsnest rebuild during a drag to just the nets
     * that actually move with the component.
     * @param {string} compId
     * @returns {Set<string>}
     */
    _netsForComponent(compId) {
        const nets = new Set();
        for (const entry of (this.netlist || [])) {
            if (!entry?.net) continue;
            for (const pin of (entry.pins || [])) {
                if (pin.componentId === compId) { nets.add(entry.net); break; }
            }
        }
        return nets;
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
    _screenToWorld(e) {
        // Use the viewport's cached rect rather than calling
        // getBoundingClientRect() directly. The hover code mutates the SVG
        // (halo polylines) every frame, which marks layout dirty; a fresh
        // getBoundingClientRect() would then force a synchronous reflow of
        // the whole board on each mousemove — cheap when zoomed out but
        // expensive when zoomed in, which is why hover lagged after zoom.
        // The SVG element's own rect only changes on resize (handled by the
        // 50 ms cache), not on pan/zoom or content edits.
        const rect = this.viewport._getCachedRect();
        return this.viewport.screenToWorld({
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
        });
    }

    /**
     * Hit-test: find which component contains a world position.
     * Tests against the footprint's courtyard/outline bounds (the same box
     * drawn as the selection highlight). Falls back to the pad bounding-box
     * extent for footprints without stored bounds. Returns the component ID
     * or null. Iterates in insertion order and keeps the last (topmost)
     * match so overlapping components resolve to the one drawn on top.
     * @param {{x: number, y: number}} worldPos
     * @param {boolean} [all=false] Return every hit in top-to-bottom order for overlap selection.
     * @returns {string|string[]|null}
     */
    _hitTestComponent(worldPos, all = false) {
        let hit = null;
        const hits = all ? [] : null;
        for (const [compId, pl] of this.placements) {
            const b = pl.bounds;
            if (b) {
                // `bounds` is in footprint-LOCAL coordinates; the rendered
                // halo/LOD rects apply the full placement transform
                // (translate → rotate → mirror). Map the cursor into the same
                // local frame by inverting that transform, then test the
                // axis-aligned local bounds rect — otherwise a rotated or
                // mirrored footprint's hit box wouldn't match its halo.
                const local = this._worldToPlacementLocal(worldPos, pl);
                if (
                    local.x >= b.x && local.x <= b.x + b.width
                    && local.y >= b.y && local.y <= b.y + b.height
                ) {
                    hit = compId;
                    hits?.push(compId);
                }
                continue;
            }
            // Fallback: no courtyard/outline — use the union of pad bounding
            // boxes plus a small margin so the body between pads is clickable.
            const MARGIN = 0.5; // mm
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const off of (pl.padOffsets || [])) {
                const pos = pl.pads.get(off.padId);
                if (!pos) continue;
                const w = (off.width || 1.2) / 2;
                const h = (off.height || 1.2) / 2;
                if (pos.x - w < minX) minX = pos.x - w;
                if (pos.y - h < minY) minY = pos.y - h;
                if (pos.x + w > maxX) maxX = pos.x + w;
                if (pos.y + h > maxY) maxY = pos.y + h;
            }
            if (
                minX !== Infinity
                && worldPos.x >= minX - MARGIN && worldPos.x <= maxX + MARGIN
                && worldPos.y >= minY - MARGIN && worldPos.y <= maxY + MARGIN
            ) {
                hit = compId;
                hits?.push(compId);
            }
        }
        return hits ? hits.reverse() : hit;
    }

    /**
     * Map a world-space point into a placement's local footprint frame,
     * inverting `placementTransform` (translate → rotate → mirror). Used so
     * hit-tests against footprint-local `bounds` match the rendered halo on
     * rotated/mirrored placements.
     * @param {{x:number,y:number}} worldPos
     * @param {object} pl - placement
     * @returns {{x:number,y:number}} point in footprint-local coordinates
     */
    _worldToPlacementLocal(worldPos, pl) {
        // Undo translate.
        let px = worldPos.x - pl.x;
        let py = worldPos.y - pl.y;
        // Undo rotation (inverse = rotate by -θ).
        const rot = pl.rotation || 0;
        if (rot) {
            const rad = rot * Math.PI / 180;
            const cos = Math.cos(rad), sin = Math.sin(rad);
            const rx = px * cos + py * sin;
            const ry = -px * sin + py * cos;
            px = rx; py = ry;
        }
        // Undo mirror (scale(-1,1) is its own inverse).
        if (isPlacementMirrored(pl)) px = -px;
        return { x: px, y: py };
    }

    /**
     * Hit-test: find a pad whose bounding box contains the world position.
     * Returns `{ type:'pad', componentId, pinNumber }` or null. Pad shape
     * is approximated by the bounding box from padOffsets.
     */
    /**
     * Schedule a select-tool hover update for the next animation frame.
     * Mousemove fires many times per frame; the hover hit-test is O(N) over
     * every pad/track/text, so running it per-event makes the highlight lag
     * the cursor on dense boards. We stash the latest pointer event and do a
     * single hit-test pass per frame against the current viewport.
     * @param {MouseEvent} e
     */
    _scheduleHoverUpdate(e) {
        // Keep the freshest pointer position; the rAF callback re-derives the
        // world coordinate so it always reflects the current pan/zoom.
        this._pendingHoverEvent = e;
        if (this._hoverRaf) return;
        this._hoverRaf = requestAnimationFrame(() => {
            this._hoverRaf = 0;
            const ev = this._pendingHoverEvent;
            this._pendingHoverEvent = null;
            // Bail if the tool changed or the tab went inactive between the
            // event and this frame.
            if (!ev || !this._active || this.currentTool !== 'select') return;
            const worldPos = this._screenToWorld(ev);
            this._hoverBoardOutline(this._hitTestBoardOutline(worldPos));
            // Hover highlight for tracks/vias.
            const trackHover = hitTestTrack(this, worldPos);
            // Read-only overlap count: skip the per-frame adapter-list rebuild
            // and reuse the last-synced entries (structural edits resync).
            const selectionHits = getPcbSelectionHits(this, worldPos, null, { sync: false });
            const componentHover = (selectionHits.find(hit => hit.kind === 'component' && isPcbSelected(this, hit.kind, hit.object))
                || selectionHits.find(hit => hit.kind === 'component'))?.object || null;
            this._hoverComponent(componentHover);
            const standalonePadHover = selectionHits.find(hit => hit.kind === 'pad')?.object || null;
            const shapeHover = hitTestBoardShape(this, worldPos);
            const copperShapeHover = shapeHover
                && (shapeHover.layer === 'top-copper' || shapeHover.layer === 'bottom-copper')
                && normalizeShapeCopperMode(shapeHover.copperMode) === 'add'
                ? shapeHover : null;
            const hovered = this._hitTestPad(worldPos) || trackHover
                || (standalonePadHover ? { type: 'standalone-pad', pad: standalonePadHover } : null)
                || (copperShapeHover ? { type: 'shape', shape: copperShapeHover } : null);
            setHoverHighlight(this, hovered);
            // Net-name tooltip for the hovered copper object.
            this._updateNetTooltip(ev, hovered);
            // Hover highlight for text annotations.
            const textHover = this._hitTestText(worldPos);
            this._setTextHover(textHover);
            // Hover highlight for free-standing board shapes.
            setBoardShapeHover(this, shapeHover);
            const overlapHitCount = selectionHits.length;
            if (overlapHitCount !== this._overlapHitCount) {
                this._overlapHitCount = overlapHitCount;
                this.setPcbStatus();
            }
            // Cursor feedback: a diagonal double-arrow (matching the
            // schematic editor's graph anchors) when the pointer is over a
            // draggable track node. Only toggle on transitions so we don't
            // clobber other cursors (e.g. a selected component's grab).
            const overNode = trackHover?.type === 'track'
                && !!hitTestTrackNode(this, trackHover.track, worldPos);
            const overMidpoint = !overNode
                && trackHover?.type === 'track'
                && trackHover.track === getSelectedTrack(this)
                && !!hitTestTrackMidpoint(this, trackHover.track, worldPos);
            const overCopper = !overNode && !overMidpoint
                && (trackHover?.type === 'track' || trackHover?.type === 'via');
            const overRef = !overNode && !overMidpoint
                && !!this._hitTestRefText(worldPos);
            const selectedAnchor = hitTestPcbSelectionAnchor(this, worldPos, ['shape', 'text']);
            const shapeIsSelected = !!shapeHover && isPcbSelected(this, 'shape', shapeHover);
            const copperIsSelected = (trackHover?.type === 'track' && isPcbSelected(this, 'track', trackHover.track))
                || (trackHover?.type === 'via' && isPcbSelected(this, 'via', trackHover.via));
            const hoverCursor = selectedAnchor?.anchor.symbol === 'rotate' ? 'grab'
                : overNode ? 'nwse-resize'
                : overMidpoint ? 'copy'
                : overCopper ? (copperIsSelected ? 'move' : 'pointer')
                : overRef ? 'move'
                : selectedAnchor ? (selectedAnchor.anchor.cursor || 'move')
                : shapeHover ? (shapeIsSelected ? 'move' : 'pointer')
                : textHover ? (isPcbSelected(this, 'text', textHover) ? 'move' : 'pointer')
                : standalonePadHover ? (isPcbSelected(this, 'pad', standalonePadHover) ? 'move' : 'pointer')
                : componentHover ? (isPcbSelected(this, 'component', componentHover) ? 'move' : 'pointer')
                : null;
            if (hoverCursor) {
                // Compare against the live inline value so we skip redundant
                // writes without a private cache that other cursor-setting
                // paths (drag 'grabbing', tool crosshair) could leave stale.
                if (this.viewport.svg.style.cursor !== hoverCursor) {
                    this.viewport.svg.style.cursor = hoverCursor;
                }
                this._hoverNodeCursor = true;
            } else if (this._hoverNodeCursor) {
                this._hoverNodeCursor = false;
                this._updateCursorForTool();
            }
        });
    }

    _hitTestPad(worldPos) {
        const topVisible = isLayerVisible('top-copper');
        const bottomVisible = isLayerVisible('bottom-copper');
        if (!topVisible && !bottomVisible) return null;
        for (const [componentId, pl] of this.placements) {
            if (!pl?.padOffsets) continue;
            // For 90°/270° placement rotations the pad's footprint-local
            // width/height are swapped in world space; account for that so the
            // hit region tracks the pad's actual on-screen extent.
            const ortho = Math.abs((pl.rotation || 0) % 180) === 90;
            for (const off of pl.padOffsets) {
                // Respect copper-layer visibility. Through-hole pads ('both')
                // are hover-hittable when either side is visible.
                const padLayer = String(off.layer || 'top');
                const onTop = padLayer === 'top' || padLayer === 'top-copper';
                const onBottom = padLayer === 'bottom' || padLayer === 'bottom-copper';
                const onBoth = padLayer === 'both';
                if (onTop && !topVisible) continue;
                if (onBottom && !bottomVisible) continue;
                if (onBoth && !topVisible && !bottomVisible) continue;
                const pos = pl.pads.get(off.padId);
                if (!pos) continue;
                const ow = off.width || 1.2;
                const oh = off.height || 1.2;
                const w = (ortho ? oh : ow) / 2;
                const h = (ortho ? ow : oh) / 2;
                if (
                    worldPos.x >= pos.x - w && worldPos.x <= pos.x + w
                    && worldPos.y >= pos.y - h && worldPos.y <= pos.y + h
                ) {
                    return { type: 'pad', componentId, pinNumber: off.number };
                }
            }
        }
        return null;
    }

    /**
     * Resolve the net name for a hovered pad/track/via hit, or '' if none.
     * @param {{type:string, track?:any, via?:any, componentId?:string, pinNumber?:string|number}|null} hovered
     * @returns {string}
     */
    _netNameForHover(hovered) {
        if (!hovered) return '';
        if (hovered.type === 'track') return hovered.track?.net || '';
        if (hovered.type === 'via') return hovered.via?.net || '';
        if (hovered.type === 'standalone-pad') return hovered.pad?.net || '';
        if (hovered.type === 'shape') return hovered.shape?.net || '';
        if (hovered.type === 'pad') {
            const key = `${hovered.componentId}|${hovered.pinNumber}`;
            for (const entry of (this.netlist || [])) {
                for (const pin of entry.pins) {
                    if (`${pin.componentId}|${pin.pinNumber}` === key) return entry.net || '';
                }
            }
        }
        return '';
    }

    /** Hide the net-name tooltip if it is showing. */
    _hideNetTooltip() {
        if (this._netTooltipTimer) {
            clearTimeout(this._netTooltipTimer);
            this._netTooltipTimer = 0;
        }
        if (this._netTooltip) this._netTooltip.style.display = 'none';
    }

    /**
     * Show/hide a small tooltip with the net name of the hovered element.
     * Appears for any hovered pad/track/via after a short delay.
     * @param {MouseEvent} e
     * @param {{type:string, track?:any, via?:any}|null} hovered
     */
    _updateNetTooltip(e, hovered) {
        if (!hovered) {
            this._hideNetTooltip();
            return;
        }
        const net = this._netNameForHover(hovered) || '(no net)';
        const x = e.clientX, y = e.clientY;
        // Restart the show timer on each move so it appears only after the
        // pointer settles briefly over the item.
        if (this._netTooltipTimer) clearTimeout(this._netTooltipTimer);
        this._netTooltipTimer = setTimeout(() => {
            this._netTooltipTimer = 0;
            if (!this._netTooltip) {
                const el = document.createElement('div');
                el.style.cssText = 'position:fixed;z-index:10000;pointer-events:none;'
                    + 'padding:2px 6px;border-radius:3px;font:11px/1.4 monospace;'
                    + 'background:rgba(20,20,28,0.92);color:#9fd0ff;'
                    + 'border:1px solid rgba(120,160,220,0.5);white-space:nowrap;';
                document.body.appendChild(el);
                this._netTooltip = el;
            }
            const el = this._netTooltip;
            el.textContent = net;
            el.style.display = 'block';
            const pad = 14;
            const maxX = window.innerWidth - el.offsetWidth - pad;
            const maxY = window.innerHeight - el.offsetHeight - pad;
            el.style.left = `${Math.min(x + pad, Math.max(pad, maxX))}px`;
            el.style.top = `${Math.min(y + pad, Math.max(pad, maxY))}px`;
        }, 400);
    }

    /**
     * Restore saved placement models, then replace only their footprint artwork.
     * Used when overrides are loaded after footprints were already rendered.
     */
    _applyPlacementOverrides() {
        const placements = this.project.restorePcbPlacementOverrides(this.placements.keys());
        for (const compId of placements.keys()) {
            const pl = this.placements.get(compId);
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
        this._markDirty();
    }

    /**
     * Select a component (or deselect if null).
     * Adds/removes a highlight outline on all layer groups for that component.
     * @param {string|null} compId
     */
    _selectComponent(compId) {
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
            this.viewport.svg.style.cursor = 'default';
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

        this.viewport.svg.style.cursor = pl.locked ? 'default' : 'grab';
        // Ensure the selected footprint shows full detail even when zoomed out
        // far enough that it would otherwise be collapsed to its LOD placeholder.
        this._updatePcbCulling();
    }

    _beginComponentDrag(compId, worldPos) {
        const pl = this.placements.get(compId);
        if (!pl || pl.locked) return false;
        // Clear the hover net-highlight before dragging: hover updates are
        // suppressed while a drag is active, so a leftover halo would otherwise
        // sit at the component's original position the whole drag.
        setHoverHighlight(this, null);
        this._hoverComponent(null);
        this._hideNetTooltip();
        this._drag = {
            compId,
            startWorld: worldPos,
            startPos: { x: pl.x, y: pl.y },
            // Only these nets move, so the live ratsnest rebuild is restricted
            // to them instead of recomputing the whole board each frame.
            nets: this._netsForComponent(compId),
        };
        // Copper pours and clearance halos are rebuilt once in _endDrag.
        setDragOverlaysDeferred(this, true);
        if (this._clearancesVisible) {
            // Hide only the dragged component's pad halos and the halos of the
            // nets it moves (their bonded tracks shift mid-drag); every other
            // halo stays visible for judging clearances while placing.
            const group = this._padHaloGroups?.get(compId);
            if (group) group.style.display = 'none';
            const overlay = this._layerGroups.get('clearance-overlay');
            if (overlay) {
                for (const net of this._drag.nets) {
                    for (const element of overlay.querySelectorAll(`.debug-clearance[data-net="${CSS.escape(net)}"]`)) {
                        /** @type {SVGElement} */ (element).style.display = 'none';
                    }
                }
                // Promote the now-static overlay to its own compositing layer so
                // per-frame board mutations don't repaint thousands of halo vectors.
                overlay.style.willChange = 'transform';
            }
        }
        return true;
    }

    _updateComponentDrag(worldPos) {
        if (!this._drag) return;
        const newX = this._drag.startPos.x + worldPos.x - this._drag.startWorld.x;
        const newY = this._drag.startPos.y + worldPos.y - this._drag.startWorld.y;
        const pl = this.placements.get(this._drag.compId);
        if (!pl || pl.locked) return;
        const snap = this._snapToGrid({ x: newX, y: newY });
        if (pl.x === snap.x && pl.y === snap.y) return;
        previewPlacementPose(this, this._drag.compId, { x: snap.x, y: snap.y });
        this.updateRatsnest({ nets: this._drag.nets });
    }

    /**
     * Hover highlight for a component under the select-tool cursor: a faint
     * dashed outline over the footprint's bounds, matching the selection box
     * but lighter. Skipped for the currently selected component (its solid
     * highlight already shows). Pass null to clear. The rect is appended to
     * the footprint's first layer group so it inherits the placement
     * transform (bounds are in footprint-local coords).
     * @param {string|null} compId
     */
    _hoverComponent(compId) {
        if (compId === getPcbSelection(this, 'component')[0]) compId = null;
        if (this._hoveredComp === compId) return;
        if (this._hoveredComp) {
            const oldPl = this.placements.get(this._hoveredComp);
            oldPl?.elements?.[0]?.querySelector('.pcb-hover-highlight')?.remove();
        }
        this._hoveredComp = compId || null;
        if (!compId) return;
        const pl = this.placements.get(compId);
        const b = pl?.bounds;
        if (!pl?.elements?.length || !b) { this._hoveredComp = null; return; }
        const NS = 'http://www.w3.org/2000/svg';
        const hl = document.createElementNS(NS, 'rect');
        hl.setAttribute('class', 'pcb-hover-highlight');
        hl.setAttribute('x', String(b.x));
        hl.setAttribute('y', String(b.y));
        hl.setAttribute('width', String(b.width));
        hl.setAttribute('height', String(b.height));
        hl.setAttribute('fill', 'rgba(51,153,255,0.07)');
        hl.setAttribute('stroke', '#3399ff');
        hl.setAttribute('stroke-width', '0.1');
        hl.setAttribute('stroke-dasharray', '0.5 0.35');
        hl.setAttribute('pointer-events', 'none');
        pl.elements[0].appendChild(hl);
    }

    /**
     * Show a short-lived message bubble centred over a component, then fade
     * it away. Used for actions that aren't allowed on the PCB (e.g. trying
     * to delete a component, which must be done in the schematic editor).
     * @param {string} compId
     * @param {string} message
     */
    _showComponentPopup(compId, message) {
        const pl = this.placements.get(compId);
        if (!pl || !this.viewport) return;

        // Centre of the footprint in world coords (bounds are in the
        // footprint's local space, offset by the placement translate).
        const b = pl.bounds;
        const cx = pl.x + (b ? b.x + b.width / 2 : 0);
        const cy = pl.y + (b ? b.y + b.height / 2 : 0);

        const screen = this.viewport.worldToScreen({ x: cx, y: cy });
        const svgRect = this.viewport.svg.getBoundingClientRect();

        // Remove any existing popup so rapid presses don't stack.
        this._componentPopup?.remove();

        const popup = document.createElement('div');
        popup.className = 'pcb-component-popup';
        popup.textContent = message;
        popup.style.left = `${svgRect.left + screen.x}px`;
        popup.style.top = `${svgRect.top + screen.y}px`;
        document.body.appendChild(popup);
        this._componentPopup = popup;

        requestAnimationFrame(() => popup.classList.add('show'));
        window.setTimeout(() => {
            popup.classList.remove('show');
            window.setTimeout(() => {
                popup.remove();
                if (this._componentPopup === popup) this._componentPopup = null;
            }, 250);
        }, 1400);
    }

    /**
     * Coalesce footprint-drag updates to one per animation frame.
     *
     * Stash the latest pointer event so pose, bonded-track and incremental
     * ratsnest updates run at most once per frame on this pointer path.
     * @param {MouseEvent} e
     */
    _scheduleDragUpdate(e) {
        this._pendingDragEvent = e;
        if (this._dragRaf) return;
        this._dragRaf = requestAnimationFrame(() => {
            this._dragRaf = 0;
            const ev = this._pendingDragEvent;
            this._pendingDragEvent = null;
            if (!ev || !this._active || !this._drag) return;
            this._handleDrag(ev);
        });
    }

    /**
     * Handle drag movement.
     * @param {MouseEvent} e
     */
    _handleDrag(e) {
        if (!this._drag) return;

        // Keep Shift-to-reverse-snap current from the live event (trackMouse
        // only runs after this handler, so reading it here would lag a frame).
        this.viewport.shiftHeld = e.shiftKey;

        this._updateComponentDrag(this._screenToWorld(e));
    }

    /**
     * Commit or cancel a component drag and restore derived overlays.
     */
    _endDrag(commit = true) {
        if (!this._drag) return;
        // Flush any pointer move coalesced by _scheduleDragUpdate so the final
        // resting position reflects the very last mouse position, not the one
        // from the previous animation frame.
        if (this._dragRaf) {
            cancelAnimationFrame(this._dragRaf);
            this._dragRaf = 0;
        }
        const pending = this._pendingDragEvent;
        this._pendingDragEvent = null;
        if (commit && pending) this._handleDrag(pending);
        const { compId, startPos } = this._drag;
        const pl = this.placements.get(compId);
        this._drag = null;
        // Restore overlays before the placement command refreshes clearance.
        setDragOverlaysDeferred(this, false);
        // Drop the GPU-layer promotion applied during the drag so the overlay
        // returns to normal painting (avoids holding a compositing layer).
        if (this._clearancesVisible) {
            const ov = this._layerGroups.get('clearance-overlay');
            if (ov) ov.style.willChange = '';
        }
        this.viewport.svg.style.cursor = getPcbSelection(this, 'component').length ? 'grab' : 'default';
        if (commit && pl && (pl.x !== startPos.x || pl.y !== startPos.y)) {
            finishPlacementPreview(this, () => {
                const cmd = new MovePlacementCommand(this, compId, startPos.x, startPos.y, pl.x, pl.y);
                this.history.execute(cmd);
            });
        } else {
            finishPlacementPreview(this);
            this.refreshClearanceHalos();
            this.updateRatsnest();
        }
    }

    _cancelPosePreviews() {
        cancelPcbPosePreviews(this);
    }

    // ── Text annotations ─────────────────────────────────────────

    /**
     * Whether grid snap currently applies, honouring Shift-to-reverse the
     * snap setting while the grid is visible — matching the schematic
     * editor's `Viewport.getSnappedPosition`.
     * @returns {boolean}
     */
    _snapActive() {
        let snap = !!this.viewport?.snapToGrid;
        if (this.viewport?.shiftHeld && this.viewport?.gridVisible) snap = !snap;
        return snap;
    }

    /** Attract nearby coordinates to displayed grid lines, leaving the rest free. */
    _snapToGrid(p) {
        return snapToViewportGrid(p, this.viewport);
    }

    _snapPadPlacement(point) {
        return this.viewport?.getSnappedPosition?.(point) || { x: point.x, y: point.y };
    }

    /**
     * Render `text` into its layer group, replacing any prior element
     * with the same id. Stores the new element in _textElements.
     */
    _renderText(text) {
        this._removeTextElement(text.id);
        const layerG = this.getLayerGroup(text.layer);
        if (!layerG) return;
        const isSel = isPcbSelected(this, 'text', text);
        const isHover = !isSel && this._hoveredText?.id === text.id;
        // While inline-editing, render the text in white so it doesn't
        // disappear against same-coloured tracks/pads on the layer.
        const isEditing = this._textEdit?.text?.id === text.id;
        const isLight = document.documentElement.getAttribute('data-theme') === 'light';
        const selColor = pcbLayerSelectionColor(text.layer);
        const hoverColor = pcbLayerHoverColor(text.layer);
        const editColor = isLight ? '#000000' : '#ffffff';
        const strokeOverride = isEditing ? editColor
            : isSel ? selColor
            : isHover ? hoverColor
            : undefined;
        const el = renderPcbText(text, strokeOverride);
        layerG.appendChild(el);
        this._textElements.set(text.id, el);
        this._refreshBoardShapeClearance(text);
        if (isSel) renderPcbSelectionAnchors(this);
        // If this text is being inline-edited, keep the editing
        // box/caret transform in sync with any property changes
        // (rotation, size, layer mirror) that just re-rendered it.
        if (isEditing) this._textEdit?.updateCaret?.();
    }

    /** Remove the SVG element for a text id (model untouched). */
    _removeTextElement(id) {
        const el = this._textElements.get(id);
        if (el?.parentNode) el.parentNode.removeChild(el);
        this._textElements.delete(id);
    }

    /** Set/clear hover highlight for text annotations. */
    _setTextHover(text) {
        const prev = this._hoveredText || null;
        const next = text || null;
        if (prev === next || (prev && next && prev.id === next.id)) return;
        this._hoveredText = next;
        if (prev && (!next || prev.id !== next.id)) this.refreshText(prev.id);
        if (next) this.refreshText(next.id);
    }

    /** Re-render an existing text in place (e.g. after a property change). */
    refreshText(id) {
        const t = this.texts.get(id);
        if (!t) return;
        this._renderText(t);
        this.refreshSelectedDRCMarker?.();
    }

    /**
     * Hit-test the given world point against every text. Returns the
     * topmost (last-added) hit, or null.
     */
    _hitTestText(worldPos) {
        let hit = null;
        for (const t of this.texts.values()) {
            if (isLayerLocked(t.layer) || !isLayerVisible(t.layer)) continue;
            if (pcbTextHitTest(t, worldPos.x, worldPos.y)) hit = t;
        }
        return hit;
    }

    /** Select/deselect a text. Pass null to clear. */
    _selectText(text) {
        const prev = getPcbSelection(this, 'text')[0] || null;
        const next = text || null;
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

    _beginTextDrag(text, worldPos) {
        getPropertyEditor(this, 'text')?.commit();
        text = text && this.pcbDocument.texts.get(text.id);
        if (!text || !this.texts.has(text.id) || isLayerLocked(text.layer) || !isLayerVisible(text.layer)) return false;
        this._textDrag = {
            textId: text.id,
            startWorld: worldPos,
            startPos: { x: text.x, y: text.y },
            previousDeferDragOverlays: !!areDragOverlaysDeferred(this),
        };
        setDragOverlaysDeferred(this, true);
        this.viewport?.setCrosshair({ x: text.x, y: text.y });
        return true;
    }

    _updateTextDrag(worldPos) {
        if (!this._textDrag) return;
        const text = this.texts.get(this._textDrag.textId);
        if (!text || isLayerLocked(text.layer) || !isLayerVisible(text.layer)) return;
        const snap = this._snapToGrid({
            x: this._textDrag.startPos.x + worldPos.x - this._textDrag.startWorld.x,
            y: this._textDrag.startPos.y + worldPos.y - this._textDrag.startWorld.y,
        });
        if (text.x === snap.x && text.y === snap.y) return;
        previewTextPose(this, text.id, snap);
        this.viewport?.setCrosshair({ x: snap.x, y: snap.y });
        this.refreshText(text.id);
    }

    /** Drag an already-selected text. */
    _handleTextDrag(e) {
        if (!this._textDrag) return;
        this.viewport.shiftHeld = e.shiftKey;
        this._updateTextDrag(this._screenToWorld(e));
    }

    /** End a text drag, pushing a MoveTextCommand if it actually moved. */
    _endTextDrag(commit = true) {
        if (!this._textDrag) return;
        const { textId, startPos, previousDeferDragOverlays } = this._textDrag;
        this._textDrag = null;
        setDragOverlaysDeferred(this, previousDeferDragOverlays);
        this.viewport?.hideCrosshair();
        this.viewport.svg.style.cursor = 'default';
        const t = this.texts.get(textId);
        finishTextPosePreview(this, t && commit && !isLayerLocked(t.layer) && isLayerVisible(t.layer)
            && (t.x !== startPos.x || t.y !== startPos.y)
            ? () => this.history.execute(new MoveTextCommand(this, textId, startPos.x, startPos.y, t.x, t.y))
            : undefined);
    }

    // ── Reference-designator move / rotate ────────────────────
    // A component's reference (e.g. "R3") is rendered as part of its
    // footprint but can be repositioned and rotated relative to the body,
    // mirroring the schematic editor. The label text itself comes from the
    // schematic; reference edits update that source through its property command.

    _tryEditReferenceAt(worldPos) {
        if (this._hitTestText(worldPos)) return false;
        const compId = this._hitTestRefText(worldPos);
        const pl = this.placements.get(compId);
        const component = this.project?.getComponentInfo(compId);
        const layer = pl?.side === 'bottom' ? 'bottom-silk' : 'top-silk';
        if (!pl || pl.locked || !component || component.locked || isLayerLocked(layer) || !isLayerVisible(layer)) return false;
        const original = component.reference;
        const text = {
            content: original,
            size: pl.refSize || REF_DEFAULT_SIZE,
            strokeWidth: pl.refStrokeWidth || REF_DEFAULT_STROKE,
            layer,
        };
        const baseX = () => this._refBox(pl).cx - measureStrokeText(text.content, text.size) / 2;
        const render = () => {
            pl.reference = text.content;
            this._rerenderRef(compId);
            this._drawRefOverlay(compId, false);
        };
        this._startTextInlineEdit(text, worldPos, {
            componentId: compId,
            select: () => {
                this._selectRefText(compId);
                this._showRefProperties(compId);
            },
            prepare: () => {
                text.size = pl.refSize || REF_DEFAULT_SIZE;
                text.strokeWidth = pl.refStrokeWidth || REF_DEFAULT_STROKE;
            },
            transform: () => `${placementTransform(pl)} ${pl._refEl.getAttribute('transform') || ''}`
                + ` translate(${baseX()},${pl._refEl.getAttribute('data-ref-anchor-y')})`,
            localX: point => {
                const svg = this.viewport.svg;
                const cursor = svg.createSVGPoint();
                cursor.x = point.x;
                cursor.y = point.y;
                const local = cursor.matrixTransform(pl._refEl.getCTM().inverse().multiply(svg.getCTM()));
                return local.x - baseX();
            },
            render,
            validate: value => {
                const issue = this.project.validateComponentReference(compId, value);
                if (issue) {
                    showAlert(issue.message, { title: issue.title });
                    return false;
                }
                return true;
            },
            finish: (value, commit) => {
                const reference = value.trim();
                if (commit && reference !== original) {
                    const command = this.project.createReferenceRenameCommand(compId, reference);
                    const apply = redo => {
                        if (redo) command.execute();
                        else command.undo();
                        const current = this.project.getComponentInfo(compId);
                        const placement = this.placements.get(compId);
                        if (placement && current) {
                            placement.reference = current.reference;
                            this._rerenderRef(compId);
                            this._drawRefOverlay(compId, false);
                            this._showRefProperties(compId);
                        }
                        this.netlist = this.project.getNetlist();
                        this.updateRatsnest();
                        this._board3d?.refresh?.();
                    };
                    this.history.execute({
                        description: `Rename ${original} to ${reference}`,
                        execute: () => apply(true),
                        undo: () => apply(false),
                    });
                } else {
                    text.content = original;
                    render();
                    this._showRefProperties(compId);
                }
            },
        });
        return true;
    }

    /**
     * Resolve a placement's reference-text element and its footprint-local
     * bounding box (cached on the placement). Returns null when the footprint
     * has no reference group. The box `{bx,by,bw,bh,cx,cy}` is authored-local,
     * the same frame as `_worldToPlacementLocal` output and the pad offsets.
     * @param {object} pl - placement
     */
    _refBox(pl) {
        if (!pl) return null;
        if (pl._refBox && pl._refEl?.isConnected) return pl._refBox;
        let el = null;
        for (const layer of (pl.elements || [])) {
            el = layer.querySelector?.('[data-fp-ref]');
            if (el) break;
        }
        if (!el) return null;
        const bx = parseFloat(el.getAttribute('data-ref-bx'));
        const by = parseFloat(el.getAttribute('data-ref-by'));
        const bw = parseFloat(el.getAttribute('data-ref-bw'));
        const bh = parseFloat(el.getAttribute('data-ref-bh'));
        const cx = parseFloat(el.getAttribute('data-mx-center'));
        const cy = parseFloat(el.getAttribute('data-ref-cy'));
        if (![bx, by, bw, bh, cx, cy].every(Number.isFinite)) return null;
        pl._refEl = el;
        pl._refBox = { bx, by, bw, bh, cx, cy };
        return pl._refBox;
    }

    /**
     * Regenerate a reference designator's glyph geometry after its size or
     * line width changed, refresh the cached layout box, and re-apply the
     * SVG pose so the new geometry picks up the current offset/rotation
     * and mirror state.
     * @param {string} compId
     */
    _rerenderRef(compId) {
        const pl = this.placements.get(compId);
        if (!pl) return;
        this._refBox(pl); // resolve & cache pl._refEl
        const el = pl._refEl;
        if (!el) return;
        const cxRef = parseFloat(el.getAttribute('data-mx-center'));
        const baseY = parseFloat(el.getAttribute('data-ref-anchor-y'));
        if (!Number.isFinite(cxRef) || !Number.isFinite(baseY)) return;
        if (applyRefGeometry(el, pl.reference, cxRef, baseY,
            pl.refSize || REF_DEFAULT_SIZE, pl.refStrokeWidth || REF_DEFAULT_STROKE)) {
            pl._refBox = null;
        }
        renderPlacementPose(this, compId);
        this._refreshRefHighlight(compId);
        if (this._textEdit?.options?.componentId === compId) this._textEdit.updateCaret?.();
    }

    _refreshRefHighlight(compId) {
        const pl = this.placements.get(compId);
        if (!pl || !this._refBox(pl)) return;
        const active = isPcbSelected(this, 'reftext', compId)
            || this._textEdit?.options?.componentId === compId;
        const isLight = document.documentElement.getAttribute('data-theme') === 'light';
        pl._refEl.setAttribute('stroke', active ? (isLight ? '#000000' : '#ffffff')
            : textColorForLayer(pl.side === 'bottom' ? 'bottom-silk' : 'top-silk'));
    }

    /**
     * Forward transform of an authored-local footprint point to world space,
     * the inverse of {@link _worldToPlacementLocal}: mirror → rotate → translate.
     * @param {object} pl - placement
     * @param {number} lx
     * @param {number} ly
     * @returns {{x:number,y:number}}
     */
    _placementLocalToWorld(pl, lx, ly) {
        let px = isPlacementMirrored(pl) ? -lx : lx;
        let py = ly;
        const rot = pl.rotation || 0;
        if (rot) {
            const rad = rot * Math.PI / 180;
            const cos = Math.cos(rad), sin = Math.sin(rad);
            const rx = px * cos - py * sin;
            const ry = px * sin + py * cos;
            px = rx; py = ry;
        }
        return { x: px + pl.x, y: py + pl.y };
    }

    /**
     * World-space centre of a placement's reference designator, accounting
     * for the ref offset (rotation about the centre leaves the centre fixed).
     * @param {object} pl - placement
     * @param {{bx:number,by:number,bw:number,bh:number,cx:number,cy:number}} box
     */
    _refCenterWorld(pl, box) {
        return this._placementLocalToWorld(pl, box.cx + (pl.refDx || 0), box.cy + (pl.refDy || 0));
    }

    /**
     * World-space corners of the reference's inline-edit rectangle.
     * Keep these metrics identical to _startTextInlineEdit.updateCaret().
     */
    _refEditBoxWorldCorners(pl, box) {
        const size = pl.refSize || REF_DEFAULT_SIZE;
        const width = measureStrokeText(pl.reference || '', size);
        const baseX = box.cx - width / 2;
        const baseY = parseFloat(pl._refEl?.getAttribute('data-ref-anchor-y'));
        if (!Number.isFinite(baseY)) return null;

        const padX = size * 0.15;
        const padTop = size * 0.25;
        const padBot = size * 1.0;
        const referenceAngle = (pl.refRot || 0) * Math.PI / 180;
        const cosine = Math.cos(referenceAngle), sine = Math.sin(referenceAngle);
        return [
            [baseX - padX, baseY - size - padTop],
            [baseX + width + padX, baseY - size - padTop],
            [baseX + width + padX, baseY + padBot],
            [baseX - padX, baseY + padBot],
        ].map(([x, y]) => {
            const deltaX = x - box.cx, deltaY = y - box.cy;
            let localX = box.cx + deltaX * cosine - deltaY * sine;
            const localY = box.cy + deltaX * sine + deltaY * cosine;
            if (pl.mirror) localX = 2 * box.cx - localX;
            return this._placementLocalToWorld(
                pl,
                localX + (pl.refDx || 0),
                localY + (pl.refDy || 0),
            );
        });
    }

    /**
     * Hit-test the reference designator of every visible placement. Returns
     * the topmost component id whose ref box contains the world point, or null.
     * @param {{x:number,y:number}} worldPos
     * @returns {string|null}
     */
    _hitTestRefText(worldPos) {
        const MARGIN = REF_BOX_PAD; // mm — match the drawn selection box
        let hit = null;
        for (const [compId, pl] of this.placements) {
            if (pl.refVisible === false) continue;
            if (!isLayerVisible(pl.side === 'bottom' ? 'bottom-silk' : 'top-silk')) continue;
            const box = this._refBox(pl);
            if (!box) continue;
            // Undo placement, reference offset, user counter-mirror, then reference rotation.
            const local = this._worldToPlacementLocal(worldPos, pl);
            let ax = local.x - (pl.refDx || 0);
            let ay = local.y - (pl.refDy || 0);
            if (pl.mirror) ax = 2 * box.cx - ax;
            const rr = pl.refRot || 0;
            if (rr) {
                const rad = -rr * Math.PI / 180;
                const cos = Math.cos(rad), sin = Math.sin(rad);
                const ox = ax - box.cx, oy = ay - box.cy;
                ax = box.cx + ox * cos - oy * sin;
                ay = box.cy + ox * sin + oy * cos;
            }
            if (
                ax >= box.bx - MARGIN && ax <= box.bx + box.bw + MARGIN
                && ay >= box.by - MARGIN && ay <= box.by + box.bh + MARGIN
            ) {
                hit = compId;
            }
        }
        return hit;
    }

    /** Select/deselect a component's reference text. Pass null to clear. */
    _selectRefText(compId) {
        const prev = getPcbSelection(this, 'reftext')[0] || null;
        const next = compId || null;
        if (prev === next) {
            if (next) this._drawRefOverlay(next, false);
            return;
        }
        setPcbSelection(this, next ? [{ kind: 'reftext', object: next }] : []);
        this.syncClipboardButtons?.();
        this._drawRefOverlay(next, false);
    }

    _beginRefTextDrag(compId, worldPos) {
        getPropertyEditor(this, 'component')?.commit();
        const pl = this.placements.get(compId);
        if (!pl || isRefTextLocked(pl)) return false;
        this._refDrag = {
            compId,
            startWorld: worldPos,
            startDx: pl.refDx || 0,
            startDy: pl.refDy || 0,
        };
        this._drawRefOverlay(compId, true);
        return true;
    }

    _updateRefTextDrag(worldPos) {
        if (!this._refDrag) return;
        const pl = this.placements.get(this._refDrag.compId);
        if (!pl || isRefTextLocked(pl)) return;
        const localNow = this._worldToPlacementLocal(worldPos, pl);
        const localStart = this._worldToPlacementLocal(this._refDrag.startWorld, pl);
        const snap = this._snapToGrid({
            x: this._refDrag.startDx + localNow.x - localStart.x,
            y: this._refDrag.startDy + localNow.y - localStart.y,
        });
        if ((pl.refDx || 0) === snap.x && (pl.refDy || 0) === snap.y) return;
        pl.refDx = snap.x;
        pl.refDy = snap.y;
        renderPlacementPose(this, this._refDrag.compId);
        this._drawRefOverlay(this._refDrag.compId, true);
    }

    /** Lazily create the world-space overlay group for the ref selection/tether. */
    _ensureRefOverlay() {
        if (!this._refOverlay || !this._refOverlay.isConnected) {
            const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            g.setAttribute('class', 'pcb-ref-overlay');
            g.setAttribute('pointer-events', 'none');
            this.viewport.addContent(g);
            this._refOverlay = g;
        }
        return this._refOverlay;
    }

    /**
    * Draw (or clear) the component outline associated with a reference and
    * optionally its dotted connection line. Passing a null/invalid compId
    * clears the overlay.
     * @param {string|null} compId
     * @param {boolean} withTether
     */
    _drawRefOverlay(compId, withTether) {
        const g = this._ensureRefOverlay();
        while (g.firstChild) g.removeChild(g.firstChild);
        if (!compId) return;
        const pl = this.placements.get(compId);
        if (!pl) return;
        const box = this._refBox(pl);
        if (!box) return;
        this._refreshRefHighlight(compId);
        const NS = 'http://www.w3.org/2000/svg';
        if (pl.bounds) {
            const outline = document.createElementNS(NS, 'rect');
            outline.setAttribute('class', 'pcb-ref-component-outline');
            outline.setAttribute('x', String(pl.bounds.x));
            outline.setAttribute('y', String(pl.bounds.y));
            outline.setAttribute('width', String(pl.bounds.width));
            outline.setAttribute('height', String(pl.bounds.height));
            outline.setAttribute('transform', placementTransform(pl));
            outline.setAttribute('fill', 'none');
            outline.setAttribute('stroke', '#3399ff');
            outline.setAttribute('stroke-width', '1.2');
            outline.setAttribute('vector-effect', 'non-scaling-stroke');
            outline.setAttribute('pointer-events', 'none');
            g.appendChild(outline);
        }
        if (withTether || isPcbSelected(this, 'reftext', compId) || this._refDrag?.compId === compId
            || this._textEdit?.options?.componentId === compId) {
            const bounds = pl.bounds;
            if (!bounds || bounds.width <= 0 || bounds.height <= 0) return;
            const textBox = this._refEditBoxWorldCorners(pl, box);
            if (!textBox) return;
            const componentBox = [
                [bounds.x, bounds.y], [bounds.x + bounds.width, bounds.y],
                [bounds.x + bounds.width, bounds.y + bounds.height], [bounds.x, bounds.y + bounds.height],
            ].map(([x, y]) => this._placementLocalToWorld(pl, x, y));
            const connection = connectBoxOutlines(componentBox, textBox);
            if (!connection) return;
            const line = document.createElementNS(NS, 'line');
            applyTextConnectionGuide(line, connection, '#3399ff');
            g.appendChild(line);
        }
    }

    /** Drag an already-selected reference designator. */
    _handleRefDrag(e) {
        if (!this._refDrag) return;
        this.viewport.shiftHeld = e.shiftKey;
        this._updateRefTextDrag(this._screenToWorld(e));
    }

    /** Commit reference offsets through history, or restore the preview on cancel. */
    _endRefDrag(commit = true) {
        if (!this._refDrag) return;
        const { compId, startDx, startDy } = this._refDrag;
        this._refDrag = null;
        const pl = this.placements.get(compId);
        this.viewport.svg.style.cursor = 'default';
        if (!pl) { this._drawRefOverlay(null, false); return; }
        if ((pl.refDx || 0) === startDx && (pl.refDy || 0) === startDy) {
            this._drawRefOverlay(compId, false);
            return;
        }
        if (commit && !isRefTextLocked(pl)) {
            this.history.execute(new MoveRefTextCommand(this, compId, startDx, startDy, pl.refDx || 0, pl.refDy || 0));
        } else {
            pl.refDx = startDx; pl.refDy = startDy;
            renderPlacementPose(this, compId);
            this._drawRefOverlay(compId, false);
        }
    }

    /** Rotate the selected reference designator by 90° (through history). */
    _rotateRefText(compId) {
        getPropertyEditor(this, 'component')?.commit();
        const pl = this.placements.get(compId);
        if (!pl || isRefTextLocked(pl)) return;
        const cur = ((pl.refRot || 0) % 360 + 360) % 360;
        const next = (cur + 90) % 360;
        this.history.execute(new RotateRefTextCommand(this, compId, cur, next));
        this._drawRefOverlay(compId, false);
        if (isPcbSelected(this, 'reftext', compId)) this._showRefProperties(compId);
    }

    /** Show Text drawing defaults in Properties. */
    _showTextToolProperties() {
        showTextToolProperties(this, this._textDefaults);
    }

    layerLabel(layer) {
        switch (layer) {
            case 'top-silk':      return 'Top Silk';
            case 'bottom-silk':   return 'Bottom Silk';
            case 'top-copper':    return 'Top Copper';
            case 'bottom-copper': return 'Bottom Copper';
            case 'top-document':  return 'Top Document';
            case 'bottom-document': return 'Bottom Document';
            default:              return layer;
        }
    }

    _escapeAttr(s) {
        return String(s ?? '').replace(/[&"<>]/g, c => ({ '&':'&amp;', '"':'&quot;', '<':'&lt;', '>':'&gt;' }[c]));
    }

    /**
     * Show properties for the given text and switch to Properties tab.
     * Editing pushes EditTextCommand on `change` (not per keystroke) so
     * undo collapses each edit into one entry.
     */
    _showTextProperties(text) {
        showTextProperties(this, text, () => this._textEdit);
    }

    /**
     * Shared field-binding machinery for the stroke-text style panels (Text
     * objects and reference designators). For each spec field it wires the
     * input/change events so edits update the selected preview (via spec.preview)
     * and collapse into a single undo entry on commit (via spec.commit). A
     * snapshot of the model is taken on the first keystroke so spec.commit
     * can diff against the pre-edit state.
     * @param {Element} items container holding the inputs
     * @param {any} model object whose fields the inputs drive
     * @param {{fields: Array<{id:string, field:string, parse:(v:string)=>any, apply?:(m:any,v:any)=>void, value?:(m:any)=>any, wrap?:boolean}>, editable?:()=>boolean, begin?:(m:any)=>any, cancel?:(snap:any)=>void, preview:(m:any)=>void, commit:(m:any, snap:any)=>void}} spec
     */
    _bindStrokeTextProps(items, model, spec) {
        return bindStrokeTextProps(this, items, model, spec);
    }

    /**
     * Show the properties panel for a selected reference designator. Mirrors
     * the Text-object panel (Type/Layer/Size/Rotation/Line W) and reuses the
     * same field-binding helper, but the Reference string and Layer are
     * read-only — only Size, Rotation and Line W can be edited.
     * @param {string} compId
     */
    _showRefProperties(compId) {
        return PCBApp.prototype._getComponentProperties.call(this).showReference(compId);
    }

    /**
     * Delete the currently-selected text (if any). Called from the
     * Delete-key handler. Returns true if it consumed the keystroke.
     */
    _deleteSelectedText() {
        const text = getPcbSelection(this, 'text')[0] || null;
        if (!text || isLayerLocked(text.layer) || !isLayerVisible(text.layer)) return false;
        const id = text.id;
        this.history.execute(new RemoveTextCommand(this, id));
        this.clearProperties?.();
        return true;
    }

    /**
     * Begin in-place editing of a PCB text annotation. Overlays an HTML
     * <input> positioned over the text via a <foreignObject>. Commits on
     * Enter or blur, cancels on Escape.
     * @param {object} text
     * @param {{x:number,y:number}} [worldPos] - if given, the caret is
     *   placed at the character nearest this click point; otherwise it
     *   goes to the end of the text.
     */
    _startTextInlineEdit(text, worldPos, opts = {}) {
        if (!text || isLayerLocked(text.layer) || !isLayerVisible(text.layer)) return;
        if (this._textEdit && this._endTextInlineEdit(true) === false) return;

        const svg = this.viewport?.svg;
        if (!svg) return;
        invalidateFillRefresh(this);
        invalidateDrcRefresh(this);
        if (!opts.componentId) text = beginTextContentPreview(this, text.id);

        // Hidden input captures keystrokes / selection / IME / clipboard.
        // Its visual is irrelevant; we draw our own caret as an SVG line
        // positioned via the actual Hershey font's measureText().
        const input = document.createElement('input');
        input.type = 'text';
        input.value = text.content;
        input.style.cssText =
            'position:fixed;left:-1000px;top:-1000px;width:10px;height:10px;' +
            'opacity:0;';
        document.body.appendChild(input);
        setInlineTextInputActive(input, this._active);

        const layerG = this.getLayerGroup(text.layer);
        const overlay = createInlineTextOverlay(
            group => {
                if (typeof this.viewport.addInteractionOverlay === 'function') {
                    this.viewport.addInteractionOverlay(group);
                } else {
                    layerG?.appendChild(group);
                }
            },
            { emphasized: true },
        );
        const { box, caret } = overlay;

        this._textEdit = {
            text, input, caret, box, overlay,
            options: opts,
            isNewPlacement: !!opts.isNewPlacement,
            originalContent: text.content,
            committed: false,
            blinkTimer: overlay.blinkTimer,
        };

        // Surface the Properties panel for this text so the user can
        // tweak size/rotation/etc. mid-edit without leaving edit mode.
        if (opts.select) opts.select();
        else {
            this._selectText(text);
            this._showTextProperties(text);
        }
        const keepVisible = () => {
            this._textEdit?.overlay?.keepCaretVisible();
        };

        const updateCaret = () => {
            opts.prepare?.();
            // Update editing box bounds. Top of box sits a small pad
            // above the cap-top; bottom sits below the baseline far
            // enough to clear descenders (g, y, p, …).
            const editBox = pcbTextEditBox(text, input.value);
            const mirror = (typeof text.layer === 'string' && text.layer.startsWith('bottom-')) ? -1 : 1;
            const xform = opts.transform?.()
                ?? `translate(${text.x},${text.y}) rotate(${-(text.rotation || 0)}) scale(${mirror},1)`;

            const caretIdx = input.selectionStart ?? input.value.length;
            const sub = input.value.slice(0, caretIdx);
            const lx = measureStrokeText(sub, text.size);
            const verticalBounds = measureStrokeTextVerticalBounds(
                input.value,
                text.size,
                text.strokeWidth,
            );
            const caretExtension = text.size * 0.15;
            overlay.updateGeometry({
                ...editBox,
                caretX: lx,
                caretTop: verticalBounds.top - caretExtension,
                caretBottom: verticalBounds.bottom + caretExtension,
                transform: xform,
            });
        };

        keepVisible();
        this._textEdit.updateCaret = updateCaret;

        const live = () => {
            // Inline autoreplace for common typographic symbols. Matches
            // only at the caret so the user can still type literal "(c)"
            // by undoing (Ctrl+Z) after the substitution.
            const AUTOREPLACE = [
                ['(c)',  '\u00A9'],
                ['(C)',  '\u00A9'],
                ['(r)',  '\u00AE'],
                ['(R)',  '\u00AE'],
                ['(tm)', '\u2122'],
                ['(TM)', '\u2122'],
            ];
            const caret = input.selectionStart ?? input.value.length;
            for (const [from, to] of AUTOREPLACE) {
                if (caret >= from.length &&
                    input.value.slice(caret - from.length, caret) === from) {
                    const before = input.value.slice(0, caret - from.length);
                    const after = input.value.slice(caret);
                    input.value = before + to + after;
                    const pos = before.length + to.length;
                    try { input.setSelectionRange(pos, pos); } catch { /* */ }
                    break;
                }
            }
            if (text.content !== input.value) {
                text.content = input.value;
                if (opts.render) opts.render();
                else this.refreshText(text.id);
            }
            updateCaret();
            keepVisible();
        };
        input.addEventListener('input', live);
        input.addEventListener('keyup', () => { updateCaret(); keepVisible(); });
        input.addEventListener('click', () => { updateCaret(); keepVisible(); });
        input.addEventListener('select', () => { updateCaret(); keepVisible(); });

        // Resume label typing from property controls, but let numeric fields
        // own their editing keys. Enter/Escape still finish the inline edit.
        const docKeyCapture = (ev) => {
            const st = this._textEdit;
            if (!st || !this._active) return;
            const active = document.activeElement;
            if (active === input) return;
            const propsPanel = document.getElementById('pcbPropertiesPanel');
            if (!(propsPanel && active && propsPanel.contains(active))) return;
            // Determine if this is a text-editing key we should reroute.
            const k = ev.key;
            if (active.tagName === 'INPUT' && active.type === 'number'
                && k !== 'Enter' && k !== 'Escape') return;
            const editingKey =
                k === 'ArrowLeft' || k === 'ArrowRight' ||
                k === 'Home' || k === 'End' ||
                k === 'Backspace' || k === 'Delete' ||
                k === 'Escape' || k === 'Enter' ||
                (k.length === 1 && !ev.metaKey);
            if (!editingKey) return;
            // Don't steal the spinner's own up/down arrows, Tab, etc.
            ev.preventDefault();
            ev.stopPropagation();
            input.focus();
            // Synthesize: for printable chars, insert at selection.
            const sel = input.selectionStart ?? input.value.length;
            const end = input.selectionEnd ?? sel;
            if (k.length === 1 && !ev.ctrlKey && !ev.metaKey) {
                const v = input.value;
                input.value = v.slice(0, sel) + k + v.slice(end);
                const pos = sel + 1;
                try { input.setSelectionRange(pos, pos); } catch { /* */ }
                input.dispatchEvent(new Event('input', { bubbles: true }));
            } else if (k === 'Backspace') {
                const v = input.value;
                if (sel !== end) {
                    input.value = v.slice(0, sel) + v.slice(end);
                    try { input.setSelectionRange(sel, sel); } catch { /* */ }
                } else if (sel > 0) {
                    input.value = v.slice(0, sel - 1) + v.slice(sel);
                    try { input.setSelectionRange(sel - 1, sel - 1); } catch { /* */ }
                }
                input.dispatchEvent(new Event('input', { bubbles: true }));
            } else if (k === 'Delete') {
                const v = input.value;
                if (sel !== end) {
                    input.value = v.slice(0, sel) + v.slice(end);
                } else if (sel < v.length) {
                    input.value = v.slice(0, sel) + v.slice(sel + 1);
                }
                try { input.setSelectionRange(sel, sel); } catch { /* */ }
                input.dispatchEvent(new Event('input', { bubbles: true }));
            } else if (k === 'ArrowLeft') {
                const pos = Math.max(0, (ev.ctrlKey ? 0 : sel - 1));
                try { input.setSelectionRange(pos, pos); } catch { /* */ }
                updateCaret(); keepVisible();
            } else if (k === 'ArrowRight') {
                const pos = ev.ctrlKey ? input.value.length : Math.min(input.value.length, sel + 1);
                try { input.setSelectionRange(pos, pos); } catch { /* */ }
                updateCaret(); keepVisible();
            } else if (k === 'Home') {
                try { input.setSelectionRange(0, 0); } catch { /* */ }
                updateCaret(); keepVisible();
            } else if (k === 'End') {
                const pos = input.value.length;
                try { input.setSelectionRange(pos, pos); } catch { /* */ }
                updateCaret(); keepVisible();
            } else if (k === 'Enter') {
                this._endTextInlineEdit(true);
            } else if (k === 'Escape') {
                this._endTextInlineEdit(false);
            }
        };
        document.addEventListener('keydown', docKeyCapture, true);
        this._textEdit.docKeyCapture = docKeyCapture;

        input.addEventListener('keydown', (e) => {
            if (!this._active) {
                e.preventDefault();
                return;
            }
            e.stopPropagation();
            if (e.key === 'Enter') {
                e.preventDefault();
                this._endTextInlineEdit(true);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                this._endTextInlineEdit(false);
            } else {
                // Arrow/Home/End/Backspace/Delete autorepeat only fires
                // keydown (no keyup, no input event for arrows). Defer
                // one tick so input.selectionStart reflects the post-key
                // position, then redraw the SVG caret.
                requestAnimationFrame(() => { updateCaret(); keepVisible(); });
            }
        });
        input.addEventListener('blur', (e) => {
            // Keep edit mode alive on blur. If focus moved to the
            // Properties panel, leave it there (the user is tweaking
            // a spinner). Otherwise refocus the hidden input on the
            // next tick so transient blurs (e.g. right-drag panning
            // the canvas) don't end edit mode. Commit happens only
            // via Enter or Escape.
            const propsPanel = document.getElementById('pcbPropertiesPanel');
            setTimeout(() => {
                if (!this._active || !this._textEdit || this._textEdit.committed) return;
                const active = document.activeElement;
                if (active === input) return;
                if (propsPanel && active && propsPanel.contains(active)) return;
                input.focus();
            }, 0);
        });

        setTimeout(() => {
            if (!this._active || this._textEdit?.input !== input) return;
            input.focus();
            // Place caret at the character nearest the click, if known.
            let idx = input.value.length;
            if (worldPos) {
                // Inverse-rotate the click into the text's local frame,
                // undo the mirror, then walk glyphs accumulating widths
                // to find the nearest gap.
                const rad = -(text.rotation || 0) * Math.PI / 180;
                const cos = Math.cos(-rad), sin = Math.sin(-rad);
                const mirror = (typeof text.layer === 'string' && text.layer.startsWith('bottom-')) ? -1 : 1;
                const dx = worldPos.x - text.x, dy = worldPos.y - text.y;
                const lx = opts.localX ? opts.localX(worldPos) : (dx * cos - dy * sin) * mirror;
                let cursorX = 0;
                let best = 0;
                let bestDist = Math.abs(lx - cursorX);
                const s = input.value;
                for (let i = 0; i < s.length; i++) {
                    const charW = measureStrokeText(s[i], text.size);
                    cursorX += charW;
                    // After the i-th char, caret would be at index i+1.
                    const d = Math.abs(lx - cursorX);
                    if (d < bestDist) { bestDist = d; best = i + 1; }
                }
                idx = best;
            }
            try { input.setSelectionRange(idx, idx); } catch { /* ignore */ }
            updateCaret();
        }, 0);
    }

    /**
     * Finish in-place text editing. If `commit`, pushes an EditTextCommand
     * with the new content. Always tears down the overlay.
     * @param {boolean} commit
     */
    _endTextInlineEdit(commit) {
        const state = this._textEdit;
        if (!state) return;
        if (commit) getPropertyEditor(this, 'text')?.commit();
        else getPropertyEditor(this, 'text')?.cancel();
        if (commit && state.options?.validate && !state.options.validate(state.input.value)) return false;
        state.committed = true;
        this._textEdit = null;

        const { text, input, originalContent, isNewPlacement } = state;
        const finalContent = input.value;

        if (state.docKeyCapture) document.removeEventListener('keydown', state.docKeyCapture, true);
        state.overlay?.destroy();
        if (input.parentNode) input.parentNode.removeChild(input);

        if (state.options?.finish) {
            text.content = originalContent;
            state.options.finish(commit ? finalContent : originalContent, commit);
            return;
        }

        // Determine effective final content (empty if cancelled).
        const effective = commit ? finalContent : originalContent;
        // Remove blank text without recording its temporary typed content.
        const blank = effective.trim() === '';
        const wasSelected = isPcbSelected(this, 'text', text);
        try {
            finishTextPosePreview(this, () => {
                if (blank) {
                    const remove = new RemoveTextCommand(this, text.id);
                    const last = this.history.undoStack.at(-1);
                    if (isNewPlacement && last instanceof AddTextCommand && last.text.id === text.id) {
                        remove.execute();
                        this.history.popUndo();
                        this.history.redoStack = [];
                        this.history._notifyChanged();
                    } else {
                        // Keep intervening edits undoable against a restored text.
                        this.history.execute(remove);
                    }
                } else if (commit && finalContent !== originalContent) {
                    this.history.execute(new EditTextCommand(this, text.id, { content: finalContent }));
                } else {
                    this.refreshText(text.id);
                }
            });
        } finally {
            if (!blank || wasSelected) {
                this._selectText(null);
                this.clearProperties?.();
            }
            this._exitTextTool();
        }
    }

    /**
     * After finishing an inline text edit, return to the Home ribbon
     * tab. Keep the Text tool active so the user can immediately
     * place another label.
     */
    _exitTextTool() {
        this.setActiveRibbonTab?.('pcb-home');
    }

    _pcbMultiPropertyCapabilities(entry) {
        return multiPropertyCapabilities(this, entry);
    }

    /** Show the editable intersection of properties for any PCB multi-selection. */
    _showPcbMultiSelectionProperties(entries) {
        showMultiSelectionProperties(this, entries);
    }

    /** Routing adapters expose model operations, never the application itself. */
    _getAutorouter() {
        if (!this._autorouter) this._autorouter = new AutorouterSession({
            readBoard: () => ({
                active: this._active !== false,
                editing: hasPcbEditInProgress(this) || isPcbDrawing(this),
                model: this.pcbDocument, placements: this.placements, netlist: this.netlist,
                undo: this.history.undoStack, redo: this.history.redoStack,
                rules: this.getRoutingParams(),
            }),
            takeRouteInput: () => {
                const testInput = this._testBoardRouteInput;
                const input = testInput || this._buildRouteInput();
                this._testBoardRouteInput = null;
                if (testInput) input.copperObstacles = this._buildCopperObstacles();
                return input;
            },
            getRouterMode: () => this._getRouterMode(),
            adoptResult: result => this._renderRouteResult(result),
            reconcileRatsnest: () => reconcileRatsnest(this),
            setStatus: message => this.setStatus(message),
            presentation: {
                getProgressHost: () => this.status.modeStatus,
                getLayerGroup: id => this.getLayerGroup(id),
                getSvg: () => this.viewport?.svg,
                getRoutingParams: () => this.getRoutingParams(),
                refreshClearanceHalos: () => this.refreshClearanceHalos(),
            },
        });
        return this._autorouter;
    }

    runAutoRoute() { return this._getAutorouter().run(); }

    _cancelAutoRoute(message = null) { this._autorouter?.cancel(message); }

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
            const routeInput = await resp.json();

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
     */
    _setupTestBoardState(routeInput) {
        this.placements = new Map();
        this.netlist = [];

        // Build minimal placements from allObstaclePads
        // Group pads into a single virtual component
        // Pad layers follow the footprint/autorouter convention:
        // 'top' | 'bottom' | 'both' (short form). Track layers use the
        // long SVG-layer-id form ('top-copper'/'bottom-copper').
        const padOffsets = (routeInput.allObstaclePads || []).map((p, i) => ({
            number: String(i),
            dx: p.x,
            dy: p.y,
            width: p.width,
            height: p.height,
            layer: p.layer === 'bottom' ? 'bottom' : p.layer === 'both' ? 'both' : 'top',
        }));
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
     * Build the router's copper-obstacle list from the live board model.
     * Copper text decomposes into per-stroke segment obstacles; silk text
     * is not copper and is ignored. Future copper shapes (rects, arcs,
     * pours, imported artwork) should append their obstacles here too.
     * @returns {import('../pcb/modules/autorouter-common.js').CopperObstacle[]}
     */
    _buildCopperObstacles() {
        return buildCopperObstacles(this);
    }

    /**
     * Convert placements + netlist into the input format for our A* router.
     * @returns {import('../pcb/modules/autorouter-common.js').RouteInput}
     */
    _buildRouteInput() {
        // Build connections with pad positions and sizes.
        // Pad layers are already in the router's 'top'|'bottom'|'both' form
        // (set by footprint.js); no translation needed.
        const connections = [];
        const shapeTerminalsByNet = new Map();
        for (const shape of this.boardShapes || []) {
            if (shape?.type === 'fill') continue;
            const net = String(shape?.net || '');
            if (!net || !shape.filled || (shape.layer !== 'top-copper' && shape.layer !== 'bottom-copper')) continue;
            if (normalizeShapeCopperMode(shape.copperMode) !== 'add') continue;
            const bounds = boardShapeBounds(shape);
            const terminals = shapeTerminalsByNet.get(net) || [];
            terminals.push({
                x: (bounds.minX + bounds.maxX) / 2,
                y: (bounds.minY + bounds.maxY) / 2,
                width: bounds.maxX - bounds.minX,
                height: bounds.maxY - bounds.minY,
                layer: shape.layer === 'top-copper' ? 'top' : 'bottom',
                shape: shape.kind === 'circle' ? 'ellipse' : 'rect',
            });
            shapeTerminalsByNet.set(net, terminals);
        }
        for (const entry of this.netlist) {
            const pads = [];
            for (const pin of entry.pins) {
                const pl = this.placements.get(pin.componentId);
                if (!pl) continue;
                // Multi-pad pins (e.g. thermal/centre pads of TQFN/SOIC-with-EP
                // share a pin number across many physical pads). Collect ALL
                // matching offsets — first becomes the primary endpoint, the
                // rest go into `alternates` so the router can land on any of
                // them. Without this we'd only see the arbitrary last-inserted
                // pad from the placement Map, often a hemmed-in centre pad
                // that's hard or impossible to reach.
                const matches = (pl.padOffsets || []).filter(o => o.number === pin.pinNumber);
                if (matches.length === 0) continue;
                const padFor = (off) => ({
                    x: pl.x + off.dx,
                    y: pl.y + off.dy,
                    width: off.width || 1.0,
                    height: off.height || 1.0,
                    layer: off.layer || 'top',
                    shape: off.shape || 'rect',
                });
                const primary = padFor(matches[0]);
                if (matches.length > 1) {
                    primary.alternates = matches.slice(1).map(padFor);
                }
                pads.push(primary);
            }
            pads.push(...(shapeTerminalsByNet.get(entry.net) || []));
            if (pads.length >= 2) {
                connections.push({ net: entry.net, pads });
            }
        }

        // Collect ALL pads from every component as obstacles
        // (not just the ones in the netlist — unconnected pads must block too)
        const allObstaclePads = [];
        for (const [, pl] of this.placements) {
            for (const off of (pl.padOffsets || [])) {
                allObstaclePads.push({
                    x: pl.x + off.dx,
                    y: pl.y + off.dy,
                    width: off.width || 1.0,
                    height: off.height || 1.0,
                    layer: off.layer || 'top',
                    shape: off.shape || 'rect',
                });
            }
        }

        // Fixed copper features the router must avoid but never rip up. Copper
        // text decomposes into per-stroke segment obstacles; silk text is not
        // copper and is ignored. Future copper shapes (rects, arcs, pours,
        // imported artwork) append their own segment/pad obstacles here.
        const copperObstacles = this._buildCopperObstacles();

        // Compute bounds
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [, pl] of this.placements) {
            for (const [, pad] of pl.pads) {
                minX = Math.min(minX, pad.x - 5);
                minY = Math.min(minY, pad.y - 5);
                maxX = Math.max(maxX, pad.x + 5);
                maxY = Math.max(maxY, pad.y + 5);
            }
        }

        const params = this.getRoutingParams();
        return {
            connections,
            allObstaclePads,
            copperObstacles,
            trackWidth: params.trackWidth,
            clearance: params.clearance,
            viaDiameter: params.viaDiameter,
            gridStep: 0.5,
            bounds: { minX, maxX, minY, maxY },
        };
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
            console.log(`Route input copied to clipboard (${input.connections.length} nets, ${input.allObstaclePads.length} pads). Paste into ${filename}`);
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
     * @param {object|null} [liveTrack] - update only this track's rendered clearance during a drag.
     */
    showClearances(show, liveTrack = null) {
        const NS = 'http://www.w3.org/2000/svg';
        const HALO_CLASS = 'debug-clearance';
        const OVERLAY_LAYER = 'clearance-overlay';

        const overlay = this.getLayerGroup(OVERLAY_LAYER);
        this._trackClearanceElements ??= new Map();
        if (liveTrack) {
            for (const element of this._trackClearanceElements.get(liveTrack.id) || []) element.remove();
            this._trackClearanceElements.delete(liveTrack.id);
        } else {
            while (overlay.firstChild) overlay.removeChild(overlay.firstChild);
            this._trackClearanceElements.clear();
            this._viaClearanceCache?.clear();
            this._viaClearanceKeys?.clear();
        }

        if (show === undefined) show = !this._clearancesVisible;
        this._boardShapeClearanceCache ??= new Map();
        if (!liveTrack) {
            const shapeIds = new Set([...(this.boardShapes || []), ...(this.texts?.values() || [])].map(shape => shape.id));
            for (const id of this._boardShapeClearanceCache.keys()) {
                if (!shapeIds.has(id)) this._boardShapeClearanceCache.delete(id);
            }
        }
        this._clearancesVisible = !!show;
        if (!this._clearancesVisible) {
            this._boardShapeClearanceCache.clear();
            return;
        }

        const params = this.getRoutingParams();
        const halo = params.clearance;

        const HALO_STROKE = 'rgba(255, 255, 255, 0.55)';
        // Stroke width in CSS pixels (constant on screen at any zoom thanks
        // to vector-effect: non-scaling-stroke). 1px = thin clean line.
        const OUTLINE_W = 1;

        const styleHalo = (el) => {
            el.setAttribute('class', HALO_CLASS);
            el.setAttribute('fill', 'none');
            el.setAttribute('stroke', HALO_STROKE);
            el.setAttribute('stroke-width', String(OUTLINE_W));
            el.setAttribute('vector-effect', 'non-scaling-stroke');
            el.setAttribute('pointer-events', 'none');
        };

        const isLayerVisible = (layerId) => {
            const g = this._layerGroups.get(layerId);
            return !g || g.style.display !== 'none';
        };
        const topVisible = isLayerVisible('top-copper');
        const bottomVisible = isLayerVisible('bottom-copper');

        // Build a single SVG path representing the Minkowski expansion of a
        // pad shape by `halo`. Returns null if shape unsupported.
        // Geometry is sized exactly to the clearance boundary; the constant-
        // width screen-pixel stroke straddles it.
        const padHaloPath = (cx, cy, w, h, shape) => {
            const hw = w / 2, hh = h / 2;
            const grow = halo;
            if (shape === 'ellipse') {
                if (Math.abs(hw - hh) < 1e-9) {
                    const r = hw + grow;
                    const c = document.createElementNS(NS, 'circle');
                    c.setAttribute('cx', String(cx));
                    c.setAttribute('cy', String(cy));
                    c.setAttribute('r', String(r));
                    return c;
                }
                const e = document.createElementNS(NS, 'ellipse');
                e.setAttribute('cx', String(cx));
                e.setAttribute('cy', String(cy));
                e.setAttribute('rx', String(hw + grow));
                e.setAttribute('ry', String(hh + grow));
                return e;
            }
            // 'oval' (stadium) and 'rect' both expand to a rounded rectangle:
            //   oval: corner radius = min(hw, hh) + halo
            //   rect: corner radius = halo (true Minkowski sum with a disk)
            const cornerR = (shape === 'oval' ? Math.min(hw, hh) : 0) + grow;
            const r = document.createElementNS(NS, 'rect');
            r.setAttribute('x', String(cx - hw - grow));
            r.setAttribute('y', String(cy - hh - grow));
            r.setAttribute('width', String(w + grow * 2));
            r.setAttribute('height', String(h + grow * 2));
            r.setAttribute('rx', String(cornerR));
            r.setAttribute('ry', String(cornerR));
            return r;
        };

        // Halos for component pads — wrapped in a per-placement <g> with a
        // translate() transform so they follow the component during drag
        // (the drag handler updates the same transform).
        if (!liveTrack) this._padHaloGroups = new Map();
        for (const [compId, pl] of liveTrack ? [] : this.placements) {
            const grp = document.createElementNS(NS, 'g');
            grp.setAttribute('class', 'halo-comp');
            grp.setAttribute('data-comp-id', compId);
            grp.setAttribute('transform', placementTransform(pl));
            for (const off of (pl.padOffsets || [])) {
                const padLayer = off.layer || 'top';
                // Respect copper-layer visibility. 'both' (through-hole pads)
                // are shown if either copper layer is visible.
                if (padLayer === 'top' && !topVisible) continue;
                if (padLayer === 'bottom' && !bottomVisible) continue;
                if (padLayer === 'both' && !topVisible && !bottomVisible) continue;
                // Coords are pad offsets from the component origin; the
                // wrapping <g> applies pl.x/pl.y as a translate.
                const el = padHaloPath(off.dx, off.dy, off.width || 0, off.height || 0, off.shape || 'rect');
                styleHalo(el);
                grp.appendChild(el);
            }
            overlay.appendChild(grp);
            this._padHaloGroups.set(compId, grp);
        }

        // Halos for routed tracks. Computed as the Minkowski-sum offset
        // polygon of each track centerline by (trackR + OUTLINE_W/2),
        // rendered as a closed <polygon> stroked with width OUTLINE_W. Pure
        // vector — no masks, no rasterization, zero per-frame cost on
        // zoom/pan.
        //
        // Construction (per track):
        //   - Walk each segment; emit perpendicular offsets on the right
        //     side going forward, then on the left side going backward.
        //   - At interior vertices: insert a short arc fan on the OUTSIDE
        //     of the bend (round-join). Inside vertex uses the segment-
        //     intersection point.
        //   - At endpoints: insert a semicircular cap (round-cap).
        //
        // Where two tracks meet at a junction, their polygons overlap and
        // the stroked outlines visibly cross — same artifact as pad/via
        // halos already have. Acceptable.
        //
        // Halo radius is sized per-track from each rendered run's stroke
        // width (tracks may carry per-segment widths); see the track loop.
        // Arc tessellation: number of segments per FULL CIRCLE. Each arc
        // emits a proportional fraction of these. Higher = smoother caps
        // and corners at the cost of more polygon vertices.
        const ARC_STEPS_FULL = 64;

        const trackToPoints = (track) => {
            const out = [];
            const push = (x, y) => {
                const xn = parseFloat(x), yn = parseFloat(y);
                if (Number.isFinite(xn) && Number.isFinite(yn)) out.push([xn, yn]);
            };
            if (track.tagName === 'polyline') {
                const tokens = (track.getAttribute('points') || '').trim().split(/[\s,]+/);
                for (let i = 0; i + 1 < tokens.length; i += 2) push(tokens[i], tokens[i + 1]);
            } else if (track.tagName === 'line') {
                push(track.getAttribute('x1'), track.getAttribute('y1'));
                push(track.getAttribute('x2'), track.getAttribute('y2'));
            }
            // De-dupe consecutive identical points.
            const dedup = [];
            for (const p of out) {
                if (dedup.length === 0 || dedup[dedup.length - 1][0] !== p[0] || dedup[dedup.length - 1][1] !== p[1]) {
                    dedup.push(p);
                }
            }
            return dedup;
        };

        // Build the offset polygon of `pts` by radius `r`. Returns array of
        // [x, y] pairs (closed polygon — first ≠ last).
        const offsetPolygon = (pts, r) => {
            if (pts.length < 2) return [];
            const n = pts.length;
            // Per-segment unit direction and perpendicular (right-hand normal).
            const dirs = new Array(n - 1);
            const perps = new Array(n - 1);
            for (let i = 0; i < n - 1; i++) {
                const dx = pts[i + 1][0] - pts[i][0];
                const dy = pts[i + 1][1] - pts[i][1];
                const len = Math.hypot(dx, dy) || 1;
                dirs[i] = [dx / len, dy / len];
                perps[i] = [dy / len, -dx / len]; // right-hand perpendicular
            }

            const arcFan = (cx, cy, fromAngle, toAngle, ccw) => {
                // Returns intermediate arc points (not including endpoints).
                let delta = toAngle - fromAngle;
                if (ccw) {
                    while (delta <= 0) delta += Math.PI * 2;
                } else {
                    while (delta >= 0) delta -= Math.PI * 2;
                }
                // Number of steps proportional to arc sweep angle.
                const steps = Math.max(2, Math.ceil(Math.abs(delta) / (Math.PI * 2) * ARC_STEPS_FULL));
                const out = [];
                for (let s = 1; s < steps; s++) {
                    const t = s / steps;
                    const a = fromAngle + delta * t;
                    out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
                }
                return out;
            };

            // Right side, forward (i = 0 .. n-1)
            const right = [];
            // Start cap (semicircle from left side around to right side)
            {
                const p = perps[0];
                const startAngle = Math.atan2(-p[1], -p[0]); // left-side angle
                const endAngle = Math.atan2(p[1], p[0]);     // right-side angle
                right.push([pts[0][0] + Math.cos(startAngle) * r, pts[0][1] + Math.sin(startAngle) * r]);
                // CCW so the cap bulges AWAY from the segment (around the back of the start point).
                for (const a of arcFan(pts[0][0], pts[0][1], startAngle, endAngle, true)) right.push(a);
                right.push([pts[0][0] + p[0] * r, pts[0][1] + p[1] * r]);
            }
            // Forward through interior vertices (1 .. n-2): join between seg i-1 and seg i.
            for (let i = 1; i < n - 1; i++) {
                const p0 = perps[i - 1];
                const p1 = perps[i];
                // Cross of dirs to determine bend direction.
                const cross = dirs[i - 1][0] * dirs[i][1] - dirs[i - 1][1] * dirs[i][0];
                if (Math.abs(cross) < 1e-9) {
                    // Collinear — just push the point.
                    right.push([pts[i][0] + p1[0] * r, pts[i][1] + p1[1] * r]);
                    continue;
                }
                if (cross > 0) {
                    // Right turn — right side is OUTSIDE → arc fan.
                    const fromA = Math.atan2(p0[1], p0[0]);
                    const toA = Math.atan2(p1[1], p1[0]);
                    right.push([pts[i][0] + p0[0] * r, pts[i][1] + p0[1] * r]);
                    for (const a of arcFan(pts[i][0], pts[i][1], fromA, toA, true)) right.push(a);
                    right.push([pts[i][0] + p1[0] * r, pts[i][1] + p1[1] * r]);
                } else {
                    // Left turn — right side is INSIDE → miter (segment intersection).
                    // Lines: P1 = pts[i-1]+p0*r + t*dirs[i-1]
                    //        P2 = pts[i]  +p1*r + s*dirs[i]
                    // Solve for intersection.
                    const a1x = pts[i - 1][0] + p0[0] * r;
                    const a1y = pts[i - 1][1] + p0[1] * r;
                    const a2x = pts[i][0] + p1[0] * r;
                    const a2y = pts[i][1] + p1[1] * r;
                    const denom = dirs[i - 1][0] * (-dirs[i][1]) - dirs[i - 1][1] * (-dirs[i][0]);
                    if (Math.abs(denom) < 1e-9) {
                        right.push([a2x, a2y]);
                    } else {
                        const t = ((a2x - a1x) * (-dirs[i][1]) - (a2y - a1y) * (-dirs[i][0])) / denom;
                        const mx = a1x + dirs[i - 1][0] * t;
                        const my = a1y + dirs[i - 1][1] * t;
                        // Miter limit: if the miter point is too far from
                        // the vertex (acute inside corner), fall back to a
                        // bevel (two endpoints) to avoid the spike.
                        const distSq = (mx - pts[i][0]) * (mx - pts[i][0]) + (my - pts[i][1]) * (my - pts[i][1]);
                        const maxDist = r * 4; // miter limit ~4× ring radius
                        if (distSq > maxDist * maxDist) {
                            right.push([pts[i][0] + p0[0] * r, pts[i][1] + p0[1] * r]);
                            right.push([pts[i][0] + p1[0] * r, pts[i][1] + p1[1] * r]);
                        } else {
                            right.push([mx, my]);
                        }
                    }
                }
            }
            // End cap (right side around to left side)
            {
                const p = perps[n - 2];
                right.push([pts[n - 1][0] + p[0] * r, pts[n - 1][1] + p[1] * r]);
                const startAngle = Math.atan2(p[1], p[0]);
                const endAngle = Math.atan2(-p[1], -p[0]);
                // CCW so the cap bulges AWAY from the segment (around the front of the end point).
                for (const a of arcFan(pts[n - 1][0], pts[n - 1][1], startAngle, endAngle, true)) right.push(a);
                right.push([pts[n - 1][0] - p[0] * r, pts[n - 1][1] - p[1] * r]);
            }
            // Left side, backward (i = n-2 .. 1): mirror logic with negated perps.
            for (let i = n - 2; i >= 1; i--) {
                const p0 = perps[i];      // perp of segment going INTO vertex from left walk
                const p1 = perps[i - 1];
                const cross = dirs[i][0] * dirs[i - 1][1] - dirs[i][1] * dirs[i - 1][0];
                // Left side uses negated perpendiculars.
                if (Math.abs(cross) < 1e-9) {
                    right.push([pts[i][0] - p1[0] * r, pts[i][1] - p1[1] * r]);
                    continue;
                }
                if (cross > 0) {
                    // Walking backwards: a "right turn" in reverse means left side is OUTSIDE → arc fan.
                    const fromA = Math.atan2(-p0[1], -p0[0]);
                    const toA = Math.atan2(-p1[1], -p1[0]);
                    right.push([pts[i][0] - p0[0] * r, pts[i][1] - p0[1] * r]);
                    for (const a of arcFan(pts[i][0], pts[i][1], fromA, toA, true)) right.push(a);
                    right.push([pts[i][0] - p1[0] * r, pts[i][1] - p1[1] * r]);
                } else {
                    // Inside — miter with limit fallback to bevel.
                    const a1x = pts[i + 1][0] - p0[0] * r;
                    const a1y = pts[i + 1][1] - p0[1] * r;
                    const a2x = pts[i][0] - p1[0] * r;
                    const a2y = pts[i][1] - p1[1] * r;
                    const dx0 = -dirs[i][0], dy0 = -dirs[i][1];
                    const dx1 = -dirs[i - 1][0], dy1 = -dirs[i - 1][1];
                    const denom = dx0 * (-dy1) - dy0 * (-dx1);
                    if (Math.abs(denom) < 1e-9) {
                        right.push([a2x, a2y]);
                    } else {
                        const t = ((a2x - a1x) * (-dy1) - (a2y - a1y) * (-dx1)) / denom;
                        const mx = a1x + dx0 * t;
                        const my = a1y + dy0 * t;
                        const distSq = (mx - pts[i][0]) * (mx - pts[i][0]) + (my - pts[i][1]) * (my - pts[i][1]);
                        const maxDist = r * 4;
                        if (distSq > maxDist * maxDist) {
                            right.push([pts[i][0] - p0[0] * r, pts[i][1] - p0[1] * r]);
                            right.push([pts[i][0] - p1[0] * r, pts[i][1] - p1[1] * r]);
                        } else {
                            right.push([mx, my]);
                        }
                    }
                }
            }
            return right;
        };

        const liveRuns = liveTrack ? (hasTrackElements(liveTrack) ? buildTrackLayerRuns(liveTrack) : []) : null;
        const layerIds = ['top-copper', 'bottom-copper'];
        for (const layerId of layerIds) {
            if (layerId === 'top-copper' && !topVisible) continue;
            if (layerId === 'bottom-copper' && !bottomVisible) continue;
            // Both the legacy incremental render ('.pcb-routed-track') and
            // the model-driven render ('.pcb-track') are valid track sources.
            const tracks = liveRuns ? liveRuns.filter(run => run.layer === layerId).map(run => ({
                points: run.points.filter((point, index) => !index
                    || point.x !== run.points[index - 1].x || point.y !== run.points[index - 1].y)
                    .map(point => [point.x, point.y]), width: run.width,
                id: liveTrack.id, net: liveTrack.net,
            })) : [...this.getLayerGroup(layerId).querySelectorAll('.pcb-routed-track, .pcb-track')]
                .map(track => ({ points: trackToPoints(track), width: parseFloat(track.getAttribute('stroke-width')),
                    id: track.dataset?.trackId, net: track.dataset?.net }));
            if (tracks.length === 0) continue;

            for (const track of tracks) {
                const pts = track.points;
                if (pts.length < 2) continue;
                // Each rendered run carries its own stroke-width (tracks can
                // have per-segment widths), so size the halo from THIS track's
                // width rather than the global routing width.
                const sw = track.width;
                const ringR = (Number.isFinite(sw) && sw > 0 ? sw / 2 : params.trackWidth / 2) + halo;
                const poly = offsetPolygon(pts, ringR);
                if (poly.length < 3) continue;
                const el = document.createElementNS(NS, 'polygon');
                el.setAttribute('class', HALO_CLASS);
                el.setAttribute('points', poly.map(p => `${p[0].toFixed(4)},${p[1].toFixed(4)}`).join(' '));
                el.setAttribute('fill', 'none');
                el.setAttribute('stroke', HALO_STROKE);
                el.setAttribute('stroke-width', String(OUTLINE_W));
                el.setAttribute('vector-effect', 'non-scaling-stroke');
                el.setAttribute('stroke-linejoin', 'round');
                el.setAttribute('pointer-events', 'none');
                // Tag with the source track's net so a footprint drag can hide
                // the halos of the nets it moves (their tracks shift mid-drag,
                // leaving the deferred halo stranded at the old position).
                const tnet = track.net;
                if (tnet) el.dataset.net = tnet;
                if (track.id) {
                    el.dataset.trackId = track.id;
                    if (!this._trackClearanceElements.has(track.id)) this._trackClearanceElements.set(track.id, []);
                    this._trackClearanceElements.get(track.id).push(el);
                }
                overlay.appendChild(el);
            }
        }

        if (liveTrack) return;
        for (const shape of this.boardShapes || []) {
            if (shape) this._refreshBoardShapeClearance(shape);
        }
        for (const text of this.texts?.values() || []) this._refreshBoardShapeClearance(text);

        this._refreshViaClearance();
    }

    /* ─────────────────────── Design Rule Checker ───────────────────── */

    _getDrcPresentation() {
        return this._drcPresentation ??= new DrcPresentation({
            requestRefresh: () => this._scheduleDRC(),
            collectRatlines: () => this._collectRatlines(),
            resolvePairMarker: violation => resolveDrcPairMarker(this, violation, this.getRoutingParams()),
            clearBoardSelection: () => {
                if (!getPcbSelection(this).length && !this._boardOutlineSelected && !this._trackEdit) return;
                clearSelectionInteractionUi(this);
                clearBoxSelection(this);
                this.clearProperties?.();
            },
            getLayerGroup: (id, create = false) => create
                ? this.getLayerGroup(id) : this._layerGroups?.get(id),
            getViewport: () => {
                const vp = this.viewport;
                return vp ? {
                    viewBox: vp.viewBox, svg: vp.svg, scale: vp.scale,
                    worldToScreen: vp.worldToScreen ? point => vp.worldToScreen(point) : null,
                    updateViewBox: () => vp._updateViewBox?.(),
                    notifyViewChanged: () => vp._notifyViewChanged?.(),
                } : null;
            },
        });
    }

    get _drcViolations() { return this._getDrcPresentation().violations; }
    set _drcViolations(value) { this._getDrcPresentation().violations = value; }
    get _drcActive() { return this._getDrcPresentation().designActive; }
    set _drcActive(value) { this._getDrcPresentation().designActive = value; }
    get _drcSelectedId() { return this._getDrcPresentation().selectedId; }
    set _drcSelectedId(value) { this._getDrcPresentation().selectedId = value; }
    get _drcCollapsedGroups() { return this._getDrcPresentation().collapsedGroups; }
    set _drcCollapsedGroups(value) { this._getDrcPresentation().collapsedGroups = value; }
    get _drcConnectorLine() { return this._getDrcPresentation().connectorLine; }
    set _drcConnectorLine(value) { this._getDrcPresentation().connectorLine = value; }
    get _drcPending() { return this._getDrcPresentation().pending; }
    set _drcPending(value) { this._getDrcPresentation().pending = value; }
    get _drcError() { return this._getDrcPresentation().error; }
    set _drcError(value) { this._getDrcPresentation().error = value; }

    _initDRC() {
        this._drcRaf = 0;
        return this._getDrcPresentation().initialize();
    }

    /** True when DRC should re-evaluate: Design tab active or panel open. */
    _drcShouldRun() {
        return this._getDrcPresentation().shouldRun();
    }

    /** Request a visible live check, coalesced to one per animation frame. */
    _scheduleDRC() {
        this.refreshSelectedDRCMarker?.();
        scheduleDrcRefresh(this);
    }

    refreshSelectedDRCMarker() {
        this._drcPresentation?.scheduleMarkerRefresh();
    }

    _invalidateDRC() {
        invalidateDrcRefresh(this);
    }

    /**
     * Collect neutral ratsnest air wires (remaining + autorouter-failed)
     * as plain segments for the DRC's incomplete-connection check.
     * @returns {Array<{net:string, x1:number, y1:number, x2:number, y2:number}>}
     */
    _collectRatlines() {
        if (this._drcRatlinesModel && this._drcRatlinesModel !== (this.pcbDocument || this)) return [];
        // SVG numeric attributes previously normalized signed zero, but retained all other precision.
        return (this._drcRatlines || []).map(({ net, x1, y1, x2, y2 }) => ({
            net, x1: x1 === 0 ? 0 : x1, y1: y1 === 0 ? 0 : y1,
            x2: x2 === 0 ? 0 : x2, y2: y2 === 0 ? 0 : y2,
        }));
    }

    _resetDRC() {
        disposeDrcRefresh(this);
        this._drcRatlines = [];
        this._drcRatlinesModel = this.pcbDocument;
        this._drcError = null;
        this._drcPending = false;
        this._scheduleDRC();
    }

    /** Refresh DRC only after deferred copper geometry and pours are current. */
    _runDRCLive() {
        runDrcNow(this);
    }

    _adoptDRCResult(result) {
        return this._getDrcPresentation().adoptResult(result);
    }

    /**
     * Update the green-tick / red-cross status button.
     * @param {{ok:boolean, violations:Array, counts:{errors:number, warnings:number}}} result
     * @param {boolean} [pending]
     */
    _updateDRCStatus(result, pending = false) {
        return this._getDrcPresentation().updateStatus(result, pending);
    }

    /** Populate the problem dropdown; each item points to its issue on click. */
    _renderDRCList() {
        return this._getDrcPresentation().renderList();
    }

    _closeDRCPanel() {
        return this._getDrcPresentation().closePanel();
    }

    /** Select the adjacent visible DRC row using keyboard list navigation. */
    _moveDRCSelection(direction) {
        return this._getDrcPresentation().moveSelection(direction);
    }

    /**
     * Highlight a violation: draw a dotted marker pointing to it on the board,
     * scroll it into view, and flag the matching list row.
     * @param {string} id
     */
    _selectDRCViolation(id) {
        return this._getDrcPresentation().selectViolation(id);
    }

    /** Draw the dotted marker for a violation on the DRC overlay layer. */
    _drawDRCMarker(v) {
        return this._getDrcPresentation().drawMarker(v);
    }

    /** Remove the DRC marker overlay. */
    _clearDRCMarker() {
        return this._getDrcPresentation().clearMarker();
    }

    /**
     * Draw the dotted leader from the selected problem row in the slide panel
     * to its marker on the board. Recomputed on selection and on view change.
     */
    _updateDRCConnector() {
        return this._getDrcPresentation().updateConnector();
    }

    /**
     * Pan (preserving zoom) so a world point is comfortably on-screen. Only
     * moves the view if the point sits outside the unobscured viewport.
     */
    _ensurePointVisible(x, y) {
        return this._getDrcPresentation().ensurePointVisible(x, y);
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
    /** The halo cache's only geometry work: clearance outlines for a board shape or free text. */
    _computeClearanceOutlines(shape, clearance) {
        return typeof shape.content === 'string'
            ? pcbTextClearanceOutlines(shape, clearance)
            : boardShapeClearanceOutlines(shape, clearance);
    }

    _refreshBoardShapeClearance(shape) {
        if (this._pasteDrop) return;
        if (!this._clearancesVisible) return;
        const overlay = this.getLayerGroup('clearance-overlay');
        if (!overlay) return;
        this._boardShapeClearanceCache ??= new Map();
        const previous = this._boardShapeClearanceCache.get(shape.id);
        if (shouldDeferShapeClearance(this, shape)) {
            for (const element of previous?.elements || []) {
                element.parentNode?.removeChild(element);
            }
            return;
        }
        const clearance = this.getRoutingParams().clearance;
        const layer = this._layerGroups.get(shape.layer);
        const visible = !!layer && layer.style.display !== 'none';
        const isText = typeof shape.content === 'string';
        const points = shape.points || (shape.kind === 'circle' || isText ? [{ x: shape.x, y: shape.y }]
            : shape.kind === 'arc' ? [shape.start, shape.end, shape.bulge] : []);
        const style = JSON.stringify([shape.kind, shape.layer, visible, clearance, shape.net, shape.radius,
            shape.lineWidth, shape.segmentWidths, shape.segmentBulges, shape.filled, shape.copperMode,
            shape.cornerRadius, shape.nodeCornerRadii,
            shape.content, shape.size, shape.strokeWidth, shape.rotation]);
        if (previous && previous.style === style && previous.artwork === shape.artwork
            && points.length && points.length === previous.points.length) {
            const dx = points[0].x - previous.points[0].x;
            const dy = points[0].y - previous.points[0].y;
            if (points.every((point, index) => Math.abs(point.x - previous.points[index].x - dx) < 1e-9
                && Math.abs(point.y - previous.points[index].y - dy) < 1e-9)) {
                for (const element of previous.elements) {
                    element.setAttribute('transform', `translate(${dx} ${dy})`);
                    if (element.parentNode !== overlay) overlay.appendChild(element);
                }
                return;
            }
        }
        for (const element of previous?.elements || []) {
            if (element.parentNode === overlay) overlay.removeChild(element);
        }
        const elements = [];
        if (visible) for (const outline of this._computeClearanceOutlines(shape, clearance)) {
            const element = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
            element.setAttribute('class', 'debug-clearance');
            element.setAttribute('fill', 'none');
            element.setAttribute('stroke', 'rgba(255, 255, 255, 0.55)');
            element.setAttribute('stroke-width', '1');
            element.setAttribute('vector-effect', 'non-scaling-stroke');
            element.setAttribute('pointer-events', 'none');
            element.setAttribute('points', outline.map(point => `${point.x},${point.y}`).join(' '));
            element.setAttribute('data-shape-id', shape.id);
            if (shape.net) element.dataset.net = shape.net;
            overlay.appendChild(element);
            elements.push(element);
        }
        this._boardShapeClearanceCache.set(shape.id, { style, artwork: shape.artwork,
            points: points.map(point => ({ x: point.x, y: point.y })), elements });
    }

    refreshClearanceHalos() {
        if (this._clearancesVisible) this.showClearances(true);
    }

    _refreshTrackClearance(track) {
        if (this._clearancesVisible) this.showClearances(true, track);
    }

    _refreshViaClearance(via = null) {
        if (!this._clearancesVisible) return;
        const overlay = this.getLayerGroup('clearance-overlay');
        const layer = this.getLayerGroup('vias');
        if (!overlay) return;
        this._viaClearanceCache ??= new Map();
        this._viaClearanceKeys ??= new Map();
        const affected = new Set();
        if (via) {
            const previous = this._viaClearanceKeys.get(via.id);
            if (previous != null) {
                this._viaClearanceCache.get(previous)?.sources.delete(via.id);
                this._viaClearanceKeys.delete(via.id);
                affected.add(previous);
            }
        } else {
            for (const entry of this._viaClearanceCache.values()) entry.element?.remove();
            this._viaClearanceCache.clear();
            this._viaClearanceKeys.clear();
        }
        const register = (id, cx, cy, r, net) => {
            if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(r)) return;
            const key = `${cx.toFixed(4)},${cy.toFixed(4)}`;
            if (!this._viaClearanceCache.has(key)) this._viaClearanceCache.set(key, { sources: new Map() });
            const sources = this._viaClearanceCache.get(key).sources;
            const previous = sources.get(id);
            if (!previous || r > previous.r) sources.set(id, { cx, cy, r, net: net || previous?.net });
            this._viaClearanceKeys.set(id, key);
            affected.add(key);
        };
        if (layer && layer.style.display !== 'none') {
            if (via) {
                if (hasViaElements(via)) register(via.id, via.x, via.y, via.diameter / 2, via.net);
            } else for (const rendered of layer.querySelectorAll('circle.pcb-routed-via, circle.pcb-via, path.pcb-via')) {
                const path = rendered.localName === 'path';
                register(rendered.dataset?.viaId || rendered,
                    parseFloat(rendered.getAttribute(path ? 'data-via-x' : 'cx')),
                    parseFloat(rendered.getAttribute(path ? 'data-via-y' : 'cy')),
                    parseFloat(rendered.getAttribute(path ? 'data-via-radius' : 'r')), rendered.dataset?.net);
            }
        }
        const clearance = this.getRoutingParams().clearance;
        for (const key of affected) {
            const entry = this._viaClearanceCache.get(key);
            entry.element?.remove();
            if (!entry.sources.size) {
                this._viaClearanceCache.delete(key);
                continue;
            }
            // Coincident vias share the largest ring; moving one must retain any others.
            let largest = null, net = '';
            for (const source of entry.sources.values()) {
                if (!largest || source.r > largest.r) {
                    largest = source;
                    net = source.net || net;
                }
            }
            const element = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            element.setAttribute('cx', String(largest.cx));
            element.setAttribute('cy', String(largest.cy));
            element.setAttribute('r', String(largest.r + clearance));
            element.setAttribute('class', 'debug-clearance');
            element.setAttribute('fill', 'none');
            element.setAttribute('stroke', 'rgba(255, 255, 255, 0.55)');
            element.setAttribute('stroke-width', '1');
            element.setAttribute('vector-effect', 'non-scaling-stroke');
            element.setAttribute('pointer-events', 'none');
            if (net) element.dataset.net = net;
            overlay.appendChild(element);
            entry.element = element;
        }
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
     * Re-render existing pour geometry (e.g. to reflect selection state)
     * without recomputing polygons. Selection/highlight changes don't alter
     * geometry, so reuse the cached fill results instead of re-running
     * Clipper across every pour.
     */
    _rerenderFills() {
        if (areDragOverlaysDeferred(this)) return;
        if (!this.copperFills || this.copperFills.length === 0) return;
        for (const fill of this.copperFills) {
            renderCopperFill(fill, (id) => this.getLayerGroup(id), {
                selected: isPcbSelected(this, 'fill', fill),
            });
        }
    }

    /** Remove all rendered pour geometry from both fill layer groups. */
    _clearFillGroups() {
        for (const gid of ['top-fill', 'bottom-fill']) {
            const g = this._layerGroups.get(gid);
            if (g) while (g.firstChild) g.firstChild.remove();
        }
    }

    /**
     * Recompute the poured geometry for every fill and re-render. Ensures
     * the clipper engine is loaded first (async, once); until it is, the
     * recompute is deferred.
     * @returns {true|undefined} True when fills were computed and downstream refreshes requested.
     */
    _recomputeFillsNow() {
        invalidateDrcRefresh(this);
        return recomputeFillsNow(this);
    }

    /** Build the obstacle/parameter context for the fill geometry engine. */
    _fillContext() {
        return buildFillContext(this);
    }

    /** Resolve a pad's net from the netlist (componentId + pad number). */
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
     * Layer-panel callback: show/hide the copper pour on one side. Visibility
     * is purely a view state (toggles the fill layer-group's display).
     * @param {string} copperLayerId - 'top-copper' | 'bottom-copper'
     * @param {boolean} visible
     */
    _onCopperFillVisibilityChanged(copperLayerId, visible) {
        if (this._pasteDrop && !visible && !isPcbPasteEditable(this)) this._cancelPasteDrop();
        if (!visible && this._groupDrag?.fills.some(({ fill }) => fill.layer === copperLayerId)) this._cancelPosePreviews();
        const g = this._layerGroups.get(fillGroupId(copperLayerId));
        if (g) g.style.display = visible ? '' : 'none';
        this._refreshPcbSelectionHighlights?.();
        saveLayerPrefs();
    }

    /**
     * Layer-panel callback: lock/unlock the copper pour on one side. A locked
     * pour is dimmed and remains selectable only for its unlock affordance.
     * @param {string} copperLayerId - 'top-copper' | 'bottom-copper'
     * @param {boolean} locked
     */
    _onCopperFillLockChanged(copperLayerId, locked) {
        if (this._pasteDrop && locked && !isPcbPasteEditable(this)) this._cancelPasteDrop();
        if (locked && this._groupDrag?.fills.some(({ fill }) => fill.layer === copperLayerId)) this._cancelPosePreviews();
        const g = this._layerGroups.get(fillGroupId(copperLayerId));
        if (g) g.style.opacity = locked ? '0.4' : '';
        const selectedFill = getPcbSelection(this, 'fill')[0] || null;
        const checkbox = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropFillLocked'));
        if (checkbox && selectedFill?.layer === copperLayerId) checkbox.checked = locked;
        this._refreshPcbSelectionHighlights?.();
        saveLayerPrefs();
    }

    /** Hit-test a world point against any pour region outline. */
    _hitTestFill(worldPos) {
        if (!this.copperFills) return null;
        // Topmost (last drawn) first.
        for (let i = this.copperFills.length - 1; i >= 0; i--) {
            const fill = this.copperFills[i];
            if (fill.visible === false || fill.locked) continue;
            if (isLayerLocked(fill.layer)) continue;
            if (isCopperFillLocked(fill.layer) || !isCopperFillVisible(fill.layer)) continue;
            // Only the outline edge (and its vertex nodes) selects a pour —
            // clicking the flooded interior must not, or every board click
            // would grab the fill.
            if (fill.distanceToEdge(worldPos.x, worldPos.y) < 0.6) {
                return fill;
            }
        }
        return null;
    }

    /** Select (or clear) the active pour and refresh its highlight. */
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
        const getGroup = (id) => this.getLayerGroup(id);
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
     */
    _startFillDrag(fill, worldPos, e) {
        return startFillEditAt(this, fill, worldPos);
    }

    /** Update a live pour drag (vertex move or whole-region translate). */
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
    _showFillProperties(fill) {
        showFillProperties(this, fill);
    }

    /**
     * Re-sync the pour Properties panel after a programmatic change (e.g. a
     * ModifyFillCommand undo/redo). Simply re-renders if this pour is shown.
     */
    _refreshFillProperties(fill) {
        if (fill && isPcbSelected(this, 'fill', fill)) this._showFillProperties(fill);
    }

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
        this.history.execute(new ReplaceRoutesCommand(this, tracks, vias, result.failedConnections));
    }

    _renderRoutedCopper(failedRatlines = []) {
        const params = this.getRoutingParams();
        for (const id of ['top-copper', 'bottom-copper', 'vias']) {
            this.getLayerGroup(id)?.querySelectorAll('.pcb-routed-track, .pcb-routed-via, .pcb-route-anim')
                .forEach(el => el.remove());
        }
        const getGroup = (id) => this.getLayerGroup(id);
        for (const t of this.pcbDocument.tracks) renderTrack(t, getGroup, {
            viaDiameter: params.viaDiameter,
            viaDrill: params.viaDrill,
        });
        for (const v of this.pcbDocument.vias) renderVia(v, getGroup);

        // Reconcile final ratsnest: hide all original ratlines, then draw
        // per-connection ratlines for each failed connection.
        const ratLayer = this.getLayerGroup('ratlines');
        ratLayer?.querySelectorAll('.ratsnest-failed').forEach(el => el.remove());
        for (const el of [...(ratLayer?.children || [])]) {
            /** @type {HTMLElement} */ (el).style.display = 'none';
        }

        const NS2 = 'http://www.w3.org/2000/svg';
        if (ratLayer) {
            for (const fc of failedRatlines) {
                const line = document.createElementNS(NS2, 'line');
                line.setAttribute('x1', String(fc.x1));
                line.setAttribute('y1', String(fc.y1));
                line.setAttribute('x2', String(fc.x2));
                line.setAttribute('y2', String(fc.y2));
                line.setAttribute('stroke', '#4488ff');
                line.setAttribute('stroke-width', '1');
                line.setAttribute('vector-effect', 'non-scaling-stroke');
                line.setAttribute('pointer-events', 'none');
                line.setAttribute('class', 'ratsnest-line ratsnest-failed');
                line.dataset.net = fc.net;
                ratLayer.appendChild(line);
            }
        }

        this._drcRatlines = failedRatlines.map(line => ({ ...line }));
        this._drcRatlinesModel = this.pcbDocument;
        reconcileRatsnest(this);
        syncPcbSelection(this);
        refreshBoxSelectionHighlights(this);
        showPcbSelectionProperties(this);
        this.setPcbStatus?.();

        this.refreshClearanceHalos();
        this._scheduleDRC();
    }

    /**
     * Clear all routed tracks/vias and restore all ratlines.
     */
    clearRoutes() {
        this._cancelAutoRoute();

        const command = new ReplaceRoutesCommand(this, [], []);
        command.description = 'Clear routed copper';
        if (this.pcbDocument.tracks.length || this.pcbDocument.vias.length) this.history.execute(command);
        else this._renderRoutedCopper();
        this.setStatus('Routes cleared');
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
        this._ensureViewport();
        openPanelizeDialog(this);
    }

    async exportGerber() {
        if (this._exportGerberPending) return;
        if (!hasFabricationContent(this)) {
            this.setStatus('Nothing to export');
            return;
        }
        this._exportGerberPending = true;
        const suggestedName = `${this._exportBaseName()}-gerber.zip`;
        try {
            let fileCount = 0;
            const saved = await this._saveBlob(async () => {
                const result = await generateGerberArchive(this);
                fileCount = result.fileCount;
                showGerberProgress('Saving ZIP', 100);
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
            showGerberProgress(null);
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
        const suggestedName = `${this._exportBaseName()}-bom.csv`;
        this._saveBlob(blob, suggestedName, {
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
        const suggestedName = `${this._exportBaseName()}-pick-and-place.csv`;
        this._saveBlob(blob, suggestedName, {
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
     * Derive a default export filename base from the project name.
     * @returns {string}
     */
    _exportBaseName() {
        return projectBaseName(this, 'untitled');
    }

    /**
     * Toggle the interactive 3D board visualiser. The toolbar 3D View button
     * opens/shows it when hidden and hides it when visible; the button stays
     * highlighted while the panel is active. The 3D and 2D views share one
     * panel, so opening 3D simply re-aims the shared panel.
     */
    open3DView() {
        const p = this._board3d;
        if (p && !p.closed) {
            if (!p.hidden && p.view === '3d') { p.hide?.(); return; }
            if (p.hidden) p.show?.();
            p.setView?.('3d');
            return;
        }
        openBoard3DViewer(this, { view: '3d' });
    }

    /**
     * Toggle the flat 2D board visualiser for one side. Reuses the same sliding
     * panel as the 3D view (the two buttons are mutually exclusive): clicking
     * the active side hides the panel; any other state opens/switches it to
     * `side`.
     * @param {'top'|'bottom'} [side]
     */
    open2DView(side = 'top') {
        this._last2DSide = side;
        const p = this._board3d;
        if (p && !p.closed) {
            if (!p.hidden && p.view === side) { p.hide?.(); return; }
            if (p.hidden) p.show?.();
            p.setView?.(side);
            return;
        }
        openBoard3DViewer(this, { view: side });
    }

    /**
     * Reflect the shared render panel's state on the toolbar 3D and 2D View
     * buttons. Only one is highlighted at a time (or neither, when hidden).
     */
    _update3DButtonState() {
        const btn3d = document.getElementById('pcb3dView');
        const btn2d = document.getElementById('pcb2dView');
        const p = this._board3d;
        const live = !!(p && !p.closed && !p.hidden);
        const view = live ? p.view : null;
        btn3d?.classList.toggle('active', view === '3d');
        btn2d?.classList.toggle('active', view === 'top' || view === 'bottom');
    }

    /**
     * Save a Blob to disk. Uses the File System Access API when
     * available (proper Save As dialog), falling back to an anchor
     * download. Returns true if a file was saved, false if the user
     * cancelled the picker.
    * @param {Blob | (() => Promise<Blob>)} blob
     * @param {string} suggestedName
     * @param {{description?: string, accept?: Record<string,string[]>}} [opts]
     * @returns {Promise<boolean>}
     */
    async _saveBlob(blob, suggestedName, opts = {}) {
        // Run the save in the window that owns the user gesture. When a viewer
        // is torn off into a pop-up, the click happens there — using the opener
        // window's picker/anchor would have no user activation and silently fail.
        const targetWin = /** @type {any} */ (opts.win && !opts.win.closed ? opts.win : window);
        const targetDoc = targetWin.document || document;
        if (typeof targetWin.showSaveFilePicker === 'function') {
            try {
                const handle = await targetWin.showSaveFilePicker({
                    suggestedName,
                    types: opts.accept ? [{
                        description: opts.description || '',
                        accept: opts.accept,
                    }] : undefined,
                });
                const data = typeof blob === 'function' ? await blob() : blob;
                const writable = await handle.createWritable();
                await writable.write(data);
                await writable.close();
                return true;
            } catch (err) {
                // User cancelled — not an error.
                if (err && (err.name === 'AbortError' || err.code === 20)) return false;
                throw err;
            }
        }
        // Fallback: anchor download (Firefox / older browsers).
        const data = typeof blob === 'function' ? await blob() : blob;
        const url = URL.createObjectURL(data);
        const a = targetDoc.createElement('a');
        a.href = url;
        a.download = suggestedName;
        (targetDoc.body || targetDoc.documentElement).appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        return true;
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
                this._cancelAutoRoute();
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

    // ── Debug tooltip ─────────────────────────────────────────────

    /**
     * Create the debug tooltip element (reuses schematic CSS classes).
     */
    _initDebugTooltip() {
        if (this._debugTooltip) return;
        const el = document.createElement('div');
        el.className = 'component-code-tooltip';
        el.style.display = 'none';
        el.innerHTML = `
            <div class="component-code-tooltip-title">Footprint Shapes</div>
            <button class="component-code-tooltip-close" title="Close">×</button>
            <textarea class="component-code-tooltip-text" readonly></textarea>
        `;
        el.addEventListener('click', (e) => {
            if (e.target instanceof Element && e.target.classList.contains('component-code-tooltip-close')) {
                el.style.display = 'none';
                this._debugTooltipVisible = false;
                this._debugTooltipPinned = false;
            }
        });
        document.body.appendChild(el);
        this._debugTooltip = el;

        // Bind the checkbox
        const cb = document.getElementById('pcbDebugTooltip');
        if (cb) {
            cb.addEventListener('change', (e) => {
                this._showDebugTooltip = /** @type {HTMLInputElement} */ (e.target).checked;
                if (!this._showDebugTooltip && this._debugTooltip) {
                    this._debugTooltip.style.display = 'none';
                    this._debugTooltipVisible = false;
                }
            });
        }
    }

    /**
     * Show/hide the debug tooltip based on mouse position over a footprint.
     * @param {MouseEvent} e
     */
    _updateDebugTooltip(e) {
        if (!this._showDebugTooltip) return;
        if (this._debugTooltipPinned) return;  // Don't move while pinned

        const rect = this.viewport.svg.getBoundingClientRect();
        const worldPos = this.viewport.screenToWorld({
            x: e.clientX - rect.left,
            y: e.clientY - rect.top
        });
        if (!worldPos) return;

        // Find the closest component placement
        let closest = null;
        let closestDist = 15; // mm tolerance
        for (const [compId, pl] of this.placements) {
            for (const [, pad] of pl.pads) {
                const d = Math.hypot(pad.x - worldPos.x, pad.y - worldPos.y);
                if (d < closestDist) {
                    closestDist = d;
                    closest = compId;
                }
            }
        }

        if (!closest) {
            if (!this._debugTooltipVisible) return;
            this._debugTooltip.style.display = 'none';
            this._debugTooltipVisible = false;
            return;
        }

        // Find the definition for this component
        const shapes = this.project?.getComponentInfo(closest)?.footprintShapes;
        if (!Array.isArray(shapes) || shapes.length === 0) return;

        const textEl = /** @type {HTMLTextAreaElement|null} */ (
            this._debugTooltip.querySelector('.component-code-tooltip-text')
        );
        if (textEl && this._debugTooltip.dataset.compId !== closest) {
            // Format each shape on its own line, truncate long ones
            textEl.value = shapes
                .filter(s => typeof s === 'string')
                .join('\n');
            this._debugTooltip.dataset.compId = closest;
        }

        const pad = 12;
        const maxX = window.innerWidth - this._debugTooltip.offsetWidth - pad;
        const maxY = window.innerHeight - this._debugTooltip.offsetHeight - pad;
        this._debugTooltip.style.left = `${Math.min(e.clientX + pad, Math.max(pad, maxX))}px`;
        this._debugTooltip.style.top = `${Math.min(e.clientY + pad, Math.max(pad, maxY))}px`;
        this._debugTooltip.style.display = 'block';
        this._debugTooltipVisible = true;
    }
}
