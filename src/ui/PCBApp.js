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
            // Switch ribbon back to Home tab on canvas click
            const activeTab = this.ribbon?.querySelector('.ribbon-tab.active');
            if (activeTab instanceof HTMLElement && activeTab.dataset?.tab !== 'pcb-home') {
                this._setActiveRibbonTab?.('pcb-home');
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

            // Left-click with select tool: hit-test for component
            if (e.button === 0 && this.currentTool === 'select') {
                const worldPos = this._screenToWorld(e);
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
        });

        svg.addEventListener('mousemove', (e) => {
            if (!this._active) return;
            if (this.viewport.isPanning) {
                this.viewport.updatePan(e.clientX, e.clientY);
            } else if (this._drag) {
                this._handleDrag(e);
            } else if (this.currentTool === 'select') {
                const worldPos = this._screenToWorld(e);
                this._hoverBoardOutline(this._hitTestBoardOutline(worldPos));
            }
            this.viewport.trackMouse(e);
            this._updateDebugTooltip(e);
        });

        const endInteraction = () => {
            if (!this._active) return;
            if (this.viewport.isPanning) {
                this.viewport.endPan();
            }
            if (this._drag) {
                this._endDrag();
            }
        };

        svg.addEventListener('mouseup', endInteraction);

        // Only end pan on mouseleave — keep drag active so component
        // follows mouse back into canvas (matches schematic behavior)
        svg.addEventListener('mouseleave', () => {
            if (!this._active) return;
            if (this.viewport.isPanning) {
                this.viewport.endPan();
            }
        });

        svg.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    _updateViewportStatus() {
        if (!this.viewport) return;
        if (this.status.viewportInfo) {
            this.status.viewportInfo.textContent = `${this.viewport.viewBox.width.toFixed(0)} × ${this.viewport.viewBox.height.toFixed(0)} mm`;
        }
        if (this.status.zoomPercent) {
            this.status.zoomPercent.textContent = `${Math.round(this.viewport.zoom * 100)}%`;
        }
    }

    _updateCursorForTool() {
        if (!this.viewport?.svg) return;
        this.viewport.svg.style.cursor = this.currentTool === 'pan' ? 'grab' : 'default';
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
            this._boardWidth = Math.max(5, w);
            this._boardHeight = Math.max(5, h);
            this._boardRadius = Math.max(0, r);
            this._drawBoardOutline();
            this._saveBoardOutline();
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
        } catch { /* quota exceeded — ignore */ }
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

        // Wire up live editing
        const onChange = () => {
            const wEl = /** @type {HTMLInputElement} */ (document.getElementById('pcbPropBoardW'));
            const hEl = /** @type {HTMLInputElement} */ (document.getElementById('pcbPropBoardH'));
            const rEl = /** @type {HTMLInputElement} */ (document.getElementById('pcbPropBoardR'));
            this._boardWidth = Math.max(5, parseFloat(wEl?.value) || 100);
            this._boardHeight = Math.max(5, parseFloat(hEl?.value) || 80);
            this._boardRadius = Math.max(0, parseFloat(rEl?.value) || 0);
            this._drawBoardOutline();
            this._saveBoardOutline();
        };
        items.querySelector('#pcbPropBoardW')?.addEventListener('input', onChange);
        items.querySelector('#pcbPropBoardH')?.addEventListener('input', onChange);
        items.querySelector('#pcbPropBoardR')?.addEventListener('input', onChange);

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
            /** @type {Array<{number: string, dx: number, dy: number, width: number, height: number, layer: string}>} */
            const padOffsets = [];
            for (const pad of fpGeom.pads) {
                padMap.set(pad.number, { x: cx + pad.x, y: cy + pad.y });
                padOffsets.push({ number: pad.number, dx: pad.x, dy: pad.y, width: pad.width, height: pad.height, layer: pad.layer });
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
        this._drag = null;
        this.viewport.svg.style.cursor = this._selectedComp ? 'grab' : 'default';
        this._updateRatsnest();
    }

    // ── Auto Router ───────────────────────────────────────────────

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

        // Build route input from placements + netlist
        const routeInput = this._buildRouteInput();
        this._routeNetUnrouted = new Map(routeInput.connections.map(c => [c.net, true]));
        this._routeLastBoundaryKey = '';
        this._reconcileRatsnestFromRouteState();

        try {
            const startTime = performance.now();

            const result = await this._runAutoRouteInWorker(routeInput, cancelToken);

            if (cancelToken.cancelled) {
                // Keep and finalize partial routes so users can continue from this point.
                this._clearIncrementalTraces();
                this._renderRouteResult(result);
                if (result.vias?.length) {
                    this._renderVias(result.vias);
                }
                const routedNets = new Set(result.traces.map(t => t.net)).size;
                const totalNets = routeInput.connections.length;
                this._hideRouteProgress();
                this._setStatus(`${routedNets} of ${totalNets} nets routed`);
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

            // Render vias from built-in router
            if (result.vias?.length) {
                this._renderVias(result.vias);
            }

            const totalConns = result.totalConnectionCount || routeInput.connections.length;
            const viaCount = result.vias?.length || 0;
            this._hideRouteProgress();

            // Count visible ratlines — this is the authoritative unrouted count
            const ratLayer = this._getLayerGroup('ratlines');
            let unroutedConns = 0;
            for (const el of ratLayer.querySelectorAll('.ratsnest-line')) {
                if (/** @type {HTMLElement} */ (el).style.display !== 'none') unroutedConns++;
            }
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
     * @param {import('../pcb/modules/autorouter.js').RouteInput} routeInput
     * @param {{cancelled: boolean}} cancelToken
     * @returns {Promise<import('../pcb/modules/autorouter.js').RouteResult>}
     */
    _runAutoRouteInWorker(routeInput, cancelToken) {
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
                    case 'netRipped': {
                        const netName = msg.netName;
                        this._clearIncrementalNet(netName);
                        this._setRouteNetUnrouted(netName, true);
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
            worker.postMessage({ type: 'start', routeInput });

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
        const phaseLabel = isRipup
            ? `Phase: Rip-up ${Math.max(1, state.ripupPass || 1)} of ${Math.max(1, state.ripupMaxPasses || 4)}`
            : 'Phase: Route placement';
        const remainingNets = Math.max(0, Number.isFinite(state.pendingNets) ? state.pendingNets : (state.total - state.done));
        const progressLabel = isRipup
            ? `${state.done}/${state.total} (${pct}%)`
            : `${state.done}/${state.total} (${pct}%)`;
        if (label) {
            label.textContent = `${phaseLabel} - ${progressLabel} - ${remainingNets} nets unrouted`;
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
     * @returns {import('../pcb/modules/autorouter.js').RouteInput}
     */
    _buildRouteInput() {
        // Build connections with pad positions and sizes
        const connections = [];
        for (const entry of this.netlist) {
            const pads = [];
            for (const pin of entry.pins) {
                const pl = this.placements.get(pin.componentId);
                if (!pl) continue;
                const padPos = pl.pads.get(pin.pinNumber);
                if (!padPos) continue;
                // Find pad dimensions from offsets
                const off = (pl.padOffsets || []).find(o => o.number === pin.pinNumber);
                // Map footprint layer to router layer
                const fpLayer = off?.layer || 'top-copper';
                const routerLayer = fpLayer === 'bottom-copper' ? 'bottom'
                    : fpLayer === 'both' ? 'both' : 'top';
                pads.push({
                    x: padPos.x,
                    y: padPos.y,
                    width: off?.width || 1.0,
                    height: off?.height || 1.0,
                    layer: routerLayer,
                });
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
                const fpLayer = off.layer || 'top-copper';
                const routerLayer = fpLayer === 'bottom-copper' ? 'bottom'
                    : fpLayer === 'both' ? 'both' : 'top';
                allObstaclePads.push({
                    x: pl.x + off.dx,
                    y: pl.y + off.dy,
                    width: off.width || 1.0,
                    height: off.height || 1.0,
                    layer: routerLayer,
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
            gridStep: 0.5,
            bounds: { minX, maxX, minY, maxY },
        };
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
            trackWidth: readVal('pcbTrackWidth', 0.254),
            clearance: readVal('pcbClearance', 0.2),
            viaDiameter: readVal('pcbViaDiameter', 0.6),
            viaDrill: readVal('pcbViaDrill', 0.3),
        };
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
    }

    _clearIncrementalNet(netName) {
        if (!netName || !this.viewport?.svg) return;
        for (const el of this.viewport.svg.querySelectorAll(`.pcb-route-anim[data-net="${netName}"]`)) {
            el.remove();
        }
    }

    _clearIncrementalConnection(connId) {
        if (!connId || !this.viewport?.svg) return;
        for (const el of this.viewport.svg.querySelectorAll(`.pcb-route-anim[data-connid="${connId}"]`)) {
            el.remove();
        }
    }

    /**
     * Remove incremental animation traces (replaced by final clean render).
     */
    _clearIncrementalTraces() {
        const anims = this.viewport?.svg?.querySelectorAll('.pcb-route-anim');
        if (anims) {
            for (const el of anims) el.remove();
        }
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
     * @param {import('../pcb/modules/autorouter.js').RouteResult} result
     */
    _renderRouteResult(result) {
        this._flushRatsnestVisibilityQueue();
        const NS = 'http://www.w3.org/2000/svg';
        const topCopper = this._getLayerGroup('top-copper');
        const bottomCopper = this._getLayerGroup('bottom-copper');

        // Clear previous traces
        topCopper.querySelectorAll('.pcb-routed-trace').forEach(el => el.remove());
        bottomCopper.querySelectorAll('.pcb-routed-trace').forEach(el => el.remove());

        const routedNets = new Set();

        for (const trace of result.traces) {
            routedNets.add(trace.net);
            const target = trace.layer === 'bottom' ? bottomCopper : topCopper;
            const color = trace.layer === 'bottom' ? '#3498db' : '#e74c3c';

            for (let i = 0; i < trace.points.length - 1; i++) {
                const p1 = trace.points[i];
                const p2 = trace.points[i + 1];
                const line = document.createElementNS(NS, 'line');
                line.setAttribute('class', 'pcb-routed-trace');
                line.setAttribute('x1', String(p1.x));
                line.setAttribute('y1', String(p1.y));
                line.setAttribute('x2', String(p2.x));
                line.setAttribute('y2', String(p2.y));
                line.setAttribute('stroke', color);
                line.setAttribute('stroke-width', '0.254');
                line.setAttribute('stroke-linecap', 'round');
                line.setAttribute('stroke-opacity', '0.9');
                target.appendChild(line);
            }
        }

        // Reconcile final ratsnest visibility from final result when possible.
        // If result.failed is present, show only failed nets and hide all others.
        // This prevents drift from incremental hide/show events during rip-up.
        const ratLayer = this._getLayerGroup('ratlines');
        const hasFailedList = Array.isArray(result.failed);
        const failedNets = new Set(hasFailedList ? result.failed : []);

        for (const el of ratLayer.querySelectorAll('.ratsnest-line')) {
            const net = /** @type {HTMLElement} */ (el).dataset.net || '';
            /** @type {HTMLElement} */ (el).style.display = hasFailedList
                ? (failedNets.has(net) ? '' : 'none')
                : (routedNets.has(net) ? 'none' : '');
        }
        for (const el of ratLayer.children) {
            if (el.tagName !== 'text') continue;
            const net = (el.textContent || '').trim();
            /** @type {HTMLElement} */ (el).style.display = hasFailedList
                ? (failedNets.has(net) ? '' : 'none')
                : (routedNets.has(net) ? 'none' : '');
        }
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
        // Remove all routed trace elements and vias
        for (const [, g] of this._layerGroups) {
            g.querySelectorAll('.pcb-routed-trace, .pcb-routed-via').forEach(el => el.remove());
        }

        // Restore all ratlines
        const ratLayer = this._getLayerGroup('ratlines');
        for (const el of ratLayer.children) {
            /** @type {HTMLElement} */ (el).style.display = '';
        }

        this._setStatus('Routes cleared');
    }

    /**
     * Render via markers on the hole layer (visible on both copper layers).
     * @param {Array<{net: string, x: number, y: number}>} vias
     */
    _renderVias(vias) {
        const NS = 'http://www.w3.org/2000/svg';
        const holeLayer = this._getLayerGroup('hole');
        const params = this._getRoutingParams();
        const viaRadius = params.viaDiameter / 2;
        const drillRadius = params.viaDrill / 2;

        for (const via of vias) {
            // Outer copper ring
            const ring = document.createElementNS(NS, 'circle');
            ring.setAttribute('class', 'pcb-routed-via');
            ring.setAttribute('cx', String(via.x));
            ring.setAttribute('cy', String(via.y));
            ring.setAttribute('r', String(viaRadius));
            ring.setAttribute('fill', '#b8860b');
            ring.setAttribute('stroke', '#daa520');
            ring.setAttribute('stroke-width', '0.05');
            ring.setAttribute('fill-opacity', '0.9');
            holeLayer.appendChild(ring);

            // Inner drill hole
            const drill = document.createElementNS(NS, 'circle');
            drill.setAttribute('class', 'pcb-routed-via');
            drill.setAttribute('cx', String(via.x));
            drill.setAttribute('cy', String(via.y));
            drill.setAttribute('r', String(drillRadius));
            drill.setAttribute('fill', '#1a1a2e');
            holeLayer.appendChild(drill);
        }
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
                // Render imported traces
                this._renderRouteResult({ traces: result.traces, failed: [] });
                // Render vias
                if (result.vias?.length) {
                    this._renderVias(result.vias);
                }
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
