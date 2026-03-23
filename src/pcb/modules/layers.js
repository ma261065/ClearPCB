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
    { id: 'ratlines',         name: 'Ratlines',            color: '#4488ff', edit: false, visible: true },
    { id: 'board-outline',    name: 'Board Outline',       color: '#f1c40f', edit: false, visible: true },
    { id: 'document',         name: 'Document',            color: '#95a5a6', edit: false, visible: true },
    { id: 'hole',             name: 'Hole',                color: '#1abc9c', edit: false, visible: true },
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

    // Show all / Hide all toggle row
    const toggleRow = document.createElement('div');
    toggleRow.className = 'pcb-layer-row';
    toggleRow.style.borderBottom = '1px solid rgba(255,255,255,0.1)';
    toggleRow.style.marginBottom = '2px';
    toggleRow.style.paddingBottom = '5px';

    // Empty swatch column
    toggleRow.appendChild(document.createElement('span'));
    // Empty name column
    toggleRow.appendChild(document.createElement('span'));
    // Empty pencil column
    toggleRow.appendChild(document.createElement('span'));

    // Eye toggle in the eye column
    const toggleEyeBtn = document.createElement('button');
    toggleEyeBtn.className = 'pcb-layer-btn vis-btn active';
    toggleEyeBtn.innerHTML = EYE_OPEN_SVG;
    toggleEyeBtn.title = 'Show/Hide all layers';
    toggleRow.appendChild(toggleEyeBtn);

    let allVisible = true;
    toggleEyeBtn.addEventListener('click', () => {
        allVisible = !allVisible;
        toggleEyeBtn.classList.toggle('active', allVisible);
        toggleEyeBtn.innerHTML = allVisible ? EYE_OPEN_SVG : EYE_CLOSED_SVG;
        for (const layer of PCB_LAYERS) {
            layer.visible = allVisible;
            app._onLayerVisibilityChanged?.(layer.id, allVisible);
        }
        // Update all eye buttons
        for (const row of panel.querySelectorAll('.pcb-layer-row')) {
            const visBtn = row.querySelector('.vis-btn');
            if (!visBtn || visBtn === toggleEyeBtn) continue;
            visBtn.classList.toggle('active', allVisible);
            visBtn.innerHTML = allVisible ? EYE_OPEN_SVG : EYE_CLOSED_SVG;
        }
    });
    panel.appendChild(toggleRow);

    for (const layer of PCB_LAYERS) {
        const row = document.createElement('div');
        row.className = 'pcb-layer-row' + (layer.edit ? ' active-edit' : '');
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
