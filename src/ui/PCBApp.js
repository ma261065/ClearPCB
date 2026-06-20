// @ts-nocheck — PCBApp uses loosely-typed Maps and nullable viewport access throughout
// PCBApp.js - PCB Editor Application

import { bindPcbControls } from '../pcb/modules/controls.js';
import { Viewport } from '../core/Viewport.js';
import { loadAndApplyTheme, toggleTheme as toggleSharedTheme, syncThemeToggleButtons } from '../shared/ui/theme.js';
import { extractNetlist, extractComponents } from '../pcb/modules/netlist.js';
import { generateFootprint, renderFootprint, applyRefGeometry, REF_DEFAULT_SIZE, REF_DEFAULT_STROKE } from '../pcb/modules/footprint.js';
import { updateGridDropdown } from './modules/viewport.js';
import { PCB_LAYERS, PCB_OVERLAYS, PCB_COPPER_FILLS, isLayerLocked, isViaLocked, isLayerVisible, isViaVisible, showLockedLayerBubble, isCopperFillLocked, isCopperFillVisible, saveLayerPrefs } from '../pcb/modules/layers.js';
import { exportDSN, importSES } from '../pcb/modules/dsn.js';
import { runDRC } from '../pcb/modules/drc.js';
import { exportGerbers, buildZip } from '../pcb/modules/gerber.js';
import { generateBOM, generatePickAndPlace } from '../pcb/modules/assembly.js';
import { openBoard3DViewer } from '../pcb/modules/board3d.js';
import { savePcbPdf, printPcb } from '../pcb/modules/pcb-export.js';import { tracksFromAutorouterResult } from '../pcb/modules/autorouter-adapter.js';
import { renderTrack, renderVia, renderHole, removeTrackElements, removeViaElements, removeHoleElements } from '../pcb/modules/track-render.js';
import {
    startTrackDraw,
    updateTrackDraw,
    addTrackWaypoint,
    finishTrackDraw,
    cancelTrackDraw,
    toggleTrackLayer,
    resolveTrackSnap,
    reconcileRatsnest,
} from '../pcb/modules/track-draw.js';
import {
    hitTestTrack,
    hitTestLockedTrack,
    selectTrackOrVia,
    clearTrackSelection,
    deleteSelectedTrack,
    setHoverHighlight,
    showTrackContextMenu,
    refreshTrackSelectionHalo,
    selectTrackSegment,
    dismissTrackContextMenu,
} from '../pcb/modules/track-select.js';
import {
    startVertexDrag,
    updateVertexDrag,
    finishVertexDrag,
    cancelVertexDrag,
    startViaDrag,
    updateViaDrag,
    finishViaDrag,
    cancelViaDrag,
    startHoleDrag,
    updateHoleDrag,
    finishHoleDrag,
    cancelHoleDrag,
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
    AddHoleCommand,
    RemoveTrackCommand,
    CompoundCommand,
    MovePlacementCommand,
    RotatePlacementCommand,
    FlipPlacementCommand,
    SetPlacementSideCommand,
    SetPlacementRefVisibleCommand,
    MoveRefTextCommand,
    RotateRefTextCommand,
    SetRefStyleCommand,
    SetBoardOutlineCommand,
    applyPlacementPose,
    applyPlacementSide,
    applyPlacementRefVisible,
    placementTransform,
    isPlacementMirrored,
} from '../pcb/modules/track-commands.js';
import {
    createPcbText,
    renderPcbText,
    pcbTextHitTest,
    pcbTextBounds,
    pcbTextObstacles,
    serializePcbText,
    textColorForLayer,
    TEXT_LAYERS,
} from '../pcb/modules/pcb-text.js';
import {
    AddTextCommand,
    RemoveTextCommand,
    MoveTextCommand,
    EditTextCommand,
} from '../pcb/modules/text-commands.js';
import { AddCircleCommand, RemoveCircleCommand, MoveCircleCommand, ModifyCircleCommand } from '../pcb/modules/circle-commands.js';
import { hasAny3DModel, openComponent3DFromData, buildComponent3DTitle } from '../components/model3d-source.js';
import {
    armBoxSelect,
    maybeStartBoxSelect,
    finishBoxSelect,
    clearBoxSelection,
    hasBoxSelection,
    pointInBoxSelection,
    beginGroupDrag,
    updateGroupDrag,
    endGroupDrag,
    deleteBoxSelection,
} from '../pcb/modules/box-select.js';
import { measureText as measureStrokeText } from '../pcb/modules/stroke-font.js';
import { CommandHistory } from '../core/CommandHistory.js';
import { Track } from '../shapes/track.js';
import { Via } from '../shapes/via.js';
import { Hole, updateHoleIdCounter } from '../shapes/hole.js';
import { CopperFill, updateFillIdCounter } from '../shapes/copper-fill.js';
import { computeFillPolygons, loadClipper, isClipperReady } from '../pcb/modules/copper-fill-geom.js';
import { renderCopperFill, fillGroupId } from '../pcb/modules/copper-fill-render.js';
import { AddFillCommand, RemoveFillCommand, ModifyFillCommand } from '../pcb/modules/copper-fill-commands.js';
import {
    startFillDraw,
    updateFillDraw,
    addFillWaypoint,
    finishFillDraw,
    cancelFillDraw,
} from '../pcb/modules/copper-fill-draw.js';
import { createShape } from '../shapes/index.js';

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
    constructor() {
        this.ribbon = document.getElementById('ribbonPCB');
        this.themeToggle = document.getElementById('pcbThemeToggle');
        this.canvasContainer = document.getElementById('pcbCanvasContainer');
        this.status = {
            cursorPos: document.getElementById('pcbCursorPos'),
            gridSnap: document.getElementById('pcbGridSnap'),
            viewportInfo: document.getElementById('pcbViewportInfo'),
            zoomPercent: document.getElementById('pcbZoomPercent'),
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
         * @type {Map<string, {x:number, y:number, rotation:number}>}
         */
        this._placementOverrides = new Map();
        /**
         * Stable auto-grid positions for components that have NOT been
         * manually moved, keyed by component id. The grid slot is computed
         * once (the first time a component is seen) and remembered, so that
         * deleting a component does not reflow the others — each un-moved
         * footprint keeps the exact spot it was first assigned.
         * @type {Map<string, {x:number, y:number}>}
         */
        this._autoSlots = new Map();
        /** Cached netlist from last sync */
        this.netlist = [];

        /**
         * Tracks (routed copper traces) on the board. The autorouter pushes
         * here via the autorouter-adapter; the interactive Track tool (Phase
         * 2) will push here too. Each entry is a Track shape instance.
         * @type {Array<import('../shapes/track.js').Track>}
         */
        this.tracks = [];

        /**
         * Standalone vias (e.g. ground-plane stitching). Vias implied by
         * a Track changing layer at a node are NOT stored here — they live
         * inside the Track itself.
         * @type {Array<import('../shapes/via.js').Via>}
         */
        this.vias = [];

        /**
         * Standalone non-plated through-holes (mounting / tooling holes).
         * @type {Array<import('../shapes/hole.js').Hole>}
         */
        this.holes = [];

        /**
         * Copper pour regions (net-aware flood fills). Each entry is a
         * CopperFill (user-authored outline + layer + net); the poured
         * copper geometry is computed live by the fill engine.
         * @type {Array<import('../shapes/copper-fill.js').CopperFill>}
         */
        this.copperFills = [];
        /** Currently selected CopperFill, or null. */
        this._selectedFill = null;
        /** Currently selected free-standing circle, or null. */
        this._selectedCircle = null;

        /** True when the schematic has changed since last PCB rebuild */
        this._stale = true;
        /** Debounce timer for live rebuilds while PCB pane is active */
        this._syncTimer = null;
        /** Whether change listeners have been installed on the schematic */
        this._listening = false;
        /** True after the first sync (governs fitToBounds) */
        this._hasContent = false;
        /** Whether the board outline has been drawn */
        this._boardOutlineDrawn = false;
        /** Whether the board outline is currently selected */
        this._boardOutlineSelected = false;
        /** Board dimensions in mm */
        this._boardWidth = 100;
        this._boardHeight = 80;
        this._boardRadius = 0;
        /** UI element refs (set by controls.js) */
        this.ui = null;

        // ── Selection & drag state ────────────────────────────
        /** Currently selected component ID, or null */
        this._selectedComp = null;
        /** Component ID currently showing a hover outline, or null */
        this._hoveredComp = null;
        /** Drag state: { compId, startWorld, startPos } or null */
        this._drag = null;
        /**
         * Box (marquee) multi-selection state. Populated lazily by the
         * box-select module: { comps:Set, tracks:Set, vias:Set }.
         * @type {{comps:Set, tracks:Set, vias:Set}|null}
         */
        this._boxSel = null;
        /** Pending marquee arm (before the drag threshold), or null */
        this._boxSelectArm = null;
        /** True while a marquee is actively being dragged */
        this._boxSelectActive = false;
        /** Group-drag state for a box selection, or null */
        this._groupDrag = null;

        /**
         * Free-standing text annotations placed by the user.
         * Map<id, text> where text matches createPcbText() shape.
         * @type {Map<string, object>}
         */
        this.texts = new Map();
        /** SVG <g> elements keyed by text id for quick remove/replace. */
        this._textElements = new Map();
        /** Currently selected text object, or null. */
        this._selectedText = null;
        /** Active text drag: { textId, startWorld, startPos } or null. */
        this._textDrag = null;
        /** Component ID whose reference designator is currently selected, or null. */
        this._selectedRef = null;
        /** Active reference-text drag: { compId, startWorld, startDx, startDy } or null. */
        this._refDrag = null;
        /** Active circle drag: { circleId, startWorld, startPos } or null. */
        this._circleDrag = null;
        /** Overlay <g> for the ref-text selection box and drag tether. */
        this._refOverlay = null;
        /** Defaults for the Text tool (modifiable via tool options). */
        this._textDefaults = { size: 1.0, rotation: 0, layer: 'top-silk', strokeWidth: 0.15 };
        /** Defaults for the Circle tool. */
        this._circleDefaults = { lineWidth: 0.2 };
        /** Last typed content for the Text tool. */
        this._lastTextContent = 'Text';
        /** In-memory PCB clipboard payload. */
        this._pcbClipboard = null;
        /** Monotonic paste counter (used for visible paste offsets). */
        this._pcbPasteCount = 0;
        /** Free-standing silkscreen circles. */
        this.circles = [];
        /** SVG circle elements keyed by circle id for quick remove/replace. */
        this._circleElements = new Map();
        /** Circle currently hovered in select mode, or null. */
        this._hoveredCircle = null;
        /** Active in-progress circle draw interaction, or null. */
        this._circleDraw = null;
        /** Monotonic id counter for free-standing circles. */
        this._circleIdCounter = 1;
        /** Active paste-drop interaction (pasted items glued to cursor). */
        this._pasteDrop = null;
        /** Suspend live copper-fill recompute while floating paste is active. */
        this._suspendFillRefresh = false;
        /** Whether a fill refresh was requested while suspended. */
        this._fillRefreshPending = false;
        /** Suspend external 2D/3D panel refresh while floating paste is active. */
        this._suspendBoardViewRefresh = false;

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
            onChanged: () => {
                this._markDirty();
                this._syncHistoryButtons?.();
            },
        });
        /** Debug tooltip for showing raw footprintShapes data */
        this._debugTooltip = null;
        this._debugTooltipVisible = false;
        this._debugTooltipPinned = false;
        this._showDebugTooltip = false;
        /** Transient message bubble shown over a component, or null. */
        this._componentPopup = null;
        /** Autoroute progress/cancel runtime state */
        this._routeCancelToken = null;
        this._routeWorker = null;
        this._routeProgressStartMs = 0;
        this._routeProgressTimer = null;
        /** @type {Map<string, boolean>} pending net visibility updates */
        this._ratsnestVisibilityQueue = new Map();
        this._ratsnestVisibilityRaf = 0;
        /** @type {Map<string, boolean>|null} net -> is unrouted */
        this._routeNetUnrouted = null;
        this._routeLastBoundaryKey = '';
        /** @type {object|null} Stored test board RouteInput for direct routing */
        this._testBoardRouteInput = null;
        this._routeProgressState = {
            done: 0,
            total: 1,
            netName: 'Starting...',
            phase: 'initial',
            pendingConnections: 0,
            pendingNets: 0,
            ripupDone: 0,
            ripupTotal: 0,
            ripupPass: 0,
            ripupMaxPasses: 4,
        };
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

    activate() {
        this.initialize();
        this._active = true;

        this._ensureViewport();
        this._hookSchematicChanges();
        this._updateCursorForTool();
        this._syncPcbHomeToolHighlight?.();
        this.viewport?._onResize?.();
        this._updateViewportStatus();
        this.syncPcbViewToggles?.();
        this._updateGridDropdown();

        // Rebuild if schematic changed while we were away
        if (this._stale) this._syncFromSchematic();

        this._setPcbStatus();
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
        this._active = false;
    }

    _setPcbStatus() {
        if (!this.status.modeStatus) return;
        const rawTool = this.currentTool || 'select';
        const toolLabel = rawTool.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        const layerLabel = this.activeLayer?.replace(/-/g, ' ')?.replace(/\b\w/g, c => c.toUpperCase()) || 'Top Copper';
        this.status.modeStatus.textContent = `${toolLabel} | ${layerLabel}`;
        this._syncClipboardButtons?.();
        this._syncHistoryButtons?.();
    }

    /** Enable/disable PCB home-tab Undo/Redo buttons from history state. */
    _syncHistoryButtons() {
        const undoBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('pcbUndoBtn'));
        const redoBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('pcbRedoBtn'));
        const canUndo = !!this.history?.canUndo?.();
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
            || (c.holes?.length || 0) > 0
            || (c.texts?.length || 0) > 0
            || (c.fills?.length || 0) > 0
        );
    }

    /** Whether current selection can be copied/cut from PCB. */
    _canCopyCutPcbSelection() {
        if (hasBoxSelection(this)) {
            const s = this._boxSel;
            return !!s && ((s.tracks?.size || 0) > 0 || (s.vias?.size || 0) > 0 || (s.holes?.size || 0) > 0);
        }
        if (this._selectedComp || this._selectedRef) return false;
        return !!(this._selectedTrack || this._selectedVia || this._selectedHole || this._selectedText || this._selectedFill);
    }

    /** Enable/disable PCB ribbon clipboard buttons to match current state. */
    _syncClipboardButtons() {
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
        const payload = { tracks: [], vias: [], holes: [], texts: [], fills: [] };
        if (hasBoxSelection(this)) {
            const s = this._boxSel;
            for (const t of (s?.tracks || [])) payload.tracks.push(t.toJSON());
            for (const v of (s?.vias || [])) payload.vias.push(v.toJSON());
            for (const h of (s?.holes || [])) payload.holes.push(h.toJSON());
        } else if (this._selectedTrack) {
            payload.tracks.push(this._selectedTrack.toJSON());
        } else if (this._selectedVia) {
            payload.vias.push(this._selectedVia.toJSON());
        } else if (this._selectedHole) {
            payload.holes.push(this._selectedHole.toJSON());
        } else if (this._selectedText) {
            payload.texts.push(serializePcbText(this._selectedText));
        } else if (this._selectedFill) {
            payload.fills.push(this._selectedFill.captureState());
        }
        if (!payload.tracks.length && !payload.vias.length && !payload.holes.length
            && !payload.texts.length && !payload.fills.length) return null;
        return payload;
    }

    /** Copy currently-selected PCB entities (except components). */
    copySelection() {
        const payload = this._capturePcbClipboardSelection();
        if (!payload) {
            if (this._selectedComp || this._selectedRef) {
                this._showComponentPopup(this._selectedComp || this._selectedRef,
                    "Components can't be copied from PCB. Copy them in the schematic editor.");
            }
            this._syncClipboardButtons();
            return false;
        }
        this._pcbClipboard = payload;
        this._pcbPasteCount = 0;
        this._syncClipboardButtons();
        return true;
    }

    /** Cut currently-selected PCB entities (copy + remove). */
    cutSelection() {
        if (!this.copySelection()) return false;
        if (hasBoxSelection(this)) {
            deleteBoxSelection(this);
            this._syncClipboardButtons();
            return true;
        }
        if (this._selectedText) {
            this._deleteSelectedText();
            this._syncClipboardButtons();
            return true;
        }
        if (this._selectedTrack || this._selectedVia || this._selectedHole) {
            deleteSelectedTrack(this);
            this._syncClipboardButtons();
            return true;
        }
        if (this._selectedFill) {
            this.deleteSelectedFill();
            this._syncClipboardButtons();
            return true;
        }
        if (this._selectedCircle) {
            this.deleteSelectedCircle();
            this._syncClipboardButtons();
            return true;
        }
        return false;
    }

    /**
     * Start cursor-glued drop mode for freshly pasted entities. The pasted
     * objects move as one bundle with the cursor until the next left click.
     */
    _beginPasteDrop(payload, historyDepthBeforePaste = null) {
        const base = this._snapToGrid(this.viewport?.currentMouseWorld || { x: 0, y: 0 });
        const points = [];
        for (const t of (payload.tracks || [])) {
            for (const [, n] of t.nodes) points.push({ x: n.x, y: n.y });
        }
        for (const v of (payload.vias || [])) points.push({ x: v.x, y: v.y });
        for (const h of (payload.holes || [])) points.push({ x: h.x, y: h.y });
        for (const t of (payload.texts || [])) points.push({ x: t.x, y: t.y });
        for (const f of (payload.fills || [])) {
            for (const p of (f.outline || [])) points.push({ x: p.x, y: p.y });
        }
        const anchor = points.length
            ? {
                x: points.reduce((s, p) => s + p.x, 0) / points.length,
                y: points.reduce((s, p) => s + p.y, 0) / points.length,
            }
            : { x: base.x, y: base.y };
        this._pasteDrop = {
            historyDepthBeforePaste,
            anchorWorld: { x: anchor.x, y: anchor.y },
            tracks: (payload.tracks || []).map((t) => {
                const nodes = new Map();
                for (const [nid, n] of t.nodes) nodes.set(nid, { x: n.x, y: n.y });
                return { track: t, nodes };
            }),
            vias: (payload.vias || []).map((v) => ({ via: v, x: v.x, y: v.y })),
            holes: (payload.holes || []).map((h) => ({ hole: h, x: h.x, y: h.y })),
            texts: (payload.texts || []).map((t) => ({ text: t, x: t.x, y: t.y })),
            fills: (payload.fills || []).map((f) => ({
                fill: f,
                outline: Array.isArray(f.outline)
                    ? f.outline.map((p) => ({ x: p.x, y: p.y }))
                    : [],
            })),
        };
        if (this.viewport?.svg) this.viewport.svg.style.cursor = 'crosshair';
        // Place immediately at the current cursor location.
        this._updatePasteDrop(base);
    }

    /** Live-update the pasted bundle position while in paste-drop mode. */
    _updatePasteDrop(worldPos) {
        const pd = this._pasteDrop;
        if (!pd) return;
        const snap = this._snapToGrid(worldPos);
        const dx = snap.x - pd.anchorWorld.x;
        const dy = snap.y - pd.anchorWorld.y;

        // Force a visible crosshair while a paste bundle is floating,
        // independent of the currently selected tool.
        this.viewport?.setCrosshair({ x: snap.x, y: snap.y });
        if (this.viewport?.svg) this.viewport.svg.style.cursor = 'crosshair';

        for (const t of pd.tracks) {
            for (const [nid, start] of t.nodes) {
                const n = t.track.nodes.get(nid);
                if (!n) continue;
                n.x = start.x + dx;
                n.y = start.y + dy;
            }
            renderTrack(t.track, (id) => this._getLayerGroup(id), {
                viaDiameter: this._getRoutingParams?.()?.viaDiameter,
                viaDrill: this._getRoutingParams?.()?.viaDrill,
                hideNetLabel: t.track === this._selectedTrack,
            });
        }
        for (const v of pd.vias) {
            v.via.x = v.x + dx;
            v.via.y = v.y + dy;
            renderVia(v.via, (id) => this._getLayerGroup(id));
        }
        for (const h of pd.holes) {
            h.hole.x = h.x + dx;
            h.hole.y = h.y + dy;
            renderHole(h.hole, (id) => this._getLayerGroup(id));
        }
        for (const t of pd.texts) {
            t.text.x = t.x + dx;
            t.text.y = t.y + dy;
            this._refreshText(t.text.id);
        }
        for (const f of pd.fills) {
            f.fill.outline = f.outline.map((p) => ({ x: p.x + dx, y: p.y + dy }));
            renderCopperFill(f.fill, (id) => this._getLayerGroup(id),
                { selected: this._selectedFill === f.fill });
            if (this._selectedFill === f.fill) this._renderFillHandles(f.fill);
        }
        refreshTrackSelectionHalo(this);
    }

    /** Finish paste-drop mode and keep the pasted entities at their current position. */
    _endPasteDrop() {
        if (!this._pasteDrop) return;
        this._pasteDrop = null;
        this._suspendFillRefresh = false;
        this._suspendBoardViewRefresh = false;
        if (this._fillRefreshPending) {
            this._fillRefreshPending = false;
            this._refreshFills?.();
        }
        this._board3d?.refresh?.();
        this._updateCursorForTool?.();
        // Keep derived visuals coherent after the final drop position.
        reconcileRatsnest(this);
        this._syncClipboardButtons?.();
    }

    /** Cancel paste-drop mode and remove the freshly pasted entities. */
    _cancelPasteDrop() {
        const pd = this._pasteDrop;
        if (!pd) return;
        this._pasteDrop = null;
        const before = pd.historyDepthBeforePaste;
        if (Number.isFinite(before) && (this.history?.undoStack?.length || 0) > before) {
            this.history.undo();
        }
        this._suspendFillRefresh = false;
        this._suspendBoardViewRefresh = false;
        if (this._fillRefreshPending) {
            this._fillRefreshPending = false;
            this._refreshFills?.();
        }
        this._board3d?.refresh?.();
        this._updateCursorForTool?.();
        this._syncClipboardButtons?.();
    }

    /** Paste the current PCB clipboard payload with a small positional offset. */
    pasteSelection() {
        if (!this._hasPcbClipboardData()) {
            this._syncClipboardButtons();
            return false;
        }
        const c = this._pcbClipboard;
        this._pcbPasteCount = (this._pcbPasteCount || 0) + 1;
        const d = 2 * this._pcbPasteCount; // mm offset per successive paste
        const cmds = [];
        const pasted = { tracks: [], vias: [], holes: [], texts: [], fills: [] };

        for (const td of (c.tracks || [])) {
            const json = JSON.parse(JSON.stringify(td));
            delete json.id; delete json.i;
            const t = createShape(json);
            if (!(t instanceof Track)) continue;
            for (const [, n] of t.nodes) { n.x += d; n.y += d; }
            cmds.push(new AddTrackCommand(this, t));
            pasted.tracks.push(t);
        }
        for (const vd of (c.vias || [])) {
            const via = Via.fromJSON({ ...vd, id: undefined });
            via.x += d; via.y += d;
            cmds.push(new AddViaCommand(this, via));
            pasted.vias.push(via);
        }
        for (const hd of (c.holes || [])) {
            const hole = Hole.fromJSON({ ...hd, id: undefined });
            hole.x += d; hole.y += d;
            cmds.push(new AddHoleCommand(this, hole));
            pasted.holes.push(hole);
        }
        for (const tx of (c.texts || [])) {
            const t = createPcbText({ ...tx, id: undefined, x: (tx.x || 0) + d, y: (tx.y || 0) + d });
            cmds.push(new AddTextCommand(this, t));
            pasted.texts.push(t);
        }
        for (const fd of (c.fills || [])) {
            const outline = Array.isArray(fd.outline) ? fd.outline.map((p) => ({ x: (p.x || 0) + d, y: (p.y || 0) + d })) : [];
            const fill = new CopperFill({ layer: fd.layer, net: fd.net || '', outline });
            cmds.push(new AddFillCommand(this, fill));
            pasted.fills.push(fill);
        }
        if (!cmds.length) return false;
        this._suspendFillRefresh = true;
        this._fillRefreshPending = false;
        this._suspendBoardViewRefresh = true;
        const depthBeforePaste = this.history?.undoStack?.length || 0;
        this.history.execute(cmds.length === 1 ? cmds[0] : new CompoundCommand(cmds));
        this._beginPasteDrop(pasted, depthBeforePaste);
        this._syncClipboardButtons();
        return true;
    }

    _ensureViewport() {
        if (this.viewport || !this.canvasContainer) return;

        this.viewport = new Viewport(this.canvasContainer);

        this.viewport.onMouseMove = (worldPos, snappedPos) => {
            if (!this._active) return;
            if (this.status.cursorPos) {
                this.status.cursorPos.textContent = `${worldPos.x.toFixed(2)}, ${worldPos.y.toFixed(2)} mm`;
            }
            if (this.status.gridSnap) {
                this.status.gridSnap.textContent = `${snappedPos.x.toFixed(2)}, ${snappedPos.y.toFixed(2)} mm`;
            }
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
            // Selection halo node handles are sized in screen pixels, so they
            // must be redrawn when the zoom scale changes to stay constant on
            // screen. (Pan doesn't change scale, so skip the churn then.)
            const sc = this.viewport?.scale || 1;
            if (sc !== this._lastHaloScale && (this._selectedTrack || this._selectedVia)) {
                this._lastHaloScale = sc;
                refreshTrackSelectionHalo(this);
            }
            // Cursor crosshair (track/via tools) is sized in screen pixels
            // and spans the viewport — redraw on zoom/pan so it doesn't drift.
            if (this._lastCrosshairWorld &&
                (this.currentTool === 'via' || this.currentTool === 'track' || this.currentTool === 'text' || this.currentTool === 'circle')) {
                if (this.currentTool === 'via') {
                    this._updateViaPreview(this._lastCrosshairWorld);
                } else {
                    this._updateCursorCrosshair(this._lastCrosshairWorld);
                }
            }
            // Re-evaluate footprint culling / level-of-detail after zoom or pan.
            this._updatePcbCulling();
            // The copper-removal clip rectangle is sized to the visible
            // viewport (so its raster never blows up at high zoom); re-fit it
            // to the new view whenever a cut is active.
            if (this._hasCopperCuts) this._updateCopperCuts();
            // Keep the DRC panel→marker leader anchored to the board point.
            if (this._drcSelectedId) this._updateDRCConnector();
        };

        // Throttled footprint culling during an active pan (Viewport rAF).
        this.viewport.onViewportCull = () => {
            if (!this._active) return;
            this._updatePcbCulling();
            // Keep the copper-removal clip rectangle following the viewport
            // during a live pan (viewBox moves without firing onViewChanged).
            if (this._hasCopperCuts) this._updateCopperCuts();
            // The viewBox moves continuously during a pan without firing
            // onViewChanged, so keep the DRC leader anchored here too.
            if (this._drcSelectedId) this._updateDRCConnector();
        };

        // Hide the clearance overlay during a pan. Its halos are transient
        // non-scaling-stroke polygons that re-tessellate on every viewBox
        // change (the dominant pan repaint cost); you can't edit mid-pan, so
        // drop them for the gesture and restore in place on release. No
        // recompute is needed — the geometry is in world space and pans with
        // the viewBox.
        this.viewport.onPanStart = () => {
            this._hideNetTooltip();
            if (!this._active || !this._clearancesVisible) return;
            const ov = this._layerGroups.get('clearance-overlay');
            if (ov) ov.style.display = 'none';
        };
        this.viewport.onPanEnd = () => {
            if (!this._active) return;
            const ov = this._layerGroups.get('clearance-overlay');
            if (ov && this._clearancesVisible) ov.style.display = '';
        };

        // Bind mouse events for panning
        this._bindMouseEvents();

        // Create SVG layer groups (one <g> per PCB layer, in z-order)
        this._createLayerGroups();

        // Push any restored eye/lock state (from a prior session) into the
        // freshly-created render groups so the artwork matches the panel.
        this._applyLayerPrefsToRender();

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
            // Freshly pasted entities are glued to the cursor; the first
            // left-click drops them at their current position.
            if (this._pasteDrop && e.button === 0) {
                e.preventDefault();
                this._endPasteDrop();
                return;
            }
            // A floating vertex move drops on the next left-click. This covers
            // both the context-menu "Split" drag and a node/midpoint that was
            // click-armed into move mode (click to grab, move, click to place).
            // Consume that click here so it commits instead of starting a new
            // interaction.
            if (this._vertexDrag?.floating && e.button === 0) {
                this._vertexDrag.floating = false;
                this._vertexDragDownScreen = null;
                finishVertexDrag(this);
                this.viewport.hideCrosshair();
                svg.style.cursor = 'default';
                if (this._selectedTrack) {
                    const t = this._selectedTrack;
                    clearTrackSelection(this);
                    selectTrackOrVia(this, { type: 'track', track: t });
                }
                return;
            }
            // Switch ribbon back to Home tab on canvas click — but NOT
            // while we're drawing a track (the Track tool drives the
            // Properties tab so its width spinner stays visible), and
            // NOT while inline-editing text (the Properties tab hosts
            // the text's size/rotation spinners), and NOT on a right-button
            // press (that starts a pan — dragging the board must not switch
            // tabs, e.g. closing the Design tab's live DRC mid-pan).
            if (!this._trackDraw && !this._textEdit && e.button !== 2) {
                const activeTab = this.ribbon?.querySelector('.ribbon-tab.active');
                if (activeTab instanceof HTMLElement && activeTab.dataset?.tab !== 'pcb-home') {
                    this._setActiveRibbonTab?.('pcb-home');
                }
            }
            // Inline text edit: any left-click on the canvas commits
            // the current edit. (Right-click is reserved for pan and
            // must not commit.) If the text tool is active, the
            // text-tool branch below will then place a new text.
            if (this._textEdit && e.button === 0) {
                this._endTextInlineEdit(true);
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
                this.viewport.startPan(e.clientX, e.clientY);
                return;
            }

            // Left-click with select tool: hit-test for a track/via first
            // (smaller targets win when they overlap a component), then
            // fall back to component / board-outline selection.
            if (e.button === 0 && this.currentTool === 'select') {
                const worldPos = this._screenToWorld(e);

                // Box-selection group drag: clicking on any member of an
                // active multi-selection moves the whole group together.
                // Clicking elsewhere drops the multi-selection and falls
                // through to normal single-object selection below.
                if (hasBoxSelection(this)) {
                    if (pointInBoxSelection(this, worldPos)) {
                        // Clear the hover halo before dragging: hover updates
                        // are suppressed during a drag, so a leftover hover X
                        // (e.g. on a hole/via) would otherwise sit at the
                        // original position the whole drag.
                        setHoverHighlight(this, null);
                        this._hoverComponent(null);
                        beginGroupDrag(this, worldPos);
                        this._hideNetTooltip();
                        svg.style.cursor = 'grabbing';
                        return;
                    }
                    clearBoxSelection(this);
                }

                // Continue interacting with an already-selected fill: grab a
                // vertex or drag the whole region without re-clicking.
                if (this._selectedFill) {
                    if (this._startFillDrag(this._selectedFill, worldPos, e)) {
                        setHoverHighlight(this, null);
                        this._hideNetTooltip();
                        svg.style.cursor = 'grabbing';
                        return;
                    }
                }
                // Any other click drops the current fill selection (it may be
                // re-selected below if the click lands on a fill region).
                this._selectFill(null);
                this._selectCircle(null);

                // If a track is already selected, try to start a vertex
                // drag on it before doing anything else — this lets the
                // user grab a node or bend a segment without re-clicking.
                if (this._selectedTrack) {
                    if (startVertexDrag(this, this._selectedTrack, worldPos)) {
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
                        return;
                    }
                }
                // Same for a selected via: clicking on the via begins a
                // drag without losing the selection.
                if (this._selectedVia) {
                    if (startViaDrag(this, this._selectedVia, worldPos)) {
                        setHoverHighlight(this, null);
                        this._hideNetTooltip();
                        svg.style.cursor = 'grabbing';
                        return;
                    }
                }
                // Same for a selected hole: clicking on it begins a drag.
                if (this._selectedHole) {
                    if (startHoleDrag(this, this._selectedHole, worldPos)) {
                        setHoverHighlight(this, null);
                        this._hideNetTooltip();
                        svg.style.cursor = 'grabbing';
                        return;
                    }
                }
                // Same for a selected free-standing circle.
                if (this._selectedCircle) {
                    const selectedHit = this._hitTestCircle(worldPos);
                    if (selectedHit && selectedHit.id === this._selectedCircle.id) {
                        if (this._startCircleDrag(selectedHit, worldPos)) {
                            setHoverHighlight(this, null);
                            this._hideNetTooltip();
                            svg.style.cursor = 'grabbing';
                            return;
                        }
                    }
                }

                // The click isn't continuing a drag of the current
                // selection, so the selected track (if any) is about to be
                // deselected or replaced. Tidy away any redundant collinear
                // waypoints first — e.g. a node added by double-click but
                // never moved is collinear by definition and is removed here.
                if (this._selectedTrack) {
                    commitCollinearCleanup(this, this._selectedTrack);
                }

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
                    } else if (trackHit.type === 'hole') {
                        if (startHoleDrag(this, trackHit.hole, worldPos)) {
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

                const circleHit = this._hitTestCircle(worldPos);
                if (circleHit) {
                    this._selectComponent(null);
                    this._selectBoardOutline(false);
                    this._selectText(null);
                    this._selectRefText(null);
                    this._selectFill(null);
                    this._selectCircle(circleHit);
                    this._showCircleProperties(circleHit);
                    if (this._startCircleDrag(circleHit, worldPos)) {
                        this._hideNetTooltip();
                        svg.style.cursor = 'grabbing';
                    }
                    return;
                }
                this._selectCircle(null);

                // Text hit-test (above components in z-order).
                const textHit = this._hitTestText(worldPos);
                if (textHit) {
                    this._selectComponent(null);
                    this._selectBoardOutline(false);
                    this._selectText(textHit);
                    this._showTextProperties(textHit);
                    this._textDrag = {
                        textId: textHit.id,
                        startWorld: worldPos,
                        startPos: { x: textHit.x, y: textHit.y },
                    };
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
                    const rpl = this.placements.get(refHit);
                    this._refDrag = {
                        compId: refHit,
                        startWorld: worldPos,
                        startDx: rpl?.refDx || 0,
                        startDy: rpl?.refDy || 0,
                    };
                    this._drawRefOverlay(refHit, true);
                    this._showRefProperties(refHit);
                    svg.style.cursor = 'grabbing';
                    return;
                }
                this._selectRefText(null);

                const hit = this._hitTestComponent(worldPos);
                if (hit) {
                    this._selectComponent(hit);
                    this._selectBoardOutline(false);
                    this._showComponentProperties(hit);
                    const pl = this.placements.get(hit);
                    if (pl) {
                        // Clear the hover net-highlight before dragging: hover
                        // updates are suppressed while a drag is active, so a
                        // leftover halo would otherwise sit at the component's
                        // original position the whole drag.
                        setHoverHighlight(this, null);
                        this._hoverComponent(null);
                        this._hideNetTooltip();
                        this._drag = {
                            compId: hit,
                            startWorld: worldPos,
                            startPos: { x: pl.x, y: pl.y },
                            // Nets this component participates in. Only these
                            // move during the drag, so the live ratsnest
                            // rebuild is restricted to them (incremental mode)
                            // instead of recomputing the whole board each frame.
                            nets: this._netsForComponent(hit),
                        };
                        // Defer the expensive derived overlays (copper pours +
                        // clearance halos) until the drag ends; they're rebuilt
                        // once in _endDrag. Live ratsnest still updates.
                        this._deferDragOverlays = true;
                        // Hide only the DRAGGED component's clearance halos for
                        // the duration of the drag — its pad halos would track
                        // the component (forcing per-frame repaints of that
                        // geometry) and its connected-track halos would freeze
                        // stale. Every other component's halos stay visible so
                        // the user can still judge clearances while placing.
                        // _endDrag rebuilds the whole overlay at the drop point.
                        if (this._clearancesVisible) {
                            const g = this._padHaloGroups?.get(hit);
                            if (g) g.style.display = 'none';
                            // Also hide the halos of the nets this component
                            // moves: their bonded tracks/vias shift mid-drag,
                            // so the deferred (not-recomputed) halo would
                            // otherwise sit stranded at the old track position.
                            const ov = this._layerGroups.get('clearance-overlay');
                            if (ov) {
                                for (const net of this._drag.nets) {
                                    for (const el of ov.querySelectorAll(`.debug-clearance[data-net="${CSS.escape(net)}"]`)) {
                                        /** @type {SVGElement} */ (el).style.display = 'none';
                                    }
                                }
                                // Promote the (now-static) clearance overlay to
                                // its own GPU compositing layer for the drag.
                                // Otherwise every frame's board-wide mutations
                                // (ratsnest rebuild, bonded-track re-render)
                                // invalidate the overlapping halo geometry and
                                // force the browser to repaint thousands of
                                // non-scaling-stroke vectors — the real per-
                                // frame cost. On its own layer the overlay just
                                // composites; it never repaints.
                                ov.style.willChange = 'transform';
                            }
                        }
                        svg.style.cursor = 'grabbing';
                    }
                } else if (this._hitTestBoardOutline(worldPos)) {
                    this._selectComponent(null);
                    this._selectFill(null);
                    this._selectBoardOutline(true);
                    this._showBoardOutlineProperties();
                } else if (this._hitTestFill(worldPos)) {
                    this._selectComponent(null);
                    this._selectBoardOutline(false);
                    this._selectFill(this._hitTestFill(worldPos));
                    this._showFillProperties(this._selectedFill);
                } else {
                    this._selectComponent(null);
                    this._selectBoardOutline(false);
                    this._selectFill(null);
                    this._clearProperties();
                    // Empty canvas: arm a box-select. The marquee only
                    // materialises once the pointer crosses the drag
                    // threshold (see the mousemove handler).
                    armBoxSelect(this, { x: e.clientX, y: e.clientY }, worldPos);
                }
            }

            // Left-click with track tool: start a new track or add a waypoint.
            if (e.button === 0 && this.currentTool === 'track') {
                const worldPos = this._screenToWorld(e);
                // Can't draw on a locked layer.
                if (!this._trackDraw && isLayerLocked(this.activeLayer)) return;
                if (this._trackDraw) {
                    addTrackWaypoint(this, worldPos);
                } else {
                    startTrackDraw(this, worldPos);
                }
            }

            // Left-click with fill tool: start a new pour region or add a vertex.
            if (e.button === 0 && this.currentTool === 'fill') {
                const worldPos = this._screenToWorld(e);
                if (this._fillDraw) {
                    addFillWaypoint(this, worldPos);
                } else {
                    startFillDraw(this, worldPos);
                }
            }

            // Left-click with via tool: place a standalone via at the cursor.
            if (e.button === 0 && this.currentTool === 'via') {
                const worldPos = this._screenToWorld(e);
                // A via spans both copper layers — refuse if either is locked.
                if (isViaLocked()) return;
                const snap = resolveTrackSnap(this, worldPos, {});
                const p = this._getRoutingParams?.() || {};
                const diameter = Number.isFinite(p.viaDiameter) && p.viaDiameter > 0 ? p.viaDiameter : 0.6;
                const drill = Number.isFinite(p.viaDrill) && p.viaDrill > 0 ? p.viaDrill : 0.3;

                if (snap.snapType === 'pad' || snap.snapType === 'track-node') {
                    // Landed on an existing pad / track node: attach the via
                    // there and inherit that net (the via sits on a node).
                    const net = snap.pad?.net || snap.trackNode?.track?.net || '';
                    const via = new Via({ x: snap.x, y: snap.y, diameter, drill, net });
                    this.history.execute(new AddViaCommand(this, via));
                } else {
                    // Mid-segment? Split the host track so the via lands on a
                    // node of each resulting half (both keep the track's net).
                    const split = findSplittableTrackEdge(this, worldPos);
                    if (split) {
                        const via = new Via({
                            x: split.px, y: split.py, diameter, drill,
                            net: split.track.net || '',
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
                        const via = new Via({ x: snap.x, y: snap.y, diameter, drill, net: '' });
                        this.history.execute(new AddViaCommand(this, via));
                    }
                }
            }

            // Left-click with hole tool: place a standalone NPTH at the cursor.
            if (e.button === 0 && this.currentTool === 'hole') {
                const worldPos = this._screenToWorld(e);
                const snap = this._snapToGrid(worldPos);
                const diameter = this._getHoleDiameter();
                const hole = new Hole({ x: snap.x, y: snap.y, diameter });
                this.history.execute(new AddHoleCommand(this, hole));
            }

            // Left-click with circle tool: first click anchors center,
            // second click commits radius.
            if (e.button === 0 && this.currentTool === 'circle') {
                const worldPos = this._screenToWorld(e);
                if (this._circleDraw) this._finishCircleDraw(worldPos);
                else this._startCircleDraw(worldPos);
            }

            // Left-click with text tool: place a text at the cursor.
            if (e.button === 0 && this.currentTool === 'text') {
                const worldPos = this._screenToWorld(e);
                const snap = this._snapToGrid(worldPos);
                // Place on the active edit layer if it can carry text,
                // else fall back to the tool-options default.
                const layer = TEXT_LAYERS.includes(this.activeLayer)
                    ? this.activeLayer
                    : this._textDefaults.layer;
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
        });

        svg.addEventListener('mousemove', (e) => {
            if (!this._active) return;
            if (this.viewport.isPanning) {
                this.viewport.updatePan(e.clientX, e.clientY);
                // Keep tool crosshairs anchored under the cursor while panning.
                if (this.currentTool === 'track' || this.currentTool === 'text') {
                    this._updateCursorCrosshair(this._screenToWorld(e));
                } else if (this.currentTool === 'via') {
                    this._updateViaPreview(this._screenToWorld(e));
                } else if (this.currentTool === 'hole') {
                    this._updateHolePreview(this._screenToWorld(e));
                } else if (this.currentTool === 'circle') {
                    this._updateCursorCrosshair(this._screenToWorld(e));
                }
            } else if (this._pasteDrop) {
                this._updatePasteDrop(this._screenToWorld(e));
            } else if (this._drag) {
                this._scheduleDragUpdate(e);
            } else if (this._groupDrag) {
                updateGroupDrag(this, this._screenToWorld(e));
            } else if (this._textDrag) {
                this._handleTextDrag(e);
            } else if (this._circleDrag) {
                this._handleCircleDrag(this._screenToWorld(e));
            } else if (this._refDrag) {
                this._handleRefDrag(e);
            } else if (this._vertexDrag) {
                // Distinguish a press-drag (mode 1, place on mouse-up) from a
                // click that arms move mode (mode 2, follow-the-mouse). Once the
                // pointer travels past the threshold while the button is held,
                // it is unambiguously a drag.
                if (!this._vertexDrag.floating && this._vertexDragDownScreen) {
                    const ddx = e.clientX - this._vertexDragDownScreen.x;
                    const ddy = e.clientY - this._vertexDragDownScreen.y;
                    if (Math.hypot(ddx, ddy) > 3) this._vertexDrag.userDragged = true;
                }
                updateVertexDrag(this, this._screenToWorld(e));
                this._updateVertexDragCrosshair();
            } else if (this._viaDrag) {
                updateViaDrag(this, this._screenToWorld(e));
            } else if (this._holeDrag) {
                updateHoleDrag(this, this._screenToWorld(e));
            } else if (this._fillDrag) {
                this._handleFillDrag(this._screenToWorld(e));
            } else if (this._trackDraw) {
                updateTrackDraw(this, this._screenToWorld(e));
                if (this._trackDraw?.snap) {
                    this._updateCursorCrosshair({ x: this._trackDraw.snap.x, y: this._trackDraw.snap.y });
                }
            } else if (this._fillDraw) {
                updateFillDraw(this, this._screenToWorld(e));
                if (this._fillDraw?.snap) {
                    this._updateCursorCrosshair({ x: this._fillDraw.snap.x, y: this._fillDraw.snap.y });
                }
            } else if (this._circleDraw) {
                this._updateCircleDraw(this._screenToWorld(e));
                this._updateCursorCrosshair(this._screenToWorld(e));
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
            } else if (this.currentTool === 'hole') {
                this._updateHolePreview(this._screenToWorld(e));
            } else if (this.currentTool === 'track') {
                this._updateCursorCrosshair(this._screenToWorld(e));
            } else if (this.currentTool === 'text') {
                this._updateCursorCrosshair(this._screenToWorld(e));
            } else if (this.currentTool === 'fill') {
                this._updateCursorCrosshair(this._screenToWorld(e));
            } else if (this.currentTool === 'circle') {
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

        const endInteraction = () => {
            if (!this._active) return;
            if (this.viewport.isPanning) {
                this.viewport.endPan();
                // Restore the tool's own cursor (Viewport.endPan resets
                // to 'grab' / default — text tool wants the T+crosshair).
                this._updateCursorForTool?.();
            }
            if (this._groupDrag) {
                endGroupDrag(this);
                svg.style.cursor = 'default';
            }
            // Finish (or discard) a marquee box-select. Safe to call even
            // when nothing was armed — it just clears the pending state.
            finishBoxSelect(this);
            if (this._drag) {
                this._endDrag();
            }
            if (this._textDrag) {
                this._endTextDrag();
            }
            if (this._circleDrag) {
                this._endCircleDrag(true);
                svg.style.cursor = 'default';
            }
            if (this._refDrag) {
                this._endRefDrag();
            }
            if (this._vertexDrag) {
                // Mode 2 (click to enter move mode): the node was pressed and
                // released without dragging. Instead of committing, keep the
                // drag alive as a floating node that follows the mouse and is
                // placed on the next click. Only single-node moves qualify;
                // segment drags always place on mouse-up.
                if (!this._vertexDrag.floating
                    && this._vertexDrag.mode === 'node'
                    && !this._vertexDrag.userDragged) {
                    this._vertexDrag.floating = true;
                    this._vertexDragDownScreen = null;
                    svg.style.cursor = 'grabbing';
                    this._updateVertexDragCrosshair();
                } else {
                    this._vertexDragDownScreen = null;
                    // A pure click (no drag) on a segment of the already-
                    // selected track refines down to that single segment.
                    const segmentClick = this._vertexDrag.mode === 'segment'
                        && !this._vertexDrag.userDragged
                        && this._segmentClickEdgeId;
                    const segEdgeId = this._segmentClickEdgeId;
                    finishVertexDrag(this);
                    this.viewport.hideCrosshair();
                    svg.style.cursor = 'default';
                    // Refresh the halo on the (possibly reshaped) selected track.
                    if (this._selectedTrack) {
                        const t = this._selectedTrack;
                        clearTrackSelection(this);
                        if (segmentClick && t.edges?.has(segEdgeId)) {
                            selectTrackSegment(this, t, segEdgeId);
                        } else {
                            selectTrackOrVia(this, { type: 'track', track: t });
                        }
                    }
                }
                this._segmentClickEdgeId = null;
            }
            if (this._viaDrag) {
                finishViaDrag(this);
                svg.style.cursor = 'default';
                // Refresh the halo on the moved via.
                if (this._selectedVia) {
                    const v = this._selectedVia;
                    clearTrackSelection(this);
                    selectTrackOrVia(this, { type: 'via', via: v });
                }
            }
            if (this._holeDrag) {
                finishHoleDrag(this);
                svg.style.cursor = 'default';
                // Refresh the halo on the moved hole.
                if (this._selectedHole) {
                    const h = this._selectedHole;
                    clearTrackSelection(this);
                    selectTrackOrVia(this, { type: 'hole', hole: h });
                }
            }
            if (this._fillDrag) {
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
            endInteraction();
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
        });

        // No mouseleave handler: leaving the canvas must NOT end an active
        // pan (or any drag). Movement freezes while the cursor is outside
        // (svg gets no mousemove) and resumes seamlessly on re-entry; the
        // window-level mouseup above ends the gesture wherever it's released.
        // This matches the schematic editor, which has no mouseleave handler.

        svg.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            // Track/via context menu — select tool only, and never while
            // drawing a track (right-click finishes the draw in that mode,
            // so there's no clash).
            if (!this._active) return;
            if (this.currentTool !== 'select' || this._trackDraw) return;
            const worldPos = this._screenToWorld(e);
            const hit = hitTestTrack(this, worldPos);
            if (hit) {
                // A right-click that started a pan must not leave the
                // viewport in panning state behind the menu.
                if (this.viewport.isPanning) this.viewport.endPan();
                showTrackContextMenu(this, hit, e.clientX, e.clientY, worldPos);
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
            this._clearHoleRing();
            return;
        }
        const t = this.currentTool;
        this.viewport.svg.style.cursor =
            t === 'pan' ? 'grab' :
            t === 'track' ? 'crosshair' :
            t === 'via' ? 'crosshair' :
            t === 'hole' ? 'crosshair' :
            t === 'circle' ? 'crosshair' :
            t === 'text' ? this._textToolCursor() :
            'default';
        if (t !== 'via') this._clearViaRing();
        if (t !== 'hole') this._clearHoleRing();
        if (t !== 'via' && t !== 'track' && t !== 'text' && t !== 'hole' && t !== 'circle') this._clearCursorCrosshair();
    }

    /** Crosshair + small "T" icon cursor for the text-placement tool. */
    _textToolCursor() {
        const stroke = '#ffffff';
        // Same shape as the schematic editor: white crosshair with a
        // little glyph drawn in the upper-right quadrant.
        const svgMarkup = `<?xml version="1.0" encoding="UTF-8"?>` +
            `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="-4 -6 26 26">` +
                `<path d="M 0 8 H 16 M 8 0 V 16" fill="none" stroke="${stroke}" stroke-width="1" stroke-linecap="round"/>` +
                `<g transform="translate(10 -2)">` +
                    `<path d="M 1 1 H 7 M 4 1 V 7" fill="none" stroke="${stroke}" stroke-width="1.4" stroke-linecap="round"/>` +
                `</g>` +
            `</svg>`;
        const encoded = encodeURIComponent(svgMarkup).replace(/'/g, '%27').replace(/"/g, '%22');
        return `url("data:image/svg+xml,${encoded}") 16 18, crosshair`;
    }

    /**
     * Show/update the drawing crosshair at the snapped cursor position.
     * Delegates the actual H+V lines to the shared Viewport crosshair so
     * schematic and PCB behave identically (and clear of the rulers).
     */
    _updateCursorCrosshair(worldPos) {
        if (!this.viewport) return;
        const snap = resolveTrackSnap(this, worldPos, {});
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
        const p = this._getRoutingParams?.() || {};
        const dia = Number.isFinite(p.viaDiameter) && p.viaDiameter > 0 ? p.viaDiameter : 0.6;
        const drill = Number.isFinite(p.viaDrill) && p.viaDrill > 0 ? p.viaDrill : 0.3;
        const scale = this.viewport.scale || 1;
        const stroke = 1 / scale;
        const accent = getComputedStyle(document.documentElement)
            .getPropertyValue('--accent-color').trim() || '#0098ff';

        let g = this._viaRingGroup;
        if (!g) {
            const NS = 'http://www.w3.org/2000/svg';
            g = document.createElementNS(NS, 'g');
            g.setAttribute('class', 'pcb-via-preview');
            g.setAttribute('pointer-events', 'none');
            const ring = document.createElementNS(NS, 'circle');
            ring.setAttribute('data-role', 'ring');
            ring.setAttribute('fill', 'none');
            const hole = document.createElementNS(NS, 'circle');
            hole.setAttribute('data-role', 'hole');
            hole.setAttribute('fill', 'none');
            g.appendChild(ring);
            g.appendChild(hole);
            svg.appendChild(g);
            this._viaRingGroup = g;
        }
        const ring = g.querySelector('[data-role="ring"]');
        const hole = g.querySelector('[data-role="hole"]');
        for (const el of [ring, hole]) el.setAttribute('stroke', accent);
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

    _clearViaPreview() {
        this._clearViaRing();
        this._clearCursorCrosshair();
    }

    /**
     * Hole tool default drill diameter (mm), read from the tool options
     * spinner if present, else a sensible mounting-hole default.
     */
    _getHoleDiameter() {
        const el = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbToolHoleDia'));
        const v = el ? parseFloat(el.value) : NaN;
        return Number.isFinite(v) && v > 0 ? v : 0.8;
    }

    /**
     * Hole tool preview: crosshair + outlined drilled hole at the snapped
     * cursor position.
     */
    _updateHolePreview(worldPos) {
        this._updateCursorCrosshair(worldPos);
        const svg = this.viewport?.svg;
        if (!svg) return;
        const snap = resolveTrackSnap(this, worldPos, {});
        const dia = this._getHoleDiameter();
        const scale = this.viewport.scale || 1;
        const stroke = 1 / scale;
        const accent = getComputedStyle(document.documentElement)
            .getPropertyValue('--accent-color').trim() || '#0098ff';

        let g = this._holeRingGroup;
        if (!g) {
            const NS = 'http://www.w3.org/2000/svg';
            g = document.createElementNS(NS, 'g');
            g.setAttribute('class', 'pcb-hole-preview');
            g.setAttribute('pointer-events', 'none');
            const ring = document.createElementNS(NS, 'circle');
            ring.setAttribute('data-role', 'ring');
            ring.setAttribute('fill', 'none');
            g.appendChild(ring);
            svg.appendChild(g);
            this._holeRingGroup = g;
        }
        const ring = g.querySelector('[data-role="ring"]');
        ring.setAttribute('stroke', accent);
        ring.setAttribute('cx', String(snap.x));
        ring.setAttribute('cy', String(snap.y));
        ring.setAttribute('r', String(dia / 2));
        ring.setAttribute('stroke-width', String(stroke * 1.5));
    }

    _clearHoleRing() {
        if (this._holeRingGroup) {
            this._holeRingGroup.remove();
            this._holeRingGroup = null;
        }
    }

    _clearHolePreview() {
        this._clearHoleRing();
        this._clearCursorCrosshair();
    }

    /** Public hook used by controls.setTool to abort an in-flight track draw. */
    _cancelTrackDraw() {
        if (this._trackDraw) cancelTrackDraw(this);
    }

    /** Public hook used by controls.setTool to abort an in-flight fill draw. */
    _cancelFillDraw() {
        if (this._fillDraw) cancelFillDraw(this);
    }

    /** Public hook used by controls.setTool to abort an in-flight circle draw. */
    _cancelCircleDraw() {
        const d = this._circleDraw;
        if (!d) return;
        if (d.preview?.parentNode) d.preview.parentNode.removeChild(d.preview);
        this._circleDraw = null;
    }

    _startCircleDraw(worldPos) {
        const targetLayer = this._resolveCircleDrawLayer(this.activeLayer);
        if (isLayerLocked(targetLayer)) return;
        const c = this._snapToGrid(worldPos);
        const NS = 'http://www.w3.org/2000/svg';
        const preview = document.createElementNS(NS, 'circle');
        preview.setAttribute('class', 'pcb-circle-preview');
        preview.setAttribute('fill', 'none');
        preview.setAttribute('stroke', '#66b3ff');
        preview.setAttribute('stroke-width', '0.2');
        preview.setAttribute('stroke-dasharray', '2 2');
        preview.setAttribute('vector-effect', 'non-scaling-stroke');
        preview.setAttribute('cx', String(c.x));
        preview.setAttribute('cy', String(c.y));
        preview.setAttribute('r', '0');
        this._getLayerGroup('selection-overlay')?.appendChild(preview);
        this._circleDraw = { center: c, preview, layer: targetLayer };
    }

    _resolveCircleDrawLayer(layerId) {
        const id = String(layerId || 'top-copper');
        // Circles drawn while paste/board-outline is the active edit layer
        // are authored on silk instead (top/bottom preserved where possible).
        if (id === 'top-paste' || id === 'bottom-paste' || id === 'board-outline') {
            return id.startsWith('bottom-') ? 'bottom-silk' : 'top-silk';
        }
        return id;
    }

    _updateCircleDraw(worldPos) {
        const d = this._circleDraw;
        if (!d) return;
        const p = this._snapToGrid(worldPos);
        const r = Math.hypot(p.x - d.center.x, p.y - d.center.y);
        d.preview?.setAttribute('r', String(r));
    }

    _finishCircleDraw(worldPos) {
        const d = this._circleDraw;
        if (!d) return;
        const p = this._snapToGrid(worldPos);
        const r = Math.hypot(p.x - d.center.x, p.y - d.center.y);
        if (d.preview?.parentNode) d.preview.parentNode.removeChild(d.preview);
        this._circleDraw = null;
        if (!Number.isFinite(r) || r < 0.05) return;
        const layer = d.layer || this.activeLayer;
        const alwaysFilled = layer === 'top-mask' || layer === 'bottom-mask'
            || layer === 'document' || layer === 'top-document' || layer === 'bottom-document';
        const circle = {
            id: `pcirc_${this._circleIdCounter++}`,
            x: d.center.x,
            y: d.center.y,
            radius: r,
            layer,
            lineWidth: this._circleDefaults.lineWidth,
            filled: alwaysFilled,
            copperMode: 'add',
        };
        this.history.execute(new AddCircleCommand(this, circle));
    }

    _renderCircle(circle) {
        this._removeCircleElement(circle.id);
        const NS = 'http://www.w3.org/2000/svg';
        const el = document.createElementNS(NS, 'circle');
        const isSelected = !!(this._selectedCircle && this._selectedCircle.id === circle.id);
        const isHovered = !!(this._hoveredCircle && this._hoveredCircle.id === circle.id);
        const layer = String(circle.layer || 'top-silk');
        const isHoleLayer = circle.layer === 'hole';
        const isCopperLayer = layer === 'top-copper' || layer === 'bottom-copper';
        const isMaskLayer = layer === 'top-mask' || layer === 'bottom-mask';
        const isDocumentLayer = layer === 'document' || layer === 'top-document' || layer === 'bottom-document';
        const copperMode = this._normalizeCircleCopperMode(circle.copperMode);
        const isCopperAdd = isCopperLayer && copperMode === 'add';
        const isCopperRemoveOnly = isCopperLayer && copperMode === 'remove-copper';
        const isCopperRemoveSolderMask = isCopperLayer && copperMode === 'remove-solder-mask';
        const isCopperRemoveMask = isCopperLayer && copperMode === 'remove-copper-mask';
        // Modes that actually subtract copper. The copper itself is cut by an
        // SVG mask (see _updateCopperCuts) so the dark canvas shows through —
        // the circle element here is just a thin, selectable boundary ring.
        const isCopperKnockout = isCopperRemoveOnly || isCopperRemoveMask;
        // Editor copper colours match the track renderer (track-render.js).
        const copperColor = layer === 'bottom-copper' ? '#3498db' : '#e74c3c';
        const MASK_OPENING_PREVIEW = '#c9a44a';
        const BARE_BOARD_COLOR = '#6e4e2a';
        const CUT_RING_COLOR = '#8a929b';
        el.setAttribute('cx', String(circle.x));
        el.setAttribute('cy', String(circle.y));
        el.setAttribute('r', String(circle.radius));
        // Filled discs: added copper (track colour), mask openings and document
        // shapes. Copper removals are never filled — the mask does the cutting.
        const filled = isCopperLayer
            ? isCopperAdd
            : (!isHoleLayer && (!!circle.filled || isMaskLayer || isDocumentLayer));
        const fillColor = isCopperAdd ? copperColor
            : isMaskLayer ? MASK_OPENING_PREVIEW
                : isDocumentLayer ? BARE_BOARD_COLOR
                    : '#ffffff';
        el.setAttribute('fill', filled ? fillColor : 'none');
        if (filled) {
            const fillOpacity = isCopperAdd ? '0.9'
                : isDocumentLayer ? '1'
                    : '0.18';
            el.setAttribute('fill-opacity', fillOpacity);
        }
        // Hole-layer circles read like drilled holes: transparent bore with
        // only a ring so the grid/background shows through.
        const baseStroke = isHoleLayer ? '#1abc9c'
            : isCopperAdd ? copperColor
                : isCopperKnockout ? CUT_RING_COLOR
                    : isCopperRemoveSolderMask ? MASK_OPENING_PREVIEW
                        : isMaskLayer ? MASK_OPENING_PREVIEW
                            : isDocumentLayer ? BARE_BOARD_COLOR
                                : '#ffffff';
        el.setAttribute('stroke', isSelected ? '#ffffff' : isHovered ? '#66ccff' : baseStroke);
        const sw = isHoleLayer
            ? Math.max(0.03, (Number(circle.radius) || 0) * 2 * 0.07)
            : Math.max(0.05, Number(circle.lineWidth) || 0.2);
        el.setAttribute('stroke-width', String(sw));
        // A dashed ring marks copper-removal circles (the area inside is cut).
        if (isCopperKnockout && !isSelected) {
            el.setAttribute('stroke-dasharray', '0.6 0.45');
        }
        // Copper-removal boundary rings live in a knockout group stacked above
        // the (masked) copper so the ring stays visible over the cut; all other
        // circles stay on their own layer.
        const targetLayer = isCopperKnockout
            ? (layer === 'bottom-copper' ? 'bottom-copper-knockout' : 'top-copper-knockout')
            : (circle.layer || 'top-silk');
        this._getLayerGroup(targetLayer)?.appendChild(el);
        this._circleElements.set(circle.id, el);
        // Keep the copper-cut masks in sync with the current circle set.
        this._updateCopperCuts();
    }

    _removeCircleElement(id) {
        const el = this._circleElements.get(id);
        if (el?.parentNode) el.parentNode.removeChild(el);
        this._circleElements.delete(id);
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

    /**
     * Rebuild the per-side SVG clip-paths that cut copper where "remove
     * copper" circles sit, and apply (or clear) them on the copper + pour
     * groups. The cut reveals the canvas behind — no board-colour fill is
     * painted — so a track or pour passing through a removal circle reads as
     * genuinely removed, matching the 2D/3D board views.
     *
     * A clip-path (not a <mask>) is used deliberately: clipping is vector and
     * resolution-independent, so it stays exact at any zoom. A raster mask
     * blows past the GPU's maximum texture size when zoomed in and gets
     * silently dropped, which made the copper "fill back in".
     */
    _updateCopperCuts() {
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
        let any = false;
        for (const side of ['top', 'bottom']) {
            const copperLayer = `${side}-copper`;
            const fillLayer = `${side}-fill`;
            const clipId = `pcb-copper-cut-${side}`;
            const cuts = (this.circles || []).filter((c) => {
                if (!c) return false;
                // A hole drills through the whole board, so it cuts copper on
                // both sides regardless of its mode.
                if (c.layer === 'hole') return (Number(c.radius) || 0) > 0;
                if (c.layer !== copperLayer) return false;
                const m = this._normalizeCircleCopperMode(c.copperMode);
                return m === 'remove-copper' || m === 'remove-copper-mask';
            });
            const existing = defs.querySelector(`#${clipId}`);
            if (cuts.length === 0) {
                if (existing) existing.remove();
                for (const lid of [copperLayer, fillLayer]) {
                    this._layerGroups.get(lid)?.removeAttribute('clip-path');
                }
                continue;
            }
            any = true;
            const clip = existing || document.createElementNS(NS, 'clipPath');
            clip.setAttribute('id', clipId);
            clip.setAttribute('clipPathUnits', 'userSpaceOnUse');
            while (clip.firstChild) clip.removeChild(clip.firstChild);
            // Outer rectangle keeps everything; each circle sub-path is a hole.
            let d = `M ${r4(x0)} ${r4(y0)} L ${r4(x1)} ${r4(y0)} L ${r4(x1)} ${r4(y1)} L ${r4(x0)} ${r4(y1)} Z`;
            for (const c of cuts) {
                const cx = Number(c.x) || 0;
                const cy = Number(c.y) || 0;
                const rad = Math.max(0, Number(c.radius) || 0);
                if (rad <= 0) continue;
                // Two semicircle arcs trace a full circle as a closed sub-path.
                d += ` M ${r4(cx - rad)} ${r4(cy)}`
                    + ` a ${r4(rad)} ${r4(rad)} 0 1 0 ${r4(rad * 2)} 0`
                    + ` a ${r4(rad)} ${r4(rad)} 0 1 0 ${r4(-rad * 2)} 0 Z`;
            }
            const path = document.createElementNS(NS, 'path');
            path.setAttribute('d', d);
            path.setAttribute('clip-rule', 'evenodd');
            clip.appendChild(path);
            if (!existing) defs.appendChild(clip);
            for (const lid of [copperLayer, fillLayer]) {
                this._layerGroups.get(lid)?.setAttribute('clip-path', `url(#${clipId})`);
            }
        }
        // Remember whether any cut is active so view-change handlers know to
        // re-fit the clip rectangle to the new viewport on pan/zoom.
        this._hasCopperCuts = any;
    }


    _circleIsFilled(circle) {
        if (!circle) return false;
        const layer = String(circle.layer || 'top-silk');
        const isHoleLayer = layer === 'hole';
        if (isHoleLayer) return false;
        const isCopperLayer = layer === 'top-copper' || layer === 'bottom-copper';
        if (isCopperLayer) {
            // Added copper and copper-removal circles read as solid discs for
            // hit-testing so the whole area can be clicked to select them.
            const m = this._normalizeCircleCopperMode(circle.copperMode);
            if (m === 'add' || m === 'remove-copper' || m === 'remove-copper-mask') return true;
        }
        const isMaskLayer = layer === 'top-mask' || layer === 'bottom-mask';
        const isDocumentLayer = layer === 'document' || layer === 'top-document' || layer === 'bottom-document';
        return !!circle.filled || isMaskLayer || isDocumentLayer;
    }

    _circleStrokeWidth(circle) {
        if (!circle) return 0.2;
        const layer = String(circle.layer || 'top-silk');
        if (layer === 'hole') {
            return Math.max(0.03, (Number(circle.radius) || 0) * 2 * 0.07);
        }
        return Math.max(0.05, Number(circle.lineWidth) || 0.2);
    }

    _normalizeCircleCopperMode(mode) {
        const m = String(mode || 'add');
        if (m === 'remove-copper' || m === 'remove-solder-mask' || m === 'remove-copper-mask') return m;
        // Backward compatibility for sessions/files created before copper mode
        // split (old remove meant removing copper and mask together).
        if (m === 'remove') return 'remove-copper-mask';
        if (m === 'remove-mask') return 'remove-solder-mask';
        return 'add';
    }

    _hitTestCircle(worldPos) {
        if (!Array.isArray(this.circles) || !worldPos) return null;
        for (let i = this.circles.length - 1; i >= 0; i--) {
            const c = this.circles[i];
            if (!c) continue;
            if (isLayerLocked(c.layer) || !isLayerVisible(c.layer)) continue;
            const dist = Math.hypot(worldPos.x - c.x, worldPos.y - c.y);
            if (this._circleIsFilled(c)) {
                if (dist <= c.radius) return c;
            } else {
                const stroke = this._circleStrokeWidth(c);
                const tol = Math.max(0.25, stroke / 2 + 0.12);
                const edgeDist = Math.abs(dist - c.radius);
                if (edgeDist <= tol) return c;
            }
        }
        return null;
    }

    _setCircleHover(circle) {
        const prev = this._hoveredCircle || null;
        const next = circle || null;
        if (prev === next || (prev && next && prev.id === next.id)) return;
        this._hoveredCircle = next;
        if (prev) this._renderCircle(prev);
        if (next) this._renderCircle(next);
    }

    _selectCircle(circle) {
        const prev = this._selectedCircle;
        const next = circle || null;
        if (prev === next || (prev && next && prev.id === next.id)) return;
        this._selectedCircle = next;
        this._syncClipboardButtons?.();
        // Only refresh the previous selection if it still exists in-model.
        // Delete flow removes from `this.circles` first, then clears
        // selection, and we must not recreate an orphan SVG element.
        if (prev && this.circles.includes(prev)) this._renderCircle(prev);
        if (next) this._renderCircle(next);
    }

    _startCircleDrag(circle, worldPos) {
        if (!circle || isLayerLocked(circle.layer)) return false;
        this._circleDrag = {
            circleId: circle.id,
            startWorld: { x: worldPos.x, y: worldPos.y },
            startPos: { x: circle.x, y: circle.y },
        };
        return true;
    }

    _handleCircleDrag(worldPos) {
        const d = this._circleDrag;
        if (!d) return;
        const c = this.circles.find(x => x.id === d.circleId);
        if (!c) return;
        const dx = worldPos.x - d.startWorld.x;
        const dy = worldPos.y - d.startWorld.y;
        const snap = this._snapToGrid({ x: d.startPos.x + dx, y: d.startPos.y + dy });
        c.x = snap.x;
        c.y = snap.y;
        this._renderCircle(c);
    }

    _endCircleDrag(commit) {
        const d = this._circleDrag;
        this._circleDrag = null;
        if (!d) return;
        const c = this.circles.find(x => x.id === d.circleId);
        if (!c) return;
        const x1 = c.x;
        const y1 = c.y;
        const moved = x1 !== d.startPos.x || y1 !== d.startPos.y;
        if (!moved) return;
        if (!commit) {
            c.x = d.startPos.x;
            c.y = d.startPos.y;
            this._renderCircle(c);
            return;
        }
        // Roll back first, then execute command so history is the source of truth.
        c.x = d.startPos.x;
        c.y = d.startPos.y;
        this._renderCircle(c);
        this.history.execute(new MoveCircleCommand(this, c, d.startPos.x, d.startPos.y, x1, y1));
    }

    deleteSelectedCircle() {
        const c = this._selectedCircle;
        if (!c) return false;
        if (isLayerLocked(c.layer)) return false;
        this.history.execute(new RemoveCircleCommand(this, c));
        this._selectCircle(null);
        this._clearProperties?.();
        return true;
    }

    /**
     * Central keyboard handler for PCB mode. Invoked by
     * AppBootstrap's window-capture dispatcher when this app is the
     * active mode. Returns `true` if the key was consumed (caller
     * should stop propagation), `false` to let other listeners run.
     *
     * Modes (highest priority first):
     *   - In-flight Track draw: Escape finishes, Space adds via + toggles layer.
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

        // File save shortcuts (Ctrl+S / Ctrl+Alt+S). While PCB is active it owns
        // the keyboard, and the schematic keyboard handler bails out when PCB is
        // active — so Ctrl+S must be handled here. Otherwise it isn't consumed by
        // the app and falls through to the browser's native "Save page as…"
        // dialog instead of saving the project (matching the PCB ribbon Save
        // button, which calls project.save()/saveAs()).
        if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
            const w = /** @type {any} */ (window);
            const result = e.altKey ? w.bootstrap?.project?.saveAs() : w.bootstrap?.project?.save();
            Promise.resolve(result).then((r) => { if (r?.success) this._showSaveToast('Saved'); });
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

        // Track-draw mode owns Escape + Space.
        if (this._trackDraw) {
            if (e.key === 'Escape') {
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

        // Circle-draw mode owns Escape.
        if (this._circleDraw) {
            if (e.key === 'Escape') {
                this._cancelCircleDraw();
                return true;
            }
            return false;
        }

        // Otherwise: history, delete, selection-cancel.
        const ctrl = e.ctrlKey || e.metaKey;
        if (ctrl && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
            if (this._vertexDrag) { cancelVertexDrag(this); this.viewport.hideCrosshair(); }
            if (this._viaDrag) cancelViaDrag(this);
            if (this._holeDrag) cancelHoleDrag(this);
            if (this._circleDrag) this._endCircleDrag(false);
            this.history.undo();
            return true;
        }
        if (ctrl && ((e.key === 'y' || e.key === 'Y') || ((e.key === 'z' || e.key === 'Z') && e.shiftKey))) {
            this.history.redo();
            return true;
        }
        if (e.key === 'Delete' || e.key === 'Backspace') {
            // Box multi-selection: delete the enclosed tracks/vias as one
            // undoable action. Components are kept (they belong to the
            // schematic netlist and are never deleted on the PCB).
            if (hasBoxSelection(this)) {
                deleteBoxSelection(this);
                return true;
            }
            if (this._selectedText) {
                this._deleteSelectedText();
                return true;
            }
            if (this._selectedTrack || this._selectedVia || this._selectedHole) {
                deleteSelectedTrack(this);
                return true;
            }
            if (this._selectedFill) {
                this.deleteSelectedFill();
                return true;
            }
            if (this._selectedCircle) {
                this.deleteSelectedCircle();
                return true;
            }
            // Components belong to the schematic netlist and can't be deleted
            // on the PCB — tell the user where to do it instead.
            if (this._selectedComp) {
                this._showComponentPopup(
                    this._selectedComp, 'Delete components from the schematic editor');
                return true;
            }
            return false;
        }
        if (e.key === 'Escape') {
            if (this._pasteDrop) {
                this._cancelPasteDrop();
                return true;
            }
            if (this._vertexDrag) {
                cancelVertexDrag(this);
                this.viewport.hideCrosshair();
                // The mouse-up block that normally clears this is skipped now
                // that the drag is gone, so reset it here to avoid a stale
                // segment-click candidate leaking into the next interaction.
                this._segmentClickEdgeId = null;
                return true;
            }
            if (this._viaDrag) { cancelViaDrag(this); return true; }
            if (this._holeDrag) { cancelHoleDrag(this); return true; }
            if (this._circleDrag) {
                this._endCircleDrag(false);
                return true;
            }
            if (hasBoxSelection(this)) {
                clearBoxSelection(this);
                return true;
            }
            if (this._selectedText) {
                this._selectText(null);
                this._clearProperties?.();
                this._setActiveRibbonTab?.('pcb-home');
                return true;
            }
            if (this._selectedTrack || this._selectedVia || this._selectedHole) {
                clearTrackSelection(this);
                this._clearProperties?.();
                return true;
            }
            if (this._selectedFill) {
                this._selectFill(null);
                this._clearProperties?.();
                return true;
            }
            if (this._selectedRef) {
                this._selectRefText(null);
                this._clearProperties?.();
                this._setActiveRibbonTab?.('pcb-home');
                return true;
            }
            // No active interaction: return to Home tab + select tool.
            if (this.currentTool !== 'select') {
                this.currentTool = 'select';
                this._updateCursorForTool?.();
                this._syncPcbHomeToolHighlight?.();
                this._setPcbStatus?.();
                this._hideToolOptions?.();
            }
            this._setActiveRibbonTab?.('pcb-home');
            return true;
        }
        // Component transform shortcuts (match the schematic editor):
        //   Space = rotate right, X = flip horizontal, Y = flip vertical.
        if (this._selectedRef && this.placements.has(this._selectedRef)) {
            // A selected reference designator rotates with Space; the
            // component body shortcuts don't apply while the label is selected.
            if (e.code === 'Space' || e.key === ' ') {
                this._rotateRefText(this._selectedRef);
                e.preventDefault();
                return true;
            }
        }
        if (this._selectedComp && this.placements.has(this._selectedComp)) {
            if (e.code === 'Space' || e.key === ' ') {
                this._rotateComponent(this._selectedComp, 'R');
                this._showComponentProperties(this._selectedComp);
                e.preventDefault();
                return true;
            }
            if (e.key === 'x' || e.key === 'X') {
                this._flipComponent(this._selectedComp, 'H');
                this._showComponentProperties(this._selectedComp);
                e.preventDefault();
                return true;
            }
            if (e.key === 'y' || e.key === 'Y') {
                this._flipComponent(this._selectedComp, 'V');
                this._showComponentProperties(this._selectedComp);
                e.preventDefault();
                return true;
            }
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
     * by vias; grouping them keeps undo/redo atomic.
     * @param {Track[]} tracks
     * @param {Via[]} [vias]
     */
    _commitTracks(tracks, vias = []) {
        const list = Array.isArray(tracks) ? tracks : [tracks];
        // Fuse any drawn endpoint that lands on an existing same-net/
        // same-layer track node into that track, so joined traces render
        // as one continuous polyline instead of two coincident objects.
        const cmd = buildDrawnTrackCommands(this, list, vias);
        if (cmd) this.history.execute(cmd);
    }

    /**
     * Serialise the PCB state (tracks, vias) to a JSON-friendly object.
     * Board outline is derived from the schematic. Footprint placements are
     * re-derived from the schematic too, so only the positions the user has
     * manually moved are persisted (as overrides) — untouched components keep
     * following the auto grid-layout.
     */
    serialize() {
        /** @type {Record<string, {x:number, y:number, rotation:number, mirror?:boolean, side?:string, refVisible?:boolean, refDx?:number, refDy?:number, refRot?:number, refSize?:number, refStrokeWidth?:number}>} */
        const placements = {};
        for (const [id, p] of this._placementOverrides) {
            placements[id] = { x: p.x, y: p.y, rotation: p.rotation || 0 };
            if (p.mirror) placements[id].mirror = true;
            if (p.side === 'bottom') placements[id].side = 'bottom';
            if (p.refVisible === false) placements[id].refVisible = false;
            if (p.refDx) placements[id].refDx = p.refDx;
            if (p.refDy) placements[id].refDy = p.refDy;
            if (p.refRot) placements[id].refRot = p.refRot;
            if (p.refSize && p.refSize !== REF_DEFAULT_SIZE) placements[id].refSize = p.refSize;
            if (p.refStrokeWidth && p.refStrokeWidth !== REF_DEFAULT_STROKE) placements[id].refStrokeWidth = p.refStrokeWidth;
        }
        return {
            board: {
                width: this._boardWidth,
                height: this._boardHeight,
                radius: this._boardRadius,
            },
            tracks: this.tracks.map(t => t.toJSON()),
            vias: this.vias.map(v => v.toJSON()),
            holes: this.holes.map(h => h.toJSON()),
            circles: this.circles.map(c => ({
                id: c.id,
                x: c.x,
                y: c.y,
                radius: c.radius,
                layer: c.layer,
                lineWidth: c.lineWidth,
                filled: !!c.filled,
                copperMode: this._normalizeCircleCopperMode(c.copperMode),
            })),
            texts: [...this.texts.values()].map(serializePcbText),
            fills: this.copperFills.map(f => f.toJSON()),
            placements,
        };
    }

    // ── ProjectDocument view interface ────────────────────────────────

    /**
     * Serialize this editor's slice of the document for the project owner.
     * Returns null when there is nothing to persist so the combined
     * document omits an empty `pcb` section.
     * @returns {object|null}
     */
    serializeSection() {
        const hasContent = this.tracks?.length || this.vias?.length
            || this.holes?.length
            || this.circles?.length
            || this.texts?.size || this.copperFills?.length || this._placementOverrides.size
            || this._boardOutlineDrawn;
        return hasContent ? this.serialize() : null;
    }

    /**
     * Restore this editor's slice of the document.
     * @param {object|null} data The PCB section (or null to clear).
     */
    loadSection(data) {
        this.loadFromData(data || null);
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

    /**
     * Mark the PCB section as having no unsaved changes. Called after the
     * combined document is successfully saved to disk, so the section's
     * dirty flag stops re-triggering autosave / the unsaved-changes warning.
     */
    markSectionClean() {
        this._isDirty = false;
    }

    /**
     * Flag the PCB section as having unsaved changes AND refresh the host
     * title so the unsaved-changes dot (`•`) appears for PCB-only edits.
     * The dot reflects the aggregate project dirty state, but only the
     * schematic host renders the title, so it must be poked here.
     */
    _markDirty() {
        this._isDirty = true;
        /** @type {any} */ (window).app?._updateTitle?.();
        // Keep the clearance overlay in sync after any committed edit (e.g. an
        // undo/redo that relocates a via leaves orphaned halos otherwise).
        this._refreshClearanceHalos?.();
        // Re-run the design-rule check (debounced) while the Design tab is
        // active or the problem panel is open.
        if (this._drcShouldRun()) this._scheduleDRC();
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
        // Need a viewport in place before we can render into layer
        // groups (autosave-recovery may call this before the user has
        // ever activated the PCB tab).
        this._ensureViewport();
        // Drop any existing tracks/vias and their SVG.
        for (const t of this.tracks) removeTrackElements(t);
        for (const v of this.vias) removeViaElements(v);
        for (const h of this.holes) removeHoleElements(h);
        this.tracks.length = 0;
        this.vias.length = 0;
        this.holes.length = 0;
        for (const id of this._circleElements.keys()) this._removeCircleElement(id);
        this.circles.length = 0;
        this._circleIdCounter = 1;
        this._updateCopperCuts?.();
        // Drop any existing copper pours and their SVG.
        this.copperFills.length = 0;
        this._selectedFill = null;
        this._selectedCircle = null;
        this._clearFillHandles?.();
        this._clearFillGroups?.();
        // Drop any existing free-standing texts.
        for (const id of this._textElements.keys()) this._removeTextElement(id);
        this.texts.clear();
        this._selectedText = null;
        clearTrackSelection(this);
        this.history.clear?.();

        // A new/opened document invalidates any current DRC results, so close
        // the problem panel and clear its marker/leader.
        this._closeDRCPanel?.();
        this._drcSelectedId = null;
        this._clearDRCMarker?.();
        this._drcViolations = [];

        // Reset the board outline to "undrawn" so a document without board
        // dimensions (a brand-new board) prompts for them on activation, and a
        // loaded document gets a clean slate before its outline is restored.
        this._selectBoardOutline?.(false);
        this._getLayerGroup('board-outline')
            ?.querySelector('.pcb-board-outline')?.remove();
        this._boardOutlineDrawn = false;
        this._boardWidth = 100;
        this._boardHeight = 80;
        this._boardRadius = 0;

        // Restore manual footprint position overrides. These are applied when
        // _placeFootprints rebuilds the placements from the schematic; if
        // placements already exist (sync ran first), re-apply immediately.
        this._placementOverrides.clear();

        if (!data) return;

        // Restore the saved board outline so it survives save/reopen and
        // autosave-recovery (the dimensions are part of the document).
        if (data.board && data.board.width > 0 && data.board.height > 0) {
            this._boardWidth = data.board.width;
            this._boardHeight = data.board.height;
            this._boardRadius = data.board.radius || 0;
            this._drawBoardOutline();
        }

        if (data.placements && typeof data.placements === 'object') {
            for (const [id, p] of Object.entries(data.placements)) {
                if (!p) continue;
                this._placementOverrides.set(id, {
                    x: Number(p.x) || 0,
                    y: Number(p.y) || 0,
                    rotation: Number(p.rotation) || 0,
                    mirror: !!p.mirror,
                    side: p.side === 'bottom' ? 'bottom' : 'top',
                    refVisible: p.refVisible !== false,
                    refDx: Number(p.refDx) || 0,
                    refDy: Number(p.refDy) || 0,
                    refRot: ((Number(p.refRot) || 0) % 360 + 360) % 360,
                    refSize: Number(p.refSize) || REF_DEFAULT_SIZE,
                    refStrokeWidth: Number(p.refStrokeWidth) || REF_DEFAULT_STROKE,
                });
            }
            if (this.placements.size) this._applyPlacementOverrides();
        }

        if (Array.isArray(data.tracks)) {
            for (const td of data.tracks) {
                let track;
                try {
                    track = createShape(td);
                } catch (err) {
                    console.warn('Skipping malformed track during load:', err);
                    continue;
                }
                if (track instanceof Track) {
                    this.tracks.push(track);
                    renderTrack(track, (id) => this._getLayerGroup(id), {
                        viaDiameter: this._getRoutingParams?.()?.viaDiameter,
                        viaDrill: this._getRoutingParams?.()?.viaDrill,
                        hideNetLabel: track === this._selectedTrack,
                    });
                }
            }
        }
        if (Array.isArray(data.vias)) {
            for (const vd of data.vias) {
                const via = Via.fromJSON(vd);
                this.vias.push(via);
                renderVia(via, (id) => this._getLayerGroup(id));
            }
        }
        if (Array.isArray(data.holes)) {
            for (const hd of data.holes) {
                const hole = Hole.fromJSON(hd);
                updateHoleIdCounter(hole.id);
                this.holes.push(hole);
                renderHole(hole, (id) => this._getLayerGroup(id));
            }
        }
        if (Array.isArray(data.circles)) {
            for (const cd of data.circles) {
                const c = {
                    id: String(cd.id || `pcirc_${this._circleIdCounter++}`),
                    x: Number(cd.x) || 0,
                    y: Number(cd.y) || 0,
                    radius: Math.max(0.05, Number(cd.radius) || 0),
                    layer: String(cd.layer || 'top-silk'),
                    lineWidth: Math.max(0.05, Number(cd.lineWidth) || this._circleDefaults.lineWidth),
                    filled: !!cd.filled,
                    copperMode: this._normalizeCircleCopperMode(cd.copperMode),
                };
                this.circles.push(c);
                this._renderCircle(c);
                const n = /pcirc_(\d+)/.exec(c.id);
                if (n) this._circleIdCounter = Math.max(this._circleIdCounter, Number(n[1]) + 1);
            }
        }
        if (Array.isArray(data.texts)) {
            for (const td of data.texts) {
                const t = createPcbText(td);
                this.texts.set(t.id, t);
                this._renderText(t);
            }
        }
        if (Array.isArray(data.fills)) {
            for (const fd of data.fills) {
                try {
                    const fill = CopperFill.fromJSON(fd);
                    updateFillIdCounter(fill.id);
                    this.copperFills.push(fill);
                } catch (err) {
                    console.warn('Skipping malformed copper fill during load:', err);
                }
            }
        }
        // Re-evaluate ratlines once the model is in place.
        reconcileRatsnest(this);
        // Compute and render the pours now that obstacles are loaded.
        this._refreshFills();
        // Loading a document is not a user edit — start from a clean slate so
        // a freshly opened/recovered board isn't immediately treated as having
        // unsaved PCB changes (which would re-trigger autosave after a save).
        this._isDirty = false;
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

        // Layer z-order (bottom to top): outline, masks, paste, copper, silk, holes, rats, doc
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
            'bottom-silk', 'top-silk',
            'hole',
            'ratlines',
            // Level-of-detail placeholders: one solid rect per footprint, shown
            // (in place of the footprint's full geometry) when zoomed out far
            // enough that the detail is sub-pixel. Sits above copper/silk so the
            // block reads clearly; hidden whenever the real geometry is shown.
            'fp-lod',
            'bottom-document',
            'top-document',
            'document',
            // Overlays — non-editable visual aids drawn on top of everything
            // (clearance halos, etc.). Must be last in z-order.
            'clearance-overlay',
            // Selection-overlay — track node handles etc. sit above ALL
            // copper, vias (hole layer) and overlays so they stay visible
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
        // Match the active draw layer to the restored edit (pencil) layer.
        const editLayer = PCB_LAYERS.find(l => l.edit);
        if (editLayer) this.activeLayer = editLayer.id;
    }

    /**
     * Get the SVG group for a layer, creating it if needed.
     * @param {string} layerId
     * @returns {SVGGElement}
     */
    _getLayerGroup(layerId) {
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
        }
        // Clearance overlay tracks per-layer visibility — re-render so halos
        // for hidden copper/hole layers disappear too.
        if (this._clearancesVisible && (layerId === 'top-copper' || layerId === 'bottom-copper' || layerId === 'hole')) {
            this.showClearances(true);
        }
        // A newly-hidden layer must not keep anything on it selected or
        // hovered — hidden objects are non-interactive (can't be selected,
        // dragged or deleted), mirroring the locked-layer behaviour.
        if (!visible) {
            const viaAffected = (layerId === 'top-copper' || layerId === 'bottom-copper') && !isViaVisible();
            if ((this._selectedTrack && this._selectedTrack.layer === layerId) ||
                (this._selectedVia && viaAffected)) {
                clearTrackSelection(this);
                this._clearProperties();
            }
            if (this._selectedText && this._selectedText.layer === layerId) {
                this._selectText(null);
                this._clearProperties();
            }
            if (this._selectedCircle && this._selectedCircle.layer === layerId) {
                this._selectCircle(null);
                this._clearProperties();
            }
            if (this._selectedFill && this._selectedFill.layer === layerId) {
                this._selectFill(null);
            }
            if (this._boardOutlineSelected && layerId === 'board-outline') {
                this._selectBoardOutline(false);
            }
            if (hasBoxSelection(this)) clearBoxSelection(this);
            setHoverHighlight(this, null);
        }
        saveLayerPrefs();
    }

    /**
     * Called by the layer panel when a layer's lock is toggled. A locked
     * layer is rendered dimmed (reduced opacity) so it's clearly set apart
     * from the editable layers.
     * @param {string} layerId
     * @param {boolean} locked
     */
    _onLayerLockChanged(layerId, locked) {
        const g = this._layerGroups.get(layerId);
        if (g) {
            g.style.opacity = locked ? '0.4' : '';
        }
        // Keep copper-removal knockouts dimmed in step with their copper layer.
        if (layerId === 'top-copper' || layerId === 'bottom-copper') {
            const ko = this._layerGroups.get(layerId === 'bottom-copper' ? 'bottom-copper-knockout' : 'top-copper-knockout');
            if (ko) ko.style.opacity = locked ? '0.4' : '';
        }
        saveLayerPrefs();
        if (!locked) return;
        // A newly-locked layer must not keep anything on it selected or
        // hovered — locked objects are read-only.
        const viaAffected = layerId === 'top-copper' || layerId === 'bottom-copper';
        if ((this._selectedTrack && this._selectedTrack.layer === layerId) ||
            (this._selectedVia && viaAffected)) {
            clearTrackSelection(this);
            this._clearProperties();
        }
        if (this._selectedText && this._selectedText.layer === layerId) {
            this._selectText(null);
            this._clearProperties();
        }
        if (this._selectedCircle && this._selectedCircle.layer === layerId) {
            this._selectCircle(null);
            this._clearProperties();
        }
        if (this._boardOutlineSelected && layerId === 'board-outline') {
            this._selectBoardOutline(false);
        }
        if (hasBoxSelection(this)) clearBoxSelection(this);
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
            // A highlighted incomplete-connection violation draws a temporary
            // copy of its ratline only while the real ratline is hidden.
            // Toggling ratline visibility flips that condition, so re-draw the
            // currently shown marker to add or drop the temp ratline to match.
            if (this._drcSelectedId) {
                const overlay = this._layerGroups.get('drc-overlay');
                const sel = (overlay && overlay.firstChild)
                    ? this._drcViolations.find(x => x.id === this._drcSelectedId) : null;
                if (sel) {
                    this._drawDRCMarker(sel);
                    this._updateDRCConnector();
                }
            }
        }
        saveLayerPrefs();
    }

    _fitToContent() {
        this._ensureViewport();
        if (!this.viewport) return;

        // Culled footprints are display:none and report a zero bounding box, so
        // restore full detail before measuring; the resulting view change will
        // re-apply culling for the new viewport.
        this._uncullAllPlacements();

        // Measure the actual artwork from the live layer groups rather than
        // relying on the viewport's fixed placeholder bounds.
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        if (this._layerGroups) {
            for (const g of this._layerGroups.values()) {
                if (!g || !g.childNodes.length) continue;
                let bb;
                try {
                    bb = g.getBBox();
                } catch {
                    continue;
                }
                if (!bb || (bb.width === 0 && bb.height === 0)) continue;
                minX = Math.min(minX, bb.x);
                minY = Math.min(minY, bb.y);
                maxX = Math.max(maxX, bb.x + bb.width);
                maxY = Math.max(maxY, bb.y + bb.height);
            }
        }

        if (Number.isFinite(minX)) {
            this.viewport.fitToBounds(minX, minY, maxX, maxY, 10);
        } else {
            // Nothing drawn yet — fall back to the nominal board outline.
            this.viewport.fitToBounds(0, -this._boardHeight, this._boardWidth, 0, 10);
        }
    }

    _bindRibbonTabs() {
        if (!this.ribbon) return;

        const tabs = this.ribbon.querySelectorAll('.ribbon-tab[data-tab]');
        const panels = this.ribbon.querySelectorAll('.ribbon-panel');

        const setActive = (tabId) => {
            tabs.forEach(tab => {
                const tabEl = /** @type {HTMLElement} */ (tab);
                tabEl.classList.toggle('active', tabEl.dataset.tab === tabId);
            });

            panels.forEach(panel => {
                const panelEl = /** @type {HTMLElement} */ (panel);
                panelEl.classList.toggle('active', panelEl.dataset.panel === tabId);
            });

            if (tabId === 'pcb-home') {
                this._syncPcbHomeToolHighlight?.();
            }

            // The DRC runs live only while the Design tab is active. The
            // slide-in problem panel, however, stays open across tab switches
            // — it's dismissed only by re-clicking the DRC button or its X.
            this._drcActive = (tabId === 'pcb-design');
            if (this._drcActive) {
                this._runDRCLive();
            }
        };

        this._setActiveRibbonTab = setActive;

        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                const tabEl = /** @type {HTMLElement} */ (tab);
                if (!tabEl.dataset.tab) return;
                setActive(tabEl.dataset.tab);
            });
        });
    }

    // ── Board Outline ─────────────────────────────────────────────

    /**
     * Show a dialog asking for board dimensions on first entry.
     */
    _showBoardDimensionsDialog() {
        const overlay = document.createElement('div');
        overlay.className = 'app-modal-overlay';
        overlay.innerHTML = `
            <div class="app-modal" style="min-width:300px">
                <div class="app-modal-title">Board Dimensions</div>
                <div class="app-modal-message">Enter the board size in millimetres.</div>
                <div style="display:flex;gap:10px;margin-top:10px">
                    <div style="flex:1">
                        <label style="font-size:11px;color:var(--text-secondary)">Width (mm)</label>
                        <input class="app-modal-input" id="boardDlgWidth" type="number" value="${this._boardWidth}" min="5" step="1" style="margin-top:2px">
                    </div>
                    <div style="flex:1">
                        <label style="font-size:11px;color:var(--text-secondary)">Height (mm)</label>
                        <input class="app-modal-input" id="boardDlgHeight" type="number" value="${this._boardHeight}" min="5" step="1" style="margin-top:2px">
                    </div>
                    <div style="flex:1">
                        <label style="font-size:11px;color:var(--text-secondary)">Corner R (mm)</label>
                        <input class="app-modal-input" id="boardDlgRadius" type="number" value="${this._boardRadius}" min="0" step="0.5" style="margin-top:2px">
                    </div>
                </div>
                <div class="app-modal-actions">
                    <button class="app-modal-btn app-modal-ok" id="boardDlgOk">OK</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);

        const widthInput = /** @type {HTMLInputElement} */ (overlay.querySelector('#boardDlgWidth'));
        const heightInput = /** @type {HTMLInputElement} */ (overlay.querySelector('#boardDlgHeight'));
        const radiusInput = /** @type {HTMLInputElement} */ (overlay.querySelector('#boardDlgRadius'));
        const okBtn = overlay.querySelector('#boardDlgOk');

        setTimeout(() => widthInput?.focus(), 50);

        const accept = () => {
            const w = parseFloat(widthInput?.value) || 100;
            const h = parseFloat(heightInput?.value) || 80;
            const r = parseFloat(radiusInput?.value) || 0;
            const before = {
                width: this._boardWidth,
                height: this._boardHeight,
                radius: this._boardRadius,
            };
            const after = {
                width: Math.max(5, w),
                height: Math.max(5, h),
                radius: Math.max(0, r),
            };
            if (before.width !== after.width || before.height !== after.height || before.radius !== after.radius) {
                this.history.execute(new SetBoardOutlineCommand(this, before, after));
            } else if (!this._boardOutlineDrawn) {
                // Dimensions unchanged from defaults, so no command runs — but
                // the outline still needs its first draw, and the document must
                // be flagged dirty so the autosave captures the new board.
                this._drawBoardOutline();
                this._markDirty();
            }
            overlay.remove();
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
        const NS = 'http://www.w3.org/2000/svg';
        const layer = this._getLayerGroup('board-outline');

        // Remove existing outline
        const old = layer.querySelector('.pcb-board-outline');
        if (old) old.remove();

        const w = this._boardWidth;
        const h = this._boardHeight;
        const r = Math.min(this._boardRadius, w / 2, h / 2);

        // Bottom-left corner at origin (0,0) in user coords (Y-up)
        // In SVG coords (Y-down), rect goes from (0, -h) to (w, 0)
        const x = 0;
        const y = -h;

        const rect = document.createElementNS(NS, 'rect');
        rect.setAttribute('class', 'pcb-board-outline');
        rect.setAttribute('x', String(x));
        rect.setAttribute('y', String(y));
        rect.setAttribute('width', String(w));
        rect.setAttribute('height', String(h));
        if (r > 0) {
            rect.setAttribute('rx', String(r));
            rect.setAttribute('ry', String(r));
        }
        rect.setAttribute('fill', 'none');
        rect.setAttribute('stroke', '#f1c40f');
        rect.setAttribute('stroke-width', '0.2');
        layer.appendChild(rect);

        const wasDrawn = this._boardOutlineDrawn;
        this._boardOutlineDrawn = true;

        // Fit view to board only on first draw
        if (!wasDrawn && this.viewport) {
            this.viewport.fitToBounds(x - 5, y - 5, w + 10, h + 10);
        }
    }

    // ── Properties Panel ──────────────────────────────────────────

    /**
     * Test if a world point is near the board outline edge.
     */
    _hitTestBoardOutline(pos) {
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
        const outline = this._getLayerGroup('board-outline').querySelector('.pcb-board-outline');
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
        this._boardOutlineSelected = selected;
        const outline = this._getLayerGroup('board-outline').querySelector('.pcb-board-outline');
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
     * Show live editable options for an in-progress Track draw
     * (currently just track width). Replaces the old Properties-tab UI.
     * @param {object} ctx - the _trackDraw context
     */
    _showTrackDrawToolOptions(ctx) {
        if (!ctx) return;
        this._showToolOptions(
            `<label>Width (mm) <input type="number" id="pcbToolTrackWidth" value="${ctx.width}" min="0.05" step="0.05"></label>`,
            () => {
                const wEl = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbToolTrackWidth'));
                wEl?.addEventListener('input', () => {
                    const v = parseFloat(wEl.value);
                    if (Number.isFinite(v) && v > 0) {
                        ctx.width = v;
                        const last = ctx.points[ctx.points.length - 1];
                        const live = ctx.snap ? { x: ctx.snap.x, y: ctx.snap.y } : last;
                        updateTrackDraw(this, live);
                    }
                });
            });
    }

    /**
     * Show idle Track tool options (width spinner only). Used when the
     * track tool is selected but no draw is in progress; edits write
     * back to the routing-params input so the next draw picks them up.
     */
    _showTrackToolOptions() {
        const p = this._getRoutingParams?.() || {};
        const w = Number.isFinite(p.trackWidth) && p.trackWidth > 0 ? p.trackWidth : 0.2;
        this._showToolOptions(
            `<label>Width (mm) <input type="number" id="pcbToolTrackWidth" value="${w}" min="0.05" step="0.05"></label>`,
            () => {
                const wEl = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbToolTrackWidth'));
                const src = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbTrackWidth'));
                wEl?.addEventListener('input', () => {
                    if (src) src.value = wEl.value;
                });
            });
    }

    /**
     * Show live editable options for the Via tool (diameter / drill).
     */
    _showViaToolOptions() {
        const p = this._getRoutingParams?.() || {};
        const dia = Number.isFinite(p.viaDiameter) && p.viaDiameter > 0 ? p.viaDiameter : 0.6;
        const drill = Number.isFinite(p.viaDrill) && p.viaDrill > 0 ? p.viaDrill : 0.3;
        this._showToolOptions(
            `<label>Diameter (mm) <input type="number" id="pcbToolViaDia" value="${dia}" min="0.1" step="0.05"></label>
             <label>Drill (mm) <input type="number" id="pcbToolViaDrill" value="${drill}" min="0.05" step="0.05"></label>`,
            () => {
                const diaEl = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbToolViaDia'));
                const drillEl = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbToolViaDrill'));
                const srcDia = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbViaDiameter'));
                const srcDrill = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbViaDrill'));
                diaEl?.addEventListener('input', () => {
                    if (srcDia) srcDia.value = diaEl.value;
                    if (this._lastCrosshairWorld) this._updateViaPreview(this._lastCrosshairWorld);
                });
                drillEl?.addEventListener('input', () => {
                    if (srcDrill) srcDrill.value = drillEl.value;
                    if (this._lastCrosshairWorld) this._updateViaPreview(this._lastCrosshairWorld);
                });
            });
    }

    _showHoleToolOptions() {
        const dia = this._getHoleDiameter();
        this._showToolOptions(
            `<label>Diameter (mm) <input type="number" id="pcbToolHoleDia" value="${dia}" min="0.1" step="0.05"></label>`,
            () => {
                const diaEl = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbToolHoleDia'));
                diaEl?.addEventListener('input', () => {
                    if (this._lastCrosshairWorld) this._updateHolePreview(this._lastCrosshairWorld);
                });
            });
    }

    /**
     * Show Fill tool options (copper-layer picker). The chosen layer becomes
     * the active layer so the next pour is drawn on it; if a pour outline is
     * already in progress, retarget it live.
     */
    _showFillToolOptions() {
        const cur = this.activeLayer === 'bottom-copper' ? 'bottom-copper' : 'top-copper';
        const opt = (id, name) => `<option value="${id}"${id === cur ? ' selected' : ''}>${name}</option>`;
        this._showToolOptions(
            `<label>Layer <select id="pcbToolFillLayer">${opt('top-copper', 'Top Copper')}${opt('bottom-copper', 'Bottom Copper')}</select></label>`,
            () => {
                const el = /** @type {HTMLSelectElement|null} */ (document.getElementById('pcbToolFillLayer'));
                el?.addEventListener('change', () => {
                    this.activeLayer = el.value === 'bottom-copper' ? 'bottom-copper' : 'top-copper';
                    if (this._fillDraw) this._fillDraw.layer = this.activeLayer;
                });
            });
    }

    /**
     * Clear the properties panel to its default state.
     */
    _clearProperties() {
        this._setPcbPropsTitle('Properties');
        const items = this._pcbPropsItems();
        if (items) {
            items.innerHTML = '<span style="font-size:11px;color:var(--text-muted)">Click an object to see its properties</span>';
        }
        this._syncClipboardButtons?.();
    }

    /**
     * Set the PCB Properties ribbon group title.
     * @param {string} title
     */
    _setPcbPropsTitle(title) {
        const el = document.querySelector('#pcbPropsContent .ribbon-group-title');
        if (el) el.textContent = title || 'Properties';
    }

    /**
     * Return the `#pcbPropsItems` container, first stripping any component-only
     * sibling sections (Transform / 3D) so non-component property views render
     * with the base Properties group as the sole panel content.
     */
    _pcbPropsItems() {
        document.getElementById('pcbPropertiesPanel')
            ?.querySelectorAll('.pcb-props-extra').forEach((el) => el.remove());
        return document.getElementById('pcbPropsItems');
    }

    /**
     * Show live editable properties for an in-progress Track draw.
     * @deprecated Track-draw options now live in the Home tab Tool
     * Options group (see _showTrackDrawToolOptions). Kept as a no-op
     * for backwards compat with anything still calling it.
     */
    _showTrackDrawProperties() { /* no-op */ }

    /**
     * Show board outline properties and switch to Properties tab.
     */
    _showBoardOutlineProperties() {
        const items = this._pcbPropsItems();
        if (!items) return;
        this._setPcbPropsTitle('Board Outline');

        items.innerHTML = `
            <div class="prop-row"><label>Width (mm)</label><input type="number" id="pcbPropBoardW" value="${this._boardWidth}" min="5" step="1"></div>
            <div class="prop-row"><label>Height (mm)</label><input type="number" id="pcbPropBoardH" value="${this._boardHeight}" min="5" step="1"></div>
            <div class="prop-row"><label>Corner R (mm)</label><input type="number" id="pcbPropBoardR" value="${this._boardRadius}" min="0" step="0.5"></div>
        `;

        // Live editing: apply changes immediately for visual feedback, but
        // only commit a SetBoardOutlineCommand on `change` (blur / Enter)
        // so the undo stack gets a single entry per edit, not one per
        // keystroke. _boardOutlineEditStart captures the pre-edit values.
        const snapshot = () => ({
            width: this._boardWidth,
            height: this._boardHeight,
            radius: this._boardRadius,
        });
        const onInput = () => {
            if (!this._boardOutlineEditStart) {
                this._boardOutlineEditStart = snapshot();
            }
            const wEl = /** @type {HTMLInputElement} */ (document.getElementById('pcbPropBoardW'));
            const hEl = /** @type {HTMLInputElement} */ (document.getElementById('pcbPropBoardH'));
            const rEl = /** @type {HTMLInputElement} */ (document.getElementById('pcbPropBoardR'));
            this._boardWidth = Math.max(5, parseFloat(wEl?.value) || 100);
            this._boardHeight = Math.max(5, parseFloat(hEl?.value) || 80);
            this._boardRadius = Math.max(0, parseFloat(rEl?.value) || 0);
            this._drawBoardOutline();
        };
        const onCommit = () => {
            if (!this._boardOutlineEditStart) return;
            const before = this._boardOutlineEditStart;
            const after = snapshot();
            this._boardOutlineEditStart = null;
            if (before.width === after.width
                && before.height === after.height
                && before.radius === after.radius) return;
            this.history.execute(new SetBoardOutlineCommand(this, before, after));
        };
        for (const id of ['pcbPropBoardW', 'pcbPropBoardH', 'pcbPropBoardR']) {
            const el = items.querySelector('#' + id);
            el?.addEventListener('input', onInput);
            el?.addEventListener('change', onCommit);
        }

        // Switch to Properties tab
        this._setActiveRibbonTab?.('pcb-properties');
    }

    /**
     * Show component properties (placeholder for now).
     */
    _showComponentProperties(compId) {
        const items = this._pcbPropsItems();
        if (!items) return;
        this._setPcbPropsTitle('Component');

        const pl = this.placements.get(compId);
        const name = pl?.name || pl?.reference || compId;
        const side = pl?.side === 'bottom' ? 'bottom' : 'top';
        const refVisible = pl?.refVisible !== false;

        items.innerHTML = `
            <div class="prop-row"><label>Reference</label><span style="font-size:11px;color:var(--text-primary)">${name}</span></div>
            <div class="prop-row"><input type="checkbox" id="pcbPropCompRefVis"${refVisible ? ' checked' : ''}> <span style="font-size:11px;color:var(--text-secondary)">Show Reference</span></div>
            <div class="prop-row"><label>Layer</label><select id="pcbPropCompSide">
                <option value="top"${side === 'top' ? ' selected' : ''}>Top</option>
                <option value="bottom"${side === 'bottom' ? ' selected' : ''}>Bottom</option>
            </select></div>
            ${hasAny3DModel(pl) ? '<div class="prop-actions" style="margin-top:6px"><button id="pcbPropShow3D" title="Show 3D model">\uD83E\uDDCA Show 3D</button></div>' : ''}
        `;

        // Sibling ribbon-group sections (mirrors the schematic Properties
        // panel: Transform sits beside the info group horizontally).
        const panel = document.getElementById('pcbPropertiesPanel');
        const transform = document.createElement('div');
        transform.className = 'ribbon-group pcb-props-extra';
        transform.innerHTML = `
            <div class="ribbon-group-title">Transform</div>
            <div class="ribbon-group-items prop-actions">
                <button id="pcbPropRotateLeft" title="Rotate Left 90°">↶ Rotate L</button>
                <button id="pcbPropRotateRight" title="Rotate Right 90°">↷ Rotate R</button>
                <button id="pcbPropFlipH" title="Flip Horizontal (X)">⇔ Flip H</button>
                <button id="pcbPropFlipV" title="Flip Vertical (Y)">⇕ Flip V</button>
            </div>
        `;
        panel?.appendChild(transform);

        const curRot = () => ((this.placements.get(compId)?.rotation || 0) % 360 + 360) % 360;

        const rotateTo = (deg) => {
            const p = this.placements.get(compId);
            if (!p) return;
            const norm = ((deg % 360) + 360) % 360;
            if ((p.rotation || 0) === norm) return;
            this.history.execute(new RotatePlacementCommand(this, compId, p.rotation || 0, norm));
            this._showComponentProperties(compId);
        };

        const refEl = /** @type {HTMLInputElement} */ (document.getElementById('pcbPropCompRefVis'));
        refEl?.addEventListener('change', () => {
            this._setComponentRefVisible(compId, refEl.checked);
        });
        document.getElementById('pcbPropRotateLeft')
            ?.addEventListener('click', () => rotateTo(curRot() - 90));
        document.getElementById('pcbPropRotateRight')
            ?.addEventListener('click', () => rotateTo(curRot() + 90));
        document.getElementById('pcbPropFlipH')
            ?.addEventListener('click', () => { this._flipComponent(compId, 'H'); this._showComponentProperties(compId); });
        document.getElementById('pcbPropFlipV')
            ?.addEventListener('click', () => { this._flipComponent(compId, 'V'); this._showComponentProperties(compId); });
        const sideEl = /** @type {HTMLSelectElement} */ (document.getElementById('pcbPropCompSide'));
        sideEl?.addEventListener('change', () => {
            this._setPlacementSide(compId, sideEl.value === 'bottom' ? 'bottom' : 'top');
        });
        document.getElementById('pcbPropShow3D')
            ?.addEventListener('click', () => this._openComponent3DPopout(compId));

        this._setActiveRibbonTab?.('pcb-properties');
    }

    /** Show editable properties for a selected free-standing circle. */
    _showCircleProperties(circle) {
        const items = this._pcbPropsItems();
        if (!items || !circle) return;
        this._setPcbPropsTitle('Circle');
        const hiddenLayers = new Set([
            'top-paste', 'bottom-paste',
            'top-mask', 'bottom-mask',
            'board-outline',
            'document', 'top-document', 'bottom-document',
        ]);
        const currentLayer = String(circle.layer || 'top-silk');
        const legacyCurrentOpt = hiddenLayers.has(currentLayer)
            ? `<option value="${currentLayer}" selected hidden></option>`
            : '';
        const layerOpts = PCB_LAYERS
            .filter((l) => !hiddenLayers.has(l.id))
            .map((l) => (
                `<option value="${l.id}"${l.id === currentLayer ? ' selected' : ''}>${l.name}</option>`
            ));
        const layerOptionsHtml = [legacyCurrentOpt, ...layerOpts].join('');
        const isCopperLayer = (layerId) => layerId === 'top-copper' || layerId === 'bottom-copper';
        const normalizeCopperMode = (mode) => this._normalizeCircleCopperMode(mode);
        const initialCopperMode = normalizeCopperMode(circle.copperMode);
        items.innerHTML = `
            <div class="prop-row"><label>Line Thickness (mm)</label><input type="number" id="pcbPropCircleLineWidth" min="0.05" step="0.05" value="${Number(circle.lineWidth || this._circleDefaults.lineWidth).toFixed(2)}"></div>
            <div class="prop-row"><label>Layer</label><select id="pcbPropCircleLayer">${layerOptionsHtml}</select></div>
            <div class="prop-row"><input type="checkbox" id="pcbPropCircleFilled"${circle.filled ? ' checked' : ''}> <span style="font-size:11px;color:var(--text-secondary)">Filled</span></div>
            <div class="prop-row" id="pcbPropCircleCopperModeRow"><label>Copper Mode</label><select id="pcbPropCircleCopperMode"><option value="add"${initialCopperMode === 'add' ? ' selected' : ''}>Add Copper</option><option value="remove-copper"${initialCopperMode === 'remove-copper' ? ' selected' : ''}>Remove Copper</option><option value="remove-solder-mask"${initialCopperMode === 'remove-solder-mask' ? ' selected' : ''}>Remove Solder Mask</option><option value="remove-copper-mask"${initialCopperMode === 'remove-copper-mask' ? ' selected' : ''}>Remove Copper + Mask</option></select></div>
        `;

        const snapshot = () => ({
            x: circle.x,
            y: circle.y,
            radius: circle.radius,
            layer: circle.layer,
            lineWidth: Math.max(0.05, Number(circle.lineWidth) || this._circleDefaults.lineWidth),
            filled: !!circle.filled,
            copperMode: normalizeCopperMode(circle.copperMode),
        });
        const commit = (mutate) => {
            const before = snapshot();
            mutate();
            if (circle.layer === 'top-mask' || circle.layer === 'bottom-mask'
                || circle.layer === 'document' || circle.layer === 'top-document' || circle.layer === 'bottom-document') {
                circle.filled = true;
            }
            circle.copperMode = normalizeCopperMode(circle.copperMode);
            const after = snapshot();
            if (JSON.stringify(before) === JSON.stringify(after)) return;
            circle.x = before.x;
            circle.y = before.y;
            circle.radius = before.radius;
            circle.layer = before.layer;
            circle.lineWidth = before.lineWidth;
            circle.filled = before.filled;
            circle.copperMode = before.copperMode;
            this.history.execute(new ModifyCircleCommand(this, circle, before, after));
        };

        const lineEl = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropCircleLineWidth'));
        lineEl?.addEventListener('change', () => {
            const v = Math.max(0.05, Number(lineEl.value) || this._circleDefaults.lineWidth);
            if (Math.abs(v - (Number(circle.lineWidth) || this._circleDefaults.lineWidth)) < 1e-9) return;
            commit(() => { circle.lineWidth = v; });
        });

        const filledEl = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropCircleFilled'));
        const layerEl = /** @type {HTMLSelectElement|null} */ (document.getElementById('pcbPropCircleLayer'));
        const copperModeRowEl = /** @type {HTMLDivElement|null} */ (document.getElementById('pcbPropCircleCopperModeRow'));
        const copperModeEl = /** @type {HTMLSelectElement|null} */ (document.getElementById('pcbPropCircleCopperMode'));
        const syncFilledAvailability = () => {
            if (!filledEl || !layerEl) return;
            const isHole = layerEl.value === 'hole';
            filledEl.disabled = isHole;
            if (isHole) filledEl.checked = false;
        };
        const syncCopperModeAvailability = () => {
            if (!copperModeEl || !layerEl || !copperModeRowEl) return;
            const copper = isCopperLayer(layerEl.value);
            copperModeRowEl.style.display = copper ? '' : 'none';
            copperModeEl.disabled = !copper;
            copperModeEl.value = copper ? normalizeCopperMode(circle.copperMode) : 'add';
        };
        filledEl?.addEventListener('change', () => {
            if (filledEl.disabled) {
                filledEl.checked = false;
                return;
            }
            const v = !!filledEl.checked;
            if (v === !!circle.filled) return;
            commit(() => { circle.filled = v; });
        });
        layerEl?.addEventListener('change', () => {
            const next = layerEl.value;
            if (next === circle.layer) return;
            if (isLayerLocked(next)) {
                layerEl.value = circle.layer;
                syncFilledAvailability();
                syncCopperModeAvailability();
                return;
            }
            commit(() => {
                circle.layer = next;
                if (next === 'hole') circle.filled = false;
            });
            syncFilledAvailability();
            syncCopperModeAvailability();
        });

        copperModeEl?.addEventListener('change', () => {
            if (copperModeEl.disabled) return;
            const next = normalizeCopperMode(copperModeEl.value);
            if (next === normalizeCopperMode(circle.copperMode)) return;
            commit(() => { circle.copperMode = next; });
            syncCopperModeAvailability();
        });

        syncFilledAvailability();
        syncCopperModeAvailability();

        this._setActiveRibbonTab?.('pcb-properties');
    }

    /** Re-sync circle properties when undo/redo mutates the selected circle. */
    _refreshCircleProperties(circle) {
        if (circle && this._selectedCircle && this._selectedCircle.id === circle.id) {
            this._showCircleProperties(circle);
        }
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
        if (!pl) return;
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
        if (!this.placements.has(compId)) return;
        this.history.execute(new FlipPlacementCommand(this, compId, axis));
    }

    /**
     * Move a component to the top or bottom copper side via the history stack.
     * @param {string} compId
     * @param {'top'|'bottom'} side
     */
    _setPlacementSide(compId, side) {
        const pl = this.placements.get(compId);
        if (!pl) return;
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
        if (!pl) return;
        if ((pl.refVisible !== false) === !!visible) return;
        this.history.execute(new SetPlacementRefVisibleCommand(this, compId, !!visible));
    }

    _bindThemeToggle() {
        if (!this.themeToggle) return;

        this.themeToggle.addEventListener('click', () => {
            const newTheme = toggleSharedTheme();
            syncThemeToggleButtons(['themeToggle', 'pcbThemeToggle'], newTheme);
            this.viewport?.updateTheme?.();
        });
    }

    // ── Schematic → PCB sync ──────────────────────────────────────

    /**
     * Install listeners on the schematic app so every mutation
     * (add/remove shape, undo/redo, file load) marks the PCB stale.
     * Safe to call multiple times — only hooks once.
     */
    _hookSchematicChanges() {
        if (this._listening) return;
        const schematicApp = /** @type {any} */ (window).app;
        if (!schematicApp) return;

        // Wrap the history callback to also mark PCB stale
        const origOnChanged = schematicApp.history?.onChanged;
        if (schematicApp.history) {
            schematicApp.history.onChanged = (...args) => {
                origOnChanged?.(...args);
                this._markStale();
            };
        }

        // Also catch file-open / new-document (dirty flag resets)
        const origDirty = schematicApp.fileManager?.onDirtyChanged;
        if (schematicApp.fileManager) {
            schematicApp.fileManager.onDirtyChanged = (...args) => {
                origDirty?.(...args);
                this._markStale();
            };
        }

        this._listening = true;
    }

    /**
     * Mark the PCB as needing a rebuild.  If the PCB pane is currently
     * active the rebuild is scheduled via a short debounce so rapid
     * schematic edits don't cause per-keystroke rebuilds.
     */
    _markStale() {
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
        this._stale = false;
        clearTimeout(this._syncTimer);

        const schematicApp = /** @type {any} */ (window).app;
        if (!schematicApp) return;

        this._ensureViewport();

        const components = extractComponents(schematicApp);
        const netlist = extractNetlist(schematicApp);
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
        this._renderPersistentObjects();

        if (components.length === 0) {
            this._setStatus('No components in schematic');
            return;
        }

        // Ratsnest goes to its own layer group
        this._ratsnestGroup = this._getLayerGroup('ratlines');

        // Place footprints (elements distributed to correct layer groups)
        this._placeFootprints(components);

        // Keep free circles above freshly placed footprint artwork. Persistent
        // objects are re-rendered before _placeFootprints to handle empty-
        // component boards, but on populated boards that ordering can bury
        // circles under footprint geometry after autosave restore/sync.
        for (const c of this.circles) this._renderCircle(c);

        // Draw ratsnest
        this._updateRatsnest();

        // Only fit-to-content on the first sync so we don't
        // reset the user's pan/zoom on every change
        if (!this._hasContent) {
            this._fitToPlacedContent();
            this._hasContent = true;
        }

        const netCount = netlist.length;
        this._setStatus(`${components.length} component(s), ${netCount} net(s)`);

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
    _renderPersistentObjects() {
        const getGroup = (id) => this._getLayerGroup(id);

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
        const routeParams = this._getRoutingParams?.();
        for (const t of this.tracks) {
            removeTrackElements(t);
            renderTrack(t, getGroup, {
                viaDiameter: routeParams?.viaDiameter,
                viaDrill: routeParams?.viaDrill,
                hideNetLabel: t === this._selectedTrack || t === this._vertexDrag?.track,
            });
        }
        for (const v of this.vias) {
            removeViaElements(v);
            renderVia(v, getGroup);
        }
        for (const h of this.holes) {
            removeHoleElements(h);
            renderHole(h, getGroup);
        }

        // Free-standing circles.
        this._circleElements.clear();
        for (const c of this.circles) {
            this._renderCircle(c);
        }

        // Copper pours. Their model (copperFills) survives the rebuild but
        // their SVG is wiped by _clearPCBContent, so re-pour them here. This
        // is coalesced to one recompute on the next frame, by which point any
        // footprint placement in the same sync pass has finished, so the pour
        // clips against the up-to-date obstacles.
        if (this.copperFills.length) {
            this._refreshFills();
        }
    }

    /**
     * Remove all PCB footprint and ratsnest content from layer groups.
     */
    _clearPCBContent() {
        // Clear children of layer groups (but keep the groups themselves)
        for (const [, g] of this._layerGroups) {
            while (g.firstChild) g.removeChild(g.firstChild);
        }
        // Drop any reference-text selection/overlay tied to the old placements.
        this._refDrag = null;
        this._selectedRef = null;
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
            this._layerGroups.get(`${side}-fill`)?.removeAttribute('clip-path');
        }
        this._hasCopperCuts = false;
    }

    /**
     * Place footprints in a grid arrangement on the PCB canvas.
     * @param {Array} components - Components from extractComponents()
     */
    _placeFootprints(components) {
        const SPACING_X = 20;  // mm between component centres (horizontal)
        const SPACING_Y = 20;  // mm between component centres (vertical)
        const COLS = Math.max(1, Math.ceil(Math.sqrt(components.length)));
        // Offset to place components inside the board outline
        // Y is flipped: positive user-Y = negative SVG-Y
        const MARGIN = 10;  // mm from board edge
        const offsetX = MARGIN;
        const offsetY = -(MARGIN);  // start near top of board in SVG coords

        // Assign a stable auto-grid slot to every component that has no manual
        // override. Slots are remembered per component id (in _autoSlots) so
        // that deleting one component does NOT reflow the others: each un-moved
        // footprint keeps the exact spot it was first given. A grid cell is
        // computed only for components seen for the first time, scanning for
        // the lowest cell not already taken by an override or an existing slot.
        const slotPos = (i) => ({
            x: offsetX + (i % COLS) * SPACING_X,
            y: offsetY - Math.floor(i / COLS) * SPACING_Y,
        });
        const posKey = (x, y) => `${Math.round(x * 100)},${Math.round(y * 100)}`;
        const occupied = new Set();
        for (const comp of components) {
            const ov = this._placementOverrides.get(comp.id);
            if (ov) { occupied.add(posKey(ov.x, ov.y)); continue; }
            const slot = this._autoSlots.get(comp.id);
            if (slot) occupied.add(posKey(slot.x, slot.y));
        }
        for (const comp of components) {
            if (this._placementOverrides.has(comp.id) || this._autoSlots.has(comp.id)) continue;
            let i = 0, pos = slotPos(0);
            while (occupied.has(posKey(pos.x, pos.y))) { i++; pos = slotPos(i); }
            occupied.add(posKey(pos.x, pos.y));
            this._autoSlots.set(comp.id, pos);
        }

        for (let i = 0; i < components.length; i++) {
            const comp = components[i];
            let rot = 0;
            // Honour a remembered manual position so a moved footprint stays
            // put across schematic re-syncs and reloads; otherwise use the
            // component's stable auto-grid slot.
            const override = this._placementOverrides.get(comp.id);
            let cx, cy;
            if (override) {
                cx = override.x;
                cy = override.y;
                rot = override.rotation || 0;
            } else {
                const slot = this._autoSlots.get(comp.id);
                cx = slot.x;
                cy = slot.y;
            }

            // Generate footprint geometry (use real pad data when available)
            const fpGeom = generateFootprint(
                comp.footprint, comp.pins,
                comp.footprintShapes, comp.footprintBBox,
                comp.source
            );

            // Render SVG (returns Map<layerId, SVGGElement>)
            const fpLayers = renderFootprint(fpGeom, comp.reference, cx, cy, rot);

            // Distribute each layer's group to the correct SVG layer
            /** @type {SVGGElement[]} */
            const elements = [];
            for (const [layerId, layerGroup] of fpLayers) {
                this._getLayerGroup(layerId).appendChild(layerGroup);
                elements.push(layerGroup);
            }

            // Build pad world-position map for ratsnest
            const padMap = new Map();
            /** @type {Array<{number: string, padId: string, dx: number, dy: number, width: number, height: number, layer: string, shape: string}>} */
            const padOffsets = [];
            // Some footprints carry several physical pads that share one pad
            // number (e.g. the four shell/shield pads of a USB connector, or a
            // QFN's exposed thermal pad). A Map keyed purely by number would
            // collapse them, leaving all but one unselectable / unroutable. So
            // each pad gets a unique padId: the first of a number keeps
            // padId === number (net-side lookups by number still resolve), and
            // duplicates get a "#k" suffix. Every pad entry also stores its
            // original number for net resolution.
            const numCount = new Map();
            for (const pad of fpGeom.pads) {
                const num = String(pad.number);
                const seen = numCount.get(num) || 0;
                numCount.set(num, seen + 1);
                const padId = seen === 0 ? num : `${num}#${seen + 1}`;
                padMap.set(padId, { x: cx + pad.x, y: cy + pad.y, number: num });
                padOffsets.push({ number: num, padId, dx: pad.x, dy: pad.y, width: pad.width, height: pad.height, drill: pad.drill || 0, layer: pad.layer, shape: pad.shape || 'rect', mask: pad.mask !== false, paste: pad.paste !== false });
            }
            // Paste-only stencil apertures (no copper) — e.g. a QFN exposed
            // pad's windowpane matrix. Carried separately so they reach the
            // paste gerber without polluting copper/ratsnest/netlist.
            /** @type {Array<{dx: number, dy: number, width: number, height: number, shape: string, side: string}>} */
            const pasteOffsets = [];
            for (const ap of (fpGeom.pasteApertures || [])) {
                pasteOffsets.push({ dx: ap.x, dy: ap.y, width: ap.width, height: ap.height, shape: ap.shape || 'rect', side: ap.side || 'top' });
            }

            this.placements.set(comp.id, {
                x: cx,
                y: cy,
                pads: padMap,
                padOffsets,
                pasteOffsets,
                elements,
                bounds: fpGeom.courtyard || fpGeom.outline,
                outline: fpGeom.outline || null,
                reference: comp.reference,
                value: comp.value || '',
                footprint: comp.footprint || '',
                source: comp.source || '',
                model3dObj: comp.model3dObj || null,
                model3dUrl: comp.model3dUrl || null,
                model3dPlacement: fpGeom.model3d || null,
                silks: fpGeom.silks || [],
                rotation: rot,
                mirror: !!override?.mirror,
                side: override?.side === 'bottom' ? 'bottom' : 'top',
                refVisible: override?.refVisible !== false,
                refDx: override?.refDx || 0,
                refDy: override?.refDy || 0,
                refRot: ((override?.refRot || 0) % 360 + 360) % 360,
                refSize: override?.refSize || REF_DEFAULT_SIZE,
                refStrokeWidth: override?.refStrokeWidth || REF_DEFAULT_STROKE,
            });
            this._buildLodPlaceholder(comp.id);
        }

        // Apply mirror / bottom-side overrides now that all elements exist
        // (rotation and position were baked into renderFootprint above).
        for (const comp of components) {
            const pl = this.placements.get(comp.id);
            if (!pl) continue;
            if (pl.side === 'bottom') applyPlacementSide(this, comp.id, 'bottom');
            if (pl.refVisible === false) applyPlacementRefVisible(this, comp.id, false);
            // padMap above is built from the un-rotated local offsets
            // (cx+dx, cy+dy); a rotation, mirror or bottom-side placement must
            // recompute the pads' world positions so the ratsnest (and routed
            // track re-gluing) follow the footprint's true orientation. The SVG
            // already carries the same translate+rotate transform, so this only
            // corrects the pad geometry — it does not double-rotate the render.
            if (pl.mirror || pl.side === 'bottom' || pl.rotation || pl.refDx || pl.refDy || pl.refRot) applyPlacementPose(this, comp.id);
            if (pl.refSize !== REF_DEFAULT_SIZE || pl.refStrokeWidth !== REF_DEFAULT_STROKE) this._rerenderRef(comp.id);
        }
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
        this._getLayerGroup('fp-lod').appendChild(rect);
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
            // Never collapse the actively-selected footprint — keep it editable.
            const px = Math.max(b.maxX - b.minX, b.maxY - b.minY) * scale;
            const far = inView && px < PCB_LOD_PIXEL_THRESHOLD && compId !== this._selectedComp;

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
        const mx = pl.mirror ? -1 : 1;
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
    _updateRatsnest(opts) {
        // Net-based rebuild — draws guide lines between every disconnected
        // cluster of same-net copper (pads, tracks and vias alike). When
        // `opts.nets` is supplied (live footprint drag) only those nets are
        // recomputed; every other net's ratlines are left untouched.
        reconcileRatsnest(this, opts);
        // A highlighted incomplete-connection violation draws a temporary copy
        // of its ratline. Reconcile just moved the real ratlines (live drag),
        // so snap that temp copy to the fresh geometry too — it should track
        // its endpoints exactly like a real ratline.
        if (this._drcSelectedId) this._followDRCRatline();
    }

    /**
     * Re-anchor the selected incomplete-connection marker's temporary ratline
     * to the live ratsnest geometry, so it follows whatever it connects to as
     * that copper is moved (just like a real ratline). Matches the marker to
     * the live ratline of the same net whose endpoints are nearest its current
     * ones, then redraws the marker.
     */
    _followDRCRatline() {
        const sel = this._drcViolations?.find(v => v.id === this._drcSelectedId);
        const m = sel?.marker;
        if (!m || m.type !== 'ratline' || !m.a || !m.b) return;

        const net = m.net || '';
        const dist2 = (ax, ay, bx, by) => (ax - bx) ** 2 + (ay - by) ** 2;
        let best = null, bestD = Infinity;
        for (const r of this._collectRatlines()) {
            if ((r.net || '') !== net) continue;
            if (![r.x1, r.y1, r.x2, r.y2].every(Number.isFinite)) continue;
            const dA = dist2(r.x1, r.y1, m.a.x, m.a.y) + dist2(r.x2, r.y2, m.b.x, m.b.y);
            const dB = dist2(r.x1, r.y1, m.b.x, m.b.y) + dist2(r.x2, r.y2, m.a.x, m.a.y);
            const d = Math.min(dA, dB);
            if (d < bestD) {
                bestD = d;
                best = (dA <= dB)
                    ? { a: { x: r.x1, y: r.y1 }, b: { x: r.x2, y: r.y2 } }
                    : { a: { x: r.x2, y: r.y2 }, b: { x: r.x1, y: r.y1 } };
            }
        }
        if (!best) return;

        m.a = best.a;
        m.b = best.b;
        sel.x = (best.a.x + best.b.x) / 2;
        sel.y = (best.a.y + best.b.y) / 2;
        this._drawDRCMarker(sel);
        this._updateDRCConnector();
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
    _setStatus(text) {
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
     * @returns {string|null}
     */
    _hitTestComponent(worldPos) {
        let hit = null;
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
            }
        }
        return hit;
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
            // Hover highlight for the component body under the cursor.
            this._hoverComponent(this._hitTestComponent(worldPos));
            // Hover highlight for tracks/vias.
            const trackHover = hitTestTrack(this, worldPos);
            const hovered = this._hitTestPad(worldPos) || trackHover;
            setHoverHighlight(this, hovered);
            // Net-name tooltip for the hovered pad/track/via.
            this._updateNetTooltip(ev, hovered);
            // Hover highlight for text annotations.
            this._setTextHover(this._hitTestText(worldPos));
            // Hover highlight for free-standing circles.
            this._setCircleHover(this._hitTestCircle(worldPos));
            // Cursor feedback: a diagonal double-arrow (matching the
            // schematic editor's graph anchors) when the pointer is over a
            // draggable track node. Only toggle on transitions so we don't
            // clobber other cursors (e.g. a selected component's grab).
            const overNode = trackHover?.type === 'track'
                && !!hitTestTrackNode(this, trackHover.track, worldPos);
            const overMidpoint = !overNode
                && trackHover?.type === 'track'
                && trackHover.track === this._selectedTrack
                && !!hitTestTrackMidpoint(this, trackHover.track, worldPos);
            const overRef = !overNode && !overMidpoint
                && !!this._hitTestRefText(worldPos);
            if (overNode) {
                this.viewport.svg.style.cursor = 'nwse-resize';
                this._hoverNodeCursor = true;
            } else if (overMidpoint) {
                this.viewport.svg.style.cursor = 'copy';
                this._hoverNodeCursor = true;
            } else if (overRef) {
                this.viewport.svg.style.cursor = 'move';
                this._hoverNodeCursor = true;
            } else if (this._hoverNodeCursor) {
                this._hoverNodeCursor = false;
                this._updateCursorForTool();
            }
        });
    }

    _hitTestPad(worldPos) {
        for (const [componentId, pl] of this.placements) {
            if (!pl?.padOffsets) continue;
            // For 90°/270° placement rotations the pad's footprint-local
            // width/height are swapped in world space; account for that so the
            // hit region tracks the pad's actual on-screen extent.
            const ortho = Math.abs((pl.rotation || 0) % 180) === 90;
            for (const off of pl.padOffsets) {
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
     * Only appears for an unselected pad/track/via, after a short delay.
     * @param {MouseEvent} e
     * @param {{type:string, track?:any, via?:any}|null} hovered
     */
    _updateNetTooltip(e, hovered) {
        // Skip when nothing is hovered or the hovered item is selected.
        const isSelected = hovered
            && ((hovered.type === 'track' && hovered.track === this._selectedTrack)
                || (hovered.type === 'via' && hovered.via === this._selectedVia));
        if (!hovered || isSelected) {
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
     * Reposition already-built placements to their remembered override
     * positions. Used when overrides are restored after the placements were
     * already created (otherwise _placeFootprints applies them at build time).
     */
    _applyPlacementOverrides() {
        for (const [compId, o] of this._placementOverrides) {
            const pl = this.placements.get(compId);
            if (!pl) continue;
            pl.x = o.x;
            pl.y = o.y;
            pl.rotation = o.rotation || 0;
            pl.mirror = !!o.mirror;
            pl.refDx = o.refDx || 0;
            pl.refDy = o.refDy || 0;
            pl.refRot = ((o.refRot || 0) % 360 + 360) % 360;
            pl.refSize = o.refSize || REF_DEFAULT_SIZE;
            pl.refStrokeWidth = o.refStrokeWidth || REF_DEFAULT_STROKE;
            applyPlacementSide(this, compId, o.side === 'bottom' ? 'bottom' : 'top');
            applyPlacementRefVisible(this, compId, o.refVisible !== false);
            applyPlacementPose(this, compId);
            if (pl.refSize !== REF_DEFAULT_SIZE || pl.refStrokeWidth !== REF_DEFAULT_STROKE) {
                this._rerenderRef(compId);
            }
        }
        this._updateRatsnest?.();
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
        this._placementOverrides.set(compId, {
            x: pl.x,
            y: pl.y,
            rotation: pl.rotation || 0,
            mirror: !!pl.mirror,
            side: pl.side === 'bottom' ? 'bottom' : 'top',
            refVisible: pl.refVisible !== false,
            refDx: pl.refDx || 0,
            refDy: pl.refDy || 0,
            refRot: ((pl.refRot || 0) % 360 + 360) % 360,
            refSize: pl.refSize || REF_DEFAULT_SIZE,
            refStrokeWidth: pl.refStrokeWidth || REF_DEFAULT_STROKE,
        });
        this._markDirty();
    }

    /**
     * Select a component (or deselect if null).
     * Adds/removes a highlight outline on all layer groups for that component.
     * @param {string|null} compId
     */
    _selectComponent(compId) {
        // Remove old selection highlight
        if (this._selectedComp) {
            const oldPl = this.placements.get(this._selectedComp);
            if (oldPl?.elements) {
                for (const el of oldPl.elements) {
                    el.querySelector('.pcb-selection-highlight')?.remove();
                }
            }
        }

        this._selectedComp = compId;
        this._syncClipboardButtons?.();

        if (!compId) {
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

        this.viewport.svg.style.cursor = 'grab';
        // Ensure the selected footprint shows full detail even when zoomed out
        // far enough that it would otherwise be collapsed to its LOD placeholder.
        this._updatePcbCulling();
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
        if (compId === this._selectedComp) compId = null;
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
     * Each move re-applies the placement pose and rebuilds the WHOLE board's
     * ratsnest (reconcileRatsnest is O(tracks+pads+vias)). Running that on
     * every raw mousemove backs up the event queue on dense boards, so the
     * component visibly lags the cursor — even for a part with no tracks
     * attached, because the rebuild cost is board-wide, not per-component.
     * Stash the latest pointer event and process a single pass per frame.
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

        const worldPos = this._screenToWorld(e);
        const dx = worldPos.x - this._drag.startWorld.x;
        const dy = worldPos.y - this._drag.startWorld.y;
        const newX = this._drag.startPos.x + dx;
        const newY = this._drag.startPos.y + dy;

        // Snap to grid if enabled (Shift temporarily reverses the setting)
        let snapX = newX, snapY = newY;
        if (this._snapActive()) {
            const gs = this.viewport.gridSize;
            snapX = Math.round(newX / gs) * gs;
            snapY = Math.round(newY / gs) * gs;
        }

        const pl = this.placements.get(this._drag.compId);
        if (!pl) return;

        // Update placement position, then re-apply the full pose (so any
        // rotation is preserved) — this moves the SVG, LOD placeholder and
        // pad halos, recomputes pad world positions and re-glues bonded
        // track endpoints.
        pl.x = snapX;
        pl.y = snapY;
        applyPlacementPose(this, this._drag.compId);

        // Rebuild ratsnest in real-time — restricted to the dragged
        // component's nets (incremental); the rest of the board is untouched.
        this._updateRatsnest({ nets: this._drag.nets });
    }

    /**
     * End a drag operation and rebuild ratsnest.
     */
    _endDrag() {
        if (!this._drag) return;
        // Flush any pointer move coalesced by _scheduleDragUpdate so the final
        // resting position reflects the very last mouse position, not the one
        // from the previous animation frame.
        if (this._dragRaf) {
            cancelAnimationFrame(this._dragRaf);
            this._dragRaf = 0;
        }
        if (this._pendingDragEvent) {
            const ev = this._pendingDragEvent;
            this._pendingDragEvent = null;
            this._handleDrag(ev);
        }
        const { compId, startPos } = this._drag;
        const pl = this.placements.get(compId);
        this._drag = null;
        // Drag finished — re-enable the deferred overlays so the reconcile
        // below (or the MovePlacementCommand's) rebuilds pours + clearance
        // halos once, at the final resting position. The clearance rebuild
        // wipes and recreates every pad-halo group, so the dragged
        // component's group (hidden on drag start) returns visible.
        this._deferDragOverlays = false;
        // Drop the GPU-layer promotion applied during the drag so the overlay
        // returns to normal painting (avoids holding a compositing layer).
        if (this._clearancesVisible) {
            const ov = this._layerGroups.get('clearance-overlay');
            if (ov) ov.style.willChange = '';
        }
        this.viewport.svg.style.cursor = this._selectedComp ? 'grab' : 'default';
        // If the placement actually moved, push a MovePlacementCommand so the
        // drag is undoable. _handleDrag has already applied the new position;
        // construct the command with execute=no-op by passing identical
        // to-coords on first execute (we instead apply manually by calling
        // execute() which re-applies, idempotent).
        if (pl && (pl.x !== startPos.x || pl.y !== startPos.y)) {
            const cmd = new MovePlacementCommand(this, compId, startPos.x, startPos.y, pl.x, pl.y);
            // The drag already moved the component visually; execute() will
            // re-apply the same position (idempotent), so the history stack
            // is correct without double-rendering.
            this.history.execute(cmd);
        } else {
            this._updateRatsnest();
        }
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

    /** Snap a world point to grid if snap-to-grid is enabled. */
    _snapToGrid(p) {
        if (!this._snapActive()) return { x: p.x, y: p.y };
        const gs = this.viewport.gridSize;
        return { x: Math.round(p.x / gs) * gs, y: Math.round(p.y / gs) * gs };
    }

    /**
     * Render `text` into its layer group, replacing any prior element
     * with the same id. Stores the new element in _textElements.
     */
    _renderText(text) {
        this._removeTextElement(text.id);
        const layerG = this._getLayerGroup(text.layer);
        if (!layerG) return;
        const isSel = this._selectedText?.id === text.id;
        const isHover = !isSel && this._hoveredText?.id === text.id;
        // While inline-editing, render the text in white so it doesn't
        // disappear against same-coloured tracks/pads on the layer.
        const isEditing = this._textEdit?.text?.id === text.id;
        const isLight = document.documentElement.getAttribute('data-theme') === 'light';
        const selColor = isLight ? '#000000' : '#ffffff';
        const hoverColor = isLight ? '#555555' : '#aaaaaa';
        const editColor = isLight ? '#000000' : '#ffffff';
        const strokeOverride = isEditing ? editColor
            : isSel ? selColor
            : isHover ? hoverColor
            : undefined;
        const el = renderPcbText(text, strokeOverride);
        layerG.appendChild(el);
        this._textElements.set(text.id, el);
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
        if (prev && (!next || prev.id !== next.id)) this._refreshText(prev.id);
        if (next) this._refreshText(next.id);
    }

    /** Re-render an existing text in place (e.g. after a property change). */
    _refreshText(id) {
        const t = this.texts.get(id);
        if (!t) return;
        this._renderText(t);
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
        const prev = this._selectedText;
        const next = text || null;
        // No-op when selection doesn't change — important because
        // _refreshText removes & re-creates the SVG element, which
        // breaks the browser's same-target requirement for `dblclick`.
        if (prev === next || (prev && next && prev.id === next.id)) return;
        this._selectedText = next;
        this._syncClipboardButtons?.();
        if (prev && (!next || prev.id !== next.id)) this._refreshText(prev.id);
        if (next) this._refreshText(next.id);
    }

    /** Drag an already-selected text. */
    _handleTextDrag(e) {
        if (!this._textDrag) return;
        this.viewport.shiftHeld = e.shiftKey;
        const worldPos = this._screenToWorld(e);
        const dx = worldPos.x - this._textDrag.startWorld.x;
        const dy = worldPos.y - this._textDrag.startWorld.y;
        const snap = this._snapToGrid({
            x: this._textDrag.startPos.x + dx,
            y: this._textDrag.startPos.y + dy,
        });
        const t = this.texts.get(this._textDrag.textId);
        if (!t) return;
        t.x = snap.x;
        t.y = snap.y;
        this._refreshText(t.id);
    }

    /** End a text drag, pushing a MoveTextCommand if it actually moved. */
    _endTextDrag() {
        if (!this._textDrag) return;
        const { textId, startPos } = this._textDrag;
        this._textDrag = null;
        this.viewport.svg.style.cursor = 'default';
        const t = this.texts.get(textId);
        if (!t) return;
        if (t.x === startPos.x && t.y === startPos.y) return;
        // The visible position is already current; record the move so it's
        // undoable. Roll back first, then execute so the command stays the
        // single source of truth.
        const x1 = t.x, y1 = t.y;
        t.x = startPos.x; t.y = startPos.y;
        this._refreshText(t.id);
        this.history.execute(new MoveTextCommand(this, textId, startPos.x, startPos.y, x1, y1));
    }

    // ── Reference-designator move / rotate ────────────────────
    // A component's reference (e.g. "R3") is rendered as part of its
    // footprint but can be repositioned and rotated relative to the body,
    // mirroring the schematic editor. The label text itself comes from the
    // schematic, so it is never edited in place here.

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
     * placement pose so the new geometry picks up the current offset/rotation
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
        applyRefGeometry(el, pl.reference, cxRef, baseY,
            pl.refSize || REF_DEFAULT_SIZE, pl.refStrokeWidth || REF_DEFAULT_STROKE);
        pl._refBox = null; // bbox changed — invalidate cache
        applyPlacementPose(this, compId);
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
            const box = this._refBox(pl);
            if (!box) continue;
            // Inverse of the ref transform: undo placement, then ref offset,
            // then ref rotation about the box centre.
            const local = this._worldToPlacementLocal(worldPos, pl);
            let ax = local.x - (pl.refDx || 0);
            let ay = local.y - (pl.refDy || 0);
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
        const next = compId || null;
        if (this._selectedRef === next) {
            if (next) this._drawRefOverlay(next, false);
            return;
        }
        this._selectedRef = next;
        this._syncClipboardButtons?.();
        this._drawRefOverlay(next, false);
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
     * Draw (or clear) the dashed selection box around a component's reference
     * text, and optionally the dotted tether from the component origin to the
     * label. Passing a null/invalid compId clears the overlay.
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
        const NS = 'http://www.w3.org/2000/svg';
        const dx = pl.refDx || 0, dy = pl.refDy || 0, rr = pl.refRot || 0;
        const rad = rr * Math.PI / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        // Pad the tight glyph box outward a little so the selection outline
        // (and grab region) sits comfortably around the label rather than
        // touching the strokes.
        const PAD = REF_BOX_PAD;
        const x0 = box.bx - PAD, y0 = box.by - PAD;
        const x1 = box.bx + box.bw + PAD, y1 = box.by + box.bh + PAD;
        // Four corners of the local box → rotate about centre → +offset → world.
        const corners = [
            [x0, y0], [x1, y0], [x1, y1], [x0, y1],
        ].map(([lx, ly]) => {
            const ox = lx - box.cx, oy = ly - box.cy;
            const rxL = box.cx + ox * cos - oy * sin + dx;
            const ryL = box.cy + ox * sin + oy * cos + dy;
            return this._placementLocalToWorld(pl, rxL, ryL);
        });
        const poly = document.createElementNS(NS, 'polygon');
        poly.setAttribute('points', corners.map(p => `${p.x},${p.y}`).join(' '));
        poly.setAttribute('fill', 'rgba(51,153,255,0.10)');
        poly.setAttribute('stroke', '#3399ff');
        poly.setAttribute('stroke-width', '1.2');
        poly.setAttribute('stroke-dasharray', '4 3');
        poly.setAttribute('vector-effect', 'non-scaling-stroke');
        poly.setAttribute('pointer-events', 'none');
        g.appendChild(poly);
        if (withTether) {
            const c = this._refCenterWorld(pl, box);
            const line = document.createElementNS(NS, 'line');
            line.setAttribute('x1', String(pl.x));
            line.setAttribute('y1', String(pl.y));
            line.setAttribute('x2', String(c.x));
            line.setAttribute('y2', String(c.y));
            line.setAttribute('stroke', '#3399ff');
            line.setAttribute('stroke-width', '1');
            line.setAttribute('stroke-dasharray', '3 3');
            line.setAttribute('vector-effect', 'non-scaling-stroke');
            line.setAttribute('pointer-events', 'none');
            g.appendChild(line);
        }
    }

    /** Drag an already-selected reference designator. */
    _handleRefDrag(e) {
        if (!this._refDrag) return;
        const pl = this.placements.get(this._refDrag.compId);
        if (!pl) return;
        this.viewport.shiftHeld = e.shiftKey;
        const localNow = this._worldToPlacementLocal(this._screenToWorld(e), pl);
        const localStart = this._worldToPlacementLocal(this._refDrag.startWorld, pl);
        let dx = this._refDrag.startDx + (localNow.x - localStart.x);
        let dy = this._refDrag.startDy + (localNow.y - localStart.y);
        if (this._snapActive()) {
            const gs = this.viewport.gridSize || 0;
            if (gs > 0) {
                dx = Math.round(dx / gs) * gs;
                dy = Math.round(dy / gs) * gs;
            }
        }
        pl.refDx = dx;
        pl.refDy = dy;
        applyPlacementPose(this, this._refDrag.compId);
        this._drawRefOverlay(this._refDrag.compId, true);
    }

    /** End a ref-text drag, pushing a MoveRefTextCommand if it actually moved. */
    _endRefDrag() {
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
        // Roll back, then execute so the command is the single source of truth.
        const tx = pl.refDx || 0, ty = pl.refDy || 0;
        pl.refDx = startDx; pl.refDy = startDy;
        applyPlacementPose(this, compId);
        this.history.execute(new MoveRefTextCommand(this, compId, startDx, startDy, tx, ty));
        this._drawRefOverlay(compId, false);
    }

    /** Rotate the selected reference designator by 90° (through history). */
    _rotateRefText(compId) {
        const pl = this.placements.get(compId);
        if (!pl) return;
        const cur = ((pl.refRot || 0) % 360 + 360) % 360;
        const next = (cur + 90) % 360;
        this.history.execute(new RotateRefTextCommand(this, compId, cur, next));
        this._drawRefOverlay(compId, false);
        if (this._selectedRef === compId) this._showRefProperties(compId);
    }

    /** Show tool-options spinners for the Text tool. */
    _showTextToolOptions() {
        const d = this._textDefaults;
        this._showToolOptions(`
            <label style="display:flex;align-items:center;gap:4px;font-size:11px">Size
              <input type="number" id="pcbTextSize" value="${d.size}" min="0.2" max="20" step="0.1" style="width:50px">
            </label>
            <label style="display:flex;align-items:center;gap:4px;font-size:11px">Line W
              <input type="number" id="pcbTextLW" value="${d.strokeWidth}" min="0.05" max="2" step="0.05" style="width:55px">
            </label>
        `, () => {
            const s = document.getElementById('pcbTextSize');
            const lw = document.getElementById('pcbTextLW');
            s?.addEventListener('input', () => {
                const v = parseFloat(s.value);
                if (Number.isFinite(v) && v > 0) this._textDefaults.size = v;
            });
            lw?.addEventListener('input', () => {
                const v = parseFloat(lw.value);
                if (Number.isFinite(v) && v > 0) this._textDefaults.strokeWidth = v;
            });
        });
    }

    _layerLabel(layer) {
        switch (layer) {
            case 'top-silk':      return 'Top Silk';
            case 'bottom-silk':   return 'Bottom Silk';
            case 'top-copper':    return 'Top Copper';
            case 'bottom-copper': return 'Bottom Copper';
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
        const items = this._pcbPropsItems();
        if (!items) return;
        this._setPcbPropsTitle('Text');
        const layerOpts = TEXT_LAYERS.map(l =>
            `<option value="${l}" ${l === text.layer ? 'selected' : ''}>${this._layerLabel(l)}</option>`
        ).join('');
        const isEditingThis = this._textEdit?.text?.id === text.id;
        const insertRow = isEditingThis ? `
            <div class="prop-row"><label>Insert</label><select id="pcbPropTextInsert">
                <option value="">Symbol…</option>
                <option value="\u00A9">© Copyright</option>
                <option value="\u00AE">® Registered</option>
                <option value="\u2122">™ Trademark</option>
                <option value="\u00B0">° Degree</option>
                <option value="\u00B5">µ Micro</option>
                <option value="\u03A9">Ω Ohm</option>
                <option value="\u00B1">± Plus-minus</option>
                <option value="\u00D7">× Times</option>
                <option value="\u00F7">÷ Divide</option>
            </select></div>` : '';
        items.innerHTML = `
            <div class="prop-row"><label>Layer</label><select id="pcbPropTextLayer">${layerOpts}</select></div>
            <div class="prop-row"><label>Size (mm)</label><input type="number" id="pcbPropTextSize" value="${text.size}" min="0.2" step="0.1"></div>
            <div class="prop-row"><label>Rotation (°)</label><input type="number" id="pcbPropTextRot" value="${text.rotation}" step="15"></div>
            <div class="prop-row"><label>Line W (mm)</label><input type="number" id="pcbPropTextLW" value="${text.strokeWidth}" min="0.05" step="0.05"></div>
            ${insertRow}
        `;
        // Snapshot at first edit so undo collapses keystrokes into a
        // single command per field. The field binding/commit machinery is
        // shared with the reference-designator panel via _bindStrokeTextProps.
        const layerApply = (model, v) => {
            // Layer change: if mirror flips (top↔bottom), the rendered
            // text reflects about its anchor x and visually jumps. Shift
            // the anchor by the text width (rotated into world space) so
            // the visible glyphs stay put.
            const wasBottom = typeof model.layer === 'string' && model.layer.startsWith('bottom-');
            const willBottom = typeof v === 'string' && v.startsWith('bottom-');
            if (wasBottom !== willBottom) {
                const w = measureStrokeText(model.content, model.size);
                const sign = willBottom ? 1 : -1; // top→bottom: +w; bottom→top: -w
                const rot = (model.rotation || 0) * Math.PI / 180;
                // SVG-Y-down with rotate(-rot): dx,dy in local frame map
                // to (cos(rot)*dx, -sin(rot)*dx) in world.
                model.x += sign * w * Math.cos(rot);
                model.y += sign * w * -Math.sin(rot);
            }
            model.layer = v;
        };
        const num = (min) => (v) => {
            const n = parseFloat(v);
            if (!Number.isFinite(n)) return null;
            return min !== undefined ? Math.max(min, n) : n;
        };
        const rotParse = (v) => {
            const n = parseFloat(v);
            if (!Number.isFinite(n)) return null;
            return ((n % 360) + 360) % 360;
        };
        this._bindStrokeTextProps(items, text, {
            fields: [
                { id: 'pcbPropTextLayer', field: 'layer', parse: (v) => TEXT_LAYERS.includes(v) ? v : null, apply: layerApply },
                { id: 'pcbPropTextSize', field: 'size', parse: num(0.1) },
                { id: 'pcbPropTextRot', field: 'rotation', parse: rotParse, wrap: true },
                { id: 'pcbPropTextLW', field: 'strokeWidth', parse: num(0.01) },
            ],
            preview: (t) => this._refreshText(t.id),
            commit: (t, snap) => {
                const after = {};
                for (const k of ['content', 'layer', 'size', 'rotation', 'strokeWidth', 'x', 'y']) {
                    if (snap[k] !== t[k]) after[k] = t[k];
                }
                // Roll back to snapshot first; EditTextCommand will reapply.
                const final = { ...t };
                Object.assign(t, snap);
                this._refreshText(t.id);
                if (Object.keys(after).length === 0) return;
                Object.assign(t, final); // restore current values inside cmd
                this.history.execute(new EditTextCommand(this, t.id, after));
            },
        });
        // Insert-symbol dropdown: insert at caret when inline-editing,
        // otherwise append to the text via an EditTextCommand. Resets
        // to the placeholder after each selection so the same symbol
        // can be inserted again.
        const insertEl = /** @type {HTMLSelectElement|null} */
            (document.getElementById('pcbPropTextInsert'));
        insertEl?.addEventListener('change', () => {
            const sym = insertEl.value;
            insertEl.value = '';
            if (!sym) return;
            const edit = this._textEdit;
            if (edit && edit.text?.id === text.id) {
                const inp = edit.input;
                const sel = inp.selectionStart ?? inp.value.length;
                const end = inp.selectionEnd ?? sel;
                inp.value = inp.value.slice(0, sel) + sym + inp.value.slice(end);
                const pos = sel + sym.length;
                try { inp.setSelectionRange(pos, pos); } catch { /* */ }
                inp.dispatchEvent(new Event('input', { bubbles: true }));
                inp.focus();
            } else {
                this.history.execute(new EditTextCommand(this, text.id,
                    { content: (text.content || '') + sym }));
            }
        });

        this._setActiveRibbonTab?.('pcb-properties');
    }

    /**
     * Shared field-binding machinery for the stroke-text style panels (Text
     * objects and reference designators). For each spec field it wires the
     * input/change events so edits update the model live (via spec.preview)
     * and collapse into a single undo entry on commit (via spec.commit). A
     * snapshot of the model is taken on the first keystroke so spec.commit
     * can diff against the pre-edit state.
     * @param {Element} items container holding the inputs
     * @param {any} model object whose fields the inputs drive
     * @param {{fields: Array<{id:string, field:string, parse:(v:string)=>any, apply?:(m:any,v:any)=>void, wrap?:boolean}>, preview:(m:any)=>void, commit:(m:any, snap:any)=>void}} spec
     */
    _bindStrokeTextProps(items, model, spec) {
        let snapshot = null;
        const onInput = (f) => () => {
            if (!snapshot) snapshot = { ...model };
            const el = /** @type {HTMLInputElement|HTMLSelectElement|null} */ (items.querySelector('#' + f.id));
            const v = f.parse(el ? el.value : '');
            if (v === null || v === undefined) return;
            if (f.apply) f.apply(model, v); else model[f.field] = v;
            spec.preview(model);
        };
        const onCommit = () => {
            if (!snapshot) return;
            const snap = snapshot;
            snapshot = null;
            spec.commit(model, snap);
        };
        for (const f of spec.fields) {
            const el = /** @type {HTMLInputElement|HTMLSelectElement|null} */ (items.querySelector('#' + f.id));
            if (!el) continue;
            const handler = onInput(f);
            el.addEventListener('input', handler);
            // Spinner step clicks on number inputs fire 'change' without 'input'.
            el.addEventListener('change', handler);
            el.addEventListener('change', onCommit);
            if (f.wrap) {
                const wrapDeg = () => {
                    const n = parseFloat(el.value);
                    if (!Number.isFinite(n)) return;
                    const wrapped = ((n % 360) + 360) % 360;
                    if (wrapped !== n) el.value = String(wrapped);
                };
                el.addEventListener('input', wrapDeg);
                el.addEventListener('change', wrapDeg);
            }
        }
    }

    /**
     * Show the properties panel for a selected reference designator. Mirrors
     * the Text-object panel (Type/Layer/Size/Rotation/Line W) and reuses the
     * same field-binding helper, but the Reference string and Layer are
     * read-only — only Size, Rotation and Line W can be edited.
     * @param {string} compId
     */
    _showRefProperties(compId) {
        const pl = this.placements.get(compId);
        if (!pl) return;
        const items = this._pcbPropsItems();
        if (!items) return;
        this._setPcbPropsTitle('Reference');
        const silkLayer = pl.side === 'bottom' ? 'bottom-silk' : 'top-silk';
        const size = pl.refSize || REF_DEFAULT_SIZE;
        const lw = pl.refStrokeWidth || REF_DEFAULT_STROKE;
        const rot = ((pl.refRot || 0) % 360 + 360) % 360;
        items.innerHTML = `
            <div class="prop-row"><label>Reference</label><input type="text" id="pcbPropRefName" value="${pl.reference ?? ''}" disabled></div>
            <div class="prop-row"><label>Layer</label><input type="text" id="pcbPropRefLayer" value="${this._layerLabel(silkLayer)}" disabled></div>
            <div class="prop-row"><label>Size (mm)</label><input type="number" id="pcbPropRefSize" value="${size}" min="0.2" step="0.1"></div>
            <div class="prop-row"><label>Rotation (°)</label><input type="number" id="pcbPropRefRot" value="${rot}" step="15"></div>
            <div class="prop-row"><label>Line W (mm)</label><input type="number" id="pcbPropRefLW" value="${lw}" min="0.05" step="0.05"></div>
        `;
        const num = (min) => (v) => {
            const n = parseFloat(v);
            if (!Number.isFinite(n)) return null;
            return min !== undefined ? Math.max(min, n) : n;
        };
        const rotParse = (v) => {
            const n = parseFloat(v);
            if (!Number.isFinite(n)) return null;
            return ((n % 360) + 360) % 360;
        };
        this._bindStrokeTextProps(items, pl, {
            fields: [
                { id: 'pcbPropRefSize', field: 'refSize', parse: num(0.1) },
                { id: 'pcbPropRefRot', field: 'refRot', parse: rotParse, wrap: true },
                { id: 'pcbPropRefLW', field: 'refStrokeWidth', parse: num(0.01) },
            ],
            preview: () => {
                this._rerenderRef(compId);
                if (this._selectedRef === compId) this._drawRefOverlay(compId, true);
            },
            commit: (m, snap) => {
                const before = { refSize: snap.refSize, refStrokeWidth: snap.refStrokeWidth, refRot: snap.refRot };
                const after = { refSize: m.refSize, refStrokeWidth: m.refStrokeWidth, refRot: m.refRot };
                const changed = before.refSize !== after.refSize
                    || before.refStrokeWidth !== after.refStrokeWidth
                    || before.refRot !== after.refRot;
                // Roll back; SetRefStyleCommand will reapply for undo history.
                Object.assign(m, before);
                this._rerenderRef(compId);
                if (this._selectedRef === compId) this._drawRefOverlay(compId, true);
                if (!changed) return;
                this.history.execute(new SetRefStyleCommand(this, compId, before, after));
            },
        });
        this._setActiveRibbonTab?.('pcb-properties');
    }

    /**
     * Delete the currently-selected text (if any). Called from the
     * Delete-key handler. Returns true if it consumed the keystroke.
     */
    _deleteSelectedText() {
        if (!this._selectedText) return false;
        const id = this._selectedText.id;
        this.history.execute(new RemoveTextCommand(this, id));
        this._clearProperties?.();
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
        if (!text) return;
        if (this._textEdit) this._endTextInlineEdit(true);

        const svg = this.viewport?.svg;
        if (!svg) return;

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

        const layerG = this._getLayerGroup(text.layer);
        // Editing box around the text (matches schematic style).
        const box = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        box.setAttribute('fill', 'none');
        box.setAttribute('stroke', '#00ccff');
        box.setAttribute('stroke-opacity', '0.5');
        box.setAttribute('vector-effect', 'non-scaling-stroke');
        box.setAttribute('stroke-width', '2');
        box.style.pointerEvents = 'none';
        layerG?.appendChild(box);

        const caret = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        // Use a contrasting colour so the caret stands out against the
        // silk/copper text colour (yellow/teal/red). A cyan-ish accent
        // works on every layer.
        caret.setAttribute('stroke', '#00ccff');
        caret.setAttribute('stroke-width', '2');
        caret.setAttribute('vector-effect', 'non-scaling-stroke');
        caret.setAttribute('stroke-linecap', 'butt');
        caret.style.pointerEvents = 'none';
        caret.style.opacity = '1';

        // Steady blink rhythm: a single setInterval toggles the caret
        // on a fixed cadence and is never reset. While the user is
        // actively typing or moving the caret, `forceVisibleUntil` is
        // bumped — the toggle then just keeps it visible without
        // touching the underlying rhythm, so there's no stutter.
        layerG?.appendChild(caret);

        this._textEdit = {
            text, input, caret, box,
            isNewPlacement: !!opts.isNewPlacement,
            originalContent: text.content,
            committed: false,
            blinkTimer: null,
            blinkEpoch: performance.now(),
            forceVisibleUntil: 0,
        };

        // Metronome: blink state is a pure function of wallclock time
        // (floor((now-epoch)/BLINK_MS) % 2). Movement bumps
        // forceVisibleUntil to hold the caret solid-on, but the
        // metronome keeps ticking underneath — so when movement
        // stops, the blink resumes exactly in phase.
        const BLINK_MS = 530;
        const IDLE_MS = 400;
        const tick = () => {
            const st = this._textEdit;
            if (!st) return;
            const now = performance.now();
            const beat = (Math.floor((now - st.blinkEpoch) / BLINK_MS) % 2) === 0;
            // Caret is solid-on while the activity hold is in effect.
            // After the hold expires, only release into the blink cycle
            // on a "light" beat — otherwise we'd flash dark for a few ms
            // then back to light, which reads as a disconcerting blink.
            let on;
            if (now < st.forceVisibleUntil) {
                on = true;
                st.releasePending = true;
            } else if (st.releasePending) {
                if (beat) { st.releasePending = false; on = true; }
                else { on = true; }   // hold through residual dark
            } else {
                on = beat;
            }
            st.caret.style.opacity = on ? '1' : '0';
        };
        // Sample faster than BLINK_MS so the visible transition
        // happens close to the true metronome edge.
        this._textEdit.blinkTimer = setInterval(tick, 60);

        // Surface the Properties panel for this text so the user can
        // tweak size/rotation/etc. mid-edit without leaving edit mode.
        this._selectedText = text;
        this._showTextProperties(text);
        const keepVisible = () => {
            const st = this._textEdit;
            if (!st) return;
            st.forceVisibleUntil = performance.now() + IDLE_MS;
            st.caret.style.opacity = '1';
        };

        const updateCaret = () => {
            // Update editing box bounds. Top of box sits a small pad
            // above the cap-top; bottom sits below the baseline far
            // enough to clear descenders (g, y, p, …).
            const totalW = measureStrokeText(input.value, text.size);
            const padX = text.size * 0.15;
            const padTop = text.size * 0.25;
            const padBot = text.size * 1.0;   // descender room (Hershey 'g','y' reach -0.75)
            const mirror = (typeof text.layer === 'string' && text.layer.startsWith('bottom-')) ? -1 : 1;
            box.setAttribute('x', String(-padX));
            box.setAttribute('y', String(-text.size - padTop));
            box.setAttribute('width', String(totalW + padX * 2));
            box.setAttribute('height', String(text.size + padTop + padBot));
            // scale(mirror,1) mirrors box + caret about the text's local Y
            // axis so the editing overlay tracks the mirrored rendered text
            // on bottom layers.
            const xform = `translate(${text.x},${text.y}) rotate(${-(text.rotation || 0)}) scale(${mirror},1)`;
            box.setAttribute('transform', xform);
            caret.setAttribute('transform', xform);

            const caretIdx = input.selectionStart ?? input.value.length;
            const sub = input.value.slice(0, caretIdx);
            const lx = measureStrokeText(sub, text.size);
            // Caret spans the editing box vertically (cap-top + small
            // overhang, baseline + descender room).
            const ly0 = text.size * 1.0;      // below baseline (matches box padBot)
            const ly1 = -text.size * 1.25;    // above cap-top (matches box: size+padTop)
            caret.setAttribute('x1', String(lx));
            caret.setAttribute('y1', String(ly0));
            caret.setAttribute('x2', String(lx));
            caret.setAttribute('y2', String(ly1));
            // Keep caret/box on top of the (re-rendered) text so a
            // fat stroke doesn't obscure the cursor.
            if (box.parentNode) box.parentNode.appendChild(box);
            if (caret.parentNode) caret.parentNode.appendChild(caret);
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
            text.content = input.value;
            this._refreshText(text.id);
            updateCaret();
            keepVisible();
        };
        input.addEventListener('input', live);
        input.addEventListener('keyup', () => { updateCaret(); keepVisible(); });
        input.addEventListener('click', () => { updateCaret(); keepVisible(); });
        input.addEventListener('select', () => { updateCaret(); keepVisible(); });

        // Document-level capture: while inline-editing, route text-editing
        // keys (printable chars, arrows, Home/End, Backspace/Delete) back
        // to the hidden input even if focus is on a Properties spinner,
        // so the user can tweak rotation/size and keep typing seamlessly.
        const docKeyCapture = (ev) => {
            const st = this._textEdit;
            if (!st) return;
            const active = document.activeElement;
            if (active === input) return;
            const propsPanel = document.getElementById('pcbPropertiesPanel');
            if (!(propsPanel && active && propsPanel.contains(active))) return;
            // Determine if this is a text-editing key we should reroute.
            const k = ev.key;
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
                if (!this._textEdit || this._textEdit.committed) return;
                const active = document.activeElement;
                if (active === input) return;
                if (propsPanel && active && propsPanel.contains(active)) return;
                input.focus();
            }, 0);
        });

        setTimeout(() => {
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
                const lx = (dx * cos - dy * sin) * mirror;
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
        state.committed = true;
        this._textEdit = null;

        const { text, input, caret, box, originalContent, blinkTimer, isNewPlacement } = state;
        const finalContent = input.value;

        if (blinkTimer) clearInterval(blinkTimer);
        if (state.docKeyCapture) document.removeEventListener('keydown', state.docKeyCapture, true);
        if (caret.parentNode) caret.parentNode.removeChild(caret);
        if (box.parentNode) box.parentNode.removeChild(box);
        if (input.parentNode) input.parentNode.removeChild(input);

        text.content = originalContent;
        this._refreshText(text.id);

        // Determine effective final content (empty if cancelled).
        const effective = commit ? finalContent : originalContent;
        // No empty orphans: if the resulting content is blank, delete
        // the text outright. For a freshly-created text (originalContent
        // was already empty), this avoids the undo stack growing for
        // an aborted placement; use Remove instead of Edit.
        if (effective.trim() === '') {
            if (isNewPlacement) {
                // Surgically remove the AddTextCommand for THIS text
                // from the undo stack — it may not be at the top if
                // committing a previous inline-edit pushed an
                // EditTextCommand on top (e.g. click-elsewhere flow).
                const stack = this.history.undoStack;
                for (let i = stack.length - 1; i >= 0; i--) {
                    const cmd = stack[i];
                    if (cmd?.constructor?.name === 'AddTextCommand' && cmd.text?.id === text.id) {
                        stack.splice(i, 1);
                        break;
                    }
                }
                this.history.redoStack = [];
                // Remove the model + SVG for the cancelled placement.
                this._removeTextElement(text.id);
                this.texts.delete(text.id);
            } else {
                this.history.execute(new RemoveTextCommand(this, text.id));
            }
            if (this._selectedText?.id === text.id) {
                this._selectedText = null;
                this._clearProperties?.();
            }
            this._exitTextTool();
            return;
        }

        if (commit && finalContent !== originalContent) {
            this.history.execute(new EditTextCommand(this, text.id, { content: finalContent }));
        }
        // Always deselect after exiting inline edit and return to home.
        this._selectText(null);
        this._clearProperties?.();
        this._exitTextTool();
    }

    /**
     * After finishing an inline text edit, return to the Home ribbon
     * tab. Keep the Text tool active so the user can immediately
     * place another label.
     */
    _exitTextTool() {
        this._setActiveRibbonTab?.('pcb-home');
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
                this._ratsnestGroup = this._getLayerGroup('ratlines');
            }
            this._updateRatsnest();

            // Fit viewport to board bounds
            if (routeInput.bounds && this.viewport) {
                const b = routeInput.bounds;
                const margin = 5;
                this.viewport.fitToBounds(
                    b.minX - margin, b.minY - margin,
                    b.maxX + margin, b.maxY + margin
                );
            }

            this._setStatus(`Loaded ${filename} — ${routeInput.connections.length} nets, click Auto Route to route`);

            // Store the original route input so runAutoRoute uses it directly
            // instead of rebuilding from placements/netlist
            this._testBoardRouteInput = routeInput;

        } catch (err) {
            this._setStatus(`Error loading test board: ${err.message}`);
            console.error(err);
        }
    }

    /**
     * Render test board pads as SVG rectangles for visual reference.
     */
    _renderTestBoardPads(routeInput) {
        const NS = 'http://www.w3.org/2000/svg';
        const topCopper = this._getLayerGroup('top-copper');
        const bottomCopper = this._getLayerGroup('bottom-copper');
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
     * Run the built-in A* maze autorouter on the current board layout.
     */
    async runAutoRoute() {
        if (!this.placements.size || !this.netlist.length) {
            this._setStatus('Nothing to route');
            return;
        }

        this.clearRoutes();

        // Show progress UI in status bar
        const cancelToken = { cancelled: false };
        this._routeCancelToken = cancelToken;
        this._routeProgressStartMs = performance.now();
        this._showRouteProgress(0, 1, 'Starting...', {
            phase: 'initial',
            pendingConnections: 0,
            pendingNets: 0,
            ripupDone: 0,
            ripupTotal: 0,
            ripupPass: 0,
            ripupMaxPasses: 4,
        });

        // Build route input from placements + netlist, or use stored test board input
        const usingTestBoard = !!this._testBoardRouteInput;
        const routeInput = this._testBoardRouteInput || this._buildRouteInput();
        this._testBoardRouteInput = null;  // consume it — only used once
        const routerMode = this._getRouterMode();
        // Always honour the current UI design rules, even when the source is a
        // test-board JSON that embedded its own values.
        const uiParams = this._getRoutingParams();
        routeInput.traceWidth = uiParams.trackWidth;
        routeInput.clearance = uiParams.clearance;
        routeInput.viaDiameter = uiParams.viaDiameter;
        // A stored test-board input pre-dates any copper text the user has
        // since drawn on it, so refresh its copper obstacles from the live
        // model. (_buildRouteInput already embeds these for the normal path.)
        if (usingTestBoard) {
            routeInput.copperObstacles = this._buildCopperObstacles();
        }
        this._routeNetUnrouted = new Map(routeInput.connections.map(c => [c.net, true]));
        this._routeLastBoundaryKey = '';
        this._reconcileRatsnestFromRouteState();

        try {
            const startTime = performance.now();

            const result = await this._runAutoRouteInWorker(routeInput, cancelToken, routerMode);

            if (cancelToken.cancelled) {
                // Keep and finalize partial routes so users can continue from this point.
                this._clearIncrementalTraces();
                this._renderRouteResult(result);
                const routedConns = result.totalConnectionCount - (result.failedConnectionCount || 0);
                const totalConns2 = result.totalConnectionCount || routeInput.connections.length;
                this._hideRouteProgress();
                this._setStatus(`${routedConns} of ${totalConns2} connections routed`);
                this._routeNetUnrouted = null;
                return;
            }

            await this._playRemainingRipupPhases();

            const elapsedSec = Math.max(0, Math.floor((performance.now() - startTime) / 1000));
            const elapsedMin = Math.floor(elapsedSec / 60);
            const elapsedRemSec = elapsedSec % 60;
            const elapsed = `${elapsedMin} min ${String(elapsedRemSec).padStart(2, '0')} sec`;

            // Clear incremental traces and do final clean render
            this._clearIncrementalTraces();
            this._renderRouteResult(result);

            const totalConns = result.totalConnectionCount || routeInput.connections.length;
            const viaCount = result.vias?.length || 0;
            this._hideRouteProgress();

            // Use the router's authoritative connection count
            const unroutedConns = result.failedConnectionCount || 0;
            const routedConns = totalConns - unroutedConns;

            this._setStatus(`Routed ${routedConns} of ${totalConns} connections (${unroutedConns} unrouted), ${result.traces.length} segments, ${viaCount} vias in ${elapsed}`);
            this._routeNetUnrouted = null;

        } catch (e) {
            console.error('Autorouter error:', e);
            this._hideRouteProgress();
            this._setStatus(`Route error: ${e.message}`);
            this._routeNetUnrouted = null;
        } finally {
            if (this._routeWorker) {
                this._routeWorker.terminate();
                this._routeWorker = null;
            }
        }
        this._routeCancelToken = null;
    }

    /**
     * Run routing in a dedicated worker and relay progress/events back to UI.
     * @param {import('../pcb/modules/autorouter-common.js').RouteInput} routeInput
     * @param {{cancelled: boolean}} cancelToken
    * @param {'maze'|'pathfinder'} routerMode
     * @returns {Promise<import('../pcb/modules/autorouter-common.js').RouteResult>}
     */
    _runAutoRouteInWorker(routeInput, cancelToken, routerMode = 'maze') {
        return new Promise((resolve, reject) => {
            const workerUrl = new URL('../pcb/modules/autorouter-worker.js', import.meta.url);
            const worker = new Worker(workerUrl, { type: 'module' });
            this._routeWorker = worker;
            let cancelPoll = null;

            const cleanup = () => {
                if (cancelPoll) {
                    clearInterval(cancelPoll);
                    cancelPoll = null;
                }
                worker.removeEventListener('message', onMessage);
                worker.removeEventListener('error', onError);
            };

            const onError = (err) => {
                cleanup();
                reject(err?.error || new Error(err?.message || 'Autorouter worker failed'));
            };

            const onMessage = (evt) => {
                const msg = evt.data || {};
                switch (msg.type) {
                    case 'progress': {
                        const { done, total, net, meta } = msg;
                        this._showRouteProgress(done, total, net, meta || {});
                        this._maybeReconcileAtPhaseBoundary(done, total, meta || {});
                        break;
                    }
                    case 'netRouted': {
                        const netTraces = msg.netTraces || [];
                        this._clearTryingLines();
                        // Clear old visuals for specific connections before rendering new paths
                        for (const trace of netTraces) {
                            if (trace.connId) this._clearIncrementalConnection(trace.connId);
                        }
                        const netName = netTraces?.[0]?.net;
                        if (netName) {
                            this._setRouteNetUnrouted(netName, false);
                        }
                        this._renderNetTraces(netTraces);
                        break;
                    }
                    case 'netFailed': {
                        this._clearTryingLines();
                        this._flashFailedNet(msg.conn);
                        break;
                    }
                    case 'connRipped': {
                        const connId = msg.connId;
                        if (connId) this._clearIncrementalConnection(connId);
                        break;
                    }
                    case 'netPendingChanged': {
                        const { netName, pendingConnections } = msg;
                        this._setRouteNetUnrouted(netName, pendingConnections > 0);
                        this._setRatsnestVisibilityForNet(netName, pendingConnections > 0);
                        break;
                    }
                    case 'trying': {
                        this._flashTryingLine(msg.from, msg.to);
                        break;
                    }
                    case 'done': {
                        cleanup();
                        resolve(msg.result);
                        break;
                    }
                    case 'error': {
                        cleanup();
                        reject(new Error(msg.error || 'Autorouter worker error'));
                        break;
                    }
                    default:
                        break;
                }
            };

            worker.addEventListener('message', onMessage);
            worker.addEventListener('error', onError);
            worker.postMessage({ type: 'start', routeInput, routerMode });

            cancelPoll = setInterval(() => {
                if (!cancelToken?.cancelled) return;
                if (this._routeWorker === worker) {
                    worker.postMessage({ type: 'cancel' });
                }
            }, 50);
        });
    }

    _setRouteNetUnrouted(netName, isUnrouted) {
        if (!this._routeNetUnrouted || !netName) return;
        this._routeNetUnrouted.set(netName, !!isUnrouted);
    }

    _reconcileRatsnestFromRouteState() {
        if (!this._routeNetUnrouted) return;
        const visibility = new Map();
        for (const [netName, isUnrouted] of this._routeNetUnrouted.entries()) {
            visibility.set(netName, !!isUnrouted);
        }
        this._applyRatsnestVisibilityMap(visibility);
    }

    _maybeReconcileAtPhaseBoundary(done, total, meta = {}) {
        const phase = meta?.phase || 'initial';
        if (phase === 'initial' && total > 0 && done === total) {
            const key = 'initial:end';
            if (this._routeLastBoundaryKey === key) return;
            this._routeLastBoundaryKey = key;
            this._reconcileRatsnestFromRouteState();
            return;
        }

        if (phase === 'ripup') {
            const pass = Number.isFinite(meta?.ripupPass) ? meta.ripupPass : 0;
            const ripDone = Number.isFinite(meta?.ripupDone) ? meta.ripupDone : -1;
            const ripTotal = Number.isFinite(meta?.ripupTotal) ? meta.ripupTotal : -2;
            if (pass > 0 && ripTotal >= 0 && ripDone === ripTotal) {
                const key = `ripup:${pass}:end`;
                if (this._routeLastBoundaryKey === key) return;
                this._routeLastBoundaryKey = key;
                this._reconcileRatsnestFromRouteState();
            }
        }
    }

    async _playRemainingRipupPhases() {
        const state = this._routeProgressState;
        if (!state) return;
        const isRipup = state.phase === 'ripup' || String(state.netName || '').startsWith('Rip-up');
        if (!isRipup) return;

        const currentPass = Math.max(0, state.ripupPass || 0);
        const maxPasses = Math.max(0, state.ripupMaxPasses || 0);
        if (currentPass <= 0 || maxPasses <= currentPass) return;

        for (let p = currentPass + 1; p <= maxPasses; p++) {
            this._showRouteProgress(1, 1, `Rip-up pass ${p}`, {
                phase: 'ripup',
                pendingConnections: state.pendingConnections,
                pendingNets: state.pendingNets,
                ripupDone: 1,
                ripupTotal: 1,
                ripupPass: p,
                ripupMaxPasses: maxPasses,
            });
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

    /**
     * Show routing progress in the status bar.
     */
    _showRouteProgress(done, total, netName, meta = {}) {
        if (!this.status.modeStatus) return;
        const prev = this._routeProgressState || {
            done: 0,
            total: 1,
            netName: 'Starting...',
            phase: 'initial',
            pendingConnections: 0,
            pendingNets: 0,
            ripupDone: 0,
            ripupTotal: 0,
            ripupPass: 0,
            ripupMaxPasses: 4,
        };
        const m = /** @type {any} */ (meta || {});
        this._routeProgressState = {
            done,
            total,
            netName,
            phase: m.phase || prev.phase || 'initial',
            pendingConnections: Number.isFinite(m.pendingConnections) ? m.pendingConnections : (prev.pendingConnections || 0),
            pendingNets: Number.isFinite(m.pendingNets) ? m.pendingNets : (prev.pendingNets || 0),
            ripupDone: Number.isFinite(m.ripupDone) ? m.ripupDone : (prev.ripupDone || 0),
            ripupTotal: Number.isFinite(m.ripupTotal) ? m.ripupTotal : (prev.ripupTotal || 0),
            ripupPass: Number.isFinite(m.ripupPass) ? m.ripupPass : (prev.ripupPass || 0),
            ripupMaxPasses: Number.isFinite(m.ripupMaxPasses) ? m.ripupMaxPasses : (prev.ripupMaxPasses || 4),
        };

        // Only build the DOM structure once; update text/width on subsequent calls
        let bar = this.status.modeStatus.querySelector('.route-progress-bar-fill');
        let label = this.status.modeStatus.querySelector('.route-progress-label');
        let elapsed = this.status.modeStatus.querySelector('.route-progress-elapsed');
        if (!bar) {
            this.status.modeStatus.innerHTML = `
                <span style="display:inline-flex;align-items:center;gap:8px">
                    <span class="route-progress-label"></span>
                    <span style="display:inline-block;width:80px;height:6px;background:var(--border-color);border-radius:3px;overflow:hidden;vertical-align:middle">
                        <span class="route-progress-bar-fill" style="display:block;height:100%;width:0%;background:var(--accent-color);border-radius:3px;transition:width 0.15s"></span>
                    </span>
                    <span class="route-progress-elapsed" style="font-size:10px;color:var(--text-muted)">0:00</span>
                    <button id="pcbRouteCancelBtn" style="
                        background:none;border:1px solid var(--text-muted);color:var(--text-primary);
                        padding:1px 8px;border-radius:3px;font-size:10px;cursor:pointer;line-height:1.4;
                        transition: background 0.1s, color 0.1s;
                    ">Stop</button>
                </span>`;
            bar = this.status.modeStatus.querySelector('.route-progress-bar-fill');
            label = this.status.modeStatus.querySelector('.route-progress-label');
            elapsed = this.status.modeStatus.querySelector('.route-progress-elapsed');

            const cancelBtn = /** @type {HTMLButtonElement|null} */ (this.status.modeStatus.querySelector('#pcbRouteCancelBtn'));
            cancelBtn?.addEventListener('mousedown', (e) => {
                e.stopPropagation();
                if (this._routeCancelToken) this._routeCancelToken.cancelled = true;
                if (this._routeWorker) this._routeWorker.postMessage({ type: 'cancel' });
                cancelBtn.style.background = '#d9534f';
                cancelBtn.style.borderColor = '#d9534f';
                cancelBtn.style.color = '#fff';
                cancelBtn.textContent = 'Stopping...';
                cancelBtn.disabled = true;
            });

            if (this._routeProgressTimer) clearInterval(this._routeProgressTimer);
            this._routeProgressTimer = setInterval(() => {
                this._refreshRouteProgress();
            }, 250);
        }

        this._refreshRouteProgress(label, bar, elapsed);
    }

    _refreshRouteProgress(labelEl = null, barEl = null, elapsedEl = null) {
        if (!this.status.modeStatus) return;
        const state = this._routeProgressState || {
            done: 0,
            total: 1,
            netName: 'Routing...',
            phase: 'initial',
            pendingConnections: 0,
            pendingNets: 0,
            ripupDone: 0,
            ripupTotal: 0,
            ripupPass: 0,
            ripupMaxPasses: 4,
        };
        const label = labelEl || this.status.modeStatus.querySelector('.route-progress-label');
        const bar = barEl || this.status.modeStatus.querySelector('.route-progress-bar-fill');
        const elapsed = elapsedEl || this.status.modeStatus.querySelector('.route-progress-elapsed');

        const pct = state.total > 0 ? Math.round((state.done / state.total) * 100) : 0;
        const isRipup = state.phase === 'ripup' || String(state.netName || '').startsWith('Rip-up');
        const isPathfinder = state.phase === 'pathfinder';
        let phaseLabel;
        if (isRipup) {
            phaseLabel = `Phase: Rip-up ${Math.max(1, state.ripupPass || 1)} of ${Math.max(1, state.ripupMaxPasses || 4)}`;
        } else if (isPathfinder) {
            // Pathfinder sends a self-describing netName (e.g. "Pathfinder iter 12/25: 950 overused").
            phaseLabel = `Phase: ${state.netName || 'Pathfinder'}`;
        } else {
            phaseLabel = 'Phase: Route placement';
        }
        const remainingConns = Math.max(0, Number.isFinite(state.pendingConnections) ? state.pendingConnections : (state.total - state.done));
        const progressLabel = `${pct}%`;
        if (label) {
            label.textContent = isPathfinder
                ? `${phaseLabel} - ${progressLabel} - ${remainingConns} pending`
                : `${phaseLabel} - ${state.done}/${state.total} (${pct}%) - ${remainingConns} connections unrouted`;
        }
        if (bar) bar.style.width = `${pct}%`;
        if (elapsed) {
            const t = Math.max(0, (performance.now() - this._routeProgressStartMs) / 1000);
            const mins = Math.floor(t / 60);
            const secs = Math.floor(t % 60);
            elapsed.textContent = `${mins}:${String(secs).padStart(2, '0')}`;
        }
    }

    /**
     * Remove routing progress from the status bar.
     */
    _hideRouteProgress() {
        if (this._routeProgressTimer) {
            clearInterval(this._routeProgressTimer);
            this._routeProgressTimer = null;
        }
        this._routeProgressState = {
            done: 0,
            total: 1,
            netName: 'Starting...',
            phase: 'initial',
            pendingConnections: 0,
            pendingNets: 0,
            ripupDone: 0,
            ripupTotal: 0,
            ripupPass: 0,
            ripupMaxPasses: 4,
        };
        if (this.status.modeStatus) {
            this.status.modeStatus.textContent = '';
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
        const copperObstacles = [];
        for (const text of this.texts.values()) {
            if (text.layer !== 'top-copper' && text.layer !== 'bottom-copper') continue;
            for (const seg of pcbTextObstacles(text)) copperObstacles.push(seg);
        }
        return copperObstacles;
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

        const params = this._getRoutingParams();
        return {
            connections,
            allObstaclePads,
            copperObstacles,
            traceWidth: params.trackWidth,
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
     * pad, via, and trace. The halo width equals the **Clearance** value
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
     */
    showClearances(show) {
        const NS = 'http://www.w3.org/2000/svg';
        const HALO_CLASS = 'debug-clearance';
        const OVERLAY_LAYER = 'clearance-overlay';

        // All halos live in a single dedicated overlay layer that sits on
        // top of every copper/silk/hole layer in the SVG z-order. Wipe and
        // rebuild from scratch on each call.
        const overlay = this._getLayerGroup(OVERLAY_LAYER);
        while (overlay.firstChild) overlay.removeChild(overlay.firstChild);

        if (show === undefined) show = !this._clearancesVisible;
        this._clearancesVisible = !!show;
        if (!this._clearancesVisible) return;

        const params = this._getRoutingParams();
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
        const holeVisible = isLayerVisible('hole');

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
        this._padHaloGroups = new Map();
        for (const [compId, pl] of this.placements) {
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

        // Halos for routed traces. Computed as the Minkowski-sum offset
        // polygon of each trace centerline by (traceR + OUTLINE_W/2),
        // rendered as a closed <polygon> stroked with width OUTLINE_W. Pure
        // vector — no masks, no rasterization, zero per-frame cost on
        // zoom/pan.
        //
        // Construction (per trace):
        //   - Walk each segment; emit perpendicular offsets on the right
        //     side going forward, then on the left side going backward.
        //   - At interior vertices: insert a short arc fan on the OUTSIDE
        //     of the bend (round-join). Inside vertex uses the segment-
        //     intersection point.
        //   - At endpoints: insert a semicircular cap (round-cap).
        //
        // Where two traces meet at a junction, their polygons overlap and
        // the stroked outlines visibly cross — same artifact as pad/via
        // halos already have. Acceptable.
        //
        // Halo radius is sized per-trace from each rendered run's stroke
        // width (tracks may carry per-segment widths); see the trace loop.
        // Arc tessellation: number of segments per FULL CIRCLE. Each arc
        // emits a proportional fraction of these. Higher = smoother caps
        // and corners at the cost of more polygon vertices.
        const ARC_STEPS_FULL = 64;

        const traceToPoints = (trace) => {
            const out = [];
            const push = (x, y) => {
                const xn = parseFloat(x), yn = parseFloat(y);
                if (Number.isFinite(xn) && Number.isFinite(yn)) out.push([xn, yn]);
            };
            if (trace.tagName === 'polyline') {
                const tokens = (trace.getAttribute('points') || '').trim().split(/[\s,]+/);
                for (let i = 0; i + 1 < tokens.length; i += 2) push(tokens[i], tokens[i + 1]);
            } else if (trace.tagName === 'line') {
                push(trace.getAttribute('x1'), trace.getAttribute('y1'));
                push(trace.getAttribute('x2'), trace.getAttribute('y2'));
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

        const layerIds = ['top-copper', 'bottom-copper'];
        for (const layerId of layerIds) {
            if (layerId === 'top-copper' && !topVisible) continue;
            if (layerId === 'bottom-copper' && !bottomVisible) continue;
            const sourceGroup = this._getLayerGroup(layerId);
            // Both the legacy incremental render ('.pcb-routed-trace') and
            // the model-driven render ('.pcb-track') are valid trace sources.
            const traces = [...sourceGroup.querySelectorAll('.pcb-routed-trace, .pcb-track')];
            if (traces.length === 0) continue;

            for (const trace of traces) {
                const pts = traceToPoints(trace);
                if (pts.length < 2) continue;
                // Each rendered run carries its own stroke-width (tracks can
                // have per-segment widths), so size the halo from THIS trace's
                // width rather than the global routing width.
                const sw = parseFloat(trace.getAttribute('stroke-width'));
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
                // Tag with the source trace's net so a footprint drag can hide
                // the halos of the nets it moves (their tracks shift mid-drag,
                // leaving the deferred halo stranded at the old position).
                const tnet = trace.dataset?.net;
                if (tnet) el.dataset.net = tnet;
                overlay.appendChild(el);
            }
        }

        // Vias: drawn as circles with class 'pcb-routed-via' (legacy/animation)
        // or 'pcb-via' (model-driven) on the 'hole' layer. Two elements share
        // the class (ring + drill); halo only the ring (the larger r).
        const holeGroup = this._getLayerGroup('hole');
        if (!holeVisible) return;
        const viaRingByCenter = new Map();
        for (const via of holeGroup.querySelectorAll('circle.pcb-routed-via, circle.pcb-via')) {
            const cx = parseFloat(via.getAttribute('cx'));
            const cy = parseFloat(via.getAttribute('cy'));
            const r = parseFloat(via.getAttribute('r'));
            if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(r)) continue;
            const key = `${cx.toFixed(4)},${cy.toFixed(4)}`;
            const prev = viaRingByCenter.get(key);
            if (!prev || r > prev.r) viaRingByCenter.set(key, { cx, cy, r, net: via.dataset?.net || prev?.net });
        }
        for (const { cx, cy, r, net } of viaRingByCenter.values()) {
            const ghost = document.createElementNS(NS, 'circle');
            ghost.setAttribute('cx', String(cx));
            ghost.setAttribute('cy', String(cy));
            ghost.setAttribute('r', String(r + halo));
            styleHalo(ghost);
            // Tag with net so a footprint drag can hide moving nets' halos.
            if (net) ghost.dataset.net = net;
            overlay.appendChild(ghost);
        }
    }

    /* ─────────────────────── Design Rule Checker ───────────────────── */

    /**
     * Wire up the DRC status button (toggle the problem dropdown) and re-run
     * triggers (routing-rule input changes). Live evaluation itself is driven
     * by the Design tab becoming active and by board edits via `_markDirty`.
     */
    _initDRC() {
        /** @type {Array} */
        this._drcViolations = [];
        this._drcActive = false;
        this._drcSelectedId = null;
        this._drcRaf = 0;
        /** @type {Set<string>} Collapsed problem-list section headings. */
        this._drcCollapsedGroups = new Set();

        const statusBtn = document.getElementById('pcbDrcStatus');
        const closeBtn = document.getElementById('pcbDrcSlideClose');
        statusBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            this._toggleDRCPanel();
        });
        closeBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            this._closeDRCPanel();
        });

        // Suppress the browser/app context menu on the DRC panel.
        const slidePanel = document.getElementById('pcbDrcSlidePanel');
        slidePanel?.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
        });

        // Keep the leader anchored to its row as the problem list scrolls.
        const body = document.querySelector('#pcbDrcSlidePanel .drc-slide-body');
        body?.addEventListener('scroll', () => {
            if (this._drcSelectedId) this._updateDRCConnector();
        }, { passive: true });

        // Re-run when the design rules themselves change.
        for (const id of ['pcbClearance', 'pcbViaDiameter', 'pcbViaDrill', 'pcbRouteUnits']) {
            const el = document.getElementById(id);
            el?.addEventListener('change', () => { if (this._drcShouldRun()) this._runDRCLive(); });
        }

        this._updateDRCStatus({ ok: true, violations: [], counts: { errors: 0, warnings: 0 } }, true);
    }

    /** True when DRC should re-evaluate: Design tab active or panel open. */
    _drcShouldRun() {
        if (this._drcActive) return true;
        const panel = document.getElementById('pcbDrcSlidePanel');
        return !!panel && panel.classList.contains('open');
    }

    /** Debounced live re-run, coalesced to one per animation frame. */
    _scheduleDRC() {
        if (this._drcRaf) return;
        this._drcRaf = requestAnimationFrame(() => {
            this._drcRaf = 0;
            this._runDRCLive();
        });
    }

    /**
     * Collect the rendered ratsnest air wires (remaining + autorouter-failed)
     * as plain segments for the DRC's incomplete-connection check.
     * @returns {Array<{net:string, x1:number, y1:number, x2:number, y2:number}>}
     */
    _collectRatlines() {
        const layer = this._getLayerGroup?.('ratlines');
        if (!layer) return [];
        const out = [];
        for (const el of layer.querySelectorAll('line.ratsnest-line, line.ratsnest-failed')) {
            out.push({
                net: el.dataset?.net || '',
                x1: parseFloat(el.getAttribute('x1')),
                y1: parseFloat(el.getAttribute('y1')),
                x2: parseFloat(el.getAttribute('x2')),
                y2: parseFloat(el.getAttribute('y2')),
            });
        }
        return out;
    }

    /** Run the DRC engine and refresh the status indicator + problem list. */
    _runDRCLive() {
        // Capture the currently-selected violation before the list is replaced,
        // so a coordinate-keyed ratline that gets renumbered can be re-adopted.
        const prevSel = this._drcSelectedId
            ? this._drcViolations?.find(v => v.id === this._drcSelectedId)
            : null;
        const params = this._getRoutingParams();
        let result;
        try {
            result = runDRC(this, {
                clearance: params.clearance,
                minAnnularRing: 0.05,
                ratlines: this._collectRatlines(),
            });
        } catch (err) {
            console.warn('[DRC] check failed', err);
            return;
        }
        this._drcViolations = result.violations;
        this._updateDRCStatus(result);
        this._renderDRCList();

        // Keep the selected marker in sync: if the violation still exists,
        // redraw it at its (possibly moved) location; otherwise drop it.
        if (this._drcSelectedId) {
            let sel = this._drcViolations.find(v => v.id === this._drcSelectedId);
            // An incomplete-connection violation's id is keyed on its endpoint
            // coordinates, so moving the connected copper renumbers it — the
            // old id vanishes on re-run. Re-adopt the equivalent fresh ratline
            // (same net, nearest endpoints) so the selection survives the drop.
            if (!sel) {
                sel = this._rematchRatlineViolation(prevSel);
                if (sel) {
                    this._drcSelectedId = sel.id;
                    this._renderDRCList();
                }
            }
            if (sel) {
                this._drawDRCMarker(sel);
                this._updateDRCConnector();
            } else {
                this._drcSelectedId = null;
                this._clearDRCMarker();
            }
        }
    }

    /**
     * Find the incomplete-connection violation in the freshly-computed list
     * that corresponds to a previously-selected one whose coordinate-keyed id
     * was renumbered (because its copper moved). Matches by net and nearest
     * endpoints; the live drag already moved `prev.marker` to the drop point,
     * so the closest new ratline of that net is the same connection.
     * @param {any} prev - the previously selected violation (pre-rerun).
     * @returns {any|null}
     */
    _rematchRatlineViolation(prev) {
        const pm = prev?.marker;
        if (!pm || pm.type !== 'ratline' || !pm.a || !pm.b) return null;
        const net = pm.net || '';
        const dist2 = (p, q) => (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
        let best = null, bestD = Infinity;
        for (const v of this._drcViolations) {
            const m = v.marker;
            if (v.rule !== 'unrouted' || !m || m.type !== 'ratline') continue;
            if ((m.net || '') !== net || !m.a || !m.b) continue;
            const d = Math.min(
                dist2(m.a, pm.a) + dist2(m.b, pm.b),
                dist2(m.a, pm.b) + dist2(m.b, pm.a),
            );
            if (d < bestD) { bestD = d; best = v; }
        }
        return best;
    }

    /**
     * Update the green-tick / red-cross status button.
     * @param {{ok:boolean, violations:Array, counts:{errors:number, warnings:number}}} result
     * @param {boolean} [pending]
     */
    _updateDRCStatus(result, pending = false) {
        const btn = document.getElementById('pcbDrcStatus');
        const icon = document.getElementById('pcbDrcIcon');
        const label = document.getElementById('pcbDrcLabel');
        if (!btn || !icon || !label) return;

        btn.classList.remove('drc-status-pending', 'drc-status-ok', 'drc-status-error', 'drc-status-warn');

        if (pending) {
            btn.classList.add('drc-status-pending');
            icon.textContent = '…';
            label.textContent = 'Checking…';
            return;
        }

        const { errors, warnings } = result.counts;
        if (errors === 0 && warnings === 0) {
            btn.classList.add('drc-status-ok');
            icon.textContent = '✓';
            label.textContent = 'No DRC errors';
        } else if (errors > 0) {
            btn.classList.add('drc-status-error');
            icon.textContent = '✕';
            const w = warnings > 0 ? `, ${warnings} warning${warnings === 1 ? '' : 's'}` : '';
            label.textContent = `${errors} error${errors === 1 ? '' : 's'}${w}`;
        } else {
            btn.classList.add('drc-status-warn');
            icon.textContent = '!';
            label.textContent = `${warnings} warning${warnings === 1 ? '' : 's'}`;
        }
    }

    /** Populate the problem dropdown; each item points to its issue on click. */
    _renderDRCList() {
        const list = document.getElementById('pcbDrcList');
        const empty = document.getElementById('pcbDrcEmpty');
        if (!list || !empty) return;
        list.textContent = '';

        const title = document.getElementById('pcbDrcSlideTitle');
        if (title) {
            const n = this._drcViolations.length;
            title.textContent = n === 0
                ? 'Design Rule Check'
                : `Design Rule Check — ${n} problem${n === 1 ? '' : 's'}`;
        }

        if (this._drcViolations.length === 0) {
            empty.removeAttribute('hidden');
            empty.style.display = '';
            return;
        }
        empty.setAttribute('hidden', '');
        empty.style.display = 'none';

        // Group violations under section headings. Sections appear only when
        // they have at least one violation (built from the data below), so an
        // empty category never shows a header. Shorted nets are listed first
        // (highest severity), then clearance, then incomplete connections.
        const groupOf = (v) => {
            if (v.rule === 'short') return 'Shorted Nets';
            if (v.rule === 'unrouted') return 'Incomplete Connections';
            return 'Clearance';
        };
        const ORDER = ['Shorted Nets', 'Clearance', 'Incomplete Connections'];

        // Cap the rendered rows so a pathological board (thousands of
        // violations) can't bloat the DOM and stall the UI.
        const MAX_ROWS = 200;
        const shown = this._drcViolations.slice(0, MAX_ROWS);

        const groups = new Map();
        for (const v of shown) {
            const g = groupOf(v);
            if (!groups.has(g)) groups.set(g, []);
            groups.get(g).push(v);
        }
        const names = [...ORDER.filter(n => groups.has(n)), ...[...groups.keys()].filter(n => !ORDER.includes(n))];

        for (const name of names) {
            const collapsed = this._drcCollapsedGroups.has(name);
            const heading = document.createElement('li');
            heading.className = 'drc-group-heading' + (collapsed ? ' drc-group-collapsed' : '');
            heading.setAttribute('role', 'button');
            heading.setAttribute('tabindex', '0');
            heading.setAttribute('aria-expanded', collapsed ? 'false' : 'true');

            const chevron = document.createElement('span');
            chevron.className = 'drc-group-chevron';
            chevron.textContent = '▸';
            const label = document.createElement('span');
            label.className = 'drc-group-label';
            label.textContent = `${name} (${groups.get(name).length})`;
            heading.appendChild(chevron);
            heading.appendChild(label);

            const toggle = () => {
                if (this._drcCollapsedGroups.has(name)) this._drcCollapsedGroups.delete(name);
                else this._drcCollapsedGroups.add(name);
                this._renderDRCList();
                // If the selected violation now sits in a collapsed section,
                // stop showing its on-board marker + leader; restore them when
                // its section is expanded again.
                const sel = this._drcSelectedId
                    ? this._drcViolations.find(x => x.id === this._drcSelectedId) : null;
                if (sel && this._drcCollapsedGroups.has(groupOf(sel))) {
                    this._clearDRCMarker();
                } else if (sel) {
                    this._drawDRCMarker(sel);
                    this._updateDRCConnector();
                }
            };
            heading.addEventListener('click', toggle);
            heading.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
            });
            list.appendChild(heading);

            if (collapsed) continue;

            for (const v of groups.get(name)) {
                const li = document.createElement('li');
                li.className = `drc-item drc-item-${v.severity === 'error' ? 'error' : 'warn'}`;
                li.dataset.drcId = v.id;
                if (v.id === this._drcSelectedId) li.classList.add('drc-item-active');

                const dot = document.createElement('span');
                dot.className = 'drc-item-dot';
                const text = document.createElement('span');
                text.className = 'drc-item-text';
                text.textContent = v.message;
                li.appendChild(dot);
                li.appendChild(text);

                li.addEventListener('click', () => this._selectDRCViolation(v.id));
                list.appendChild(li);
            }
        }

        if (this._drcViolations.length > MAX_ROWS) {
            const more = document.createElement('li');
            more.className = 'drc-panel-empty';
            more.style.cursor = 'default';
            more.textContent = `…and ${this._drcViolations.length - MAX_ROWS} more`;
            list.appendChild(more);
        }
    }

    _toggleDRCPanel() {
        const panel = document.getElementById('pcbDrcSlidePanel');
        if (!panel) return;
        if (panel.classList.contains('open')) this._closeDRCPanel();
        else this._openDRCPanel();
    }

    _openDRCPanel() {
        const panel = document.getElementById('pcbDrcSlidePanel');
        const btn = document.getElementById('pcbDrcStatus');
        if (!panel) return;
        panel.classList.add('open');
        panel.setAttribute('aria-hidden', 'false');
        btn?.setAttribute('aria-expanded', 'true');
        btn?.classList.add('drc-status-active');
    }

    _closeDRCPanel() {
        const panel = document.getElementById('pcbDrcSlidePanel');
        const btn = document.getElementById('pcbDrcStatus');
        if (!panel) return;
        panel.classList.remove('open');
        panel.setAttribute('aria-hidden', 'true');
        btn?.setAttribute('aria-expanded', 'false');
        btn?.classList.remove('drc-status-active');
        // Closing the panel clears the on-board violation marker(s)/leader.
        this._drcSelectedId = null;
        this._clearDRCMarker();
    }

    /**
     * Highlight a violation: draw a dotted marker pointing to it on the board,
     * scroll it into view, and flag the matching list row.
     * @param {string} id
     */
    _selectDRCViolation(id) {
        const v = this._drcViolations.find(x => x.id === id);
        if (!v) return;
        this._drcSelectedId = id;

        // Re-flag the active list row.
        const list = document.getElementById('pcbDrcList');
        if (list) {
            for (const li of list.querySelectorAll('.drc-item')) {
                li.classList.toggle('drc-item-active', li.dataset.drcId === id);
            }
        }

        this._drawDRCMarker(v);
        this._ensurePointVisible(v.x, v.y);
        this._updateDRCConnector();
    }

    /** Draw the dotted marker for a violation on the DRC overlay layer. */
    _drawDRCMarker(v) {
        const NS = 'http://www.w3.org/2000/svg';
        const overlay = this._getLayerGroup('drc-overlay');
        while (overlay.firstChild) overlay.removeChild(overlay.firstChild);

        const COLOR = '#ffd400';
        const dot = (x, y, r, dash) => {
            const c = document.createElementNS(NS, 'circle');
            c.setAttribute('cx', String(x));
            c.setAttribute('cy', String(y));
            c.setAttribute('r', String(r));
            c.setAttribute('fill', 'none');
            c.setAttribute('stroke', COLOR);
            c.setAttribute('stroke-width', '1.5');
            c.setAttribute('vector-effect', 'non-scaling-stroke');
            if (dash) c.setAttribute('stroke-dasharray', dash);
            c.setAttribute('pointer-events', 'none');
            overlay.appendChild(c);
        };

        // Marker location ring (always) — a dashed circle pinpointing the spot.
        const m = v.marker || {};
        const ringR = (m.type === 'ring') ? (m.r || 0.3) + 0.25 : 0.6;
        dot(v.x, v.y, ringR, '3,2');

        // For an incomplete-connection (ratline) violation, the actual air
        // wire may be hidden (Ratlines overlay off, or this net's ratline
        // toggled off). Re-draw just this one ratline on the overlay so the
        // user can see what is unconnected — only while it stays highlighted.
        if (m.type === 'ratline' && m.a && m.b && !this._isRatlineVisible(m.a, m.b)) {
            const line = document.createElementNS(NS, 'line');
            line.setAttribute('x1', String(m.a.x));
            line.setAttribute('y1', String(m.a.y));
            line.setAttribute('x2', String(m.b.x));
            line.setAttribute('y2', String(m.b.y));
            line.setAttribute('stroke', '#4488ff');
            line.setAttribute('stroke-width', '1');
            line.setAttribute('vector-effect', 'non-scaling-stroke');
            line.setAttribute('pointer-events', 'none');
            overlay.appendChild(line);
        }

        // For a shorted-net violation, draw a red leader between sample points
        // of the two shorted nets plus a ring at each end so the user can see
        // which two features are tied together.
        if (m.type === 'short' && m.a && m.b) {
            const line = document.createElementNS(NS, 'line');
            line.setAttribute('x1', String(m.a.x));
            line.setAttribute('y1', String(m.a.y));
            line.setAttribute('x2', String(m.b.x));
            line.setAttribute('y2', String(m.b.y));
            line.setAttribute('stroke', '#ff3b30');
            line.setAttribute('stroke-width', '1.5');
            line.setAttribute('vector-effect', 'non-scaling-stroke');
            line.setAttribute('pointer-events', 'none');
            overlay.appendChild(line);
            dot(m.a.x, m.a.y, 0.5, '3,2');
            dot(m.b.x, m.b.y, 0.5, '3,2');
        }
    }

    /**
     * True when the ratline between two points is currently shown on the
     * board. Hidden if the Ratlines overlay group is off, or if the matching
     * ratsnest line element is individually display:none.
     * @param {{x:number, y:number}} a
     * @param {{x:number, y:number}} b
     * @returns {boolean}
     */
    _isRatlineVisible(a, b) {
        const layer = this._layerGroups?.get('ratlines');
        if (!layer || layer.style.display === 'none') return false;
        const near = (p, q) => Math.abs(p - q) < 1e-3;
        for (const el of layer.querySelectorAll('line.ratsnest-line, line.ratsnest-failed')) {
            if (/** @type {HTMLElement} */ (el).style.display === 'none') continue;
            const x1 = parseFloat(el.getAttribute('x1'));
            const y1 = parseFloat(el.getAttribute('y1'));
            const x2 = parseFloat(el.getAttribute('x2'));
            const y2 = parseFloat(el.getAttribute('y2'));
            if ((near(x1, a.x) && near(y1, a.y) && near(x2, b.x) && near(y2, b.y)) ||
                (near(x1, b.x) && near(y1, b.y) && near(x2, a.x) && near(y2, a.y))) {
                return true;
            }
        }
        return false;
    }

    /** Remove the DRC marker overlay. */
    _clearDRCMarker() {
        const overlay = this._layerGroups.get('drc-overlay');
        if (overlay) while (overlay.firstChild) overlay.removeChild(overlay.firstChild);
        this._hideDRCConnector();
    }

    /** Lazily create the screen-space SVG used for the panel→marker leader. */
    _ensureDRCConnector() {
        if (this._drcConnectorSvg) return this._drcConnectorSvg;
        const container = this.viewport?.svg?.parentElement?.parentElement; // .main-container
        if (!container) return null;
        const NS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(NS, 'svg');
        svg.setAttribute('class', 'drc-connector-svg');
        svg.style.position = 'absolute';
        svg.style.inset = '0';
        svg.style.width = '100%';
        svg.style.height = '100%';
        svg.style.pointerEvents = 'none';
        svg.style.zIndex = '60';
        svg.style.display = 'none';
        const line = document.createElementNS(NS, 'polyline');
        line.setAttribute('fill', 'none');
        line.setAttribute('stroke', '#ffd400');
        line.setAttribute('stroke-width', '1.5');
        line.setAttribute('stroke-dasharray', '4,3');
        svg.appendChild(line);
        container.appendChild(svg);
        this._drcConnectorSvg = svg;
        this._drcConnectorLine = line;
        return svg;
    }

    _hideDRCConnector() {
        if (this._drcConnectorSvg) this._drcConnectorSvg.style.display = 'none';
    }

    /**
     * Draw the dotted leader from the selected problem row in the slide panel
     * to its marker on the board. Recomputed on selection and on view change.
     */
    _updateDRCConnector() {
        const id = this._drcSelectedId;
        const panel = document.getElementById('pcbDrcSlidePanel');
        const v = id ? this._drcViolations.find(x => x.id === id) : null;
        // Only show while the panel is open and a violation is selected.
        if (!v || !panel || !panel.classList.contains('open')) {
            this._hideDRCConnector();
            return;
        }
        const svg = this._ensureDRCConnector();
        if (!svg || !this.viewport?.worldToScreen) return;

        const row = panel.querySelector(`.drc-item[data-drc-id="${id}"]`);
        const containerRect = svg.parentElement.getBoundingClientRect();
        const vpSvg = this.viewport.svg;
        const sp = this.viewport.worldToScreen({ x: v.x, y: v.y });
        const svgRect = vpSvg.getBoundingClientRect();
        // Marker position in container-local coordinates.
        const ex = (svgRect.left - containerRect.left) + sp.x;
        const ey = (svgRect.top - containerRect.top) + sp.y;        // Start point: right edge of the selected row so the leader meets the
        // marker from the right side of the list. Clamp vertically to the
        // scrollable body so it never spills over the header/footer when the
        // row is scrolled out of view.
        const body = panel.querySelector('.drc-slide-body');
        const startRect = (row || panel).getBoundingClientRect();
        const sx = startRect.right - containerRect.left - 16;
        let sy = (row ? (startRect.top + startRect.height / 2) : (startRect.top + 24)) - containerRect.top;
        let rowVisible = true;
        if (body) {
            const b = body.getBoundingClientRect();
            const top = b.top - containerRect.top;
            const bottom = b.bottom - containerRect.top;
            // The row is "off the list" when its center sits outside the body.
            if (row) {
                const rowCenter = startRect.top + startRect.height / 2;
                rowVisible = rowCenter >= b.top && rowCenter <= b.bottom;
            }
            sy = Math.max(top, Math.min(bottom, sy));
        }

        // Dim the leader when its row is scrolled out of view.
        this._drcConnectorLine.setAttribute('stroke-opacity', rowVisible ? '1' : '0.3');
        // Stop the leader at the edge of the marker ring (not its center).
        const m = v.marker || {};
        const ringR = (m.type === 'ring') ? (m.r || 0.3) + 0.25 : 0.6;
        const screenR = ringR * (this.viewport.scale || 1);
        let tx = ex, ty = ey;
        const dx = ex - sx, dy = ey - sy;
        const dist = Math.hypot(dx, dy);
        if (dist > screenR) {
            tx = ex - (dx / dist) * screenR;
            ty = ey - (dy / dist) * screenR;
        }
        this._drcConnectorLine.setAttribute('points', `${sx},${sy} ${tx},${ty}`);
        svg.style.display = '';
    }

    /**
     * Pan (preserving zoom) so a world point is comfortably on-screen. Only
     * moves the view if the point currently sits outside the viewport.
     */
    _ensurePointVisible(x, y) {
        const vp = this.viewport;
        if (!vp || !vp.viewBox) return;
        const vb = vp.viewBox;
        const margin = Math.min(vb.width, vb.height) * 0.12;
        const inside = x >= vb.x + margin && x <= vb.x + vb.width - margin &&
            y >= vb.y + margin && y <= vb.y + vb.height - margin;
        if (inside) return;
        // Needs panning: center the point on screen (never change zoom).
        // viewBox.width/height are left untouched so the scale is preserved.
        vb.x = x - vb.width / 2;
        vb.y = y - vb.height / 2;
        vp._updateViewBox?.();
        vp._notifyViewChanged?.();
    }

    /**
     * Read routing parameters from the ribbon inputs, converting to mm.
     */
    _getRoutingParams() {
        const unitsEl = /** @type {HTMLSelectElement|null} */ (document.getElementById('pcbRouteUnits'));
        const units = unitsEl?.value || 'mm';
        const toMM = units === 'inch' ? 25.4 : 1;

        const readVal = (id, fallback) => {
            const el = /** @type {HTMLInputElement|null} */ (document.getElementById(id));
            const v = parseFloat(el?.value);
            return (isNaN(v) || v <= 0) ? fallback : v * toMM;
        };

        return {
            trackWidth: readVal('pcbTrackWidth', 0.2),
            clearance: readVal('pcbClearance', 0.1),
            viaDiameter: readVal('pcbViaDiameter', 0.3),
            viaDrill: readVal('pcbViaDrill', 0.15),
        };
    }

    _getRouterMode() {
        const routerEl = /** @type {HTMLSelectElement|null} */ (document.getElementById('pcbRouterMode'));
        return routerEl?.value === 'pathfinder' ? 'pathfinder' : 'maze';
    }

    /**
     * Render a single net's traces incrementally during routing animation.
     */
    _renderNetTraces(netTraces) {
        const NS = 'http://www.w3.org/2000/svg';
        const topCopper = this._getLayerGroup('top-copper');
        const bottomCopper = this._getLayerGroup('bottom-copper');
        const params = this._getRoutingParams();

        for (const trace of netTraces) {
            if (trace.points.length < 2) continue;
            const parent = trace.layer === 'bottom' ? bottomCopper : topCopper;
            const color = trace.layer === 'bottom' ? '#0066ff' : '#ff3333';

            const polyline = document.createElementNS(NS, 'polyline');
            polyline.setAttribute('class', 'pcb-routed-trace pcb-route-anim');
            const ptsStr = trace.points.map(p => `${p.x},${p.y}`).join(' ');
            polyline.setAttribute('points', ptsStr);
            polyline.setAttribute('fill', 'none');
            polyline.setAttribute('stroke', color);
            polyline.setAttribute('stroke-width', String(params.trackWidth));
            polyline.setAttribute('stroke-linecap', 'round');
            polyline.setAttribute('stroke-linejoin', 'round');
            polyline.setAttribute('opacity', '0.6');
            if (trace.net) polyline.dataset.net = trace.net;
            if (trace.connId) polyline.dataset.connid = trace.connId;
            parent.appendChild(polyline);

            // Render vias for this trace
            if (trace.vias?.length) {
                const holeLayer = this._getLayerGroup('hole');
                const viaRadius = params.viaDiameter / 2;
                const drillRadius = params.viaDrill / 2;
                for (const v of trace.vias) {
                    const ring = document.createElementNS(NS, 'circle');
                    ring.setAttribute('class', 'pcb-routed-via pcb-route-anim');
                    ring.setAttribute('cx', String(v.x));
                    ring.setAttribute('cy', String(v.y));
                    ring.setAttribute('r', String(viaRadius));
                    ring.setAttribute('fill', '#b8860b');
                    ring.setAttribute('opacity', '0.6');
                    if (trace.net) ring.dataset.net = trace.net;
                    if (trace.connId) ring.dataset.connid = trace.connId;
                    holeLayer.appendChild(ring);

                    const drill = document.createElementNS(NS, 'circle');
                    drill.setAttribute('class', 'pcb-routed-via pcb-route-anim');
                    drill.setAttribute('cx', String(v.x));
                    drill.setAttribute('cy', String(v.y));
                    drill.setAttribute('r', String(drillRadius));
                    drill.setAttribute('fill', '#1a1a2e');
                    drill.setAttribute('opacity', '0.6');
                    if (trace.net) drill.dataset.net = trace.net;
                    if (trace.connId) drill.dataset.connid = trace.connId;
                    holeLayer.appendChild(drill);
                }
            }
        }
        this._refreshClearanceHalos();
    }

    _clearIncrementalNet(netName) {
        if (!netName || !this.viewport?.svg) return;
        for (const el of this.viewport.svg.querySelectorAll(`.pcb-route-anim[data-net="${netName}"]`)) {
            el.remove();
        }
        this._refreshClearanceHalos();
    }

    _clearIncrementalConnection(connId) {
        if (!connId || !this.viewport?.svg) return;
        for (const el of this.viewport.svg.querySelectorAll(`.pcb-route-anim[data-connid="${connId}"]`)) {
            el.remove();
        }
        this._refreshClearanceHalos();
    }

    /**
     * Remove incremental animation traces (replaced by final clean render).
     */
    _clearIncrementalTraces() {
        const anims = this.viewport?.svg?.querySelectorAll('.pcb-route-anim');
        if (anims) {
            for (const el of anims) el.remove();
        }
        this._refreshClearanceHalos();
    }

    /**
     * If the clearance overlay is currently visible, redraw it. Call this
     * after any operation that adds, removes, or relocates traces/vias so the
     * halos stay in sync (rip-ups in particular leave orphaned halos otherwise).
     */
    _refreshClearanceHalos() {
        if (this._clearancesVisible) this.showClearances(true);
    }

    /* ──────────────────── Copper fill (pours) ─────────────────────── */

    /**
     * Schedule a recompute + re-render of all copper pours, coalesced to
     * one pass per animation frame. This is the live-refresh hook called
     * from reconcileRatsnest() (every copper mutation) and on routing-
     * parameter changes, as well as during fill editing.
     */
    _refreshFills() {
        if (this._suspendFillRefresh) {
            this._fillRefreshPending = true;
            return;
        }
        if (!this.copperFills || this.copperFills.length === 0) {
            // Nothing to pour: make sure both fill groups are empty.
            this._clearFillGroups();
            return;
        }
        if (this._fillRefreshScheduled) return;
        this._fillRefreshScheduled = true;
        const run = () => {
            this._fillRefreshScheduled = false;
            this._recomputeFillsNow();
        };
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
        else setTimeout(run, 0);
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
     */
    _recomputeFillsNow() {
        if (!this.copperFills || this.copperFills.length === 0) {
            this._clearFillGroups();
            return;
        }
        if (!isClipperReady()) {
            // Load the polygon engine, then try again.
            loadClipper().then(() => this._recomputeFillsNow()).catch(() => {});
            return;
        }
        const ctx = this._fillContext();
        this._clearFillGroups();
        for (const fill of this.copperFills) {
            try {
                fill._computed = computeFillPolygons(fill, ctx);
            } catch (_) {
                fill._computed = null;
            }
            renderCopperFill(fill, (id) => this._getLayerGroup(id), {
                selected: fill === this._selectedFill,
            });
        }
        if (this._selectedFill) this._renderFillHandles(this._selectedFill);
        // Pours just recomputed — let any open 3D/2D view pick up the fresh
        // geometry (its rebuild reads fill._computed).
        this._board3d?.refresh?.();
    }

    /** Build the obstacle/parameter context for the fill geometry engine. */
    _fillContext() {
        const params = this._getRoutingParams?.() || {};
        const pads = [];
        for (const [compId, pl] of this.placements) {
            // Orient each pad by the placement pose (rotation + mirror) so the
            // pour carves clearances at the pads' true world positions — not
            // their unrotated footprint-local offsets.
            const rad = ((pl.rotation || 0) * Math.PI) / 180;
            const cos = Math.cos(rad), sin = Math.sin(rad);
            const mx = isPlacementMirrored(pl) ? -1 : 1;
            // A 90°/270° rotation swaps a rectangular pad's width and height.
            const ortho = Math.abs(((pl.rotation || 0) % 180)) === 90;
            for (const off of (pl.padOffsets || [])) {
                const lx = off.dx * mx;
                pads.push({
                    x: pl.x + lx * cos - off.dy * sin,
                    y: pl.y + lx * sin + off.dy * cos,
                    width: (ortho ? off.height : off.width) || 0,
                    height: (ortho ? off.width : off.height) || 0,
                    shape: off.shape || 'rect',
                    layer: off.layer || 'top',
                    net: this._padNetLookup(compId, off.number),
                });
            }
        }
        return {
            tracks: this.tracks,
            vias: this.vias,
            pads,
            holes: [
                ...(this.holes || []),
                ...((this.circles || [])
                    .filter((c) => c && c.layer === 'hole' && c.radius > 0)
                    .map((c) => ({ x: c.x, y: c.y, diameter: c.radius * 2, plated: false }))),
            ],
            params: { clearance: Number.isFinite(params.clearance) ? params.clearance : 0.1 },
            board: (this._boardWidth > 0 && this._boardHeight > 0)
                ? { w: this._boardWidth, h: this._boardHeight, r: this._boardRadius || 0 }
                : null,
        };
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
        const g = this._layerGroups.get(fillGroupId(copperLayerId));
        if (g) g.style.display = visible ? '' : 'none';
        saveLayerPrefs();
    }

    /**
     * Layer-panel callback: lock/unlock the copper pour on one side. A locked
     * pour is dimmed and can't be selected; deselect anything on it.
     * @param {string} copperLayerId - 'top-copper' | 'bottom-copper'
     * @param {boolean} locked
     */
    _onCopperFillLockChanged(copperLayerId, locked) {
        const g = this._layerGroups.get(fillGroupId(copperLayerId));
        if (g) g.style.opacity = locked ? '0.4' : '';
        if (locked && this._selectedFill && this._selectedFill.layer === copperLayerId) {
            this._selectFill(null);
            this._clearProperties?.();
        }
        saveLayerPrefs();
    }

    /** Hit-test a world point against any pour region outline. */
    _hitTestFill(worldPos) {
        if (!this.copperFills) return null;
        // Topmost (last drawn) first.
        for (let i = this.copperFills.length - 1; i >= 0; i--) {
            const fill = this.copperFills[i];
            if (fill.visible === false || fill.locked) continue;
            if (isLayerLocked(fill.layer) || !isLayerVisible(fill.layer)) continue;
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
    _selectFill(fill) {
        if (this._selectedFill === fill) {
            if (fill) this._renderFillHandles(fill);
            return;
        }
        const prev = this._selectedFill;
        this._selectedFill = fill || null;
        this._syncClipboardButtons?.();
        // Re-render the previously- and newly-selected fills to update the
        // boundary highlight.
        const getGroup = (id) => this._getLayerGroup(id);
        if (prev) {
            renderCopperFill(prev, getGroup, { selected: false });
        }
        this._clearFillHandles();
        if (this._selectedFill) {
            renderCopperFill(this._selectedFill, getGroup,
                { selected: true });
            this._renderFillHandles(this._selectedFill);
        }
    }

    /** Draw draggable vertex handles for the selected pour on the overlay. */
    _renderFillHandles(fill) {
        this._clearFillHandles();
        if (!fill || !isCopperFillVisible(fill.layer)) return;
        const NS = 'http://www.w3.org/2000/svg';
        const overlay = this._getLayerGroup('selection-overlay');
        const g = document.createElementNS(NS, 'g');
        g.setAttribute('class', 'pcb-fill-handles');
        for (let i = 0; i < fill.outline.length; i++) {
            const p = fill.outline[i];
            const r = document.createElementNS(NS, 'rect');
            r.setAttribute('x', String(p.x - 0.25));
            r.setAttribute('y', String(p.y - 0.25));
            r.setAttribute('width', '0.5');
            r.setAttribute('height', '0.5');
            r.setAttribute('fill', '#ffffff');
            r.setAttribute('stroke', '#000000');
            r.setAttribute('stroke-width', '0.06');
            r.setAttribute('data-vertex', String(i));
            g.appendChild(r);
        }
        overlay.appendChild(g);
    }

    /** Remove the pour vertex handles from the overlay. */
    _clearFillHandles() {
        const overlay = this._layerGroups.get('selection-overlay');
        if (!overlay) return;
        for (const el of [...overlay.querySelectorAll('.pcb-fill-handles')]) el.remove();
    }

    /**
     * Begin a drag of the selected pour: grab the nearest vertex (within
     * tolerance) for a vertex edit, otherwise move the whole region if the
     * click lands inside it. Returns true if a drag was started.
     */
    _startFillDrag(fill, worldPos, e) {
        if (!fill || fill.locked || isLayerLocked(fill.layer) || isCopperFillLocked(fill.layer)) return false;
        // Vertex grab?
        const tol = 0.6;
        let vi = -1, best = tol;
        for (let i = 0; i < fill.outline.length; i++) {
            const d = Math.hypot(fill.outline[i].x - worldPos.x, fill.outline[i].y - worldPos.y);
            if (d < best) { best = d; vi = i; }
        }
        if (vi >= 0) {
            this._fillDrag = {
                fill, mode: 'vertex', vertex: vi,
                before: fill.captureState(),
                start: { x: worldPos.x, y: worldPos.y },
            };
            return true;
        }
        // Whole-region move?
        if (fill.containsPoint(worldPos.x, worldPos.y)) {
            this._fillDrag = {
                fill, mode: 'move',
                before: fill.captureState(),
                start: { x: worldPos.x, y: worldPos.y },
                last: { x: worldPos.x, y: worldPos.y },
            };
            return true;
        }
        return false;
    }

    /** Update a live pour drag (vertex move or whole-region translate). */
    _handleFillDrag(world) {
        const fd = this._fillDrag;
        if (!fd) return;
        const snap = this._snapToGrid ? this._snapToGrid(world) : world;
        if (fd.mode === 'vertex') {
            const p = fd.fill.outline[fd.vertex];
            if (p) { p.x = snap.x; p.y = snap.y; }
        } else {
            const dx = snap.x - fd.last.x;
            const dy = snap.y - fd.last.y;
            if (dx === 0 && dy === 0) return;
            fd.fill.move(dx, dy);
            fd.last = { x: snap.x, y: snap.y };
        }
        // Live preview: re-render the boundary + handles and recompute pour.
        renderCopperFill(fd.fill, (id) => this._getLayerGroup(id),
            { selected: true });
        this._renderFillHandles(fd.fill);
        this._refreshFills();
    }

    /** Commit a pour drag as an undoable ModifyFillCommand. */
    _endFillDrag() {
        const fd = this._fillDrag;
        this._fillDrag = null;
        if (!fd) return;
        const after = fd.fill.captureState();
        const moved = JSON.stringify(after.outline) !== JSON.stringify(fd.before.outline);
        if (moved) {
            // Roll the model back to its pre-drag state, then execute the
            // command so it re-applies "after" through the normal undo path.
            fd.fill.applyState(fd.before);
            this.history.execute(new ModifyFillCommand(this, fd.fill, fd.before, after));
        } else {
            this._refreshFills();
        }
    }

    /** Delete the selected pour (Delete/Backspace). */
    deleteSelectedFill() {
        if (!this._selectedFill) return false;
        if (this._selectedFill.locked || isLayerLocked(this._selectedFill.layer)
            || isCopperFillLocked(this._selectedFill.layer)) return false;
        this.history.execute(new RemoveFillCommand(this, this._selectedFill));
        return true;
    }

    /**
     * Render the Properties-tab editor for a selected copper pour. The pour
     * has two editable attributes: its net (same-net copper is joined, other
     * nets are cleared) and its copper layer. Both commit through a single
     * ModifyFillCommand for clean undo/redo.
     */
    _showFillProperties(fill) {
        const items = this._pcbPropsItems();
        if (!items || !fill) return;
        this._setPcbPropsTitle('Copper Fill');
        const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
        ));
        const layerOpts = [
            ['top-copper', 'Top Copper'],
            ['bottom-copper', 'Bottom Copper'],
        ].map(([id, name]) => `<option value="${id}"${id === fill.layer ? ' selected' : ''}>${name}</option>`).join('');
        items.innerHTML = `
            <div class="prop-row"><label>Net</label><input type="text" id="pcbPropFillNet" placeholder="(isolated)" value="${esc(fill.net || '')}"></div>
            <div class="prop-row"><label>Layer</label><select id="pcbPropFillLayer">${layerOpts}</select></div>
        `;
        const commit = (mutate) => {
            const before = fill.captureState();
            mutate();
            const after = fill.captureState();
            fill.applyState(before);
            this.history.execute(new ModifyFillCommand(this, fill, before, after));
        };
        const netEl = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropFillNet'));
        netEl?.addEventListener('change', () => {
            const value = netEl.value.trim();
            if ((fill.net || '') === value) return;
            commit(() => { fill.net = value; });
        });
        const layerEl = /** @type {HTMLSelectElement|null} */ (document.getElementById('pcbPropFillLayer'));
        layerEl?.addEventListener('change', () => {
            if (fill.layer === layerEl.value) return;
            commit(() => { fill.layer = layerEl.value; });
        });
        this._setActiveRibbonTab?.('pcb-properties');
    }

    /**
     * Re-sync the pour Properties panel after a programmatic change (e.g. a
     * ModifyFillCommand undo/redo). Simply re-renders if this pour is shown.
     */
    _refreshFillProperties(fill) {
        if (fill && this._selectedFill === fill) this._showFillProperties(fill);
    }

    /**
     * Show a brief "trying" line for a connection being attempted.
     */
    _flashTryingLine(from, to) {
        const NS = 'http://www.w3.org/2000/svg';
        const layer = this._getLayerGroup('ratlines');

        // Remove all previous trying lines
        for (const el of layer.querySelectorAll('.pcb-trying-line')) el.remove();

        const line = document.createElementNS(NS, 'line');
        line.setAttribute('class', 'pcb-route-anim pcb-trying-line');
        line.setAttribute('x1', String(from.x));
        line.setAttribute('y1', String(from.y));
        line.setAttribute('x2', String(to.x));
        line.setAttribute('y2', String(to.y));
        line.setAttribute('stroke', '#ffcc00');
        line.setAttribute('stroke-width', '0.2');
        line.setAttribute('opacity', '0.8');
        layer.appendChild(line);
    }

    /**
     * Remove all trying lines.
     */
    _clearTryingLines() {
        const layer = this._layerGroups.get('ratlines');
        if (layer) {
            for (const el of layer.querySelectorAll('.pcb-trying-line')) el.remove();
        }
    }

    /**
     * Flash a failed net's ratline(s) in yellow.
     */
    _flashFailedNet(conn) {
        if (!conn.pads || conn.pads.length < 2) return;
        const NS = 'http://www.w3.org/2000/svg';
        const layer = this._getLayerGroup('ratlines');

        // Keep failed overlays bounded and replace previous overlays for this net.
        const netName = conn.net || '';
        if (netName) {
            for (const old of layer.querySelectorAll(`.pcb-failed-line[data-net="${netName}"]`)) {
                old.remove();
            }
        }
        const allFailed = layer.querySelectorAll('.pcb-failed-line');
        if (allFailed.length > 24) {
            const toRemove = allFailed.length - 24;
            for (let i = 0; i < toRemove; i++) allFailed[i]?.remove();
        }

        for (let i = 0; i < conn.pads.length - 1; i++) {
            const from = conn.pads[i];
            const to = conn.pads[i + 1];

            const line = document.createElementNS(NS, 'line');
            line.setAttribute('class', 'pcb-route-anim pcb-failed-line');
            if (netName) line.dataset.net = netName;
            line.setAttribute('x1', String(from.x));
            line.setAttribute('y1', String(from.y));
            line.setAttribute('x2', String(to.x));
            line.setAttribute('y2', String(to.y));
            line.setAttribute('stroke', '#ffcc00');
            line.setAttribute('stroke-width', '0.3');
            line.setAttribute('opacity', '0.9');
            layer.appendChild(line);

            // Fade out and remove
            let opacity = 0.9;
            const fade = () => {
                opacity -= 0.08;
                if (opacity <= 0) {
                    line.remove();
                    return;
                }
                line.setAttribute('opacity', String(opacity));
                requestAnimationFrame(fade);
            };
            requestAnimationFrame(fade);
        }
    }

    _hideRatsnestForNet(netName) {
        this._setRatsnestVisibilityForNet(netName, false);
    }

    _setRatsnestVisibilityForNet(netName, visible) {
        if (!netName) return;
        this._ratsnestVisibilityQueue.set(netName, !!visible);
        if (this._ratsnestVisibilityRaf) return;
        this._ratsnestVisibilityRaf = requestAnimationFrame(() => {
            this._ratsnestVisibilityRaf = 0;
            this._flushRatsnestVisibilityQueue();
        });
    }

    _flushRatsnestVisibilityQueue() {
        if (!this._ratsnestVisibilityQueue.size) return;
        const updates = new Map(this._ratsnestVisibilityQueue);
        this._ratsnestVisibilityQueue.clear();
        this._applyRatsnestVisibilityMap(updates);
    }

    _applyRatsnestVisibilityMap(visibilityByNet) {
        if (!visibilityByNet || !visibilityByNet.size) return;
        const ratLayer = this._getLayerGroup('ratlines');
        for (const line of ratLayer.querySelectorAll('.ratsnest-line')) {
            const net = /** @type {HTMLElement} */ (line).dataset.net || '';
            if (!visibilityByNet.has(net)) continue;
            /** @type {HTMLElement} */ (line).style.display = visibilityByNet.get(net) ? '' : 'none';
        }
        for (const el of ratLayer.children) {
            if (el.tagName !== 'text') continue;
            const net = (el.textContent || '').trim();
            if (!visibilityByNet.has(net)) continue;
            /** @type {HTMLElement} */ (el).style.display = visibilityByNet.get(net) ? '' : 'none';
        }
    }

    /**
     * Render routing result onto copper layers and hide routed ratlines.
     *
     * Converts the autorouter's raw {traces, vias} payload into Track and
     * Via model instances stored on this.tracks / this.vias, then renders
     * those via the track-render module. All downstream selection/edit/
     * undo operations operate on the model, not on raw SVG.
     *
     * @param {import('../pcb/modules/autorouter-common.js').RouteResult} result
     */
    _renderRouteResult(result) {
        this._flushRatsnestVisibilityQueue();
        const params = this._getRoutingParams();

        // Discard previous tracks/vias (the autorouter replaces the entire
        // routed copper picture each run; manually-drawn tracks will be
        // preserved separately once Phase 2 lands).
        for (const t of this.tracks) removeTrackElements(t);
        for (const v of this.vias) removeViaElements(v);
        this.tracks.length = 0;
        this.vias.length = 0;

        // Also clear any stale incremental-render SVG (from progress msgs).
        const topCopper = this._getLayerGroup('top-copper');
        const bottomCopper = this._getLayerGroup('bottom-copper');
        if (topCopper) topCopper.querySelectorAll('.pcb-routed-trace, .pcb-route-anim').forEach(el => el.remove());
        if (bottomCopper) bottomCopper.querySelectorAll('.pcb-routed-trace, .pcb-route-anim').forEach(el => el.remove());
        const holeLayerEarly = this._getLayerGroup('hole');
        if (holeLayerEarly) holeLayerEarly.querySelectorAll('.pcb-routed-via, .pcb-route-anim').forEach(el => el.remove());

        // Build model objects from the autorouter output.
        const { tracks, vias } = tracksFromAutorouterResult(result, {
            trackWidth: params.trackWidth,
            viaDiameter: params.viaDiameter,
            viaDrill: params.viaDrill,
            placements: this.placements,
        });
        this.tracks.push(...tracks);
        this.vias.push(...vias);

        // Render them.
        const getGroup = (id) => this._getLayerGroup(id);
        for (const t of this.tracks) renderTrack(t, getGroup, {
            viaDiameter: params.viaDiameter,
            viaDrill: params.viaDrill,
        });
        for (const v of this.vias) renderVia(v, getGroup);

        // Reconcile final ratsnest: hide all original ratlines, then draw
        // per-connection ratlines for each failed connection.
        const ratLayer = this._getLayerGroup('ratlines');
        for (const el of [...ratLayer.children]) {
            /** @type {HTMLElement} */ (el).style.display = 'none';
        }

        const NS2 = 'http://www.w3.org/2000/svg';
        if (Array.isArray(result.failedConnections)) {
            for (const fc of result.failedConnections) {
                const line = document.createElementNS(NS2, 'line');
                line.setAttribute('x1', String(fc.from.x));
                line.setAttribute('y1', String(fc.from.y));
                line.setAttribute('x2', String(fc.to.x));
                line.setAttribute('y2', String(fc.to.y));
                line.setAttribute('stroke', '#4488ff');
                line.setAttribute('stroke-width', '1');
                line.setAttribute('vector-effect', 'non-scaling-stroke');
                line.setAttribute('pointer-events', 'none');
                line.setAttribute('class', 'ratsnest-line ratsnest-failed');
                line.dataset.net = fc.net;
                ratLayer.appendChild(line);
            }
        }

        this._refreshClearanceHalos();
    }

    /**
     * Clear all routed traces/vias and restore all ratlines.
     */
    clearRoutes() {
        if (this._ratsnestVisibilityRaf) {
            cancelAnimationFrame(this._ratsnestVisibilityRaf);
            this._ratsnestVisibilityRaf = 0;
        }
        this._ratsnestVisibilityQueue.clear();

        // Drop track/via selection (its references are about to become stale).
        clearTrackSelection(this);

        // Drop model objects and their SVG.
        for (const t of this.tracks) removeTrackElements(t);
        for (const v of this.vias) removeViaElements(v);
        this.tracks.length = 0;
        this.vias.length = 0;

        // Remove any stray legacy SVG (incremental render, SES import, etc.)
        for (const [, g] of this._layerGroups) {
            g.querySelectorAll('.pcb-routed-trace, .pcb-routed-via, .pcb-track, .pcb-via, .pcb-route-anim').forEach(el => el.remove());
        }

        // Rebuild the ratsnest from scratch now that all routed copper is
        // gone (every net reverts to fully-unconnected guide lines) and drop
        // the autorouter's failed-connection lines.
        const ratLayer = this._getLayerGroup('ratlines');
        ratLayer.querySelectorAll('.ratsnest-failed').forEach(el => el.remove());
        reconcileRatsnest(this);

        this._refreshClearanceHalos();
        this._setStatus('Routes cleared');
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
            this._setStatus('Nothing to export');
            return;
        }

        const params = this._getRoutingParams();
        const dsn = exportDSN({
            placements: this.placements,
            netlist: this.netlist,
            traceWidth: params.trackWidth,
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

        this._setStatus('DSN exported — open in Freerouting, then Import SES');
    }

    /**
     * Export the current board as a ZIP of Gerber + Excellon drill files.
     * Files included: top/bottom copper, top silkscreen, board outline,
     * and an Excellon drill file.
     */
    exportGerber() {
        if (!this.placements.size && !this.tracks.length && !this.vias.length) {
            this._setStatus('Nothing to export');
            return;
        }
        let blob, files;
        try {
            files = exportGerbers({
                placements: this.placements,
                tracks: this.tracks,
                vias: this.vias,
                holes: this.holes,
                texts: [...this.texts.values()],
                fills: this.copperFills,
                boardX: this._boardX || 0,
                boardY: this._boardY || 0,
                boardWidth: this._boardWidth,
                boardHeight: this._boardHeight,
                boardRadius: this._boardRadius,
            });
            blob = buildZip(files);
        } catch (err) {
            console.error('Gerber export failed:', err);
            this._setStatus(`Gerber export failed: ${err?.message || err}`);
            return;
        }
        // Derive default filename from the project name.
        const schematicApp = /** @type {any} */ (window).app;
        const fname = schematicApp?.fileManager?.fileName || 'untitled.cpcb';
        const base = fname.replace(/\.[^./\\]+$/, '') || 'untitled';
        const suggestedName = `${base}-gerber.zip`;
        this._saveBlob(blob, suggestedName, {
            description: 'Gerber ZIP archive',
            accept: { 'application/zip': ['.zip'] },
        }).then(saved => {
            if (saved) this._setStatus(`Gerbers exported (${files.size} files)`);
        }).catch(err => {
            console.error('Gerber save failed:', err);
            this._setStatus(`Gerber save failed: ${err?.message || err}`);
        });
    }

    /**
     * Export the Bill of Materials as a CSV file.
     */
    exportBOM() {
        if (!this.placements.size) {
            this._setStatus('No components to export');
            return;
        }
        let blob;
        try {
            const csv = generateBOM(this.placements);
            blob = new Blob([csv], { type: 'text/csv' });
        } catch (err) {
            console.error('BOM export failed:', err);
            this._setStatus(`BOM export failed: ${err?.message || err}`);
            return;
        }
        const suggestedName = `${this._exportBaseName()}-bom.csv`;
        this._saveBlob(blob, suggestedName, {
            description: 'CSV file',
            accept: { 'text/csv': ['.csv'] },
        }).then(saved => {
            if (saved) this._setStatus(`BOM exported (${this.placements.size} parts)`);
        }).catch(err => {
            console.error('BOM save failed:', err);
            this._setStatus(`BOM save failed: ${err?.message || err}`);
        });
    }

    /**
     * Export the Pick-and-Place (centroid) file as a CSV.
     */
    exportPickAndPlace() {
        if (!this.placements.size) {
            this._setStatus('No components to export');
            return;
        }
        let blob;
        try {
            const csv = generatePickAndPlace(this.placements);
            blob = new Blob([csv], { type: 'text/csv' });
        } catch (err) {
            console.error('Pick-and-place export failed:', err);
            this._setStatus(`Pick-and-place export failed: ${err?.message || err}`);
            return;
        }
        const suggestedName = `${this._exportBaseName()}-pick-and-place.csv`;
        this._saveBlob(blob, suggestedName, {
            description: 'CSV file',
            accept: { 'text/csv': ['.csv'] },
        }).then(saved => {
            if (saved) this._setStatus(`Pick-and-place exported (${this.placements.size} parts)`);
        }).catch(err => {
            console.error('Pick-and-place save failed:', err);
            this._setStatus(`Pick-and-place save failed: ${err?.message || err}`);
        });
    }

    /**
     * Derive a default export filename base from the project name.
     * @returns {string}
     */
    _exportBaseName() {
        const schematicApp = /** @type {any} */ (window).app;
        const fname = schematicApp?.fileManager?.fileName || 'untitled.cpcb';
        return fname.replace(/\.[^./\\]+$/, '') || 'untitled';
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
     * @param {Blob} blob
     * @param {string} suggestedName
     * @param {{description?: string, accept?: Record<string,string[]>}} [opts]
     * @returns {Promise<boolean>}
     */
    async _saveBlob(blob, suggestedName, opts = {}) {
        const w = /** @type {any} */ (window);
        if (typeof w.showSaveFilePicker === 'function') {
            try {
                const handle = await w.showSaveFilePicker({
                    suggestedName,
                    types: opts.accept ? [{
                        description: opts.description || '',
                        accept: opts.accept,
                    }] : undefined,
                });
                const writable = await handle.createWritable();
                await writable.write(blob);
                await writable.close();
                return true;
            } catch (err) {
                // User cancelled — not an error.
                if (err && (err.name === 'AbortError' || err.code === 20)) return false;
                throw err;
            }
        }
        // Fallback: anchor download (Firefox / older browsers).
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = suggestedName;
        a.click();
        URL.revokeObjectURL(url);
        return true;
    }

    /**
     * Prompt user to select an SES file and import routed traces.
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
                if (!result.traces.length) {
                    this._setStatus('No routes found in SES file');
                    return;
                }
                // Clear existing routes first
                this.clearRoutes();
                // Log first trace for debugging coordinates
                if (result.traces.length) {
                    const t = result.traces[0];
                    console.log(`[SES] First trace: net=${t.net} layer=${t.layer} pts=${t.points.length}`, t.points);
                    // Log placement coords for comparison
                    for (const [, pl] of this.placements) {
                        for (const [num, pos] of pl.pads) {
                            console.log(`[SES] Pad ${pl.reference}-${num} at (${pos.x.toFixed(2)}, ${pos.y.toFixed(2)})`);
                            break;
                        }
                        break;
                    }
                }
                // Render imported traces (and their vias)
                this._renderRouteResult({ traces: result.traces, vias: result.vias || [], failed: [] });
                this._setStatus(`Imported ${result.traces.length} trace(s), ${result.vias?.length || 0} via(s) from SES`);
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
        const schematicApp = /** @type {any} */ (window).app;
        const comp = schematicApp?.components?.find(c => c.id === closest);
        if (!comp?.definition) return;

        const shapes = comp.definition.footprintShapes;
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
