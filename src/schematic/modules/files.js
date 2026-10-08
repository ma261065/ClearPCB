import { resetWireLabelCounter, resetNetNameCounter } from '../../shapes/index.js';
import { createNetText } from './shape-management.js';
import { discardComponentView, discardShapeView, mountDocument, prepareDocumentView } from './schematic-view.js';
import { attachLabelToTarget } from './label-attachment.js';
import { importEasyEDASchematic } from '../../easyeda/schematic-importer.js';
import { deserializeComponent } from '../../core/SchematicDocument.js';
import { serializeGridSettings, restoreGridSettings } from '../../shared/ui/viewport.js';
import { cancelSchematicInteractions } from './schematic-interaction-routing.js';
import { cancelSchematicPropertyPreview } from './properties.js';
import { errorMessage } from '../../core/errors.js';
import { duplicateIdRepairMessage, repairDuplicateIds } from '../../core/project-format.js';
import { showSaveToast } from './ribbon.js';
import { updateUndoRedoButtons } from './ui-utils.js';
import { getSchematicTextEdit } from './text-edit.js';
import { isTextItem as isTextShape } from '../../core/schematic-items.js';
/** @typedef {import('./schematic-editor-api.js').SchematicEditor} SchematicEditor */
/** @typedef {import('../../core/ProjectDocument.js').ProjectData} ProjectData */
/** @typedef {{data: ProjectData, fileName: string, handle?: any, filePath?: string|null}} OpenSuccess */
/** @typedef {import('../../core/FileManager.js').OpenResult} OpenResult */
/** @typedef {import('../../core/FileManager.js').SaveResult} SaveResult */
/** @typedef {import('../../core/SchematicDocument.js').SchematicItem} SchematicItem */
/** @typedef {import('../../shapes/text.js').Text} Text */

/** @param {SchematicEditor} app */
function canReplaceDocument(app) {
    if (!app.fileManager.saving && !app.fileManager.loading) return true;
    app.alert('Wait for the current file operation to finish.', { title: 'File Operation In Progress' });
    return false;
}

/**
 * Serializes the entire document (shapes, components, settings, paper size,
 * title block) into a JSON-ready object with deduplicated component definitions.
 * @param {SchematicEditor} app
 * @returns {ProjectData} Serialized document object.
 */
export function serializeDocument(app) {
    return /** @type {ProjectData} */ (app.document.serialize(serializeViewSettings(app.viewport)));
}

/** @param {SchematicEditor} app @returns {ProjectData} */
export function serializeProjectDocument(app) {
    return /** @type {ProjectData} */ (app.project ? app.project.serialize() : app.serializeSection());
}

/**
 * Capture view preferences without accessing authored content or creating a viewport.
 * @param {any} viewport
 */
export function serializeViewSettings(viewport) {
    if (!viewport) return undefined;
    return {
        ...serializeGridSettings(viewport),
        paperSize: viewport.paperSizeKey || null,
        paperOrientation: viewport.paperSize
            ? (viewport.paperSize.width >= viewport.paperSize.height ? 'landscape' : 'portrait')
            : null,
        titleBlock: viewport.showTitleBlock || false,
        titleBlockInfo: viewport.showTitleBlockInfo || false,
        titleBlockData: structuredClone(viewport.titleBlockData || {}),
    };
}

/**
 * Prepare model data and its SVG before replacing the live editor content.
 * @param {SchematicEditor} app
 * @param {ProjectData} data - Previously serialized document.
 */
export function prepareDocument(app, data) {
    const prepared = app.document.prepare(data, name => app.componentLibrary.getDefinition(name));
    prepareDocumentView(app, prepared);
    return prepared;
}

/** @param {SchematicEditor} app @param {ProjectData} data @param {ReturnType<typeof prepareDocument>} [prepared] */
export async function loadDocument(app, data, prepared = prepareDocument(app, data)) {
    data = prepared.data || data;
    app.selection.clearSelection();
    if (getSchematicTextEdit(app)?.shape) app.endTextEdit(false);
    clearAllShapes(app);
    clearAllComponents(app);
    app.document.load(data, prepared);

    // Unified project format (v2.0)
    const sch = data.schematic || {};
    const settings = sch.settings;

    mountDocument(app);

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
        if (!isTextShape(shape) || !shape._pendingComponentId) continue;
        if (shape.fieldKey !== 'label') continue;
        const target = linkTargets.get(shape._pendingComponentId);
        if (!target) continue;
        attachLabelToTarget(shape, target, { x: shape.x, y: shape.y });

        delete shape._pendingComponentId;
    }

    if (settings) {
        restoreGridSettings(app, settings);
        // Restore paper size, orientation, and title block from file
        if (settings.paperSize && typeof settings.paperSize === 'string') {
            const orientation = settings.paperOrientation || 'landscape';
            // Trigger paper display update via the same path as UI
            const { getPaperSize } = await import('./paper.js');
            const paperSize = getPaperSize(settings.paperSize);
            if (paperSize) {
                let size = { ...paperSize };
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
            localStorage.setItem('clearpcb_title_block', String(showTitleBlock));
            // Restore title block info box state
            const showTitleBlockInfo = settings.titleBlockInfo || false;
            app.viewport.setTitleBlockInfo(showTitleBlockInfo);
            localStorage.setItem('clearpcb_title_block_info', String(showTitleBlockInfo));
            app.refreshRibbon?.();
        }
        // The title block's text belongs to the document, with or without a paper size.
        if (settings.titleBlockData) {
            app.viewport.setTitleBlockData(settings.titleBlockData);
        }
    }

    app.updateSelectableItems();
    app.renderShapes(true);

    // NB: the PCB section is restored by ProjectDocument after this
    // schematic section loads, so neither view reaches into the other.
}

/** @param {SchematicEditor} app @param {ProjectData} data */
export async function loadProjectDocument(app, data) {
    if (app.project) {
        await app.project.load(data);
    } else {
        await app.loadSection(data);
    }
}

/** @param {SchematicEditor} app @param {'new'|'open'|'import'} reason */
export function notifyDocumentReplaced(app, reason) {
    if (app.project) app.project.notifyDocumentReplaced(reason);
    else app.onDocumentReplaced();
}

/** @param {SchematicEditor} app */
export function clearAllShapes(app) {
    for (const shape of app.shapes) discardShapeView(app, shape);
    app.shapes = [];
    app.updateSelectableItems();
    app.history.clear();
    updateUndoRedoButtons(app);
}

/** @param {SchematicEditor} app */
export function clearAllComponents(app) {
    for (const comp of app.components) {
        // Remove field texts from shapes array and DOM
        for (const ft of comp.getFieldTexts()) {
            const idx = app.shapes.indexOf(ft);
            if (idx !== -1) app.shapes.splice(idx, 1);
            discardShapeView(app, ft);
        }
        discardComponentView(app, comp);
    }
    app.components = [];
    app.updateSelectableItems();
}

/**
 * Creates a `Component` instance from serialized data, resolving definitions
 * from the library or embedding them if missing.
 * @param {SchematicEditor} app
 * @param {object} data - Serialized component data.
 * @returns {import('../../components/Component.js').Component|null} The created component, or `null` if definition not found.
 */
export function createComponentFromData(app, data) {
    return deserializeComponent(data, name => app.componentLibrary.getDefinition(name));
}

/**
 * Updates `document.title` and the UI title element with the file name
 * and dirty indicator (`•`).
 * @param {SchematicEditor} app
 */
export function updateTitle(app) {
    // Reflect the aggregate project dirty state (schematic file-manager dirty
    // OR any view section dirty, e.g. PCB-only edits) so the dot appears for
    // edits made in either editor. Falls back to the file-manager flag when
    // there is no project facade (standalone schematic).
    const isDirty = app.project ? app.project.isDirty : app.fileManager.isDirty;
    const dirty = isDirty ? '•' : '';
    // Format: ClearPCB (•mike.json) or ClearPCB (mike.json)
    const title = `ClearPCB (${dirty}${app.fileManager.fileName})`;
    document.title = title;
    const path = app.fileManager.filePath || app.fileManager.fileName;
    const autoSaveSize = app.fileManager.autoSaveSize;
    const formattedSize = typeof autoSaveSize === 'number' && Number.isFinite(autoSaveSize)
        ? autoSaveSize < 1024
            ? `${autoSaveSize} B`
            : autoSaveSize < 1024 * 1024
                ? `${(autoSaveSize / 1024).toFixed(1)} KB`
                : `${(autoSaveSize / (1024 * 1024)).toFixed(1)} MB`
        : 'None';
    const tooltip = `${path}\nAutosave size: ${formattedSize}`;

    if (app.ui.docTitle) {
        app.ui.docTitle.textContent = `${dirty}${app.fileManager.fileName}`;
        app.ui.docTitle.title = tooltip;
    }

    // Mirror the filename into the PCB editor's status bar so both editors
    // (one shared document) show the same name + dirty indicator.
    const pcbDocTitle = document.getElementById('pcbDocTitle');
    if (pcbDocTitle) {
        pcbDocTitle.textContent = `${dirty}${app.fileManager.fileName}`;
        pcbDocTitle.title = tooltip;
    }
}

/**
 * Checks for auto-saved content on startup and prompts the user to recover
 * or discard it.
 * @param {SchematicEditor} app
 */
export async function checkAutoSave(app) {
    if (app.fileManager.hasAutoSave()) {
        const saved = app.fileManager.loadAutoSave();
        if (saved && saved.data) {
            const hasContent = (saved.data.shapes && saved.data.shapes.length > 0) ||
                               (saved.data.components && saved.data.components.length > 0);
            if (hasContent) {
                const time = new Date(saved.timestamp).toLocaleString();
                const recoveryChoice = await app.confirm(
                    `Found auto-saved content from ${time}.\n\nRecover it? Choosing No permanently deletes this autosave. Your last fully saved file on disk is unchanged.`,
                    { title: 'Recover Autosave', okText: 'Yes', cancelText: 'No - Delete Autosave', showClose: true, escapeResult: null },
                );
                if (recoveryChoice === true) {
                    await loadProjectDocument(app, saved.data);
                    app.fileManager.setDirty(true);
                    console.log('Recovered auto-saved content');
                } else if (recoveryChoice === false) {
                    app.fileManager.clearAutoSave();
                }
            }
        }
    }
}

/**
 * Fetches `version.json` and displays the version number in the UI.
 * @param {SchematicEditor} app
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
                const response = await fetch(path, { cache: 'no-cache' });
                if (response.ok) {
                    data = await response.json();
                    break;
                }
            } catch (e) {
                // Continue to next path
            }
        }

        if (data) {
            for (const id of ['version-display', 'pcb-version-display']) {
                const versionDisplay = document.getElementById(id);
                if (versionDisplay) versionDisplay.textContent = `v${data.version}`;
            }
        }
    } catch (err) {
        console.error('Failed to load version:', err);
    }
}

/**
 * Clear only the schematic section, retaining paper/grid preferences.
 * @param {SchematicEditor} app
 */
export function clearDocument(app) {
    cancelSchematicPropertyPreview(app);
    cancelSchematicInteractions(app);
    if (app.isSectionEditing()) throw new Error('Finish the current edit before creating a new document.');
    app.selection.clearSelection();
    clearAllShapes(app);
    clearAllComponents(app);
    resetWireLabelCounter();
    resetNetNameCounter();
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
}

/**
 * Confirm New in the UI, then let the project coordinate both editors.
 * @param {SchematicEditor} app
 */
export async function newFile(app) {
    if (!canReplaceDocument(app)) return;
    if (app.project?.isDirty ?? app.fileManager.isDirty) {
        if (!await app.confirm('You have unsaved changes. Create new document anyway?', { title: 'Unsaved Changes', okText: 'Yes', cancelText: 'No', defaultCancel: true })) {
            return;
        }
    }
    if (!canReplaceDocument(app)) return;
    try {
        if (app.project) await app.project.reset();
        else {
            clearDocument(app);
            app.fileManager.newDocument(/** @type {Parameters<typeof app.fileManager.newDocument>[0]} */ (serializeDocument(app)));
        }
        updateTitle(app);
        notifyDocumentReplaced(app, 'new');
        console.log('New document created');
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        app.alert('Failed to create new document: ' + message, { title: 'New Failed' });
    }
}

/**
 * Serializes and saves the document using the file manager. Shows toast on success.
 * @param {SchematicEditor} app
 * @returns {Promise<SaveResult>}
 */
export async function saveFile(app) {
    const result = await writeDocument(app, false);

    if (result.success) {
        // Saving writes the WHOLE document, so every section is now clean.
        // Clear per-view dirty flags (e.g. the PCB's) too, otherwise they
        // keep re-triggering autosave and the unsaved warning after a save.
        if (result.clean) app.project?.markAllSectionsClean?.();
        updateTitle(app);
        showSaveToast(app, 'Saved');
        console.log('Saved:', result.fileName);
    } else if (result.errorName === 'NotAllowedError' || result.errorName === 'SecurityError') {
        const retry = await app.confirm(
            'The browser could not write to the current file. Your changes are still open and unsaved. Choose Save As to grant access to a file again, or save a new copy in another folder.',
            { title: 'File Access Required', okText: 'Save As', cancelText: 'Cancel' });
        if (retry) return saveFileAs(app);
    } else if (!result.cancelled) {
        app.alert('Failed to save: ' + (result.error || 'Unknown error'), { title: 'Save Failed' });
    }

    return result;
}

/**
 * Serializes and saves the document with a new file name/location ("Save As").
 * @param {SchematicEditor} app
 * @returns {Promise<SaveResult>}
 */
export async function saveFileAs(app) {
    const result = await writeDocument(app, true);

    if (result.success) {
        // Saving writes the WHOLE document, so every section is now clean.
        if (result.clean) app.project?.markAllSectionsClean?.();
        updateTitle(app);
        showSaveToast(app, 'Saved');
        console.log('Saved as:', result.fileName);
    } else if (!result.cancelled) {
        app.alert('Failed to save: ' + (result.error || 'Unknown error'), { title: 'Save Failed' });
    }

    return result;
}

/**
 * @param {SchematicEditor} app
 * @param {boolean} saveAs
 * @returns {Promise<SaveResult>}
 */
async function writeDocument(app, saveAs) {
    let data;
    try {
        data = serializeProjectDocument(app);
    } catch (error) {
        console.error('Save snapshot failed:', error);
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
    return /** @type {Promise<SaveResult>} */ (saveAs ? app.fileManager.saveAs(data) : app.fileManager.save(data));
}

/**
 * Load an opened project and adopt its file identity. Duplicate ids left by older
 * builds are repaired first; the document is then marked unsaved so the fix can be kept.
 * @param {SchematicEditor} app
 * @param {OpenSuccess} result - A successful open result.
 */
export async function loadOpenedProject(app, result) {
    const repaired = repairDuplicateIds(result.data);
    await loadProjectDocument(app, repaired.data);
    await app.fileManager.adoptOpen(result);
    app.fitToContent();
    updateTitle(app);
    app.fileManager.clearAutoSave(result.fileName);
    notifyDocumentReplaced(app, 'open');
    const message = duplicateIdRepairMessage(repaired);
    if (message) {
        app.fileManager.setDirty(true);
        await app.alert(`Opened ${result.fileName}. ${message}`, { title: 'File Repaired' });
    }
}

/**
 * Opens a file via the file manager, loads its data, and updates the title.
 * Prompts if there are unsaved changes.
 * @param {SchematicEditor} app
 */
export async function openFile(app) {
    if (!canReplaceDocument(app)) return;
    if (app.project?.isDirty ?? app.fileManager.isDirty) {
        if (!await app.confirm('You have unsaved changes. Open another file anyway?', { title: 'Unsaved Changes', okText: 'Yes', cancelText: 'No', defaultCancel: true })) {
            return;
        }
    }

    try {
        const result = /** @type {OpenResult} */ (await app.fileManager.open());

        if (result.success) {
            await loadOpenedProject(app, /** @type {OpenSuccess} */ (result));
            console.log('Opened:', result.fileName);
        } else if (result.error) {
            app.alert('Failed to open: ' + result.error, { title: 'Open Failed' });
        }
    } catch (err) {
        app.alert('Failed to open file: ' + errorMessage(err), { title: 'Open Failed' });
    }
}

/**
 * Re-open a file from the recents list (Open ▾ dropdown) without showing the
 * file picker. Mirrors {@link openFile} but routes through
 * `fileManager.openRecent(name)`, which reuses the stored handle.
 * @param {SchematicEditor} app
 * @param {string} name - The recents entry / file name to reopen.
 */
export async function openRecentFile(app, name) {
    if (!canReplaceDocument(app)) return;
    if (app.project?.isDirty ?? app.fileManager.isDirty) {
        if (!await app.confirm('You have unsaved changes. Open another file anyway?', { title: 'Unsaved Changes', okText: 'Yes', cancelText: 'No', defaultCancel: true })) {
            return;
        }
    }

    try {
        const result = /** @type {OpenResult} */ (await app.fileManager.openRecent(name));

        if (result.success) {
            await loadOpenedProject(app, /** @type {OpenSuccess} */ (result));
            console.log('Opened recent:', result.fileName);
        } else if (result.error) {
            app.alert('Failed to open: ' + result.error, { title: 'Open Failed' });
        }
    } catch (err) {
        app.alert('Failed to open file: ' + errorMessage(err), { title: 'Open Failed' });
    }
}

/**
 * Import an EasyEDA schematic (.json) file.
 * Opens a file picker for .json, detects EasyEDA format, converts, and loads.
 * @param {SchematicEditor} app
 */
export async function importEasyEDA(app) {
    if (!canReplaceDocument(app)) return;
    if (app.project?.isDirty ?? app.fileManager.isDirty) {
        if (!await app.confirm('You have unsaved changes. Import anyway?', { title: 'Unsaved Changes', okText: 'Yes', cancelText: 'No', defaultCancel: true })) {
            return;
        }
    }

    try {
        const data = await _pickAndReadJSON('.json', 'EasyEDA Schematic');
        if (!data) return; // cancelled

        if (!_isEasyEDASchematic(data)) {
            app.alert('This does not appear to be an EasyEDA schematic file.\n\nExpected a JSON file with a "schematics" array.', { title: 'Import Failed' });
            return;
        }

        console.log('Importing EasyEDA schematic…');
        const doc = importEasyEDASchematic(data, app.componentLibrary);

        await loadProjectDocument(app, doc);
        app.fitToContent();
        app.fileManager.fileHandle = null;
        app.fileManager.setFilePath(null);
        app.fileManager.setFileName('imported.cpcb');
        app.fileManager.setDirty(true);
        updateTitle(app);
        notifyDocumentReplaced(app, 'import');
        console.log('EasyEDA import complete');
    } catch (err) {
        app.alert('Import failed: ' + errorMessage(err), { title: 'Import Failed' });
    }
}

/**
 * Detect whether parsed JSON is an EasyEDA schematic file.
 * @param {any} data
 */
function _isEasyEDASchematic(data) {
    return data
        && Array.isArray(data.schematics)
        && data.schematics.length > 0
        && (data.docType === 5 || data.docType === '5' || data.editorVersion);
}

/**
 * Open a file picker restricted to a given extension and return parsed JSON.
 * @param {string} ext - File extension (e.g. '.json')
 * @param {string} description - Description for the picker dialog
 * @returns {Promise<object|null>} Parsed JSON data, or null if cancelled
 */
function _pickAndReadJSON(ext, description) {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = ext;
        input.onchange = async (e) => {
            const file = /** @type {HTMLInputElement} */ (e.target)?.files?.[0];
            if (!file) { resolve(null); return; }
            try {
                const text = await file.text();
                resolve(JSON.parse(text));
            } catch (err) {
                resolve(null);
            }
        };
        input.click();
    });
}
