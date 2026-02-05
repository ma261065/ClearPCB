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

    get('ribbonDelete')?.addEventListener('click', () => app._deleteSelected());
    get('ribbonToggleLock')?.addEventListener('click', () => app._toggleSelectionLock());
    get('ribbonRotate')?.addEventListener('click', () => app._rotateComponent());
    
    // ESC key goes to home tab
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            app._setActiveRibbonTab('home');
        }
    });

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

    // Ensure we have a valid tool ID
    const toolId = toolIdArg || app.currentTool || 'select';

    const items = selection || [];
    const hasSelection = items.length > 0;
    const toolSupportsLineWidth = ['line', 'wire', 'rect', 'circle', 'arc', 'polygon'].includes(toolId);
    const toolSupportsFill = ['rect', 'circle', 'polygon'].includes(toolId);
    const supportsLineWidth = hasSelection
        ? items.some(item => typeof item?.lineWidth === 'number')
        : toolSupportsLineWidth;
    const supportsFill = hasSelection
        ? items.some(item => typeof item?.fill === 'boolean')
        : toolSupportsFill;

    container.innerHTML = `
        <label>
            Line width
            <input type="number" id="ribbonShapeLineWidth" step="0.25" min="0.25" max="5" placeholder="—">
        </label>
        <label>
            <input type="checkbox" id="ribbonShapeFill"> Fill
        </label>
    `;

    const setCheckboxState = (el, values) => {
        el.indeterminate = false;
        if (values.length === 0) {
            el.checked = false;
            el.disabled = true;
            return;
        }
        const allTrue = values.every(v => v === true);
        const allFalse = values.every(v => v === false);
        el.disabled = false;
        if (allTrue) {
            el.checked = true;
        } else if (allFalse) {
            el.checked = false;
        } else {
            el.checked = false;
            el.indeterminate = true;
        }
    };

    const lineWidthInput = container.querySelector('#ribbonShapeLineWidth');
    if (lineWidthInput) {
        if (hasSelection) {
            const lineWidthValues = items
                .filter(item => typeof item?.lineWidth === 'number')
                .map(item => item.lineWidth);

            if (lineWidthValues.length === 0) {
                lineWidthInput.value = '';
                lineWidthInput.placeholder = '—';
                lineWidthInput.disabled = true;
            } else {
                lineWidthInput.disabled = false;
                const first = lineWidthValues[0];
                const allSame = lineWidthValues.every(v => Math.abs(v - first) < 1e-6);
                if (allSame) {
                    lineWidthInput.value = first;
                } else {
                    lineWidthInput.value = '';
                    lineWidthInput.placeholder = '—';
                }
                
                // Disable if any selected item is a wire
                if (items.some(item => item.type === 'wire')) {
                    lineWidthInput.disabled = true;
                }
            }
        } else {
            // When no selection (drawing mode), always enable input if tool supports it
            lineWidthInput.disabled = !toolSupportsLineWidth;
            lineWidthInput.value = app.toolOptions?.lineWidth ?? 0.2;
            
            // Force disable for wire tool
            if (toolId === 'wire') {
                lineWidthInput.value = 0.25;
                lineWidthInput.disabled = true;
            }
        }

        lineWidthInput.addEventListener('change', (e) => {
            const value = parseFloat(e.target.value);
            if (Number.isNaN(value)) return;
            if (hasSelection) {
                app._applyCommonProperty('lineWidth', value);
            } else {
                app.toolOptions.lineWidth = value;
            }
        });
    }

    const fillInput = container.querySelector('#ribbonShapeFill');
    if (fillInput) {
        if (hasSelection) {
            const fillValues = items
                .filter(item => typeof item?.fill === 'boolean')
                .map(item => item.fill);
            setCheckboxState(fillInput, fillValues);
        } else {
            // When no selection (drawing mode), always enable input if tool supports it
            fillInput.disabled = !toolSupportsFill;
            // Use toolOptions safe access
            fillInput.checked = !!(app.toolOptions && app.toolOptions.fill);
            fillInput.indeterminate = false;
        }
        fillInput.addEventListener('change', (e) => {
            if (hasSelection) {
                app._applyCommonProperty('fill', e.target.checked);
            } else {
                app.toolOptions.fill = e.target.checked;
            }
        });
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
