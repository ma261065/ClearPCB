/**
 * PCB layer definitions and hover-expandable layer panel.
 *
 * Each layer has a unique id, display name, color, and
 * visibility and lock state. The panel auto-expands on hover and shows a
 * color swatch, name, lock toggle, and visibility eye for every layer.
 */

/** @typedef {{id: string, name: string, color: string, visible: boolean, locked: boolean}} LayerDef */
const lockedBubbleTimers = new WeakMap();
let layerChangeHandlers = {};

export function registerLayerChangeHandlers(handlers) {
    layerChangeHandlers = handlers;
}

export function notifyLayerVisibilityChanged(app, layerId, visible) {
    layerChangeHandlers.onLayerVisibilityChanged?.(app, layerId, visible);
}

export function notifyLayerLockChanged(app, layerId, locked) {
    layerChangeHandlers.onLayerLockChanged?.(app, layerId, locked);
}

export function notifyCopperFillVisibilityChanged(app, layerId, visible) {
    layerChangeHandlers.onCopperFillVisibilityChanged?.(app, layerId, visible);
}

export function notifyCopperFillLockChanged(app, layerId, locked) {
    layerChangeHandlers.onCopperFillLockChanged?.(app, layerId, locked);
}

export function notifyOverlayVisibilityChanged(app, overlayId, visible) {
    layerChangeHandlers.onOverlayVisibilityChanged?.(app, overlayId, visible);
}

export function applyLayerPrefsToRender(app) {
    for (const l of PCB_LAYERS) {
        notifyLayerVisibilityChanged(app, l.id, l.visible);
        notifyLayerLockChanged(app, l.id, l.locked);
    }
    for (const f of PCB_COPPER_FILLS) {
        notifyCopperFillVisibilityChanged(app, f.id, f.visible);
        notifyCopperFillLockChanged(app, f.id, f.locked);
    }
    for (const ov of PCB_OVERLAYS) {
        notifyOverlayVisibilityChanged(app, ov.id, ov.visible);
    }
}

/** All PCB layers with their display colors. */
export const PCB_LAYERS = /** @type {LayerDef[]} */ ([
    { id: 'top-copper',       name: 'Top Copper',          color: '#e74c3c', visible: true, locked: false },
    { id: 'bottom-copper',    name: 'Bottom Copper',       color: '#2479b5', visible: true, locked: false },
    { id: 'top-silk',         name: 'Top Silk',            color: '#f0e68c', visible: true, locked: false },
    { id: 'bottom-silk',      name: 'Bottom Silk',         color: '#a89332', visible: true, locked: false },
    { id: 'top-paste',        name: 'Top Paste Mask',      color: '#e88dd6', visible: true, locked: false },
    { id: 'bottom-paste',     name: 'Bottom Paste Mask',   color: '#8d5e87', visible: true, locked: false },
    { id: 'top-mask',         name: 'Top Solder Mask',     color: '#9b59b6', visible: true, locked: false },
    { id: 'bottom-mask',      name: 'Bottom Solder Mask',  color: '#5b3a70', visible: true, locked: false },
    { id: 'board-outline',    name: 'Board Outline',       color: '#f1c40f', visible: true, locked: false },
    { id: 'top-document',     name: 'Top Document',        color: '#b0b7b8', visible: true, locked: false },
    { id: 'bottom-document',  name: 'Bottom Document',     color: '#7f8c8d', visible: true, locked: false },
    { id: 'vias',             name: 'Via',                  color: '#b8860b', visible: true, locked: false },
    { id: 'hole',             name: 'Hole',                color: '#1abc9c', visible: true, locked: false },
]);

export const PCB_SELECTION_HIGHLIGHT_OPACITY = 0.5;
export const PCB_HOVER_HIGHLIGHT_OPACITY = 0.25;

/** Blend a PCB display color toward white by the requested highlight opacity. */
export function pcbHighlightColor(color, opacity) {
    const channels = color.match(/[\da-f]{2}/gi);
    if (!channels || channels.length !== 3) return color;
    return `#${channels.map((channel) => {
        const value = parseInt(channel, 16);
        return Math.round(value + (255 - value) * opacity).toString(16).padStart(2, '0');
    }).join('')}`;
}

/** Return a selected color equivalent to the shared white halo. */
export function pcbLayerSelectionColor(layerId) {
    const color = PCB_LAYERS.find((layer) => layer.id === layerId)?.color || '#ffffff';
    return pcbHighlightColor(color, PCB_SELECTION_HIGHLIGHT_OPACITY);
}

/** Return a hover color equivalent to the shared white halo. */
export function pcbLayerHoverColor(layerId) {
    const color = PCB_LAYERS.find((layer) => layer.id === layerId)?.color || '#ffffff';
    return pcbHighlightColor(color, PCB_HOVER_HIGHLIGHT_OPACITY);
}

/**
 * Overlays — non-editable visual aids (clearance halos, etc.). Rendered in
 * a separate section of the layer panel with its own master eye toggle.
 * `visible` defaults to false so overlays are off until the user enables them.
 * @typedef {{id: string, name: string, color: string, visible: boolean}} OverlayDef
 */
export const PCB_OVERLAYS = /** @type {OverlayDef[]} */ ([
    { id: 'ratlines',  name: 'Ratlines',  color: '#4488ff', visible: true },
    { id: 'clearance', name: 'Clearance', color: '#ffffff', visible: false },
]);

/**
 * Copper fill (pour) sides — their own panel section with master eye + lock,
 * mirroring the per-copper-layer pours. `id` is the copper layer the pour
 * belongs to (matching `fill.layer`); colours match the copper layers.
 * @typedef {{id: string, name: string, color: string, visible: boolean, locked: boolean}} CopperFillDef
 */
export const PCB_COPPER_FILLS = /** @type {CopperFillDef[]} */ ([
    { id: 'top-copper',    name: 'Top',    color: '#e74c3c', visible: true, locked: false },
    { id: 'bottom-copper', name: 'Bottom', color: '#2479b5', visible: true, locked: false },
]);

/**
 * True when the copper pour on the given copper layer is hidden via the
 * Copper Fill section's eye toggle.
 * @param {string} copperLayerId
 * @returns {boolean}
 */
export function isCopperFillVisible(copperLayerId) {
    const def = PCB_COPPER_FILLS.find(f => f.id === copperLayerId);
    return def ? def.visible : true;
}

/**
 * True when the copper pour on the given copper layer is locked (read-only)
 * via the Copper Fill section's lock toggle.
 * @param {string} copperLayerId
 * @returns {boolean}
 */
/** The layer panel's name for a layer ("Top Copper", "Hole"); unknown ids come back unchanged. */
export function pcbLayerName(layerId) {
    return PCB_LAYERS.find(layer => layer.id === layerId)?.name || layerId;
}

export function isCopperFillLocked(copperLayerId) {
    const def = PCB_COPPER_FILLS.find(f => f.id === copperLayerId);
    return !!(def && def.locked);
}

/** Set a PCB layer lock through its panel control so all UI state stays in sync. */
export function setPcbLayerLocked(app, layerId, locked) {
    const layer = PCB_LAYERS.find(item => item.id === layerId);
    if (!layer || layer.locked === !!locked) return;
    const button = /** @type {HTMLElement|null} */ (document.querySelector(
        `.pcb-layer-row[data-layer-id="${layerId}"] .lock-btn`,
    ));
    if (button) {
        button.click();
        return;
    }
    layer.locked = !!locked;
    notifyLayerLockChanged(app, layerId, layer.locked);
}

/** Unlock a PCB layer through its panel control so all UI state stays in sync. */
export function unlockPcbLayer(app, layerId) {
    setPcbLayerLocked(app, layerId, false);
}

/** Set a copper-fill lock through its panel control. */
export function setPcbCopperFillLocked(app, layerId, locked) {
    const fill = PCB_COPPER_FILLS.find(item => item.id === layerId);
    if (!fill || fill.locked === !!locked) return;
    const button = /** @type {HTMLElement|null} */ (document.querySelector(
        `.pcb-layer-row[data-fill-id="${layerId}"] .lock-btn`,
    ));
    if (button) {
        button.click();
        return;
    }
    fill.locked = !!locked;
    notifyCopperFillLockChanged(app, layerId, fill.locked);
}

/** Unlock a copper-fill layer through its panel control. */
export function unlockPcbCopperFill(app, layerId) {
    setPcbCopperFillLocked(app, layerId, false);
}

/** Show or hide a PCB layer through its panel control so all UI state stays in sync. */
export function setPcbLayerVisible(app, layerId, visible) {
    const layer = PCB_LAYERS.find(item => item.id === layerId);
    if (!layer || layer.visible === !!visible) return;
    const button = /** @type {HTMLElement|null} */ (document.querySelector(
        `.pcb-layer-row[data-layer-id="${layerId}"] .vis-btn`,
    ));
    if (button) {
        button.click();
        return;
    }
    layer.visible = !!visible;
    notifyLayerVisibilityChanged(app, layerId, layer.visible);
}

/** Show or hide one side's pours through the Copper Fill row's eye. */
export function setPcbCopperFillVisible(app, layerId, visible) {
    const fill = PCB_COPPER_FILLS.find(item => item.id === layerId);
    if (!fill || fill.visible === !!visible) return;
    const button = /** @type {HTMLElement|null} */ (document.querySelector(
        `.pcb-layer-row[data-fill-id="${layerId}"] .vis-btn`,
    ));
    if (button) {
        button.click();
        return;
    }
    fill.visible = !!visible;
    notifyCopperFillVisibilityChanged(app, layerId, fill.visible);
}

/**
 * True when the given layer id is currently locked. Locked layers are
 * read-only: their objects can be selected for inspection/unlocking, but
 * cannot be dragged, edited, or deleted, and nothing new may be drawn on them.
 * @param {string} layerId
 * @returns {boolean}
 */
export function isLayerLocked(layerId) {
    const def = PCB_LAYERS.find(l => l.id === layerId);
    return !!(def && def.locked);
}

// Native options need text; the variation selector requests a monochrome lock.
const LOCK_OPTION_SUFFIX = ' \u{1F512}\uFE0E';

/**
 * A layer as a Properties select option (shared/ui/property-fields.js): a locked layer
 * is disabled and marked, and refreshPcbLayerOptions keeps it current.
 * @returns {import('../../shared/ui/property-fields.js').PropertyOption}
 */
export function pcbLayerOption(layerId, label) {
    const locked = isLayerLocked(layerId);
    return { value: layerId, label: `${label}${locked ? LOCK_OPTION_SUFFIX : ''}`, disabled: locked,
        dataset: { pcbLayerLabel: label } };
}

export function refreshPcbLayerOptions(layerId) {
    const locked = isLayerLocked(layerId);
    for (const option of document.querySelectorAll(`option[value="${layerId}"][data-pcb-layer-label]`)) {
        const element = /** @type {HTMLOptionElement} */ (option);
        element.disabled = locked;
        element.textContent = `${element.dataset.pcbLayerLabel}${locked ? LOCK_OPTION_SUFFIX : ''}`;
    }
}

/**
 * True when the given layer id is currently visible (its eye toggle is on).
 * Hidden layers are non-interactive: their objects can't be selected, hovered
 * or dragged, mirroring how the layer group is rendered with display:none.
 * @param {string} layerId
 * @returns {boolean}
 */
export function isLayerVisible(layerId) {
    const def = PCB_LAYERS.find(l => l.id === layerId);
    return def ? def.visible : true;
}

/**
 * True when the given overlay id (e.g. 'ratlines', 'clearance') is currently
 * visible via its eye toggle in the Overlays section.
 * @param {string} overlayId
 * @returns {boolean}
 */
export function isOverlayVisible(overlayId) {
    const def = PCB_OVERLAYS.find(o => o.id === overlayId);
    return def ? def.visible : true;
}

/**
 * True when the dedicated Via layer is locked.
 * @returns {boolean}
 */
export function isViaLocked() {
    return isLayerLocked('vias');
}

/**
 * True when the dedicated Via layer is visible.
 * @returns {boolean}
 */
export function isViaVisible() {
    return isLayerVisible('vias');
}

/**
 * Persistence of per-session layer-panel state (eye/lock) in
 * localStorage. These are UI preferences, deliberately kept out of the saved
 * document — they survive reloads but aren't part of the file.
 */
const LAYER_PREFS_KEY = 'clearpcb_pcb_layer_prefs';
let _savePrefsScheduled = false;

function _writeLayerPrefs() {
    try {
        const data = {
            layers: {},
            fills: {},
            overlays: {},
        };
        for (const l of PCB_LAYERS) {
            data.layers[l.id] = { visible: l.visible, locked: l.locked };
        }
        for (const f of PCB_COPPER_FILLS) {
            data.fills[f.id] = { visible: f.visible, locked: f.locked };
        }
        for (const ov of PCB_OVERLAYS) {
            data.overlays[ov.id] = { visible: ov.visible };
        }
        localStorage.setItem(LAYER_PREFS_KEY, JSON.stringify(data));
    } catch { /* storage unavailable — ignore */ }
}

/** Persist the current layer-panel state (debounced to one write per frame). */
export function saveLayerPrefs() {
    if (_savePrefsScheduled) return;
    _savePrefsScheduled = true;
    requestAnimationFrame(() => {
        _savePrefsScheduled = false;
        _writeLayerPrefs();
    });
}

/** Restore layer-panel state from localStorage into the module arrays. */
export function loadLayerPrefs() {
    let data;
    try {
        data = JSON.parse(localStorage.getItem(LAYER_PREFS_KEY) || 'null');
    } catch { data = null; }
    if (!data) return;

    if (data.layers) {
        for (const l of PCB_LAYERS) {
            const s = data.layers[l.id];
            if (!s) continue;
            if (typeof s.visible === 'boolean') l.visible = s.visible;
            if (typeof s.locked === 'boolean') l.locked = s.locked;
        }
    }
    if (data.fills) {
        for (const f of PCB_COPPER_FILLS) {
            const s = data.fills[f.id];
            if (!s) continue;
            if (typeof s.visible === 'boolean') f.visible = s.visible;
            if (typeof s.locked === 'boolean') f.locked = s.locked;
        }
    }
    if (data.overlays) {
        for (const ov of PCB_OVERLAYS) {
            const s = data.overlays[ov.id];
            if (s && typeof s.visible === 'boolean') ov.visible = s.visible;
        }
    }
}

const EYE_OPEN_SVG = `<svg width="20" height="20" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M1 7s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4z" stroke="currentColor" stroke-width="1.1"/>
  <circle cx="7" cy="7" r="1.8" stroke="currentColor" stroke-width="1.1"/>
</svg>`;

const EYE_CLOSED_SVG = `<svg width="20" height="20" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M1 7s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4z" stroke="currentColor" stroke-width="1.1"/>
  <line x1="2" y1="12" x2="12" y2="2" stroke="currentColor" stroke-width="1.2"/>
</svg>`;

const LOCK_CLOSED_SVG = `<svg width="20" height="20" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="3" y="6.2" width="8" height="5.5" rx="1" stroke="currentColor" stroke-width="1.1"/>
  <path d="M4.6 6.2V4.6a2.4 2.4 0 0 1 4.8 0v1.6" stroke="currentColor" stroke-width="1.1"/>
</svg>`;

const LOCK_OPEN_SVG = `<svg width="20" height="20" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="3" y="6.2" width="8" height="5.5" rx="1" stroke="currentColor" stroke-width="1.1"/>
  <path d="M4.6 6.2V4.6a2.4 2.4 0 0 1 4.8-0.4" stroke="currentColor" stroke-width="1.1"/>
</svg>`;

const PIN_SVG = `<svg width="28" height="28" viewBox="3.5 0.5 7 13" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M5.2 1.5h3.6l-0.5 3 1.9 1.9-0.6 0.6H4.4l-0.6-0.6 1.9-1.9-0.5-3z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/>
  <path d="M7 7v5.5" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>
</svg>`;

/**
 * Build the layer panel inside #pcbLayerPanel and wire events.
 * @param {object} app - PCBApp instance
 */
export function buildLayerPanel(app) {
    const panel = document.getElementById('pcbLayerPanel');
    if (!panel) return;

    // Restore persisted eye/lock state before rendering the rows.
    loadLayerPrefs();

    panel.innerHTML = '';
    const panelLayers = PCB_LAYERS;

    // ---- Helpers --------------------------------------------------------
    /**
     * Build a section header row with a heading label and a master eye that
     * controls only the rows belonging to that section.
     * @param {string} title
     * @param {string} sectionClass - extra class so we can scope the master
     *   eye's iteration to rows of this section.
     * @param {boolean} [withLock] - also add a master lock button in the lock
     *   column (only the Layers section has per-row locks).
     * @returns {{row: HTMLElement, eyeBtn: HTMLButtonElement,
     *   lockBtn: HTMLButtonElement|null}}
     */
    const makeSectionHeader = (title, sectionClass, withLock = false) => {
        const row = document.createElement('div');
        row.className = 'pcb-layer-row pcb-layer-section-header';
        const heading = document.createElement('span');
        heading.className = 'pcb-layer-name';
        heading.textContent = title;
        // Span the swatch + name columns so the heading sits flush-left,
        // making the items below appear indented under it.
        heading.style.gridColumn = '1 / span 2';
        row.appendChild(heading);
        // lock col: a master lock button when requested, else an empty spacer
        let lockBtn = null;
        if (withLock) {
            lockBtn = document.createElement('button');
            lockBtn.className = `pcb-layer-btn lock-btn section-master-lock ${sectionClass}-master-lock`;
            lockBtn.innerHTML = LOCK_OPEN_SVG;
            lockBtn.title = `Lock/Unlock all ${title.toLowerCase()}`;
            row.appendChild(lockBtn);
        } else {
            row.appendChild(document.createElement('span'));
        }
        const eyeBtn = document.createElement('button');
        eyeBtn.className = `pcb-layer-btn vis-btn section-master-vis ${sectionClass}-master active`;
        eyeBtn.innerHTML = EYE_OPEN_SVG;
        eyeBtn.title = `Show/Hide all ${title.toLowerCase()}`;
        row.appendChild(eyeBtn);
        return { row, eyeBtn, lockBtn };
    };

    // ---- Layers section -------------------------------------------------
    const { row: layersHeader, eyeBtn: layersMasterEye, lockBtn: layersMasterLock } =
        makeSectionHeader('Layers', 'layers', true);
    panel.appendChild(layersHeader);

    // Pin toggle, sitting just left of the "Layers" heading text. Keeps the
    // panel open after the mouse leaves so the user can work on the board
    // without it auto-collapsing.
    const control = document.getElementById('pcbLayerControl');
    const layersHeading = /** @type {HTMLElement|null} */ (layersHeader.querySelector('.pcb-layer-name'));
    if (layersHeading) {
        layersHeading.style.display = 'flex';
        layersHeading.style.alignItems = 'center';
        layersHeading.style.gap = '6px';
        const pinBtn = document.createElement('button');
        pinBtn.className = 'pcb-layer-pin' + (control?.classList.contains('pinned') ? ' active' : '');
        pinBtn.innerHTML = PIN_SVG;
        pinBtn.title = control?.classList.contains('pinned') ? 'Unpin panel' : 'Pin Panel';
        pinBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const pinned = control?.classList.toggle('pinned') ?? false;
            pinBtn.classList.toggle('active', pinned);
            pinBtn.title = pinned ? 'Unpin panel' : 'Pin Panel';
        });
        layersHeading.insertBefore(pinBtn, layersHeading.firstChild);
    }

    let allLayersVisible = panelLayers.every(l => l.visible);
    layersMasterEye.classList.toggle('active', allLayersVisible);
    layersMasterEye.innerHTML = allLayersVisible ? EYE_OPEN_SVG : EYE_CLOSED_SVG;
    layersMasterEye.addEventListener('click', () => {
        allLayersVisible = !allLayersVisible;
        layersMasterEye.classList.toggle('active', allLayersVisible);
        layersMasterEye.innerHTML = allLayersVisible ? EYE_OPEN_SVG : EYE_CLOSED_SVG;
        for (const layer of panelLayers) {
            layer.visible = allLayersVisible;
            notifyLayerVisibilityChanged(app, layer.id, allLayersVisible);
        }
        // Update only LAYER row eyes (not overlay rows or the other master).
        for (const row of panel.querySelectorAll('.pcb-layer-row.section-layers')) {
            const visBtn = row.querySelector('.vis-btn');
            if (!visBtn) continue;
            visBtn.classList.toggle('active', allLayersVisible);
            visBtn.innerHTML = allLayersVisible ? EYE_OPEN_SVG : EYE_CLOSED_SVG;
        }
    });

    // Master lock: lock or unlock every layer at once.
    let allLayersLocked = panelLayers.every(l => l.locked);
    const syncMasterLock = () => {
        if (!layersMasterLock) return;
        layersMasterLock.classList.toggle('active', allLayersLocked);
        layersMasterLock.innerHTML = allLayersLocked ? LOCK_CLOSED_SVG : LOCK_OPEN_SVG;
        layersMasterLock.title = allLayersLocked ? 'Unlock all layers' : 'Lock all layers';
    };
    syncMasterLock();
    layersMasterLock?.addEventListener('click', (e) => {
        e.stopPropagation();
        allLayersLocked = !allLayersLocked;
        syncMasterLock();
        for (const layer of panelLayers) {
            layer.locked = allLayersLocked;
            notifyLayerLockChanged(app, layer.id, allLayersLocked);
        }
        // Update only LAYER row lock buttons.
        for (const row of panel.querySelectorAll('.pcb-layer-row.section-layers')) {
            const lockBtn = /** @type {HTMLButtonElement|null} */ (row.querySelector('.lock-btn'));
            if (!lockBtn) continue;
            lockBtn.classList.toggle('active', allLayersLocked);
            lockBtn.innerHTML = allLayersLocked ? LOCK_CLOSED_SVG : LOCK_OPEN_SVG;
            lockBtn.title = allLayersLocked ? 'Unlock layer' : 'Lock layer';
        }
    });

    for (const layer of panelLayers) {
        const row = document.createElement('div');
        row.className = 'pcb-layer-row section-layers';
        row.dataset.layerId = layer.id;

        // Color swatch
        const swatch = document.createElement('span');
        swatch.className = 'pcb-layer-swatch';
        swatch.style.background = layer.color;
        row.appendChild(swatch);

        // Name
        const name = document.createElement('span');
        name.className = 'pcb-layer-name';
        name.textContent = layer.name;
        name.style.color = layer.color;
        row.appendChild(name);

        // Lock button (padlock) — toggle. A locked layer renders dimmed
        // so it's visually distinct from the editable layers.
        const lockBtn = document.createElement('button');
        lockBtn.className = 'pcb-layer-btn lock-btn' + (layer.locked ? ' active' : '');
        lockBtn.innerHTML = layer.locked ? LOCK_CLOSED_SVG : LOCK_OPEN_SVG;
        lockBtn.title = 'Lock layer';
        lockBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            layer.locked = !layer.locked;
            lockBtn.classList.toggle('active', layer.locked);
            lockBtn.innerHTML = layer.locked ? LOCK_CLOSED_SVG : LOCK_OPEN_SVG;
            lockBtn.title = layer.locked ? 'Unlock layer' : 'Lock layer';
            notifyLayerLockChanged(app, layer.id, layer.locked);
            // Keep the master lock in sync with the per-row states.
            allLayersLocked = panelLayers.every(l => l.locked);
            syncMasterLock();
        });
        row.appendChild(lockBtn);

        // Visibility button (eye) — toggle
        const visBtn = document.createElement('button');
        visBtn.className = 'pcb-layer-btn vis-btn' + (layer.visible ? ' active' : '');
        visBtn.innerHTML = layer.visible ? EYE_OPEN_SVG : EYE_CLOSED_SVG;
        visBtn.title = 'Toggle visibility';
        visBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            layer.visible = !layer.visible;
            visBtn.classList.toggle('active', layer.visible);
            visBtn.innerHTML = layer.visible ? EYE_OPEN_SVG : EYE_CLOSED_SVG;
            notifyLayerVisibilityChanged(app, layer.id, layer.visible);
            allLayersVisible = panelLayers.every(layer => layer.visible);
            layersMasterEye.classList.toggle('active', allLayersVisible);
            layersMasterEye.innerHTML = allLayersVisible ? EYE_OPEN_SVG : EYE_CLOSED_SVG;
        });
        row.appendChild(visBtn);

        panel.appendChild(row);
    }

    // ---- Copper Fill section -------------------------------------------
    {
        const { row: cfHeader, eyeBtn: cfMasterEye, lockBtn: cfMasterLock } =
            makeSectionHeader('Copper Fill', 'copperfill', true);
        cfHeader.style.marginTop = '6px';
        panel.appendChild(cfHeader);

        // Master eye: show/hide both pour sides.
        let allFillsVisible = PCB_COPPER_FILLS.every(f => f.visible);
        cfMasterEye.classList.toggle('active', allFillsVisible);
        cfMasterEye.innerHTML = allFillsVisible ? EYE_OPEN_SVG : EYE_CLOSED_SVG;
        cfMasterEye.addEventListener('click', () => {
            allFillsVisible = !allFillsVisible;
            cfMasterEye.classList.toggle('active', allFillsVisible);
            cfMasterEye.innerHTML = allFillsVisible ? EYE_OPEN_SVG : EYE_CLOSED_SVG;
            for (const f of PCB_COPPER_FILLS) {
                f.visible = allFillsVisible;
                notifyCopperFillVisibilityChanged(app, f.id, allFillsVisible);
            }
            for (const row of panel.querySelectorAll('.pcb-layer-row.section-copperfill')) {
                const visBtn = row.querySelector('.vis-btn');
                if (!visBtn) continue;
                visBtn.classList.toggle('active', allFillsVisible);
                visBtn.innerHTML = allFillsVisible ? EYE_OPEN_SVG : EYE_CLOSED_SVG;
            }
        });

        // Master lock: lock/unlock both pour sides.
        let allFillsLocked = PCB_COPPER_FILLS.every(f => f.locked);
        const syncCfMasterLock = () => {
            if (!cfMasterLock) return;
            cfMasterLock.classList.toggle('active', allFillsLocked);
            cfMasterLock.innerHTML = allFillsLocked ? LOCK_CLOSED_SVG : LOCK_OPEN_SVG;
            cfMasterLock.title = allFillsLocked ? 'Unlock all copper fill' : 'Lock all copper fill';
        };
        syncCfMasterLock();
        cfMasterLock?.addEventListener('click', (e) => {
            e.stopPropagation();
            allFillsLocked = !allFillsLocked;
            syncCfMasterLock();
            for (const f of PCB_COPPER_FILLS) {
                f.locked = allFillsLocked;
                notifyCopperFillLockChanged(app, f.id, allFillsLocked);
            }
            for (const row of panel.querySelectorAll('.pcb-layer-row.section-copperfill')) {
                const lockBtn = /** @type {HTMLButtonElement|null} */ (row.querySelector('.lock-btn'));
                if (!lockBtn) continue;
                lockBtn.classList.toggle('active', allFillsLocked);
                lockBtn.innerHTML = allFillsLocked ? LOCK_CLOSED_SVG : LOCK_OPEN_SVG;
                lockBtn.title = allFillsLocked ? 'Unlock copper fill' : 'Lock copper fill';
            }
        });

        for (const f of PCB_COPPER_FILLS) {
            const row = document.createElement('div');
            row.className = 'pcb-layer-row section-copperfill';
            row.dataset.fillId = f.id;

            const swatch = document.createElement('span');
            swatch.className = 'pcb-layer-swatch';
            swatch.style.background = f.color;
            row.appendChild(swatch);

            const name = document.createElement('span');
            name.className = 'pcb-layer-name';
            name.textContent = f.name;
            name.style.color = f.color;
            row.appendChild(name);

            // Lock button (padlock) — toggle.
            const lockBtn = document.createElement('button');
            lockBtn.className = 'pcb-layer-btn lock-btn' + (f.locked ? ' active' : '');
            lockBtn.innerHTML = f.locked ? LOCK_CLOSED_SVG : LOCK_OPEN_SVG;
            lockBtn.title = 'Lock copper fill';
            lockBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                f.locked = !f.locked;
                lockBtn.classList.toggle('active', f.locked);
                lockBtn.innerHTML = f.locked ? LOCK_CLOSED_SVG : LOCK_OPEN_SVG;
                lockBtn.title = f.locked ? 'Unlock copper fill' : 'Lock copper fill';
                notifyCopperFillLockChanged(app, f.id, f.locked);
                allFillsLocked = PCB_COPPER_FILLS.every(x => x.locked);
                syncCfMasterLock();
            });
            row.appendChild(lockBtn);

            // Visibility button (eye) — toggle.
            const visBtn = document.createElement('button');
            visBtn.className = 'pcb-layer-btn vis-btn' + (f.visible ? ' active' : '');
            visBtn.innerHTML = f.visible ? EYE_OPEN_SVG : EYE_CLOSED_SVG;
            visBtn.title = 'Toggle copper fill';
            visBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                f.visible = !f.visible;
                visBtn.classList.toggle('active', f.visible);
                visBtn.innerHTML = f.visible ? EYE_OPEN_SVG : EYE_CLOSED_SVG;
                notifyCopperFillVisibilityChanged(app, f.id, f.visible);
                allFillsVisible = PCB_COPPER_FILLS.every(x => x.visible);
                cfMasterEye.classList.toggle('active', allFillsVisible);
                cfMasterEye.innerHTML = allFillsVisible ? EYE_OPEN_SVG : EYE_CLOSED_SVG;
            });
            row.appendChild(visBtn);

            panel.appendChild(row);
        }
    }

    // ---- Overlays section ----------------------------------------------
    if (PCB_OVERLAYS.length > 0) {
        const { row: ovHeader, eyeBtn: overlaysMasterEye } = makeSectionHeader('Overlays', 'overlays');
        // Add a small top margin so the section is visually separated.
        ovHeader.style.marginTop = '6px';
        panel.appendChild(ovHeader);

        let allOverlaysVisible = PCB_OVERLAYS.every(o => o.visible);
        overlaysMasterEye.classList.toggle('active', allOverlaysVisible);
        overlaysMasterEye.innerHTML = allOverlaysVisible ? EYE_OPEN_SVG : EYE_CLOSED_SVG;
        overlaysMasterEye.addEventListener('click', () => {
            allOverlaysVisible = !allOverlaysVisible;
            overlaysMasterEye.classList.toggle('active', allOverlaysVisible);
            overlaysMasterEye.innerHTML = allOverlaysVisible ? EYE_OPEN_SVG : EYE_CLOSED_SVG;
            for (const ov of PCB_OVERLAYS) {
                ov.visible = allOverlaysVisible;
                notifyOverlayVisibilityChanged(app, ov.id, allOverlaysVisible);
            }
            for (const row of panel.querySelectorAll('.pcb-layer-row.section-overlays')) {
                const visBtn = row.querySelector('.vis-btn');
                if (!visBtn) continue;
                visBtn.classList.toggle('active', allOverlaysVisible);
                visBtn.innerHTML = allOverlaysVisible ? EYE_OPEN_SVG : EYE_CLOSED_SVG;
            }
        });

        for (const ov of PCB_OVERLAYS) {
            const row = document.createElement('div');
            row.className = 'pcb-layer-row section-overlays';
            row.dataset.overlayId = ov.id;

            const swatch = document.createElement('span');
            swatch.className = 'pcb-layer-swatch';
            swatch.style.background = ov.color;
            row.appendChild(swatch);

            const name = document.createElement('span');
            name.className = 'pcb-layer-name';
            name.textContent = ov.name;
            name.style.color = ov.color;
            row.appendChild(name);

            // Empty lock column — overlays can't be locked.
            row.appendChild(document.createElement('span'));

            const visBtn = document.createElement('button');
            visBtn.className = 'pcb-layer-btn vis-btn' + (ov.visible ? ' active' : '');
            visBtn.innerHTML = ov.visible ? EYE_OPEN_SVG : EYE_CLOSED_SVG;
            visBtn.title = 'Toggle overlay';
            visBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                ov.visible = !ov.visible;
                visBtn.classList.toggle('active', ov.visible);
                visBtn.innerHTML = ov.visible ? EYE_OPEN_SVG : EYE_CLOSED_SVG;
                notifyOverlayVisibilityChanged(app, ov.id, ov.visible);
                allOverlaysVisible = PCB_OVERLAYS.every(overlay => overlay.visible);
                overlaysMasterEye.classList.toggle('active', allOverlaysVisible);
                overlaysMasterEye.innerHTML = allOverlaysVisible ? EYE_OPEN_SVG : EYE_CLOSED_SVG;
            });
            row.appendChild(visBtn);

            panel.appendChild(row);
        }
    }

}
/**
 * A layer-panel row a new object would be drawn on: a layer, or (`fill`) one side's
 * Copper Fill row, which locks or hides that side's pours.
 * @typedef {{id: string, fill?: boolean}} PlacementLayer
 * @typedef {PlacementLayer & {reason: 'locked'|'hidden'}} PlacementBlock
 */

/** @param {PlacementLayer} target @param {'locked'|'hidden'} reason */
function placementBlocked(target, reason) {
    if (target.fill) return reason === 'locked' ? isCopperFillLocked(target.id) : !isCopperFillVisible(target.id);
    return reason === 'locked' ? isLayerLocked(target.id) : !isLayerVisible(target.id);
}

/**
 * Why nothing may be placed on these rows, or null. Nothing is drawn on a locked row,
 * nor on a hidden one, where the new object would be invisible. A lock is reported first.
 * @param {PlacementLayer[]} targets
 * @returns {PlacementBlock|null}
 */
export function placementBlock(targets) {
    for (const reason of /** @type {const} */ (['locked', 'hidden'])) {
        const target = targets.find(item => placementBlocked(item, reason));
        if (target) return { id: target.id, fill: !!target.fill, reason };
    }
    return null;
}

/** The layer panel's name for a blocked row: "Via", "Top Silk", "Top Copper Fill". */
export function placementBlockName(block) {
    if (!block.fill) return pcbLayerName(block.id);
    return `${PCB_COPPER_FILLS.find(fill => fill.id === block.id)?.name || pcbLayerName(block.id)} Copper Fill`;
}

/** "“Via” is locked" / "“Top Silk” is hidden". */
export function placementBlockMessage(block) {
    return `“${placementBlockName(block)}” is ${block.reason}`;
}

/** The button label that lifts a block: Unlock or Show. */
export const placementBlockAction = block => (block.reason === 'locked' ? 'Unlock' : 'Show');

/** Lift a block through the layer panel's own control, so every view of the layer follows. */
export function clearPlacementBlock(app, block) {
    if (block.reason === 'locked') {
        if (block.fill) unlockPcbCopperFill(app, block.id);
        else unlockPcbLayer(app, block.id);
    } else if (block.fill) setPcbCopperFillVisible(app, block.id, true);
    else setPcbLayerVisible(app, block.id, true);
}

/**
 * Refuse a placement onto a locked or hidden row, saying why at the pointer with a
 * button that lifts the block. Placement tools keep their preview there, so a silent
 * refusal would look like a dead click.
 * @param {object} app
 * @param {PlacementLayer[]} targets every row the placed object would occupy
 * @param {{clientX: number, clientY: number}} [event] the press, to anchor the bubble
 * @returns {boolean} true when the press was refused
 */
export function refuseBlockedPlacement(app, targets, event) {
    const block = placementBlock(targets);
    if (!block) return false;
    showLayerBubble(app, block, event ? { x: event.clientX, y: event.clientY } : undefined, { action: true });
    return true;
}

/**
 * Show a small speech bubble explaining why a locked layer/object can't be
 * selected. Anchors to the layer's row in the panel by default, or to a given
 * client-space point (e.g. the mouse cursor) when `anchor` is provided.
 * Auto-dismisses after a short delay.
 * @param {object} app
 * @param {string} layerId
 * @param {{x:number,y:number}} [anchor] client-space point to anchor beside
 */
export function showLockedLayerBubble(app, layerId, anchor) {
    showLayerBubble(app, { id: layerId, reason: 'locked' }, anchor);
}

/**
 * Speech bubble saying a row is locked or hidden, beside `anchor` or the row itself.
 * With `action`, it carries the button that unlocks or shows the row, and stays up
 * longer (and while the pointer is on it) so the button can be reached.
 * @param {object} app
 * @param {PlacementBlock} block
 * @param {{x:number,y:number}} [anchor] client-space point to anchor beside
 * @param {{action?: boolean}} [options]
 */
export function showLayerBubble(app, block, anchor, { action = false } = {}) {
    const panel = document.getElementById('pcbLayerPanel');
    const row = panel
        ? panel.querySelector(block.fill ? `.pcb-layer-row[data-fill-id="${block.id}"]`
            : `.pcb-layer-row[data-layer-id="${block.id}"]`)
        : null;
    if (!row && !anchor) return;

    let bubble = document.getElementById('pcbLockedLayerBubble');
    if (!bubble) {
        bubble = document.createElement('div');
        bubble.id = 'pcbLockedLayerBubble';
        bubble.className = 'pcb-locked-bubble';
        document.body.appendChild(bubble);
    }
    const hide = () => {
        clearTimeout(lockedBubbleTimers.get(app));
        bubble.classList.remove('pcb-locked-bubble-show');
        bubble.style.display = 'none';
    };
    const icon = block.reason === 'locked' ? LOCK_CLOSED_SVG : EYE_CLOSED_SVG;
    bubble.innerHTML = `<span class="pcb-locked-bubble-icon">${icon}</span>`
        + `<span class="pcb-locked-bubble-text">${placementBlockMessage(block)}</span>`;
    bubble.classList.toggle('pcb-locked-bubble-actionable', action);
    if (action) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'pcb-locked-bubble-action';
        button.textContent = placementBlockAction(block);
        button.addEventListener('click', event => {
            event.stopPropagation();
            hide();
            clearPlacementBlock(app, block);
        });
        bubble.appendChild(button);
    }

    // Resolve the anchor point (client space). Default to the row's left edge.
    let anchorX, anchorY;
    if (anchor) {
        anchorX = anchor.x;
        anchorY = anchor.y;
    } else if (row) {
        const r = row.getBoundingClientRect();
        anchorX = r.left;
        anchorY = r.top + r.height / 2;
    } else {
        return;
    }

    // Make it measurable, then decide which side to grow toward so it never
    // clips off the left edge of the window.
    bubble.style.display = 'flex';
    bubble.classList.remove('pcb-locked-bubble-flip');
    const width = bubble.offsetWidth;
    const height = bubble.offsetHeight;
    const margin = 8;
    // The default layout grows LEFT from the anchor (tail on the right). If
    // that would push the left edge off-screen, flip so it grows RIGHT.
    const flip = (anchorX - 10) - width < margin;
    bubble.classList.toggle('pcb-locked-bubble-flip', flip);

    // Clamp vertically so the bubble stays fully on-screen.
    const top = Math.min(
        Math.max(anchorY, margin + height / 2),
        window.innerHeight - margin - height / 2
    );
    bubble.style.top = `${top}px`;
    bubble.style.left = `${flip ? anchorX + 10 : anchorX - 10}px`;

    // Restart the pop-in animation each time it's triggered.
    bubble.classList.remove('pcb-locked-bubble-show');
    // Force reflow so re-adding the class restarts the keyframes.
    void bubble.offsetWidth;
    bubble.classList.add('pcb-locked-bubble-show');

    const linger = action ? 5000 : 2400;
    const schedule = () => {
        clearTimeout(lockedBubbleTimers.get(app));
        lockedBubbleTimers.set(app, setTimeout(hide, linger));
    };
    bubble.onmouseenter = action ? () => clearTimeout(lockedBubbleTimers.get(app)) : null;
    bubble.onmouseleave = action ? schedule : null;
    schedule();
}
