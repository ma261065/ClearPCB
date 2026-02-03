import { updateIdCounter } from '../../shapes/index.js';
import { Component } from '../../components/index.js';

export function serializeDocument(app) {
    return {
        version: '1.1',
        type: 'clearpcb-schematic',
        created: new Date().toISOString(),
        settings: {
            gridSize: app.viewport.gridSize,
            units: app.viewport.units
        },
        shapes: app.shapes.map(s => s.toJSON()),
        components: app.components.map(c => c.toJSON())
    };
}

export function loadDocument(app, data) {
    app._clearAllShapes();
    app._clearAllComponents();

    if (data.shapes && Array.isArray(data.shapes)) {
        for (const shapeData of data.shapes) {
            if (shapeData.id) {
                updateIdCounter(shapeData.id);
            }

            const shape = app._createShapeFromData(shapeData);
            if (shape) {
                app.shapes.push(shape);
                shape.render(app.viewport.scale);
                app.viewport.addContent(shape.element);
            }
        }
    }

    if (data.components && Array.isArray(data.components)) {
        for (const compData of data.components) {
            const component = app._createComponentFromData(compData);
            if (component) {
                app.components.push(component);
                const element = component.createSymbolElement();
                app.viewport.addContent(element);
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
    }

    app._updateSelectableItems();
    app.renderShapes(true);
}

export function createComponentFromData(app, data) {
    let def = app.componentLibrary.getDefinition(data.definitionName);

    if (!def && data.definition) {
        try {
            console.log('Adding embedded definition from saved file:', data.definitionName);

            if (!data.definition.symbol && (data.definition.graphics || data.definition.pins)) {
                console.log('Reconstructing symbol object for:', data.definitionName);
                data.definition.symbol = {
                    width: data.definition.width || 10,
                    height: data.definition.height || 10,
                    origin: data.definition.origin || { x: 5, y: 5 },
                    graphics: data.definition.graphics || [],
                    pins: data.definition.pins || []
                };
            }

            app.componentLibrary.addDefinition(data.definition, data.definition._source || 'User');
            def = app.componentLibrary.getDefinition(data.definitionName);
            if (def) {
                console.log('Successfully loaded embedded definition:', data.definitionName);
            }
        } catch (e) {
            console.warn('Failed to add embedded definition:', data.definitionName, e);
        }
    }

    if (!def) {
        console.warn('Component definition not found:', data.definitionName);
        return null;
    }

    return new Component(def, {
        id: data.id,
        x: data.x,
        y: data.y,
        rotation: data.rotation || 0,
        mirror: data.mirror || false,
        reference: data.reference,
        value: data.value,
        properties: data.properties
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

    app._clearAllShapes();
    app._clearAllComponents();
    app.fileManager.newDocument();
    app.viewport.resetView();
    app._updateTitle();
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
