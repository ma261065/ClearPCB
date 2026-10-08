import { SCHEMATIC_TOOLS, schematicToolTitle } from './schematic-tools.js';
import { hasClipboard } from './clipboard.js';
import { renderRecentFiles } from '../../shared/ui/recents.js';
import { toggleSelectionLock } from './selection.js';
import { rotateComponentRight } from './components.js';
import { beginPastePreview, cutSelection } from './clipboard.js';
import { runSchematicDeleteAction, runSchematicHistoryAction } from './editor-actions.js';
import { getSavedTheme, getThemeIcon } from '../../shared/ui/theme.js';
import { getPaperSize, isPaperSizeKey } from './paper.js';
/** @typedef {import('./schematic-editor-api.js').SchematicEditor} SchematicEditor */
/** @typedef {import('../../shapes/net.js').NetStyle} NetStyle */
/** @typedef {import('../../shapes/net.js').NetOrientation} NetOrientation */
/** @typedef {{value: string|number, label: string, [key: string]: unknown}} GridOption */
/** @typedef {import('../../ui/SchematicApp.js').SchematicToolOptions & {netPresetText?: string|null}} ToolOptions */
/** @typedef {string|number|boolean|null|undefined|RibbonNode|Array<any>|(() => any)} RibbonContent */
/** @typedef {{kind: string, [key: string]: unknown}} RibbonNode */

/** @param {string} tag @param {Record<string, any>} [props] @param {RibbonContent} [children] @returns {RibbonNode} */
const E = (tag, props = {}, children = undefined) => ({ kind: 'element', tag, ...props, children });
/** @param {string} id @param {RibbonContent} content @param {string} title @param {Record<string, any>} [props] @returns {RibbonNode} */
const B = (id, content, title, props = {}) => ({ kind: 'button', id, title, content, ...props });
/** @param {string} tool @param {RibbonContent} content @param {string} title @param {Record<string, any>} [props] @returns {RibbonNode} */
const T = (tool, content, title, props = {}) => ({ kind: 'toolButton', dataset: { tool }, title, content, ...props });
/**
 * A tool's ribbon button: label and tooltip from its entry in schematic-tools.js.
 * @param {SchematicEditor} app
 * @param {string} id
 * @param {any} [content] - a label built from elements, for tools whose entry has none
 */
const toolButton = (app, id, content = SCHEMATIC_TOOLS[id].content) => T(id, content, schematicToolTitle(id),
    { active: () => app.currentTool === id, run: () => app.selectTool(id) });
/** @param {string} text @returns {RibbonNode} */
const K = text => E('kbd', {}, text);
/** @param {RibbonContent[]} children @returns {RibbonNode} */
const H = children => ({ kind: 'helpRow', children: [E('span', {}, children)] });

const PAPER_KEY = 'clearpcb_paper_size';
const ORIENTATION_KEY = 'clearpcb_paper_orientation';
const TITLE_BLOCK_KEY = 'clearpcb_title_block';
const TITLE_BLOCK_INFO_KEY = 'clearpcb_title_block_info';

const DRAWING_TOOL_IDS = new Set(['wire', 'line', 'rect', 'circle', 'arc', 'polygon']);

/**
 * @param {string|null|undefined} style
 * @returns {NetStyle}
 */
function normalizenetStyle(style) {
    return style === 'gnd' || style === 'arrow' || style === 'chevron' ? style : 't';
}

const NET_STYLE_META = {
    t: { icon: '⊤', title: 'T' },
    gnd: { icon: '⏚', title: 'GND' },
    arrow: { icon: '↑', title: 'Arrow' },
    chevron: { icon: '«', title: 'Chevron' },
};

const DEFAULT_ORIENTATION_BY_STYLE = {
    t: 'N',
    gnd: 'S',
    arrow: 'N',
    chevron: 'E',
};

/** @param {SchematicEditor} app */
function gridOptions(app) {
    return /** @type {GridOption[]} */ (app.viewport?.getGridOptions?.() || [{ value: 1, label: '1 mm' }]);
}

/** @param {SchematicEditor} app */
function nearestGridValue(app) {
    const options = gridOptions(app).filter(option => typeof option.value === 'number' && Number.isFinite(option.value));
    const current = app.viewport?.gridSize ?? Number(options[0]?.value || 1);
    let best = options[0];
    let bestDiff = Infinity;
    for (const option of options) {
        const diff = Math.abs(/** @type {number} */ (option.value) - current);
        if (diff < bestDiff) {
            best = option;
            bestDiff = diff;
        }
    }
    if (best && best.value !== current) app.viewport?.setGridSize?.(/** @type {number} */ (best.value));
    return String(best?.value ?? current);
}

/** @param {SchematicEditor} app @param {string|null|undefined} key @param {string} orientation */
function applyPaperDisplay(app, key, orientation) {
    const paperSize = getPaperSize(key || '');
    if (!key || !paperSize) {
        app.viewport.setPaperSize(null, null);
        return;
    }
    const size = { ...paperSize };
    if (orientation === 'portrait') {
        if (size.width > size.height) [size.width, size.height] = [size.height, size.width];
    } else if (size.width < size.height) [size.width, size.height] = [size.height, size.width];
    app.viewport.setPaperSize(size, key);
}

/** @param {string} key */
function storageGet(key) {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
}

/** @param {string} key @param {string} value */
function storageSet(key, value) {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
}

/** @param {string} key */
function storageRemove(key) {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(key);
}

/** @param {SchematicEditor} app */
function restorePaperState(app) {
    const orientation = storageGet(ORIENTATION_KEY) || 'landscape';
    const key = storageGet(PAPER_KEY) || '';
    app.viewport.setTitleBlock?.(storageGet(TITLE_BLOCK_KEY) === 'true');
    app.viewport.setTitleBlockInfo?.(storageGet(TITLE_BLOCK_INFO_KEY) === 'true');
    if (isPaperSizeKey(key)) applyPaperDisplay(app, key, orientation);
}

/** @param {SchematicEditor} app */
function paperKey(app) {
    return app.viewport?.paperSizeKey || storageGet(PAPER_KEY) || '';
}

function paperOrientation() {
    return storageGet(ORIENTATION_KEY) || 'landscape';
}

/** @param {SchematicEditor} app */
function hasPaper(app) {
    const key = paperKey(app);
    return isPaperSizeKey(key);
}

/** @param {SchematicEditor} app */
function markDirty(app) {
    app.fileManager?.setDirty?.(true);
}

const labelIcon = [
    E('svg', { className: 'ribbon-label-icon', attrs: { width: 11, height: 8, viewBox: '0 0 11 9' } }, [
        E('path', { attrs: { d: 'M0.5 1.5 Q0.5 0.5 1.5 0.5 H6.5 L10.5 4 L6.5 7.5 H1.5 Q0.5 7.5 0.5 6.5 Z', fill: 'none', stroke: 'currentColor', 'stroke-width': 1 } }),
        E('circle', { attrs: { cx: 3, cy: 4, r: 0.8, fill: 'currentColor' } }),
    ]),
    'Label',
];

const netMenuItems = [
    { kind: 'button', className: 'dropdown-item', type: 'button', dataset: { netStyle: 'arrow', netText: 'VCC' }, content: '↑ VCC' },
    { kind: 'button', className: 'dropdown-item', type: 'button', dataset: { netStyle: 'arrow', netText: '3.3V' }, content: '↑ 3.3V' },
    { kind: 'button', className: 'dropdown-item', type: 'button', dataset: { netStyle: 'arrow', netText: '5V' }, content: '↑ 5V' },
    { kind: 'button', className: 'dropdown-item', type: 'button', dataset: { netStyle: 'arrow', netText: '12V' }, content: '↑ 12V' },
    { kind: 'button', className: 'dropdown-item', type: 'button', dataset: { netStyle: 'gnd' }, content: '⏚ GND' },
    { kind: 'button', className: 'dropdown-item', type: 'button', dataset: { netStyle: 't' }, content: '⊤ T' },
    { kind: 'button', className: 'dropdown-item', type: 'button', dataset: { netStyle: 'arrow' }, content: '↑ Arrow' },
    { kind: 'button', className: 'dropdown-item', type: 'button', dataset: { netStyle: 'chevron' }, content: '« Chevron' },
];

/** @param {SchematicEditor} app */
export function createSchematicRibbonDescription(app) {
    if (app?.viewport) restorePaperState(app);
    return {
        /** @param {{from: string, to: string, userInitiated: boolean}} event */
        onBeforeTabChange({ from, to, userInitiated }) {
            if (userInitiated && from !== to && DRAWING_TOOL_IDS.has(app.currentTool)) {
                if (app.currentTool === 'wire') app.cancelWireDrawing();
                app.selectTool('select');
            }
        },
        /** @param {{to: string}} event */
        onTabChange({ to }) {
            if (to === 'home') app.refreshRibbon?.();
        },
        tabs: [
            { id: 'file', label: 'File', active: true },
            { id: 'home', label: 'Home' },
            { id: 'properties', label: 'Properties' },
            { id: 'help', label: 'Help' },
        ],
        panels: [
            {
                id: 'file',
                panel: 'file',
                active: true,
                groups: [
                    {
                        title: 'File',
                        items: [
                            B('ribbonNew', '📄 New', 'New (Ctrl+N)', { run: () => app.newFile() }),
                            {
                                kind: 'splitDropdown',
                                id: 'ribbonOpenDropdown',
                                main: { id: 'ribbonOpen', title: 'Open (Ctrl+O)', content: '📂 Open', run: () => app.openFile() },
                                arrow: { id: 'ribbonOpenRecent', title: 'Recent files', attrs: { 'aria-haspopup': 'true', 'aria-label': 'Recent files' }, content: '▾' },
                                menuId: 'ribbonRecentMenu',
                                /** @param {{menu: HTMLElement}} event */
                                onOpen: (event) => void renderRecentFiles({
                                    container: event.menu,
                                    getFileManager: () => app.fileManager,
                                    openRecent: name => app.openRecentFile(name),
                                }),
                            },
                            {
                                kind: 'dropdown',
                                id: 'ribbonImportDropdown',
                                button: { id: 'ribbonImport', title: 'Import from other formats', content: '📥 Import ▾' },
                                menuId: 'ribbonImportMenu',
                                items: [{ kind: 'button', className: 'dropdown-item', dataset: { format: 'easyeda-sch' }, content: 'EasyEDA Schematic (.json)', run: () => app.importEasyEDA() }],
                            },
                            B('ribbonSave', '💾 Save', 'Save (Ctrl+S)', { run: async () => { if ((await app.saveFile())?.success) app.showSaveToast('Saved'); } }),
                            B('ribbonSaveAs', '💾 Save As', 'Save As (Ctrl+Alt+S)', { run: async () => { if ((await app.saveFileAs())?.success) app.showSaveToast('Saved'); } }),
                            B('ribbonExportPdf', '🧾 Export PDF', 'Export PDF (Ctrl+Shift+P)', { run: () => app.savePdf() }),
                            B('ribbonPrint', '🖨️ Print', 'Print (Ctrl+P)', { run: () => app.print() }),
                            { kind: 'button', attrs: { 'data-mcp-session': true }, title: 'Connect an AI through MCP', content: '🔌 AI Mode' },
                        ],
                    },
                    {
                        title: 'Debug',
                        items: [
                            B('ribbonClearComponentCache', '🧹 Clear Cache', 'Clear component caches', { className: 'ribbon-danger', run: () => app.clearComponentCaches() }),
                            { kind: 'checkbox', id: 'ribbonToggleComponentTooltip', label: 'Component tooltip',
                                checked: () => app.showComponentDebugTooltip !== false,
                                onChange: /** @param {boolean} checked */ (checked) => {
                                    app.showComponentDebugTooltip = checked;
                                    if (!checked) app.updateComponentCodeTooltip(null, null, { forceHide: true });
                                } },
                        ],
                    },
                ],
            },
            {
                id: 'home',
                panel: 'home',
                groups: [
                    {
                        title: 'Tools',
                        itemsClassName: 'ribbon-shape-body',
                        items: [
                            E('div', { className: 'ribbon-group-items ribbon-shape-tools' }, [
                                ...['select', 'wire', 'rect', 'circle', 'arc', 'line', 'polygon'].map(id => toolButton(app, id)),
                                toolButton(app, 'text', labelIcon),
                                {
                                    kind: 'splitDropdown',
                                    id: 'ribbonNetDropdown',
                                    className: 'dropdown ribbon-net-dropdown ribbon-split-btn',
                                    active: () => app.currentTool === 'net',
                                    main: { id: 'ribbonNetTool', className: 'ribbon-tool-btn ribbon-split-main', dataset: { tool: 'net' },
                                        title: () => {
                                            const toolOptions = /** @type {ToolOptions} */ (app.toolOptions || {});
                                            const meta = NET_STYLE_META[normalizenetStyle(toolOptions.netStyle || 't')] || NET_STYLE_META.t;
                                            return `${SCHEMATIC_TOOLS.net.name} (${meta.title}) (${(SCHEMATIC_TOOLS.net.key || '').toUpperCase()})`;
                                        },
                                        content: () => {
                                            const toolOptions = /** @type {ToolOptions} */ (app.toolOptions || {});
                                            const meta = NET_STYLE_META[normalizenetStyle(toolOptions.netStyle || 't')] || NET_STYLE_META.t;
                                            return [E('span', { className: 'ribbon-net-icon', attrs: { 'aria-hidden': 'true' } }, meta.icon), ' Net'];
                                        },
                                        run: () => app.selectTool('net') },
                                    arrow: { id: 'ribbonNetStyleBtn', className: 'ribbon-tool-btn ribbon-split-arrow', title: 'Net style', content: '▼' },
                                    menuId: 'ribbonNetStyleMenu',
                                    menuAttrs: { 'aria-label': 'Net style' },
                                    items: netMenuItems.map(item => ({
                                        ...item,
                                        active: () => {
                                            const toolOptions = /** @type {ToolOptions} */ (app.toolOptions || {});
                                            return item.dataset.netStyle === normalizenetStyle(toolOptions.netStyle || 't')
                                                && (item.dataset.netText || null) === (toolOptions.netPresetText || null);
                                        },
                                        run: () => {
                                            const style = normalizenetStyle(item.dataset.netStyle || 't');
                                            app.updateToolOptions({ netStyle: style, netOrientation: DEFAULT_ORIENTATION_BY_STYLE[style] || 'E' });
                                            /** @type {ToolOptions} */ (app.toolOptions).netPresetText = item.dataset.netText || null;
                                            app.selectTool('net');
                                        },
                                    })),
                                },
                                toolButton(app, 'noconnect'),
                                toolButton(app, 'component'),
                            ]),
                            { kind: 'slot', id: 'ribbonShapeOptions', className: 'ribbon-shape-options' },
                        ],
                    },
                    {
                        title: 'History',
                        items: [
                            B('undoBtn', '↶', 'Undo (Ctrl+Z)', { disabled: () => !app.history?.canUndo?.(), run: () => runSchematicHistoryAction(app, 'undo') }),
                            B('redoBtn', '↷', 'Redo (Ctrl+Y)', { disabled: () => !app.history?.canRedo?.(), run: () => runSchematicHistoryAction(app, 'redo') }),
                        ],
                    },
                    {
                        title: 'Clipboard',
                        items: [
                            B('ribbonCut', '✂ Cut', 'Cut (Ctrl+X)', { disabled: () => app.selection?.getSelection?.().length === 0, run: () => cutSelection(app) }),
                            B('ribbonCopy', '⧉ Copy', 'Copy (Ctrl+C)', { disabled: () => app.selection?.getSelection?.().length === 0, run: () => app.copySelection() }),
                            B('ribbonPaste', '📋 Paste', 'Paste (Ctrl+V)', { disabled: () => !hasClipboard(), run: () => beginPastePreview(app) }),
                        ],
                    },
                    {
                        title: 'Paper',
                        items: [
                            {
                                kind: 'select',
                                id: 'paperSize',
                                title: 'Paper size',
                                value: () => paperKey(app),
                                onChange: /** @param {string} value */ (value) => {
                                    if (!isPaperSizeKey(value)) {
                                        app.viewport.setPaperSize(null, null);
                                        storageRemove(PAPER_KEY);
                                    } else {
                                        applyPaperDisplay(app, value, paperOrientation());
                                        storageSet(PAPER_KEY, value);
                                    }
                                },
                                options: [
                                    { value: '', label: 'None' },
                                    { label: 'Metric', options: [
                                        { value: 'A4', label: 'A4 (210 × 297 mm)' },
                                        { value: 'A3', label: 'A3 (297 × 420 mm)' },
                                        { value: 'A2', label: 'A2 (420 × 594 mm)' },
                                        { value: 'A1', label: 'A1 (594 × 841 mm)' },
                                        { value: 'A0', label: 'A0 (841 × 1189 mm)' },
                                    ] },
                                    { label: 'Imperial', options: [
                                        { value: 'Letter', label: 'Letter (8.5 × 11 inch)' },
                                        { value: 'Legal', label: 'Legal (8.5 × 14 inch)' },
                                        { value: 'Tabloid', label: 'Tabloid (11 × 17 inch)' },
                                    ] },
                                ],
                            },
                            { kind: 'select', id: 'paperOrientation', title: 'Paper orientation', value: () => paperOrientation(), disabled: () => !hasPaper(app),
                                onChange: /** @param {string} value */ (value) => { storageSet(ORIENTATION_KEY, value); if (hasPaper(app)) applyPaperDisplay(app, paperKey(app), value); },
                                options: [{ value: 'landscape', label: 'Landscape', selected: true }, { value: 'portrait', label: 'Portrait' }] },
                            { kind: 'checkbox', id: 'showTitleBlock', label: 'Border', checked: () => !!app.viewport?.showTitleBlock, disabled: () => !hasPaper(app),
                                onChange: /** @param {boolean} checked */ (checked) => { app.viewport.setTitleBlock(checked); storageSet(TITLE_BLOCK_KEY, String(checked)); } },
                            { kind: 'checkbox', id: 'showTitleBlockInfo', label: 'Title Block', checked: () => !!app.viewport?.showTitleBlockInfo, disabled: () => !hasPaper(app),
                                onChange: /** @param {boolean} checked */ (checked) => { app.viewport.setTitleBlockInfo(checked); storageSet(TITLE_BLOCK_INFO_KEY, String(checked)); } },
                        ],
                    },
                    {
                        title: 'Grid',
                        items: [
                            { kind: 'checkbox', id: 'showGrid', label: 'Grid', checked: () => !!app.viewport?.gridVisible,
                                onChange: /** @param {boolean} checked */ (checked) => { app.viewport.setGridVisible(checked); if (!checked) app.viewport.snapToGrid = false; markDirty(app); } },
                            { kind: 'checkbox', id: 'snapToGrid', label: 'Snap', checked: () => !!app.viewport?.snapToGrid && !!app.viewport?.gridVisible,
                                disabled: () => !app.viewport?.gridVisible, onChange: /** @param {boolean} checked */ (checked) => { if (app.viewport.gridVisible) app.viewport.snapToGrid = checked; markDirty(app); } },
                            { kind: 'select', id: 'gridSize', title: 'Grid size', options: () => gridOptions(app),
                                value: () => nearestGridValue(app), onChange: /** @param {string} value */ (value) => { app.viewport.setGridSize(parseFloat(value)); markDirty(app); } },
                            { kind: 'select', id: 'units', title: 'Units', value: () => app.viewport?.units || 'mm',
                                onChange: /** @param {string} value */ (value) => { app.viewport.setUnits(/** @type {import('../../core/Viewport.js').ViewportUnit} */ (value)); nearestGridValue(app); markDirty(app); },
                                options: [{ value: 'mm', label: 'mm', selected: true }, { value: 'inch', label: 'inch' }] },
                            { kind: 'select', id: 'gridStyle', title: 'Grid style', value: () => app.viewport?.gridStyle || 'lines',
                                onChange: /** @param {string} value */ (value) => { app.viewport.setGridStyle(/** @type {'lines'|'dots'} */ (value)); markDirty(app); },
                                options: [{ value: 'lines', label: 'Lines', selected: true }, { value: 'dots', label: 'Dots' }] },
                        ],
                    },
                    {
                        title: 'View',
                        items: [
                            B('zoomOut', '−', 'Zoom Out', { run: () => app.viewport.zoomOut() }),
                            B('zoomIn', '+', 'Zoom In', { run: () => app.viewport.zoomIn() }),
                            B('zoomFit', 'Fit', 'Fit to Content', { run: () => app.fitToContent() }),
                            B('resetView', 'Default', 'Default View (Home)', { run: () => app.viewport.resetView() }),
                            B('themeToggle', () => getThemeIcon(getSavedTheme()), 'Toggle Dark/Light Mode', { className: 'theme-toggle', run: () => app.toggleTheme() }),
                        ],
                    },
                ],
            },
            { id: 'propertiesPanel', panel: 'properties' },
            {
                id: 'help',
                panel: 'help',
                groups: [
                    {
                        title: 'Keyboard Shortcuts',
                        className: 'ribbon-help',
                        itemsClassName: 'ribbon-group-items ribbon-help-items',
                        items: [
                            H([K('Ctrl+N'), ' New file']),
                            H([K('Ctrl+O'), ' Open file']),
                            H([K('Ctrl+S'), ' Save']),
                            H([K('Ctrl+Alt+S'), ' Save As']),
                            H([K('Ctrl+Shift+P'), ' Save PDF']),
                            H([K('Ctrl+Z'), ' Undo']),
                            H([K('Ctrl+Y'), ' Redo']),
                            H([K('V'), ' Select']),
                            H([K('I'), ' Line']),
                            H([K('W'), ' Wire']),
                            H([K('R'), ' Rectangle']),
                            H([K('C'), ' Circle']),
                            H([K('A'), ' Arc']),
                            H([K('P'), ' Polygon']),
                            H([K('L'), ' Label']),
                            H([K('N'), ' Net']),
                            H([K('O'), ' Component']),
                            H([K('X'), ' No Connect']),
                            H([K('Space'), ' Rotate component']),
                            H([K('Space'), ' Fit (nothing selected)']),
                            H([K('X'), ' Flip H (component)']),
                            H([K('Y'), ' Flip V (component)']),
                            H([K('Home'), ' Default view']),
                            H([K('Esc'), ' Cancel / Select mode']),
                            H([K('Del'), ' Delete selected']),
                            H([K('Ctrl+A'), ' Select all']),
                            H([K('Arrow keys'), ' Move selected: 1/4 grid step (1 mm with snap off)']),
                            H([K('Drag shape'), ' Move']),
                            H([K('Drag anchor'), ' Resize/Edit']),
                            H([K('Drag empty'), ' Box select']),
                            H([K('Ctrl+Click'), ' Multi-selection']),
                            H([K('Shift+Click'), ' Cycle overlapping objects']),
                            H([K('Ctrl+Shift+Click'), ' Cycle and keep other selections']),
                            H([K('Shift+Drag'), ' Relax grid snap']),
                            H([K('Right-drag'), ' Pan']),
                            H([K('Scroll'), ' Zoom']),
                            H([K('+'), ' / ', K('−'), ' Zoom in / out']),
                            { kind: 'helpRow', children: [E('a', { attrs: { href: 'https://github.com/ma261065/ClearPCB', target: '_blank', rel: 'noopener' } }, 'ClearPCB on GitHub')] },
                            { kind: 'helpRow', children: [E('a', { attrs: { href: 'mailto:clearpcbdesign@gmail.com' } }, 'clearpcbdesign@gmail.com')] },
                            { kind: 'helpRow', children: [E('span', { id: 'version-display', className: 'help-version' })] },
                        ],
                    },
                ],
            },
        ],
    };
}
