import { updateIdCounter, resetWireLabelCounter, resetNetNameCounter } from '../../shapes/index.js';
import { Component, updateComponentIdCounter } from '../../components/index.js';
import { createNetText } from './shape-management.js';
import { attachLabelToTarget } from '../../ui/modules/label-attachment.js';

/**
 * Serializes the entire document (shapes, components, settings, paper size,
 * title block) into a JSON-ready object with deduplicated component definitions.
 * @param {object} app - Application state.
 * @returns {object} Serialized document object.
 */
export function serializeDocument(app) {
    const components = app.components.map(c => c.toJSON());

    // Keep Net text as derived data (recreated/relinked on load)
    // so net name/font/offset are persisted only on the Net shape.
    const serializedShapes = app.shapes
        .filter(s => !(s.type === 'text' && s.fieldKey === 'net' && s.parentComponent?.type === 'net'))
        .map(s => s.toJSON());

    // Deduplicate definitions: extract into a top-level map so each
    // unique definition is stored only once instead of per-instance.
    const defs = {};
    for (const comp of components) {
        if (comp.def && comp.dn) {
            if (!defs[comp.dn]) {
                defs[comp.dn] = comp.def;
            }
            delete comp.def;
        }
    }

    const doc = {
        version: '2.0',
        type: 'clearpcb-project',
        created: new Date().toISOString(),
        schematic: {
            settings: {
                gridSize: app.viewport.gridSize,
                units: app.viewport.units,
                paperSize: app.viewport.paperSizeKey || null,
                paperOrientation: app.viewport.paperSize
                    ? (app.viewport.paperSize.width >= app.viewport.paperSize.height ? 'landscape' : 'portrait')
                    : null,
                titleBlock: app.viewport.showTitleBlock || false,
                titleBlockInfo: app.viewport.showTitleBlockInfo || false,
                titleBlockData: app.viewport.titleBlockData || {}
            },
            shapes: serializedShapes,
            components
        }
    };

    if (Object.keys(defs).length > 0) {
        doc.schematic.defs = defs;
    }

    return doc;
}

/**
 * Clears the canvas and reconstitutes all shapes, components, and settings
 * from a saved document object.
 * @param {object} app - Application state.
 * @param {object} data - Previously serialized document.
 */
export async function loadDocument(app, data) {
    app.selection.clearSelection();
    if (app.textEdit?.shape) app._endTextEdit(false);
    app._clearAllShapes();
    app._clearAllComponents();
    resetWireLabelCounter();
    resetNetNameCounter();

    // Unified project format (v2.0)
    const sch = data.schematic || {};
    const shapes = sch.shapes;
    const components = sch.components;
    const settings = sch.settings;
    const defs = sch.defs;

    if (shapes && Array.isArray(shapes)) {
        for (const shapeData of shapes) {
            const compId = shapeData.cid || shapeData.componentId;
            const fieldKey = shapeData.fk || shapeData.fieldKey;

            // Net field text is derived and not part of persisted schema.
            if (fieldKey === 'net') {
                continue;
            }

            if (shapeData.id) {
                updateIdCounter(shapeData.id);
            }

            const shape = app._createShapeFromData(shapeData);
            if (shape) {
                // Preserve component field linkage for re-linking after components load
                if (compId && fieldKey) {
                    shape._pendingComponentId = compId;
                    shape.fieldKey = fieldKey;
                }
                app.shapes.push(shape);
                shape.render(app.viewport.scale);
                app.viewport.addContent(shape.element);
            }
        }
    }

    // Resolve deduplicated definitions from top-level map
    if (defs && components) {
        for (const compData of components) {
            const dn = compData.dn || compData.definitionName;
            if (!compData.def && !compData.definition && dn && defs[dn]) {
                compData.def = defs[dn];
            }
        }
    }

    if (components && Array.isArray(components)) {
        for (const compData of components) {
            if (compData.id) updateComponentIdCounter(compData.id);
            const component = app._createComponentFromData(compData);
            if (component) {
                app.components.push(component);
                const element = component.createSymbolElement();
                app.viewport.addComponentContent(element);
                
                // Re-link field texts from loaded shapes
                component.linkFieldTexts(app.shapes);
            }
        }
    }

    // Re-link only derived Net text (wire names are handled as generic labels)
    for (const shape of app.shapes) {
        if (shape.type === 'net') {
            createNetText(app, shape);
        }
    }

    const linkTargets = new Map();
    for (const shape of app.shapes) linkTargets.set(shape.id, shape);
    for (const component of app.components) linkTargets.set(component.id, component);
    for (const shape of app.shapes) {
        if (shape.type !== 'text' || !shape._pendingComponentId) continue;
        if (shape.fieldKey !== 'label') continue;
        const target = linkTargets.get(shape._pendingComponentId);
        if (!target) continue;
        attachLabelToTarget(shape, target, { x: shape.x, y: shape.y });

        delete shape._pendingComponentId;
    }

    if (settings) {
        if (settings.gridSize) {
            app.viewport.setGridSize(settings.gridSize);
            if (app.ui.gridSize) {
                app.ui.gridSize.value = settings.gridSize;
            }
        }
        if (settings.units) {
            app.viewport.setUnits(settings.units);
            if (app.ui.units) {
                app.ui.units.value = settings.units;
            }
            if (typeof app._updateGridDropdown === 'function') {
                app._updateGridDropdown();
            }
        }
        // Restore paper size, orientation, and title block from file
        if (settings.paperSize) {
            const paperSelect = /** @type {HTMLSelectElement|null} */ (document.getElementById('paperSize'));
            const orientationSelect = /** @type {HTMLSelectElement|null} */ (document.getElementById('paperOrientation'));
            const titleBlockCheckbox = /** @type {HTMLInputElement|null} */ (document.getElementById('showTitleBlock'));
            const orientation = settings.paperOrientation || 'landscape';
            if (paperSelect) paperSelect.value = settings.paperSize;
            if (orientationSelect) orientationSelect.value = orientation;
            // Trigger paper display update via the same path as UI
            const { PAPER_SIZES } = await import('../../ui/modules/paper.js');
            if (PAPER_SIZES[settings.paperSize]) {
                let size = { ...PAPER_SIZES[settings.paperSize] };
                if (orientation === 'portrait') {
                    if (size.width > size.height) [size.width, size.height] = [size.height, size.width];
                } else {
                    if (size.width < size.height) [size.width, size.height] = [size.height, size.width];
                }
                app.viewport.setPaperSize(size, settings.paperSize);
                localStorage.setItem('clearpcb_paper_size', settings.paperSize);
                localStorage.setItem('clearpcb_paper_orientation', orientation);
            }
            const showTitleBlock = settings.titleBlock || false;
            app.viewport.setTitleBlock(showTitleBlock);
            if (titleBlockCheckbox) titleBlockCheckbox.checked = showTitleBlock;
            localStorage.setItem('clearpcb_title_block', String(showTitleBlock));
            // Restore title block info box state
            const showTitleBlockInfo = settings.titleBlockInfo || false;
            const titleBlockInfoCheckbox = /** @type {HTMLInputElement|null} */ (document.getElementById('showTitleBlockInfo'));
            app.viewport.setTitleBlockInfo(showTitleBlockInfo);
            if (titleBlockInfoCheckbox) titleBlockInfoCheckbox.checked = showTitleBlockInfo;
            localStorage.setItem('clearpcb_title_block_info', String(showTitleBlockInfo));
            // Restore title block info data
            if (settings.titleBlockData) {
                app.viewport.setTitleBlockData(settings.titleBlockData);
            }
        }
    }

    app._updateSelectableItems();
    app.renderShapes(true);
}

/**
 * Creates a `Component` instance from serialized data, resolving definitions
 * from the library or embedding them if missing.
 * @param {object} app - Application state.
 * @param {object} data - Serialized component data.
 * @returns {import('../../components/Component.js').Component|null} The created component, or `null` if definition not found.
 */
export function createComponentFromData(app, data) {
    const dn = data.dn || data.definitionName;
    const def_data = data.def || data.definition;
    let def = app.componentLibrary.getDefinition(dn);

    if (!def && def_data) {
        try {
            console.log('Adding embedded definition from saved file:', dn);

            if (!def_data.symbol && (def_data.graphics || def_data.pins)) {
                console.log('Reconstructing symbol object for:', dn);
                def_data.symbol = {
                    width: def_data.width || 10,
                    height: def_data.height || 10,
                    origin: def_data.origin || { x: 5, y: 5 },
                    graphics: def_data.graphics || [],
                    pins: def_data.pins || []
                };
            }

            app.componentLibrary.addDefinition(def_data, def_data._source || 'User');
            def = app.componentLibrary.getDefinition(dn);
            if (def) {
                console.log('Successfully loaded embedded definition:', dn);
            }
        } catch (e) {
            console.warn('Failed to add embedded definition:', dn, e);
        }
    }

    if (!def) {
        console.warn('Component definition not found:', dn);
        return null;
    }

    return new Component(def, {
        id: data.id,
        x: data.x,
        y: data.y,
        rotation: data.rot ?? data.rotation ?? 0,
        mirror: data.mir ?? data.mirror ?? false,
        reference: data.ref ?? data.reference,
        value: data.val ?? data.value,
        showReference: data.sr ?? data.showReference,
        showValue: data.sv ?? data.showValue,
        properties: data.props ?? data.properties,
        visible: data.v ?? data.visible,
        locked: data.lk ?? data.locked,
    });
}

/**
 * Updates `document.title` and the UI title element with the file name
 * and dirty indicator (`•`).
 * @param {object} app - Application state.
 */
export function updateTitle(app) {
    const dirty = app.fileManager.isDirty ? '•' : '';
    // Format: ClearPCB (•mike.json) or ClearPCB (mike.json)
    const title = `ClearPCB (${dirty}${app.fileManager.fileName})`;
    document.title = title;

    if (app.ui.docTitle) {
        app.ui.docTitle.textContent = `${dirty}${app.fileManager.fileName}`;
        app.ui.docTitle.title = app.fileManager.filePath || app.fileManager.fileName;
    }
}

/**
 * Checks for auto-saved content on startup and prompts the user to recover
 * or discard it.
 * @param {object} app - Application state.
 */
export async function checkAutoSave(app) {
    if (app.fileManager.hasAutoSave()) {
        const saved = app.fileManager.loadAutoSave();
        if (saved && saved.data) {
            const hasContent = (saved.data.shapes && saved.data.shapes.length > 0) ||
                               (saved.data.components && saved.data.components.length > 0);
            if (hasContent) {
                const time = new Date(saved.timestamp).toLocaleString();
                if (await app._confirm(`Found auto-saved content from ${time}.\n\nRecover it?`, { title: 'Recover Autosave', okText: 'Yes', cancelText: 'No' })) {
                    await app._loadDocument(saved.data);
                    app.fileManager.setDirty(true);
                    console.log('Recovered auto-saved content');
                } else {
                    app.fileManager.clearAutoSave();
                }
            }
        }
    }
}

/**
 * Fetches `version.json` and displays the version number in the UI.
 * @param {object} app - Application state.
 */
export async function loadVersion(app) {
    try {
        const paths = [
            './assets/version.json',
            '/assets/version.json',
            '../assets/version.json'
        ];

        let data = null;
        for (const path of paths) {
            try {
                const response = await fetch(path);
                if (response.ok) {
                    data = await response.json();
                    break;
                }
            } catch (e) {
                // Continue to next path
            }
        }

        if (data) {
            const versionDisplay = document.getElementById('version-display');
            if (versionDisplay) {
                versionDisplay.textContent = `v${data.version}`;
            }
        }
    } catch (err) {
        console.error('Failed to load version:', err);
    }
}

/**
 * Creates a new blank document, clearing all shapes/components and resetting
 * title block defaults. Prompts if there are unsaved changes.
 * @param {object} app - Application state.
 */
export async function newFile(app) {
    if (app.fileManager.isDirty) {
        if (!await app._confirm('You have unsaved changes. Create new document anyway?', { title: 'Unsaved Changes', okText: 'Yes', cancelText: 'No', defaultCancel: true })) {
            return;
        }
    }

    app.selection.clearSelection();
    if (app.textEdit?.shape) app._endTextEdit(false);
    app._clearAllShapes();
    app._clearAllComponents();
    resetWireLabelCounter();
    resetNetNameCounter();
    app.fileManager.newDocument();
    app.viewport.resetView();

    // Reset title block to defaults (preserve persisted user-identity fields)
    app.viewport.setTitleBlockData({
        title: '',
        rev: '',
        sheet: '1/1',
        date: new Date().toLocaleDateString(),
        company: localStorage.getItem('clearpcb_tb_company') || '',
        drawnBy: localStorage.getItem('clearpcb_tb_drawnBy') || ''
    });

    app._updateTitle();
    app.invalidate?.();
    console.log('New document created');
}

/**
 * Serializes and saves the document using the file manager. Shows toast on success.
 * @param {object} app - Application state.
 * @returns {Promise<{success: boolean, fileName?: string, error?: string}>}
 */
export async function saveFile(app) {
    const data = app._serializeDocument();
    const result = await app.fileManager.save(data);

    if (result.success) {
        app._updateTitle();
        app._showSaveToast?.('Saved');
        console.log('Saved:', result.fileName);
    } else if (!result.cancelled) {
        app._alert('Failed to save: ' + (result.error || 'Unknown error'), { title: 'Save Failed' });
    }

    return result;
}

/**
 * Serializes and saves the document with a new file name/location ("Save As").
 * @param {object} app - Application state.
 * @returns {Promise<{success: boolean, fileName?: string, error?: string}>}
 */
export async function saveFileAs(app) {
    const data = app._serializeDocument();
    const result = await app.fileManager.saveAs(data);

    if (result.success) {
        app._updateTitle();
        app._showSaveToast?.('Saved');
        console.log('Saved as:', result.fileName);
    } else if (!result.cancelled) {
        app._alert('Failed to save: ' + (result.error || 'Unknown error'), { title: 'Save Failed' });
    }

    return result;
}

/**
 * Opens a file via the file manager, loads its data, and updates the title.
 * Prompts if there are unsaved changes.
 * @param {object} app - Application state.
 */
export async function openFile(app) {
    if (app.fileManager.isDirty) {
        if (!await app._confirm('You have unsaved changes. Open another file anyway?', { title: 'Unsaved Changes', okText: 'Yes', cancelText: 'No', defaultCancel: true })) {
            return;
        }
    }

    try {
        const result = await app.fileManager.open();

        if (result.success) {
            await app._loadDocument(result.data);
            app._fitToContent?.();
            app._updateTitle();
            app.fileManager.clearAutoSave();
            console.log('Opened:', result.fileName);
        } else if (result.error) {
            app._alert('Failed to open: ' + result.error, { title: 'Open Failed' });
        }
    } catch (err) {
        app._alert('Failed to open file: ' + err.message, { title: 'Open Failed' });
    }
}
