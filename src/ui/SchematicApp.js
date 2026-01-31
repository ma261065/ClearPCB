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
        this._setToolCursor(this.currentTool, this.viewport.svg);
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