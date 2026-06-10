// @ts-nocheck — PCBApp uses loosely-typed Maps and nullable viewport access throughout
// PCBApp.js - PCB Editor Application

import { bindPcbControls } from '../pcb/modules/controls.js';
import { Viewport } from '../core/Viewport.js';
import { loadAndApplyTheme, toggleTheme as toggleSharedTheme, syncThemeToggleButtons } from '../shared/ui/theme.js';
import { extractNetlist, extractComponents } from '../pcb/modules/netlist.js';
import { generateFootprint, renderFootprint } from '../pcb/modules/footprint.js';
import { updateGridDropdown } from './modules/viewport.js';
import { PCB_LAYERS, isLayerLocked, isViaLocked, showLockedLayerBubble } from '../pcb/modules/layers.js';
import { exportDSN, importSES } from '../pcb/modules/dsn.js';
import { exportGerbers, buildZip } from '../pcb/modules/gerber.js';
import { generateBOM, generatePickAndPlace } from '../pcb/modules/assembly.js';
import { openBoard3DViewer } from '../pcb/modules/board3d.js';
import { savePcbPdf, printPcb } from '../pcb/modules/pcb-export.js';import { tracksFromAutorouterResult } from '../pcb/modules/autorouter-adapter.js';
import { renderTrack, renderVia, removeTrackElements, removeViaElements } from '../pcb/modules/track-render.js';
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
    CompoundCommand,
    MovePlacementCommand,
    SetBoardOutlineCommand,
    repositionPadConnectedNodes,
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
import { createShape } from '../shapes/index.js';

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
            modeStatus: document.getElementById('pcbModeStatus')
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
        /** Defaults for the Text tool (modifiable via tool options). */
        this._textDefaults = { size: 1.0, rotation: 0, layer: 'top-silk', strokeWidth: 0.15 };
        /** Last typed content for the Text tool. */
        this._lastTextContent = 'Text';

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
            onChanged: () => { this._isDirty = true; },
        });
        /** Debug tooltip for showing raw footprintShapes data */
        this._debugTooltip = null;
        this._debugTooltipVisible = false;
        this._debugTooltipPinned = false;
        this._showDebugTooltip = false;

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

        // First-time board outline setup
        if (!this._boardOutlineDrawn) {
            if (this._loadBoardOutline()) {
                this._drawBoardOutline();
            } else {
                this._showBoardDimensionsDialog();
            }
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

        this.viewport.onViewChanged = () => {
            if (!this._active) return;
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
                (this.currentTool === 'via' || this.currentTool === 'track' || this.currentTool === 'text')) {
                if (this.currentTool === 'via') {
                    this._updateViaPreview(this._lastCrosshairWorld);
                } else {
                    this._updateCursorCrosshair(this._lastCrosshairWorld);
                }
            }
        };

        // Bind mouse events for panning
        this._bindMouseEvents();

        // Create SVG layer groups (one <g> per PCB layer, in z-order)
        this._createLayerGroups();

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
            // the text's size/rotation spinners).
            if (!this._trackDraw && !this._textEdit) {
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
            // Right-click: pin/unpin debug tooltip
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
                        beginGroupDrag(this, worldPos);
                        this._hideNetTooltip();
                        svg.style.cursor = 'grabbing';
                        return;
                    }
                    clearBoxSelection(this);
                }

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
                        this._hideNetTooltip();
                        this._drag = {
                            compId: hit,
                            startWorld: worldPos,
                            startPos: { x: pl.x, y: pl.y },
                        };
                        svg.style.cursor = 'grabbing';
                    }
                } else if (this._hitTestBoardOutline(worldPos)) {
                    this._selectComponent(null);
                    this._selectBoardOutline(true);
                    this._showBoardOutlineProperties();
                } else {
                    this._selectComponent(null);
                    this._selectBoardOutline(false);
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
                }
            } else if (this._drag) {
                this._handleDrag(e);
            } else if (this._groupDrag) {
                updateGroupDrag(this, this._screenToWorld(e));
            } else if (this._textDrag) {
                this._handleTextDrag(e);
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
            } else if (this._trackDraw) {
                updateTrackDraw(this, this._screenToWorld(e));
                if (this._trackDraw?.snap) {
                    this._updateCursorCrosshair({ x: this._trackDraw.snap.x, y: this._trackDraw.snap.y });
                }
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
            } else if (this.currentTool === 'track') {
                this._updateCursorCrosshair(this._screenToWorld(e));
            } else if (this.currentTool === 'text') {
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
        const t = this.currentTool;
        this.viewport.svg.style.cursor =
            t === 'pan' ? 'grab' :
            t === 'track' ? 'crosshair' :
            t === 'via' ? 'crosshair' :
            t === 'text' ? this._textToolCursor() :
            'default';
        if (t !== 'via') this._clearViaRing();
        if (t !== 'via' && t !== 'track' && t !== 'text') this._clearCursorCrosshair();
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

    /** Public hook used by controls.setTool to abort an in-flight track draw. */
    _cancelTrackDraw() {
        if (this._trackDraw) cancelTrackDraw(this);
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
        if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) {
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

        // Otherwise: history, delete, selection-cancel.
        const ctrl = e.ctrlKey || e.metaKey;
        if (ctrl && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
            if (this._vertexDrag) { cancelVertexDrag(this); this.viewport.hideCrosshair(); }
            if (this._viaDrag) cancelViaDrag(this);
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
            if (this._selectedTrack || this._selectedVia) {
                deleteSelectedTrack(this);
                return true;
            }
            return false;
        }
        if (e.key === 'Escape') {
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
            if (this._selectedTrack || this._selectedVia) {
                clearTrackSelection(this);
                this._clearProperties?.();
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
        return false;
    }

    /**
     * Commit a freshly-drawn Track via the history stack so it can be
     * undone. Called from finishTrackDraw(). Optional `vias` array
     * (e.g. layer-change vias) is added in the same undo step.
     * @param {Track} track
     * @param {Via[]} [vias]
     */
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
        /** @type {Record<string, {x:number, y:number, rotation:number}>} */
        const placements = {};
        for (const [id, p] of this._placementOverrides) {
            placements[id] = { x: p.x, y: p.y, rotation: p.rotation || 0 };
        }
        return {
            tracks: this.tracks.map(t => t.toJSON()),
            vias: this.vias.map(v => v.toJSON()),
            texts: [...this.texts.values()].map(serializePcbText),
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
            || this.texts?.size || this._placementOverrides.size;
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
        this.tracks.length = 0;
        this.vias.length = 0;
        // Drop any existing free-standing texts.
        for (const id of this._textElements.keys()) this._removeTextElement(id);
        this.texts.clear();
        this._selectedText = null;
        clearTrackSelection(this);
        this.history.clear?.();

        // Restore manual footprint position overrides. These are applied when
        // _placeFootprints rebuilds the placements from the schematic; if
        // placements already exist (sync ran first), re-apply immediately.
        this._placementOverrides.clear();

        if (!data) return;

        if (data.placements && typeof data.placements === 'object') {
            for (const [id, p] of Object.entries(data.placements)) {
                if (!p) continue;
                this._placementOverrides.set(id, {
                    x: Number(p.x) || 0,
                    y: Number(p.y) || 0,
                    rotation: Number(p.rotation) || 0,
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
        if (Array.isArray(data.texts)) {
            for (const td of data.texts) {
                const t = createPcbText(td);
                this.texts.set(t.id, t);
                this._renderText(t);
            }
        }
        // Re-evaluate ratlines once the model is in place.
        reconcileRatsnest(this);
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
            'bottom-copper', 'top-copper',
            'bottom-silk', 'top-silk',
            'hole',
            'ratlines',
            'document',
            // Overlays — non-editable visual aids drawn on top of everything
            // (clearance halos, etc.). Must be last in z-order.
            'clearance-overlay',
            // Selection-overlay — track node handles etc. sit above ALL
            // copper, vias (hole layer) and overlays so they stay visible
            // even when a via covers the node they mark.
            'selection-overlay',
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
        // Clearance overlay tracks per-layer visibility — re-render so halos
        // for hidden copper/hole layers disappear too.
        if (this._clearancesVisible && (layerId === 'top-copper' || layerId === 'bottom-copper' || layerId === 'hole')) {
            this.showClearances(true);
        }
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
        }
    }

    _fitToContent() {
        this._ensureViewport();
        if (!this.viewport) return;

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
            }
            overlay.remove();
        };

        okBtn?.addEventListener('click', accept);
        overlay.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') accept();
        });
    }

    /**
     * Save board outline dimensions to localStorage.
     */
    _saveBoardOutline() {
        try {
            localStorage.setItem('clearpcb_board_outline', JSON.stringify({
                width: this._boardWidth,
                height: this._boardHeight,
                radius: this._boardRadius,
            }));
        } catch (err) {
            console.warn('Board outline save failed:', err);
            this._setStatus?.('Board outline not saved (storage full)');
        }
    }

    /**
     * Load board outline dimensions from localStorage.
     * @returns {boolean} true if data was found and loaded
     */
    _loadBoardOutline() {
        try {
            const raw = localStorage.getItem('clearpcb_board_outline');
            if (!raw) return false;
            const data = JSON.parse(raw);
            if (data.width > 0 && data.height > 0) {
                this._boardWidth = data.width;
                this._boardHeight = data.height;
                this._boardRadius = data.radius || 0;
                return true;
            }
        } catch { /* corrupt data — ignore */ }
        return false;
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
        // selecting/hovering it while that layer is locked.
        if (isLayerLocked('board-outline')) return false;
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

    /**
     * Clear the properties panel to its default state.
     */
    _clearProperties() {
        const items = document.getElementById('pcbPropsItems');
        if (items) {
            items.innerHTML = '<span style="font-size:11px;color:var(--text-muted)">Click an object to see its properties</span>';
        }
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
        const items = document.getElementById('pcbPropsItems');
        if (!items) return;

        items.innerHTML = `
            <div class="prop-row"><label>Type</label><span style="font-size:11px;color:var(--text-primary)">Board Outline</span></div>
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
        const items = document.getElementById('pcbPropsItems');
        if (!items) return;

        const pl = this.placements.get(compId);
        const name = pl?.name || compId;
        const x = pl?.x?.toFixed(2) || '0';
        const y = pl?.y?.toFixed(2) || '0';

        items.innerHTML = `
            <div class="prop-row"><label>Type</label><span style="font-size:11px;color:var(--text-primary)">Component</span></div>
            <div class="prop-row"><label>Name</label><span style="font-size:11px;color:var(--text-primary)">${name}</span></div>
            <div class="prop-row"><label>X (mm)</label><span style="font-size:11px;color:var(--text-primary)">${x}</span></div>
            <div class="prop-row"><label>Y (mm)</label><span style="font-size:11px;color:var(--text-primary)">${y}</span></div>
        `;

        this._setActiveRibbonTab?.('pcb-properties');
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
    }

    /**
     * Remove all PCB footprint and ratsnest content from layer groups.
     */
    _clearPCBContent() {
        // Clear children of layer groups (but keep the groups themselves)
        for (const [, g] of this._layerGroups) {
            while (g.firstChild) g.removeChild(g.firstChild);
        }
        this._footprintGroup = null;
        this._ratsnestGroup = null;
        this.placements.clear();
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
                reference: comp.reference,
                value: comp.value || '',
                footprint: comp.footprint || '',
                model3dObj: comp.model3dObj || null,
                model3dUrl: comp.model3dUrl || null,
                model3dPlacement: fpGeom.model3d || null,
                silks: fpGeom.silks || [],
                rotation: rot,
            });
        }
    }

    /**
     * Rebuild the ratsnest lines from the current netlist and placements.
     */
    _updateRatsnest() {
        // Net-based rebuild — draws guide lines between every disconnected
        // cluster of same-net copper (pads, tracks and vias alike).
        reconcileRatsnest(this);
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
                const x0 = pl.x + b.x;
                const y0 = pl.y + b.y;
                if (
                    worldPos.x >= x0 && worldPos.x <= x0 + b.width
                    && worldPos.y >= y0 && worldPos.y <= y0 + b.height
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
            const hovered = this._hitTestPad(worldPos) || trackHover;
            setHoverHighlight(this, hovered);
            // Net-name tooltip for the hovered pad/track/via.
            this._updateNetTooltip(ev, hovered);
            // Hover highlight for text annotations.
            this._setTextHover(this._hitTestText(worldPos));
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
            if (overNode) {
                this.viewport.svg.style.cursor = 'nwse-resize';
                this._hoverNodeCursor = true;
            } else if (overMidpoint) {
                this.viewport.svg.style.cursor = 'copy';
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
            for (const off of pl.padOffsets) {
                const pos = pl.pads.get(off.padId);
                if (!pos) continue;
                const w = (off.width || 1.2) / 2;
                const h = (off.height || 1.2) / 2;
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
            for (const el of (pl.elements || [])) {
                el.setAttribute('transform', `translate(${o.x}, ${o.y})`);
            }
            const halo = this._padHaloGroups?.get(compId);
            if (halo) halo.setAttribute('transform', `translate(${o.x}, ${o.y})`);
            for (const off of (pl.padOffsets || [])) {
                pl.pads.set(off.padId, { x: o.x + off.dx, y: o.y + off.dy, number: off.number });
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
        });
        this._isDirty = true;
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
    }

    /**
     * Handle drag movement.
     * @param {MouseEvent} e
     */
    _handleDrag(e) {
        if (!this._drag) return;

        const worldPos = this._screenToWorld(e);
        const dx = worldPos.x - this._drag.startWorld.x;
        const dy = worldPos.y - this._drag.startWorld.y;
        const newX = this._drag.startPos.x + dx;
        const newY = this._drag.startPos.y + dy;

        // Snap to grid if enabled
        let snapX = newX, snapY = newY;
        if (this.viewport.snapToGrid) {
            const gs = this.viewport.gridSize;
            snapX = Math.round(newX / gs) * gs;
            snapY = Math.round(newY / gs) * gs;
        }

        const pl = this.placements.get(this._drag.compId);
        if (!pl) return;

        // Update all SVG group transforms
        for (const el of pl.elements) {
            el.setAttribute('transform', `translate(${snapX}, ${snapY})`);
        }

        // Move the matching pad-halo group too, so clearance outlines
        // follow the component during drag (no full halo rebuild).
        const haloGrp = this._padHaloGroups?.get(this._drag.compId);
        if (haloGrp) {
            haloGrp.setAttribute('transform', `translate(${snapX}, ${snapY})`);
        }

        // Update placement position
        pl.x = snapX;
        pl.y = snapY;

        // Update pad world positions
        for (const off of (pl.padOffsets || [])) {
            pl.pads.set(off.padId, { x: snapX + off.dx, y: snapY + off.dy, number: off.number });
        }

        // Drag pad-bonded track endpoints along with the component.
        repositionPadConnectedNodes(this, this._drag.compId);

        // Rebuild ratsnest in real-time
        this._updateRatsnest();
    }

    /**
     * End a drag operation and rebuild ratsnest.
     */
    _endDrag() {
        if (!this._drag) return;
        const { compId, startPos } = this._drag;
        const pl = this.placements.get(compId);
        this._drag = null;
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

    /** Snap a world point to grid if snap-to-grid is enabled. */
    _snapToGrid(p) {
        if (!this.viewport?.snapToGrid) return { x: p.x, y: p.y };
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
            if (isLayerLocked(t.layer)) continue;
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
        if (prev && (!next || prev.id !== next.id)) this._refreshText(prev.id);
        if (next) this._refreshText(next.id);
    }

    /** Drag an already-selected text. */
    _handleTextDrag(e) {
        if (!this._textDrag) return;
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
        const items = document.getElementById('pcbPropsItems');
        if (!items) return;
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
            <div class="prop-row"><label>Type</label><span style="font-size:11px;color:var(--text-primary)">Text</span></div>
            <div class="prop-row"><label>Layer</label><select id="pcbPropTextLayer">${layerOpts}</select></div>
            <div class="prop-row"><label>Size (mm)</label><input type="number" id="pcbPropTextSize" value="${text.size}" min="0.2" step="0.1"></div>
            <div class="prop-row"><label>Rotation (°)</label><input type="number" id="pcbPropTextRot" value="${text.rotation}" step="15"></div>
            <div class="prop-row"><label>Line W (mm)</label><input type="number" id="pcbPropTextLW" value="${text.strokeWidth}" min="0.05" step="0.05"></div>
            ${insertRow}
        `;
        // Snapshot at first edit so undo collapses keystrokes into a
        // single command per field.
        let snapshot = null;
        const onInput = (key, parse) => () => {
            if (!snapshot) snapshot = { ...text };
            const el = document.getElementById(`pcbPropText${key}`);
            const v = parse(el?.value);
            if (v === null) return;
            const field = this._propFieldMap[key];
            // Layer change: if mirror flips (top↔bottom), the rendered
            // text reflects about its anchor x and visually jumps. Shift
            // the anchor by the text width (rotated into world space) so
            // the visible glyphs stay put.
            if (field === 'layer') {
                const wasBottom = typeof text.layer === 'string' && text.layer.startsWith('bottom-');
                const willBottom = typeof v === 'string' && v.startsWith('bottom-');
                if (wasBottom !== willBottom) {
                    const w = measureStrokeText(text.content, text.size);
                    const sign = willBottom ? 1 : -1; // top→bottom: +w; bottom→top: -w
                    const rot = (text.rotation || 0) * Math.PI / 180;
                    // SVG-Y-down with rotate(-rot): dx,dy in local frame map
                    // to (cos(rot)*dx, -sin(rot)*dx) in world.
                    text.x += sign * w * Math.cos(rot);
                    text.y += sign * w * -Math.sin(rot);
                }
            }
            text[field] = v;
            this._refreshText(text.id);
        };
        const onCommit = () => {
            if (!snapshot) return;
            const after = {};
            for (const k of ['content', 'layer', 'size', 'rotation', 'strokeWidth', 'x', 'y']) {
                if (snapshot[k] !== text[k]) after[k] = text[k];
            }
            // Roll back to snapshot first; EditTextCommand will reapply.
            const final = { ...text };
            Object.assign(text, snapshot);
            this._refreshText(text.id);
            snapshot = null;
            if (Object.keys(after).length === 0) return;
            // Re-apply via command for undo history.
            Object.assign(text, final); // restore current values inside cmd
            this.history.execute(new EditTextCommand(this, text.id, after));
        };
        const bindField = (key, parse) => {
            const el = document.getElementById(`pcbPropText${key}`);
            const handler = onInput(key, parse);
            el?.addEventListener('input', handler);
            // Also handle 'change' — spinner step clicks on number
            // inputs fire 'change' in some browsers without an 'input'.
            el?.addEventListener('change', handler);
            el?.addEventListener('change', onCommit);
        };
        const num = (min) => (v) => {
            const n = parseFloat(v);
            if (!Number.isFinite(n)) return null;
            return min !== undefined ? Math.max(min, n) : n;
        };
        bindField('Layer',   (v) => TEXT_LAYERS.includes(v) ? v : null);
        bindField('Size',    num(0.1));
        bindField('Rot',     (v) => {
            const n = parseFloat(v);
            if (!Number.isFinite(n)) return null;
            return ((n % 360) + 360) % 360;
        });
        bindField('LW',      num(0.01));
        const rotEl = document.getElementById('pcbPropTextRot');
        const wrapRot = () => {
            const n = parseFloat(rotEl.value);
            if (!Number.isFinite(n)) return;
            const wrapped = ((n % 360) + 360) % 360;
            if (wrapped !== n) rotEl.value = String(wrapped);
        };
        rotEl?.addEventListener('input', wrapRot);
        rotEl?.addEventListener('change', wrapRot);

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

    /** Property panel field → text-object field mapping. */
    get _propFieldMap() {
        return { Content: 'content', Layer: 'layer', Size: 'size',
                 Rot: 'rotation', LW: 'strokeWidth', X: 'x', Y: 'y' };
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
            grp.setAttribute('transform', `translate(${pl.x}, ${pl.y})`);
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
            if (!prev || r > prev.r) viaRingByCenter.set(key, { cx, cy, r });
        }
        for (const { cx, cy, r } of viaRingByCenter.values()) {
            const ghost = document.createElementNS(NS, 'circle');
            ghost.setAttribute('cx', String(cx));
            ghost.setAttribute('cy', String(cy));
            ghost.setAttribute('r', String(r + halo));
            styleHalo(ghost);
            overlay.appendChild(ghost);
        }
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
                texts: [...this.texts.values()],
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
     * highlighted while the panel is active.
     */
    open3DView() {
        const p = this._board3d;
        if (p && !p.closed && !p.hidden) {
            p.hide?.();
        } else {
            openBoard3DViewer(this);
        }
    }

    /**
     * Reflect the 3D panel's visibility on the toolbar 3D View button.
     */
    _update3DButtonState() {
        const btn = document.getElementById('pcb3dView');
        if (!btn) return;
        const active = !!(this._board3d && !this._board3d.closed && !this._board3d.hidden);
        btn.classList.toggle('active', active);
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
