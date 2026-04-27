/**
 * PCB layer definitions and hover-expandable layer panel.
 *
 * Each layer has a unique id, display name, color, and
 * edit/visible state.  The panel auto-expands on hover,
 * shows a color swatch, name, edit pencil (radio), and
 * visibility eye (toggle) for every layer.
 */

/** @typedef {{id: string, name: string, color: string, edit: boolean, visible: boolean}} LayerDef */

/** All PCB layers with their display colors. */
export const PCB_LAYERS = /** @type {LayerDef[]} */ ([
    { id: 'top-copper',       name: 'Top Copper',          color: '#e74c3c', edit: true,  visible: true },
    { id: 'bottom-copper',    name: 'Bottom Copper',       color: '#3498db', edit: false, visible: true },
    { id: 'top-silk',         name: 'Top Silk',            color: '#f0e68c', edit: false, visible: true },
    { id: 'bottom-silk',      name: 'Bottom Silk',         color: '#a89332', edit: false, visible: true },
    { id: 'top-paste',        name: 'Top Paste Mask',      color: '#e88dd6', edit: false, visible: true },
    { id: 'bottom-paste',     name: 'Bottom Paste Mask',   color: '#8d5e87', edit: false, visible: true },
    { id: 'top-mask',         name: 'Top Solder Mask',     color: '#9b59b6', edit: false, visible: true },
    { id: 'bottom-mask',      name: 'Bottom Solder Mask',  color: '#5b3a70', edit: false, visible: true },
    { id: 'board-outline',    name: 'Board Outline',       color: '#f1c40f', edit: false, visible: true },
    { id: 'document',         name: 'Document',            color: '#95a5a6', edit: false, visible: true },
    { id: 'hole',             name: 'Hole',                color: '#1abc9c', edit: false, visible: true },
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
 * Set the active edit layer (radio behavior — only one at a time).
 * @param {object} app
 * @param {string} layerId
 */
function _setEditLayer(app, layerId) {
    const panel = document.getElementById('pcbLayerPanel');
    if (!panel) return;

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
