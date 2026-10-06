import { updateSnapHighlight } from './wire.js';
import { ShapeValidator } from '../../core/ShapeValidator.js';
import { cancelSchematicInteractions } from './schematic-interaction-routing.js';
import { normalizeNetOrientation, normalizeNetStyle } from '../../shapes/net.js';
import {
    createNetToolGhost,
    createNoConnectToolGhost,
    getToolGhost,
    removeToolGhost,
} from './tool-ghost.js';
export { getToolGhost } from './tool-ghost.js';
export { updateToolGhost } from './tool-ghost.js';

const STORAGE_KEY = 'clearpcb_tool_options';

function _getnetToolOptionState(app) {
    const style = normalizeNetStyle(app.toolOptions?.netStyle || 't');
    const orientation = normalizeNetOrientation(app.toolOptions?.netOrientation || 'N');
    return { style, orientation };
}

/**
 * Reads persisted tool options (line width, fill, font size) from localStorage.
 * @returns {object|null} Parsed options object, or `null` if none stored.
 */
export function loadToolOptions() {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
            return _sanitizeToolOptions(JSON.parse(stored));
        }
    } catch (e) {
        console.warn('Failed to load tool options:', e);
    }
    return null;
}

/**
 * Validate/clamp persisted tool options so untrusted localStorage data can't
 * inject markup (colors flow into preview SVG) or break rendering with
 * out-of-range numbers.
 * @param {*} opts
 * @returns {object|null}
 */
function _sanitizeToolOptions(opts) {
    if (!opts || typeof opts !== 'object') return null;
    const clampNum = (v, min, max, dflt) =>
        (Number.isFinite(v) && v >= min && v <= max) ? v : dflt;
    const out = { ...opts };
    if ('color' in out) out.color = ShapeValidator.validateColor(out.color, { default: 'var(--sch-symbol-outline, #ffffff)' });
    if ('textColor' in out) out.textColor = ShapeValidator.validateColor(out.textColor, { default: 'var(--sch-text-label, #00b894)' });
    out.lineWidth = clampNum(out.lineWidth, 0.01, 100, 0.25);
    if ('fontSize' in out) out.fontSize = clampNum(out.fontSize, 0.1, 1000, 2.0);
    if ('netFontSize' in out) out.netFontSize = clampNum(out.netFontSize, 0.1, 1000, 1.4);
    out.fill = !!out.fill;
    return out;
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
    // Every in-progress interaction except inline text (it ends on blur) and a
    // component placement, which the Component tool keeps; other tools cancel the
    // placement below, once the new tool is current.
    cancelSchematicInteractions(app, ['textEdit', 'placingComponent']);
    app.cancelDrawing();
    
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
        app.cancelComponentPlacement();
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
        // Don't show placement guides until the user clicks Place Component.
        app.hideCrosshair();
    }

    const svg = app.viewport.svg;
    app.setToolCursor(tool, svg);

    // Keep Net placement preferences initialized
    if (tool === 'net') {
        const { style, orientation } = _getnetToolOptionState(app);
        app.updateToolOptions?.({ netStyle: style, netOrientation: orientation });
    }

    // Manage placement ghost for single-click tools
    removeToolGhost(app);
    if (tool === 'noconnect') {
        createNoConnectToolGhost(app);
    } else if (tool === 'net') {
        createNetToolGhost(app);
    }

    app.refreshRibbon?.();
    app.updateShapePanelOptions(app.selection.getSelection(), tool);
    app.updatePropertiesPanel(app.selection.getSelection());
    if (tool === 'wire' || tool === 'noconnect' || tool === 'line' || tool === 'rect' || tool === 'circle' || tool === 'arc' || tool === 'polygon' || tool === 'text' || tool === 'net') {
        app.setActiveRibbonTab?.('properties');
    } else if (tool === 'select' && app.selection.getSelection().length === 0) {
        app.setActiveRibbonTab?.('home');
    }
}

/**
 * Handles the component picker closing — switches back to select tool
 * if the current tool is `'component'`.
 * @param {object} app - Application state.
 */
export function onComponentPickerClosed(app) {
    if (app.currentTool === 'component') {
        app.selectTool('select');
    }
}

/**
 * Update and persist the default Net style option.
 * @param {object} app
 * @param {string} style
 */
export function setnetStyleOption(app, style) {
    const normalized = normalizeNetStyle(style);
    app.updateToolOptions?.({ netStyle: normalized });
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
