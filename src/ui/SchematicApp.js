// SchematicApp.js - Schematic Editor Application

import { Viewport } from '../core/Viewport.js';
import { globalEventBus } from '../core/EventBus.js';
import { CommandHistory } from '../core/CommandHistory.js';
import { SelectionManager } from '../core/SelectionManager.js';
import { FileManager } from '../core/FileManager.js';
import { SchematicDocument } from '../core/SchematicDocument.js';
import { duplicateIdRepairMessage, repairDuplicateIds } from '../core/project-format.js';
import { storageManager } from '../core/StorageManager.js';
import { ComponentPicker } from '../components/ComponentPicker.js';
import { createShape } from '../shapes/index.js';
import { getComponentLibrary } from '../components/index.js';
import { warmKiCadIndex } from '../components/KiCadFetcher.js';
// Modules with a small public API use named imports; modules with many
// exports (wire, drawing, components, files, export) use namespace imports
// to keep the import block manageable.
import { bindMouseEvents } from '../schematic/modules/mouse.js';
import { bindKeyboardShortcuts, runSchematicHistoryAction } from '../schematic/modules/keyboard.js';
import { bindPropertiesPanel, applyCommonProperty, updatePropertiesPanel, hasSchematicPropertyPreview } from '../schematic/modules/properties.js';
import { bindRibbon, updateShapePanelOptions } from '../schematic/modules/ribbon.js';
import { setToolCursor } from '../shared/ui/cursor.js';
import { bindViewportControls, updateGridDropdown, fitToContent } from '../shared/ui/viewport.js';
import { bindThemeToggle, toggleTheme, loadTheme } from '../schematic/modules/theme.js';
import { deleteSelected, captureShapeState, applyShapeState } from '../schematic/modules/selection.js';
import { copySelection, cancelPaste } from '../schematic/modules/clipboard.js';
import { removeBoxSelectElement } from '../shared/ui/box-selection.js';
import { bindPaperEvents } from '../schematic/modules/paper.js';
import * as WireTools from '../schematic/modules/wire.js';
import * as DrawingTools from '../schematic/modules/drawing.js';
import * as ComponentTools from '../schematic/modules/components.js';
import * as FileTools from '../schematic/modules/files.js';
import * as ExportTools from '../shared/ui/export.js';
import { onToolSelected, onOptionsChanged, loadToolOptions } from '../schematic/modules/tool.js';
import { adaptShortcutsInDOM } from '../schematic/modules/platform-keys.js';
import { setupCallbacks } from '../schematic/modules/callbacks.js';
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
    removeShapeInternal,
} from '../schematic/modules/shape-management.js';
import {
    renderShapes,
    clearShapeSegmentSelection,
    discardShapeView,
    discardComponentView,
    refreshSelectionVisual,
} from '../schematic/modules/schematic-view.js';

// Shape construction uses createShape() from shapes/index.js.

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
        /** @type {any} */
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
        this._skipAutoSaveRecovery = !!/** @type {any} */ (window)._launchFile;

        this.container = document.getElementById('canvasContainer');
        this.viewport = new Viewport(this.container);
        /** @type {any} */ (this.viewport)._app = this; // back-reference for state-aware pan suppression
        this.eventBus = globalEventBus;
        this.history = new CommandHistory({
            onChanged: () => this._onHistoryChanged(),
        });
        // fileManager already created above
        this.fileManager.onDirtyChanged = () => this._onDirtyChanged();
        this.fileManager.onFileNameChanged = () => this._updateTitle();
        this.fileManager.onAutoSaveChanged = () => this._updateTitle();
        this.fileManager.onAutoSaveSuccess = flashAutoSaveIndicator;
        this.fileManager.onAutoSaveError = () => this.onAutoSaveError();

        // Shape/selection state
        this.selection = new SelectionManager({
            getScale: () => this.viewport?.scale,
            onSelectionChanged: (shapes) => this._onSelectionChanged(shapes),
            invalidateEntity: (entity) => refreshSelectionVisual(this, entity),
        });
        /** Refined edge selection for a line, rectangle, or polygon. */
        this._selectedShapeSegment = null;
        /** Refined node selection for per-corner properties. */
        this._selectedShapeNode = null;
        /** Number of selectable objects under the pointer (overlap cycling tip). */
        this._overlapHitCount = 0;
        /** Ribbon tab switcher and height keeper, installed by bindRibbon(). */
        this._setActiveRibbonTab = null;
        this._retainRibbonHeight = null;
        this._updateSelectableItems();

        // ── Tool / drawing state ─────────────────────────────────────
        this.currentTool = 'select';
        this.isDrawing = false;
        this.drawStart = null;
        this.drawCurrent = null;
        this.polygonPoints = [];
        this.previewElement = null;
        this.wirePoints = [];
        this.wireSnapPin = null;
        this.wireStartPin = null;
        this.lastSnappedData = null;
        this.drawCorner = null;         // set by wire.js — auto-corner waypoint
        this.linePoints = [];           // set by drawing.js — polyline vertices
        this.arcEndpoint = null;        // set by drawing.js / mouse.js — arc second click
        this.arcDirection = undefined;  // set by drawing.js — arc CW/CCW flag
        this.arcSweepFlag = undefined;  // set by drawing.js — SVG sweep-flag

        // ── Drag state (mutated by mouse-states.js / drag.js) ────────
        this.drag = null;                  // { mode, shape, ... } — see mouse-states.js begin*Session
        this.didDrag = false;              // true once an actual drag occurred
        this.pendingAnchorDrag = null;     // deferred anchor drag (before threshold is met)
        this.skipClickSelection = false;
        this._rightClickStart = null;      // screen pos for right-click drag detection

        // ── Box selection ──────────────────────────────────────────────
        this.boxSelectElement = null;

        // ── Clipboard / paste state (set by clipboard.js) ─────────────
        this.pastePreviewGroup = null;
        this.pastingClipboard = false;

        // Tool options
        const savedOptions = loadToolOptions();
        const defaultShapeColor = 'var(--sch-symbol-outline, #ffffff)';
        this.toolOptions = savedOptions || {
            lineWidth: 0.25,
            fill: false,
            color: defaultShapeColor,
            textColor: 'var(--sch-text-label, #00b894)',
            fontSize: 2.0,
            netFontSize: 1.4,
            netStyle: 't',
            netOrientation: 'N'
        };
        this.toolOptions.color = defaultShapeColor;

        // Text edit state
        this.textEdit = null;

        // UI elements
        this.ui = {
            cursorPos: document.getElementById('cursorPos'),
            gridSnap: document.getElementById('gridSnap'),
            zoomPercent: document.getElementById('zoomPercent'),
            viewportInfo: document.getElementById('viewportInfo'),
            gridSize: document.getElementById('gridSize'),
            gridStyle: document.getElementById('gridStyle'),
            units: document.getElementById('units'),
            showGrid: document.getElementById('showGrid'),
            snapToGrid: document.getElementById('snapToGrid'),
            docTitle: document.getElementById('docTitle'),
            undoBtn: document.getElementById('undoBtn'),
            redoBtn: document.getElementById('redoBtn'),
            propertiesPanel: document.getElementById('propertiesPanel'),
        };

        document.querySelector('.ribbon')?.addEventListener('contextmenu', (e) => {
            e.preventDefault();
        });
        document.querySelectorAll('.status-bar').forEach(el => el.addEventListener('contextmenu', (e) => {
            e.preventDefault();
        }));

        // Component code tooltip (copyable)
        this._componentCodeTooltip = document.createElement('div');
        this._componentCodeTooltip.className = 'component-code-tooltip';
        this._componentCodeTooltip.innerHTML = `
            <div class="component-code-tooltip-title">Component code</div>
            <button class="component-code-tooltip-close" title="Close">×</button>
            <textarea class="component-code-tooltip-text" readonly></textarea>
        `;
        document.body.appendChild(this._componentCodeTooltip);
        this._componentCodeTooltipActiveId = null;
        this._componentCodeTooltipPinned = false;
        this._componentCodeTooltipPosition = null;
        this.showComponentDebugTooltip = false;
        this._showSaveToast = null;
        this._componentCodeTooltip.addEventListener('click', (e) => {
            if (e.target instanceof Element && e.target.classList.contains('component-code-tooltip-close')) {
                this._updateComponentCodeTooltip(null, null, { forceHide: true });
            }
        });

        // Help panel now lives in ribbon

        // Component library and picker
        this.componentLibrary = getComponentLibrary();
        this.componentPicker = new ComponentPicker({
            eventBus: this.eventBus
        });
        this.componentPicker.appendTo(this.container);

        // Component placement state
        this.placingComponent = null;  // Definition being placed
        this.componentPreview = null;  // Preview SVG element
        this.componentRotation = 0;    // Current rotation for placement
        this.componentMirror = false;  // Current mirror state

        this._setupCallbacks();
        this._bindUIControls();
        this._bindMouseEvents();
        this._bindKeyboardShortcuts();
        bindPaperEvents(this);

        // Listen for lock icon clicks (bubbles up from shape SVG elements)
        this.viewport.svg.addEventListener('unlock-shape', (e) => {
            const customEvent = /** @type {CustomEvent} */ (e);
            const shape = customEvent.detail?.shape;
            if (shape && shape.locked) {
                this._applyCommonProperty('locked', false);
            }
        });

        // Initial view
        this.viewport.resetView();
        this._updateTitle();

        // Start auto-save. When a project owns this view the project
        // drives autosave (it aggregates dirty state across both editors);
        // only fall back to a private timer in standalone setups.
        if (!this.project) {
            this.fileManager.startAutoSave(
                () => this._serializeDocument(),
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
                await FileTools.loadDocument(this, this._pendingAutoLoad);
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
        let index = [];
        try {
            index = JSON.parse(localStorage.getItem(this.fileManager.autoSavePrefix + 'index')) || [];
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
            const recoveryChoice = await this._confirm(
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
                        await this._alert(`Deleted autosave for ${index[idx].fileName}`, { title: 'Autosave Deleted' });
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
     * @param {Object} entry - The auto-save index entry to restore.
     */
    async _applyAutoSave(entry) {
        const saved = this.fileManager.loadAutoSave(entry.fileName);
        if (saved && saved.data) {
            try {
                const recovered = repairDuplicateIds(saved.data);
                const repairMessage = duplicateIdRepairMessage(recovered);
                if (this._initComplete) {
                    await this._loadDocument(recovered.data);
                } else {
                    this.shapes = [];
                    this.components = [];
                    this.ui = /** @type {any} */ ({});
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
                    await this._alert(`Recovered the autosave. ${repairMessage}`, { title: 'Autosave Repaired' });
                }
                console.log('Recovered auto-saved content');
            } catch (error) {
                await this._alert(`Failed to recover autosave: ${error.message}`, { title: 'Recovery Failed' });
                return false;
            }
        }
        return true;
    }

    /**
     * Begins inline text editing on a text shape, or shows a value dialog for passive component fields.
     * @param {Object} shape - The text shape to edit.
     */
    _startTextEdit(shape) {
        // For value fields on passive components, show the value dialog instead
        if (shape && shape.fieldKey === 'value' && shape.parentComponent) {
            const comp = shape.parentComponent;
            if (needsValueDialog(comp.definition)) {
                const screenPos = this.viewport.worldToScreen({ x: shape.x, y: shape.y });
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
        startTextEdit(this, shape);
    }

    /**
     * Ends inline text editing, committing or discarding changes.
     * @param {boolean} [commit=true] - Whether to commit the text changes.
     */
    _endTextEdit(commit = true) {
        endTextEdit(this, commit);
    }

    /**
     * Forwards a keyboard event to the text-edit handler during inline editing.
     * @param {KeyboardEvent} e - The keyboard event to handle.
     * @returns {*} The result from the text-edit key handler.
     */
    _handleTextEditKey(e) {
        return handleTextEditKey(this, e);
    }

    /**
     * Refreshes the text-edit overlay position and content.
     */
    _updateTextEditOverlay() {
        updateTextEditOverlay(this);
    }

    /**
     * Sets the text-edit caret position from screen coordinates.
     * @param {Object} screenPos - The screen position {x, y}.
     */
    _setTextEditCaretFromScreen(screenPos) {
        setTextCaretFromScreen(this, screenPos);
    }

    // ==================== Tool Handling ====================
    
    /**
     * Switches the active tool and emits a toolChanged event.
     * @param {string} tool - The tool identifier to activate.
     */
    _onToolSelected(tool) {
        onToolSelected(this, tool);
        this.eventBus.emit('toolChanged', tool);
    }
    
    /**
     * Merges updated tool options and persists to storage.
     * @param {Object} options - The tool options to apply.
     */
    _onOptionsChanged(options) {
        onOptionsChanged(this, options);
    }

    // ==================== Shape Management ====================
    
    /**
     * Adds a shape to the canvas via an undoable command.
     * @param {Object} shape - The shape to add.
     * @returns {*} The result of the add operation.
     */
    addShape(shape) {
        return addShape(this, shape);
    }
    
    /**
     * Internal remove - used by commands, no history entry
     * Does NOT destroy the shape so it can be re-added on undo
     */
    _removeShapeInternal(shape, options = undefined) {
        removeShapeInternal(this, shape, options);
    }

    /**
     * Command boundary: add one shape with command-safe wire-label handling.
     */
    _commandAddShape(shape, linkedWireLabelText = null) {
        return commandAddShapeInternal(this, shape, linkedWireLabelText);
    }

    /**
     * Command boundary: remove one shape with command-safe wire-label handling.
     */
    _commandRemoveShape(shape, options = undefined) {
        return commandRemoveShapeInternal(this, shape, options);
    }

    /**
     * Command boundary: batch-delete shapes and linked wire labels.
     */
    _commandDeleteShapes(shapesData, linkedLabelData) {
        commandDeleteShapesInternal(this, shapesData, linkedLabelData);
    }

    /**
     * Command boundary: batch-restore shapes and linked wire labels.
     */
    _commandRestoreShapes(shapesData, linkedLabelData) {
        commandRestoreShapesInternal(this, shapesData, linkedLabelData);
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
    _cancelDrawing() {
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
    _cancelWireDrawing() {
        WireTools.cancelWireDrawing(this);
    }
    
    // ==================== Component Handling ====================
    
    /**
     * Rebuilds the selection manager's item list.
     */
    _updateSelectableItems() {
        ComponentTools.updateSelectableItems(this);
    }
    
    /**
     * Generates the next unique reference designator.
     * @param {Object} definition - The component definition.
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
    _cancelComponentPlacement() {
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
     * @param {Object} snapped - The snapped position data.
     */
    _updateCrosshair(snapped) {
        this.lastCrosshairWorld = { x: snapped.x, y: snapped.y };
        this.viewport.setCrosshair(snapped);
    }

    /**
     * Sets the CSS cursor on the SVG canvas for the active tool.
     * @param {string} tool - The tool identifier.
     * @param {SVGSVGElement} svg - The SVG element to set the cursor on.
     */
    _setToolCursor(tool, svg) {
        setToolCursor(this, tool, svg);
    }

    /**
     * Shows the crosshair overlay.
     */
    _showCrosshair() {
        this.viewport.showCrosshair();
    }
    
    /**
     * Hides the crosshair overlay.
     */
    _hideCrosshair() {
        this.viewport.hideCrosshair();
    }
    
    /**
     * Emits selectionChanged on the event bus.
     * @param {Array} shapes - The currently selected shapes.
     */
    _onSelectionChanged(shapes) {
        if (shapes.length !== 1 || shapes[0]?.id !== this._selectedShapeSegment?.shapeId) {
            clearShapeSegmentSelection(this);
        }
        if (shapes.length !== 1 || shapes[0]?.id !== this._selectedShapeNode?.shapeId) {
            this._selectedShapeNode = null;
        }
        this._updateShapeSelectionTip();
        this.eventBus.emit('selectionChanged', shapes);
    }

    _updateShapeSelectionTip() {
        const tip = document.getElementById('schematicStatusTip');
        if (!tip) return;
        const selected = this.selection.getSelection();
        const showReferenceTip = this.currentTool === 'select'
            && selected.length === 1
            && selected[0]?.type === 'text'
            && selected[0]?.fieldKey === 'reference';
        const showOverlapTip = this.currentTool === 'select' && this._overlapHitCount > 1;
        const show = this.currentTool === 'select'
            && selected.length === 1
            && selected[0]?.type === 'polyline'
            && !this._selectedShapeSegment
            && !this._selectedShapeNode;
        tip.hidden = !show && !showReferenceTip && !showOverlapTip;
        tip.textContent = showReferenceTip ? 'Tip: Use SPACE to rotate text'
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
     * @param {Array} selection - The current selection.
     * @param {string} toolId - The active tool identifier.
     */
    _updateShapePanelOptions(selection, toolId) {
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
     * @param {Array} selection - The currently selected shapes.
     */
    _updatePropertiesPanel(selection) {
        updatePropertiesPanel(this, selection);
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
        bindViewportControls(this);
        
        // Ribbon handles file/export actions
        
        // Undo/Redo buttons
        this.ui.undoBtn.addEventListener('click', () => {
            runSchematicHistoryAction(this, 'undo');
        });
        
        this.ui.redoBtn.addEventListener('click', () => {
            runSchematicHistoryAction(this, 'redo');
        });
        
        // Theme toggle
        bindThemeToggle(this);
        
        // Initialize button states
        this._updateUndoRedoButtons();
        
        // Initialize grid dropdown with current units
        this._updateGridDropdown();

        // Properties panel
        this._bindPropertiesPanel();

        // Ribbon
        this._bindRibbon();
    }

    /**
     * Returns the topmost component at a world coordinate, or null.
     * @param {Object} point - The world coordinate {x, y} to test.
     * @returns {Object|null} The component at the point, or null.
     */
    _findComponentAt(point) {
        for (let i = this.components.length - 1; i >= 0; i--) {
            const comp = this.components[i];
            if (!comp?.visible) continue;
            if (comp.hitTest(point, 0.5)) {
                return comp;
            }
        }
        return null;
    }

    /**
     * Shows, updates, or hides the component debug tooltip.
     * @param {Object|null} component - The component to display info for, or null to hide.
     * @param {Object|null} screenPos - The screen position {x, y} for the tooltip.
     * @param {Object} [options={}] - Options (e.g., { forceHide: true }).
     */
    _updateComponentCodeTooltip(component, screenPos, options = {}) {
        const tooltip = this._componentCodeTooltip;
        if (!tooltip) return;

        if (!this.showComponentDebugTooltip && !options.forceHide) {
            tooltip.style.display = 'none';
            this._componentCodeTooltipActiveId = null;
            this._componentCodeTooltipPinned = false;
            this._componentCodeTooltipPosition = null;
            return;
        }

        const easyedaRaw = component?.definition?.symbol?._easyedaRawShapes;
        const kicadRaw = component?.definition?._kicadRaw || component?.definition?.symbol?._kicadRaw;
        const hasEasyeda = Array.isArray(easyedaRaw) && easyedaRaw.length > 0;
        const hasKicad = typeof kicadRaw === 'string' && kicadRaw.trim().length > 0;
        if (options.forceHide || !component || (!hasEasyeda && !hasKicad)) {
            tooltip.style.display = 'none';
            this._componentCodeTooltipActiveId = null;
            this._componentCodeTooltipPinned = false;
            this._componentCodeTooltipPosition = null;
            return;
        }

        const textEl = /** @type {HTMLTextAreaElement|null} */ (tooltip.querySelector('.component-code-tooltip-text'));
        if (textEl && this._componentCodeTooltipActiveId !== component.id) {
            textEl.value = hasEasyeda ? easyedaRaw.join('\n') : kicadRaw;
            this._componentCodeTooltipActiveId = component.id;
        }

        const pad = 12;
        const position = this._componentCodeTooltipPinned && this._componentCodeTooltipPosition
            ? this._componentCodeTooltipPosition
            : screenPos;
        const maxX = window.innerWidth - tooltip.offsetWidth - pad;
        const maxY = window.innerHeight - tooltip.offsetHeight - pad;
        const left = Math.min(position.x + pad, Math.max(pad, maxX));
        const top = Math.min(position.y + pad, Math.max(pad, maxY));

        tooltip.style.left = `${left}px`;
        tooltip.style.top = `${top}px`;
        tooltip.style.display = 'block';
    }

    /**
     * Pins the component tooltip at a fixed position.
     * @param {Object} component - The component to pin the tooltip for.
     * @param {Object} screenPos - The screen position {x, y} to pin at.
     */
    _pinComponentCodeTooltip(component, screenPos) {
        if (!component || !screenPos) return;
        this._componentCodeTooltipPinned = true;
        this._componentCodeTooltipPosition = { ...screenPos };
        this._updateComponentCodeTooltip(component, screenPos);
    }

    /**
     * Clears cached component/search data from IndexedDB storage and legacy localStorage.
     */
    async _clearComponentCaches() {
        if (!await this._confirm('Clear cached components and search results?', { title: 'Clear Cache', okText: 'Yes', cancelText: 'No' })) {
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
        if (typeof this._showSaveToast === 'function') {
            this._showSaveToast('Cache cleared');
        }
    }

    // ==================== Modal helpers ====================

    async _alert(message, options = {}) {
        await showAlert(message, options);
    }

    async _confirm(message, options = {}) {
        return await showConfirm(message, options);
    }

    async _prompt(message, options = {}) {
        return await showPrompt(message, options);
    }
    
    /**
     * Toggles between dark and light themes.
     */
    _toggleTheme() {
        toggleTheme(this);
    }
    
    /**
     * Loads the saved theme from storage on startup.
     */
    _loadTheme() {
        loadTheme(this);
    }
    
    /**
     * Updates grid size dropdown options for current units.
     */
    _updateGridDropdown() {
        updateGridDropdown(this);
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
        deleteSelected(this);
    }

    /**
     * Copies selected items to the internal clipboard.
     */
    _copySelection() {
        copySelection(this);
    }

    /**
     * Cancels paste preview and removes preview elements.
     */
    _cancelPaste() {
        cancelPaste(this);
    }
    
    // ==================== Box Selection ====================
    
    /**
     * Removes the box-selection element.
     */
    _removeBoxSelectElement() {
        removeBoxSelectElement(this);
    }
    
    // ==================== Shape State Helpers (for undo/redo) ====================
    
    /**
     * Captures a shape's state snapshot for undo.
     * @param {Object} shape - The shape to capture state from.
     * @returns {Object} The captured state snapshot.
     */
    _captureShapeState(shape) {
        return captureShapeState(this, shape);
    }
    
    /**
     * Restores a shape from a captured state snapshot.
     * @param {Object} shape - The shape to restore.
     * @param {Object} state - The state snapshot to apply.
     */
    _applyShapeState(shape, state) {
        applyShapeState(this, shape, state);
    }
    
    /**
     * Zooms and pans to fit all content.
     */
    _fitToContent() {
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
    _serializeDocument() {
        return this.project ? this.project.serialize() : this.serializeSection();
    }

    /**
     * Loads a whole project document from serialized data, restoring every
     * registered section via the project owner when present.
     * @param {Object} data - The serialized document data.
     * @returns {Promise<void>}
     */
    async _loadDocument(data) {
        if (this.project) {
            await this.project.load(data);
        } else {
            await this.loadSection(data);
        }
    }

    /** @param {'new'|'open'|'import'} reason */
    _notifyDocumentReplaced(reason) {
        if (this.project) this.project.notifyDocumentReplaced(reason);
        else this.onDocumentReplaced();
    }

    // ── ProjectDocument view interface ────────────────────────────────

    isSectionEditing() {
        return !!(hasSchematicPropertyPreview(this) || this.drag || this.pendingAnchorDrag
            || this.isDrawing || this.textEdit || this.pastingClipboard || this.placingComponent);
    }

    onDocumentReplaced() {
        this._setActiveRibbonTab?.('home');
    }

    onProjectChanged() {
        this._updateTitle();
    }

    _onHistoryChanged() {
        this._updateUndoRedoButtons();
        this.project?.notifySchematicChanged();
    }

    _onDirtyChanged() {
        this._updateTitle();
        this.project?.notifySchematicChanged();
    }

    onAutoSaveError() {
        return this._alert('Auto-save failed: storage full or unavailable. Your changes are still open, but are not being backed up. Save your project to disk.',
            { title: 'Auto-save Failed' });
    }

    // Existing interaction modules use these aliases, never a second collection.
    get shapes() { return this.document.shapes; }
    set shapes(value) { this.document.shapes = value; }
    get components() { return this.document.components; }
    set components(value) { this.document.components = value; }

    /** Refresh presentation after a project-owned reference operation. */
    onComponentReferenceChanged(id) {
        const component = this.components.find(item => item.id === id);
        if (!component) return;
        component.invalidate();
        component.refText?.invalidate();
        this.renderShapes(true);
    }

    /** Current view preferences only; authored state is serialized by the project model. */
    getViewSettings() {
        return FileTools.serializeViewSettings(this.viewport);
    }

    /**
     * Retained direct-editor API for the schematic envelope.
     * ProjectDocument serializes the model itself.
     * @returns {Object}
     */
    serializeSection() {
        return FileTools.serializeDocument(this);
    }

    /** Validate and render replacement entities before either editor is changed. */
    prepareSection(data) {
        return FileTools.prepareDocument(this, data);
    }

    /** Restore this editor's slice, consuming project preflight when provided. */
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
     * @param {Object} data - The serialized shape data.
     * @returns {Object|null} The created shape, or null if the type is unknown.
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
    _clearAllShapes() {
        for (const shape of this.shapes) discardShapeView(this, shape);
        this.shapes = [];
        this._updateSelectableItems();
        this.history.clear();
        this._updateUndoRedoButtons();
    }
    
    /**
     * Removes all components and their field texts.
     */
    _clearAllComponents() {
        for (const comp of this.components) {
            // Remove field texts from shapes array and DOM
            for (const ft of comp.getFieldTexts()) {
                const idx = this.shapes.indexOf(ft);
                if (idx !== -1) this.shapes.splice(idx, 1);
                discardShapeView(this, ft);
            }
            discardComponentView(this, comp);
        }
        this.components = [];
        this._updateSelectableItems();
    }
    
    /**
     * Updates document title with filename and dirty indicator.
     */
    _updateTitle() {
        FileTools.updateTitle(this);
    }
    
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
}
