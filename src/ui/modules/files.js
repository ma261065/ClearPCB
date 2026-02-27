import { updateIdCounter } from '../../shapes/index.js';
import { Component, updateComponentIdCounter } from '../../components/index.js';

export function serializeDocument(app) {
    const components = app.components.map(c => c.toJSON());

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
        version: '1.2',
        type: 'clearpcb-schematic',
        created: new Date().toISOString(),
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
        shapes: app.shapes.map(s => s.toJSON()),
        components
    };

    if (Object.keys(defs).length > 0) {
        doc.defs = defs;
    }

    return doc;
}

export async function loadDocument(app, data) {
    app.selection.clearSelection();
    if (app.textEdit?.shape) app._endTextEdit(false);
    app._clearAllShapes();
    app._clearAllComponents();

    if (data.shapes && Array.isArray(data.shapes)) {
        for (const shapeData of data.shapes) {
            if (shapeData.id) {
                updateIdCounter(shapeData.id);
            }

            const shape = app._createShapeFromData(shapeData);
            if (shape) {
                // Preserve component field linkage for re-linking after components load
                const compId = shapeData.cid || shapeData.componentId;
                const fieldKey = shapeData.fk || shapeData.fieldKey;
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
    const defsMap = data.defs || data.definitions;
    if (defsMap && data.components) {
        for (const compData of data.components) {
            const dn = compData.dn || compData.definitionName;
            if (!compData.def && !compData.definition && dn && defsMap[dn]) {
                compData.def = defsMap[dn];
            }
        }
    }

    if (data.components && Array.isArray(data.components)) {
        for (const compData of data.components) {
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

    if (data.settings) {
        if (data.settings.gridSize) {
            app.viewport.setGridSize(data.settings.gridSize);
            if (app.ui.gridSize) {
                app.ui.gridSize.value = data.settings.gridSize;
            }
        }
        if (data.settings.units) {
            app.viewport.setUnits(data.settings.units);
            if (app.ui.units) {
                app.ui.units.value = data.settings.units;
            }
            if (typeof app._updateGridDropdown === 'function') {
                app._updateGridDropdown();
            }
        }
        // Restore paper size, orientation, and title block from file
        if (data.settings.paperSize) {
            const paperSelect = document.getElementById('paperSize');
            const orientationSelect = document.getElementById('paperOrientation');
            const titleBlockCheckbox = document.getElementById('showTitleBlock');
            const orientation = data.settings.paperOrientation || 'landscape';
            if (paperSelect) paperSelect.value = data.settings.paperSize;
            if (orientationSelect) orientationSelect.value = orientation;
            // Trigger paper display update via the same path as UI
            const { PAPER_SIZES } = await import('./paper.js');
            if (PAPER_SIZES[data.settings.paperSize]) {
                let size = { ...PAPER_SIZES[data.settings.paperSize] };
                if (orientation === 'portrait') {
                    if (size.width > size.height) [size.width, size.height] = [size.height, size.width];
                } else {
                    if (size.width < size.height) [size.width, size.height] = [size.height, size.width];
                }
                app.viewport.setPaperSize(size, data.settings.paperSize);
                localStorage.setItem('clearpcb_paper_size', data.settings.paperSize);
                localStorage.setItem('clearpcb_paper_orientation', orientation);
            }
            const showTitleBlock = data.settings.titleBlock || false;
            app.viewport.setTitleBlock(showTitleBlock);
            if (titleBlockCheckbox) titleBlockCheckbox.checked = showTitleBlock;
            localStorage.setItem('clearpcb_title_block', String(showTitleBlock));
            // Restore title block info box state
            const showTitleBlockInfo = data.settings.titleBlockInfo || false;
            const titleBlockInfoCheckbox = document.getElementById('showTitleBlockInfo');
            app.viewport.setTitleBlockInfo(showTitleBlockInfo);
            if (titleBlockInfoCheckbox) titleBlockInfoCheckbox.checked = showTitleBlockInfo;
            localStorage.setItem('clearpcb_title_block_info', String(showTitleBlockInfo));
            // Restore title block info data
            if (data.settings.titleBlockData) {
                app.viewport.setTitleBlockData(data.settings.titleBlockData);
            }
        }
    }

    app._updateSelectableItems();
    app.renderShapes(true);
}

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

export function checkAutoSave(app) {
    if (app.fileManager.hasAutoSave()) {
        const saved = app.fileManager.loadAutoSave();
        if (saved && saved.data) {
            const hasContent = (saved.data.shapes && saved.data.shapes.length > 0) ||
                               (saved.data.components && saved.data.components.length > 0);
            if (hasContent) {
                const time = new Date(saved.timestamp).toLocaleString();
                if (confirm(`Found auto-saved content from ${time}.\n\nRecover it?`)) {
                    app._loadDocument(saved.data);
                    app.fileManager.setDirty(true);
                    console.log('Recovered auto-saved content');
                } else {
                    app.fileManager.clearAutoSave();
                }
            }
        }
    }
}

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

export async function newFile(app) {
    if (app.fileManager.isDirty) {
        if (!confirm('You have unsaved changes. Create new document anyway?')) {
            return;
        }
    }

    app.selection.clearSelection();
    if (app.textEdit?.shape) app._endTextEdit(false);
    app._clearAllShapes();
    app._clearAllComponents();
    app.fileManager.newDocument();
    app.viewport.resetView();

    // Reset title block to defaults (preserve persisted user-identity fields)
    app.viewport.titleBlockData.title = '';
    app.viewport.titleBlockData.rev = '';
    app.viewport.titleBlockData.sheet = '1/1';
    app.viewport.titleBlockData.date = new Date().toLocaleDateString();
    app.viewport.titleBlockData.company = localStorage.getItem('clearpcb_tb_company') || '';
    app.viewport.titleBlockData.drawnBy = localStorage.getItem('clearpcb_tb_drawnBy') || '';

    app._updateTitle();
    app.invalidate?.();
    console.log('New document created');
}

export async function saveFile(app) {
    const data = app._serializeDocument();
    const result = await app.fileManager.save(data);

    if (result.success) {
        app._updateTitle();
        app._showSaveToast?.('Saved');
        console.log('Saved:', result.fileName);
    } else if (!result.cancelled) {
        alert('Failed to save: ' + (result.error || 'Unknown error'));
    }

    return result;
}

export async function saveFileAs(app) {
    const data = app._serializeDocument();
    const result = await app.fileManager.saveAs(data);

    if (result.success) {
        app._updateTitle();
        app._showSaveToast?.('Saved');
        console.log('Saved as:', result.fileName);
    } else if (!result.cancelled) {
        alert('Failed to save: ' + (result.error || 'Unknown error'));
    }

    return result;
}

export async function openFile(app) {
    if (app.fileManager.isDirty) {
        if (!confirm('You have unsaved changes. Open another file anyway?')) {
            return;
        }
    }

    try {
        const result = await app.fileManager.open();

        if (result.success) {
            app._loadDocument(result.data);
            app._updateTitle();
            app.fileManager.clearAutoSave();
            console.log('Opened:', result.fileName);
        } else if (result.error) {
            alert('Failed to open: ' + result.error);
        }
    } catch (err) {
        alert('Failed to open file: ' + err.message);
    }
}
