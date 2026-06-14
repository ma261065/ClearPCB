import { setCheckboxState } from './ui-utils.js';
import { ModifyPropertyCommand } from '../../core/CommandHistory.js';
import { rotateNetOrientation } from '../../shapes/net.js';
import { adaptShortcutText } from './platform-keys.js';
import { canDecomposeRoundedCorners } from '../../shapes/shape-decompose.js';
import { decomposeShapeCorners } from './context-menu.js';

/**
 * Initializes the properties panel and subscribes to `selectionChanged`
 * events to rebuild it when the selection changes.
 * @param {object} app - Application state.
 */
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
    const displayNames = { rect: 'Rectangle', text: 'Label', Net: 'Net', noconnect: 'No Connect', polyline: 'Line' };
    const types = selection.map(s => {
        if (s.definition) return 'Component';
        if (s.type === 'polyline' && s.isRect) return 'rect';
        if (s.type === 'polyline' && s.closed) return 'polygon';
        return s.type || 'object';
    });
    const first = types[0];
    if (types.every(t => t === first)) {
        if (first === 'Component') {
            const names = new Set(selection.map(s => s.name).filter(Boolean));
            if (names.size === 1) {
                return `Component - ${[...names][0].toUpperCase()}`;
            }
            return 'Component';
        }
        return displayNames[first] || first.charAt(0).toUpperCase() + first.slice(1);
    }
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

/**
 * Rebuilds the properties panel DOM: shows merged property descriptors,
 * clipboard actions, transform buttons (for components), and delete.
 * @param {object} app - Application state.
 * @param {Array} selection - Currently selected shapes/components.
 */
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
            // Spacing after selection count
            const spacer = document.createElement('div');
            spacer.style.height = '6px';
            sec.content.appendChild(spacer);

            const descriptors = mergeDescriptors(selection);
            const allLocked = selection.every(s => s.locked);

            for (const desc of descriptors) {
                // Add divider after locked checkbox
                if (desc.key === 'lineWidth' || (desc.key !== 'locked' && descriptors[0]?.key === 'locked')) {
                    if (desc.key === 'lineWidth') {
                        const divider = document.createElement('hr');
                        divider.style.cssText = 'border:none;border-top:1px solid var(--border-color);margin:4px 0;';
                        sec.content.appendChild(divider);
                    }
                }

                const row = document.createElement('div');
                row.className = 'prop-row';
                const disabled = allLocked && desc.key !== 'locked';

                if (desc.type === 'checkbox') {
                    const lbl = document.createElement('label');
                    const input = document.createElement('input');
                    input.type = 'checkbox';
                    const values = selection.map(s => s[desc.key]);
                    setCheckboxState(input, values);
                    if (disabled) {
                        input.disabled = true;
                        lbl.style.opacity = '0.4';
                        lbl.style.pointerEvents = 'none';
                    }
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
                    // Real-time preview while dragging spinner
                    input.addEventListener('input', () => {
                        let v = parseFloat(input.value);
                        if (Number.isNaN(v)) return;
                        if (desc.min != null && v < desc.min) v = desc.min;
                        if (desc.max != null && v > desc.max) v = desc.max;
                        for (const item of selection) {
                            if (desc.key in item) {
                                item[desc.key] = v;
                                item.invalidate?.();
                            }
                        }
                        app.renderShapes(false);
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

                } else if (desc.type === 'select' && Array.isArray(desc.options)) {
                    const lbl = document.createElement('label');
                    lbl.setAttribute('for', `prop_${desc.key}`);
                    lbl.textContent = desc.label;
                    row.appendChild(lbl);

                    const select = document.createElement('select');
                    select.id = `prop_${desc.key}`;
                    for (const opt of desc.options) {
                        const option = document.createElement('option');
                        option.value = opt.value;
                        option.textContent = opt.label;
                        select.appendChild(option);
                    }

                    const values = selection.map(s => s[desc.key]);
                    const first = values[0];
                    const allSame = values.every(v => v === first);
                    select.value = allSame ? first : '';

                    if (disabled) {
                        select.disabled = true;
                        select.style.opacity = '0.7';
                    } else {
                        select.addEventListener('change', () => {
                            let v = select.value;
                            // Convert to number if the option values are numeric
                            const num = parseFloat(v);
                            if (!Number.isNaN(num) && String(num) === v) v = num;
                            applyCommonProperty(app, desc.key, v);
                        });
                    }
                    row.appendChild(select);
                }

                sec.content.appendChild(row);
            }

            // H/V rotation buttons for text shapes
            const textShapes = selection.filter(s => s.type === 'text');
            if (textShapes.length > 0 && textShapes.length === selection.length) {
                const hvRow = document.createElement('div');
                hvRow.className = 'prop-row';
                const hvLabel = document.createElement('label');
                hvLabel.textContent = 'Orientation';
                hvRow.appendChild(hvLabel);

                const hvBtns = document.createElement('span');
                hvBtns.style.cssText = 'display:flex;gap:2px;';
                const curRot = textShapes[0].rotation || 0;
                const allSameRot = textShapes.every(s => (s.rotation || 0) === curRot);

                const hBtn = document.createElement('button');
                hBtn.textContent = 'H';
                hBtn.title = 'Horizontal';
                hBtn.style.cssText = 'padding:1px 6px;font-size:11px;min-width:0;';
                if (allSameRot && curRot === 0) hBtn.classList.add('active');
                if (allLocked) hBtn.disabled = true;
                hBtn.addEventListener('click', () => {
                    applyCommonProperty(app, 'rotation', 0);
                });
                const vBtn = document.createElement('button');
                vBtn.textContent = 'V';
                vBtn.title = 'Vertical (bottom to top)';
                vBtn.style.cssText = 'padding:1px 6px;font-size:11px;min-width:0;';
                if (allSameRot && curRot === 270) vBtn.classList.add('active');
                if (allLocked) vBtn.disabled = true;
                vBtn.addEventListener('click', () => {
                    applyCommonProperty(app, 'rotation', 270);
                });
                hvBtns.appendChild(hBtn);
                hvBtns.appendChild(vBtn);
                hvRow.appendChild(hvBtns);
                sec.content.appendChild(hvRow);
            }
        }

        panel.appendChild(sec.group);
    }

    if (selection.length === 0) return;

    const allLocked = selection.every(s => s.locked);

    // ── Wire Net section (only for single wire selection) ──
    const singleWire = selection.length === 1 && selection[0].type === 'wire' ? selection[0] : null;
    if (singleWire) {
        const sec = _createSection('Net');
        const wire = singleWire;
        const disabled = allLocked;

        const netRow = document.createElement('div');
        netRow.className = 'prop-row';
        const netLbl = document.createElement('label');
        netLbl.setAttribute('for', 'prop_net');
        netLbl.textContent = 'Net';
        netRow.appendChild(netLbl);
        const netInput = document.createElement('input');
        netInput.type = 'text';
        netInput.id = 'prop_net';
        netInput.value = wire.net || '';
        if (disabled) {
            netInput.readOnly = true;
            netInput.style.opacity = '0.7';
        } else {
            netInput.addEventListener('change', () => {
                if (!netInput.value.trim()) {
                    netInput.value = wire.net || 'NET1';
                    return;
                }
                applyCommonProperty(app, 'net', netInput.value);
            });
        }
        netRow.appendChild(netInput);
        sec.content.appendChild(netRow);

        panel.appendChild(sec.group);
    }

    // ── Clipboard section ──
    {
        const sec = _createSection('Clipboard');
        const div = document.createElement('div');
        div.className = 'prop-actions';

        const cutBtn = document.createElement('button');
        cutBtn.title = adaptShortcutText('Cut (Ctrl+X)');
        cutBtn.id = 'propCut';
        cutBtn.textContent = '✂ Cut';
        if (allLocked) { cutBtn.disabled = true; }
        div.appendChild(cutBtn);

        const copyBtn = document.createElement('button');
        copyBtn.title = adaptShortcutText('Copy (Ctrl+C)');
        copyBtn.id = 'propCopy';
        copyBtn.textContent = '⧉ Copy';
        div.appendChild(copyBtn);

        const pasteBtn = document.createElement('button');
        pasteBtn.title = adaptShortcutText('Paste (Ctrl+V)');
        pasteBtn.id = 'propPaste';
        pasteBtn.textContent = '📋 Paste';
        div.appendChild(pasteBtn);

        sec.content.appendChild(div);
        panel.appendChild(sec.group);
    }

    // ── Transform section (for components or net shapes) ──
    const hasComponent = selection.some(s => s.definition);
    const hasNet = selection.every(s => s.type === 'net') && selection.length > 0;
    if (hasComponent || hasNet) {
        const sec = _createSection('Transform');
        const div = document.createElement('div');
        div.className = 'prop-actions';

        if (hasNet) {
            const rotLeftBtn = document.createElement('button');
            rotLeftBtn.title = 'Rotate Left';
            rotLeftBtn.id = 'propNetRotateLeft';
            rotLeftBtn.textContent = '↶ Rotate L';
            if (allLocked) rotLeftBtn.disabled = true;
            rotLeftBtn.addEventListener('click', () => {
                const cur = selection[0].orientation || 'E';
                const next = rotateNetOrientation(rotateNetOrientation(rotateNetOrientation(cur)));
                applyCommonProperty(app, 'orientation', next);
            });
            div.appendChild(rotLeftBtn);

            const rotRightBtn = document.createElement('button');
            rotRightBtn.title = 'Rotate Right';
            rotRightBtn.id = 'propNetRotateRight';
            rotRightBtn.textContent = '↷ Rotate R';
            if (allLocked) rotRightBtn.disabled = true;
            rotRightBtn.addEventListener('click', () => {
                const cur = selection[0].orientation || 'E';
                const next = rotateNetOrientation(cur);
                applyCommonProperty(app, 'orientation', next);
            });
            div.appendChild(rotRightBtn);
        }

        if (hasComponent) {
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
        }

        sec.content.appendChild(div);
        panel.appendChild(sec.group);
    }

    // ── Actions section ──
    {
        const sec = _createSection('Actions');
        const div = document.createElement('div');
        div.className = 'prop-actions';

        if (selection.length === 1 && canDecomposeRoundedCorners(selection[0]) && !allLocked) {
            const decomposeBtn = document.createElement('button');
            decomposeBtn.title = 'Convert rounded corners into editable arc edges';
            decomposeBtn.id = 'propDecomposeCorners';
            decomposeBtn.textContent = '⌒ Decompose corners';
            div.appendChild(decomposeBtn);
        }

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
    const decomposeBtn = document.getElementById('propDecomposeCorners');
    if (decomposeBtn) {
        decomposeBtn.addEventListener('click', () => {
            const sel = app.selection?.getSelection?.() || [];
            if (sel.length === 1) decomposeShapeCorners(app, sel[0]);
        });
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

/**
 * Applies a property value change to all selected items via
 * `ModifyPropertyCommand`, with duplicate reference validation for components.
 * @param {object} app - Application state.
 * @param {string} prop - Property key to modify.
 * @param {*} value - New value for the property.
 */
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
            app._alert(`Reference "${value}" is already used by another component.`, { title: 'Duplicate Reference' });
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
                app._alert(`Reference "${value}" is already used by another component.`, { title: 'Duplicate Reference' });
                app._updatePropertiesPanel(selection);
                return;
            }
        }
        // Check if any affected item is a wire label field text
        const wireLabelFields = changing.filter(s => s.parentComponent?.type === 'wire' && (s.fieldKey === 'wireLabel' || s.fieldKey === 'label'));
        if (wireLabelFields.length > 0 && value) {
            const parentWireIds = new Set(wireLabelFields.map(f => f.parentComponent.id));
            const dup = app.shapes.find(s =>
                s.type === 'wire' && !parentWireIds.has(s.id) &&
                s.wireLabel.toUpperCase() === value.toUpperCase());
            if (dup) {
                app._alert(`Wire name "${value}" is already used by another wire.`, { title: 'Duplicate Wire Name' });
                app._updatePropertiesPanel(selection);
                return;
            }
        }
    }

    // Enforce unique wire labels (via properties panel or inline edit)
    if (prop === 'wireLabel' && value) {
        const changingIds = new Set(changing.map(s => s.id));
        const dup = app.shapes.find(s =>
            s.type === 'wire' && !changingIds.has(s.id) &&
            s.wireLabel.toUpperCase() === value.toUpperCase());
        if (dup) {
            app._alert(`Wire name "${value}" is already used by another wire.`, { title: 'Duplicate Wire Name' });
            app._updatePropertiesPanel(selection);
            return;
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
        }
    }
}
