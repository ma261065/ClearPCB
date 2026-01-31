/**
 * SchematicApp.js - Schematic Editor Application
 */

import { Viewport } from '../core/Viewport.js';
import { EventBus, Events, globalEventBus } from '../core/EventBus.js';
import { CommandHistory, AddShapeCommand } from '../core/CommandHistory.js';
import { SelectionManager } from '../core/SelectionManager.js';
import { FileManager } from '../core/FileManager.js';
import { ComponentPicker } from '../components/ComponentPicker.js';
import { Line, Wire, Circle, Rect, Arc, Polygon, Text } from '../shapes/index.js';
import { getComponentLibrary } from '../components/index.js';
import { bindMouseEvents } from './modules/mouse.js';
import { bindKeyboardShortcuts } from './modules/keyboard.js';
import { bindPropertiesPanel, updatePropertiesPanel, applyCommonProperty } from './modules/properties.js';
import { bindRibbon, updateRibbonState, updateShapePanelOptions } from './modules/ribbon.js';
import { updateCrosshair, getToolIconPath, setToolCursor, showCrosshair, hideCrosshair } from './modules/cursor.js';
import { bindViewportControls, updateGridDropdown, fitToContent } from './modules/viewport.js';
import { bindThemeToggle, toggleTheme, loadTheme, updateComponentColors } from './modules/theme.js';
import { toggleSelectionLock, deleteSelected, captureShapeState, applyShapeState } from './modules/selection.js';
import { createBoxSelectElement, updateBoxSelectElement, removeBoxSelectElement, getBoxSelectBounds } from './modules/box-selection.js';
import {
    getWireSnappedPosition,
    getWireAnchorSnappedPosition,
    findNearbyPin,
    isSamePin,
    pointsMatch,
    checkAutoCornerTriggers,
    startWireDrawing,
    updateWireDrawing,
    addWireWaypoint,
    finishWireDrawing,
    cancelWireDrawing,
    updateWirePreview,
    highlightPin,
    unhighlightPin
} from './modules/wire.js';
import {
    startDrawing,
    updateDrawing,
    finishDrawing,
    addPolygonPoint,
    finishPolygon,
    cancelDrawing,
    createPreview,
    getEffectiveStrokeWidth,
    updatePreview,
    createShapeFromDrawing
} from './modules/drawing.js';
import {
    onComponentDefinitionSelected,
    createComponentPreview,
    updateComponentPreview,
    placeComponent,
    rotateComponent,
    mirrorComponent,
    cancelComponentPlacement
} from './modules/components.js';
import {
    serializeDocument,
    loadDocument,
    createComponentFromData,
    updateTitle,
    checkAutoSave,
    loadVersion,
    newFile,
    saveFile,
    saveFileAs,
    openFile
} from './modules/files.js';
import {
    savePdf,
    loadVectorPdfLibs,
    cloneViewportSvgForExport,
    forceMonochromeSvg,
    inlineSvgComputedStyles,
    saveBlobAsFile,
    renderViewportToCanvas
} from './modules/export.js';

// Shape class registry for deserialization
const ShapeClasses = { Line, Wire, Circle, Rect, Arc, Polygon, Text };

class SchematicApp {
    constructor() {
        this.container = document.getElementById('canvasContainer');
        this.viewport = new Viewport(this.container);
        this.eventBus = globalEventBus;
        this.history = new CommandHistory({
            onChanged: () => {
                this._updateUndoRedoButtons();
            }
        });
        this.fileManager = new FileManager();
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
        this.toolOptions = {
            lineWidth: 0.2,
            fill: false,
            color: '#00cc66'  // Default wire color - matches --sch-wire
        };

        // UI elements
        this.ui = {
            cursorPos: document.getElementById('cursorPos'),
            gridSnap: document.getElementById('gridSnap'),
            zoomLevel: document.getElementById('zoomLevel'),
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
            propText: document.getElementById('propText'),
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

        // Initial view
        this.viewport.resetView();
        this._updateTitle();

        // Check for auto-saved content
        this._checkAutoSave();

        // Start auto-save
        this.fileManager.startAutoSave(() => this._serializeDocument());

        // Warn about unsaved changes
        window.addEventListener('beforeunload', (e) => {
            if (this.fileManager.isDirty) {
                e.preventDefault();
                e.returnValue = '';
            }
        });

        // Load version after a brief delay to ensure DOM is ready
        setTimeout(() => this._loadVersion(), 100);

        console.log('Schematic Editor initialized');
    }

    _handleEscape() {
        if (this.isDrawing) {
            if (this.currentTool === 'wire') {
                // Cancel wire drawing
                this._cancelWireDrawing();
            } else {
                this._cancelDrawing();
            }
        }
        // Cancel component placement
        if (this.placingComponent) {
            this._cancelComponentPlacement();
        }
        // Close component picker if open
        if (this.componentPicker.isOpen) {
            this.componentPicker.close();
        }
        // Cancel box selection if in progress
        if (this.dragMode === 'box') {
            this._removeBoxSelectElement();
            this.isDragging = false;
            this.dragMode = null;
            this.boxSelectStart = null;
        }
        // Always return to select mode on Escape
        if (this.currentTool !== 'select') {
            this._onToolSelected('select');
        } else {
            // Only clear selection if already in select mode and not drawing
            this.selection.clearSelection();
            this.renderShapes(true);
        }
    }

    /**
     * Setup EventBus listeners for cross-module communication
     */
    _setupEventBusListeners() {
        // Listen for component selection events
        this.eventBus.on('component:selected', (def) => {
            this._onComponentDefinitionSelected(def);
        });
    }

    // ==================== Tool Handling ====================
    
    _onToolSelected(tool) {
        // Cancel any in-progress drawing
        this._cancelDrawing();
        
        // Cancel component placement if switching away from component tool
        if (tool !== 'component' && this.placingComponent) {
            this._cancelComponentPlacement();
        }
        
        // Close component picker when switching away from component tool
        if (tool !== 'component' && this.componentPicker.isOpen) {
            this.componentPicker.close();
        }
        
        this.currentTool = tool;
        
        // Handle component tool - open picker panel
        if (tool === 'component') {
            // Open component picker if collapsed
            if (!this.componentPicker.isOpen) {
                this.componentPicker.open();
            }
            // Focus search input
            const searchInput = this.componentPicker.element.querySelector('.cp-search-input');
            if (searchInput) {
                searchInput.focus();
            }
        }
        
        // Update cursor
        const svg = this.viewport.svg;
        this._setToolCursor(tool, svg);

        this._setActiveToolButton?.(tool);
        this._updateShapePanelOptions(this.selection.getSelection(), tool);
    }
    
    _onComponentPickerClosed() {
        // Return to select mode when component picker is closed
        if (this.currentTool === 'component') {
            this._onToolSelected('select');
        }
    }
    
    _onOptionsChanged(options) {
        this.toolOptions = { ...this.toolOptions, ...options };
    }

    // ==================== Shape Management ====================
    
    /**
     * Add a shape (creates an undoable command)
     */
    addShape(shape) {
        const command = new AddShapeCommand(this, shape);
        this.history.execute(command);
        return shape;
    }
    
    /**
     * Internal add - used by commands, no history entry
     */
    _addShapeInternal(shape) {
        this.shapes.push(shape);
        shape.render(this.viewport.scale);
        this.viewport.addContent(shape.element);
        this._updateSelectableItems();
        this.selection._invalidateHitTestCache();  // Invalidate cache when shapes change
        this.fileManager.setDirty(true);
        return shape;
    }
    
    /**
     * Internal add at specific index - used by undo
     */
    _addShapeInternalAt(shape, index) {
        // Re-render if element was removed
        shape.render(this.viewport.scale);
        
        if (index >= 0 && index < this.shapes.length) {
            this.shapes.splice(index, 0, shape);
        } else {
            this.shapes.push(shape);
        }
        this.viewport.addContent(shape.element);
        this._updateSelectableItems();
        this.fileManager.setDirty(true);
        return shape;
    }
    
    /**
     * Internal remove - used by commands, no history entry
     * Does NOT destroy the shape so it can be re-added on undo
     */
    _removeShapeInternal(shape) {
        const idx = this.shapes.indexOf(shape);
        if (idx !== -1) {
            this.shapes.splice(idx, 1);
            if (shape.element && shape.element.parentNode) {
                shape.element.parentNode.removeChild(shape.element);
            }
            if (shape.anchorsGroup && shape.anchorsGroup.parentNode) {
                shape.anchorsGroup.parentNode.removeChild(shape.anchorsGroup);
            }
            this.selection.deselect(shape);
            this.selection._invalidateHitTestCache();  // Invalidate cache when shapes change
            this._updateSelectableItems();
            this.fileManager.setDirty(true);
        }
    }
    
    renderShapes(force = false) {
        for (const shape of this.shapes) {
            if (force || shape._dirty || shape.selected || shape.hovered) {
                shape.render(this.viewport.scale);
            }
        }
    }

    // ==================== Drawing ====================
    
    _startDrawing(worldPos) {
        startDrawing(this, worldPos);
    }
    
    _updateDrawing(worldPos) {
        updateDrawing(this, worldPos);
    }
    
    _finishDrawing(worldPos) {
        finishDrawing(this, worldPos);
    }
    
    _addPolygonPoint(worldPos) {
        addPolygonPoint(this, worldPos);
    }
    
    _finishPolygon() {
        finishPolygon(this);
    }
    
    _cancelDrawing() {
        cancelDrawing(this);
    }
    
    _createPreview() {
        createPreview(this);
    }
    
    
    // Calculate effective stroke width with minimum screen pixel size
    _getEffectiveStrokeWidth(lineWidth) {
        return getEffectiveStrokeWidth(this, lineWidth);
    }
    
    _updatePreview() {
        updatePreview(this);
    }
    
    _createShapeFromDrawing() {
        return createShapeFromDrawing(this);
    }

    // ==================== Wire Drawing ====================
    
    /**
     * Get snapped position for wire drawing with directional routing
     * First segment from pin: lock Y (horizontal) or X (vertical)
     * Later segments: grid snap, but override with target pin Y/X when approaching
     */
    _getWireSnappedPosition(worldPos) {
        return getWireSnappedPosition(this, worldPos);
    }
    
    /**
     * Find the nearest pin within snap tolerance from a position
     * Returns {component, pin, distance, worldPos} or null if no pin nearby
     * @param {Object} worldPos - The position to check
     * @param {number} tolerance - Snap tolerance in mm (defaults to 0.5mm)
     */
    _findNearbyPin(worldPos, tolerance = 0.5) {
        return findNearbyPin(this, worldPos, tolerance);
    }

    /**
     * Check if two pins are the same (by component and pin number)
     */
    _isSamePin(pin1, pin2) {
        return isSamePin(pin1, pin2);
    }

    /**
     * Check if two points are essentially the same (within epsilon)
     */
    _pointsMatch(a, b, epsilon = 1e-6) {
        return pointsMatch(a, b, epsilon);
    }

    /**
     * Get display position adjusted for target pin snapping (with fake grid consideration)
     */
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

    /**
     * Check auto-corner triggers (deadband and grid-line crossing)
     */
    _checkAutoCornerTriggers(rawDx, rawDy, primaryDir, gridSize, lastWorldPos, worldPos) {
        return checkAutoCornerTriggers(this, rawDx, rawDy, primaryDir, gridSize, lastWorldPos, worldPos);
    }
    
    /**
     * Start drawing a wire - click to place first point or snap to pin
     */
    _startWireDrawing(snappedData) {
        startWireDrawing(this, snappedData);
    }
    
    /**
     * Update wire preview while drawing
     */
    _updateWireDrawing(worldPos) {
        updateWireDrawing(this, worldPos);
    }

    /**
     * Get snapped position for wire anchor editing, allowing snap to original position
     */
    _getWireAnchorSnappedPosition(wireShape, anchorId, worldPos) {
        return getWireAnchorSnappedPosition(this, wireShape, anchorId, worldPos);
    }
    
    /**
     * Add a waypoint to the wire
     */
    _addWireWaypoint(waypointData) {
        addWireWaypoint(this, waypointData);
    }
    
    /**
     * Finish drawing the wire
     */
    _finishWireDrawing(worldPos) {
        finishWireDrawing(this, worldPos);
    }
    
    /**
     * Cancel wire drawing
     */
    _cancelWireDrawing() {
        cancelWireDrawing(this);
    }
    
    /**
     * Update wire preview visualization
     */
    _updateWirePreview() {
        updateWirePreview(this);
    }
    
    /**
     * Highlight a pin during snapping
     */
    _highlightPin(snapPin) {
        highlightPin(this, snapPin);
    }
    
    /**
     * Remove pin highlight
     */
    _unhighlightPin() {
        unhighlightPin(this);
    }

    // ==================== Component Handling ====================
    
    /**
     * Called when a component definition is selected in the picker
     */
    _onComponentDefinitionSelected(definition) {
        onComponentDefinitionSelected(this, definition);
    }
    
    /**
     * Create component preview that follows cursor
     */
    _createComponentPreview(definition) {
        createComponentPreview(this, definition);
    }
    
    /**
     * Update component preview position
     */
    _updateComponentPreview(worldPos) {
        updateComponentPreview(this, worldPos);
    }
    
    /**
     * Place the current component at the given position
     */
    _placeComponent(worldPos) {
        placeComponent(this, worldPos);
    }
    
    /**
     * Update SelectionManager with all selectable items (shapes + components)
     */
    _updateSelectableItems() {
        const items = [...this.shapes, ...this.components];
        this.selection.setShapes(items);
    }
    
    /**
     * Generate a reference designator for a component
     */
    _generateReference(definition) {
        // Get prefix from default reference (e.g., "R?" -> "R", "U?" -> "U")
        let prefix = definition.defaultReference || 'U?';
        prefix = prefix.replace(/[0-9?]+$/, '');
        
        // Find highest number used for this prefix
        let maxNum = 0;
        for (const comp of this.components) {
            if (comp.reference.startsWith(prefix)) {
                const num = parseInt(comp.reference.slice(prefix.length)) || 0;
                maxNum = Math.max(maxNum, num);
            }
        }
        
        return `${prefix}${maxNum + 1}`;
    }
    
    /**
     * Rotate component during placement (or selected components)
     */
    _rotateComponent() {
        rotateComponent(this);
    }
    
    /**
     * Mirror component during placement (or selected components)
     */
    _mirrorComponent() {
        mirrorComponent(this);
    }
    
    /**
     * Cancel component placement mode
     */
    _cancelComponentPlacement() {
        cancelComponentPlacement(this);
    }
    
    /**
     * Get selected components (for future selection integration)
     */
    _getSelectedComponents() {
        // TODO: Integrate components with SelectionManager
        return [];
    }
    
    /**
     * Render all components
     */
    renderComponents() {
        // Components render themselves via their SVG elements
        // This is called if we need to re-render (e.g., after loading)
        for (const comp of this.components) {
            if (comp.element) {
                // Update transform in case position changed
                const transform = comp._buildTransform();
                if (transform) {
                    comp.element.setAttribute('transform', transform);
                }
            }
        }
    }

    // ==================== Callbacks ====================

    _setupCallbacks() {
        let lastStatusUpdate = 0;
        let lastHoverUpdate = 0;
        const STATUS_THROTTLE = 50;
        const HOVER_THROTTLE = 30; // Throttle hover/cursor updates to reduce render calls
        
        this.viewport.onMouseMove = (world, snapped) => {
            // Update drawing preview and crosshair (not throttled - needs real-time feedback)
            if (this.isDrawing) {
                if (this.currentTool === 'wire') {
                    // For wire, get the directionally-snapped position for crosshair
                    const wireSnapped = this._getWireSnappedPosition(world);
                    this._updateDrawing(wireSnapped);
                    this._updateCrosshair(wireSnapped);
                } else {
                    this._updateDrawing(snapped);
                    this._updateCrosshair(snapped);
                }
            }
            
            // Update component preview position during placement (not throttled - needs real-time feedback)
            if (this.placingComponent && this.componentPreview) {
                this._updateComponentPreview(snapped);
            }
            
            // Throttle hover state and cursor updates to reduce expensive calculations
            let now = performance.now();
            if (now - lastHoverUpdate > HOVER_THROTTLE) {
                lastHoverUpdate = now;
                
                // Update hover state and cursor (only in select mode when not panning/dragging)
                if (!this.viewport.isPanning && !this.isDragging && this.currentTool === 'select') {
                    const hit = this.selection.hitTest(world);
                    const hoveredChanged = this.selection.setHovered(hit);  // Only returns true if changed
                    
                    // Check for anchor hover on selected shapes
                    let cursor = 'default';
                    const selectedShapes = this.selection.getSelection();
                    for (const shape of selectedShapes) {
                        const anchorId = shape.hitTestAnchor(world, this.viewport.scale);
                        if (anchorId) {
                            // Find anchor cursor
                            const anchors = shape.getAnchors();
                            const anchor = anchors.find(a => a.id === anchorId);
                            cursor = anchor?.cursor || 'crosshair';
                            break;
                        }
                    }
                    
                    // If not on anchor, check if on selected shape for move cursor
                    if (cursor === 'default' && hit && hit.selected) {
                        cursor = 'move';
                    } else if (cursor === 'default' && hit) {
                        cursor = 'pointer';
                    }
                    
                    this.viewport.svg.style.cursor = cursor;
                    
                    // Only re-render if hover state actually changed (avoids redundant renders)
                    if (hoveredChanged) {
                        this.renderShapes();
                    }
                }
            }
            
            // Throttle status bar updates
            now = performance.now();
            if (now - lastStatusUpdate > STATUS_THROTTLE) {
                lastStatusUpdate = now;
                const v = this.viewport;
                const unitLabel = v.units === 'inch' ? '"' : ` ${v.units}`;
                this.ui.cursorPos.textContent = `${v.formatValue(world.x)}, ${v.formatValue(world.y)}${unitLabel}`;
                this.ui.gridSnap.textContent = `${v.formatValue(snapped.x)}, ${v.formatValue(snapped.y)}${unitLabel}`;
            }
        };

        this.viewport.onViewChanged = (view) => {
            // Display zoom as percentage
            const zoomPercent = Math.round(this.viewport.zoom * 100);
            if (this.ui.zoomLevel) {
                this.ui.zoomLevel.textContent = `${zoomPercent}%`;
            }
            
            const bounds = view.bounds;
            const v = this.viewport;
            const widthDisplay = v.formatValue(bounds.maxX - bounds.minX, 1);
            const heightDisplay = v.formatValue(bounds.maxY - bounds.minY, 1);
            const unitLabel = v.units === 'inch' ? '"' : ` ${v.units}`;
            if (this.ui.viewportInfo) {
                this.ui.viewportInfo.textContent = `${widthDisplay} × ${heightDisplay}${unitLabel}`;
            }
            
            // Re-render all shapes to update stroke widths based on zoom
            this.renderShapes(true);
        };
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
        const panel = document.querySelector('.help-panel');
        if (!panel) return;
        const header = panel.querySelector('h3') || panel;

        let isDragging = false;
        let offsetX = 0;
        let offsetY = 0;

        header.addEventListener('mousedown', (e) => {
            isDragging = true;
            const rect = panel.getBoundingClientRect();
            offsetX = e.clientX - rect.left;
            offsetY = e.clientY - rect.top;
            header.style.cursor = 'grabbing';
            e.preventDefault();
        });

        window.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const x = e.clientX - offsetX;
            const y = e.clientY - offsetY;

            const maxX = window.innerWidth - panel.offsetWidth;
            const maxY = window.innerHeight - panel.offsetHeight;

            panel.style.left = Math.max(0, Math.min(x, maxX)) + 'px';
            panel.style.top = Math.max(0, Math.min(y, maxY)) + 'px';
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
        });

        window.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                header.style.cursor = 'grab';
            }
        });
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
        this._updatePropertiesPanel(shapes);
        this._updateRibbonState(shapes);
        this._updateShapePanelOptions(shapes);
        if (shapes.length > 0) {
            this._setActiveRibbonTab?.('properties');
        } else {
            this._setActiveRibbonTab?.('home');
        }
    }

    _bindPropertiesPanel() {
        bindPropertiesPanel(this);
    }

    _bindRibbon() {
        bindRibbon(this);
    }

    _updateRibbonState(selection) {
        updateRibbonState(this, selection);
    }

    _updateShapePanelOptions(selection, toolId = this.currentTool) {
        updateShapePanelOptions(this, selection, toolId);
    }

    _toggleSelectionLock() {
        toggleSelectionLock(this);
    }

    _updatePropertiesPanel(selection) {
        updatePropertiesPanel(this, selection);
    }

    _applyCommonProperty(prop, value) {
        applyCommonProperty(this, prop, value);
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
    
    /**
     * Toggle between dark and light theme
     */
    _toggleTheme() {
        toggleTheme(this);
    }
    
    /**
     * Load saved theme preference
     */
    _loadTheme() {
        loadTheme(this);
    }
    
    /**
     * Update component colors for current theme
     */
    _updateComponentColors() {
        updateComponentColors(this);
    }
    
    /**
     * Update grid dropdown options based on current units
     */
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
    
    /**
     * Capture the geometric state of a shape for undo/redo
     */
    _captureShapeState(shape) {
        return captureShapeState(this, shape);
    }
    
    /**
     * Apply a captured state to a shape
     */
    _applyShapeState(shape, state) {
        applyShapeState(this, shape, state);
    }
    
    _fitToContent() {
        fitToContent(this);
    }
    
    // ==================== File Operations ====================
    
    /**
     * Serialize document to JSON-compatible object
     */
    _serializeDocument() {
        return serializeDocument(this);
    }
    
    /**
     * Load shapes from document data
     */
    _loadDocument(data) {
        loadDocument(this, data);
    }
    
    /**
     * Create component instance from serialized data
     */
    _createComponentFromData(data) {
        return createComponentFromData(this, data);
    }
    
    /**
     * Create shape instance from serialized data
     */
    _createShapeFromData(data) {
        const ShapeClass = ShapeClasses[data.type.charAt(0).toUpperCase() + data.type.slice(1)];
        if (!ShapeClass) {
            console.warn('Unknown shape type:', data.type);
            return null;
        }
        return new ShapeClass(data);
    }
    
    /**
     * Clear all shapes from canvas
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
     * Clear all components from canvas
     */
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
    
    /**
     * Update window/document title
     */
    _updateTitle() {
        updateTitle(this);
    }
    
    /**
     * Update undo/redo button enabled states
     */
    _updateUndoRedoButtons() {
        if (this.ui.undoBtn) {
            this.ui.undoBtn.disabled = !this.history.canUndo();
            this.ui.undoBtn.style.opacity = this.history.canUndo() ? '1' : '0.4';
        }
        if (this.ui.redoBtn) {
            this.ui.redoBtn.disabled = !this.history.canRedo();
            this.ui.redoBtn.style.opacity = this.history.canRedo() ? '1' : '0.4';
        }
    }
    
    /**
     * Check for auto-saved content on startup
     */
    _checkAutoSave() {
        checkAutoSave(this);
    }
    
    /**
     * Load and display version number
     */
    async _loadVersion() {
        await loadVersion(this);
    }
    
    /**
     * Create new document
     */
    async newFile() {
        await newFile(this);
    }
    
    /**
     * Save current document
     */
    async saveFile() {
        await saveFile(this);
    }
    
    /**
     * Save As - always prompt for location
     */
    async saveFileAs() {
        await saveFileAs(this);
    }

    /**
     * Save current view to PDF
     */
    async savePdf() {
        await savePdf(this);
    }

    _loadVectorPdfLibs() {
        return loadVectorPdfLibs(this);
    }

    _cloneViewportSvgForExport() {
        return cloneViewportSvgForExport(this);
    }

    _forceMonochromeSvg(svgRoot) {
        forceMonochromeSvg(svgRoot);
    }

    _inlineSvgComputedStyles(originalSvg, clonedSvg) {
        inlineSvgComputedStyles(originalSvg, clonedSvg);
    }

    async _saveBlobAsFile(blob, suggestedName, mimeType, extensions) {
        await saveBlobAsFile(blob, suggestedName, mimeType, extensions);
    }

    /**
     * Render the current viewport SVG to a canvas
     */
    _renderViewportToCanvas(scale = 2) {
        return renderViewportToCanvas(this, scale);
    }
    
    /**
     * Open file
     */
    async openFile() {
        await openFile(this);
    }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.app = new SchematicApp();
});