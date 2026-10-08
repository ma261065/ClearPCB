import { bindRibbonHeight } from '../../shared/ui/ribbon-height.js';
import { renderRibbon } from '../../shared/ui/ribbon.js';
import { createSchematicRibbonDescription } from './ribbon-description.js';
/** @typedef {import('./schematic-editor-api.js').SchematicEditor} SchematicEditor */
/** @typedef {{refresh: () => void, activateTab: (tabId: string) => void, controls: Map<string, HTMLElement>}} RenderedRibbon */
/** @typedef {{activateRibbonTab: ((tabId: string) => void)|null, retainRibbonHeight: (() => void)|null, cleanupRibbonEsc: (() => void)|null, showSaveToast: ((text?: string) => void)|null}} RibbonState */

/** @type {WeakMap<SchematicEditor, RibbonState>} */
const ribbonState = new WeakMap();

/** @param {SchematicEditor} app */
function stateFor(app) {
    let state = ribbonState.get(app);
    if (!state) {
        state = {
            activateRibbonTab: null,
            retainRibbonHeight: null,
            cleanupRibbonEsc: null,
            showSaveToast: null,
        };
        ribbonState.set(app, state);
    }
    return state;
}

/**
 * @param {SchematicEditor} app
 * @param {string} tabId
 */
export function activateRibbonTab(app, tabId) {
    const state = ribbonState.get(app);
    if (state && state.activateRibbonTab) state.activateRibbonTab(tabId);
}

/** @param {SchematicEditor} app */
export function retainRibbonHeight(app) {
    const state = ribbonState.get(app);
    if (state && state.retainRibbonHeight) state.retainRibbonHeight();
}

/** @param {SchematicEditor} app */
export function cleanupRibbonEsc(app) {
    const state = ribbonState.get(app);
    if (state && state.cleanupRibbonEsc) state.cleanupRibbonEsc();
}

/** @param {SchematicEditor} app */
export function showSaveToast(app, text = 'Saved') {
    const state = ribbonState.get(app);
    if (state && state.showSaveToast) state.showSaveToast(text);
}

/**
 * @param {SchematicEditor} app
 * @param {(text?: string) => void} handler
 */
export function setSaveToastHandler(app, handler) {
    stateFor(app).showSaveToast = handler;
}

/**
 * Binds all ribbon tab buttons, tool buttons, file commands, edit commands,
 * and event listeners; sets up the save toast, active tab tracking, and
 * shape panel options.
 * @param {SchematicEditor} app
 */
export function bindRibbon(app) {
    const ribbonEl = document.getElementById('ribbonSchematic');
    if (!ribbonEl) return;

    const ribbon = /** @type {RenderedRibbon} */ (renderRibbon(ribbonEl, createSchematicRibbonDescription(app)));
    const ui = /** @type {typeof app.ui & {propertiesPanel?: HTMLElement}} */ (app.ui);
    ui.propertiesPanel = ribbon.controls.get('propertiesPanel') || ui.propertiesPanel;
    const retainRibbonHeight = bindRibbonHeight(ribbonEl);
    const state = stateFor(app);
    state.retainRibbonHeight = retainRibbonHeight;
    app.refreshRibbon = () => {
        ribbon.refresh();
        retainRibbonHeight();
    };
    state.activateRibbonTab = (/** @type {string} */ tabId) => {
        retainRibbonHeight();
        app.activeRibbonTab = tabId;
        ribbon.activateTab(tabId);
    };

    ribbonEl.addEventListener('change', (e) => {
        if (e.target instanceof HTMLSelectElement) e.target.blur();
    });

    state.showSaveToast = (text = 'Saved') => {
        const anchor = document.getElementById('docTitle');
        if (!anchor) return;
        const rect = anchor.getBoundingClientRect();
        const existing = document.getElementById('ribbon-save-toast');
        if (existing) existing.remove();
        const toast = document.createElement('div');
        toast.id = 'ribbon-save-toast';
        toast.className = 'ribbon-save-toast';
        toast.textContent = text;
        toast.style.left = `${rect.left + rect.width / 2}px`;
        toast.style.top = `${rect.top - 28}px`;
        document.body.appendChild(toast);
        requestAnimationFrame(() => toast.classList.add('show'));
        window.setTimeout(() => {
            toast.classList.remove('show');
            window.setTimeout(() => toast.remove(), 200);
        }, 900);
    };

    const ribbonEscHandler = (/** @type {KeyboardEvent} */ e) => {
        if (e.key === 'Escape') app.setActiveRibbonTab('home');
    };
    document.addEventListener('keydown', ribbonEscHandler);
    state.cleanupRibbonEsc = () => document.removeEventListener('keydown', ribbonEscHandler);

    activateRibbonTab(app, 'home');
    updateRibbonState(app, app.selection.getSelection());

    app.eventBus.on('selectionChanged', (shapes) => {
        updateRibbonState(app, shapes);
        activateRibbonTab(app, shapes.length > 0 ? 'properties' : 'home');
    });

    app.eventBus.on('toolChanged', () => {
        app.updatePropertiesPanel?.(app.selection.getSelection());
        app.refreshRibbon?.();
    });
}

/**
 * Populates or clears the shape-options panel (line width, fill checkbox,
 * font size) based on the active tool when nothing is selected.
 * @param {SchematicEditor} app
 * @param {import('../../core/SchematicDocument.js').SchematicShape[]} selection - Currently selected items.
 * @param {string} [toolIdArg] - Active tool identifier override.
 */
export function updateShapePanelOptions(app, selection, toolIdArg) {
    const container = document.getElementById('ribbonShapeOptions');
    if (!container) return;
    // Drawing defaults are rendered in the Properties tab so Home remains
    // focused on commands and tools rather than object-specific settings.
    container.innerHTML = '';
}

/**
 * Enables/disables ribbon buttons (delete, lock, cut, copy, paste, rotate)
 * based on the current selection count and clipboard state.
 * @param {SchematicEditor} app
 * @param {import('../../core/SchematicDocument.js').SchematicShape[]} selection - Currently selected items.
 */
export function updateRibbonState(app, selection) {
    app.refreshRibbon?.();
}
