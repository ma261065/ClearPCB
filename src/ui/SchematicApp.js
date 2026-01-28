/**
 * SchematicApp.js - Schematic Editor Application
 */

import { Viewport } from '../core/Viewport.js';
import { EventBus, Events, globalEventBus } from '../core/EventBus.js';
import { CommandHistory, AddShapeCommand, DeleteShapesCommand, MoveShapesCommand, ModifyShapeCommand } from '../core/CommandHistory.js';
import { SelectionManager } from '../core/SelectionManager.js';
import { FileManager } from '../core/FileManager.js';
import { storageManager } from '../core/StorageManager.js';
import { Toolbox } from './Toolbox.js';
import { ComponentPicker } from '../components/ComponentPicker.js';
import { Line, Circle, Rect, Arc, Polygon, updateIdCounter } from '../shapes/index.js';
import { Component, getComponentLibrary } from '../components/index.js';

// Shape class registry for deserialization
const ShapeClasses = { Line, Circle, Rect, Arc, Polygon };

class SchematicApp {
    constructor() {
        this.container = document.getElementById('canvasContainer');
        this.viewport = new Viewport(this.container);
        this.eventBus = globalEventBus;
        this.history = new CommandHistory({
            onChanged: () => {
                this._updateTitle();
                this._updateUndoRedoButtons();
            }
        });
        
        // File management
        this.fileManager = new FileManager();
        this.fileManager.onDirtyChanged = (dirty) => this._updateTitle();
        this.fileManager.onFileNameChanged = (name) => this._updateTitle();
        
        // Drawing crosshair elements
        this.crosshair = {
            container: document.getElementById('drawingCrosshair'),
            lineX: document.getElementById('crosshairX'),
            lineY: document.getElementById('crosshairY')
        };
        
        // Shape management
        this.shapes = [];
        this.components = [];  // Placed component instances
        this.selection = new SelectionManager({
            onSelectionChanged: (items) => this._onSelectionChanged(items)
        });
        this._updateSelectableItems();
        
        // Drawing state
        this.currentTool = 'select';
        this.isDrawing = false;
        this.drawStart = null;
        this.drawCurrent = null;
        this.polygonPoints = [];
        this.previewElement = null;
        
        // Drag state
        this.isDragging = false;
        this.didDrag = false;  // Track if actual drag occurred
        this.dragMode = null;  // 'move', 'anchor', or 'box'
        this.dragStart = null;
        this.dragAnchorId = null;
        this.dragShape = null;
        
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
            redoBtn: document.getElementById('redoBtn')
        };
        
        // Create toolbox
        this.toolbox = new Toolbox({
            onToolSelected: (tool) => this._onToolSelected(tool),
            onOptionsChanged: (opts) => this._onOptionsChanged(opts),
            eventBus: this.eventBus
        });
        this.toolbox.appendTo(this.container);
        
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
            this._cancelDrawing();
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
            this.toolbox.selectTool('select');
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
        // Listen for tool selection events
        this.eventBus.on('tool:selected', (toolId) => {
            this._onToolSelected(toolId);
        });
        
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
        svg.style.cursor = tool === 'select' ? 'default' : 'crosshair';
    }
    
    _onComponentPickerClosed() {
        // Return to select mode when component picker is closed
        if (this.currentTool === 'component') {
            this.currentTool = 'select';
            this.toolbox.selectTool('select');
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
        if (this.currentTool === 'select') return;
        
        this.isDrawing = true;
        this.drawStart = { ...worldPos };
        this.drawCurrent = { ...worldPos };
        
        if (this.currentTool === 'polygon') {
            this.polygonPoints = [{ ...worldPos }];
        }
        
        this._createPreview();
        this._showCrosshair();
        this._updateCrosshair(worldPos);
        this.viewport.svg.style.cursor = 'none';
    }
    
    _updateDrawing(worldPos) {
        if (!this.isDrawing) return;
        
        this.drawCurrent = { ...worldPos };
        this._updatePreview();
    }
    
    _finishDrawing(worldPos) {
        if (!this.isDrawing) return;
        
        this.drawCurrent = { ...worldPos };
        
        // Create the actual shape
        const shape = this._createShapeFromDrawing();
        if (shape) {
            this.addShape(shape);
        }
        
        this._cancelDrawing();
    }
    
    _addPolygonPoint(worldPos) {
        if (this.currentTool === 'polygon' && this.isDrawing) {
            this.polygonPoints.push({ ...worldPos });
            this._updatePreview();
        }
    }
    
    _finishPolygon() {
        if (this.currentTool === 'polygon' && this.isDrawing && this.polygonPoints.length >= 3) {
            const shape = new Polygon({
                points: this.polygonPoints.map(p => ({ ...p })),
                color: this.toolOptions.color,
                lineWidth: this.toolOptions.lineWidth,
                fill: this.toolOptions.fill,
                fillColor: this.toolOptions.color,
                fillAlpha: 0.3,
                closed: true
            });
            this.addShape(shape);
        }
        this._cancelDrawing();
    }
    
    _cancelDrawing() {
        this.isDrawing = false;
        this.drawStart = null;
        this.drawCurrent = null;
        this.polygonPoints = [];
        
        if (this.previewElement) {
            this.previewElement.remove();
            this.previewElement = null;
        }
        
        this._hideCrosshair();
        this.viewport.svg.style.cursor = this.currentTool === 'select' ? 'default' : 'crosshair';
    }
    
    _createPreview() {
        // Create SVG element for preview
        this.previewElement = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        this.previewElement.setAttribute('class', 'preview');
        this.previewElement.style.opacity = '0.6';
        this.previewElement.style.pointerEvents = 'none';
        this.viewport.contentLayer.appendChild(this.previewElement);
    }
    
    
    // Calculate effective stroke width with minimum screen pixel size
    _getEffectiveStrokeWidth(lineWidth) {
        const minWorldWidth = 1 / this.viewport.scale; // 1 screen pixel minimum
        return Math.max(lineWidth, minWorldWidth);
    }
    
    _updatePreview() {
        if (!this.previewElement || !this.drawStart || !this.drawCurrent) return;
        
        const start = this.drawStart;
        const end = this.drawCurrent;
        const opts = this.toolOptions;
        const strokeWidth = this._getEffectiveStrokeWidth(opts.lineWidth);
        
        let svg = '';
        
        switch (this.currentTool) {
            case 'line':
            case 'wire':
                svg = `<line x1="${start.x}" y1="${start.y}" x2="${end.x}" y2="${end.y}" 
                        stroke="${opts.color}" stroke-width="${strokeWidth}" stroke-linecap="round"/>`;
                break;
                
            case 'rect':
                const x = Math.min(start.x, end.x);
                const y = Math.min(start.y, end.y);
                const w = Math.abs(end.x - start.x);
                const h = Math.abs(end.y - start.y);
                svg = `<rect x="${x}" y="${y}" width="${w}" height="${h}" 
                        stroke="${opts.color}" stroke-width="${strokeWidth}" 
                        fill="${opts.fill ? opts.color : 'none'}" fill-opacity="0.3"/>`;
                break;
                
            case 'circle':
                const radius = Math.hypot(end.x - start.x, end.y - start.y);
                svg = `<circle cx="${start.x}" cy="${start.y}" r="${radius}" 
                        stroke="${opts.color}" stroke-width="${strokeWidth}" 
                        fill="${opts.fill ? opts.color : 'none'}" fill-opacity="0.3"/>`;
                break;
                
            case 'arc':
                const arcRadius = Math.hypot(end.x - start.x, end.y - start.y);
                const endAngle = Math.atan2(end.y - start.y, end.x - start.x);
                const arcEndX = start.x + arcRadius * Math.cos(endAngle);
                const arcEndY = start.y + arcRadius * Math.sin(endAngle);
                const largeArc = endAngle > Math.PI ? 1 : 0;
                svg = `<path d="M ${start.x + arcRadius} ${start.y} A ${arcRadius} ${arcRadius} 0 ${largeArc} 1 ${arcEndX} ${arcEndY}" 
                        stroke="${opts.color}" stroke-width="${strokeWidth}" fill="none" stroke-linecap="round"/>`;
                break;
                
            case 'polygon':
                if (this.polygonPoints.length > 0) {
                    const points = [...this.polygonPoints, end];
                    const pointsStr = points.map(p => `${p.x},${p.y}`).join(' ');
                    svg = `<polyline points="${pointsStr}" 
                            stroke="${opts.color}" stroke-width="${strokeWidth}" 
                            fill="${opts.fill ? opts.color : 'none'}" fill-opacity="0.3"
                            stroke-linecap="round" stroke-linejoin="round"/>`;
                    // Draw vertex indicators
                    for (const p of this.polygonPoints) {
                        svg += `<circle cx="${p.x}" cy="${p.y}" r="${2 / this.viewport.scale}" fill="${opts.color}"/>`;
                    }
                }
                break;
        }
        
        this.previewElement.innerHTML = svg;
    }
    
    _createShapeFromDrawing() {
        const start = this.drawStart;
        const end = this.drawCurrent;
        const opts = this.toolOptions;
        
        // Minimum size check
        const minSize = 0.5;
        
        switch (this.currentTool) {
            case 'line':
            case 'wire': {
                const length = Math.hypot(end.x - start.x, end.y - start.y);
                if (length < minSize) return null;
                return new Line({
                    x1: start.x, y1: start.y,
                    x2: end.x, y2: end.y,
                    color: this.currentTool === 'wire' ? '#00cc66' : opts.color,
                    lineWidth: opts.lineWidth
                });
            }
                
            case 'rect': {
                const w = Math.abs(end.x - start.x);
                const h = Math.abs(end.y - start.y);
                if (w < minSize || h < minSize) return null;
                return new Rect({
                    x: Math.min(start.x, end.x),
                    y: Math.min(start.y, end.y),
                    width: w,
                    height: h,
                    color: opts.color,
                    lineWidth: opts.lineWidth,
                    fill: opts.fill,
                    fillColor: opts.color,
                    fillAlpha: 0.3
                });
            }
                
            case 'circle': {
                const radius = Math.hypot(end.x - start.x, end.y - start.y);
                if (radius < minSize) return null;
                return new Circle({
                    x: start.x,
                    y: start.y,
                    radius,
                    color: opts.color,
                    lineWidth: opts.lineWidth,
                    fill: opts.fill,
                    fillColor: opts.color,
                    fillAlpha: 0.3
                });
            }
                
            case 'arc': {
                const arcRadius = Math.hypot(end.x - start.x, end.y - start.y);
                if (arcRadius < minSize) return null;
                const endAngle = Math.atan2(end.y - start.y, end.x - start.x);
                return new Arc({
                    x: start.x,
                    y: start.y,
                    radius: arcRadius,
                    startAngle: 0,
                    endAngle: endAngle,
                    color: opts.color,
                    lineWidth: opts.lineWidth
                });
            }
                
            default:
                return null;
        }
    }

    // ==================== Component Handling ====================
    
    /**
     * Called when a component definition is selected in the picker
     */
    _onComponentDefinitionSelected(definition) {
        // Cancel any current drawing
        this._cancelDrawing();
        
        // Start component placement mode
        this.placingComponent = definition;
        this.currentTool = 'component';
        
        // Update toolbox to show component tool as active (without triggering callback)
        this.toolbox.selectTool('component', { silent: true, force: true });
        
        // Create preview element
        this._createComponentPreview(definition);
        
        // Change cursor
        this.viewport.svg.style.cursor = 'crosshair';
        
        console.log('Placing component:', definition.name);
    }
    
    /**
     * Create component preview that follows cursor
     */
    _createComponentPreview(definition) {
        if (this.componentPreview) {
            this.componentPreview.remove();
        }
        
        // Create a temporary component for preview
        const tempComponent = new Component(definition, {
            x: 0,
            y: 0,
            rotation: this.componentRotation,
            mirror: this.componentMirror,
            reference: definition.defaultReference || 'U?'
        });
        
        this.componentPreview = tempComponent.createSymbolElement();
        this.componentPreview.style.opacity = '0.6';
        this.componentPreview.style.pointerEvents = 'none';
        this.componentPreview.classList.add('component-preview');
        
        this.viewport.contentLayer.appendChild(this.componentPreview);
    }
    
    /**
     * Update component preview position
     */
    _updateComponentPreview(worldPos) {
        if (!this.componentPreview || !this.placingComponent) return;
        
        // Build transform
        const parts = [`translate(${worldPos.x}, ${worldPos.y})`];
        if (this.componentRotation !== 0) {
            parts.push(`rotate(${this.componentRotation})`);
        }
        if (this.componentMirror) {
            parts.push('scale(-1, 1)');
        }
        
        this.componentPreview.setAttribute('transform', parts.join(' '));
    }
    
    /**
     * Place the current component at the given position
     */
    _placeComponent(worldPos) {
        if (!this.placingComponent) return;
        
        // Generate reference designator
        const ref = this._generateReference(this.placingComponent);
        
        // Create the component instance
        const component = new Component(this.placingComponent, {
            x: worldPos.x,
            y: worldPos.y,
            rotation: this.componentRotation,
            mirror: this.componentMirror,
            reference: ref
        });
        
        // Add to components list
        this.components.push(component);
        
        // Create SVG element and add to canvas
        const element = component.createSymbolElement();
        this.viewport.addContent(element);
        
        // Mark document as dirty
        this.fileManager.setDirty(true);
        
        // Update selection manager to include the new component
        this._updateSelectableItems();
        
        // TODO: Add undo command for component placement
        
        console.log('Placed component:', component.reference, 'at', worldPos.x, worldPos.y);
        
        // Continue placement mode (for placing multiple components)
        // Reset rotation/mirror for next placement? Or keep them? Let's keep them.
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
        if (this.placingComponent) {
            this.componentRotation = (this.componentRotation + 90) % 360;
            this._createComponentPreview(this.placingComponent);
        } else {
            // Rotate selected components
            const selected = this._getSelectedComponents();
            for (const comp of selected) {
                comp.rotate(90);
            }
            if (selected.length > 0) {
                this.fileManager.setDirty(true);
            }
        }
    }
    
    /**
     * Mirror component during placement (or selected components)
     */
    _mirrorComponent() {
        if (this.placingComponent) {
            this.componentMirror = !this.componentMirror;
            this._createComponentPreview(this.placingComponent);
        } else {
            // Mirror selected components
            const selected = this._getSelectedComponents();
            for (const comp of selected) {
                comp.toggleMirror();
            }
            if (selected.length > 0) {
                this.fileManager.setDirty(true);
            }
        }
    }
    
    /**
     * Cancel component placement mode
     */
    _cancelComponentPlacement() {
        if (this.componentPreview) {
            this.componentPreview.remove();
            this.componentPreview = null;
        }
        this.placingComponent = null;
        this.componentRotation = 0;
        this.componentMirror = false;
        
        if (this.currentTool === 'component') {
            this.currentTool = 'select';
            this.viewport.svg.style.cursor = 'default';
            // Ensure the Toolbox UI reflects the change (update without triggering callback)
            if (this.toolbox) {
                this.toolbox.selectTool('select', { silent: true, force: true });
            }
        }
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
                this._updateDrawing(snapped);
                this._updateCrosshair(snapped);
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
            this.ui.zoomLevel.textContent = `${zoomPercent}%`;
            
            const bounds = view.bounds;
            const v = this.viewport;
            const widthDisplay = v.formatValue(bounds.maxX - bounds.minX, 1);
            const heightDisplay = v.formatValue(bounds.maxY - bounds.minY, 1);
            const unitLabel = v.units === 'inch' ? '"' : ` ${v.units}`;
            this.ui.viewportInfo.textContent = `${widthDisplay} × ${heightDisplay}${unitLabel}`;
            
            // Re-render all shapes to update stroke widths based on zoom
            this.renderShapes(true);
        };
    }
    
    _updateCrosshair(snapped) {
        const screenPos = this.viewport.worldToScreen(snapped);
        const w = this.container.clientWidth;
        const h = this.container.clientHeight;
        
        // Horizontal line (full width at snapped Y)
        this.crosshair.lineX.setAttribute('x1', 0);
        this.crosshair.lineX.setAttribute('y1', screenPos.y);
        this.crosshair.lineX.setAttribute('x2', w);
        this.crosshair.lineX.setAttribute('y2', screenPos.y);
        
        // Vertical line (full height at snapped X)
        this.crosshair.lineY.setAttribute('x1', screenPos.x);
        this.crosshair.lineY.setAttribute('y1', 0);
        this.crosshair.lineY.setAttribute('x2', screenPos.x);
        this.crosshair.lineY.setAttribute('y2', h);
    }
    
    _showCrosshair() {
        this.crosshair.container.classList.add('active');
    }
    
    _hideCrosshair() {
        this.crosshair.container.classList.remove('active');
    }
    
    _onSelectionChanged(shapes) {
        console.log(`Selection: ${shapes.length} shape(s)`);
        this.renderShapes(true);
    }

    // ==================== Mouse Events ====================
    
    _bindMouseEvents() {
        const svg = this.viewport.svg;
        
        svg.addEventListener('mousedown', (e) => {
            // Ignore right-click (used for pan)
            if (e.button !== 0) return;
            if (this.viewport.isPanning) return;
            
            this.didDrag = false;
            
            const rect = svg.getBoundingClientRect();
            const screenPos = {
                x: e.clientX - rect.left,
                y: e.clientY - rect.top
            };
            const worldPos = this.viewport.screenToWorld(screenPos);
            const snapped = this.viewport.getSnappedPosition(worldPos);
            
            // Handle component placement
            if (this.placingComponent) {
                this._placeComponent(snapped);
                e.preventDefault();
                return;
            }
            
            if (this.currentTool === 'select') {
                // Check if clicking on an anchor of a selected shape
                const selectedShapes = this.selection.getSelection();
                for (const shape of selectedShapes) {
                    const anchorId = shape.hitTestAnchor(worldPos, this.viewport.scale);
                    if (anchorId) {
                        // Start anchor drag - capture state for undo
                        this.isDragging = true;
                        this.dragMode = 'anchor';
                        this.dragStart = { ...snapped };
                        this.dragAnchorId = anchorId;
                        this.dragShape = shape;
                        // Capture shape state before modification
                        this.dragShapesBefore = this._captureShapeState(shape);
                        e.preventDefault();
                        return;
                    }
                }
                
                // Check if clicking on any shape/component
                const hitShape = this.selection.hitTest(worldPos);
                
                if (hitShape) {
                    // If clicking on unselected item, select it first
                    if (!hitShape.selected) {
                        if (e.shiftKey) {
                            this.selection.select(hitShape, true);  // Add to selection
                        } else {
                            this.selection.select(hitShape, false); // Replace selection
                        }
                        this.renderShapes(true);
                    }
                    
                    // Now start move drag immediately
                    this.isDragging = true;
                    this.dragMode = 'move';
                    this.dragStart = { ...snapped };
                    this.dragTotalDx = 0;
                    this.dragTotalDy = 0;
                    this.viewport.svg.style.cursor = 'move';
                    e.preventDefault();
                    return;
                }
                
                // Clicking on empty space - start box selection
                this.isDragging = true;
                this.dragMode = 'box';
                this.boxSelectStart = { ...worldPos };
                this._createBoxSelectElement();
                e.preventDefault();
                return;
            } else if (this.currentTool === 'polygon') {
                if (!this.isDrawing) {
                    this._startDrawing(snapped);
                } else {
                    this._addPolygonPoint(snapped);
                }
            } else {
                // Start drawing shape
                this._startDrawing(snapped);
            }
        });
        
        svg.addEventListener('mousemove', (e) => {
            if (!this.isDragging) return;
            if (this.viewport.isPanning) return;
            
            const rect = svg.getBoundingClientRect();
            const screenPos = {
                x: e.clientX - rect.left,
                y: e.clientY - rect.top
            };
            const worldPos = this.viewport.screenToWorld(screenPos);
            const snapped = this.viewport.getSnappedPosition(worldPos);
            
            if (this.dragMode === 'move') {
                // Move all selected shapes
                const dx = snapped.x - this.dragStart.x;
                const dy = snapped.y - this.dragStart.y;
                
                if (dx !== 0 || dy !== 0) {
                    this.didDrag = true;
                    // Track total movement for undo command
                    this.dragTotalDx += dx;
                    this.dragTotalDy += dy;
                    
                    for (const shape of this.selection.getSelection()) {
                        shape.move(dx, dy);
                    }
                    this.dragStart = { ...snapped };
                    this.renderShapes(true);
                    this.fileManager.setDirty(true);
                }
            } else if (this.dragMode === 'anchor' && this.dragShape) {
                // Move the anchor
                this.didDrag = true;
                const newAnchorId = this.dragShape.moveAnchor(this.dragAnchorId, snapped.x, snapped.y);
                // Update anchor ID if shape flipped (e.g., rectangle dragged past opposite edge)
                if (newAnchorId && newAnchorId !== this.dragAnchorId) {
                    this.dragAnchorId = newAnchorId;
                }
                this.renderShapes(true);
                this.fileManager.setDirty(true);
            } else if (this.dragMode === 'box' && this.boxSelectStart) {
                // Update box selection rectangle
                this.didDrag = true;
                this._updateBoxSelectElement(worldPos);
            }
        });
        
        svg.addEventListener('mouseup', (e) => {
            if (e.button !== 0) return;
            
            const rect = svg.getBoundingClientRect();
            const screenPos = {
                x: e.clientX - rect.left,
                y: e.clientY - rect.top
            };
            const worldPos = this.viewport.screenToWorld(screenPos);
            const snapped = this.viewport.getSnappedPosition(worldPos);
            
            // Handle box selection completion
            if (this.isDragging && this.dragMode === 'box' && this.boxSelectStart) {
                const bounds = this._getBoxSelectBounds(worldPos);
                this._removeBoxSelectElement();
                
                // Only select if we actually dragged (not just clicked)
                if (this.didDrag) {
                    this.selection.handleBoxSelect(bounds, e.shiftKey, 'contain');
                    this.renderShapes(true);
                    // Keep didDrag true so click event doesn't clear selection
                }
                
                this.isDragging = false;
                this.dragMode = null;
                this.boxSelectStart = null;
                // Note: didDrag stays true if we dragged, so click event will ignore it
                return;
            }
            
            // End other dragging modes
            if (this.isDragging) {
                // Create undo command if we actually moved something
                if (this.didDrag && this.dragMode === 'move') {
                    // Create move command (shapes already moved, so use negative values to undo)
                    const selectedShapes = this.selection.getSelection();
                    if (selectedShapes.length > 0 && (this.dragTotalDx !== 0 || this.dragTotalDy !== 0)) {
                        // First undo the move, then let the command redo it
                        for (const shape of selectedShapes) {
                            shape.move(-this.dragTotalDx, -this.dragTotalDy);
                        }
                        const command = new MoveShapesCommand(this, selectedShapes, this.dragTotalDx, this.dragTotalDy);
                        this.history.execute(command);
                    }
                } else if (this.didDrag && this.dragMode === 'anchor' && this.dragShape && this.dragShapesBefore) {
                    // Create modify command for anchor drag
                    const afterState = this._captureShapeState(this.dragShape);
                    // Restore before state, then let command apply after state
                    this._applyShapeState(this.dragShape, this.dragShapesBefore);
                    const command = new ModifyShapeCommand(this, this.dragShape, this.dragShapesBefore, afterState);
                    this.history.execute(command);
                }
                
                this.isDragging = false;
                this.dragMode = null;
                this.dragStart = null;
                this.dragAnchorId = null;
                this.dragShape = null;
                this.dragShapesBefore = null;
                // Don't return - let click handle selection if needed
            }
            
            if (this.viewport.isPanning) return;
            
            if (this.currentTool === 'polygon') {
                // Polygon continues until double-click or Escape
            } else if (this.isDrawing) {
                this._finishDrawing(snapped);
            }
        });
        
        svg.addEventListener('click', (e) => {
            if (this.viewport.isPanning) return;
            
            // Don't handle click if we actually dragged
            if (this.didDrag) {
                this.didDrag = false;
                return;
            }
            
            const rect = svg.getBoundingClientRect();
            const screenPos = {
                x: e.clientX - rect.left,
                y: e.clientY - rect.top
            };
            const worldPos = this.viewport.screenToWorld(screenPos);
            
            if (this.currentTool === 'select') {
                this.selection.handleClick(worldPos, e.shiftKey);
                // Force re-render all shapes to update anchor visibility on deselected shapes
                this.renderShapes(true);
            }
        });
        
        svg.addEventListener('dblclick', (e) => {
            if (this.currentTool === 'polygon' && this.isDrawing) {
                this._finishPolygon();
            }
        });
    }

    // ==================== UI Controls ====================

    _bindUIControls() {
        this.ui.gridSize.addEventListener('change', (e) => {
            this.viewport.setGridSize(parseFloat(e.target.value));
        });

        this.ui.gridStyle.addEventListener('change', (e) => {
            this.viewport.setGridStyle(e.target.value);
        });

        this.ui.units.addEventListener('change', (e) => {
            this.viewport.setUnits(e.target.value);
            this._updateGridDropdown();
        });

        this.ui.showGrid.addEventListener('change', (e) => {
            this.viewport.setGridVisible(e.target.checked);
        });

        this.ui.snapToGrid.addEventListener('change', (e) => {
            this.viewport.snapToGrid = e.target.checked;
        });

        document.getElementById('zoomFit').addEventListener('click', () => {
            this._fitToContent();
        });

        document.getElementById('zoomIn').addEventListener('click', () => {
            this.viewport.zoomIn();
        });

        document.getElementById('zoomOut').addEventListener('click', () => {
            this.viewport.zoomOut();
        });

        document.getElementById('resetView').addEventListener('click', () => {
            this.viewport.resetView();
        });
        
        // File buttons
        document.getElementById('newFile').addEventListener('click', () => {
            this.newFile();
        });
        
        document.getElementById('openFile').addEventListener('click', () => {
            this.openFile();
        });
        
        document.getElementById('saveFile').addEventListener('click', () => {
            this.saveFile();
        });
        
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
        const themeToggle = document.getElementById('themeToggle');
        if (themeToggle) {
            themeToggle.addEventListener('click', () => {
                this._toggleTheme();
            });
            // Load saved theme preference
            this._loadTheme();
        }
        
        // Initialize button states
        this._updateUndoRedoButtons();
        
        // Initialize grid dropdown with current units
        this._updateGridDropdown();
    }
    
    /**
     * Toggle between dark and light theme
     */
    _toggleTheme() {
        const html = document.documentElement;
        const currentTheme = html.getAttribute('data-theme');
        const newTheme = currentTheme === 'light' ? 'dark' : 'light';
        
        html.setAttribute('data-theme', newTheme);
        storageManager.set('clearpcb-theme', newTheme);
        
        // Update toggle button icon
        const themeToggle = document.getElementById('themeToggle');
        if (themeToggle) {
            themeToggle.textContent = newTheme === 'light' ? '☀️' : '🌙';
        }
        
        // Update viewport colors
        this.viewport.updateTheme();
        
        // Re-render components with new colors
        this._updateComponentColors();
    }
    
    /**
     * Load saved theme preference
     */
    _loadTheme() {
        const savedTheme = storageManager.get('clearpcb-theme') || 'dark';
        const html = document.documentElement;
        
        if (savedTheme === 'light') {
            html.setAttribute('data-theme', 'light');
        }
        
        // Update toggle button icon
        const themeToggle = document.getElementById('themeToggle');
        if (themeToggle) {
            themeToggle.textContent = savedTheme === 'light' ? '☀️' : '🌙';
        }
        
        // Update viewport colors
        if (this.viewport) {
            this.viewport.updateTheme();
        }
    }
    
    /**
     * Update component colors for current theme
     */
    _updateComponentColors() {
        // Re-render all placed components
        for (const comp of this.components) {
            if (comp.element) {
                comp.element.remove();
            }
            const element = comp.createSymbolElement();
            this.viewport.addContent(element);
        }
        
        // Update preview if placing
        if (this.placingComponent && this.componentPreview) {
            this._createComponentPreview(this.placingComponent);
        }
    }
    
    /**
     * Update grid dropdown options based on current units
     */
    _updateGridDropdown() {
        const options = this.viewport.getGridOptions();
        const currentValue = this.viewport.gridSize;
        
        // Clear existing options
        this.ui.gridSize.innerHTML = '';
        
        // Add new options
        for (const opt of options) {
            const option = document.createElement('option');
            option.value = opt.value;
            option.textContent = opt.label;
            this.ui.gridSize.appendChild(option);
        }
        
        // Try to select closest matching value
        let closestIdx = 0;
        let closestDiff = Infinity;
        for (let i = 0; i < options.length; i++) {
            const diff = Math.abs(options[i].value - currentValue);
            if (diff < closestDiff) {
                closestDiff = diff;
                closestIdx = i;
            }
        }
        this.ui.gridSize.selectedIndex = closestIdx;
        
        // Update viewport grid size to match selected option
        this.viewport.setGridSize(options[closestIdx].value);
    }

    _bindKeyboardShortcuts() {
        // Use capture phase so this runs BEFORE Toolbox's listener
        // This allows us to intercept R/M during component placement
        window.addEventListener('keydown', (e) => {
            if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA')) return;

            if (e.ctrlKey || e.metaKey) {
                switch (e.key.toLowerCase()) {
                    case 's':
                        e.preventDefault();
                        if (e.altKey) {
                            this.saveFileAs();
                        } else {
                            this.saveFile();
                        }
                        break;
                    case 'o':
                        e.preventDefault();
                        this.openFile();
                        break;
                    case 'n':
                        e.preventDefault();
                        this.newFile();
                        break;
                    case 'z':
                        e.preventDefault();
                        if (e.shiftKey) {
                            if (this.history.redo()) this.renderShapes(true);
                        } else {
                            if (this.history.undo()) this.renderShapes(true);
                        }
                        break;
                    case 'y':
                        e.preventDefault();
                        if (this.history.redo()) this.renderShapes(true);
                        break;
                    case 'a':
                        e.preventDefault();
                        this.selection.selectAll();
                        this.renderShapes(true);
                        break;
                }
            } else {
                switch (e.key) {
                    case 'Escape':
                        this._handleEscape();
                        break;
                    case 'Delete':
                    case 'Backspace':
                        this._deleteSelected();
                        break;
                    case 'r':
                    case 'R':
                        // Rotate component during placement only
                        if (this.placingComponent) {
                            this._rotateComponent();
                            e.preventDefault();
                            e.stopImmediatePropagation();  // Prevent Toolbox from switching to Rectangle
                        }
                        // Otherwise let R pass through for Rectangle tool
                        break;
                    case 'm':
                    case 'M':
                        // Mirror component during placement only
                        if (this.placingComponent) {
                            this._mirrorComponent();
                            e.preventDefault();
                            e.stopImmediatePropagation();
                        }
                        break;
                }
            }
        }, { capture: true });  // Capture phase to run before Toolbox

        // Also listen for ModalManager fallback event
        window.addEventListener('global-escape', () => this._handleEscape());
    }
    
    _deleteSelected() {
        const toDelete = this.selection.getSelection();
        if (toDelete.length === 0) return;
        
        this.selection.clearSelection();
        
        // Separate shapes and components
        const shapesToDelete = [];
        const componentsToDelete = [];
        
        for (const item of toDelete) {
            if (this.shapes.includes(item)) {
                shapesToDelete.push(item);
            } else if (this.components.includes(item)) {
                componentsToDelete.push(item);
            }
        }
        
        // Delete shapes via command (supports undo)
        if (shapesToDelete.length > 0) {
            const command = new DeleteShapesCommand(this, shapesToDelete);
            this.history.execute(command);
        }
        
        // Delete components (TODO: add undo support)
        for (const comp of componentsToDelete) {
            const idx = this.components.indexOf(comp);
            if (idx !== -1) {
                this.components.splice(idx, 1);
                if (comp.element) {
                    this.viewport.removeContent(comp.element);
                }
                comp.destroy();
            }
        }
        
        if (componentsToDelete.length > 0) {
            this._updateSelectableItems();
            this.fileManager.setDirty(true);
        }
        
        this.renderShapes(true);
    }
    
    // ==================== Box Selection ====================
    
    _createBoxSelectElement() {
        this.boxSelectElement = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        this.boxSelectElement.setAttribute('fill', 'rgba(51, 153, 255, 0.15)');  // --sch-selection-fill
        this.boxSelectElement.setAttribute('stroke', '#3399ff');  // --sch-selection
        this.boxSelectElement.setAttribute('stroke-width', 1 / this.viewport.scale);
        this.boxSelectElement.setAttribute('stroke-dasharray', `${4 / this.viewport.scale} ${4 / this.viewport.scale}`);
        this.boxSelectElement.style.pointerEvents = 'none';
        this.viewport.contentLayer.appendChild(this.boxSelectElement);
    }
    
    _updateBoxSelectElement(currentPos) {
        if (!this.boxSelectElement || !this.boxSelectStart) return;
        
        const x = Math.min(this.boxSelectStart.x, currentPos.x);
        const y = Math.min(this.boxSelectStart.y, currentPos.y);
        const width = Math.abs(currentPos.x - this.boxSelectStart.x);
        const height = Math.abs(currentPos.y - this.boxSelectStart.y);
        
        this.boxSelectElement.setAttribute('x', x);
        this.boxSelectElement.setAttribute('y', y);
        this.boxSelectElement.setAttribute('width', width);
        this.boxSelectElement.setAttribute('height', height);
    }
    
    _removeBoxSelectElement() {
        if (this.boxSelectElement) {
            this.boxSelectElement.remove();
            this.boxSelectElement = null;
        }
    }
    
    _getBoxSelectBounds(currentPos) {
        return {
            minX: Math.min(this.boxSelectStart.x, currentPos.x),
            minY: Math.min(this.boxSelectStart.y, currentPos.y),
            maxX: Math.max(this.boxSelectStart.x, currentPos.x),
            maxY: Math.max(this.boxSelectStart.y, currentPos.y)
        };
    }
    
    // ==================== Shape State Helpers (for undo/redo) ====================
    
    /**
     * Capture the geometric state of a shape for undo/redo
     */
    _captureShapeState(shape) {
        switch (shape.type) {
            case 'rect':
                return { x: shape.x, y: shape.y, width: shape.width, height: shape.height };
            case 'circle':
                return { x: shape.x, y: shape.y, radius: shape.radius };
            case 'line':
                return { x1: shape.x1, y1: shape.y1, x2: shape.x2, y2: shape.y2 };
            case 'arc':
                return { x: shape.x, y: shape.y, radius: shape.radius, startAngle: shape.startAngle, endAngle: shape.endAngle };
            case 'polygon':
                return { points: shape.points.map(p => ({ x: p.x, y: p.y })) };
            default:
                console.warn('Unknown shape type for state capture:', shape.type);
                return {};
        }
    }
    
    /**
     * Apply a captured state to a shape
     */
    _applyShapeState(shape, state) {
        for (const [key, value] of Object.entries(state)) {
            if (key === 'points' && Array.isArray(value)) {
                shape.points = value.map(p => ({ x: p.x, y: p.y }));
            } else {
                shape[key] = value;
            }
        }
        shape.invalidate();
        this.renderShapes(true);
    }
    
    _fitToContent() {
        if (this.shapes.length === 0) {
            this.viewport.resetView();
            return;
        }
        
        let minX = Infinity, minY = Infinity;
        let maxX = -Infinity, maxY = -Infinity;
        
        for (const shape of this.shapes) {
            const b = shape.getBounds();
            minX = Math.min(minX, b.minX);
            minY = Math.min(minY, b.minY);
            maxX = Math.max(maxX, b.maxX);
            maxY = Math.max(maxY, b.maxY);
        }
        
        this.viewport.fitToBounds(minX, minY, maxX, maxY, 10);
    }
    
    // ==================== File Operations ====================
    
    /**
     * Serialize document to JSON-compatible object
     */
    _serializeDocument() {
        return {
            version: '1.1',
            type: 'clearpcb-schematic',
            created: new Date().toISOString(),
            settings: {
                gridSize: this.viewport.gridSize,
                units: this.viewport.units
            },
            shapes: this.shapes.map(s => s.toJSON()),
            components: this.components.map(c => c.toJSON())
        };
    }
    
    /**
     * Load shapes from document data
     */
    _loadDocument(data) {
        // Clear existing shapes and components
        this._clearAllShapes();
        this._clearAllComponents();
        
        // Load shapes
        if (data.shapes && Array.isArray(data.shapes)) {
            for (const shapeData of data.shapes) {
                // Update ID counter to avoid collisions with future shapes
                if (shapeData.id) {
                    updateIdCounter(shapeData.id);
                }
                
                const shape = this._createShapeFromData(shapeData);
                if (shape) {
                    this.shapes.push(shape);
                    shape.render(this.viewport.scale);
                    this.viewport.addContent(shape.element);
                }
            }
        }
        
        // Load components
        if (data.components && Array.isArray(data.components)) {
            for (const compData of data.components) {
                const component = this._createComponentFromData(compData);
                if (component) {
                    this.components.push(component);
                    const element = component.createSymbolElement();
                    this.viewport.addContent(element);
                }
            }
        }
        
        // Apply settings
        if (data.settings) {
            if (data.settings.gridSize) {
                this.viewport.setGridSize(data.settings.gridSize);
                if (this.ui.gridSize) {
                    this.ui.gridSize.value = data.settings.gridSize;
                }
            }
        }
        
        this._updateSelectableItems();
        this.renderShapes(true);
    }
    
    /**
     * Create component instance from serialized data
     */
    _createComponentFromData(data) {
        // First try to get definition from library
        let def = this.componentLibrary.getDefinition(data.definitionName);
        
        // If not found and we have an embedded definition, add it to the library and use it
        if (!def && data.definition) {
            try {
                console.log('Adding embedded definition from saved file:', data.definitionName);
                
                // Ensure the definition has a symbol object
                // (Handle old saved files that had graphics/pins but no symbol wrapper)
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
                
                this.componentLibrary.addDefinition(data.definition, data.definition._source || 'User');
                def = this.componentLibrary.getDefinition(data.definitionName);
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
        const dirty = this.fileManager.isDirty ? '• ' : '';
        const title = `${dirty}${this.fileManager.fileName} - ClearPCB`;
        document.title = title;
        
        if (this.ui.docTitle) {
            this.ui.docTitle.textContent = `${dirty}${this.fileManager.fileName}`;
        }
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
        if (this.fileManager.hasAutoSave()) {
            const saved = this.fileManager.loadAutoSave();
            if (saved && saved.data) {
                const hasContent = (saved.data.shapes && saved.data.shapes.length > 0) ||
                                   (saved.data.components && saved.data.components.length > 0);
                if (hasContent) {
                    const time = new Date(saved.timestamp).toLocaleString();
                    if (confirm(`Found auto-saved content from ${time}.\n\nRecover it?`)) {
                        this._loadDocument(saved.data);
                        this.fileManager.setDirty(true);
                        console.log('Recovered auto-saved content');
                    } else {
                        this.fileManager.clearAutoSave();
                    }
                }
            }
        }
    }
    
    /**
     * Load and display version number
     */
    async _loadVersion() {
        try {
            // Try multiple possible paths for version.json
            const paths = [
                '../../version.json',
                '/version.json',
                '../../../version.json'
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
     * Create new document
     */
    async newFile() {
        if (this.fileManager.isDirty) {
            if (!confirm('You have unsaved changes. Create new document anyway?')) {
                return;
            }
        }
        
        this._clearAllShapes();
        this._clearAllComponents();
        this.fileManager.newDocument();
        this.viewport.resetView();
        this._updateTitle();
        console.log('New document created');
    }
    
    /**
     * Save current document
     */
    async saveFile() {
        const data = this._serializeDocument();
        const result = await this.fileManager.save(data);
        
        if (result.success) {
            this._updateTitle();
            console.log('Saved:', result.fileName);
        } else if (!result.cancelled) {
            alert('Failed to save: ' + (result.error || 'Unknown error'));
        }
    }
    
    /**
     * Save As - always prompt for location
     */
    async saveFileAs() {
        const data = this._serializeDocument();
        const result = await this.fileManager.saveAs(data);
        
        if (result.success) {
            this._updateTitle();
            console.log('Saved as:', result.fileName);
        } else if (!result.cancelled) {
            alert('Failed to save: ' + (result.error || 'Unknown error'));
        }
    }
    
    /**
     * Open file
     */
    async openFile() {
        if (this.fileManager.isDirty) {
            if (!confirm('You have unsaved changes. Open another file anyway?')) {
                return;
            }
        }
        
        try {
            const result = await this.fileManager.open();
            
            if (result.success) {
                this._loadDocument(result.data);
                this._updateTitle();
                this.fileManager.clearAutoSave();
                console.log('Opened:', result.fileName);
            } else if (result.error) {
                alert('Failed to open: ' + result.error);
            }
        } catch (err) {
            alert('Failed to open file: ' + err.message);
        }
    }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.app = new SchematicApp();
});