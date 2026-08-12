import { hasClipboard } from './clipboard.js';
import { bindRecentsDropdown } from './recents.js';

/**
 * Binds all ribbon tab buttons, tool buttons, file commands, edit commands,
 * and event listeners; sets up the save toast, active tab tracking, and
 * shape panel options.
 * @param {object} app - Application state.
 */
export function bindRibbon(app) {
    const HOME_TAB_ID = 'home';
    const SELECT_TOOL_ID = 'select';

    // Auto-blur ribbon selects after change so focus border doesn't stick
    document.querySelector('.ribbon')?.addEventListener('change', (e) => {
        if (e.target instanceof HTMLSelectElement) e.target.blur();
    });

    const net_STYLE_META = {
        t: { icon: '⊤', title: 'T' },
        gnd: { icon: '⏚', title: 'GND' },
        arrow: { icon: '↑', title: 'Arrow' },
        chevron: { icon: '«', title: 'Chevron' }
    };

    const normalizenetStyle = (style) => {
        if (style === 'gnd' || style === 'arrow' || style === 'chevron') return style;
        return 't';
    };

    const defaultOrientationByStyle = {
        t: 'N',
        gnd: 'S',
        arrow: 'N',
        chevron: 'E'
    };

    const updateNetToolButton = () => {
        const button = /** @type {HTMLButtonElement|null} */ (document.getElementById('ribbonNetTool'));
        if (!button) return;
        const style = normalizenetStyle(app.toolOptions?.netStyle || 't');
        const meta = net_STYLE_META[style] || net_STYLE_META.t;
        button.innerHTML = `<span class="ribbon-net-icon" aria-hidden="true">${meta.icon}</span> Net`;
        button.title = `Net (${meta.title}) (N)`;
    };

    const updatenetStyleMenuState = () => {
        const menu = /** @type {HTMLElement|null} */ (document.getElementById('ribbonNetStyleMenu'));
        if (!menu) return;
        const style = normalizenetStyle(app.toolOptions?.netStyle || 't');
        const presetText = app.toolOptions?.netPresetText || null;
        menu.querySelectorAll('[data-net-style]').forEach(item => {
            const el = /** @type {HTMLElement} */ (item);
            const itemStyle = el.dataset.netStyle || 't';
            const itemText = el.dataset.netText || null;
            const match = itemStyle === style && itemText === presetText;
            el.classList.toggle('active', match);
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

    const ribbonEl = document.getElementById('ribbonSchematic') || document.querySelector('.ribbon');
    const tabs = ribbonEl.querySelectorAll('.ribbon-tab');
    const panels = ribbonEl.querySelectorAll('.ribbon-panel');
    if (tabs.length === 0 || panels.length === 0) return;
    const panelsEl = /** @type {HTMLElement|null} */ (ribbonEl.querySelector('.ribbon-panels'));

    const retainRibbonHeight = () => {
        if (!panelsEl) return;
        const activePanels = Array.from(panels, panel => panel.classList.contains('active'));
        let height = 0;

        panels.forEach(panel => {
            panels.forEach(other => other.classList.toggle('active', other === panel));
            height = Math.max(height, panelsEl.getBoundingClientRect().height);
        });

        panels.forEach((panel, index) => panel.classList.toggle('active', activePanels[index]));
        panelsEl.style.minHeight = `${Math.ceil(height)}px`;
    };

    window.addEventListener('resize', () => {
        if (!panelsEl) return;
        delete panelsEl.dataset.retainedHeight;
        panelsEl.style.minHeight = '';
        requestAnimationFrame(retainRibbonHeight);
    });

    /** @type {(toolId: string|undefined|null) => void} */
    let setActiveToolButton = () => {};
    const validToolIds = new Set();

    const syncHomeToolHighlight = () => {
        const toolId = typeof app.currentTool === 'string' ? app.currentTool : '';
        if (toolId && validToolIds.has(toolId)) {
            setActiveToolButton(toolId);
            return;
        }
        setActiveToolButton(SELECT_TOOL_ID);
    };

    app._setActiveRibbonTab = (tabId) => {
        retainRibbonHeight();
        tabs.forEach(tab => {
            const t = /** @type {HTMLElement} */ (tab);
            t.classList.toggle('active', t.dataset.tab === tabId);
        });
        panels.forEach(panel => {
            const p = /** @type {HTMLElement} */ (panel);
            p.classList.toggle('active', p.dataset.panel === tabId);
        });

        if (tabId === HOME_TAB_ID) {
            syncHomeToolHighlight();
        }
    };

    tabs.forEach(tab => {
        const t = /** @type {HTMLElement} */ (tab);
        tab.addEventListener('click', () => app._setActiveRibbonTab(t.dataset.tab));
    });
    app._setActiveRibbonTab(HOME_TAB_ID);

    const get = (id) => document.getElementById(id);

    get('ribbonNew')?.addEventListener('click', () => {
        app.newFile();
        app._setActiveRibbonTab('home');
    });
    get('ribbonOpen')?.addEventListener('click', () => {
        app.openFile();
        app._setActiveRibbonTab('home');
    });

    // ── Recent files (Open ▾ dropdown) ───────────────────────────
    bindRecentsDropdown({
        caretBtn: get('ribbonOpenRecent'),
        menu: get('ribbonRecentMenu'),
        getFileManager: () => app.fileManager,
        openRecent: (name) => app.openRecentFile?.(name),
    });

    // ── Import dropdown ──────────────────────────────────────────
    const importBtn = get('ribbonImport');
    const importMenu = get('ribbonImportMenu');
    if (importBtn && importMenu) {
        const closeImportMenu = () => importMenu.classList.remove('open');
        importBtn.addEventListener('click', () => {
            importMenu.classList.toggle('open');
        });
        // Close on outside click
        document.addEventListener('click', (e) => {
            if (!importBtn.contains(/** @type {Node} */ (e.target)) && !importMenu.contains(/** @type {Node} */ (e.target))) {
                closeImportMenu();
            }
        });
        // Handle menu items
        importMenu.addEventListener('click', (e) => {
            const item = /** @type {HTMLElement} */ (e.target).closest('.dropdown-item');
            if (!item) return;
            closeImportMenu();
            const format = item.dataset.format;
            if (format === 'easyeda-sch') {
                app._importEasyEDA();
            }
        });
    }

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
    ribbonToolButtons.forEach(btn => {
        const toolId = /** @type {HTMLElement} */ (btn).dataset.tool;
        if (toolId) validToolIds.add(toolId);
    });
    const netSplitContainer = document.querySelector('.ribbon-split-btn');
    setActiveToolButton = (toolId) => {
        ribbonToolButtons.forEach(btn => {
            const button = /** @type {HTMLElement} */ (btn);
            // Skip split button children — container handles their active state
            if (button.closest('.ribbon-split-btn')) return;
            button.classList.toggle('active', button.dataset.tool === toolId);
        });
        // Handle split button container active state
        if (netSplitContainer) {
            netSplitContainer.classList.toggle('active', toolId === 'net');
        }
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
    const netToolBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('ribbonNetTool'));
    const netArrowBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('ribbonNetStyleBtn'));
    const netStyleMenu = /** @type {HTMLElement|null} */ (document.getElementById('ribbonNetStyleMenu'));
    if (netDropdown && netToolBtn && netArrowBtn && netStyleMenu) {
        const closenetStyleMenu = () => netStyleMenu.classList.remove('open');

        // Arrow button always toggles dropdown
        netArrowBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            updatenetStyleMenuState();
            netStyleMenu.classList.toggle('open');
        });

        // Right-click on main button also opens dropdown
        netToolBtn.addEventListener('contextmenu', (e) => {
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
                const presetText = target.dataset.netText || null;
                app._onOptionsChanged?.({ netStyle: style, netOrientation: orientation });
                app.toolOptions.netPresetText = presetText;
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

    // Event-driven updates
    app.eventBus.on('selectionChanged', (shapes) => {
        updateRibbonState(app, shapes);
        
        if (shapes.length > 0) {
            app._setActiveRibbonTab?.('properties');
        } else {
            app._setActiveRibbonTab?.('home');
        }
    });

    // Tool changes refresh the Properties panel's drawing defaults.
    app.eventBus.on('toolChanged', (toolId) => {
        app._updatePropertiesPanel?.(app.selection.getSelection());
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
    // Drawing defaults are rendered in the Properties tab so Home remains
    // focused on commands and tools rather than object-specific settings.
    container.innerHTML = '';
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
