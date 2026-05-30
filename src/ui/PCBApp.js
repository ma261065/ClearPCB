// @ts-nocheck — PCBApp uses loosely-typed Maps and nullable viewport access throughout
// PCBApp.js - PCB Editor Application

import { bindPcbControls } from '../pcb/modules/controls.js';
import { Viewport } from '../core/Viewport.js';
import { loadAndApplyTheme, toggleTheme as toggleSharedTheme, syncThemeToggleButtons } from '../shared/ui/theme.js';
import { extractNetlist, extractComponents } from '../pcb/modules/netlist.js';
import { generateFootprint, renderFootprint } from '../pcb/modules/footprint.js';
import { buildRatsnest } from '../pcb/modules/ratsnest.js';
import { updateGridDropdown } from './modules/viewport.js';
import { PCB_LAYERS } from '../pcb/modules/layers.js';
import { exportDSN, importSES } from '../pcb/modules/dsn.js';
import { exportGerbers, buildZip } from '../pcb/modules/gerber.js';
import { tracksFromAutorouterResult } from '../pcb/modules/autorouter-adapter.js';
import { renderTrack, renderVia, removeTrackElements, removeViaElements } from '../pcb/modules/track-render.js';
import {
    startTrackDraw,
    updateTrackDraw,
    addTrackWaypoint,
    finishTrackDraw,
    cancelTrackDraw,
    toggleTrackLayer,
} from '../pcb/modules/track-draw.js';
import {
    hitTestTrack,
    selectTrackOrVia,
    clearTrackSelection,
    deleteSelectedTrack,
    setHoverHighlight,
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
} from '../pcb/modules/track-drag.js';
import {
    AddTrackCommand,
    MovePlacementCommand,
    SetBoardOutlineCommand,
} from '../pcb/modules/track-commands.js';
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
         * Map of componentId → { x, y, pads: Map<pinNumber, {x,y}>, element }
         * @type {Map<string, object>}
         */
        this.placements = new Map();
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
         * Undo/redo for PCB-side edits (tracks, vias, vertex drags,
         * property tweaks). Separate from the schematic's history.
         * @type {CommandHistory}
         */
        this.history = new CommandHistory({ maxSize: 200 });
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
            // Switch ribbon back to Home tab on canvas click — but NOT
            // while we're drawing a track (the Track tool drives the
            // Properties tab so its width spinner stays visible).
            if (!this._trackDraw) {
                const activeTab = this.ribbon?.querySelector('.ribbon-tab.active');
                if (activeTab instanceof HTMLElement && activeTab.dataset?.tab !== 'pcb-home') {
                    this._setActiveRibbonTab?.('pcb-home');
                }
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

                // If a track is already selected, try to start a vertex
                // drag on it before doing anything else — this lets the
                // user grab a node or bend a segment without re-clicking.
                if (this._selectedTrack) {
                    if (startVertexDrag(this, this._selectedTrack, worldPos)) {
                        svg.style.cursor = 'grabbing';
                        return;
                    }
                }
                // Same for a selected via: clicking on the via begins a
                // drag without losing the selection.
                if (this._selectedVia) {
                    if (startViaDrag(this, this._selectedVia, worldPos)) {
                        svg.style.cursor = 'grabbing';
                        return;
                    }
                }

                const trackHit = hitTestTrack(this, worldPos);
                if (trackHit) {
                    this._selectComponent(null);
                    this._selectBoardOutline(false);
                    selectTrackOrVia(this, trackHit);
                    // Begin a drag immediately so click-and-drag works in
                    // one motion (no separate select-then-drag click).
                    if (trackHit.type === 'via') {
                        if (startViaDrag(this, trackHit.via, worldPos)) {
                            svg.style.cursor = 'grabbing';
                        }
                    } else if (trackHit.type === 'track') {
                        if (startVertexDrag(this, trackHit.track, worldPos)) {
                            svg.style.cursor = 'grabbing';
                        }
                    }
                    return;
                }
                // Anything else clears any track selection first.
                clearTrackSelection(this);
                const hit = this._hitTestComponent(worldPos);
                if (hit) {
                    this._selectComponent(hit);
                    this._selectBoardOutline(false);
                    this._showComponentProperties(hit);
                    const pl = this.placements.get(hit);
                    if (pl) {
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
                }
            }

            // Left-click with track tool: start a new track or add a waypoint.
            if (e.button === 0 && this.currentTool === 'track') {
                const worldPos = this._screenToWorld(e);
                if (this._trackDraw) {
                    addTrackWaypoint(this, worldPos);
                } else {
                    startTrackDraw(this, worldPos);
                }
            }
        });

        svg.addEventListener('mousemove', (e) => {
            if (!this._active) return;
            if (this.viewport.isPanning) {
                this.viewport.updatePan(e.clientX, e.clientY);
            } else if (this._drag) {
                this._handleDrag(e);
            } else if (this._vertexDrag) {
                updateVertexDrag(this, this._screenToWorld(e));
            } else if (this._viaDrag) {
                updateViaDrag(this, this._screenToWorld(e));
            } else if (this._trackDraw) {
                updateTrackDraw(this, this._screenToWorld(e));
            } else if (this.currentTool === 'select') {
                const worldPos = this._screenToWorld(e);
                this._hoverBoardOutline(this._hitTestBoardOutline(worldPos));
                // Hover highlight for tracks/vias.
                setHoverHighlight(this, this._hitTestPad(worldPos) || hitTestTrack(this, worldPos));
            }
            this.viewport.trackMouse(e);
            this._updateDebugTooltip(e);
        });

        svg.addEventListener('dblclick', (e) => {
            if (!this._active) return;
            if (this._trackDraw) {
                e.preventDefault();
                finishTrackDraw(this);
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
            }
            if (this._drag) {
                this._endDrag();
            }
            if (this._vertexDrag) {
                finishVertexDrag(this);
                svg.style.cursor = 'default';
                // Refresh the halo on the (possibly reshaped) selected track.
                if (this._selectedTrack) {
                    const t = this._selectedTrack;
                    clearTrackSelection(this);
                    selectTrackOrVia(this, { type: 'track', track: t });
                }
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

        svg.addEventListener('mouseup', (e) => {
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

        // Only end pan on mouseleave — keep drag active so component
        // follows mouse back into canvas (matches schematic behavior)
        svg.addEventListener('mouseleave', () => {
            if (!this._active) return;
            if (this.viewport.isPanning) {
                this.viewport.endPan();
            }
        });

        svg.addEventListener('contextmenu', (e) => e.preventDefault());

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
            'default';
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
            if (this._vertexDrag) cancelVertexDrag(this);
            if (this._viaDrag) cancelViaDrag(this);
            this.history.undo();
            return true;
        }
        if (ctrl && ((e.key === 'y' || e.key === 'Y') || ((e.key === 'z' || e.key === 'Z') && e.shiftKey))) {
            this.history.redo();
            return true;
        }
        if (e.key === 'Delete' || e.key === 'Backspace') {
            if (this._selectedTrack || this._selectedVia) {
                deleteSelectedTrack(this);
                return true;
            }
            return false;
        }
        if (e.key === 'Escape') {
            if (this._vertexDrag) { cancelVertexDrag(this); return true; }
            if (this._viaDrag) { cancelViaDrag(this); return true; }
            if (this._selectedTrack || this._selectedVia) {
                clearTrackSelection(this);
                this._clearProperties?.();
                return true;
            }
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
     * Serialise the PCB state (tracks, vias) to a JSON-friendly object.
     * Board outline / placements are derived from the schematic and not
     * persisted here.
     */
    serialize() {
        return {
            tracks: this.tracks.map(t => t.toJSON()),
            vias: this.vias.map(v => v.toJSON()),
        };
    }

    /**
     * Restore PCB state previously produced by serialize(). Replaces any
     * existing tracks/vias and re-renders them.
     * @param {{tracks?: Array, vias?: Array}|null} data
     */
    loadFromData(data) {
        // Drop any existing tracks/vias and their SVG.
        for (const t of this.tracks) removeTrackElements(t);
        for (const v of this.vias) removeViaElements(v);
        this.tracks.length = 0;
        this.vias.length = 0;
        clearTrackSelection(this);
        this.history.clear?.();

        if (!data) return;

        if (Array.isArray(data.tracks)) {
            for (const td of data.tracks) {
                const track = createShape(td);
                if (track instanceof Track) {
                    this.tracks.push(track);
                    renderTrack(track, (id) => this._getLayerGroup(id), {
                        viaDiameter: this._getRoutingParams?.()?.viaDiameter,
                        viaDrill: this._getRoutingParams?.()?.viaDrill,
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
        // Re-evaluate ratlines once the model is in place.
        import('../pcb/modules/track-draw.js').then(({ reconcileRatsnest }) => {
            reconcileRatsnest(this);
        });
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
        this.viewport?.fitToContent();
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
     * Currently exposes net, layer, and a width spinner. Editing the
     * width updates the live preview immediately.
     * @param {object} ctx - the _trackDraw context
     */
    _showTrackDrawProperties(ctx) {
        const items = document.getElementById('pcbPropsItems');
        if (!items || !ctx) return;
        const netLabel = ctx.net || '(unassigned)';
        const layerLabel = ctx.currentLayer === 'bottom-copper' ? 'Bottom Copper' : 'Top Copper';
        items.innerHTML = `
            <div class="prop-row"><label>Type</label><span style="font-size:11px;color:var(--text-primary)">Track (drawing)</span></div>
            <div class="prop-row"><label>Net</label><span style="font-size:11px;color:var(--text-primary)">${netLabel}</span></div>
            <div class="prop-row"><label>Layer</label><span style="font-size:11px;color:var(--text-primary)">${layerLabel}</span></div>
            <div class="prop-row"><label>Width (mm)</label><input type="number" id="pcbPropTrackWidth" value="${ctx.width}" min="0.05" step="0.05"></div>
        `;
        const wEl = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropTrackWidth'));
        wEl?.addEventListener('input', () => {
            const v = parseFloat(wEl.value);
            if (Number.isFinite(v) && v > 0) {
                ctx.width = v;
                // Trigger a preview re-render at the current cursor position.
                const last = ctx.points[ctx.points.length - 1];
                const live = ctx.snap ? { x: ctx.snap.x, y: ctx.snap.y } : last;
                updateTrackDraw(this, live);
            }
        });
        this._setActiveRibbonTab?.('pcb-properties');
    }

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

        for (let i = 0; i < components.length; i++) {
            const comp = components[i];
            const col = i % COLS;
            const row = Math.floor(i / COLS);
            const cx = offsetX + col * SPACING_X;
            const cy = offsetY - row * SPACING_Y;  // go downward in user view = more negative in SVG

            // Generate footprint geometry (use real pad data when available)
            const fpGeom = generateFootprint(
                comp.footprint, comp.pins,
                comp.footprintShapes, comp.footprintBBox,
                comp.source
            );

            // Render SVG (returns Map<layerId, SVGGElement>)
            const fpLayers = renderFootprint(fpGeom, comp.reference, cx, cy, 0);

            // Distribute each layer's group to the correct SVG layer
            /** @type {SVGGElement[]} */
            const elements = [];
            for (const [layerId, layerGroup] of fpLayers) {
                this._getLayerGroup(layerId).appendChild(layerGroup);
                elements.push(layerGroup);
            }

            // Build pad world-position map for ratsnest
            const padMap = new Map();
            /** @type {Array<{number: string, dx: number, dy: number, width: number, height: number, layer: string, shape: string}>} */
            const padOffsets = [];
            for (const pad of fpGeom.pads) {
                padMap.set(pad.number, { x: cx + pad.x, y: cy + pad.y });
                padOffsets.push({ number: pad.number, dx: pad.x, dy: pad.y, width: pad.width, height: pad.height, drill: pad.drill || 0, layer: pad.layer, shape: pad.shape || 'rect' });
            }

            this.placements.set(comp.id, {
                x: cx,
                y: cy,
                pads: padMap,
                padOffsets,
                elements,
                bounds: fpGeom.courtyard || fpGeom.outline,
                reference: comp.reference,
            });
        }
    }

    /**
     * Rebuild the ratsnest lines from the current netlist and placements.
     */
    _updateRatsnest() {
        // Clear old ratsnest
        if (this._ratsnestGroup) {
            while (this._ratsnestGroup.firstChild)
                this._ratsnestGroup.removeChild(this._ratsnestGroup.firstChild);
        }

        if (!this.netlist.length || !this.placements.size) return;

        const ratsnestSvg = buildRatsnest(this.netlist, this.placements);

        // Move children into existing group
        while (ratsnestSvg.firstChild) {
            this._ratsnestGroup.appendChild(ratsnestSvg.firstChild);
        }
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
        const rect = this.viewport.svg.getBoundingClientRect();
        return this.viewport.screenToWorld({
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
        });
    }

    /**
     * Hit-test: find which component is closest to a world position.
     * Returns the component ID or null.
     * @param {{x: number, y: number}} worldPos
     * @returns {string|null}
     */
    _hitTestComponent(worldPos) {
        let closest = null;
        let closestDist = 10; // mm tolerance
        for (const [compId, pl] of this.placements) {
            for (const [, pad] of pl.pads) {
                const d = Math.hypot(pad.x - worldPos.x, pad.y - worldPos.y);
                if (d < closestDist) {
                    closestDist = d;
                    closest = compId;
                }
            }
        }
        return closest;
    }

    /**
     * Hit-test: find a pad whose bounding box contains the world position.
     * Returns `{ type:'pad', componentId, pinNumber }` or null. Pad shape
     * is approximated by the bounding box from padOffsets.
     */
    _hitTestPad(worldPos) {
        for (const [componentId, pl] of this.placements) {
            if (!pl?.padOffsets) continue;
            for (const off of pl.padOffsets) {
                const pos = pl.pads.get(off.number);
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
            pl.pads.set(off.number, { x: snapX + off.dx, y: snapY + off.dy });
        }

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
        const routeInput = this._testBoardRouteInput || this._buildRouteInput();
        this._testBoardRouteInput = null;  // consume it — only used once
        const routerMode = this._getRouterMode();
        // Always honour the current UI design rules, even when the source is a
        // test-board JSON that embedded its own values.
        const uiParams = this._getRoutingParams();
        routeInput.traceWidth = uiParams.trackWidth;
        routeInput.clearance = uiParams.clearance;
        routeInput.viaDiameter = uiParams.viaDiameter;
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
        const traceR = params.trackWidth / 2 + halo;
        // Visible halo line center sits at the clearance boundary; the
        // constant-width screen-pixel stroke straddles it (~½ px each side).
        const RING_R = traceR;
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
                const poly = offsetPolygon(pts, RING_R);
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

        // Restore all original ratlines and remove failed-connection ratlines
        const ratLayer = this._getLayerGroup('ratlines');
        ratLayer.querySelectorAll('.ratsnest-failed').forEach(el => el.remove());
        for (const el of ratLayer.children) {
            /** @type {HTMLElement} */ (el).style.display = '';
        }

        this._refreshClearanceHalos();
        this._setStatus('Routes cleared');
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
        try {
            const files = exportGerbers({
                placements: this.placements,
                tracks: this.tracks,
                vias: this.vias,
                boardX: this._boardX || 0,
                boardY: this._boardY || 0,
                boardWidth: this._boardWidth,
                boardHeight: this._boardHeight,
                boardRadius: this._boardRadius,
            });
            const blob = buildZip(files);
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'gerbers.zip';
            a.click();
            URL.revokeObjectURL(url);
            this._setStatus(`Gerbers exported (${files.size} files)`);
        } catch (err) {
            console.error('Gerber export failed:', err);
            this._setStatus(`Gerber export failed: ${err?.message || err}`);
        }
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
