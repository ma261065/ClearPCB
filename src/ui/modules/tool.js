import { updateSnapHighlight } from './wire.js';

const STORAGE_KEY = 'clearpcb_tool_options';

/** Half-size of the NoConnect X mark in mm (mirrors noconnect.js NC_HALF). */
const NC_HALF = 0.8;
/** NetLabel ghost sizing constants (mirrors netlabel.js geometry intent). */
const NL_FLAG_TIP = 1.0;
const NL_FLAG_PAD_X = 0.6;
const NL_FLAG_PAD_Y = 0.3;
const NL_FONT_SIZE = 1.8;

function _nextNetLabelName(app) {
    const used = new Set();
    for (const shape of app.shapes) {
        if (shape?.type !== 'netlabel' || typeof shape.net !== 'string') continue;
        const m = shape.net.trim().match(/^NET(\d+)$/i);
        if (m) used.add(Number(m[1]));
    }
    let i = 1;
    while (used.has(i)) i += 1;
    return `NET${i}`;
}

/**
 * Reads persisted tool options (line width, fill, font size) from localStorage.
 * @returns {object|null} Parsed options object, or `null` if none stored.
 */
export function loadToolOptions() {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
            return JSON.parse(stored);
        }
    } catch (e) {
        console.warn('Failed to load tool options:', e);
    }
    return null;
}

/**
 * Persists tool options to localStorage.
 * @param {object} options - Tool options to save.
 */
export function saveToolOptions(options) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(options));
    } catch (e) {
        console.warn('Failed to save tool options:', e);
    }
}

/**
 * Switches the active drawing tool: cancels current drawing, clears snap
 * highlight, clears selection for non-select tools, opens/closes the component
 * picker, and updates cursor and ribbon state.
 * @param {object} app - Application state.
 * @param {string} tool - Tool identifier to activate.
 */
export function onToolSelected(app, tool) {
    app._cancelDrawing();
    
    // Clear any snap highlight left from the previous tool (e.g. wire hover dot)
    updateSnapHighlight(app, null);

    // Update current tool first so that listeners (like ribbon) 
    // see the new tool state when selection is cleared
    app.currentTool = tool;
    
    // Clear selection when switching tools so that property panel inputs 
    // control default tool options (new shapes) rather than editing existing selection.
    if (tool !== 'select') {
        app.selection.clearSelection();
        app.renderShapes(true);
    }

    if (tool !== 'component' && app.placingComponent) {
        app._cancelComponentPlacement();
    }

    if (tool !== 'component' && app.componentPicker.isOpen) {
        app.componentPicker.close();
    }

    if (tool === 'component') {
        if (!app.componentPicker.isOpen) {
            app.componentPicker.open();
        }
        const searchInput = app.componentPicker.element.querySelector('.cp-search-input');
        if (searchInput) {
            searchInput.focus();
        }
    }

    const svg = app.viewport.svg;
    app._setToolCursor(tool, svg);

    // Manage placement ghost for single-click tools
    _removeToolGhost(app);
    if (tool === 'noconnect') {
        _createNCGhost(app);
    } else if (tool === 'netlabel') {
        _createNetLabelGhost(app);
    }

    app._setActiveToolButton?.(tool);
    app._updateShapePanelOptions(app.selection.getSelection(), tool);
    app._updatePropertiesPanel(app.selection.getSelection());
}

/**
 * Handles the component picker closing — switches back to select tool
 * if the current tool is `'component'`.
 * @param {object} app - Application state.
 */
export function onComponentPickerClosed(app) {
    if (app.currentTool === 'component') {
        app._onToolSelected('select');
    }
}

// ─── Placement ghost helpers ───────────────────────────────────

/**
 * Creates a semi-transparent NoConnect "X" ghost that follows the cursor
 * before the first click, giving visual feedback of what will be placed.
 * @param {object} app - Application state.
 */
function _createNCGhost(app) {
    const ns = 'http://www.w3.org/2000/svg';
    const g = document.createElementNS(ns, 'g');
    g.style.opacity = '0.5';
    g.style.pointerEvents = 'none';

    const color = 'var(--sch-no-connect, #cc0000)';
    const sw = 0.25;
    const l1 = document.createElementNS(ns, 'line');
    l1.setAttribute('x1', -NC_HALF); l1.setAttribute('y1', -NC_HALF);
    l1.setAttribute('x2',  NC_HALF); l1.setAttribute('y2',  NC_HALF);
    l1.setAttribute('stroke', color); l1.setAttribute('stroke-width', sw);
    l1.setAttribute('stroke-linecap', 'round');
    const l2 = document.createElementNS(ns, 'line');
    l2.setAttribute('x1', -NC_HALF); l2.setAttribute('y1',  NC_HALF);
    l2.setAttribute('x2',  NC_HALF); l2.setAttribute('y2', -NC_HALF);
    l2.setAttribute('stroke', color); l2.setAttribute('stroke-width', sw);
    l2.setAttribute('stroke-linecap', 'round');
    g.appendChild(l1);
    g.appendChild(l2);

    app.viewport.contentLayer.appendChild(g);
    app._toolGhost = g;
}

/**
 * Creates a semi-transparent NetLabel ghost (flag + text) that follows
 * the cursor before click placement.
 * @param {object} app - Application state.
 */
function _createNetLabelGhost(app) {
    const ns = 'http://www.w3.org/2000/svg';
    const g = document.createElementNS(ns, 'g');
    g.style.opacity = '0.55';
    g.style.pointerEvents = 'none';

    const net = _nextNetLabelName(app);
    const textW = net.length * NL_FONT_SIZE * 0.6;
    const halfH = NL_FONT_SIZE / 2 + NL_FLAG_PAD_Y;
    const bodyW = textW + NL_FLAG_PAD_X * 2;

    const path = document.createElementNS(ns, 'path');
    path.setAttribute(
        'd',
        `M 0 0 L ${NL_FLAG_TIP} ${-halfH} L ${NL_FLAG_TIP + bodyW} ${-halfH} L ${NL_FLAG_TIP + bodyW} ${halfH} L ${NL_FLAG_TIP} ${halfH} Z`
    );
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'var(--sch-net-label, #00cccc)');
    path.setAttribute('stroke-width', '0.25');
    path.setAttribute('stroke-linejoin', 'miter');

    const text = document.createElementNS(ns, 'text');
    text.setAttribute('x', NL_FLAG_TIP + NL_FLAG_PAD_X);
    text.setAttribute('y', 0);
    text.setAttribute('fill', 'var(--sch-net-label, #00cccc)');
    text.setAttribute('font-size', NL_FONT_SIZE);
    text.setAttribute('font-family', 'Arial');
    text.setAttribute('dominant-baseline', 'middle');
    text.setAttribute('alignment-baseline', 'middle');
    text.setAttribute('text-anchor', 'start');
    text.textContent = net;

    g.appendChild(path);
    g.appendChild(text);
    app.viewport.contentLayer.appendChild(g);
    g.__ghostType = 'netlabel';
    g.__ghostTextEl = text;
    app._toolGhost = g;
}

/**
 * Removes any active tool placement ghost.
 * @param {object} app - Application state.
 */
function _removeToolGhost(app) {
    if (app._toolGhost) {
        app._toolGhost.remove();
        app._toolGhost = null;
    }
}

/**
 * Moves the tool placement ghost to the given world position.
 * @param {object} app - Application state.
 * @param {{x: number, y: number}} pos - Position in world coordinates.
 */
export function updateToolGhost(app, pos) {
    if (app._toolGhost) {
        if (app._toolGhost.__ghostType === 'netlabel' && app._toolGhost.__ghostTextEl) {
            app._toolGhost.__ghostTextEl.textContent = _nextNetLabelName(app);
        }
        app._toolGhost.setAttribute('transform', `translate(${pos.x},${pos.y})`);
    }
}

/**
 * Merges new options into `app.toolOptions` and persists to storage.
 * @param {object} app - Application state.
 * @param {object} options - Tool option overrides to merge.
 */
export function onOptionsChanged(app, options) {
    app.toolOptions = { ...app.toolOptions, ...options };
    saveToolOptions(app.toolOptions);
}
