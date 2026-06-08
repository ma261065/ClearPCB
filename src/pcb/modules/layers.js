/**
 * PCB layer definitions and hover-expandable layer panel.
 *
 * Each layer has a unique id, display name, color, and
 * edit/visible state.  The panel auto-expands on hover,
 * shows a color swatch, name, edit pencil (radio), and
 * visibility eye (toggle) for every layer.
 */

/** @typedef {{id: string, name: string, color: string, edit: boolean, visible: boolean, locked: boolean}} LayerDef */

/** All PCB layers with their display colors. */
export const PCB_LAYERS = /** @type {LayerDef[]} */ ([
    { id: 'top-copper',       name: 'Top Copper',          color: '#e74c3c', edit: true,  visible: true, locked: false },
    { id: 'bottom-copper',    name: 'Bottom Copper',       color: '#3498db', edit: false, visible: true, locked: false },
    { id: 'top-silk',         name: 'Top Silk',            color: '#f0e68c', edit: false, visible: true, locked: false },
    { id: 'bottom-silk',      name: 'Bottom Silk',         color: '#a89332', edit: false, visible: true, locked: false },
    { id: 'top-paste',        name: 'Top Paste Mask',      color: '#e88dd6', edit: false, visible: true, locked: false },
    { id: 'bottom-paste',     name: 'Bottom Paste Mask',   color: '#8d5e87', edit: false, visible: true, locked: false },
    { id: 'top-mask',         name: 'Top Solder Mask',     color: '#9b59b6', edit: false, visible: true, locked: false },
    { id: 'bottom-mask',      name: 'Bottom Solder Mask',  color: '#5b3a70', edit: false, visible: true, locked: false },
    { id: 'board-outline',    name: 'Board Outline',       color: '#f1c40f', edit: false, visible: true, locked: false },
    { id: 'document',         name: 'Document',            color: '#95a5a6', edit: false, visible: true, locked: false },
    { id: 'hole',             name: 'Hole',                color: '#1abc9c', edit: false, visible: true, locked: false },
]);

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
 * True when the given layer id is currently locked. Locked layers are
 * read-only: their objects can't be selected, hovered, dragged or deleted,
 * and nothing new may be drawn on them.
 * @param {string} layerId
 * @returns {boolean}
 */
export function isLayerLocked(layerId) {
    const def = PCB_LAYERS.find(l => l.id === layerId);
    return !!(def && def.locked);
}

/**
 * True when a through-hole via is locked. A via spans both copper layers,
 * so it is protected whenever either copper layer is locked.
 * @returns {boolean}
 */
export function isViaLocked() {
    return isLayerLocked('top-copper') || isLayerLocked('bottom-copper');
}

// SVG icon paths (inline, no external deps)
const PENCIL_SVG = `<svg width="20" height="20" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M8.5 1.5l2 2L4 10H2v-2L8.5 1.5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
</svg>`;

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
    const triggerLabel = document.getElementById('pcbLayerLabel');
    const triggerSwatch = document.getElementById('pcbLayerSwatch');
    if (!panel) return;

    panel.innerHTML = '';

    // ---- Helpers --------------------------------------------------------
    /**
     * Build a section header row with a heading label and a master eye that
     * controls only the rows belonging to that section.
     * @param {string} title
     * @param {string} sectionClass - extra class so we can scope the master
     *   eye's iteration to rows of this section.
     * @returns {{row: HTMLElement, eyeBtn: HTMLButtonElement}}
     */
    const makeSectionHeader = (title, sectionClass) => {
        const row = document.createElement('div');
        row.className = 'pcb-layer-row pcb-layer-section-header';
        const heading = document.createElement('span');
        heading.className = 'pcb-layer-name';
        heading.textContent = title;
        // Span the swatch + name columns so the heading sits flush-left,
        // making the items below appear indented under it.
        heading.style.gridColumn = '1 / span 2';
        row.appendChild(heading);
        // empty pencil col
        row.appendChild(document.createElement('span'));
        // empty lock col
        row.appendChild(document.createElement('span'));
        const eyeBtn = document.createElement('button');
        eyeBtn.className = `pcb-layer-btn vis-btn section-master-vis ${sectionClass}-master active`;
        eyeBtn.innerHTML = EYE_OPEN_SVG;
        eyeBtn.title = `Show/Hide all ${title.toLowerCase()}`;
        row.appendChild(eyeBtn);
        return { row, eyeBtn };
    };

    // ---- Layers section -------------------------------------------------
    const { row: layersHeader, eyeBtn: layersMasterEye } = makeSectionHeader('Layers', 'layers');
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

    let allLayersVisible = PCB_LAYERS.every(l => l.visible);
    layersMasterEye.classList.toggle('active', allLayersVisible);
    layersMasterEye.innerHTML = allLayersVisible ? EYE_OPEN_SVG : EYE_CLOSED_SVG;
    layersMasterEye.addEventListener('click', () => {
        allLayersVisible = !allLayersVisible;
        layersMasterEye.classList.toggle('active', allLayersVisible);
        layersMasterEye.innerHTML = allLayersVisible ? EYE_OPEN_SVG : EYE_CLOSED_SVG;
        for (const layer of PCB_LAYERS) {
            layer.visible = allLayersVisible;
            app._onLayerVisibilityChanged?.(layer.id, allLayersVisible);
        }
        // Update only LAYER row eyes (not overlay rows or the other master).
        for (const row of panel.querySelectorAll('.pcb-layer-row.section-layers')) {
            const visBtn = row.querySelector('.vis-btn');
            if (!visBtn) continue;
            visBtn.classList.toggle('active', allLayersVisible);
            visBtn.innerHTML = allLayersVisible ? EYE_OPEN_SVG : EYE_CLOSED_SVG;
        }
    });

    for (const layer of PCB_LAYERS) {
        const row = document.createElement('div');
        row.className = 'pcb-layer-row section-layers' + (layer.edit ? ' active-edit' : '');
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

        // Edit button (pencil) — radio behavior
        const editBtn = document.createElement('button');
        editBtn.className = 'pcb-layer-btn edit-btn' + (layer.edit ? ' active' : '');
        editBtn.innerHTML = PENCIL_SVG;
        editBtn.title = 'Edit on this layer';
        editBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            _setEditLayer(app, layer.id);
        });
        row.appendChild(editBtn);

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
            // Locking the active edit layer would leave you unable to draw, so
            // move the active layer down one (looping at the bottom) to the
            // next unlocked layer.
            if (layer.locked && layer.edit) {
                _advanceEditLayerFromLocked(app, layer.id);
            }
            app._onLayerLockChanged?.(layer.id, layer.locked);
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
            app._onLayerVisibilityChanged?.(layer.id, layer.visible);
        });
        row.appendChild(visBtn);

        // Click row = set edit layer
        row.addEventListener('click', () => _setEditLayer(app, layer.id));

        panel.appendChild(row);
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
                app._onOverlayVisibilityChanged?.(ov.id, allOverlaysVisible);
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

            // Empty pencil column — overlays aren't editable layers.
            row.appendChild(document.createElement('span'));
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
                app._onOverlayVisibilityChanged?.(ov.id, ov.visible);
            });
            row.appendChild(visBtn);

            panel.appendChild(row);
        }
    }

    // Set initial trigger display
    _syncTrigger(triggerLabel, triggerSwatch);
}

/**
 * The active edit layer just got locked. Advance the active layer downward
 * through the PCB layer list (wrapping from bottom back to top) to the next
 * unlocked layer, so the user is never left editing a locked layer.
 * @param {object} app
 * @param {string} lockedLayerId
 */
function _advanceEditLayerFromLocked(app, lockedLayerId) {
    const n = PCB_LAYERS.length;
    const start = PCB_LAYERS.findIndex(l => l.id === lockedLayerId);
    if (start < 0) return;
    for (let step = 1; step <= n; step++) {
        const cand = PCB_LAYERS[(start + step) % n];
        if (!cand.locked) {
            _setEditLayer(app, cand.id);
            return;
        }
    }
    // Every layer is locked — nothing to switch to; leave as-is.
}

/**
 * Set the active edit layer (radio behavior — only one at a time).
 * @param {object} app
 * @param {string} layerId
 */
function _setEditLayer(app, layerId) {
    const panel = document.getElementById('pcbLayerPanel');
    if (!panel) return;

    // A locked layer can't be made the active edit layer — you can't draw
    // on something that's locked. Nudge the user with a speech bubble.
    if (isLayerLocked(layerId)) {
        showLockedLayerBubble(app, layerId);
        return;
    }

    for (const layer of PCB_LAYERS) {
        layer.edit = layer.id === layerId;
    }

    // Update all row highlights and pencil buttons
    for (const row of panel.querySelectorAll('.pcb-layer-row')) {
        const rid = /** @type {HTMLElement} */ (row).dataset.layerId;
        row.classList.toggle('active-edit', rid === layerId);
        const editBtn = row.querySelector('.edit-btn');
        if (editBtn) editBtn.classList.toggle('active', rid === layerId);
    }

    // Update trigger
    _syncTrigger(
        document.getElementById('pcbLayerLabel'),
        document.getElementById('pcbLayerSwatch')
    );

    // Notify app
    const active = PCB_LAYERS.find(l => l.id === layerId);
    if (active) {
        app.activeLayer = active.id;
        app._setPcbStatus?.();
    }
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
    const panel = document.getElementById('pcbLayerPanel');
    const row = panel
        ? panel.querySelector(`.pcb-layer-row[data-layer-id="${layerId}"]`)
        : null;
    if (!row && !anchor) return;
    const def = PCB_LAYERS.find(l => l.id === layerId);

    let bubble = document.getElementById('pcbLockedLayerBubble');
    if (!bubble) {
        bubble = document.createElement('div');
        bubble.id = 'pcbLockedLayerBubble';
        bubble.className = 'pcb-locked-bubble';
        document.body.appendChild(bubble);
    }
    bubble.innerHTML =
        `<span class="pcb-locked-bubble-icon">${LOCK_CLOSED_SVG}</span>`
        + `<span>“${def ? def.name : 'This layer'}” is locked</span>`;

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

    clearTimeout(app._lockedBubbleTimer);
    app._lockedBubbleTimer = setTimeout(() => {
        bubble.classList.remove('pcb-locked-bubble-show');
        bubble.style.display = 'none';
    }, 2400);
}

/**
 * Sync the trigger button to show the current edit layer.
 * @param {HTMLElement|null} label
 * @param {HTMLElement|null} swatch
 */
function _syncTrigger(label, swatch) {
    const active = PCB_LAYERS.find(l => l.edit);
    if (!active) return;
    if (label) label.textContent = active.name;
    if (swatch) swatch.style.background = active.color;
}
