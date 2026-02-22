export function bindRibbon(app) {
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

    const tabs = document.querySelectorAll('.ribbon-tab');
    const panels = document.querySelectorAll('.ribbon-panel');
    if (tabs.length === 0 || panels.length === 0) return;

    app._setActiveRibbonTab = (tabId) => {
        tabs.forEach(tab => tab.classList.toggle('active', tab.dataset.tab === tabId));
        panels.forEach(panel => panel.classList.toggle('active', panel.dataset.panel === tabId));
    };

    tabs.forEach(tab => {
        tab.addEventListener('click', () => app._setActiveRibbonTab(tab.dataset.tab));
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
    const tooltipToggle = get('ribbonToggleComponentTooltip');
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
        ribbonToolButtons.forEach(btn => btn.classList.toggle('active', btn.dataset.tool === toolId));
    };
    app._setActiveToolButton = setActiveToolButton;
    ribbonToolButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const toolId = btn.dataset.tool;
            app._onToolSelected(toolId);
        });
    });
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
    });
}

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

    if (!toolSupportsLineWidth && !toolSupportsFill) {
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
}

export function updateRibbonState(app, selection) {
    const count = selection.length;
    const lockBtn = document.getElementById('ribbonToggleLock');
    const deleteBtn = document.getElementById('ribbonDelete');
    const rotateBtn = document.getElementById('ribbonRotate');

    if (deleteBtn) deleteBtn.disabled = count === 0;
    if (lockBtn) lockBtn.disabled = count === 0;

    if (rotateBtn) {
        const hasComponent = selection.some(item => item?.definition);
        rotateBtn.disabled = !hasComponent;
    }
}
