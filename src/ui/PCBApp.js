// PCBApp.js - PCB Editor Application

import { bindPcbControls } from '../pcb/modules/controls.js';
import { Viewport } from '../core/Viewport.js';
import { loadAndApplyTheme, toggleTheme as toggleSharedTheme, syncThemeToggleButtons } from '../shared/ui/theme.js';
import { extractNetlist, extractComponents } from '../pcb/modules/netlist.js';
import { generateFootprint, renderFootprint } from '../pcb/modules/footprint.js';
import { buildRatsnest } from '../pcb/modules/ratsnest.js';
import { updateGridDropdown } from './modules/viewport.js';
import { PCB_LAYERS } from '../pcb/modules/layers.js';

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
    }

    deactivate() {
        this._active = false;
    }

    _setPcbStatus() {
        if (!this.status.modeStatus) return;
        const toolLabel = this.currentTool === 'pan' ? 'Pan' : 'Select';
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
                    const pl = this.placements.get(hit);
                    if (pl) {
                        this._drag = {
                            compId: hit,
                            startWorld: worldPos,
                            startPos: { x: pl.x, y: pl.y },
                        };
                        svg.style.cursor = 'grabbing';
                    }
                } else {
                    this._selectComponent(null);
                }
            }
        });

        svg.addEventListener('mousemove', (e) => {
            if (!this._active) return;
            if (this.viewport.isPanning) {
                this.viewport.updatePan(e.clientX, e.clientY);
            } else if (this._drag) {
                this._handleDrag(e);
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
        };

        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                const tabEl = /** @type {HTMLElement} */ (tab);
                if (!tabEl.dataset.tab) return;
                setActive(tabEl.dataset.tab);
            });
        });
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

        for (let i = 0; i < components.length; i++) {
            const comp = components[i];
            const col = i % COLS;
            const row = Math.floor(i / COLS);
            const cx = col * SPACING_X;
            const cy = row * SPACING_Y;

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
            /** @type {Array<{number: string, dx: number, dy: number}>} */
            const padOffsets = [];
            for (const pad of fpGeom.pads) {
                padMap.set(pad.number, { x: cx + pad.x, y: cy + pad.y });
                padOffsets.push({ number: pad.number, dx: pad.x, dy: pad.y });
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
