import { hasClipboard } from './clipboard.js';

/**
 * Binds all ribbon tab buttons, tool buttons, file commands, edit commands,
 * and event listeners; sets up the save toast, active tab tracking, and
 * shape panel options.
 * @param {object} app - Application state.
 */
export function bindRibbon(app) {
    // Auto-blur ribbon selects after change so focus border doesn't stick
    document.querySelector('.ribbon')?.addEventListener('change', (e) => {
        if (e.target instanceof HTMLSelectElement) e.target.blur();
    });

    const net_STYLE_META = {
        t: { icon: '┤', title: 'T' },
        gnd: { icon: '⏚', title: 'GND' },
        arrow: { icon: '➤', title: 'Arrow' },
        chevron: { icon: '❯', title: 'Chevron' }
    };

    const normalizenetStyle = (style) => {
        if (style === 'gnd' || style === 'arrow' || style === 'chevron') return style;
        return 't';
    };

    const defaultOrientationByStyle = {
        t: 'N',
        gnd: 'N',
        arrow: 'N',
        chevron: 'N'
    };

    const updateNetToolButton = () => {
        const button = /** @type {HTMLButtonElement|null} */ (document.getElementById('ribbonNetTool'));
        if (!button) return;
        const style = normalizenetStyle(app.toolOptions?.netStyle || 't');
        const meta = net_STYLE_META[style] || net_STYLE_META.t;
        button.textContent = `${meta.icon} Net`;
        button.title = `Net (${meta.title}) (N)`;
    };

    const updatenetStyleMenuState = () => {
        const menu = /** @type {HTMLElement|null} */ (document.getElementById('ribbonNetStyleMenu'));
        if (!menu) return;
        const style = normalizenetStyle(app.toolOptions?.netStyle || 't');
        menu.querySelectorAll('[data-net-style]').forEach(item => {
            const el = /** @type {HTMLElement} */ (item);
            el.classList.toggle('active', (el.dataset.netStyle || 't') === style);
        });
    };

    const showSaveToast = (anchorEl, text = 'Saved') => {
        if (!anchorEl) return;
        const existing = document.getElementById('ribbon-save-toast');
        if (existing) {
            existing.remove();
        }

        const rect = anchorEl.getBoundingClientRect();
        const toast = document.createElement('div');
        toast.id = 'ribbon-save-toast';
        toast.className = 'ribbon-save-toast';
        toast.textContent = text;
        toast.style.left = `${rect.left + rect.width / 2}px`;
        toast.style.top = `${rect.bottom + 6}px`;
        document.body.appendChild(toast);

        requestAnimationFrame(() => {
            toast.classList.add('show');
        });

        window.setTimeout(() => {
            toast.classList.remove('show');
            window.setTimeout(() => toast.remove(), 200);
        }, 900);
    };

    app._showSaveToast = (text = 'Saved') => {
        const anchor = document.getElementById('docTitle');
        showSaveToast(anchor, text);
    };

    const ribbonEl = document.getElementById('ribbonSchematic') || document.querySelector('.ribbon');
    const tabs = ribbonEl.querySelectorAll('.ribbon-tab');
    const panels = ribbonEl.querySelectorAll('.ribbon-panel');
    if (tabs.length === 0 || panels.length === 0) return;

    app._setActiveRibbonTab = (tabId) => {
        tabs.forEach(tab => {
            const t = /** @type {HTMLElement} */ (tab);
            t.classList.toggle('active', t.dataset.tab === tabId);
        });
        panels.forEach(panel => {
            const p = /** @type {HTMLElement} */ (panel);
            p.classList.toggle('active', p.dataset.panel === tabId);
        });
    };

    tabs.forEach(tab => {
        const t = /** @type {HTMLElement} */ (tab);
        tab.addEventListener('click', () => app._setActiveRibbonTab(t.dataset.tab));
    });
    app._setActiveRibbonTab('home');

    const get = (id) => document.getElementById(id);

    get('ribbonNew')?.addEventListener('click', () => {
        app.newFile();
        app._setActiveRibbonTab('home');
    });
    get('ribbonOpen')?.addEventListener('click', () => {
        app.openFile();
        app._setActiveRibbonTab('home');
    });
    const saveButton = get('ribbonSave');
    const saveAsButton = get('ribbonSaveAs');

    saveButton?.addEventListener('click', async () => {
        const result = await app.saveFile();
        if (result?.success) {
            app._showSaveToast?.('Saved');
        }
    });
    saveAsButton?.addEventListener('click', async () => {
        const result = await app.saveFileAs();
        if (result?.success) {
            app._showSaveToast?.('Saved');
        }
    });
    get('ribbonExportPdf')?.addEventListener('click', () => app.savePdf());
    get('ribbonPrint')?.addEventListener('click', () => app.print());
    get('ribbonClearComponentCache')?.addEventListener('click', () => app._clearComponentCaches?.());
    const tooltipToggle = /** @type {HTMLInputElement|null} */ (get('ribbonToggleComponentTooltip'));
    if (tooltipToggle) {
        tooltipToggle.checked = app.showComponentDebugTooltip !== false;
        tooltipToggle.addEventListener('change', () => {
            app.showComponentDebugTooltip = tooltipToggle.checked;
            if (!tooltipToggle.checked) {
                app._updateComponentCodeTooltip?.(null, null, { forceHide: true });
            }
        });
    }

    get('ribbonDelete')?.addEventListener('click', () => app._deleteSelected());
    get('ribbonToggleLock')?.addEventListener('click', () => app._toggleSelectionLock());
    get('ribbonRotate')?.addEventListener('click', () => app._rotateComponentRight());
    get('ribbonCut')?.addEventListener('click', () => app._cutSelection());
    get('ribbonCopy')?.addEventListener('click', () => app._copySelection());
    get('ribbonPaste')?.addEventListener('click', () => app._pasteClipboard());
    
    // ESC key goes to home tab
    const ribbonEscHandler = (e) => {
        if (e.key === 'Escape') {
            app._setActiveRibbonTab('home');
        }
    };
    document.addEventListener('keydown', ribbonEscHandler);
    app._cleanupRibbonEsc = () => document.removeEventListener('keydown', ribbonEscHandler);

    const ribbonToolButtons = Array.from(document.querySelectorAll('.ribbon-tool-btn'));
    const setActiveToolButton = (toolId) => {
        ribbonToolButtons.forEach(btn => {
            const button = /** @type {HTMLElement} */ (btn);
            button.classList.toggle('active', button.dataset.tool === toolId);
        });
    };
    app._setActiveToolButton = setActiveToolButton;
    ribbonToolButtons.forEach(btn => {
        const button = /** @type {HTMLElement} */ (btn);
        btn.addEventListener('click', () => {
            const toolId = button.dataset.tool;
            if (!toolId) return;
            app._onToolSelected(toolId);
        });
    });

    updateNetToolButton();
    updatenetStyleMenuState();
    const netDropdown = /** @type {HTMLElement|null} */ (document.getElementById('ribbonNetDropdown'));
    const netStyleBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('ribbonNetStyleBtn'));
    const netStyleMenu = /** @type {HTMLElement|null} */ (document.getElementById('ribbonNetStyleMenu'));
    if (netDropdown && netStyleBtn && netStyleMenu) {
        const closenetStyleMenu = () => netStyleMenu.classList.remove('open');
        netStyleBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            updatenetStyleMenuState();
            netStyleMenu.classList.toggle('open');
        });

        netStyleMenu.querySelectorAll('[data-net-style]').forEach(item => {
            item.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const target = /** @type {HTMLElement} */ (item);
                const style = normalizenetStyle(target.dataset.netStyle || 't');
                const orientation = defaultOrientationByStyle[style] || 'E';
                app._onOptionsChanged?.({ netStyle: style, netOrientation: orientation });
                updateNetToolButton();
                updatenetStyleMenuState();
                closenetStyleMenu();
                app._onToolSelected('net');
            });
        });

        document.addEventListener('click', (e) => {
            const target = /** @type {Node|null} */ (e.target);
            if (!target || !netDropdown.contains(target)) {
                closenetStyleMenu();
            }
        });
    }

    setActiveToolButton(app.currentTool);

    updateRibbonState(app, app.selection.getSelection());
    updateShapePanelOptions(app, app.selection.getSelection(), app.currentTool);

    // Event-driven updates
    app.eventBus.on('selectionChanged', (shapes) => {
        updateRibbonState(app, shapes);
        updateShapePanelOptions(app, shapes, app.currentTool);
        
        if (shapes.length > 0) {
            app._setActiveRibbonTab?.('properties');
        } else {
            app._setActiveRibbonTab?.('home');
        }
    });

    // Update ribbon when tool changes (e.g. enable Fill/Line Width for shapes)
    app.eventBus.on('toolChanged', (toolId) => {
        updateShapePanelOptions(app, app.selection.getSelection(), toolId);
        updateNetToolButton();
        updatenetStyleMenuState();
    });
}

/**
 * Populates or clears the shape-options panel (line width, fill checkbox,
 * font size) based on the active tool when nothing is selected.
 * @param {object} app - Application state.
 * @param {Array} selection - Currently selected items.
 * @param {string} [toolIdArg] - Active tool identifier override.
 */
export function updateShapePanelOptions(app, selection, toolIdArg) {
    const container = document.getElementById('ribbonShapeOptions');
    if (!container) return;

    const toolId = toolIdArg || app.currentTool || 'select';
    const hasSelection = selection && selection.length > 0;

    // When items are selected, the Properties tab handles editing.
    // This panel shows tool-default options only when drawing (no selection).
    if (hasSelection) {
        container.innerHTML = '';
        return;
    }

    const toolSupportsLineWidth = ['line', 'rect', 'circle', 'arc', 'polygon'].includes(toolId);
    const toolSupportsFill = ['rect', 'circle', 'polygon'].includes(toolId);
    const toolSupportsFontSize = ['text', 'net'].includes(toolId);

    if (!toolSupportsLineWidth && !toolSupportsFill && !toolSupportsFontSize) {
        container.innerHTML = '';
        return;
    }

    container.innerHTML = '';

    if (toolSupportsLineWidth) {
        const label = document.createElement('label');
        label.textContent = 'Line width ';
        const input = document.createElement('input');
        input.type = 'number';
        input.id = 'ribbonShapeLineWidth';
        input.step = '0.05';
        input.min = '0.05';
        input.max = '5';
        input.value = app.toolOptions?.lineWidth ?? 0.2;
        input.addEventListener('change', () => {
            const v = parseFloat(input.value);
            if (!Number.isNaN(v)) app.toolOptions.lineWidth = v;
        });
        label.appendChild(input);
        container.appendChild(label);
    }

    if (toolSupportsFill) {
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.id = 'ribbonShapeFill';
        input.checked = !!(app.toolOptions && app.toolOptions.fill);
        input.addEventListener('change', () => {
            app.toolOptions.fill = input.checked;
        });
        label.appendChild(input);
        label.append(' Fill');
        container.appendChild(label);
    }

    if (toolSupportsFontSize) {
        const label = document.createElement('label');
        label.textContent = toolId === 'text' ? 'Label size ' : 'Text size ';
        const input = document.createElement('input');
        input.type = 'number';
        input.id = 'ribbonShapeFontSize';
        input.step = '0.5';
        input.min = '0.5';
        input.max = '50';
        if (toolId === 'net') {
            input.value = app.toolOptions?.netFontSize ?? 1.4;
        } else {
            input.value = app.toolOptions?.fontSize ?? 2.0;
        }
        input.addEventListener('change', () => {
            const v = parseFloat(input.value);
            if (Number.isNaN(v)) return;
            if (toolId === 'net') app.toolOptions.netFontSize = v;
            else app.toolOptions.fontSize = v;
        });
        label.appendChild(input);
        container.appendChild(label);
    }
}

/**
 * Enables/disables ribbon buttons (delete, lock, cut, copy, paste, rotate)
 * based on the current selection count and clipboard state.
 * @param {object} app - Application state.
 * @param {Array} selection - Currently selected items.
 */
export function updateRibbonState(app, selection) {
    const count = selection.length;
    const lockBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('ribbonToggleLock'));
    const deleteBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('ribbonDelete'));
    const rotateBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('ribbonRotate'));
    const cutBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('ribbonCut'));
    const copyBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('ribbonCopy'));
    const pasteBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('ribbonPaste'));

    if (deleteBtn) deleteBtn.disabled = count === 0;
    if (lockBtn) lockBtn.disabled = count === 0;
    if (cutBtn) cutBtn.disabled = count === 0;
    if (copyBtn) copyBtn.disabled = count === 0;
    if (pasteBtn) pasteBtn.disabled = !hasClipboard();

    if (rotateBtn) {
        const hasComponent = selection.some(item => item?.definition);
        rotateBtn.disabled = !hasComponent;
    }
}
