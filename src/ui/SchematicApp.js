// SchematicApp.js - Schematic Editor Application

import { Viewport } from '../core/Viewport.js';
import { EventBus, Events, globalEventBus } from '../core/EventBus.js';
import { CommandHistory } from '../core/CommandHistory.js';
import { SelectionManager } from '../core/SelectionManager.js';
import { FileManager } from '../core/FileManager.js';
import { ComponentPicker } from '../components/ComponentPicker.js';
import { Line, Wire, Circle, Rect, Arc, Polygon, Text } from '../shapes/index.js';
import { getComponentLibrary } from '../components/index.js';
import { bindMouseEvents } from './modules/mouse.js';
import { bindKeyboardShortcuts } from './modules/keyboard.js';
import { bindPropertiesPanel, applyCommonProperty, updatePropertiesPanel } from './modules/properties.js';
import { bindRibbon, updateShapePanelOptions } from './modules/ribbon.js';
import { updateCrosshair, getToolIconPath, setToolCursor, showCrosshair, hideCrosshair } from './modules/cursor.js';
import { bindViewportControls, updateGridDropdown, fitToContent } from './modules/viewport.js';
import { bindThemeToggle, toggleTheme, loadTheme, updateComponentColors } from './modules/theme.js';
import { toggleSelectionLock, deleteSelected, captureShapeState, applyShapeState } from './modules/selection.js';
import { createBoxSelectElement, updateBoxSelectElement, removeBoxSelectElement, getBoxSelectBounds } from './modules/box-selection.js';
import { bindPaperEvents } from './modules/paper.js';
import * as WireTools from './modules/wire.js';
import * as DrawingTools from './modules/drawing.js';
import * as ComponentTools from './modules/components.js';
import * as FileTools from './modules/files.js';
import * as ExportTools from './modules/export.js';
import { handleEscape } from './modules/input.js';
import { setupEventBusListeners } from './modules/event-bus.js';
import { onToolSelected, onComponentPickerClosed, onOptionsChanged, loadToolOptions } from './modules/tool.js';
import { updateSelectableItems, generateReference, getSelectedComponents, renderComponents } from './modules/components-utils.js';
import { setupCallbacks } from './modules/callbacks.js';
import { updateUndoRedoButtons, makeHelpPanelDraggable } from './modules/ui-utils.js';
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
    removeShapeInternal,
    renderShapes
} from './modules/shape-management.js';

// Shape class registry for deserialization
const ShapeClasses = { Line, Wire, Circle, Rect, Arc, Polygon, Text };

class SchematicApp {

    constructor() {
        // Check for auto-saved content before initializing anything else
        // (FileManager is needed for this)
        this.fileManager = new FileManager();
        // Present a list of autosaved files for recovery (only if valid entries exist)
        let index = [];
        try {
            index = JSON.parse(localStorage.getItem(this.fileManager.autoSavePrefix + 'index')) || [];
        } catch {}
        // Remove autosaves older than 7 days (age out old autosaves)
        const now = Date.now();
        const weekMs = 7 * 24 * 60 * 60 * 1000;
        let changed = false;
        index = index.filter(entry => {
            // Remove if missing or too old
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
        if (index.length > 0) {
            // Sort by timestamp desc
            index.sort((a, b) => b.timestamp - a.timestamp);
            let listMsg = 'Autosaved files found:\n';
            index.forEach((entry, i) => {
                const time = new Date(entry.timestamp).toLocaleString();
                listMsg += `${i + 1}. ${entry.fileName} (saved ${time})\n`;
            });
            listMsg += '\nEnter the number to recover, or D<number> to delete:';
            let choice = prompt(listMsg);
            if (choice) {
                choice = choice.trim();
                if (/^d\d+$/i.test(choice)) {
                    // Delete entry
                    const idx = parseInt(choice.slice(1)) - 1;
                    if (index[idx]) {
                        this.fileManager.clearAutoSave(index[idx].fileName);
                        alert(`Deleted autosave for ${index[idx].fileName}`);
                        // Optionally, reload to re-prompt
                        location.reload();
                        return;
                    }
                } else {
                    const idx = parseInt(choice) - 1;
                    if (index[idx]) {
                        const saved = this.fileManager.loadAutoSave(index[idx].fileName);
                        if (saved && saved.data) {
                            this.shapes = [];
                            this.components = [];
                            this.ui = {};
                            this._pendingAutoLoad = saved.data;
                            if (saved.fileName) {
                                this.fileManager.setFileName(saved.fileName);
                            }
                            this.fileManager.setDirty(true);
                            console.log('Recovered auto-saved content');
                        }
                    }
                }
            }
        }
        this.container = document.getElementById('canvasContainer');
        this.viewport = new Viewport(this.container);
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

        // Tool/drawing state
        this.currentTool = 'select';
        this.isDrawing = false;
        this.drawStart = null;
        this.drawCurrent = null;
        this.polygonPoints = [];
        this.previewElement = null;
        this.wirePoints = [];
        this.wireSnapPin = null;
        this.wireStartPin = null;
        this.wireAutoCorner = null;
        this.wireActiveAxis = null;
        this.wireLastAdjustedPoint = null;
        this.lastSnappedData = null;

        // Crosshair
        this.crosshair = {
            container: document.getElementById('drawingCrosshair'),
            lineX: document.getElementById('crosshairX'),
            lineY: document.getElementById('crosshairY'),
            toolIcon: document.getElementById('crosshairToolIcon')
        };

        // Drag state
        this.isDragging = false;
        this.didDrag = false;  // Track if actual drag occurred
        this.dragMode = null;  // 'move', 'anchor', or 'box'
        this.dragStart = null;
        this.dragAnchorId = null;
        this.dragShape = null;
        this.dragWireAnchorOriginal = null;
        this.skipClickSelection = false;

        // Box selection
        this.boxSelectElement = null;
        this.boxSelectStart = null;

        // Drag tracking for undo/redo
        this.dragTotalDx = 0;
        this.dragTotalDy = 0;
        this.dragShapesBefore = null;  // State before drag for anchor modifications

        // Tool options
        const savedOptions = loadToolOptions();
        this.toolOptions = savedOptions || {
            lineWidth: 0.25,
            fill: false,
            color: '#00cc66',  // Default wire color - matches --sch-wire
            fontSize: 2.0
        };

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
            propertiesHeaderLabel: document.getElementById('propertiesHeaderLabel'),
            propSelectionCount: document.getElementById('propSelectionCount'),
            propLocked: document.getElementById('propLocked'),
            propLineWidth: document.getElementById('propLineWidth'),
            propFill: document.getElementById('propFill'),
            propTextSize: document.getElementById('propTextSize')
        };

        // Help panel now lives in ribbon

        // Component library and picker
        this.componentLibrary = getComponentLibrary();
        this.componentPicker = new ComponentPicker({
            onComponentSelected: (def) => this._onComponentDefinitionSelected(def),
            onClose: () => this._onComponentPickerClosed(),
            eventBus: this.eventBus
        });
        this.componentPicker.appendTo(this.container);

        // Component placement state
        this.placingComponent = null;  // Definition being placed
        this.componentPreview = null;  // Preview SVG element
        this.componentRotation = 0;    // Current rotation for placement
        this.componentMirror = false;  // Current mirror state

        this._setupCallbacks();
        this._setupEventBusListeners();
        this._bindUIControls();
        this._bindMouseEvents();
        this._bindKeyboardShortcuts();
        bindPaperEvents(this);

        // Initial view
        this.viewport.resetView();
        this._updateTitle();



        // Start auto-save
        this.fileManager.startAutoSave(() => this._serializeDocument());

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
            import('./modules/files.js').then(FileTools => {
                FileTools.loadDocument(this, this._pendingAutoLoad);
                this._pendingAutoLoad = null;
            });
        }

        // Load version after a brief delay to ensure DOM is ready
        setTimeout(() => this._loadVersion(), 100);

        console.log('Schematic Editor initialized');
    }

    _handleEscape() {
        handleEscape(this);
    }

    _startTextEdit(shape) {
        startTextEdit(this, shape);
    }

    _endTextEdit(commit = true) {
        endTextEdit(this, commit);
    }

    _handleTextEditKey(e) {
        return handleTextEditKey(this, e);
    }

    _updateTextEditOverlay() {
        updateTextEditOverlay(this);
    }

    _nudgeTextEditOverlay(dx, dy) {
        nudgeTextEditOverlay(this, dx, dy);
    }

    _setTextEditCaretFromScreen(screenPos) {
        setTextCaretFromScreen(this, screenPos);
    }

    // Setup EventBus listeners for cross-module communication
    _setupEventBusListeners() {
        setupEventBusListeners(this);
    }

    // ==================== Tool Handling ====================
    
    _onToolSelected(tool) {
        onToolSelected(this, tool);
        this.eventBus.emit('toolChanged', tool);
    }
    
    _onComponentPickerClosed() {
        onComponentPickerClosed(this);
    }
    
    _onOptionsChanged(options) {
        onOptionsChanged(this, options);
    }

    // ==================== Shape Management ====================
    
    // Add a shape (creates an undoable command)
    addShape(shape) {
        return addShape(this, shape);
    }
    
    // Internal add - used by commands, no history entry
    _addShapeInternal(shape) {
        return addShapeInternal(this, shape);
    }
    
    // Internal add at specific index - used by undo
    _addShapeInternalAt(shape, index) {
        return addShapeInternalAt(this, shape, index);
    }
    
    /**
     * Internal remove - used by commands, no history entry
     * Does NOT destroy the shape so it can be re-added on undo
     */
    _removeShapeInternal(shape) {
        removeShapeInternal(this, shape);
    }
    
    renderShapes(force = false) {
        renderShapes(this, force);
    }

    // ==================== Drawing ====================
    
    _startDrawing(worldPos) {
        DrawingTools.startDrawing(this, worldPos);
    }
    
    _updateDrawing(worldPos) {
        DrawingTools.updateDrawing(this, worldPos);
    }
    
    _finishDrawing(worldPos) {
        DrawingTools.finishDrawing(this, worldPos);
    }
    
    _addPolygonPoint(worldPos) {
        DrawingTools.addPolygonPoint(this, worldPos);
    }
    
    _finishPolygon() {
        DrawingTools.finishPolygon(this);
    }
    
    _cancelDrawing() {
        DrawingTools.cancelDrawing(this);
    }
    
    _createPreview() {
        DrawingTools.createPreview(this);
    }
    
    
    // Calculate effective stroke width with minimum screen pixel size
    _getEffectiveStrokeWidth(lineWidth) {
        return DrawingTools.getEffectiveStrokeWidth(this, lineWidth);
    }
    
    _updatePreview() {
        DrawingTools.updatePreview(this);
    }
    
    _createShapeFromDrawing() {
        return DrawingTools.createShapeFromDrawing(this);
    }

    // ==================== Wire Drawing ====================
    
    /**
     * Get snapped position for wire drawing with directional routing
     * First segment from pin: lock Y (horizontal) or X (vertical)
     * Later segments: grid snap, but override with target pin Y/X when approaching
     */
    _getWireSnappedPosition(worldPos) {
        return WireTools.getWireSnappedPosition(this, worldPos);
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

    // Check if two pins are the same (by component and pin number)
    _isSamePin(pin1, pin2) {
        return WireTools.isSamePin(pin1, pin2);
    }

    // Check if two points are essentially the same (within epsilon)
    _pointsMatch(a, b, epsilon = 1e-6) {
        return WireTools.pointsMatch(a, b, epsilon);
    }

    // Get display position adjusted for target pin snapping (with fake grid consideration)
    _getDisplayPosition(targetPin, drawPos, lastPoint, gridSize) {
        if (!targetPin) return { position: drawPos, adjusted: false, axis: null };
        
        const pinX = targetPin.worldPos.x;
        const pinY = targetPin.worldPos.y;
        
        // Distance to target pin's fake grid lines
        const distToFakeX = Math.abs(drawPos.x - pinX);  // How far from vertical line
        const distToFakeY = Math.abs(drawPos.y - pinY);  // How far from horizontal line
        
        // Since we already detected the pin at 1.0mm tolerance, snap fully to its axes
        let position = drawPos;
        
        if (distToFakeY < distToFakeX) {
            // Closer to horizontal line - snap Y to pin
            position = { x: drawPos.x, y: pinY };
        } else {
            // Closer to vertical line (or equal) - snap X to pin
            position = { x: pinX, y: drawPos.y };
        }
        
        return { position, adjusted: position !== drawPos };
    }

    // Check auto-corner triggers (deadband and grid-line crossing)
    _checkAutoCornerTriggers(rawDx, rawDy, primaryDir, gridSize, lastWorldPos, worldPos) {
        return WireTools.checkAutoCornerTriggers(this, rawDx, rawDy, primaryDir, gridSize, lastWorldPos, worldPos);
    }
    
    // Start drawing a wire - click to place first point or snap to pin
    _startWireDrawing(snappedData) {
        WireTools.startWireDrawing(this, snappedData);
    }
    
    // Update wire preview while drawing
    _updateWireDrawing(worldPos) {
        WireTools.updateWireDrawing(this, worldPos);
    }

    // Get snapped position for wire anchor editing, allowing snap to original position
    _getWireAnchorSnappedPosition(wireShape, anchorId, worldPos) {
        return WireTools.getWireAnchorSnappedPosition(this, wireShape, anchorId, worldPos);
    }
    
    // Add a waypoint to the wire
    _addWireWaypoint(waypointData) {
        WireTools.addWireWaypoint(this, waypointData);
    }
    
    // Finish drawing the wire
    _finishWireDrawing(worldPos) {
        WireTools.finishWireDrawing(this, worldPos);
    }
    
    // Cancel wire drawing
    _cancelWireDrawing() {
        WireTools.cancelWireDrawing(this);
    }
    
    // Update wire preview visualization
    _updateWirePreview() {
        WireTools.updateWirePreview(this);
    }
    
    // Highlight a pin during snapping
    _highlightPin(snapPin) {
        WireTools.highlightPin(this, snapPin);
    }
    
    // Remove pin highlight
    _unhighlightPin() {
        WireTools.unhighlightPin(this);
    }

    // ==================== Component Handling ====================
    
    // Called when a component definition is selected in the picker
    _onComponentDefinitionSelected(definition) {
        ComponentTools.onComponentDefinitionSelected(this, definition);
    }
    
    // Create component preview that follows cursor
    _createComponentPreview(definition) {
        ComponentTools.createComponentPreview(this, definition);
    }
    
    // Update component preview position
    _updateComponentPreview(worldPos) {
        ComponentTools.updateComponentPreview(this, worldPos);
    }
    
    // Place the current component at the given position
    _placeComponent(worldPos) {
        ComponentTools.placeComponent(this, worldPos);
    }
    
    // Update SelectionManager with all selectable items (shapes + components)
    _updateSelectableItems() {
        updateSelectableItems(this);
    }
    
    // Generate a reference designator for a component
    _generateReference(definition) {
        return generateReference(this, definition);
    }
    
    // Rotate component during placement (or selected components)
    _rotateComponent() {
        ComponentTools.rotateComponent(this);
    }
    
    // Mirror component during placement (or selected components)
    _mirrorComponent() {
        ComponentTools.mirrorComponent(this);
    }
    
    // Cancel component placement mode
    _cancelComponentPlacement() {
        ComponentTools.cancelComponentPlacement(this);
    }
    
    // Get selected components (for future selection integration)
    _getSelectedComponents() {
        return getSelectedComponents(this);
    }
    
    // Render all components
    renderComponents() {
        renderComponents(this);
    }

    // ==================== Callbacks ====================

    _setupCallbacks() {
        setupCallbacks(this);
    }
    
    _updateCrosshair(snapped, screenPosOverride = null) {
        updateCrosshair(this, snapped, screenPosOverride);
    }

    _getToolIconPath(tool) {
        return getToolIconPath(tool);
    }

    _setToolCursor(tool, svg) {
        setToolCursor(this, tool, svg);
    }

    _makeHelpPanelDraggable() {
        makeHelpPanelDraggable();
    }
    
    _showCrosshair() {
        showCrosshair(this);
    }
    
    _hideCrosshair() {
        hideCrosshair(this);
    }
    
    _onSelectionChanged(shapes) {
        console.log(`Selection: ${shapes.length} shape(s)`);
        this.renderShapes(true);
        this.eventBus.emit('selectionChanged', shapes);
    }

    _bindPropertiesPanel() {
        bindPropertiesPanel(this);
    }

    _bindRibbon() {
        bindRibbon(this);
    }

    _updateShapePanelOptions(selection, toolId) {
        updateShapePanelOptions(this, selection, toolId);
    }

    _toggleSelectionLock() {
        toggleSelectionLock(this);
    }

    _applyCommonProperty(prop, value) {
        applyCommonProperty(this, prop, value);
    }
    
    _updatePropertiesPanel(selection) {
        updatePropertiesPanel(this, selection);
    }

    // ==================== Mouse Events ====================
    
    _bindMouseEvents() {
        bindMouseEvents(this);
    }

    // ==================== UI Controls ====================

    _bindUIControls() {
        bindViewportControls(this);
        
        // Ribbon handles file/export actions
        
        // Undo/Redo buttons
        this.ui.undoBtn.addEventListener('click', () => {
            if (this.history.undo()) {
                this.renderShapes(true);
            }
        });
        
        this.ui.redoBtn.addEventListener('click', () => {
            if (this.history.redo()) {
                this.renderShapes(true);
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
    
    // Toggle between dark and light theme
    _toggleTheme() {
        toggleTheme(this);
    }
    
    // Load saved theme preference
    _loadTheme() {
        loadTheme(this);
    }
    
    // Update component colors for current theme
    _updateComponentColors() {
        updateComponentColors(this);
    }
    
    // Update grid dropdown options based on current units
    _updateGridDropdown() {
        updateGridDropdown(this);
    }

    _bindKeyboardShortcuts() {
        bindKeyboardShortcuts(this);
    }
    
    _deleteSelected() {
        deleteSelected(this);
    }
    
    // ==================== Box Selection ====================
    
    _createBoxSelectElement() {
        createBoxSelectElement(this);
    }
    
    _updateBoxSelectElement(currentPos) {
        updateBoxSelectElement(this, currentPos);
    }
    
    _removeBoxSelectElement() {
        removeBoxSelectElement(this);
    }
    
    _getBoxSelectBounds(currentPos) {
        return getBoxSelectBounds(this, currentPos);
    }
    
    // ==================== Shape State Helpers (for undo/redo) ====================
    
    // Capture the geometric state of a shape for undo/redo
    _captureShapeState(shape) {
        return captureShapeState(this, shape);
    }
    
    // Apply a captured state to a shape
    _applyShapeState(shape, state) {
        applyShapeState(this, shape, state);
    }
    
    _fitToContent() {
        fitToContent(this);
    }
    
    // ==================== File Operations ====================
    
    // Serialize document to JSON-compatible object
    _serializeDocument() {
        return FileTools.serializeDocument(this);
    }
    
    // Load shapes from document data
    _loadDocument(data) {
        FileTools.loadDocument(this, data);
    }
    
    // Create component instance from serialized data
    _createComponentFromData(data) {
        return FileTools.createComponentFromData(this, data);
    }
    
    // Create shape instance from serialized data
    _createShapeFromData(data) {
        const ShapeClass = ShapeClasses[data.type.charAt(0).toUpperCase() + data.type.slice(1)];
        if (!ShapeClass) {
            console.warn('Unknown shape type:', data.type);
            return null;
        }
        return new ShapeClass(data);
    }
    
    // Clear all shapes from canvas
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
    
    // Clear all components from canvas
    _clearAllComponents() {
        for (const comp of this.components) {
            if (comp.element) {
                this.viewport.removeContent(comp.element);
            }
            comp.destroy();
        }
        this.components = [];
        this._updateSelectableItems();
    }
    
    // Update window/document title
    _updateTitle() {
        FileTools.updateTitle(this);
    }
    
    // Update undo/redo button enabled states
    _updateUndoRedoButtons() {
        updateUndoRedoButtons(this);
    }
    
    // Check for auto-saved content on startup
    _checkAutoSave() {
        FileTools.checkAutoSave(this);
    }
    
    // Load and display version number
    async _loadVersion() {
        await FileTools.loadVersion(this);
    }
    
    // Create new document
    async newFile() {
        await FileTools.newFile(this);
    }
    
    // Save current document
    async saveFile() {
        return await FileTools.saveFile(this);
    }
    
    // Save As - always prompt for location
    async saveFileAs() {
        return await FileTools.saveFileAs(this);
    }

    // Save current view to PDF
    async savePdf() {
        await ExportTools.savePdf(this);
    }

    // Print current view with preview
    async print() {
        await ExportTools.printSchematic(this);
    }

    _loadVectorPdfLibs() {
        return ExportTools.loadVectorPdfLibs(this);
    }

    _cloneViewportSvgForExport() {
        return ExportTools.cloneViewportSvgForExport(this);
    }

    _forceMonochromeSvg(svgRoot) {
        ExportTools.forceMonochromeSvg(svgRoot);
    }

    _inlineSvgComputedStyles(originalSvg, clonedSvg) {
        ExportTools.inlineSvgComputedStyles(originalSvg, clonedSvg);
    }

    async _saveBlobAsFile(blob, suggestedName, mimeType, extensions) {
        await ExportTools.saveBlobAsFile(blob, suggestedName, mimeType, extensions);
    }

    // Render the current viewport SVG to a canvas
    _renderViewportToCanvas(scale = 2) {
        return ExportTools.renderViewportToCanvas(this, scale);
    }
    
    // Open file
    async openFile() {
        await FileTools.openFile(this);
    }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.app = new SchematicApp();
});