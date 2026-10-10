// SchematicApp.js - Schematic Editor Application

import { Viewport } from '../core/Viewport.js';
import { globalEventBus } from '../core/EventBus.js';
import { CommandHistory } from '../core/CommandHistory.js';
import { SelectionManager } from '../core/SelectionManager.js';
import { FileManager } from '../core/FileManager.js';
import { SchematicDocument } from '../core/SchematicDocument.js';
import { errorMessage } from '../core/errors.js';
import { ProjectIntegrityError, duplicateIdRepairMessage, repairDuplicateIds } from '../core/project-format.js';
import { storageManager } from '../core/StorageManager.js';
import { ComponentPicker } from '../components/ComponentPicker.js';
import { createShape } from '../shapes/index.js';
import { getComponentLibrary } from '../components/index.js';
import { warmKiCadIndex } from '../components/KiCadFetcher.js';
// Modules with a small public API use named imports; modules with many
// exports (wire, drawing, components, files, export) use namespace imports
// to keep the import block manageable.
import { bindMouseEvents } from '../schematic/modules/mouse.js';
import { bindKeyboardShortcuts } from '../schematic/modules/keyboard.js';
import { bindPropertiesPanel, applyCommonProperty, updatePropertiesPanel, hasSchematicPropertyPreview } from '../schematic/modules/properties.js';
import { bindRibbon, updateShapePanelOptions, activateRibbonTab, retainRibbonHeight as retainSchematicRibbonHeight, showSaveToast as showRibbonSaveToast } from '../schematic/modules/ribbon.js';
import { setToolCursor } from '../shared/ui/cursor.js';
import { updateGridDropdown, fitToContent } from '../shared/ui/viewport.js';
import { bindThemeToggle, toggleTheme } from '../schematic/modules/theme.js';
import { captureShapeState, applyShapeState } from '../schematic/modules/selection.js';
import { createSchematicHistory, showUnlockMenu } from '../schematic/modules/locks.js';
import { runSchematicDeleteAction } from '../schematic/modules/editor-actions.js';
import { copySelection, cancelPaste } from '../schematic/modules/clipboard.js';
import { removeBoxSelectElement } from '../shared/ui/box-selection.js';
import * as WireTools from '../schematic/modules/wire.js';
import * as DrawingTools from '../schematic/modules/drawing.js';
import * as ComponentTools from '../schematic/modules/components.js';
import * as FileTools from '../schematic/modules/files.js';
import * as ExportTools from '../shared/ui/export.js';
import { onToolSelected, onOptionsChanged, loadToolOptions } from '../schematic/modules/tool.js';
import { adaptShortcutsInDOM } from '../schematic/modules/platform-keys.js';
import { setupCallbacks } from '../schematic/modules/callbacks.js';
import { getOverlapHitCount } from '../schematic/modules/callbacks.js';
import { updateUndoRedoButtons, flashAutoSaveIndicator } from '../schematic/modules/ui-utils.js';
import { needsValueDialog, showValueDialog } from '../schematic/modules/value-dialog.js';
import { showAlert, showConfirm, showPrompt } from '../shared/ui/modal.js';
import {
    startTextEdit,
    endTextEdit,
    handleTextEditKey,
    updateTextEditOverlay,
    setTextCaretFromScreen
} from '../schematic/modules/text-edit.js';
import {
    addShape,
    commandAddShapeInternal,
    commandRemoveShapeInternal,
    commandDeleteShapesInternal,
    commandRestoreShapesInternal,
} from '../schematic/modules/shape-management.js';
import {
    renderShapes,
    clearShapeSegmentSelection,
    refreshSelectionVisual,
    isCulled,
} from '../schematic/modules/schematic-view.js';
import { getShapeNodeFocus, getShapeSegmentFocus, setShapeNodeFocus } from '../schematic/modules/shape-focus.js';
import { blocksSchematicSnapshot } from '../schematic/modules/schematic-interactions.js';

// Shape construction uses createShape() from shapes/index.js.

/**
 * @typedef {import('../core/SchematicDocument.js').SchematicItem} SchematicItem
 * @typedef {import('../core/SchematicDocument.js').SchematicDrawable} SchematicDrawable
 * @typedef {import('../components/Component.js').Component} Component
 * @typedef {import('../components/Component.js').ComponentDefinition} ComponentDefinition
 * @typedef {import('../shapes/text.js').Text} TextShape
 * @typedef {import('../shapes/shape.js').Shape} Shape
 * @typedef {import('../core/ProjectDocument.js').ProjectData} ProjectData
 * @typedef {import('../core/geometry.js').Point} Point
 * @typedef {import('../schematic/modules/draw-states.js').InteractionState} InteractionState
 * @typedef {{key: string, fileName: string, timestamp: number}} AutoSaveEntry
 * @typedef {{lineWidth?: number, fill?: boolean, color?: string|number, textColor?: string|number, textRotation?: number, fontSize?: number, netFontSize?: number, netStyle?: string, netOrientation?: string, cornerRadius?: number, [key: string]: unknown}} SchematicToolOptions
 * @typedef {{cursorPos: HTMLElement|null, gridSnap: HTMLElement|null, zoomPercent: HTMLElement|null, viewportInfo: HTMLElement|null, docTitle: HTMLElement|null, propertiesPanel?: HTMLElement|null}} SchematicUiElements
 * @typedef {{shape: SchematicDrawable, index: number, parentWire?: SchematicDrawable|null}} ShapeRestoreData
 */

/**
 * Central application class — a thin facade over the `schematic/modules/` layer.
 *
 * Almost all logic lives in the module files (mouse.js, wire.js, drawing.js,
 * keyboard.js, etc.).  Methods here delegate to those modules, passing `this`
 * as the shared app context.  If you're looking for how a feature works, check
 * the corresponding module rather than this file.
 *
 * The constructor initializes editor interaction state. Shape/component
 * collections alias the project-owned document rather than separate editor data.
 */
export default class SchematicApp {

    /**
     * Initializes the schematic editor app: viewport, event bus, history, selection, UI elements, component picker, and binds all event handlers.
     * @param {import('../core/ProjectDocument.js').ProjectDocument} [project]
     *        The neutral document owner. When provided, the schematic
     *        registers itself as the document's UI-host view and shares the
     *        project's FileManager. Omitted only in standalone/test setups,
     *        where a private FileManager is created as a fallback.
     */
    constructor(project) {
        /** @type {import('../core/ProjectDocument.js').ProjectDocument|null} */
        this.project = project || null;
        this.fileManager = project ? project.fileManager : new FileManager();
        this.document = project ? project.schematicDocument : new SchematicDocument();
        // Register as the schematic view + UI host, and inject the file
        // lifecycle so the project can drive New/Open/Save without
        // importing this module (keeping core free of view dependencies).
        project?.registerView('schematic', this, {
            isUiHost: true,
            lifecycle: {
                new: () => FileTools.newFile(this),
                open: () => FileTools.openFile(this),
                openRecent: (name) => FileTools.openRecentFile(this, name),
                save: () => FileTools.saveFile(this),
                saveAs: () => FileTools.saveFileAs(this),
                importEasyEDA: () => FileTools.importEasyEDA(this),
            },
        });
        // Auto-save recovery now runs after initialization.
        this._skipAutoSaveRecovery = !!/** @type {Window & {_launchFile?: boolean}} */ (window)._launchFile;

        this.container = /** @type {HTMLElement} */ (document.getElementById('canvasContainer'));
        this.viewport = new Viewport(this.container);
        /** @type {Viewport & {_app?: SchematicApp}} */ (this.viewport)._app = this; // back-reference for state-aware pan suppression
        this.eventBus = globalEventBus;
        this.history = createSchematicHistory(this, {
            onChanged: () => this._onHistoryChanged(),
            onRefused: error => showRibbonSaveToast(this, errorMessage(error)),
        });
        // fileManager already created above
        this.fileManager.onDirtyChanged = () => this._onDirtyChanged();
        this.fileManager.onFileNameChanged = () => FileTools.updateTitle(this);
        this.fileManager.onAutoSaveChanged = () => FileTools.updateTitle(this);
        this.fileManager.onAutoSaveSuccess = flashAutoSaveIndicator;
        this.fileManager.onAutoSaveError = error => this.onAutoSaveError(error);

        /**
         * The pointer state draw-states.js dispatches events to; set as interactions
         * begin and end (resolveState derives it from the interaction slots).
         * @type {InteractionState | undefined}
         */
        this.interactionState = undefined;
        // Shape/selection state
        this.selection = /** @type {SelectionManager<SchematicItem>} */ (/** @type {unknown} */ (new SelectionManager({
            getScale: () => this.viewport?.scale,
            isCulled: (entity) => isCulled(/** @type {SchematicItem} */ (entity)),
            onSelectionChanged: (shapes) => this._onSelectionChanged(/** @type {SchematicItem[]} */ (shapes)),
            invalidateEntity: (entity) => refreshSelectionVisual(this, /** @type {SchematicItem} */ (entity)),
        })));
        /** Number of selectable objects under the pointer (overlap cycling tip). */
        this.updateSelectableItems();

        // ── Tool / drawing state ─────────────────────────────────────
        this.currentTool = 'select';
        /** @type {Point|null} */
        this.drawStart = null;
        /** @type {Point|null} */
        this.drawCurrent = null;
        /** @type {Point[]} */
        this.polygonPoints = [];
        /** @type {SVGGElement|null} */
        this.previewElement = null;
        /** @type {import('../schematic/modules/wire.js').WirePoint[]} */
        this.wirePoints = [];
        /** @type {any|null} Dynamic wire snap highlight state can be a full snap result or a lightweight drawing pin. */
        this.wireSnapPin = null;
        /** @type {any|null} Dynamic wire start pin mirrors wireSnapPin's drawing-time shape. */
        this.wireStartPin = null;
        /** @type {any|null} Dynamic drawing snap state is completed progressively while drawing a wire. */
        this.lastSnappedData = null;
        /** @type {Point|null} */
        this.drawCorner = null;         // set by wire.js — auto-corner waypoint
        /** @type {Point[]} */
        this.linePoints = [];           // set by drawing.js — polyline vertices
        /** @type {Point|null} */
        this.arcEndpoint = null;        // set by drawing.js / mouse.js — arc second click
        this.arcDirection = undefined;  // set by drawing.js — arc CW/CCW flag
        this.arcSweepFlag = undefined;  // set by drawing.js — SVG sweep-flag

        // ── Clipboard / paste state (set by clipboard.js) ─────────────
        /** @type {SVGGElement|null} */
        this.pastePreviewGroup = null;

        // Tool options
        const savedOptions = loadToolOptions();
        const defaultShapeColor = 'var(--sch-symbol-outline, #ffffff)';
        /** @type {SchematicToolOptions} */
        this.toolOptions = /** @type {SchematicToolOptions} */ (savedOptions || {
            lineWidth: 0.25,
            fill: false,
            color: defaultShapeColor,
            textColor: 'var(--sch-text-label, #00b894)',
            fontSize: 2.0,
            netFontSize: 1.4,
            netStyle: 't',
            netOrientation: 'N'
        });
        this.toolOptions.color = defaultShapeColor;

        // UI elements
        /** @type {SchematicUiElements} */
        this.ui = {
            cursorPos: document.getElementById('cursorPos'),
            gridSnap: document.getElementById('gridSnap'),
            zoomPercent: document.getElementById('zoomPercent'),
            viewportInfo: document.getElementById('viewportInfo'),
            docTitle: document.getElementById('docTitle'),
        };

        document.querySelector('.ribbon')?.addEventListener('contextmenu', (e) => {
            e.preventDefault();
        });
        document.querySelectorAll('.status-bar').forEach(el => el.addEventListener('contextmenu', (e) => {
            e.preventDefault();
        }));

        // Component code tooltip (copyable)
        ComponentTools.initializeComponentCodeTooltip(this);
        this.showComponentDebugTooltip = false;
        /** @type {(() => void)|null} Refreshes renderer-owned schematic ribbon state. */
        this.refreshRibbon = null;
        /** @type {string|null} The ribbon tab shown last (set by ribbon.js). */
        this.activeRibbonTab = null;

        // Help panel now lives in ribbon

        // Component library and picker
        this.componentLibrary = getComponentLibrary();
        this.componentPicker = new ComponentPicker({
            eventBus: this.eventBus
        });
        this.componentPicker.appendTo(this.container);

        // Component placement state
        /** @type {SVGElement|null} */
        this.componentPreview = null;  // Preview SVG element
        this.componentRotation = 0;    // Current rotation for placement
        this.componentMirror = false;  // Current mirror state

        this._setupCallbacks();
        this._bindUIControls();
        this._bindMouseEvents();
        this._bindKeyboardShortcuts();
        // A lock icon click offers to unlock that object (bubbles up from the icon).
        this.viewport.svg.addEventListener('unlock-shape', (e) => {
            const { shape, clientX, clientY } = /** @type {CustomEvent} */ (e).detail || {};
            showUnlockMenu(this, shape, clientX, clientY);
        });

        // Initial view
        this.viewport.resetView();
        FileTools.updateTitle(this);

        // Start auto-save. When a project owns this view the project
        // drives autosave (it aggregates dirty state across both editors);
        // only fall back to a private timer in standalone setups.
        if (!this.project) {
            this.fileManager.startAutoSave(
                () => FileTools.serializeProjectDocument(this),
                () => false,
            );
        }

        // Warm the index immediately so first picker use need not start a download.
        warmKiCadIndex(this.componentLibrary);

        // Warn about unsaved changes in either editor (one document).
        window.addEventListener('beforeunload', (e) => {
            const dirty = this.project
                ? this.project.isDirty
                : this.fileManager?.isDirty;
            if (dirty) {
                e.preventDefault();
                e.returnValue = '';
            }
        });

        // If we have a pending auto-load, do it now that everything is ready
        if (this._pendingAutoLoad) {
            // Use the same logic as loadDocument
            import('../schematic/modules/files.js').then(async FileTools => {
                await FileTools.loadProjectDocument(this, /** @type {object} */ (this._pendingAutoLoad));
                this._pendingAutoLoad = null;
            }).catch(err => {
                console.error('Failed to auto-load document:', err);
                this._pendingAutoLoad = null;
            });
        }

        // Load version after a brief delay to ensure DOM is ready
        setTimeout(() => this._loadVersion(), 100);

        // Rewrite shortcut labels for macOS (⌘/⌥/⇧ instead of Ctrl/Alt/Shift)
        adaptShortcutsInDOM();

        this._initComplete = true;
        console.log('Schematic Editor initialized');
    }

    /**
     * Check for auto-saved content and offer recovery.
     * Returns true to continue initialization, false if a reload was triggered.
     */
    async _recoverAutoSave() {
        if (this._skipAutoSaveRecovery) return true;
        /** @type {AutoSaveEntry[]} */
        let index = [];
        try {
            index = JSON.parse(/** @type {string} */ (localStorage.getItem(this.fileManager.autoSavePrefix + 'index'))) || [];
        } catch {}

        // Remove autosaves older than 7 days
        const now = Date.now();
        const weekMs = 7 * 24 * 60 * 60 * 1000;
        let changed = false;
        index = index.filter(entry => {
            const isOrphan = !localStorage.getItem(entry.key);
            const isOld = (now - entry.timestamp) > weekMs;
            if (isOrphan || isOld) {
                localStorage.removeItem(entry.key);
                changed = true;
                return false;
            }
            return true;
        });
        if (changed) {
            localStorage.setItem(this.fileManager.autoSavePrefix + 'index', JSON.stringify(index));
        }

        if (index.length === 1) {
            const entry = index[0];
            const time = new Date(entry.timestamp).toLocaleString();
            const recoveryChoice = await this.confirm(
                `Recover autosaved file "${entry.fileName}" from ${time}?\n\nChoosing No permanently deletes this autosave. Your last fully saved file on disk is unchanged.`,
                { title: 'Recover Autosave', okText: 'Yes', cancelText: 'No - Delete Autosave', showClose: true, escapeResult: null },
            );
            if (recoveryChoice === true) {
                await this._applyAutoSave(entry);
            } else if (recoveryChoice === false) {
                this.fileManager.clearAutoSave(entry.fileName);
            }
        } else if (index.length > 1) {
            index.sort((a, b) => b.timestamp - a.timestamp);
            let listMsg = 'Autosaved files found:\n';
            index.forEach((entry, i) => {
                const time = new Date(entry.timestamp).toLocaleString();
                listMsg += `${i + 1}. ${entry.fileName} (saved ${time})\n`;
            });
            listMsg += '\nEnter the number to recover, or D<number> to delete:';
            let choice = await this._prompt(listMsg, { title: 'Recover Autosave' });
            if (choice) {
                choice = choice.trim();
                if (/^d\d+$/i.test(choice)) {
                    const idx = parseInt(choice.slice(1)) - 1;
                    if (index[idx]) {
                        this.fileManager.clearAutoSave(index[idx].fileName);
                        await this.alert(`Deleted autosave for ${index[idx].fileName}`, { title: 'Autosave Deleted' });
                        location.reload();
                        return false;
                    }
                } else {
                    const idx = parseInt(choice) - 1;
                    if (index[idx]) await this._applyAutoSave(index[idx]);
                }
            }
        }
        return true;
    }

    /**
     * Restores auto-saved document data and marks the document as dirty.
     * @param {AutoSaveEntry} entry - The auto-save index entry to restore.
     */
    async _applyAutoSave(entry) {
        const saved = this.fileManager.loadAutoSave(entry.fileName);
        if (saved && saved.data) {
            try {
                const recovered = repairDuplicateIds(saved.data);
                const repairMessage = duplicateIdRepairMessage(recovered);
                if (this._initComplete) {
                    await FileTools.loadProjectDocument(this, /** @type {object} */ (recovered.data));
                } else {
                    this.shapes = [];
                    this.components = [];
                    this.ui = /** @type {SchematicUiElements} */ ({});
                    this._pendingAutoLoad = recovered.data;
                }
                if (saved.fileName) this.fileManager.setFileName(saved.fileName);
                // Restore the original file handle (persisted in IndexedDB) so that
                // "Save"/Ctrl+S writes back to the same file instead of prompting
                // for a name. The write-permission grant is re-requested lazily on
                // the next save (which carries a user gesture).
                if (saved.fileName) {
                    try { await this.fileManager.restoreFileHandle(saved.fileName); } catch {}
                }
                this.fileManager.setDirty(true);
                if (repairMessage) {
                    await this.alert(`Recovered the autosave. ${repairMessage}`, { title: 'Autosave Repaired' });
                }
                console.log('Recovered auto-saved content');
            } catch (error) {
                await this.alert(`Failed to recover autosave: ${errorMessage(error)}`, { title: 'Recovery Failed' });
                return false;
            }
        }
        return true;
    }

    /**
     * Begins inline text editing on a text shape, or shows a value dialog for passive component fields.
     * @param {SchematicItem} shape - The text shape to edit.
     */
    startTextEdit(shape) {
        const textShape = shape?.type === 'text' ? /** @type {TextShape} */ (shape) : null;
        // For value fields on passive components, show the value dialog instead
        if (textShape && textShape.fieldKey === 'value' && textShape.parentComponent) {
            const comp = /** @type {Component} */ (/** @type {unknown} */ (textShape.parentComponent));
            if (needsValueDialog(comp.definition)) {
                const screenPos = this.viewport.worldToScreen({ x: textShape.x, y: textShape.y });
                showValueDialog(comp.definition, screenPos.x, screenPos.y, {
                    currentValue: comp.value, allowEscape: true
                }).then(value => {
                    if (value !== null && comp.valueText) {
                        const oldValue = comp.value;
                        if (value !== oldValue) {
                            comp.value = value;
                            comp.valueText.text = value;
                            comp.valueText.invalidate();
                            this.renderShapes(true);
                        }
                    }
                });
                return;
            }
        }
        startTextEdit(this, /** @type {TextShape} */ (shape));
    }

    /**
     * Ends inline text editing, committing or discarding changes.
     * @param {boolean} [commit=true] - Whether to commit the text changes.
     */
    endTextEdit(commit = true) {
        endTextEdit(this, commit);
    }

    /**
     * Forwards a keyboard event to the text-edit handler during inline editing.
     * @param {KeyboardEvent} e - The keyboard event to handle.
     * @returns {*} The result from the text-edit key handler.
     */
    handleTextEditKey(e) {
        return handleTextEditKey(this, e);
    }

    /**
     * Refreshes the text-edit overlay position and content.
     */
    updateTextEditOverlay() {
        updateTextEditOverlay(this);
    }

    /**
     * Sets the text-edit caret position from screen coordinates.
     * @param {Point} screenPos - The screen position {x, y}.
     */
    setTextEditCaretFromScreen(screenPos) {
        setTextCaretFromScreen(this, screenPos);
    }

    // ==================== Tool Handling ====================
    
    /**
     * Switches the active tool and emits a toolChanged event.
     * @param {string} tool - The tool identifier to activate.
     */
    selectTool(tool) {
        onToolSelected(this, tool);
        this.eventBus.emit('toolChanged', tool);
    }
    
    /**
     * Merges updated tool options and persists to storage.
     * @param {SchematicToolOptions} options - The tool options to apply.
     */
    updateToolOptions(options) {
        onOptionsChanged(this, options);
    }

    // ==================== Shape Management ====================
    
    /**
     * Adds a shape to the canvas via an undoable command.
     * @param {SchematicDrawable} shape - The shape to add.
     * @returns {SchematicDrawable} The result of the add operation.
     */
    addShape(shape) {
        return addShape(this, shape);
    }
    
    /**
     * Internal remove - used by commands, no history entry
     * Does NOT destroy the shape so it can be re-added on undo
     */
    /**
     * Command boundary: add one shape with command-safe wire-label handling.
     * @param {Shape} shape
     * @param {TextShape|null} [linkedWireLabelText]
     * @returns {TextShape|null}
     */
    commandAddShape(shape, linkedWireLabelText = null) {
        return commandAddShapeInternal(this, /** @type {SchematicDrawable} */ (shape), linkedWireLabelText);
    }

    /**
     * Command boundary: remove one shape with command-safe wire-label handling.
     * @param {Shape} shape
     * @param {{ preserveWireLabelRef?: boolean, preserveLinkedLabelRef?: boolean }} [options]
     * @returns {TextShape|null}
     */
    commandRemoveShape(shape, options = undefined) {
        return commandRemoveShapeInternal(this, /** @type {SchematicDrawable} */ (shape), options);
    }

    /**
     * Command boundary: batch-delete shapes and linked wire labels.
     * @param {ShapeRestoreData[]} shapesData
     * @param {ShapeRestoreData[]} [linkedLabelData]
     */
    commandDeleteShapes(shapesData, linkedLabelData) {
        commandDeleteShapesInternal(this, shapesData, /** @type {Array<{shape: SchematicDrawable, index: number, parentWire: SchematicDrawable|null}>} */ (linkedLabelData || []));
    }

    /**
     * Command boundary: batch-restore shapes and linked wire labels.
     * @param {ShapeRestoreData[]} shapesData
     * @param {ShapeRestoreData[]} [linkedLabelData]
     */
    commandRestoreShapes(shapesData, linkedLabelData) {
        commandRestoreShapesInternal(this, shapesData, /** @type {Array<{shape: SchematicDrawable, index: number, parentWire: SchematicDrawable|null}>} */ (linkedLabelData || []));
    }
    
    /**
     * Re-renders all shapes; if force is true, recalculates stroke widths.
     * @param {boolean} [force=false] - Whether to force recalculation of stroke widths.
     */
    renderShapes(force = false) {
        renderShapes(this, force);
    }

    // ==================== Drawing ====================
    
    /**
     * Cancels drawing, removing preview and resetting state.
     */
    cancelDrawing() {
        DrawingTools.cancelDrawing(this);
    }
    
    /**
     * Redraws the preview SVG for the current tool and cursor position.
     */
    _updatePreview() {
        DrawingTools.updatePreview(this);
    }
    
    // ==================== Wire Drawing ====================
    
    /**
     * Cancels wire drawing and removes its preview.
     */
    cancelWireDrawing() {
        WireTools.cancelWireDrawing(this);
    }
    
    // ==================== Component Handling ====================
    
    /**
     * Rebuilds the selection manager's item list.
     */
    updateSelectableItems() {
        ComponentTools.updateSelectableItems(this);
    }
    
    /**
     * Generates the next unique reference designator.
     * @param {ComponentDefinition} definition - The component definition.
     * @returns {string} The generated reference designator.
     */
    _generateReference(definition) {
        return ComponentTools.generateReference(this, definition);
    }
    
    /**
     * Rotates placement preview or selected components right.
     */
    _rotateComponent() {
        ComponentTools.rotateComponentRight(this);
    }
    
    /**
     * Flips placement preview or selected components horizontally.
     */
    _flipComponentH() {
        ComponentTools.flipComponentH(this);
    }

    /**
     * Exits placement mode and removes the preview.
     */
    cancelComponentPlacement() {
        ComponentTools.cancelComponentPlacement(this);
    }
    
    // ==================== Callbacks ====================

    /**
     * Registers event bus listeners and viewport callbacks.
     */
    _setupCallbacks() {
        setupCallbacks(this);
    }
    
    /**
     * Positions the crosshair at the snapped world position.
     * @param {Point} snapped - The snapped position data.
     */
    updateCrosshair(snapped) {
        this.lastCrosshairWorld = { x: snapped.x, y: snapped.y };
        this.viewport.setCrosshair(snapped);
    }

    /**
     * Sets the CSS cursor on the SVG canvas for the active tool.
     * @param {string} tool - The tool identifier.
     * @param {SVGSVGElement} svg - The SVG element to set the cursor on.
     */
    setToolCursor(tool, svg) {
        setToolCursor(this, tool, svg);
    }

    /**
     * Shows the crosshair overlay.
     */
    showCrosshair() {
        this.viewport.showCrosshair();
    }
    
    /**
     * Hides the crosshair overlay.
     */
    hideCrosshair() {
        this.viewport.hideCrosshair();
    }
    
    /**
     * Emits selectionChanged on the event bus.
     * @param {SchematicItem[]} shapes - The currently selected shapes.
     */
    _onSelectionChanged(shapes) {
        if (shapes.length !== 1 || shapes[0]?.id !== getShapeSegmentFocus(this)?.shapeId) {
            clearShapeSegmentSelection(this);
        }
        if (shapes.length !== 1 || shapes[0]?.id !== getShapeNodeFocus(this)?.shapeId) {
            setShapeNodeFocus(this, null);
        }
        this.updateShapeSelectionTip();
        this.eventBus.emit('selectionChanged', shapes);
    }

    updateShapeSelectionTip() {
        const tip = document.getElementById('schematicStatusTip');
        if (!tip) return;
        const selected = this.selection.getSelection();
        const selectedText = selected[0]?.type === 'text' ? /** @type {TextShape} */ (selected[0]) : null;
        const showReferenceTip = this.currentTool === 'select'
            && selected.length === 1
            && selectedText?.fieldKey === 'reference';
        const showOverlapTip = this.currentTool === 'select' && getOverlapHitCount(this) > 1;
        const textAttached = selected.length === 1 && !!selectedText?.parentComponent;
        const showAttachTip = !textAttached && (this.currentTool === 'text' || (this.currentTool === 'select'
            && selected.length === 1 && selectedText && (!selectedText.fieldKey || selectedText.fieldKey === 'label')));
        const show = this.currentTool === 'select'
            && selected.length === 1
            && selected[0]?.type === 'polyline'
            && !getShapeSegmentFocus(this)
            && !getShapeNodeFocus(this);
        tip.hidden = !show && !showReferenceTip && !showOverlapTip && !showAttachTip;
        tip.textContent = showAttachTip ? 'Tip: Attach text to a shape or wire by hovering over it'
            : showReferenceTip ? 'Tip: Use SPACE to rotate text'
            : showOverlapTip ? 'Tip: Shift+Click to cycle overlapping objects; Ctrl+Click for multi-selection'
            : show ? 'Tip: Click again to select a segment or node' : '';
    }

    /**
     * Binds event listeners for the properties panel.
     */
    _bindPropertiesPanel() {
        bindPropertiesPanel(this);
    }

    /**
     * Binds event listeners for the ribbon toolbar.
     */
    _bindRibbon() {
        bindRibbon(this);
    }

    /**
     * Updates shape-options panel for the active tool.
     * @param {SchematicItem[]} selection - The current selection.
     * @param {string} toolId - The active tool identifier.
     */
    updateShapePanelOptions(selection, toolId) {
        updateShapePanelOptions(this, selection, toolId);
    }

    /**
     * Applies a property change to selected items with undo.
     * @param {string} prop - The property name to change.
     * @param {*} value - The new value to apply.
     */
    _applyCommonProperty(prop, value) {
        applyCommonProperty(this, prop, value);
    }
    
    /**
     * Refreshes the properties panel for the given selection.
     * @param {SchematicItem[]} selection - The currently selected shapes.
     */
    updatePropertiesPanel(selection) {
        updatePropertiesPanel(this, selection);
    }

    /**
     * Bring a ribbon tab to the front; does nothing before the ribbon is bound.
     * @param {string} tabId - `home`, `properties`, …
     */
    setActiveRibbonTab(tabId) {
        activateRibbonTab(this, tabId);
    }

    retainRibbonHeight() {
        retainSchematicRibbonHeight(this);
    }

    // ==================== Mouse Events ====================
    
    /**
     * Binds mouse event handlers to the SVG viewport.
     */
    _bindMouseEvents() {
        bindMouseEvents(this);
    }

    // ==================== UI Controls ====================

    /**
     * Binds viewport controls, undo/redo, theme, and paper events.
     */
    _bindUIControls() {
        // Ribbon renders controls that viewport/history/theme binding uses.
        this._bindRibbon();
        
        // Ribbon handles file/export actions
        
        // Theme toggle
        bindThemeToggle(this);
        
        // Initialize button states
        this._updateUndoRedoButtons();
        
        // Initialize grid dropdown with current units
        this.updateGridDropdown();

        // Properties panel
        this._bindPropertiesPanel();

    }

    /**
     * Shows, updates, or hides the component debug tooltip.
     * @param {Component|null} component - The component to display info for, or null to hide.
     * @param {Point|null} screenPos - The screen position {x, y} for the tooltip.
     * @param {Object} [options={}] - Options (e.g., { forceHide: true }).
     */
    updateComponentCodeTooltip(component, screenPos, options = {}) {
        ComponentTools.updateComponentCodeTooltip(this, component, screenPos, options);
    }

    /**
     * Clears cached component/search data from IndexedDB storage and legacy localStorage.
     */
    async _clearComponentCaches() {
        if (!await this.confirm('Clear cached components and search results?', { title: 'Clear Cache', okText: 'Yes', cancelText: 'No' })) {
            return;
        }

        const prefixes = [
            'clearpcb_component_',
            'clearpcb_lcsc_component_',
            'clearpcb_kicad_symbol_',
            'clearpcb_search_'
        ];
        const exactKeys = [
            'kicad_full_symbol_index'
        ];

        let removed = 0;

        // Remove exact critical keys explicitly (works even if expired entries
        // are omitted from storageManager.keys()).
        for (const key of exactKeys) {
            storageManager.remove(key);
        }

        // Clear IndexedDB-backed cache entries first (current storage backend).
        for (const key of storageManager.keys()) {
            if (prefixes.some(prefix => key.startsWith(prefix)) || exactKeys.includes(key)) {
                storageManager.remove(key);
                removed += 1;
            }
        }

        // Also clear legacy localStorage entries for compatibility with older builds.
        Object.keys(localStorage).forEach((key) => {
            if (prefixes.some(prefix => key.startsWith(prefix)) || exactKeys.includes(key)) {
                localStorage.removeItem(key);
                removed += 1;
            }
        });

        this.componentPicker?.searchManager?.clearCache?.();

        // Clear KiCadFetcher in-memory index so it re-fetches
        const kf = this.componentPicker?.library?.kicadFetcher;
        if (kf) {
            kf.libraryIndex = null;
            kf._indexLoadPromise = null;
        }

        console.log(`Cleared component caches (${removed} entries)`);
        showRibbonSaveToast(this, 'Cache cleared');
    }

    async clearComponentCaches() {
        return this._clearComponentCaches();
    }

    // ==================== Modal helpers ====================

    /**
     * @param {string} message
     * @param {object} [options]
     * @returns {Promise<void>}
     */
    async alert(message, options = {}) {
        await showAlert(message, options);
    }

    /**
     * @param {string} message
     * @param {object} [options]
     * @returns {Promise<boolean>}
     */
    async confirm(message, options = {}) {
        return await showConfirm(message, options);
    }

    /**
     * @param {string} message
     * @param {object} [options]
     * @returns {Promise<string|null>}
     */
    async _prompt(message, options = {}) {
        return await showPrompt(message, options);
    }
    
    /**
     * Toggles between dark and light themes.
     */
    _toggleTheme() {
        toggleTheme(this);
    }

    toggleTheme() {
        this._toggleTheme();
    }
    
    /**
     * Loads the saved theme from storage on startup.
     */
    /**
     * Updates grid size dropdown options for current units.
     */
    updateGridDropdown() {
        updateGridDropdown(this);
        this.refreshRibbon?.();
    }

    /**
     * Binds keyboard shortcuts and stores the cleanup function.
     */
    _bindKeyboardShortcuts() {
        this._destroyKeyboard = bindKeyboardShortcuts(this);
    }
    
    /**
     * Deletes unlocked selected items with undo support.
     */
    _deleteSelected() {
        runSchematicDeleteAction(this);
    }

    /**
     * Copies selected items to the internal clipboard.
     */
    copySelection() {
        copySelection(this);
    }

    /**
     * Cancels paste preview and removes preview elements.
     */
    cancelPaste() {
        cancelPaste(this);
    }
    
    // ==================== Box Selection ====================
    
    /**
     * Removes the box-selection element.
     */
    removeBoxSelectElement() {
        removeBoxSelectElement(this);
    }
    
    // ==================== Shape State Helpers (for undo/redo) ====================
    
    /**
     * Captures a shape's state snapshot for undo.
     * @param {SchematicItem} shape - The shape to capture state from.
     * @returns {import('../schematic/modules/selection.js').ShapeState} The captured state snapshot.
     */
    _captureShapeState(shape) {
        return captureShapeState(this, shape);
    }
    
    /**
     * Restores a shape from a captured state snapshot.
     * @param {SchematicItem} shape - The shape to restore.
     * @param {import('../schematic/modules/selection.js').ShapeState} state - The state snapshot to apply.
     */
    _applyShapeState(shape, state) {
        applyShapeState(this, shape, state);
    }
    
    /**
     * Zooms and pans to fit all content.
     */
    fitToContent() {
        fitToContent(this);
    }
    
    // ==================== File Operations ====================

    /**
     * Serializes the WHOLE project document (schematic + PCB) to a
     * JSON-ready object. Delegates to the project owner when present so
     * every section is gathered consistently; falls back to the schematic
     * section alone in standalone setups.
     * @returns {Object} The serialized document data.
     */
    // ── ProjectDocument view interface ────────────────────────────────

    isSectionEditing() {
        return hasSchematicPropertyPreview(this) || blocksSchematicSnapshot(this);
    }

    onDocumentReplaced() {
        this.setActiveRibbonTab?.('home');
    }

    onProjectChanged() {
        FileTools.updateTitle(this);
    }

    _onHistoryChanged() {
        this._updateUndoRedoButtons();
        this.project?.notifySchematicChanged();
    }

    _onDirtyChanged() {
        FileTools.updateTitle(this);
        this.project?.notifySchematicChanged();
    }

    /** @param {unknown} [error] */
    onAutoSaveError(error) {
        if (error instanceof ProjectIntegrityError) {
            return this.alert('Auto-save stopped: the project failed its integrity check, so the last good autosave is kept. '
                + 'Your changes are still open, but saving is refused too, so your file on disk is not overwritten. '
                + `Please report this problem.\n\n${error.message}`, { title: 'Auto-save Failed' });
        }
        return this.alert('Auto-save failed: storage full or unavailable. Your changes are still open, but are not being backed up. Save your project to disk.',
            { title: 'Auto-save Failed' });
    }

    // Existing interaction modules use these aliases, never a second collection.
    /** @returns {SchematicDrawable[]} */
    get shapes() { return this.document.shapes; }
    /** @param {SchematicDrawable[]} value */
    set shapes(value) { this.document.shapes = value; }
    /** @returns {Component[]} */
    get components() { return this.document.components; }
    /** @param {Component[]} value */
    set components(value) { this.document.components = value; }

    /**
     * Refresh presentation after a project-owned reference operation.
     * @param {string} id
     */
    onComponentReferenceChanged(id) {
        const component = this.components.find(item => item.id === id);
        if (!component) return;
        component.invalidate();
        component.refText?.invalidate();
        this.renderShapes(true);
    }

    /**
     * Current view preferences only; authored state is serialized by the project model.
     * @returns {object}
     */
    getViewSettings() {
        return /** @type {object} */ (FileTools.serializeViewSettings(this.viewport));
    }

    /**
     * Retained direct-editor API for the schematic envelope.
     * ProjectDocument serializes the model itself.
     * @returns {Object}
     */
    serializeSection() {
        return FileTools.serializeDocument(this);
    }

    /**
     * Validate and render replacement entities before either editor is changed.
     * @param {ProjectData} data
     */
    prepareSection(data) {
        return FileTools.prepareDocument(this, data);
    }

    /**
     * Restore this editor's slice, consuming project preflight when provided.
     * @param {ProjectData} data @param {ReturnType<SchematicDocument['prepare']>} [prepared]
     */
    async loadSection(data, prepared = this.prepareSection(data)) {
        await FileTools.loadDocument(this, data, prepared);
    }

    clearSection() {
        FileTools.clearDocument(this);
    }

    /**
     * Report whether this editor has unsaved changes beyond the file
     * manager's own dirty flag. The schematic's edits already drive the
     * shared FileManager's dirty flag, so there's nothing extra to add.
     * @returns {boolean}
     */
    isSectionDirty() {
        return false;
    }
    
    /**
     * Creates a shape from serialized type/options data.
     * @param {ProjectData} data - The serialized shape data.
     * @returns {SchematicItem|null} The created shape, or null if the type is unknown.
     */
    _createShapeFromData(data) {
        try {
            return createShape(data);
        } catch (e) {
            console.warn('Unknown shape type:', data.type);
            return null;
        }
    }
    
    /**
     * Removes all shapes, clears undo history.
     */
    /**
     * Enables or disables undo/redo buttons.
     */
    _updateUndoRedoButtons() {
        updateUndoRedoButtons(this);
    }
    
    /**
     * Fetches and displays the version number.
     * @returns {Promise<void>}
     */
    async _loadVersion() {
        await FileTools.loadVersion(this);
    }
    
    /**
     * Creates a new blank document; prompts if unsaved.
     * @returns {Promise<void>}
     */
    async newFile() {
        if (this.project) return await this.project.newDocument();
        await FileTools.newFile(this);
    }
    
    /**
     * Saves the document; shows toast on success.
     * @returns {Promise<*>} The save result.
     */
    async saveFile() {
        if (this.project) return await this.project.save();
        return await FileTools.saveFile(this);
    }
    
    /**
     * Saves with a new file name/location.
     * @returns {Promise<*>} The save result.
     */
    async saveFileAs() {
        if (this.project) return await this.project.saveAs();
        return await FileTools.saveFileAs(this);
    }

    /**
     * Exports schematic as a vector PDF.
     * @returns {Promise<void>}
     */
    async savePdf() {
        await ExportTools.savePdf(this);
    }

    /**
     * Prints the schematic via a hidden iframe.
     * @returns {Promise<void>}
     */
    async print() {
        await ExportTools.printSchematic(this);
    }

    /**
     * Opens a file via picker and loads it.
     * @returns {Promise<void>}
     */
    async openFile() {
        if (this.project) return await this.project.open();
        await FileTools.openFile(this);
    }

    /**
     * Re-open a file from the recents list (Open ▾ dropdown).
     * @param {string} name - The recents entry / file name to reopen.
     * @returns {Promise<void>}
     */
    async openRecentFile(name) {
        if (this.project) return await this.project.openRecent(name);
        await FileTools.openRecentFile(this, name);
    }

    /**
     * Import an EasyEDA schematic (.json) file.
     * @returns {Promise<void>}
     */
    async _importEasyEDA() {
        if (this.project) return await this.project.importEasyEDA();
        await FileTools.importEasyEDA(this);
    }

    async importEasyEDA() {
        return await this._importEasyEDA();
    }

    /** @param {string} [text] */
    showSaveToast(text = 'Saved') {
        showRibbonSaveToast(this, text);
    }
}
