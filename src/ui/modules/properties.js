import { setCheckboxState } from './ui-utils.js';
import { ModifyPropertyCommand } from '../../core/CommandHistory.js';

export function bindPropertiesPanel(app) {
    if (!app.ui.propertiesPanel) return;

    updatePropertiesPanel(app, []);

    app.eventBus.on('selectionChanged', (shapes) => {
        updatePropertiesPanel(app, shapes);
    });
}

// ── helpers ──────────────────────────────────────────────────────

/**
 * Compute the intersection of property descriptors across all selected items.
 * Only properties declared by *every* item in the selection are shown.
 */
function mergeDescriptors(selection) {
    if (selection.length === 0) return [];
    const first = selection[0].getPropertyDescriptors();
    if (selection.length === 1) return first;

    // Keep only keys that every item declares
    const keySets = selection.map(s => new Set(s.getPropertyDescriptors().map(d => d.key)));
    return first.filter(d => keySets.every(ks => ks.has(d.key)));
}

function headerLabel(selection) {
    if (selection.length === 0) return 'Properties';
    const types = selection.map(s => s.definition ? 'Component' : (s.type || 'object'));
    const first = types[0];
    if (types.every(t => t === first)) return first.charAt(0).toUpperCase() + first.slice(1);
    return 'Multiple';
}

// ── panel rendering ──────────────────────────────────────────────

export function updatePropertiesPanel(app, selection) {
    const panel = app.ui.propertiesPanel;
    if (!panel) return;

    // Update header
    if (app.ui.propertiesHeaderLabel) {
        app.ui.propertiesHeaderLabel.textContent = headerLabel(selection);
    }

    // Clear previous content
    panel.innerHTML = '';

    // Selection count row
    const countEl = document.createElement('div');
    countEl.className = 'prop-row';
    const countSpan = document.createElement('span');
    countSpan.className = 'prop-value';
    countSpan.textContent = selection.length === 0 ? 'None selected'
        : selection.length === 1 ? '1 selected'
        : `${selection.length} selected`;
    countEl.appendChild(countSpan);
    panel.appendChild(countEl);

    if (selection.length === 0) return;

    // Build descriptor-driven rows
    const descriptors = mergeDescriptors(selection);
    const allLocked = selection.every(s => s.locked);

    for (const desc of descriptors) {
        const row = document.createElement('div');
        row.className = 'prop-row';
        // Disable non-lock fields when all selected items are locked
        const disabled = allLocked && desc.key !== 'locked';

        if (desc.type === 'checkbox') {
            const label = document.createElement('label');
            const input = document.createElement('input');
            input.type = 'checkbox';
            const values = selection.map(s => s[desc.key]);
            setCheckboxState(input, values);
            input.addEventListener('change', () => {
                applyCommonProperty(app, desc.key, input.checked);
            });
            label.appendChild(input);
            label.append(` ${desc.label}`);
            row.appendChild(label);

        } else if (desc.type === 'number') {
            const label = document.createElement('label');
            label.setAttribute('for', `prop_${desc.key}`);
            label.textContent = desc.label;
            row.appendChild(label);

            const input = document.createElement('input');
            input.type = 'number';
            input.id = `prop_${desc.key}`;
            if (desc.min != null) input.min = desc.min;
            if (desc.max != null) input.max = desc.max;
            if (desc.step != null) input.step = desc.step;

            const values = selection.map(s => s[desc.key]).filter(v => typeof v === 'number');
            if (values.length === 0) {
                input.value = '';
                input.placeholder = '—';
            } else {
                const first = values[0];
                const allSame = values.every(v => Math.abs(v - first) < 1e-6);
                input.value = allSame ? first : '';
                if (!allSame) input.placeholder = '—';
            }

            input.addEventListener('change', () => {
                let v = parseFloat(input.value);
                if (Number.isNaN(v)) return;
                if (desc.min != null && v < desc.min) v = desc.min;
                if (desc.max != null && v > desc.max) v = desc.max;
                if (parseFloat(input.value) !== v) input.value = v;
                applyCommonProperty(app, desc.key, v);
            });
            if (disabled) {
                input.readOnly = true;
                input.style.opacity = '0.7';
            }
            row.appendChild(input);

        } else if (desc.type === 'text') {
            const label = document.createElement('label');
            label.setAttribute('for', `prop_${desc.key}`);
            label.textContent = desc.label;
            row.appendChild(label);

            const input = document.createElement('input');
            input.type = 'text';
            input.id = `prop_${desc.key}`;

            const values = selection.map(s => s[desc.key]).filter(v => v != null);
            if (values.length === 0) {
                input.value = '';
                input.placeholder = '—';
            } else {
                const first = String(values[0]);
                const allSame = values.every(v => String(v) === first);
                input.value = allSame ? first : '';
                if (!allSame) input.placeholder = '—';
            }

            if (desc.readonly || disabled) {
                input.readOnly = true;
                input.style.opacity = '0.7';
            } else {
                input.addEventListener('change', () => {
                    applyCommonProperty(app, desc.key, input.value);
                });
            }
            row.appendChild(input);
        }

        panel.appendChild(row);
    }

    // Action buttons (always shown when something is selected)
    const actionsRow = document.createElement('div');
    actionsRow.className = 'prop-row';
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'ribbon-group-items';

    const hasComponent = selection.some(s => s.definition);
    if (hasComponent) {
        const rotateBtn = document.createElement('button');
        rotateBtn.textContent = '⟳ Rotate';
        rotateBtn.title = 'Rotate Components';
        rotateBtn.id = 'ribbonRotate';
        actionsDiv.appendChild(rotateBtn);
    }

    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = '🗑️ Delete';
    deleteBtn.title = 'Delete (Del)';
    deleteBtn.className = 'ribbon-danger';
    deleteBtn.id = 'ribbonDelete';
    if (allLocked) {
        deleteBtn.disabled = true;
        deleteBtn.style.opacity = '0.5';
    }
    actionsDiv.appendChild(deleteBtn);

    actionsRow.appendChild(actionsDiv);
    panel.appendChild(actionsRow);

    // Rebind action buttons (ids are used by ribbon.js / callbacks.js)
    _bindActionButtons(app);
}

// ── action button rebinding ──────────────────────────────────────

function _bindActionButtons(app) {
    const deleteBtn = document.getElementById('ribbonDelete');
    if (deleteBtn) {
        deleteBtn.addEventListener('click', () => app._deleteSelected());
    }
    const rotateBtn = document.getElementById('ribbonRotate');
    if (rotateBtn) {
        rotateBtn.addEventListener('click', () => app._rotateComponent());
    }
}

// ── property application ─────────────────────────────────────────

export function applyCommonProperty(app, prop, value) {
    const selection = app.selection.getSelection();
    if (selection.length === 0) return;

    // Filter to items that actually have this property
    const affected = selection.filter(item => prop in item);
    if (affected.length === 0) return;

    // Check if any value actually changes
    const changing = affected.filter(item => item[prop] !== value);
    if (changing.length === 0) return;

    // Enforce unique component references (direct on component OR via field text)
    if (prop === 'reference' && value) {
        const duplicate = app.components.find(c =>
            c.reference.toUpperCase() === value.toUpperCase() && !changing.includes(c));
        if (duplicate) {
            alert(`Reference "${value}" is already used by another component.`);
            app._updatePropertiesPanel(selection);
            return;
        }
    }
    if (prop === 'text') {
        // Check if any affected item is a reference field text
        const refFields = changing.filter(s => s.parentComponent && s.fieldKey === 'reference');
        if (refFields.length > 0 && value) {
            const parentIds = new Set(refFields.map(f => f.parentComponent.id));
            const duplicate = app.components.find(c =>
                c.reference.toUpperCase() === value.toUpperCase() && !parentIds.has(c.id));
            if (duplicate) {
                alert(`Reference "${value}" is already used by another component.`);
                app._updatePropertiesPanel(selection);
                return;
            }
        }
    }

    // Create undoable command
    const command = new ModifyPropertyCommand(app, changing, prop, value);
    app.history.execute(command);

    app.fileManager.setDirty(true);
    app._updatePropertiesPanel(selection);
    if (prop === 'fontSize' && app.textEdit?.shape && selection.includes(app.textEdit.shape)) {
        app._updateTextEditOverlay?.();
    }
    if (prop === 'locked') {
        if (value) {
            app._endTextEdit?.(true);
        } else if (selection.length === 1 && selection[0]?.supportsInlineEdit) {
            app._startTextEdit?.(selection[0]);
        }
    }
}
