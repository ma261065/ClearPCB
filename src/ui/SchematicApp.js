// SchematicApp.js - Schematic Editor Application

import { Viewport } from '../core/Viewport.js';
import { globalEventBus } from '../core/EventBus.js';
import { CommandHistory } from '../core/CommandHistory.js';
import { SelectionManager } from '../core/SelectionManager.js';
import { FileManager } from '../core/FileManager.js';
import { pointsMatch } from '../core/geometry.js';
import { ComponentPicker } from '../components/ComponentPicker.js';
import { createShape } from '../shapes/index.js';
import { getComponentLibrary } from '../components/index.js';
// Modules with a small public API use named imports; modules with many
// exports (wire, drawing, components, files, export) use namespace imports
// to keep the import block manageable.
import { bindMouseEvents } from './modules/mouse.js';
import { handleEscape, bindKeyboardShortcuts } from './modules/keyboard.js';
import { bindPropertiesPanel, applyCommonProperty, updatePropertiesPanel } from './modules/properties.js';
import { bindRibbon, updateShapePanelOptions } from './modules/ribbon.js';
import { updateCrosshair, getToolIconPath, setToolCursor, showCrosshair, hideCrosshair } from './modules/cursor.js';
import { bindViewportControls, updateGridDropdown, fitToContent } from './modules/viewport.js';
import { bindThemeToggle, toggleTheme, loadTheme, updateComponentColors } from './modules/theme.js';
import { toggleSelectionLock, deleteSelected, captureShapeState, applyShapeState } from './modules/selection.js';
import { copySelection, cutSelection, beginPastePreview, updatePastePreview, confirmPaste, cancelPaste } from './modules/clipboard.js';
import { createBoxSelectElement, updateBoxSelectElement, removeBoxSelectElement, getBoxSelectBounds } from './modules/box-selection.js';
import { bindPaperEvents } from './modules/paper.js';
import * as WireTools from './modules/wire.js';
import * as DrawingTools from './modules/drawing.js';
import * as ComponentTools from './modules/components.js';
import * as FileTools from './modules/files.js';
import * as ExportTools from './modules/export.js';
import { onToolSelected, onComponentPickerClosed, onOptionsChanged, loadToolOptions } from './modules/tool.js';
import { adaptShortcutsInDOM } from './modules/platform-keys.js';
import { setupCallbacks } from './modules/callbacks.js';
import { updateUndoRedoButtons, makeHelpPanelDraggable } from './modules/ui-utils.js';
import { needsValueDialog, showValueDialog } from './modules/value-dialog.js';
import { showAlert, showConfirm, showPrompt } from './modules/modal.js';
import {
    startTextEdit,
    endTextEdit,
    handleTextEditKey,
    updateTextEditOverlay,
    setTextCaretFromScreen,
    nudgeTextEditOverlay
} from './modules/text-edit.js';
import {
    addShape,
    addShapeInternal,
    addShapeInternalAt,
    commandAddShapeInternal,
    commandRemoveShapeInternal,
    commandDeleteShapesInternal,
    commandRestoreShapesInternal,
    removeShapeInternal,
    renderShapes
} from './modules/shape-management.js';

// Shape construction uses createShape() from shapes/index.js.

/**
 * Central application class — a thin facade over the `ui/modules/` layer.
 *
 * Almost all logic lives in the module files (mouse.js, wire.js, drawing.js,
 * keyboard.js, etc.).  Methods here delegate to those modules, passing `this`
 * as the shared app context.  If you're looking for how a feature works, check
 * the corresponding module rather than this file.
 *
 * The constructor is the single source of truth for application state — every
 * property that modules read or write on `app` is initialised here.
 */
class SchematicApp {

    /**
     * Initializes the schematic editor app: viewport, event bus, history, selection, UI elements, component picker, and binds all event handlers.
     */
    constructor() {
        this.fileManager = new FileManager();
        // Auto-save recovery now runs after initialization.
        this._skipAutoSaveRecovery = !!/** @type {any} */ (window)._launchFile;

        this.container = document.getElementById('canvasContainer');
        this.viewport = new Viewport(this.container);
        /** @type {any} */ (this.viewport)._app = this; // back-reference for state-aware pan suppression
        this.eventBus = globalEventBus;
        this.history = new CommandHistory({
            onChanged: () => {
                this._updateUndoRedoButtons();
            }
        });
        // fileManager already created above
        this.fileManager.onDirtyChanged = () => this._updateTitle();
        this.fileManager.onFileNameChanged = () => this._updateTitle();

        // Shape/selection state
        this.shapes = [];
        this.components = [];
        this.selection = new SelectionManager({
            onSelectionChanged: (shapes) => this._onSelectionChanged(shapes)
        });
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

        // ── Crosshair ──────────────────────────────────────────────────
        this.crosshair = {
            container: document.getElementById('drawingCrosshair'),
            lineX: document.getElementById('crosshairX'),
            lineY: document.getElementById('crosshairY'),
            toolIcon: document.getElementById('crosshairToolIcon')
        };

        // ── Drag state (mutated by mouse-states.js / drag.js) ────────
        this.drag = null;                  // { mode, shape, ... } — see mouse-states.js begin*Session
        this.didDrag = false;              // true once an actual drag occurred
        this.pendingAnchorDrag = null;     // deferred anchor drag (before threshold is met)
        this.skipClickSelection = false;
        this._collinearGuides = null;      // guide lines rendered during anchor drag
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
        document.querySelector('.status-bar')?.addEventListener('contextmenu', (e) => {
            e.preventDefault();
        });

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



        // Start auto-save
        this.fileManager.startAutoSave(() => this._serializeDocument());

        // Eagerly warm the KiCad index cache in the background.
        // If the cache is fresh this is a no-op; if expired it silently
        // refreshes so the index is ready when the user opens the picker.
        this.componentLibrary.kicadFetcher?.ensureIndexLoaded()
            ?.catch(err => console.warn('KiCad background index warm-up failed:', err));

        // Warn about unsaved changes
        window.addEventListener('beforeunload', (e) => {
            if (this.fileManager.isDirty) {
                e.preventDefault();
                e.returnValue = '';
            }
        });


        // If we have a pending auto-load, do it now that everything is ready
        if (this._pendingAutoLoad) {
            // Use the same logic as loadDocument
            import('./modules/files.js').then(async FileTools => {
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
            if (await this._confirm(`Recover autosaved file "${entry.fileName}" from ${time}?`, { title: 'Recover Autosave', okText: 'Yes', cancelText: 'No' })) {
                await this._applyAutoSave(entry);
            } else {
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
            if (this._initComplete) {
                await this._loadDocument(saved.data);
            } else {
                this.shapes = [];
                this.components = [];
                this.ui = /** @type {any} */ ({});
                this._pendingAutoLoad = saved.data;
            }
            if (saved.fileName) this.fileManager.setFileName(saved.fileName);
            this.fileManager.setDirty(true);
            console.log('Recovered auto-saved content');
        }
    }

    /**
     * Handles Escape key, cascading through active operations (text edit, drawing, placement, etc.).
     */
    _handleEscape() {
        return handleEscape(this);
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
     * Shifts the text-edit overlay by the given delta.
     * @param {number} dx - Horizontal offset.
     * @param {number} dy - Vertical offset.
     */
    _nudgeTextEditOverlay(dx, dy) {
        nudgeTextEditOverlay(this, dx, dy);
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
     * Reverts to select tool when the component picker closes.
     */
    _onComponentPickerClosed() {
        onComponentPickerClosed(this);
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
     * Adds a shape without undo (used by command execution).
     * @param {Object} shape - The shape to add internally.
     * @returns {*} The result of the internal add.
     */
    _addShapeInternal(shape) {
        return addShapeInternal(this, shape);
    }
    
    /**
     * Inserts a shape at a specific array index without undo.
     * @param {Object} shape - The shape to insert.
     * @param {number} index - The array position to insert at.
     * @returns {*} The result of the insertion.
     */
    _addShapeInternalAt(shape, index) {
        return addShapeInternalAt(this, shape, index);
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
     * Begins a shape-drawing session at the given position.
     * @param {Object} worldPos - The starting world coordinate {x, y}.
     */
    _startDrawing(worldPos) {
        DrawingTools.startDrawing(this, worldPos);
    }
    
    /**
     * Updates the drawing preview as the cursor moves.
     * @param {Object} worldPos - The current world coordinate {x, y}.
     */
    _updateDrawing(worldPos) {
        DrawingTools.updateDrawing(this, worldPos);
    }
    
    /**
     * Completes the drawing and creates the final shape.
     * @param {Object} worldPos - The ending world coordinate {x, y}.
     */
    _finishDrawing(worldPos) {
        DrawingTools.finishDrawing(this, worldPos);
    }
    
    /**
     * Adds a vertex to the in-progress polygon.
     * @param {Object} worldPos - The vertex world coordinate {x, y}.
     */
    _addPolygonPoint(worldPos) {
        DrawingTools.addPolygonPoint(this, worldPos);
    }
    
    /**
     * Completes the polygon (at least 3 points required).
     */
    _finishPolygon() {
        DrawingTools.finishPolygon(this);
    }

    /**
     * Adds a vertex to the in-progress polyline.
     * @param {Object} worldPos - The vertex world coordinate {x, y}.
     */
    _addLinePoint(worldPos) {
        DrawingTools.addLinePoint(this, worldPos);
    }

    /**
     * Completes the multi-segment line.
     */
    _finishLine() {
        DrawingTools.finishLine(this);
    }
    
    /**
     * Cancels drawing, removing preview and resetting state.
     */
    _cancelDrawing() {
        DrawingTools.cancelDrawing(this);
    }
    
    /**
     * Creates a preview SVG element for the shape being drawn.
     */
    _createPreview() {
        DrawingTools.createPreview(this);
    }
    
    
    /**
     * Returns the effective stroke width at current zoom.
     * @param {number} lineWidth - The base line width.
     * @returns {number} The effective stroke width.
     */
    _getEffectiveStrokeWidth(lineWidth) {
        return DrawingTools.getEffectiveStrokeWidth(this, lineWidth);
    }
    
    /**
     * Redraws the preview SVG for the current tool and cursor position.
     */
    _updatePreview() {
        DrawingTools.updatePreview(this);
    }
    
    /**
     * Instantiates a shape from the current drawing state.
     * @returns {Object|null} The created shape, or null.
     */
    _createShapeFromDrawing() {
        return DrawingTools.createShapeFromDrawing(this);
    }

    // ==================== Wire Drawing ====================
    
    /** Get snapped position for wire drawing with orthogonal routing */
    _getWireSnappedPosition(worldPos) {
        return WireTools.getDrawingSnappedPosition(this, worldPos);
    }
    
    /**
     * Find the nearest pin within snap tolerance from a position
     * Returns {component, pin, distance, worldPos} or null if no pin nearby
     * @param {Object} worldPos - The position to check
     * @param {number} tolerance - Snap tolerance in mm (defaults to 0.5mm)
     */
    _findNearbyPin(worldPos, tolerance = 0.5) {
        return WireTools.findNearbyPin(this.components, worldPos, tolerance);
    }

    /**
     * Checks if two pin references refer to the same component pin.
     * @param {Object} pin1 - First pin reference.
     * @param {Object} pin2 - Second pin reference.
     * @returns {boolean} True if pins are identical.
     */
    _isSamePin(pin1, pin2) {
        return WireTools.isSamePin(pin1, pin2);
    }

    /**
     * Tests whether two points are coincident within epsilon.
     * @param {Object} a - First point {x, y}.
     * @param {Object} b - Second point {x, y}.
     * @param {number} [epsilon=1e-6] - Tolerance for comparison.
     * @returns {boolean} True if the points match.
     */
    _pointsMatch(a, b, epsilon = 1e-6) {
        return pointsMatch(a, b, epsilon);
    }
    
    /**
     * Begins wire drawing from a snapped position.
     * @param {Object} snappedData - The snapped position data.
     */
    _startWireDrawing(snappedData) {
        WireTools.startWireDrawing(this, snappedData);
    }
    
    /**
     * Updates the wire routing preview as the cursor moves.
     * @param {Object} worldPos - The current world coordinate {x, y}.
     */
    _updateWireDrawing(worldPos) {
        WireTools.updateWireDrawing(this, worldPos);
    }

    
    /**
     * Adds an intermediate waypoint to the wire being drawn.
     * @param {Object} waypointData - The waypoint position data.
     */
    _addWireWaypoint(waypointData) {
        WireTools.addWireWaypoint(this, waypointData);
    }
    
    /**
     * Completes wire drawing and creates the final wire shape.
     * @param {Object} worldPos - The ending world coordinate {x, y}.
     */
    _finishWireDrawing(worldPos) {
        WireTools.finishWireDrawing(this, worldPos);
    }
    
    /**
     * Cancels wire drawing and removes its preview.
     */
    _cancelWireDrawing() {
        WireTools.cancelWireDrawing(this);
    }
    
    /**
     * Refreshes the wire preview SVG element.
     */
    _updateWirePreview() {
        WireTools.updateWirePreview(this);
    }
    
    // ==================== Component Handling ====================
    
    /**
     * Enters component placement mode with a preview.
     * @param {Object} definition - The component definition to place.
     */
    _onComponentDefinitionSelected(definition) {
        ComponentTools.onComponentDefinitionSelected(this, definition);
    }
    
    /**
     * Creates a cursor-following preview of the component.
     * @param {Object} definition - The component definition to preview.
     */
    _createComponentPreview(definition) {
        ComponentTools.createComponentPreview(this, definition);
    }
    
    /**
     * Moves the component placement preview to follow the cursor.
     * @param {Object} worldPos - The current world coordinate {x, y}.
     */
    _updateComponentPreview(worldPos) {
        ComponentTools.updateComponentPreview(this, worldPos);
    }
    
    /**
     * Places a component instance at the given position.
     * @param {Object} worldPos - The world coordinate {x, y} for placement.
     */
    _placeComponent(worldPos) {
        ComponentTools.placeComponent(this, worldPos);
    }
    
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
     * Rotates placement preview or selected components +90 degrees.
     */
    _rotateComponentRight() {
        ComponentTools.rotateComponentRight(this);
    }

    /**
     * Rotates placement preview or selected components -90 degrees.
     */
    _rotateComponentLeft() {
        ComponentTools.rotateComponentLeft(this);
    }
    
    /**
     * Flips placement preview or selected components horizontally.
     */
    _flipComponentH() {
        ComponentTools.flipComponentH(this);
    }

    /**
     * Flips selected components vertically.
     */
    _flipComponentV() {
        ComponentTools.flipComponentV(this);
    }
    
    /**
     * Legacy alias for _flipComponentH().
     */
    _mirrorComponent() {
        ComponentTools.flipComponentH(this);
    }
    
    /**
     * Exits placement mode and removes the preview.
     */
    _cancelComponentPlacement() {
        ComponentTools.cancelComponentPlacement(this);
    }
    
    /**
     * Returns currently selected Component instances.
     * @returns {Array} The selected components.
     */
    _getSelectedComponents() {
        return ComponentTools.getSelectedComponents(this);
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
     * @param {Object|null} [screenPosOverride=null] - Optional screen position override.
     */
    _updateCrosshair(snapped, screenPosOverride = null) {
        updateCrosshair(this, snapped, screenPosOverride);
    }

    /**
     * Returns the SVG path string for a tool cursor icon.
     * @param {string} tool - The tool identifier.
     * @returns {string} The SVG path data.
     */
    _getToolIconPath(tool) {
        return getToolIconPath(tool);
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
     * Makes the help panel draggable by its header.
     */
    _makeHelpPanelDraggable() {
        makeHelpPanelDraggable();
    }
    
    /**
     * Shows the crosshair overlay.
     */
    _showCrosshair() {
        showCrosshair(this);
    }
    
    /**
     * Hides the crosshair overlay.
     */
    _hideCrosshair() {
        hideCrosshair(this);
    }
    
    /**
     * Emits selectionChanged on the event bus.
     * @param {Array} shapes - The currently selected shapes.
     */
    _onSelectionChanged(shapes) {
        this.eventBus.emit('selectionChanged', shapes);
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
     * Toggles locked state on selected items.
     */
    _toggleSelectionLock() {
        toggleSelectionLock(this);
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
            if (this.history.undo()) {
                this.renderShapes();
            }
        });
        
        this.ui.redoBtn.addEventListener('click', () => {
            if (this.history.redo()) {
                this.renderShapes();
            }
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
     * Clears cached component data from localStorage.
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
     * Updates component SVG colors for the current theme.
     */
    _updateComponentColors() {
        updateComponentColors(this);
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
     * Copies selection to clipboard then deletes the items.
     */
    _cutSelection() {
        cutSelection(this);
    }

    /**
     * Begins paste preview mode with clipboard contents.
     */
    _pasteClipboard() {
        beginPastePreview(this);
    }

    /**
     * Updates paste preview position as cursor moves.
     * @param {Object} worldPos - The current world coordinate {x, y}.
     */
    _updatePastePreview(worldPos) {
        updatePastePreview(this, worldPos);
    }

    /**
     * Places pasted items at the given position.
     * @param {Object} worldPos - The world coordinate {x, y} for placement.
     */
    _confirmPaste(worldPos) {
        confirmPaste(this, worldPos);
    }

    /**
     * Cancels paste preview and removes preview elements.
     */
    _cancelPaste() {
        cancelPaste(this);
    }
    
    // ==================== Box Selection ====================
    
    /**
     * Creates the box-selection marquee SVG element.
     */
    _createBoxSelectElement() {
        createBoxSelectElement(this);
    }
    
    /**
     * Updates the box-selection rectangle dimensions.
     * @param {Object} currentPos - The current cursor position {x, y}.
     */
    _updateBoxSelectElement(currentPos) {
        updateBoxSelectElement(this, currentPos);
    }
    
    /**
     * Removes the box-selection element.
     */
    _removeBoxSelectElement() {
        removeBoxSelectElement(this);
    }
    
    /**
     * Returns the bounding box of the box selection area.
     * @param {Object} currentPos - The current cursor position {x, y}.
     * @returns {Object} The bounding box {x, y, width, height}.
     */
    _getBoxSelectBounds(currentPos) {
        return getBoxSelectBounds(this, currentPos);
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
     * Serializes the document to a JSON-ready object.
     * @returns {Object} The serialized document data.
     */
    _serializeDocument() {
        return FileTools.serializeDocument(this);
    }
    
    /**
     * Loads a document from serialized data.
     * @param {Object} data - The serialized document data.
     * @returns {Promise<void>}
     */
    async _loadDocument(data) {
        await FileTools.loadDocument(this, data);
    }
    
    /**
     * Creates a component from serialized data.
     * @param {Object} data - The serialized component data.
     * @returns {Object} The created component instance.
     */
    _createComponentFromData(data) {
        return FileTools.createComponentFromData(this, data);
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
        for (const shape of this.shapes) {
            this.viewport.removeContent(shape.element);
            shape.destroy();
        }
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
                if (ft.element) this.viewport.removeContent(ft.element);
                ft.destroy();
            }
            if (comp.element) {
                this.viewport.removeContent(comp.element);
            }
            comp.destroy();
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
     * Checks for auto-saved content on startup.
     */
    async _checkAutoSave() {
        await FileTools.checkAutoSave(this);
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
        await FileTools.newFile(this);
    }
    
    /**
     * Saves the document; shows toast on success.
     * @returns {Promise<*>} The save result.
     */
    async saveFile() {
        return await FileTools.saveFile(this);
    }
    
    /**
     * Saves with a new file name/location.
     * @returns {Promise<*>} The save result.
     */
    async saveFileAs() {
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
     * Lazy-loads jsPDF and svg2pdf vendor scripts.
     * @returns {Promise<Function>}
     */
    _loadVectorPdfLibs() {
        return ExportTools.loadVectorPdfLibs(this);
    }

    /**
     * Deep-clones viewport SVG for export with inlined styles.
     * @returns {{svgNode: SVGSVGElement, paperSize: {width: number, height: number}|null}} Export payload.
     */
    _cloneViewportSvgForExport() {
        return ExportTools.cloneViewportSvgForExport(this);
    }

    /**
     * Forces all SVG colors to black for printing.
     * @param {SVGElement} svgRoot - The SVG root element to modify.
     */
    _forceMonochromeSvg(svgRoot) {
        ExportTools.forceMonochromeSvg(svgRoot);
    }

    /**
     * Copies computed styles to a cloned SVG.
     * @param {SVGSVGElement} originalSvg - The original SVG element.
     * @param {SVGSVGElement} clonedSvg - The cloned SVG element to receive styles.
     */
    _inlineSvgComputedStyles(originalSvg, clonedSvg) {
        ExportTools.inlineSvgComputedStyles(originalSvg, clonedSvg);
    }

    /**
     * Saves a Blob via File System Access API.
     * @param {Blob} blob - The data blob to save.
     * @param {string} suggestedName - The suggested file name.
     * @param {string} mimeType - The MIME type of the file.
     * @param {Array<string>} extensions - Accepted file extensions.
     * @returns {Promise<void>}
     */
    async _saveBlobAsFile(blob, suggestedName, mimeType, extensions) {
        await ExportTools.saveBlobAsFile(blob, suggestedName, mimeType, extensions);
    }

    /**
     * Renders viewport to a canvas at the given scale.
     * @param {number} [scale=2] - The rendering scale factor.
     * @returns {Promise<HTMLCanvasElement>} The rendered canvas element.
     */
    _renderViewportToCanvas(scale = 2) {
        return ExportTools.renderViewportToCanvas(this, scale);
    }
    
    /**
     * Opens a file via picker and loads it.
     * @returns {Promise<void>}
     */
    async openFile() {
        await FileTools.openFile(this);
    }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', async () => {
    /** @type {any} */ (window).app = new SchematicApp();
    const app = /** @type {any} */ (window).app;
    await app._recoverAutoSave?.();
});