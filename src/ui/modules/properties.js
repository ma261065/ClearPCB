export function bindPropertiesPanel(app) {
    if (!app.ui.propertiesPanel) return;

    app.ui.propLocked.addEventListener('change', (e) => {
        app._applyCommonProperty('locked', e.target.checked);
    });

    app.ui.propLineWidth.addEventListener('change', (e) => {
        const value = parseFloat(e.target.value);
        if (Number.isNaN(value)) return;
        app._applyCommonProperty('lineWidth', value);
    });

    app.ui.propFill.addEventListener('change', (e) => {
        app._applyCommonProperty('fill', e.target.checked);
    });

    if (app.ui.propTextSize) {
        app.ui.propTextSize.addEventListener('change', (e) => {
            const value = parseFloat(e.target.value);
            if (Number.isNaN(value)) return;
            app._applyCommonProperty('fontSize', value);
        });
    }

    updatePropertiesPanel(app, []);

    app.eventBus.on('selectionChanged', (shapes) => {
        updatePropertiesPanel(app, shapes);
    });
}

export function updatePropertiesPanel(app, selection) {
    if (!app.ui.propertiesPanel) return;

    const count = selection.length;
    if (count === 0) {
        app.ui.propSelectionCount.textContent = 'None selected';
    } else if (count === 1) {
        app.ui.propSelectionCount.textContent = '1 selected';
    } else {
        app.ui.propSelectionCount.textContent = `${count} selected`;
    }

    if (app.ui.propertiesHeaderLabel) {
        if (count === 0) {
            app.ui.propertiesHeaderLabel.textContent = 'Properties';
        } else {
            const types = selection.map(item => item?.definition ? 'component' : (item?.type || 'object'));
            const first = types[0];
            const allSame = types.every(t => t === first);
            const labelType = allSame ? first : 'Multiple';
            app.ui.propertiesHeaderLabel.textContent = `${labelType.charAt(0).toUpperCase()}${labelType.slice(1)}`;
        }
    }

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

    const lockedValues = selection
        .filter(item => typeof item.locked === 'boolean')
        .map(item => item.locked);
    setCheckboxState(app.ui.propLocked, lockedValues);

    const lineWidthValues = selection
        .filter(item => typeof item.lineWidth === 'number')
        .map(item => item.lineWidth);

    if (lineWidthValues.length === 0) {
        app.ui.propLineWidth.value = '';
        app.ui.propLineWidth.placeholder = '—';
        app.ui.propLineWidth.disabled = true;
    } else {
        app.ui.propLineWidth.disabled = false;
        const first = lineWidthValues[0];
        const allSame = lineWidthValues.every(v => Math.abs(v - first) < 1e-6);
        if (allSame) {
            app.ui.propLineWidth.value = first;
        } else {
            app.ui.propLineWidth.value = '';
            app.ui.propLineWidth.placeholder = '—';
        }
    }

    const fillValues = selection
        .filter(item => typeof item.fill === 'boolean')
        .map(item => item.fill);
    setCheckboxState(app.ui.propFill, fillValues);

    const hasText = selection.some(item => item?.type === 'text');
    if (hasText) {
        app.ui.propFill.checked = false;
        app.ui.propFill.indeterminate = false;
        app.ui.propFill.disabled = true;
    }

    if (app.ui.propTextSize) {
        const sizeValues = selection
            .filter(item => typeof item.fontSize === 'number')
            .map(item => item.fontSize);

        if (sizeValues.length === 0) {
            app.ui.propTextSize.value = '';
            app.ui.propTextSize.placeholder = '—';
            app.ui.propTextSize.disabled = true;
        } else {
            app.ui.propTextSize.disabled = false;
            const first = sizeValues[0];
            const allSame = sizeValues.every(v => Math.abs(v - first) < 1e-6);
            if (allSame) {
                app.ui.propTextSize.value = first;
            } else {
                app.ui.propTextSize.value = '';
                app.ui.propTextSize.placeholder = '—';
            }
        }
    }

    
}

export function applyCommonProperty(app, prop, value) {
    const selection = app.selection.getSelection();
    if (selection.length === 0) return;

    let changed = false;
    for (const item of selection) {
        if (prop in item) {
            item[prop] = value;
            if (typeof item.invalidate === 'function') {
                item.invalidate();
            }
            changed = true;
        }
    }

    if (changed) {
        app.fileManager.setDirty(true);
        app.renderShapes(true);
        app._updatePropertiesPanel(selection);
        if (prop === 'fontSize' && app.textEdit?.shape && selection.includes(app.textEdit.shape)) {
            app._updateTextEditOverlay?.();
        }
        if (prop === 'locked') {
            if (value) {
                app._endTextEdit?.(true);
            } else if (selection.length === 1 && selection[0]?.type === 'text') {
                app._startTextEdit?.(selection[0]);
            }
        }
    }
}
