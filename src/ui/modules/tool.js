import { updateSnapHighlight } from './wire.js';
import {
    buildNetGroundBarsPath,
    buildNetSymbolPath,
    getNetTextBaseLocal,
    normalizeNetOrientation,
    normalizeNetStyle
} from '../../shapes/net.js';

const STORAGE_KEY = 'clearpcb_tool_options';

/** Half-size of the NoConnect X mark in mm (mirrors noconnect.js NC_HALF). */
const NC_HALF = 0.8;
/** Net ghost text defaults. */
const NL_FONT_SIZE = 1.4;

function _nextnetName(app) {
    const used = new Set();
    for (const shape of app.shapes) {
        if (shape?.type !== 'net' || typeof shape.net !== 'string') continue;
        const m = shape.net.trim().match(/^NET(\d+)$/i);
        if (m) used.add(Number(m[1]));
    }
    let i = 1;
    while (used.has(i)) i += 1;
    return `NET${i}`;
}

function _defaultnetText(app, style) {
    if (style === 'gnd') return 'Gnd';
    if (style === 'arrow') return 'VCC';
    return _nextnetName(app);
}

function _getnetToolOptionState(app) {
    const style = normalizeNetStyle(app.toolOptions?.netStyle || 't');
    const orientation = normalizeNetOrientation(app.toolOptions?.netOrientation || 'N');
    return { style, orientation };
}

function _orientnetLocal(orientation, s, t) {
    switch (orientation) {
        case 'N': return { x: t, y: -s };
        case 'S': return { x: -t, y: s };
        case 'W': return { x: -s, y: -t };
        default: return { x: s, y: t };
    }
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
    app.interactionState = tool === 'select' ? 'idle' : 'toolActive';
    
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

    // Keep Net placement preferences initialized
    if (tool === 'net') {
        const { style, orientation } = _getnetToolOptionState(app);
        app._onOptionsChanged?.({ netStyle: style, netOrientation: orientation });
    }

    // Manage placement ghost for single-click tools
    _removeToolGhost(app);
    if (tool === 'noconnect') {
        _createNCGhost(app);
    } else if (tool === 'net') {
        _createnetGhost(app);
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
    l1.setAttribute('x1', String(-NC_HALF)); l1.setAttribute('y1', String(-NC_HALF));
    l1.setAttribute('x2',  String(NC_HALF)); l1.setAttribute('y2',  String(NC_HALF));
    l1.setAttribute('stroke', color); l1.setAttribute('stroke-width', String(sw));
    l1.setAttribute('stroke-linecap', 'round');
    const l2 = document.createElementNS(ns, 'line');
    l2.setAttribute('x1', String(-NC_HALF)); l2.setAttribute('y1',  String(NC_HALF));
    l2.setAttribute('x2',  String(NC_HALF)); l2.setAttribute('y2', String(-NC_HALF));
    l2.setAttribute('stroke', color); l2.setAttribute('stroke-width', String(sw));
    l2.setAttribute('stroke-linecap', 'round');
    g.appendChild(l1);
    g.appendChild(l2);

    app.viewport.contentLayer.appendChild(g);
    app._toolGhost = g;
}

/**
 * Creates a semi-transparent Net ghost (flag + text) that follows
 * the cursor before click placement.
 * @param {object} app - Application state.
 */
function _createnetGhost(app) {
    const ns = 'http://www.w3.org/2000/svg';
    const g = document.createElementNS(ns, 'g');
    g.style.opacity = '0.55';
    g.style.pointerEvents = 'none';

    const { style, orientation } = _getnetToolOptionState(app);
    const net = _defaultnetText(app, style);
    const textBase = getNetTextBaseLocal(style);

    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', buildNetSymbolPath(style, orientation));
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'var(--sch-net-label, #00cccc)');
    path.setAttribute('stroke-width', '0.25');
    path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('stroke-linecap', 'round');

    const detailPath = document.createElementNS(ns, 'path');
    detailPath.setAttribute('fill', 'none');
    detailPath.setAttribute('stroke', 'var(--sch-net-label, #00cccc)');
    detailPath.setAttribute('stroke-linejoin', 'round');
    detailPath.setAttribute('stroke-linecap', 'round');
    if (style === 'gnd') {
        detailPath.setAttribute('d', buildNetGroundBarsPath(orientation));
        detailPath.setAttribute('stroke-width', '0.08');
    } else {
        detailPath.setAttribute('display', 'none');
    }

    const text = document.createElementNS(ns, 'text');
    const textLocal = _orientnetLocal(orientation, textBase.s, textBase.t);
    text.setAttribute('x', String(textLocal.x));
    text.setAttribute('y', String(textLocal.y));
    text.setAttribute('fill', 'var(--sch-net-label, #00cccc)');
    text.setAttribute('font-size', String(app.toolOptions?.netFontSize || NL_FONT_SIZE));
    text.setAttribute('font-family', 'Arial');
    text.setAttribute('dominant-baseline', 'middle');
    text.setAttribute('alignment-baseline', 'middle');
    text.setAttribute('text-anchor', 'start');
    text.textContent = net;

    g.appendChild(path);
    g.appendChild(detailPath);
    g.appendChild(text);
    g.setAttribute('data-nl-style', style);
    g.setAttribute('data-nl-orientation', orientation);
    app.viewport.contentLayer.appendChild(g);
    /** @type {any} */ (g).__ghostType = 'net';
    /** @type {any} */ (g).__ghostTextEl = text;
    /** @type {any} */ (g).__ghostPathEl = path;
    /** @type {any} */ (g).__ghostDetailPathEl = detailPath;
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
        if (app._toolGhost.__ghostType === 'net' && app._toolGhost.__ghostTextEl) {
            const { style, orientation } = _getnetToolOptionState(app);
            const path = app._toolGhost.__ghostPathEl;
            if (path) {
                path.setAttribute('d', buildNetSymbolPath(style, orientation));
                app._toolGhost.setAttribute('data-nl-style', style);
            }
            const detailPath = app._toolGhost.__ghostDetailPathEl;
            if (detailPath) {
                if (style === 'gnd') {
                    detailPath.setAttribute('d', buildNetGroundBarsPath(orientation));
                    detailPath.setAttribute('stroke-width', '0.08');
                    detailPath.removeAttribute('display');
                } else {
                    detailPath.setAttribute('d', '');
                    detailPath.setAttribute('display', 'none');
                }
            }
            const base = getNetTextBaseLocal(style);
            const textLocal = _orientnetLocal(orientation, base.s, base.t);
            app._toolGhost.__ghostTextEl.setAttribute('x', String(textLocal.x));
            app._toolGhost.__ghostTextEl.setAttribute('y', String(textLocal.y));
            app._toolGhost.__ghostTextEl.setAttribute('font-size', String(app.toolOptions?.netFontSize || NL_FONT_SIZE));
            app._toolGhost.setAttribute('data-nl-orientation', orientation);
            app._toolGhost.__ghostTextEl.textContent = _defaultnetText(app, style);
            app._toolGhost.setAttribute('transform', `translate(${pos.x},${pos.y})`);
            return;
        }
        app._toolGhost.setAttribute('transform', `translate(${pos.x},${pos.y})`);
    }
}

/**
 * Update and persist the default Net style option.
 * @param {object} app
 * @param {string} style
 */
export function setnetStyleOption(app, style) {
    const normalized = normalizeNetStyle(style);
    app._onOptionsChanged?.({ netStyle: normalized });
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
