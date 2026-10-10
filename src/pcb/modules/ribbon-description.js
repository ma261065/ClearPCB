import { syncGridSettings } from '../../shared/ui/viewport.js';
import { renderRecentFiles } from '../../shared/ui/recents.js';
import { getSavedTheme, getThemeIcon, toggleTheme as toggleSharedTheme } from '../../shared/ui/theme.js';
import { showPictureImport } from './picture-import.js';
import { runPcbHistoryAction, savePcbProject } from './editor-actions.js';
import { commitDesignInput } from './design-settings.js';
import { PCB_DESIGN_MAX_MM } from '../../core/PcbDesignSettings.js';
import { pcbToolBlock, preparePcbRibbonTransition, selectPcbTool } from './tool-lifecycle.js';
import { PCB_SHAPE_TOOLS as SHAPE_TOOLS, PCB_TOOLS, PCB_TOOL_PRESETS, normalizePcbTool } from './pcb-tools.js';
import { placementBlockMessage } from './layers.js';
import { peekDrcPresentation } from './drc-state.js';
import { clearRoutes, loadTestBoard, runAutoRoute } from './autorouter-actions.js';
import { exportBOM, exportDSN, exportGerber, exportPickAndPlace, importSES, openPanelize } from './fabrication-actions.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */
/** @typedef {Record<string, any>} RibbonNode Ribbon description nodes are declarative UI records with heterogeneous child/content shapes. */

/** @param {string} tag @param {RibbonNode} [props] @param {any} [children] Dynamic ribbon content accepts strings, nodes, and arrays. */
const E = (tag, props = {}, children = undefined) => ({ kind: 'element', tag, ...props, children });
/** @param {string} id @param {any} content Dynamic ribbon content accepts strings, nodes, and arrays. @param {string|undefined} title @param {RibbonNode} [props] */
const B = (id, content, title, props = {}) => ({ kind: 'button', id, title, content, ...props });
/** @param {string} text */
const K = text => E('kbd', {}, text);
/** @param {any} children Dynamic ribbon content accepts strings, nodes, and arrays. */
const H = children => ({ kind: 'helpRow', children: [E('span', {}, children)] });

const MINIMUM_MM = { trackWidth: 0.05, clearance: 0.05, viaDiameter: 0.1, viaDrill: 0.05 };
/** @typedef {keyof typeof MINIMUM_MM} RoutingDesignKey */

/** @param {PcbEditor} app */
function designFactor(app) {
    return app.designSettings.values.units === 'inch' ? 1 / 25.4 : 1;
}

/** @param {PcbEditor} app */
function designDigits(app) {
    return app.designSettings.values.units === 'inch' ? 4 : 3;
}

/** @param {PcbEditor} app @param {RoutingDesignKey} key */
function designDisplay(app, key) {
    return String(Number((app.designSettings.values[key] * designFactor(app)).toFixed(designDigits(app))));
}

/** @param {PcbEditor} app */
function gridOptions(app) {
    return app.viewport?.getGridOptions?.() || [{ value: 1.27, label: '1.27 mm' }];
}

/** @param {PcbEditor} app */
function nearestGridValue(app) {
    const options = gridOptions(app).filter(option => Number.isFinite(option.value));
    const current = app.viewport?.gridSize ?? Number(options[0]?.value || 1.27);
    let best = options[0];
    let bestDiff = Infinity;
    for (const option of options) {
        const diff = Math.abs(option.value - current);
        if (diff < bestDiff) {
            best = option;
            bestDiff = diff;
        }
    }
    if (best && best.value !== current) app.viewport?.setGridSize?.(best.value);
    return String(best?.value ?? current);
}

/** @param {PcbEditor} app */
function ensureViewport(app) {
    app.ensureViewport();
    return app.viewport;
}

/** @param {PcbEditor} app */
function boardView(app) {
    return app.currentBoardView() || null;
}

/** @param {PcbEditor} app */
function saveDesignDefaults(app) {
    try {
        localStorage.setItem('clearpcb_pcb_design_params', JSON.stringify(app.designSettings.values));
    } catch (error) {
        console.warn('Could not save PCB design defaults:', error);
    }
}

/** @param {string} label @param {RibbonNode} control */
const routingRow = (label, control) => E('div', { className: 'routing-param-row' }, [
    E('label', { attrs: { for: control.id } }, label),
    control,
]);

/** @param {Event} _e @param {{closeMenus: () => void}} api */
const closeSpecctraHelp = (_e, api) => api.closeMenus();

const specctraFlyout = {
    kind: 'dropdown',
    id: 'specctraHelpFlyoutWrap',
    className: 'specctra-help-flyout-wrap',
    button: { id: 'pcbSpecctraHelp', className: 'specctra-help-btn', title: 'How to use external routing', content: 'ⓘ' },
    menuId: 'specctraHelpFlyout',
    menuClassName: 'specctra-help-flyout',
    items: [
        E('div', { className: 'specctra-help-flyout-header' }, [
            E('span', {}, 'External Routing with Freerouting'),
            B('specctraHelpClose', '×', undefined, { className: 'specctra-help-flyout-close', run: closeSpecctraHelp }),
        ]),
        E('div', { className: 'specctra-help-flyout-body' }, [
            E('p', {}, [
                E('strong', {}, 'Specctra DSN/SES'),
                ' lets you use a powerful external autorouter like ',
                E('a', { attrs: { href: 'https://github.com/freerouting/freerouting', target: '_blank', rel: 'noopener' } }, 'Freerouting'),
                ' to route your board.',
            ]),
            E('ol', {}, [
                E('li', {}, [E('strong', {}, 'Export DSN'), ' — Click ', E('em', {}, 'Export DSN'), ' to save your board as a Specctra Design file.']),
                E('li', {}, [E('strong', {}, 'Open in Freerouting'), ' — Launch ', E('a', { attrs: { href: 'https://github.com/freerouting/freerouting/releases', target: '_blank', rel: 'noopener' } }, 'Freerouting'), ' and open the ', E('code', {}, '.dsn'), ' file.']),
                E('li', {}, [E('strong', {}, 'Route'), ' — Click the Autorouter button in Freerouting and wait for it to finish.']),
                E('li', {}, [E('strong', {}, 'Export Session'), ' — In Freerouting, go to ', E('em', {}, 'File → Export Specctra Session File'), ' to save a ', E('code', {}, '.ses'), ' file.']),
                E('li', {}, [E('strong', {}, 'Import SES'), ' — Back in ClearPCB, click ', E('em', {}, 'Import SES'), ' and select the ', E('code', {}, '.ses'), ' file. Tracks and vias will appear on your board.']),
            ]),
            E('p', { className: 'specctra-help-tip' }, '💡 Freerouting often produces higher-quality results than the built-in router for complex boards.'),
        ]),
    ],
};

const shapeItems = [...SHAPE_TOOLS].map(shape => ({
    kind: 'button', className: 'ribbon-tool-menu-item', dataset: { shape },
    title: PCB_TOOLS[shape].button.title, content: PCB_TOOLS[shape].button.content,
}));

/** @param {PcbEditor} app */
export function createPcbRibbonDescription(app) {
    let lastShape = 'circle';
    /** @type {Array<[string, string, RoutingDesignKey, string]>} */
    const routingControls = [
        ['Track Width', 'pcbTrackWidth', 'trackWidth', '0.01'],
        ['Clearance', 'pcbClearance', 'clearance', '0.01'],
        ['Via Dia', 'pcbViaDiameter', 'viaDiameter', '0.05'],
        ['Via Drill', 'pcbViaDrill', 'viaDrill', '0.05'],
    ];
    /** @param {string} tool */
    const setTool = tool => selectPcbTool(app, tool);
    const project = () => app.project;
    const canCopyCut = () => app.canCopyCutPcbSelection() || false;
    const canPaste = () => app.hasPcbClipboardData() || false;
    // A placement tool's button carries a lock or hidden badge while its layer is blocked.
    /** @param {string} tool */
    const blockBadge = tool => ({
        'tool-layer-locked': () => pcbToolBlock(app, tool)?.reason === 'locked',
        'tool-layer-hidden': () => pcbToolBlock(app, tool)?.reason === 'hidden',
    });
    /** @param {string} title @param {string} tool */
    const blockTitle = (title, tool) => () => {
        const block = pcbToolBlock(app, tool);
        return block ? `${title} (${placementBlockMessage(block)})` : title;
    };
    const shapeTool = () => (SHAPE_TOOLS.has(normalizePcbTool(app.currentTool)) ? normalizePcbTool(app.currentTool) : lastShape);
    // A tool's ribbon button, from its entry in pcb-tools.js; placement tools carry block badges.
    /** @param {string} id */
    const toolButton = id => {
        const { button, targets } = /** @type {import('./pcb-tools.js').PcbTool} */ (PCB_TOOLS[id]);
        return {
            kind: 'toolButton', id: button.id, content: button.content,
            title: targets ? blockTitle(button.title, id) : button.title, ...(targets ? { classes: blockBadge(id) } : {}),
            active: () => normalizePcbTool(app.currentTool) === id, run: () => setTool(id),
        };
    };
    /** @param {string} id */
    const presetButton = id => {
        const { button, tool, layer } = /** @type {{button: import('./pcb-tools.js').PcbToolButton, tool: string, layer: string}} */ (PCB_TOOL_PRESETS[id]);
        return {
            kind: 'toolButton', id: button.id, content: button.content, title: blockTitle(button.title, id),
            classes: blockBadge(id), run: () => { app.activeLayer = layer; setTool(tool); },
        };
    };
    /** @param {boolean} checked */
    const onShowGridChange = checked => { const vp = ensureViewport(app); if (!vp) return; vp.setGridVisible(checked); if (!checked) vp.snapToGrid = false; syncGridSettings(app); app.markDirty(); };
    /** @param {boolean} checked */
    const onSnapToGridChange = checked => { const vp = ensureViewport(app); if (!vp?.gridVisible) return; vp.snapToGrid = checked; syncGridSettings(app); app.markDirty(); };
    /** @param {string} value */
    const onGridSizeChange = value => { const vp = ensureViewport(app); if (!vp) return; vp.setGridSize(parseFloat(value)); syncGridSettings(app); app.markDirty(); };
    /** @param {string} value */
    const onViewportUnitsChange = value => { const vp = ensureViewport(app); if (!vp) return; vp.setUnits(/** @type {import('../../core/Viewport.js').ViewportUnit} */ (value)); nearestGridValue(app); syncGridSettings(app); app.markDirty(); };
    /** @param {string} value */
    const onGridStyleChange = value => { const vp = ensureViewport(app); if (!vp) return; vp.setGridStyle(/** @type {'lines'|'dots'} */ (value)); syncGridSettings(app); app.markDirty(); };
    return {
        /** @param {{from: string, to: string, userInitiated: boolean}} event */
        onBeforeTabChange(event) {
            const { from, to, userInitiated } = event;
            preparePcbRibbonTransition(app, from, to, userInitiated);
        },
        /** @param {{to: string}} event */
        onTabChange(event) {
            const { to } = event;
            app.syncClipboardButtons();
            if (to === 'pcb-home') app.refreshPcbRibbon?.();
            peekDrcPresentation(app)?.setDesignActive(to === 'pcb-design');
        },
        tabs: [
            { id: 'pcb-file', label: 'File' },
            { id: 'pcb-home', label: 'Home', active: true },
            { id: 'pcb-design', label: 'Design' },
            { id: 'pcb-properties', label: 'Properties' },
            { id: 'pcb-help', label: 'Help' },
            { kind: 'spacer' },
        ],
        persistentGroups: [
            {
                title: 'Render',
                className: 'ribbon-group--persistent ribbon-group--right ribbon-group--3d',
                items: [
                    B('pcb2dView', '🟩 2D View', 'Toggle the flat 2D board view', { active: () => boardView(app) === 'top' || boardView(app) === 'bottom', run: () => app.open2DView(app.last2DSide() || 'top') }),
                    B('pcb3dView', '🧊 3D View', 'Toggle the interactive 3D board view', { active: () => boardView(app) === '3d', run: () => app.open3DView() }),
                ],
            },
            {
                title: 'Layers',
                className: 'ribbon-group--persistent ribbon-group--right',
                items: [
                    E('div', { id: 'pcbLayerControl', className: 'pcb-layer-control' }, [
                        E('div', { id: 'pcbLayerTrigger', className: 'pcb-layer-trigger' }, [
                            E('span', { id: 'pcbLayerSwatch', className: 'pcb-layer-swatch' }),
                            E('span', { id: 'pcbLayerLabel' }, 'Top Copper'),
                            E('span', { className: 'pcb-layer-arrow' }, '▾'),
                        ]),
                        E('div', { id: 'pcbLayerPanel', className: 'pcb-layer-panel' }),
                    ]),
                ],
            },
        ],
        panels: [
            {
                id: 'pcb-file',
                panel: 'pcb-file',
                groups: [
                    {
                        title: 'File',
                        items: [
                            B('pcbRibbonNew', '📄 New', 'New (Ctrl+N)', { run: () => project()?.newDocument() }),
                            {
                                kind: 'splitDropdown',
                                id: 'pcbRibbonOpenDropdown',
                                main: { id: 'pcbRibbonOpen', title: 'Open (Ctrl+O)', content: '📂 Open', run: () => project()?.open() },
                                arrow: { id: 'pcbRibbonOpenRecent', title: 'Recent files', attrs: { 'aria-haspopup': 'true', 'aria-label': 'Recent files' }, content: '▾' },
                                menuId: 'pcbRibbonRecentMenu',
                                /** @param {{menu: HTMLElement}} event */
                                onOpen: (event) => void renderRecentFiles({
                                    container: event.menu,
                                    getFileManager: () => project()?.fileManager,
                                    openRecent: name => project()?.openRecent(name),
                                }),
                            },
                            {
                                kind: 'dropdown',
                                id: 'pcbRibbonImportDropdown',
                                button: { id: 'pcbRibbonImport', title: 'Import from other formats', content: '📥 Import ▾' },
                                menuId: 'pcbRibbonImportMenu',
                                items: [{ kind: 'button', className: 'dropdown-item', dataset: { format: 'easyeda-sch' }, content: 'EasyEDA Schematic (.json)', run: () => project()?.importEasyEDA() }],
                            },
                            B('pcbRibbonSave', '💾 Save', 'Save (Ctrl+S)', { run: () => savePcbProject(app) }),
                            B('pcbRibbonSaveAs', '💾 Save As', 'Save As (Ctrl+Alt+S)', { run: () => savePcbProject(app, true) }),
                            B('pcbRibbonExportPdf', '🧾 Export PDF', 'Export PDF (Ctrl+Shift+P)', { run: () => app.savePdf() }),
                            B('pcbRibbonPrint', '🖨️ Print', 'Print (Ctrl+P)', { run: () => app.print() }),
                            { kind: 'button', attrs: { 'data-mcp-session': true }, title: 'Connect an AI through MCP', content: '🔌 AI Mode' },
                        ],
                    },
                ],
            },
            {
                id: 'pcb-home',
                panel: 'pcb-home',
                active: true,
                groups: [
                    {
                        title: 'Tools',
                        itemsClassName: 'ribbon-shape-body',
                        items: [
                            E('div', { className: 'ribbon-group-items ribbon-shape-tools' }, [
                                toolButton('select'),
                                toolButton('track'),
                                { kind: 'toolButton', id: 'pcbImportImage', title: 'Import PNG or JPEG artwork', content: '🖼 Image', run: () => showPictureImport(app) },
                                toolButton('via'),
                                toolButton('pad'),
                                presetButton('hole'),
                                {
                                    kind: 'splitTool',
                                    id: 'pcbToolShapesWrap',
                                    active: () => SHAPE_TOOLS.has(normalizePcbTool(app.currentTool)),
                                    classes: {
                                        'tool-layer-locked': () => pcbToolBlock(app, shapeTool())?.reason === 'locked',
                                        'tool-layer-hidden': () => pcbToolBlock(app, shapeTool())?.reason === 'hidden',
                                    },
                                    main: { id: 'pcbToolShapes', title: 'Draw current shape',
                                        content: () => `${PCB_TOOLS[shapeTool()].button.icon} Shapes`,
                                        run: () => {
                                            const tool = normalizePcbTool(app.currentTool);
                                            setTool(SHAPE_TOOLS.has(tool) ? tool : lastShape);
                                        } },
                                    arrow: { id: 'pcbToolShapesArrow', title: 'Choose shape', attrs: { 'aria-label': 'Choose shape', 'aria-expanded': 'false' }, content: '▼' },
                                    menuId: 'pcbToolShapesMenu',
                                    items: shapeItems.map(item => ({ ...item, run: () => { lastShape = item.dataset.shape; setTool(lastShape); } })),
                                },
                                toolButton('text'),
                                toolButton('fill'),
                            ]),
                        ],
                    },
                    { title: 'History', items: [
                        B('pcbUndoBtn', '↶ Undo', 'Undo (Ctrl+Z)', { disabled: () => !app.canUndoPcbHistory(), run: () => runPcbHistoryAction(app, 'undo') }),
                        B('pcbRedoBtn', '↷ Redo', 'Redo (Ctrl+Y)', { disabled: () => !app.history?.canRedo?.(), run: () => runPcbHistoryAction(app, 'redo') }),
                    ] },
                    { title: 'Clipboard', itemsClassName: 'ribbon-group-items prop-actions', items: [
                        B('pcbCutHome', '✂ Cut', 'Cut (Ctrl+X)', { disabled: () => !canCopyCut(), run: () => app.cutSelection() }),
                        B('pcbCopyHome', '⧉ Copy', 'Copy (Ctrl+C)', { disabled: () => !canCopyCut(), run: () => app.copySelection() }),
                        B('pcbPasteHome', '📋 Paste', 'Paste (Ctrl+V)', { disabled: () => !canPaste(), run: () => app.pasteSelection() }),
                    ] },
                    {
                        title: 'Grid',
                        items: [
                            { kind: 'checkbox', id: 'pcbShowGrid', label: 'Grid', checked: () => !!app.viewport?.gridVisible,
                                onChange: onShowGridChange },
                            { kind: 'checkbox', id: 'pcbSnapToGrid', label: 'Snap', checked: () => !!app.viewport?.snapToGrid && !!app.viewport?.gridVisible,
                                disabled: () => !app.viewport?.gridVisible, onChange: onSnapToGridChange },
                            { kind: 'select', id: 'pcbGridSize', title: 'Grid size', options: () => gridOptions(app), value: () => nearestGridValue(app),
                                onChange: onGridSizeChange },
                            { kind: 'select', id: 'pcbUnits', title: 'Units', value: () => app.viewport?.units || 'mm',
                                onChange: onViewportUnitsChange,
                                options: [{ value: 'mm', label: 'mm', selected: true }, { value: 'inch', label: 'inch' }] },
                            { kind: 'select', id: 'pcbGridStyle', title: 'Grid style', value: () => app.viewport?.gridStyle || 'lines',
                                onChange: onGridStyleChange,
                                options: [{ value: 'lines', label: 'Lines', selected: true }, { value: 'dots', label: 'Dots' }] },
                        ],
                    },
                    { title: 'View', items: [
                        B('pcbZoomOut', '−', 'Zoom Out', { run: () => ensureViewport(app)?.zoomOut() }),
                        B('pcbZoomIn', '+', 'Zoom In', { run: () => ensureViewport(app)?.zoomIn() }),
                        B('pcbZoomFit', 'Fit', 'Fit to Board Area', { run: () => app.fitToContent() }),
                        B('pcbResetView', 'Default', 'Default View', { run: () => ensureViewport(app)?.resetView() }),
                        B('pcbThemeToggle', () => getThemeIcon(getSavedTheme()), 'Toggle Dark/Light Mode', { className: 'theme-toggle', run: () => { toggleSharedTheme(); app.refreshPcbRibbon?.(); } }),
                    ] },
                    { title: 'Fabrication', items: [
                        B('pcbPanelize', [E('span', { attrs: { 'aria-hidden': 'true' } }, '▦'), ' Panelize'], 'Configure board panel, rails and separation', { run: () => openPanelize(app) }),
                        B('pcbExportGerber', '📁 Export Gerber', 'Export Gerber + drill files as ZIP', { run: () => exportGerber(app) }),
                        B('pcbExportBOM', '📋 Export BOM', 'Export Bill of Materials as CSV', { run: () => exportBOM(app) }),
                        B('pcbExportPnP', '📍 Export P&P', 'Export Pick-and-place (centroid) file as CSV', { run: () => exportPickAndPlace(app) }),
                    ] },
                ],
            },
            {
                id: 'pcbPropertiesPanel',
                panel: 'pcb-properties',
                groups: [
                    { id: 'pcbPropsContent', title: 'Properties', itemsId: 'pcbPropsItems', items: [{ kind: 'propertyPlaceholder', text: 'Click an object to see its properties' }] },
                    { id: 'pcbPropsClipboard', title: 'Clipboard', itemsClassName: 'ribbon-group-items prop-actions', items: [
                        B('pcbCutProps', '✂ Cut', 'Cut (Ctrl+X)', { disabled: () => !canCopyCut(), run: () => app.cutSelection() }),
                        B('pcbCopyProps', '⧉ Copy', 'Copy (Ctrl+C)', { disabled: () => !canCopyCut(), run: () => app.copySelection() }),
                        B('pcbPasteProps', '📋 Paste', 'Paste (Ctrl+V)', { disabled: () => !canPaste(), run: () => app.pasteSelection() }),
                    ] },
                ],
            },
            {
                id: 'pcb-design',
                panel: 'pcb-design',
                groups: [
                    {
                        title: 'Parameters',
                        itemsClassName: 'ribbon-group-items routing-params',
                        items: [
                            ...routingControls.map(([label, id, key, step]) => routingRow(label, E('input', {
                                id,
                                value: () => designDisplay(app, key),
                                attrs: {
                                    type: 'number',
                                    min: () => String(MINIMUM_MM[key] * designFactor(app)),
                                    max: () => String(Number((PCB_DESIGN_MAX_MM[key] * designFactor(app)).toFixed(designDigits(app)))),
                                    step: () => app.designSettings.values.units === 'inch' ? '0.001' : step,
                                    'data-number-format': 'precise',
                                },
                                /** @param {string} _value @param {InputEvent & {target: HTMLInputElement}} e */
                                onInput: (_value, e) => commitDesignInput(app, key, e.target, app.designSettings.values.units),
                                /** @param {string} _value @param {InputEvent & {target: HTMLInputElement}} e */
                                onChange: (_value, e) => { if (!commitDesignInput(app, key, e.target, app.designSettings.values.units)) e.target.reportValidity?.(); },
                                refreshOnInput: false,
                                refreshOnChange: false,
                            }))),
                            routingRow('Units', { kind: 'select', id: 'pcbRouteUnits', value: () => app.designSettings.values.units,
                                /** @param {string} value */
                                onChange: value => { if (app.designSettings.update({ units: value })) { saveDesignDefaults(app); app.markDirty(); app.refreshPcbRibbon?.(); } },
                                options: [{ value: 'mm', label: 'mm', selected: true }, { value: 'inch', label: 'inch' }] }),
                        ],
                    },
                    { title: 'Design Rules', items: [E('div', { id: 'pcbDrcControl', className: 'drc-control' }, [
                        // DrcPresentation owns the live contents, not the ribbon's button-content refresh.
                        E('button', { id: 'pcbDrcStatus', className: 'drc-status drc-status-pending',
                            title: 'Design Rule Check — click to view problems',
                            attrs: { type: 'button', 'aria-haspopup': 'true' } }, [
                            E('span', { id: 'pcbDrcIcon', className: 'drc-status-icon' }, '…'),
                            E('span', { id: 'pcbDrcLabel', className: 'drc-status-label' }, 'Checking…'),
                        ]),
                    ])] },
                    { title: 'Auto Router', itemsClassName: 'ribbon-group-items auto-router-controls', items: [
                        B('pcbAutoRoute', '⚡ Auto Route', 'Auto-route all connections', { run: () => runAutoRoute(app) }),
                        { kind: 'select', id: 'pcbRouterMode', className: 'auto-router-mode', title: 'Router algorithm', attrs: { 'aria-label': 'Router algorithm' },
                            value: () => app.designSettings.values.router,
                            /** @param {string} value */
                            onChange: value => { if (app.designSettings.update({ router: value })) { saveDesignDefaults(app); app.markDirty(); } },
                            options: [{ value: 'maze', label: 'Maze', selected: true }, { value: 'pathfinder', label: 'Pathfinder' }] },
                        B('pcbClearRoutes', '✕ Clear Routes', 'Clear all tracks and restore ratlines', { run: () => clearRoutes(app) }),
                    ] },
                    { title: 'Test Boards', items: [
                        B('pcbTestDense', '🔬 Dense', 'Load dense test board (42×40mm, 76 connections)', { run: () => loadTestBoard(app, 'test-board.json') }),
                        B('pcbTestSpread', '🔬 Spread', 'Load spread test board (102×84mm, 76 connections)', { run: () => loadTestBoard(app, 'test-board-spread.json') }),
                    ] },
                    { title: 'External Routing', items: [
                        B('pcbExportDSN', '📤 Export DSN', 'Export Specctra DSN for external router', { run: () => exportDSN(app) }),
                        B('pcbImportSES', '📥 Import SES', 'Import Specctra SES routed session', { run: () => importSES(app) }),
                        specctraFlyout,
                    ] },
                ],
            },
            {
                id: 'pcb-help',
                panel: 'pcb-help',
                groups: [
                    {
                        title: 'Keyboard Shortcuts',
                        className: 'ribbon-help',
                        itemsClassName: 'ribbon-group-items ribbon-help-items',
                        items: [
                            H([K('Ctrl+S'), ' Save']),
                            H([K('Ctrl+Alt+S'), ' Save As']),
                            H([K('Ctrl+Z'), ' Undo']),
                            H([K('Ctrl+Y'), ' Redo']),
                            H([K('Ctrl+C'), ' Copy selected']),
                            H([K('Ctrl+X'), ' Cut selected']),
                            H([K('Ctrl+V'), ' Paste']),
                            H([K('Space'), ' Rotate component / reference']),
                            H([K('Space'), ' Fit (nothing selected)']),
                            H([K('X'), ' Flip H (component)']),
                            H([K('Y'), ' Flip V (component)']),
                            H([K('Space'), ' Switch layer while routing']),
                            H([K('Enter'), ' Finish drawing']),
                            H([K('Esc'), ' Cancel / Select mode']),
                            H([K('Del'), ' Delete selected (components: schematic only)']),
                            H([K('Ctrl+A'), ' Select all']),
                            H([K('Arrow keys'), ' Move selected: 1/4 grid step (1 mm with snap off)']),
                            H([K('Drag shape'), ' Move']),
                            H([K('Drag anchor'), ' Resize/Edit']),
                            H([K('Drag empty'), ' Box select']),
                            H([K('Ctrl+Click'), ' Multi-selection']),
                            H([K('Shift+Click'), ' Cycle overlapping objects']),
                            H([K('Ctrl+Shift+Click'), ' Cycle and keep other selections']),
                            H([K('Right-drag'), ' Pan']),
                            H([K('Scroll'), ' Zoom']),
                            { kind: 'helpRow', children: [{ kind: 'checkbox', id: 'pcbDebugTooltip', label: 'Show footprint shape data' }] },
                            { kind: 'helpRow', children: [E('a', { attrs: { href: 'https://github.com/ma261065/ClearPCB', target: '_blank', rel: 'noopener' } }, 'ClearPCB on GitHub')] },
                            { kind: 'helpRow', children: [E('a', { attrs: { href: 'mailto:clearpcbdesign@gmail.com' } }, 'clearpcbdesign@gmail.com')] },
                            { kind: 'helpRow', children: [E('span', { id: 'pcb-version-display', className: 'help-version' })] },
                        ],
                    },
                ],
            },
        ],
    };
}
