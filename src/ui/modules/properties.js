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

/** Create a ribbon-group style sub-section with a title label. */
function _createSection(title) {
    const group = document.createElement('div');
    group.className = 'ribbon-group';
    const titleEl = document.createElement('div');
    titleEl.className = 'ribbon-group-title';
    titleEl.textContent = title;
    group.appendChild(titleEl);
    const content = document.createElement('div');
    content.className = 'ribbon-group-items';
    group.appendChild(content);
    return { group, content };
}

// ── panel rendering ──────────────────────────────────────────────

export function updatePropertiesPanel(app, selection) {
    const panel = app.ui.propertiesPanel;
    if (!panel) return;

    // Clear previous content
    panel.innerHTML = '';

    // ── Selection / Properties section ──
    {
        const label = headerLabel(selection);
        const sec = _createSection(label);

        const countEl = document.createElement('div');
        countEl.className = 'prop-row';
        const countSpan = document.createElement('span');
        countSpan.className = 'prop-value';
        countSpan.textContent = selection.length === 0 ? 'None selected'
            : selection.length === 1 ? '1 selected'
            : `${selection.length} selected`;
        countEl.appendChild(countSpan);
        sec.content.appendChild(countEl);

        if (selection.length > 0) {
            const descriptors = mergeDescriptors(selection);
            const allLocked = selection.every(s => s.locked);

            for (const desc of descriptors) {
                const row = document.createElement('div');
                row.className = 'prop-row';
                const disabled = allLocked && desc.key !== 'locked';

                if (desc.type === 'checkbox') {
                    const lbl = document.createElement('label');
                    const input = document.createElement('input');
                    input.type = 'checkbox';
                    const values = selection.map(s => s[desc.key]);
                    setCheckboxState(input, values);
                    input.addEventListener('change', () => {
                        applyCommonProperty(app, desc.key, input.checked);
                    });
                    lbl.appendChild(input);
                    lbl.append(` ${desc.label}`);
                    row.appendChild(lbl);

                } else if (desc.type === 'number') {
                    const lbl = document.createElement('label');
                    lbl.setAttribute('for', `prop_${desc.key}`);
                    lbl.textContent = desc.label;
                    row.appendChild(lbl);

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
                    const lbl = document.createElement('label');
                    lbl.setAttribute('for', `prop_${desc.key}`);
                    lbl.textContent = desc.label;
                    row.appendChild(lbl);

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

                sec.content.appendChild(row);
            }
        }

        panel.appendChild(sec.group);
    }

    if (selection.length === 0) return;

    const allLocked = selection.every(s => s.locked);

    // ── Clipboard section ──
    {
        const sec = _createSection('Clipboard');
        const div = document.createElement('div');
        div.className = 'prop-actions';

        const cutBtn = document.createElement('button');
        cutBtn.title = 'Cut (Ctrl+X)';
        cutBtn.id = 'propCut';
        cutBtn.textContent = '✂ Cut';
        if (allLocked) { cutBtn.disabled = true; }
        div.appendChild(cutBtn);

        const copyBtn = document.createElement('button');
        copyBtn.title = 'Copy (Ctrl+C)';
        copyBtn.id = 'propCopy';
        copyBtn.textContent = '⧉ Copy';
        div.appendChild(copyBtn);

        const pasteBtn = document.createElement('button');
        pasteBtn.title = 'Paste (Ctrl+V)';
        pasteBtn.id = 'propPaste';
        pasteBtn.textContent = '📋 Paste';
        div.appendChild(pasteBtn);

        sec.content.appendChild(div);
        panel.appendChild(sec.group);
    }

    // ── Transform section (only for components) ──
    const hasComponent = selection.some(s => s.definition);
    if (hasComponent) {
        const sec = _createSection('Transform');
        const div = document.createElement('div');
        div.className = 'prop-actions';

        const rotLeftBtn = document.createElement('button');
        rotLeftBtn.title = 'Rotate Left';
        rotLeftBtn.id = 'propRotateLeft';
        rotLeftBtn.textContent = '↶ Rotate L';
        div.appendChild(rotLeftBtn);

        const rotRightBtn = document.createElement('button');
        rotRightBtn.title = 'Rotate Right';
        rotRightBtn.id = 'propRotateRight';
        rotRightBtn.textContent = '↷ Rotate R';
        div.appendChild(rotRightBtn);

        const flipHBtn = document.createElement('button');
        flipHBtn.title = 'Flip Horizontal';
        flipHBtn.id = 'propFlipH';
        flipHBtn.textContent = '⇔ Flip H';
        div.appendChild(flipHBtn);

        const flipVBtn = document.createElement('button');
        flipVBtn.title = 'Flip Vertical';
        flipVBtn.id = 'propFlipV';
        flipVBtn.textContent = '⇕ Flip V';
        div.appendChild(flipVBtn);

        sec.content.appendChild(div);
        panel.appendChild(sec.group);
    }

    // ── Actions section ──
    {
        const sec = _createSection('Actions');
        const div = document.createElement('div');
        div.className = 'prop-actions';

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'ribbon-danger';
        deleteBtn.title = 'Delete (Del)';
        deleteBtn.id = 'ribbonDelete';
        deleteBtn.textContent = '🗑 Delete';
        if (allLocked) {
            deleteBtn.disabled = true;
        }
        div.appendChild(deleteBtn);

        sec.content.appendChild(div);
        panel.appendChild(sec.group);
    }

    // Rebind action buttons (ids are used by ribbon.js / callbacks.js)
    _bindActionButtons(app);
}

// ── action button rebinding ──────────────────────────────────────

function _bindActionButtons(app) {
    const deleteBtn = document.getElementById('ribbonDelete');
    if (deleteBtn) {
        deleteBtn.addEventListener('click', () => app._deleteSelected());
    }
    const cutBtn = document.getElementById('propCut');
    if (cutBtn) {
        cutBtn.addEventListener('click', () => app._cutSelection());
    }
    const copyBtn = document.getElementById('propCopy');
    if (copyBtn) {
        copyBtn.addEventListener('click', () => app._copySelection());
    }
    const pasteBtn = document.getElementById('propPaste');
    if (pasteBtn) {
        pasteBtn.addEventListener('click', () => app._pasteClipboard());
    }
    const rotLeftBtn = document.getElementById('propRotateLeft');
    if (rotLeftBtn) {
        rotLeftBtn.addEventListener('click', () => app._rotateComponentLeft());
    }
    const rotRightBtn = document.getElementById('propRotateRight');
    if (rotRightBtn) {
        rotRightBtn.addEventListener('click', () => app._rotateComponentRight());
    }
    const flipHBtn = document.getElementById('propFlipH');
    if (flipHBtn) {
        flipHBtn.addEventListener('click', () => app._flipComponentH());
    }
    const flipVBtn = document.getElementById('propFlipV');
    if (flipVBtn) {
        flipVBtn.addEventListener('click', () => app._flipComponentV());
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
