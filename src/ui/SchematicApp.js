/**
 * SchematicApp.js - Schematic Editor Application
 */

import { Viewport } from '../core/Viewport.js';
import { EventBus, Events, globalEventBus } from '../core/EventBus.js';
import { CommandHistory, AddShapeCommand, DeleteShapesCommand, MoveShapesCommand, ModifyShapeCommand } from '../core/CommandHistory.js';
import { SelectionManager } from '../core/SelectionManager.js';
import { FileManager } from '../core/FileManager.js';
import { storageManager } from '../core/StorageManager.js';
import { ComponentPicker } from '../components/ComponentPicker.js';
import { Line, Wire, Circle, Rect, Arc, Polygon, Text, updateIdCounter } from '../shapes/index.js';
import { Component, getComponentLibrary } from '../components/index.js';

// Shape class registry for deserialization
const ShapeClasses = { Line, Wire, Circle, Rect, Arc, Polygon, Text };

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
        
        // Wire-specific drawing state
        this.wirePoints = [];  // Waypoints for the current wire being drawn
        this.wireSnapPin = null;  // Pin currently being snapped to (if any)
        this.wireSnapTolerance = 0.5;  // How close to snap to a pin
        this.wireStartPin = null;  // The pin we started from (if any)
        this.wireActiveAxis = null; // 'horizontal' | 'vertical' | null - sticky direction for current segment
        this.wireAutoCorner = null;  // Auto-generated corner for preview
        this.wireLastAdjustedPoint = null; // Last waypoint modified for axis-snap
        
        // Drag state
        this.isDragging = false;
        this.didDrag = false;  // Track if actual drag occurred
        this.dragMode = null;  // 'move', 'anchor', or 'box'
        this.dragStart = null;
        this.dragAnchorId = null;
        this.dragShape = null;
        this.dragWireAnchorOriginal = null;
        
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
        if (this.currentTool === 'select') return;
        
        this.isDrawing = true;
        this.drawStart = { ...worldPos };
        this.drawCurrent = { ...worldPos };
        
        if (this.currentTool === 'polygon') {
            this.polygonPoints = [{ ...worldPos }];
        }
        
        this._createPreview();
        this._hideCrosshair();
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
        this._setToolCursor(this.currentTool, this.viewport.svg);
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
            case 'text':
                svg = `<text x="${start.x}" y="${start.y}" fill="${opts.color}" font-size="2.5" font-family="Arial" dominant-baseline="hanging">Text</text>`;
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
            case 'text': {
                const label = window.prompt('Text', 'Text');
                if (label === null) return null;
                return new Text({
                    x: start.x,
                    y: start.y,
                    text: label,
                    color: opts.color,
                    fillColor: opts.color
                });
            }
                
            default:
                return null;
        }
    }

    // ==================== Wire Drawing ====================
    
    /**
     * Get snapped position for wire drawing with directional routing
     * First segment from pin: lock Y (horizontal) or X (vertical)
     * Later segments: grid snap, but override with target pin Y/X when approaching
     */
    _getWireSnappedPosition(worldPos) {
        const gridSnapped = this.viewport.getSnappedPosition(worldPos);
        
        // Check if we're approaching a target pin
        const targetPin = this._findNearbyPin(worldPos, 1.0);  // Increased from 0.5 to 1.0mm for easier detection
        
        // If this is the first segment (no waypoints yet)
        if (this.wirePoints.length === 0) {
            // Should not be called without a starting point
            return { ...gridSnapped, snapPin: null, targetPin: null };
        }
        
        const lastPoint = this.wirePoints[this.wirePoints.length - 1];
        
        // Tier 1: If hovering directly over a target pin, snap to it
        // Don't snap to the start pin or the current waypoint
        if (targetPin && targetPin !== this.wireStartPin) {
            // Also check we're not trying to snap to the last waypoint's pin
            if (lastPoint.pin && lastPoint.pin === targetPin) {
                // Same pin as current waypoint, don't snap
            } else {
                return { ...targetPin.worldPos, snapPin: targetPin, targetPin: targetPin };
            }
        }
        
        // Tier 2: Determine current segment direction
        if (this.wirePoints.length === 1) {
            // First segment - we have a start point, determine direction
            const dx = Math.abs(worldPos.x - lastPoint.x);
            const dy = Math.abs(worldPos.y - lastPoint.y);
            
            console.log(`[Wire Debug] First segment: dx=${dx.toFixed(3)}, dy=${dy.toFixed(3)}, lastPoint=(${lastPoint.x.toFixed(2)}, ${lastPoint.y.toFixed(2)})`);
            
            // If we've already detected a direction, stick with it
            if (this.wireDirection) {
                if (this.wireDirection === 'horizontal') {
                    return { 
                        x: gridSnapped.x, 
                        y: lastPoint.y, 
                        snapPin: null 
                    };
                } else if (this.wireDirection === 'vertical') {
                    return { 
                        x: lastPoint.x, 
                        y: gridSnapped.y, 
                        snapPin: null 
                    };
                }
            }
            
            // Lock to whichever direction has more movement
            const minMovement = 0.05;  // Very small threshold to detect direction
            if (dx > dy && dx > minMovement) {
                // Moving more horizontally - snap X to grid, lock Y to last waypoint
                console.log(`[Wire Debug] HORIZONTAL: returning x=${gridSnapped.x}, y=${lastPoint.y}`);
                this.wireDirection = 'horizontal';
                return { 
                    x: gridSnapped.x, 
                    y: lastPoint.y, 
                    snapPin: null 
                };
            } else if (dy > dx && dy > minMovement) {
                // Moving more vertically - lock X to last waypoint, snap Y to grid
                console.log(`[Wire Debug] VERTICAL: returning x=${lastPoint.x}, y=${gridSnapped.y}`);
                this.wireDirection = 'vertical';
                return { 
                    x: lastPoint.x, 
                    y: gridSnapped.y, 
                    snapPin: null 
                };
            } else {
                // Still ambiguous - lock to the pin's coordinate until clear direction
                return { 
                    x: lastPoint.x, 
                    y: lastPoint.y, 
                    snapPin: null 
                };
            }
        } else {
            // Later segments - apply directional snapping to subsequent waypoints
            const lastPoint = this.wirePoints[this.wirePoints.length - 1];
            const dx = Math.abs(worldPos.x - lastPoint.x);
            const dy = Math.abs(worldPos.y - lastPoint.y);
            const minMovement = 0.05;
            
            // Detect current direction to pick the best approach
            let segmentDirection = null;
            if (dx > dy && dx > minMovement) {
                segmentDirection = 'horizontal';
            } else if (dy > dx && dy > minMovement) {
                segmentDirection = 'vertical';
            }
            
            // Check for target pin
            if (targetPin && targetPin !== this.wireStartPin) {
                const targetX = targetPin.worldPos.x;
                const targetY = targetPin.worldPos.y;
                
                // If we have a clear direction, snap the endpoint toward the pin
                if (segmentDirection === 'horizontal') {
                    // Moving horizontally - snap X to pin, keep Y at waypoint
                    return { 
                        x: targetX,
                        y: lastPoint.y, 
                        snapPin: null,
                        targetPin: targetPin  // Pass the pin for preview rendering
                    };
                }
                if (segmentDirection === 'vertical') {
                    // Moving vertically - snap Y to pin, keep X at waypoint
                    return { 
                        x: lastPoint.x,
                        y: targetY, 
                        snapPin: null,
                        targetPin: targetPin  // Pass the pin for preview rendering
                    };
                }
                
                // No clear direction yet - offer both approaches and pick closest
                const hApproach = { x: gridSnapped.x, y: targetY, distance: Math.abs(worldPos.y - targetY) };
                const vApproach = { x: targetX, y: gridSnapped.y, distance: Math.abs(worldPos.x - targetX) };
                
                if (hApproach.distance < vApproach.distance) {
                    return { x: hApproach.x, y: hApproach.y, snapPin: null, targetPin: targetPin };
                } else {
                    return { x: vApproach.x, y: vApproach.y, snapPin: null, targetPin: targetPin };
                }
            }
            
            // No target pin - apply directional snap based on current movement
            if (dx > dy && dx > minMovement) {
                return { 
                    x: gridSnapped.x, 
                    y: lastPoint.y, 
                    snapPin: null,
                    targetPin: null
                };
            } else if (dy > dx && dy > minMovement) {
                return { 
                    x: lastPoint.x, 
                    y: gridSnapped.y, 
                    snapPin: null,
                    targetPin: null
                };
            } else {
                // No clear direction yet - stay at last point
                return { 
                    x: lastPoint.x, 
                    y: lastPoint.y, 
                    snapPin: null,
                    targetPin: null
                };
            }
        }
    }
    
    /**
     * Find the nearest pin within snap tolerance from a position
     * Returns {component, pin, distance, worldPos} or null if no pin nearby
     * @param {Object} worldPos - The position to check
     * @param {number} tolerance - Snap tolerance in mm (defaults to 0.5mm)
     */
    _findNearbyPin(worldPos, tolerance = 0.5) {
        let nearest = null;
        let minDist = tolerance;

        for (const component of this.components) {
            if (!component.symbol || !component.symbol.pins) continue;

            for (const pin of component.symbol.pins) {
                // Transform pin from component local coords to world coords
                const pinWorldX = component.x + pin.x;
                const pinWorldY = component.y + pin.y;
                
                const dist = Math.hypot(worldPos.x - pinWorldX, worldPos.y - pinWorldY);
                
                if (dist < minDist) {
                    minDist = dist;
                    nearest = {
                        component,
                        pin,
                        distance: dist,
                        worldPos: { x: pinWorldX, y: pinWorldY }
                    };
                }
            }
        }

        return nearest;
    }

    /**
     * Check if two pins are the same (by component and pin number)
     */
    _isSamePin(pin1, pin2) {
        return pin1?.component?.id === pin2?.component?.id &&
               pin1?.pin?.number === pin2?.pin?.number;
    }

    /**
     * Check if two points are essentially the same (within epsilon)
     */
    _pointsMatch(a, b, epsilon = 1e-6) {
        return a && b && Math.abs(a.x - b.x) < epsilon && Math.abs(a.y - b.y) < epsilon;
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
        const autoCornerDeadband = gridSize * 0.5;
        const prevCellX = Math.floor(lastWorldPos.x / gridSize);
        const prevCellY = Math.floor(lastWorldPos.y / gridSize);
        const currCellX = Math.floor(worldPos.x / gridSize);
        const currCellY = Math.floor(worldPos.y / gridSize);
        const crossedGridLineX = currCellX !== prevCellX;
        const crossedGridLineY = currCellY !== prevCellY;
        const turningHorizontalTrigger = primaryDir === 'horizontal' && (rawDy > autoCornerDeadband || crossedGridLineY);
        const turningVerticalTrigger = primaryDir === 'vertical' && (rawDx > autoCornerDeadband || crossedGridLineX);

        return {
            triggered: turningHorizontalTrigger || turningVerticalTrigger,
            turningHorizontalTrigger,
            turningVerticalTrigger
        };
    }
    
    /**
     * Start drawing a wire - click to place first point or snap to pin
     */
    _startWireDrawing(snappedData) {
        const snapPin = snappedData.snapPin;
        
        if (snapPin) {
            // Snap to pin connection point
            this.wirePoints = [{ x: snappedData.x, y: snappedData.y, pin: snapPin }];
            this.wireSnapPin = snapPin;
            this.wireStartPin = snapPin;  // Remember start pin
        } else {
            // Start at snapped position
            this.wirePoints = [{ x: snappedData.x, y: snappedData.y }];
            this.wireSnapPin = null;
            this.wireStartPin = null;
        }
        
        this.wireAutoCorner = null;
        this.wireActiveAxis = null;
        this.wireLastAdjustedPoint = null;
        this.isDrawing = true;
        this._createPreview();
        this._showCrosshair();
        this._updateCrosshair(snappedData);
        this.viewport.svg.style.cursor = 'none';
    }
    
    /**
     * Update wire preview while drawing
     */
    _updateWireDrawing(worldPos) {
        if (!this.isDrawing || this.wirePoints.length === 0) return;
        
        let lastPoint = { ...this.wirePoints[this.wirePoints.length - 1] };
        const gridSize = this.viewport.gridSize || 1.0;
        
        // 1. Find nearby pin (Detection radius 2.0mm)
        let nearPin = this._findNearbyPin(worldPos, 2.0);
        
        // Avoid snapping back to the starting pin immediately
        if (nearPin && this.wireStartPin && this.wirePoints.length === 1) {
            if (this._isSamePin({ component: nearPin.component, pin: nearPin.pin }, this.wireStartPin)) {
                nearPin = null;
            }
        }
        
        // Handle visual highlighting
        if (nearPin && nearPin !== this.wireSnapPin) {
            if (this.wireSnapPin) this._unhighlightPin();
            this.wireSnapPin = nearPin;
            this._highlightPin(nearPin);
        } else if (!nearPin && this.wireSnapPin) {
            this._unhighlightPin();
        }

        // 2. Determine raw movement for direction locking
        const rawDx = Math.abs(worldPos.x - lastPoint.x);
        const rawDy = Math.abs(worldPos.y - lastPoint.y);
        const dist = Math.hypot(worldPos.x - lastPoint.x, worldPos.y - lastPoint.y);

        // Reset/Update Direction Lock based on the dominant axis of movement
        if (dist < gridSize * 0.15) {
            this.wireActiveAxis = null;
        } else if (!this.wireActiveAxis) {
            this.wireActiveAxis = rawDx >= rawDy ? 'horizontal' : 'vertical';
        }

        // 3. Calculate target coordinate
        const gridSnapped = this.viewport.getSnappedPosition(worldPos);
        let target = { ...gridSnapped };
        let isAdjusted = false;

        // Apply Fake Grid Snapping (Pin Alignment)
        if (nearPin) {
            const pinPos = nearPin.worldPos;
            const dxPin = Math.abs(worldPos.x - pinPos.x);
            const dyPin = Math.abs(worldPos.y - pinPos.y);
            const snapThreshold = 0.75; // Snapping sensitivity to pin axis

            // If we are approaching horizontally, snap vertical position to pin center
            if (this.wireActiveAxis === 'horizontal') {
                if (dyPin < snapThreshold) target.y = pinPos.y;
                // Reach-in snap: snap the X as well if we are very close to the center
                if (dxPin < snapThreshold) target.x = pinPos.x;
            } 
            // If we are approaching vertically, snap horizontal position to pin center
            else if (this.wireActiveAxis === 'vertical') {
                if (dxPin < snapThreshold) target.x = pinPos.x;
                // Reach-in snap: snap the Y as well if we are very close
                if (dyPin < snapThreshold) target.y = pinPos.y;
            }
            // If no lock yet, just snap to center if extremely close
            else if (dxPin < snapThreshold && dyPin < snapThreshold) {
                target = { ...pinPos };
            }

            // Waypoint Adjustment: Slide the previous waypoint to align with the pin
            // We only do this for SMALL adjustments (stubs). If the user has made 
            // a significant move, we respect their manual corner and don't collapse it.
            if (this.wirePoints.length >= 2) {
                const lastWaypoint = this.wirePoints[this.wirePoints.length - 1];
                const prevWay = this.wirePoints[this.wirePoints.length - 2];
                if (!lastWaypoint.pin) {
                    const isVerticalPrev = Math.abs(lastWaypoint.x - prevWay.x) < 0.05;
                    const isHorizontalPrev = Math.abs(lastWaypoint.y - prevWay.y) < 0.05;
                    const shiftThreshold = gridSize * 0.8; // Only fix small offsets (< 1 grid)

                    if (this.wireActiveAxis === 'horizontal') {
                        const dy = Math.abs(target.y - lastWaypoint.y);
                        if (isVerticalPrev && dy > 0.05 && dy < shiftThreshold) {
                            lastPoint.y = target.y; 
                            isAdjusted = true;
                        }
                    } else if (this.wireActiveAxis === 'vertical') {
                        const dx = Math.abs(target.x - lastPoint.x);
                        if (isHorizontalPrev && dx > 0.05 && dx < shiftThreshold) {
                            lastPoint.x = target.x; 
                            isAdjusted = true;
                        }
                    }
                }
            }
        }

        // 4. Enforce Orthogonality for free-drawing
        const orthogonalSnapLimit = gridSize * 0.45;
        if (!nearPin) {
             if (this.wireActiveAxis === 'vertical' && rawDx <= orthogonalSnapLimit) {
                target.x = lastPoint.x;
            } else if (this.wireActiveAxis === 'horizontal' && rawDy <= orthogonalSnapLimit) {
                target.y = lastPoint.y;
            }
        }

        // 5. Calculate Corner Strategy
        // 'vertical'   => Start with vertical segment -> Corner is (last.x, target.y)
        // 'horizontal' => Start with horizontal segment -> Corner is (target.x, last.y)
        this.wireAutoCorner = null;
        if (this.wireActiveAxis === 'vertical') {
            if (Math.abs(target.x - lastPoint.x) > 0.05 && Math.abs(target.y - lastPoint.y) > 0.05) {
                this.wireAutoCorner = { x: lastPoint.x, y: target.y };
            }
        } else if (this.wireActiveAxis === 'horizontal') {
            if (Math.abs(target.x - lastPoint.x) > 0.05 && Math.abs(target.y - lastPoint.y) > 0.05) {
                this.wireAutoCorner = { x: target.x, y: lastPoint.y };
            }
        }

        this.drawCurrent = target;
        this.wireLastAdjustedPoint = isAdjusted ? lastPoint : null;
        this.lastSnappedData = { x: target.x, y: target.y, snapPin: nearPin, targetPin: nearPin };
        this._updateWirePreview();
    }

    /**
     * Get snapped position for wire anchor editing, allowing snap to original position
     */
    _getWireAnchorSnappedPosition(wireShape, anchorId, worldPos) {
        const snapped = this.viewport.getSnappedPosition(worldPos);
        const match = anchorId?.match(/point(\d+)/);
        if (!match || !wireShape?.points || wireShape.points.length === 0) return snapped;

        const idx = parseInt(match[1]);
        if (Number.isNaN(idx) || idx < 0 || idx >= wireShape.points.length) return snapped;

        const original = (anchorId === this.dragAnchorId && this.dragWireAnchorOriginal)
            ? this.dragWireAnchorOriginal
            : null;

        if (!original) return snapped;

        const gridSize = this.viewport.gridSize || 1.0;
        const halfGrid = gridSize * 0.5;
        const prev = wireShape.points[idx - 1] || null;
        const next = wireShape.points[idx + 1] || null;

        let snapX = snapped.x;
        let snapY = snapped.y;

        // Add fake snap lines from the other end of the segment
        if (prev) {
            if (Math.abs(worldPos.x - prev.x) <= halfGrid) {
                snapX = prev.x;
            }
            if (Math.abs(worldPos.y - prev.y) <= halfGrid) {
                snapY = prev.y;
            }
        }
        if (next) {
            if (Math.abs(worldPos.x - next.x) <= halfGrid) {
                snapX = next.x;
            }
            if (Math.abs(worldPos.y - next.y) <= halfGrid) {
                snapY = next.y;
            }
        }

        const useX = Math.abs(worldPos.x - original.x) <= Math.abs(worldPos.x - snapX)
            ? original.x
            : snapX;
        const useY = Math.abs(worldPos.y - original.y) <= Math.abs(worldPos.y - snapY)
            ? original.y
            : snapY;

        return { x: useX, y: useY };
    }
    
    /**
     * Add a waypoint to the wire
     */
    _addWireWaypoint(waypointData) {
        if (this.wirePoints.length === 0) return;
        
        // Apply any live adjustments (e.g. pin snapping) to the previous waypoint
        if (this.wireLastAdjustedPoint && this.wirePoints.length > 0) {
            this.wirePoints[this.wirePoints.length - 1] = { ...this.wireLastAdjustedPoint };
            this.wireLastAdjustedPoint = null;
        }

        const sourcePoint = waypointData?.point || this.drawCurrent;
        // Just store the coordinate that was being previewed
        const point = waypointData.snapPin ? 
            { x: sourcePoint.x, y: sourcePoint.y, pin: waypointData.snapPin } : 
            { x: sourcePoint.x, y: sourcePoint.y };

        this.wirePoints.push(point);
        this.wireAutoCorner = null;
        this.wireActiveAxis = null;
        this._updateWirePreview();
    }
    
    /**
     * Finish drawing the wire
     */
    _finishWireDrawing(worldPos) {
        if (this.wireAutoCorner) {
            const lastPoint = this.wirePoints[this.wirePoints.length - 1];
            if (!this._pointsMatch(lastPoint, this.wireAutoCorner)) {
                this._addWireWaypoint({ point: this.wireAutoCorner, snapPin: null });
            }
        }

        if (this.drawCurrent) {
            const lastPoint = this.wirePoints[this.wirePoints.length - 1];
            if (!this._pointsMatch(lastPoint, this.drawCurrent)) {
                this._addWireWaypoint({ point: this.drawCurrent, snapPin: this.lastSnappedData?.snapPin || null });
            }
        }

        if (this.wirePoints.length < 2) {
            this._cancelWireDrawing();
            return;
        }

        // Ensure any pin highlight is cleared when finalizing a wire
        this._unhighlightPin();
        
        // Create wire shape with the waypoints we already have
        // (they were set correctly during drawing with pin snapping)
        
        // Create wire shape
        const wire = new Wire({
            points: this.wirePoints.map(p => ({ x: p.x, y: p.y })),
            color: '#00cc66',
            lineWidth: 0.2,
            connections: {
                start: this.wirePoints[0].pin ? { 
                    componentId: this.wirePoints[0].pin.component.id,
                    pinNumber: this.wirePoints[0].pin.pin.number
                } : null,
                end: this.wirePoints[this.wirePoints.length - 1].pin ? {
                    componentId: this.wirePoints[this.wirePoints.length - 1].pin.component.id,
                    pinNumber: this.wirePoints[this.wirePoints.length - 1].pin.pin.number
                } : null
            }
        });
        
        this.addShape(wire);
        this._cancelWireDrawing();
    }
    
    /**
     * Cancel wire drawing
     */
    _cancelWireDrawing() {
        this.wirePoints = [];
        this.wireSnapPin = null;
        this.wireStartPin = null;
        this.wireAutoCorner = null;
        this.wireActiveAxis = null;
        this.wireLastAdjustedPoint = null;
        this.wireLastWorldPos = null;
        this.wireTurned = false;
        this._unhighlightPin();
        
        this.isDrawing = false;
        if (this.previewElement) {
            this.previewElement.remove();
            this.previewElement = null;
        }
        
        this._hideCrosshair();
        this._setToolCursor(this.currentTool, this.viewport.svg);
    }
    
    /**
     * Update wire preview visualization
     */
    _updateWirePreview() {
        if (!this.previewElement) return;
        
        const strokeWidth = this._getEffectiveStrokeWidth(0.2);
        let svg = '';

        // Use original waypoints, but the last one might be adjusted by _updateWireDrawing
        const wirePoints = this.wirePoints;
        
        // Draw all established segments
        for (let i = 0; i < wirePoints.length - 1; i++) {
            const p1 = wirePoints[i];
            let p2 = wirePoints[i + 1];
            
            // If this is the last established segment and we have an adjusted point (for snapping), use it
            if (i === wirePoints.length - 2 && this.wireLastAdjustedPoint) {
                p2 = this.wireLastAdjustedPoint;
            }
            
            svg += `<line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" 
                    stroke="#00cc66" stroke-width="${strokeWidth}" stroke-linecap="round"/>`;
        }
        
        // Draw waypoint dots
        for (let i = 0; i < wirePoints.length; i++) {
            let p = wirePoints[i];
            // Adjust the last dot if it's currently being shifted for a pin snap
            if (i === wirePoints.length - 1 && this.wireLastAdjustedPoint) {
                p = this.wireLastAdjustedPoint;
            }
            svg += `<circle cx="${p.x}" cy="${p.y}" r="${2 / this.viewport.scale}" fill="#00cc66"/>`;
        }
        
        // Draw preview line to cursor
        if (this.drawCurrent && wirePoints.length > 0) {
            const last = this.wireLastAdjustedPoint || wirePoints[wirePoints.length - 1];
            if (this.wireAutoCorner) {
                svg += `<line x1="${last.x}" y1="${last.y}" x2="${this.wireAutoCorner.x}" y2="${this.wireAutoCorner.y}" 
                        stroke="#00cc66" stroke-width="${strokeWidth}" stroke-linecap="round"/>`;
                svg += `<line x1="${this.wireAutoCorner.x}" y1="${this.wireAutoCorner.y}" x2="${this.drawCurrent.x}" y2="${this.drawCurrent.y}" 
                        stroke="#00cc66" stroke-width="${strokeWidth}" stroke-linecap="round"/>`;
            } else {
                svg += `<line x1="${last.x}" y1="${last.y}" x2="${this.drawCurrent.x}" y2="${this.drawCurrent.y}" 
                        stroke="#00cc66" stroke-width="${strokeWidth}" stroke-linecap="round"/>`;
            }
        }
        
        this.previewElement.innerHTML = svg;
    }
    
    /**
     * Highlight a pin during snapping
     */
    _highlightPin(snapPin) {
        if (!snapPin || !snapPin.pin) return;
        
        const pinGroup = snapPin.component.pinElements?.get(snapPin.pin.number);
        if (pinGroup) {
            // Find the circle (dot) element in the pin group
            const dot = pinGroup.querySelector('circle');
            if (dot) {
                // Save original fill color if not already saved
                if (!dot.dataset.originalFill) {
                    dot.dataset.originalFill = dot.getAttribute('fill');
                }
                dot.setAttribute('fill', '#ffff00');  // Change to yellow
                dot.setAttribute('r', 0.7);  // Enlarge it slightly
            }
        }
    }
    
    /**
     * Remove pin highlight
     */
    _unhighlightPin() {
        if (this.wireSnapPin && this.wireSnapPin.pin) {
            const pinGroup = this.wireSnapPin.component.pinElements?.get(this.wireSnapPin.pin.number);
            if (pinGroup) {
                const dot = pinGroup.querySelector('circle');
                if (dot) {
                    // Restore original fill color
                    const originalFill = dot.dataset.originalFill || 'var(--sch-pin, #aa0000)';
                    dot.setAttribute('fill', originalFill);
                    dot.setAttribute('r', 0.45);  // Reset to original size
                }
            }
        }
        this.wireSnapPin = null;
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

        this._setActiveToolButton?.('component');
        this._updateShapePanelOptions(this.selection.getSelection(), 'component');
        
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
            this._setActiveToolButton?.('select');
            this._updateShapePanelOptions(this.selection.getSelection(), 'select');
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
    
    _updateCrosshair(snapped, screenPosOverride = null) {
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

    _getToolIconPath(tool) {
        switch (tool) {
            case 'line':
                return 'M 0 8 L 8 0';
            case 'wire':
                return 'M 0 4 L 8 4';
            case 'rect':
                return 'M 1 1 H 7 V 7 H 1 Z';
            case 'circle':
                return 'M 4 1 A 3 3 0 1 1 3.999 1';
            case 'arc':
                return 'M 1 7 A 6 6 0 0 1 7 1';
            case 'polygon':
                return 'M 4 0 L 8 3 L 6 8 L 2 8 L 0 3 Z';
            case 'text':
                return 'M 1 1 H 7 M 4 1 V 7';
            case 'component':
                return 'M 1 1 H 7 V 7 H 1 Z M 4 2 V 6 M 2 4 H 6';
            default:
                return '';
        }
    }

    _setToolCursor(tool, svg) {
        if (!svg) return;
        if (tool === 'select') {
            svg.style.cursor = 'default';
            return;
        }

        const path = this._getToolIconPath(tool);
        if (!path) {
            svg.style.cursor = 'crosshair';
            return;
        }

        const stroke = '#ffffff';
        const svgMarkup = `<?xml version="1.0" encoding="UTF-8"?>
            <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="-4 -6 26 26">
                <path d="M 0 8 H 16 M 8 0 V 16" fill="none" stroke="${stroke}" stroke-width="1" stroke-linecap="round" />
                <g transform="translate(10 -2)">
                    <path d="${path}" fill="none" stroke="${stroke}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
                </g>
            </svg>`;
        const encoded = encodeURIComponent(svgMarkup)
            .replace(/'/g, '%27')
            .replace(/"/g, '%22');
        svg.style.cursor = `url("data:image/svg+xml,${encoded}") 16 18, crosshair`;
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
        this.crosshair.container.classList.add('active');
    }
    
    _hideCrosshair() {
        this.crosshair.container.classList.remove('active');
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
        if (!this.ui.propertiesPanel) return;

        this.ui.propLocked.addEventListener('change', (e) => {
            this._applyCommonProperty('locked', e.target.checked);
        });

        this.ui.propLineWidth.addEventListener('change', (e) => {
            const value = parseFloat(e.target.value);
            if (Number.isNaN(value)) return;
            this._applyCommonProperty('lineWidth', value);
        });

        this.ui.propFill.addEventListener('change', (e) => {
            this._applyCommonProperty('fill', e.target.checked);
        });

        if (this.ui.propText) {
            this.ui.propText.addEventListener('change', (e) => {
                this._applyCommonProperty('text', e.target.value);
            });
        }

        if (this.ui.propTextSize) {
            this.ui.propTextSize.addEventListener('change', (e) => {
                const value = parseFloat(e.target.value);
                if (Number.isNaN(value)) return;
                this._applyCommonProperty('fontSize', value);
            });
        }

        this._updatePropertiesPanel([]);
    }

    _bindRibbon() {
        const tabs = document.querySelectorAll('.ribbon-tab');
        const panels = document.querySelectorAll('.ribbon-panel');
        if (tabs.length === 0 || panels.length === 0) return;

        this._setActiveRibbonTab = (tabId) => {
            tabs.forEach(tab => tab.classList.toggle('active', tab.dataset.tab === tabId));
            panels.forEach(panel => panel.classList.toggle('active', panel.dataset.panel === tabId));
        };

        tabs.forEach(tab => {
            tab.addEventListener('click', () => this._setActiveRibbonTab(tab.dataset.tab));
        });
        this._setActiveRibbonTab('home');

        const get = (id) => document.getElementById(id);

        get('ribbonNew')?.addEventListener('click', () => this.newFile());
        get('ribbonOpen')?.addEventListener('click', () => this.openFile());
        get('ribbonSave')?.addEventListener('click', () => this.saveFile());
        get('ribbonSaveAs')?.addEventListener('click', () => this.saveFileAs());
        get('ribbonExportPdf')?.addEventListener('click', () => this.savePdf());

        get('ribbonDelete')?.addEventListener('click', () => this._deleteSelected());
        get('ribbonToggleLock')?.addEventListener('click', () => this._toggleSelectionLock());
        get('ribbonRotate')?.addEventListener('click', () => this._rotateComponent());

        const ribbonToolButtons = Array.from(document.querySelectorAll('.ribbon-tool-btn'));
        const setActiveToolButton = (toolId) => {
            ribbonToolButtons.forEach(btn => btn.classList.toggle('active', btn.dataset.tool === toolId));
        };
        this._setActiveToolButton = setActiveToolButton;
        ribbonToolButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const toolId = btn.dataset.tool;
                this._onToolSelected(toolId);
            });
        });
        setActiveToolButton(this.currentTool);

        this._updateRibbonState(this.selection.getSelection());
        this._updateShapePanelOptions(this.selection.getSelection(), this.currentTool);
    }

    _updateShapePanelOptions(selection, toolId = this.currentTool) {
        const container = document.getElementById('ribbonShapeOptions');
        if (!container) return;

        const items = selection || [];
        const hasSelection = items.length > 0;
        const toolSupportsLineWidth = toolId === 'line' || toolId === 'wire';
        const toolSupportsFill = toolId === 'rect' || toolId === 'circle' || toolId === 'polygon';
        const supportsLineWidth = hasSelection
            ? items.some(item => typeof item?.lineWidth === 'number')
            : toolSupportsLineWidth;
        const supportsFill = hasSelection
            ? items.some(item => typeof item?.fill === 'boolean')
            : toolSupportsFill;

        container.innerHTML = `
            <label>
                Line width
                <input type="number" id="ribbonShapeLineWidth" step="0.05" min="0" placeholder="—">
            </label>
            <label>
                <input type="checkbox" id="ribbonShapeFill"> Fill
            </label>
        `;

        const setCheckboxState = (el, values) => {
            el.indeterminate = false;
            if (values.length === 0) {
                el.checked = false;
                el.disabled = true;
                return;
            }
            const allTrue = values.every(v => v === true);
            const allFalse = values.every(v => v === false);
            el.disabled = false;
            if (allTrue) {
                el.checked = true;
            } else if (allFalse) {
                el.checked = false;
            } else {
                el.checked = false;
                el.indeterminate = true;
            }
        };

        const lineWidthInput = container.querySelector('#ribbonShapeLineWidth');
        if (lineWidthInput) {
            if (hasSelection) {
                const lineWidthValues = items
                    .filter(item => typeof item?.lineWidth === 'number')
                    .map(item => item.lineWidth);

                if (lineWidthValues.length === 0) {
                    lineWidthInput.value = '';
                    lineWidthInput.placeholder = '—';
                    lineWidthInput.disabled = true;
                } else {
                    lineWidthInput.disabled = false;
                    const first = lineWidthValues[0];
                    const allSame = lineWidthValues.every(v => Math.abs(v - first) < 1e-6);
                    if (allSame) {
                        lineWidthInput.value = first;
                    } else {
                        lineWidthInput.value = '';
                        lineWidthInput.placeholder = '—';
                    }
                }
            } else {
                lineWidthInput.disabled = !supportsLineWidth;
                lineWidthInput.value = this.toolOptions?.lineWidth ?? 0.2;
            }

            lineWidthInput.addEventListener('change', (e) => {
                const value = parseFloat(e.target.value);
                if (Number.isNaN(value)) return;
                if (hasSelection) {
                    this._applyCommonProperty('lineWidth', value);
                } else {
                    this.toolOptions.lineWidth = value;
                }
            });
        }

        const fillInput = container.querySelector('#ribbonShapeFill');
        if (fillInput) {
            if (hasSelection) {
                const fillValues = items
                    .filter(item => typeof item?.fill === 'boolean')
                    .map(item => item.fill);
                setCheckboxState(fillInput, fillValues);
            } else {
                fillInput.disabled = !supportsFill;
                fillInput.checked = !!this.toolOptions?.fill;
                fillInput.indeterminate = false;
            }
            fillInput.addEventListener('change', (e) => {
                if (hasSelection) {
                    this._applyCommonProperty('fill', e.target.checked);
                } else {
                    this.toolOptions.fill = e.target.checked;
                }
            });
        }
    }

    _updateRibbonState(selection) {
        const count = selection.length;
        const lockBtn = document.getElementById('ribbonToggleLock');
        const deleteBtn = document.getElementById('ribbonDelete');
        const rotateBtn = document.getElementById('ribbonRotate');

        if (deleteBtn) deleteBtn.disabled = count === 0;
        if (lockBtn) lockBtn.disabled = count === 0;

        if (rotateBtn) {
            const hasComponent = selection.some(item => item?.definition);
            rotateBtn.disabled = !hasComponent;
        }
    }

    _toggleSelectionLock() {
        const selection = this.selection.getSelection();
        if (selection.length === 0) return;
        const allLocked = selection.every(item => item.locked === true);
        const nextValue = !allLocked;
        for (const item of selection) {
            if (typeof item.locked === 'boolean') {
                item.locked = nextValue;
                if (typeof item.invalidate === 'function') item.invalidate();
            }
        }
        this.fileManager.setDirty(true);
        this.renderShapes(true);
        this._updatePropertiesPanel(selection);
        this._updateRibbonState(selection);
    }

    _updatePropertiesPanel(selection) {
        if (!this.ui.propertiesPanel) return;

        const count = selection.length;
        this.ui.propSelectionCount.textContent = String(count);

        if (this.ui.propertiesHeaderLabel) {
            if (count === 0) {
                this.ui.propertiesHeaderLabel.textContent = 'Properties';
            } else {
                const types = selection.map(item => item?.definition ? 'component' : (item?.type || 'object'));
                const first = types[0];
                const allSame = types.every(t => t === first);
                const labelType = allSame ? first : 'Multiple';
                this.ui.propertiesHeaderLabel.textContent = `${labelType.charAt(0).toUpperCase()}${labelType.slice(1)}`;
            }
        }

        const setCheckboxState = (el, values) => {
            el.indeterminate = false;
            if (values.length === 0) {
                el.checked = false;
                el.disabled = true;
                return;
            }
            const allTrue = values.every(v => v === true);
            const allFalse = values.every(v => v === false);
            el.disabled = false;
            if (allTrue) {
                el.checked = true;
            } else if (allFalse) {
                el.checked = false;
            } else {
                el.checked = false;
                el.indeterminate = true;
            }
        };

        const lockedValues = selection
            .filter(item => typeof item.locked === 'boolean')
            .map(item => item.locked);
        setCheckboxState(this.ui.propLocked, lockedValues);

        const lineWidthValues = selection
            .filter(item => typeof item.lineWidth === 'number')
            .map(item => item.lineWidth);

        if (lineWidthValues.length === 0) {
            this.ui.propLineWidth.value = '';
            this.ui.propLineWidth.placeholder = '—';
            this.ui.propLineWidth.disabled = true;
        } else {
            this.ui.propLineWidth.disabled = false;
            const first = lineWidthValues[0];
            const allSame = lineWidthValues.every(v => Math.abs(v - first) < 1e-6);
            if (allSame) {
                this.ui.propLineWidth.value = first;
            } else {
                this.ui.propLineWidth.value = '';
                this.ui.propLineWidth.placeholder = '—';
            }
        }

        const fillValues = selection
            .filter(item => typeof item.fill === 'boolean')
            .map(item => item.fill);
        setCheckboxState(this.ui.propFill, fillValues);

        const hasText = selection.some(item => item?.type === 'text');
        if (hasText) {
            this.ui.propFill.checked = false;
            this.ui.propFill.indeterminate = false;
            this.ui.propFill.disabled = true;
        }

        if (this.ui.propText) {
            const textValues = selection
                .filter(item => typeof item.text === 'string')
                .map(item => item.text);

            if (textValues.length === 0) {
                this.ui.propText.value = '';
                this.ui.propText.placeholder = '—';
                this.ui.propText.disabled = true;
            } else {
                this.ui.propText.disabled = false;
                const first = textValues[0];
                const allSame = textValues.every(v => v === first);
                if (allSame) {
                    this.ui.propText.value = first;
                } else {
                    this.ui.propText.value = '';
                    this.ui.propText.placeholder = '—';
                }
            }
        }

        if (this.ui.propText && selection.length === 1 && selection[0]?.type === 'text') {
            setTimeout(() => {
                this.ui.propText?.focus();
                this.ui.propText?.select();
            }, 0);
        }

        if (this.ui.propTextSize) {
            const sizeValues = selection
                .filter(item => typeof item.fontSize === 'number')
                .map(item => item.fontSize);

            if (sizeValues.length === 0) {
                this.ui.propTextSize.value = '';
                this.ui.propTextSize.placeholder = '—';
                this.ui.propTextSize.disabled = true;
            } else {
                this.ui.propTextSize.disabled = false;
                const first = sizeValues[0];
                const allSame = sizeValues.every(v => Math.abs(v - first) < 1e-6);
                if (allSame) {
                    this.ui.propTextSize.value = first;
                } else {
                    this.ui.propTextSize.value = '';
                    this.ui.propTextSize.placeholder = '—';
                }
            }
        }
    }

    _applyCommonProperty(prop, value) {
        const selection = this.selection.getSelection();
        if (selection.length === 0) return;

        let changed = false;
        for (const item of selection) {
            if (prop in item) {
                item[prop] = value;
                if (typeof item.invalidate === 'function') {
                    item.invalidate();
                }
                changed = true;
            }
        }

        if (changed) {
            this.fileManager.setDirty(true);
            this.renderShapes(true);
            this._updatePropertiesPanel(selection);
        }
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
                    if (shape.locked) continue;
                    const anchorId = shape.hitTestAnchor(worldPos, this.viewport.scale);
                    if (anchorId) {
                        // Start anchor drag - capture state for undo
                        this.isDragging = true;
                        this.dragMode = 'anchor';
                        this.dragStart = { ...snapped };
                        this.dragAnchorId = anchorId;
                        this.dragShape = shape;
                        this.dragWireAnchorOriginal = null;
                        if (shape.type === 'wire') {
                            const match = anchorId.match(/point(\d+)/);
                            const idx = match ? parseInt(match[1]) : null;
                            if (idx !== null && idx >= 0 && idx < shape.points.length) {
                                const current = shape.points[idx];
                                this.dragWireAnchorOriginal = { x: current.x, y: current.y };
                            }
                        }
                        // Capture shape state before modification
                        this.dragShapesBefore = this._captureShapeState(shape);
                        e.preventDefault();
                        return;
                    }
                }
                
                // Check if clicking on any shape/component
                const hitShape = this.selection.hitTest(worldPos);
                
                if (hitShape) {
                    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
                    if (additive) {
                        this.selection.toggle(hitShape);
                        this.renderShapes(true);
                        this.skipClickSelection = true;
                        e.preventDefault();
                        return;
                    }
                    // If clicking on unselected item, select it first
                    if (!hitShape.selected) {
                        this.selection.select(hitShape, false); // Replace selection
                        this.renderShapes(true);
                    }

                    if (hitShape.locked) {
                        e.preventDefault();
                        return;
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
            } else if (this.currentTool === 'wire') {
                // Wire drawing: click to add waypoints, ESC or right-click to finish
                if (!this.isDrawing) {
                    // Start a new wire - check for pin snap first
                    const snapPin = this._findNearbyPin(worldPos);
                    const startData = snapPin ? 
                        { x: snapPin.worldPos.x, y: snapPin.worldPos.y, snapPin: snapPin } :
                        { ...this.viewport.getSnappedPosition(worldPos), snapPin: null };
                    this._startWireDrawing(startData);
                } else {
                    // Add waypoint to existing wire - use the raw worldPos plus the snapped pin data
                    // This avoids storing grid-snapped coordinates in waypoints
                    const rect = this.viewport.svg.getBoundingClientRect();
                    const screenPos = {
                        x: e.clientX - rect.left,
                        y: e.clientY - rect.top
                    };
                    const worldPos = this.viewport.screenToWorld(screenPos);
                    const gridSnapped = this.viewport.getSnappedPosition(worldPos);

                    if (this.lastSnappedData) {
                        const lastPoint = this.wirePoints[this.wirePoints.length - 1];
                        const rawDx = Math.abs(worldPos.x - lastPoint.x);
                        const rawDy = Math.abs(worldPos.y - lastPoint.y);
                        const minMovement = 0.05;

                        if (this.wireAutoCorner && !this._pointsMatch(lastPoint, this.wireAutoCorner)) {
                            this._addWireWaypoint({ point: this.wireAutoCorner, snapPin: null });
                        }

                        this._addWireWaypoint({
                            point: this.drawCurrent,
                            snapPin: this.lastSnappedData.snapPin || null
                        });
                        
                        // If we just snapped to a pin, finish the wire
                        if (this.lastSnappedData.snapPin && this.wirePoints.length >= 2) {
                            this._finishWireDrawing(this.lastSnappedData);
                        }
                    }
                }
                e.preventDefault();
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
        
        // Right-click handler: finish wire drawing
        svg.addEventListener('mousedown', (e) => {
            if (e.button !== 2) return;  // Right-click
            if (this.currentTool === 'wire' && this.isDrawing && this.wirePoints.length >= 2) {
                // Finish the wire on right-click
                const rect = svg.getBoundingClientRect();
                const screenPos = {
                    x: e.clientX - rect.left,
                    y: e.clientY - rect.top
                };
                const worldPos = this.viewport.screenToWorld(screenPos);
                this._finishWireDrawing(worldPos);
                e.preventDefault();
            } else if (this.currentTool === 'polygon' && this.isDrawing) {
                const rect = svg.getBoundingClientRect();
                const screenPos = {
                    x: e.clientX - rect.left,
                    y: e.clientY - rect.top
                };
                const worldPos = this.viewport.screenToWorld(screenPos);
                const snapped = this.viewport.getSnappedPosition(worldPos);
                this._addPolygonPoint(snapped);
                this._finishPolygon();
                e.preventDefault();
            }
        });
        
        svg.addEventListener('mousemove', (e) => {
            const rect = svg.getBoundingClientRect();
            const screenPos = {
                x: e.clientX - rect.left,
                y: e.clientY - rect.top
            };
            const worldPos = this.viewport.screenToWorld(screenPos);
            const snapped = this.viewport.getSnappedPosition(worldPos);
            
            // Handle wire mode - highlight pins on hover even when not drawing
            if (this.currentTool === 'wire') {
                const snapPin = this._findNearbyPin(worldPos);
                if (snapPin && snapPin !== this.wireSnapPin) {
                    if (this.wireSnapPin) {
                        this._unhighlightPin();  // Unhighlight old pin first
                    }
                    this.wireSnapPin = snapPin;
                    this._highlightPin(snapPin);
                } else if (!snapPin && this.wireSnapPin) {
                    this._unhighlightPin();  // This sets wireSnapPin to null
                }
                
                // Update drawing if already started
                if (this.isDrawing) {
                    this._updateWireDrawing(worldPos);
                    this._hideCrosshair();
                } else {
                    this._showCrosshair();
                    this._updateCrosshair(snapped, screenPos);
                }
                return;
            }

            if (this.currentTool !== 'select' && !this.isDrawing) {
                this._showCrosshair();
                this._updateCrosshair(snapped, screenPos);
            } else if (this.isDrawing) {
                this._hideCrosshair();
            }
            
            if (!this.isDragging) return;
            if (this.viewport.isPanning) return;
            
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
                        if (!shape.locked) {
                            shape.move(dx, dy);
                        }
                    }
                    this.dragStart = { ...snapped };
                    this.renderShapes(true);
                    this.fileManager.setDirty(true);
                }
            } else if (this.dragMode === 'anchor' && this.dragShape) {
                // Move the anchor
                this.didDrag = true;
                const anchorPos = this.dragShape.type === 'wire'
                    ? this._getWireAnchorSnappedPosition(this.dragShape, this.dragAnchorId, worldPos)
                    : snapped;
                const newAnchorId = this.dragShape.moveAnchor(this.dragAnchorId, anchorPos.x, anchorPos.y);
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
                this.dragWireAnchorOriginal = null;
                // Don't return - let click handle selection if needed
            }
            
            if (this.viewport.isPanning) return;
            
            if (this.currentTool === 'polygon') {
                // Polygon continues until double-click or Escape
            } else if (this.currentTool === 'wire') {
                // Wire continues until Enter is pressed
            } else if (this.isDrawing) {
                this._finishDrawing(snapped);
            }
        });
        
        svg.addEventListener('click', (e) => {
            if (this.viewport.isPanning) return;

            if (this.skipClickSelection) {
                this.skipClickSelection = false;
                return;
            }
            
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
                this.selection.handleClick(worldPos, e.shiftKey || e.ctrlKey || e.metaKey);
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

        // Properties panel
        this._bindPropertiesPanel();

        // Ribbon
        this._bindRibbon();
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
        // Use capture phase so this runs before other listeners
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
                    case 'p':
                        if (e.shiftKey) {
                            e.preventDefault();
                            this.savePdf();
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
                    case 'Enter':
                        // Finish wire drawing
                        if (this.currentTool === 'wire' && this.isDrawing && this.wirePoints.length >= 2) {
                            this._finishWireDrawing(this.drawCurrent);
                            e.preventDefault();
                        }
                        break;
                    case 'Delete':
                    case 'Backspace':
                        this._deleteSelected();
                        break;
                    case 'v':
                    case 'V':
                        this._onToolSelected('select');
                        break;
                    case 'l':
                    case 'L':
                        this._onToolSelected('line');
                        break;
                    case 'w':
                    case 'W':
                        this._onToolSelected('wire');
                        break;
                    case 'c':
                    case 'C':
                        this._onToolSelected('circle');
                        break;
                    case 'a':
                    case 'A':
                        this._onToolSelected('arc');
                        break;
                    case 'p':
                    case 'P':
                        this._onToolSelected('polygon');
                        break;
                    case 't':
                    case 'T':
                        this._onToolSelected('text');
                        break;
                    case 'i':
                    case 'I':
                        this._onToolSelected('component');
                        break;
                    case 'r':
                    case 'R':
                        // Rotate component during placement only
                        if (this.placingComponent) {
                            this._rotateComponent();
                            e.preventDefault();
                        } else {
                            this._onToolSelected('rect');
                        }
                        // Otherwise let R pass through for Rectangle tool
                        break;
                    case 'm':
                    case 'M':
                        // Mirror component during placement only
                        if (this.placingComponent) {
                            this._mirrorComponent();
                            e.preventDefault();
                        }
                        break;
                }
            }
        }, { capture: true });

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
            case 'wire':
                return {
                    points: shape.points.map(p => ({ x: p.x, y: p.y })),
                    connections: shape.connections ? { ...shape.connections } : null,
                    net: shape.net || ''
                };
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
     * Save current view to PDF
     */
    async savePdf() {
        try {
            const pdfFileName = (this.fileManager?.fileName || 'schematic')
                .replace(/\.[^/.]+$/, '') + '.pdf';

            const jsPDF = await this._loadVectorPdfLibs();
            const svgNode = this._cloneViewportSvgForExport();
            const width = Number(svgNode.getAttribute('width'));
            const height = Number(svgNode.getAttribute('height'));

            const pdf = new jsPDF({
                orientation: width >= height ? 'landscape' : 'portrait',
                unit: 'px',
                format: [width, height]
            });

            const svg2pdf = window.svg2pdf?.svg2pdf || window.svg2pdf?.default || window.svg2pdf;
            if (typeof svg2pdf !== 'function') {
                throw new Error('svg2pdf is not available');
            }

            const result = svg2pdf(svgNode, pdf, {
                x: 0,
                y: 0,
                width,
                height
            });
            if (result?.then) {
                await result;
            }

            const pdfBlob = pdf.output('blob');
            await this._saveBlobAsFile(pdfBlob, pdfFileName, 'application/pdf', ['.pdf']);
        } catch (err) {
            alert('Failed to save PDF: ' + (err?.message || 'Unknown error'));
        }
    }

    _loadVectorPdfLibs() {
        if (this._pdfVectorLoader) return this._pdfVectorLoader;

        const loadScript = (src) => new Promise((resolve, reject) => {
            const existing = Array.from(document.scripts).find(s => s.src === src);
            if (existing) {
                existing.addEventListener('load', () => resolve());
                existing.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)));
                return;
            }
            const script = document.createElement('script');
            script.src = src;
            script.async = true;
            script.onload = () => resolve();
            script.onerror = () => reject(new Error(`Failed to load ${src}`));
            document.head.appendChild(script);
        });

        this._pdfVectorLoader = (async () => {
            await loadScript('./assets/vendor/jspdf.umd.min.js');
            await loadScript('./assets/vendor/svg2pdf.umd.min.js');

            const svg2pdfFn = window.svg2pdf?.svg2pdf || window.svg2pdf?.default || window.svg2pdf;
            if (!window.jspdf?.jsPDF || typeof svg2pdfFn !== 'function') {
                throw new Error('Vector PDF libraries failed to load');
            }
            return window.jspdf.jsPDF;
        })();

        return this._pdfVectorLoader;
    }

    _cloneViewportSvgForExport() {
        const originalSvg = this.viewport.svg;
        const svgNode = originalSvg.cloneNode(true);
        const vb = this.viewport.viewBox;
        const width = Math.max(1, Math.round(this.viewport.width));
        const height = Math.max(1, Math.round(this.viewport.height));

        svgNode.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        svgNode.setAttribute('width', String(width));
        svgNode.setAttribute('height', String(height));
        svgNode.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.width} ${vb.height}`);
        svgNode.setAttribute('style', 'background:#ffffff');

        this._inlineSvgComputedStyles(originalSvg, svgNode);

        // Force monochrome output for export
        this._forceMonochromeSvg(svgNode);

        // Remove grid/axes layers after inlining to keep node order aligned
        const gridLayer = svgNode.querySelector('#gridLayer');
        if (gridLayer) {
            gridLayer.remove();
        }

        const axesLayer = svgNode.querySelector('#axesLayer');
        if (axesLayer) {
            axesLayer.remove();
        }

        // Insert white background AFTER inlining to avoid iterator mismatch
        const bgRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        bgRect.setAttribute('x', String(vb.x));
        bgRect.setAttribute('y', String(vb.y));
        bgRect.setAttribute('width', String(vb.width));
        bgRect.setAttribute('height', String(vb.height));
        bgRect.setAttribute('fill', '#ffffff');
        bgRect.setAttribute('stroke', 'none');
        svgNode.insertBefore(bgRect, svgNode.firstChild);

        return svgNode;
    }

    _forceMonochromeSvg(svgRoot) {
        const nodes = svgRoot.querySelectorAll('*');
        nodes.forEach((el) => {
            const tag = el.tagName?.toLowerCase();
            if (!tag) return;

            // Normalize visibility
            if (el.getAttribute('opacity')) {
                el.setAttribute('opacity', '1');
            }

            // Text: fill only
            if (tag === 'text') {
                el.setAttribute('fill', '#000000');
                el.setAttribute('stroke', 'none');
                return;
            }

            // Shapes: preserve 'none', otherwise force black
            const fill = el.getAttribute('fill');
            const stroke = el.getAttribute('stroke');

            if (fill && fill !== 'none') {
                el.setAttribute('fill', '#000000');
            }

            if (stroke && stroke !== 'none') {
                el.setAttribute('stroke', '#000000');
            }

            // If both are missing or none, enforce stroke for basic shapes
            if ((fill === null || fill === 'none') && (stroke === null || stroke === 'none')) {
                if (['line', 'path', 'polyline', 'polygon', 'rect', 'circle', 'ellipse'].includes(tag)) {
                    el.setAttribute('stroke', '#000000');
                }
            }
        });
    }

    _inlineSvgComputedStyles(originalSvg, clonedSvg) {
        const props = [
            'fill',
            'stroke',
            'strokeWidth',
            'fontSize',
            'fontFamily',
            'fontWeight',
            'fontStyle',
            'textAnchor',
            'dominantBaseline',
            'opacity'
        ];

        const origIter = document.createNodeIterator(originalSvg, NodeFilter.SHOW_ELEMENT);
        const cloneIter = document.createNodeIterator(clonedSvg, NodeFilter.SHOW_ELEMENT);

        let origNode = origIter.nextNode();
        let cloneNode = cloneIter.nextNode();

        while (origNode && cloneNode) {
            const style = window.getComputedStyle(origNode);

            for (const prop of props) {
                const cssValue = style[prop];
                if (cssValue && cssValue !== 'initial' && cssValue !== 'inherit') {
                    const attr = prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
                    cloneNode.setAttribute(attr, cssValue);
                }
            }

            // Preserve text content explicitly
            if (origNode.nodeName.toLowerCase() === 'text') {
                cloneNode.textContent = origNode.textContent;
            }

            origNode = origIter.nextNode();
            cloneNode = cloneIter.nextNode();
        }
    }

    async _saveBlobAsFile(blob, suggestedName, mimeType, extensions) {
        if ('showSaveFilePicker' in window) {
            try {
                const handle = await window.showSaveFilePicker({
                    suggestedName,
                    types: [{ description: 'PDF', accept: { [mimeType]: extensions } }]
                });
                const writable = await handle.createWritable();
                await writable.write(blob);
                await writable.close();
                return;
            } catch (err) {
                if (err?.name === 'AbortError') return;
                throw err;
            }
        }

        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = suggestedName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    /**
     * Render the current viewport SVG to a canvas
     */
    _renderViewportToCanvas(scale = 2) {
        return new Promise((resolve, reject) => {
            try {
                const svgNode = this.viewport.svg.cloneNode(true);
                const vb = this.viewport.viewBox;

                const width = Math.max(1, Math.round(this.viewport.width * scale));
                const height = Math.max(1, Math.round(this.viewport.height * scale));

                svgNode.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
                svgNode.setAttribute('width', String(width));
                svgNode.setAttribute('height', String(height));
                svgNode.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.width} ${vb.height}`);

                // Ensure a white background for PDF output
                const bgRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                bgRect.setAttribute('x', String(vb.x));
                bgRect.setAttribute('y', String(vb.y));
                bgRect.setAttribute('width', String(vb.width));
                bgRect.setAttribute('height', String(vb.height));
                bgRect.setAttribute('fill', '#ffffff');
                svgNode.insertBefore(bgRect, svgNode.firstChild);

                const svgData = new XMLSerializer().serializeToString(svgNode);
                const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
                const url = URL.createObjectURL(svgBlob);

                const img = new Image();
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    canvas.width = width;
                    canvas.height = height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, width, height);
                    URL.revokeObjectURL(url);
                    resolve(canvas);
                };
                img.onerror = () => {
                    URL.revokeObjectURL(url);
                    reject(new Error('Failed to render SVG'));
                };
                img.src = url;
            } catch (err) {
                reject(err);
            }
        });
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