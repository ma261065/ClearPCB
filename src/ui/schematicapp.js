/**
 * SchematicApp.js - Schematic Editor Application
 */

import { Viewport } from '../core/Viewport.js';
import { EventBus, Events, globalEventBus } from '../core/EventBus.js';
import { CommandHistory } from '../core/CommandHistory.js';
import { SelectionManager } from '../core/SelectionManager.js';
import { FileManager } from '../core/FileManager.js';
import { Toolbox } from './Toolbox.js';
import { Line, Circle, Rect, Arc, Polygon, updateIdCounter } from '../shapes/index.js';

// Shape class registry for deserialization
const ShapeClasses = { Line, Circle, Rect, Arc, Polygon };

class SchematicApp {
    constructor() {
        this.container = document.getElementById('canvasContainer');
        this.viewport = new Viewport(this.container);
        this.eventBus = globalEventBus;
        this.history = new CommandHistory();
        
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
        this.selection = new SelectionManager({
            onSelectionChanged: (shapes) => this._onSelectionChanged(shapes)
        });
        this.selection.setShapes(this.shapes);
        
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
        this.dragMode = null;  // 'move' or 'anchor'
        this.dragStart = null;
        this.dragAnchorId = null;
        this.dragShape = null;
        
        // Tool options
        this.toolOptions = {
            lineWidth: 0.2,
            fill: false,
            color: '#00b894'
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
            docTitle: document.getElementById('docTitle')
        };
        
        // Create toolbox
        this.toolbox = new Toolbox({
            onToolSelected: (tool) => this._onToolSelected(tool),
            onOptionsChanged: (opts) => this._onOptionsChanged(opts)
        });
        this.toolbox.appendTo(this.container);
        
        this._setupCallbacks();
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
        
        console.log('Schematic Editor initialized');
    }

    // ==================== Tool Handling ====================
    
    _onToolSelected(tool) {
        // Cancel any in-progress drawing
        this._cancelDrawing();
        
        this.currentTool = tool;
        
        // Update cursor
        const svg = this.viewport.svg;
        svg.style.cursor = tool === 'select' ? 'default' : 'crosshair';
    }
    
    _onOptionsChanged(options) {
        this.toolOptions = { ...this.toolOptions, ...options };
    }

    // ==================== Shape Management ====================
    
    addShape(shape) {
        this.shapes.push(shape);
        shape.render(this.viewport.scale);
        this.viewport.addContent(shape.element);
        this.fileManager.setDirty(true);
        return shape;
    }
    
    removeShape(shape) {
        const idx = this.shapes.indexOf(shape);
        if (idx !== -1) {
            this.shapes.splice(idx, 1);
            this.viewport.removeContent(shape.element);
            this.selection.deselect(shape);
            shape.destroy();
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
                    color: this.currentTool === 'wire' ? '#00b894' : opts.color,
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

    // ==================== Callbacks ====================

    _setupCallbacks() {
        let lastStatusUpdate = 0;
        const STATUS_THROTTLE = 50;
        
        this.viewport.onMouseMove = (world, snapped) => {
            // Update drawing preview and crosshair
            if (this.isDrawing) {
                this._updateDrawing(snapped);
                this._updateCrosshair(snapped);
            }
            
            // Update hover state and cursor (only in select mode when not panning/dragging)
            if (!this.viewport.isPanning && !this.isDragging && this.currentTool === 'select') {
                const hit = this.selection.hitTest(world);
                this.selection.setHovered(hit);
                
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
                this.renderShapes();
            }
            
            // Throttle status bar updates
            const now = performance.now();
            if (now - lastStatusUpdate > STATUS_THROTTLE) {
                lastStatusUpdate = now;
                const v = this.viewport;
                this.ui.cursorPos.textContent = `${v.formatValue(world.x)}, ${v.formatValue(world.y)} ${v.units}`;
                this.ui.gridSnap.textContent = `${v.formatValue(snapped.x)}, ${v.formatValue(snapped.y)} ${v.units}`;
            }
        };

        this.viewport.onViewChanged = (view) => {
            // Display zoom as percentage (500mm = 100%)
            const zoomPercent = Math.round(this.viewport.zoom * 100);
            this.ui.zoomLevel.textContent = `${zoomPercent}%`;
            
            const bounds = view.bounds;
            const v = this.viewport;
            this.ui.viewportInfo.textContent = 
                `${v.formatValue(bounds.maxX - bounds.minX)} × ${v.formatValue(bounds.maxY - bounds.minY)} ${v.units}`;
            
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
            
            if (this.currentTool === 'select') {
                // Check if clicking on an anchor of a selected shape
                const selectedShapes = this.selection.getSelection();
                for (const shape of selectedShapes) {
                    const anchorId = shape.hitTestAnchor(worldPos, this.viewport.scale);
                    if (anchorId) {
                        // Start anchor drag
                        this.isDragging = true;
                        this.dragMode = 'anchor';
                        this.dragStart = { ...snapped };
                        this.dragAnchorId = anchorId;
                        this.dragShape = shape;
                        e.preventDefault();
                        return;
                    }
                }
                
                // Check if clicking on a selected shape (for move)
                const hitShape = this.selection.hitTest(worldPos);
                if (hitShape && hitShape.selected) {
                    // Start move drag
                    this.isDragging = true;
                    this.dragMode = 'move';
                    this.dragStart = { ...snapped };
                    e.preventDefault();
                    return;
                }
                
                // Otherwise, handle as selection click (done in click event)
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
            }
        });
        
        svg.addEventListener('mouseup', (e) => {
            if (e.button !== 0) return;
            
            // End dragging
            if (this.isDragging) {
                this.isDragging = false;
                this.dragMode = null;
                this.dragStart = null;
                this.dragAnchorId = null;
                this.dragShape = null;
                // Don't return - let click handle selection if needed
            }
            
            if (this.viewport.isPanning) return;
            
            const rect = svg.getBoundingClientRect();
            const screenPos = {
                x: e.clientX - rect.left,
                y: e.clientY - rect.top
            };
            const worldPos = this.viewport.screenToWorld(screenPos);
            const snapped = this.viewport.getSnappedPosition(worldPos);
            
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
    }

    _bindKeyboardShortcuts() {
        window.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
            
            if (e.ctrlKey || e.metaKey) {
                switch (e.key.toLowerCase()) {
                    case 's':
                        e.preventDefault();
                        if (e.altKey) {
                            // Ctrl+Alt+S for Save As (changed from Ctrl+Shift+S)
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
                            this.history.redo();
                        } else {
                            this.history.undo();
                        }
                        break;
                    case 'y':
                        e.preventDefault();
                        this.history.redo();
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
                        if (this.isDrawing) {
                            this._cancelDrawing();
                        }
                        // Always return to select mode on Escape
                        if (this.currentTool !== 'select') {
                            this.toolbox.selectTool('select');
                        } else {
                            // Only clear selection if already in select mode and not drawing
                            this.selection.clearSelection();
                            this.renderShapes(true);
                        }
                        break;
                    case 'Delete':
                    case 'Backspace':
                        this._deleteSelected();
                        break;
                }
            }
        });
    }
    
    _deleteSelected() {
        const toDelete = this.selection.getSelection();
        if (toDelete.length === 0) return;
        
        this.selection.clearSelection();
        for (const shape of toDelete) {
            this.removeShape(shape);
        }
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
        
        this.viewport.fitToBounds(minX, minY, maxX, maxY, 30);
    }
    
    // ==================== File Operations ====================
    
    /**
     * Serialize document to JSON-compatible object
     */
    _serializeDocument() {
        return {
            version: '1.0',
            type: 'clearpcb-schematic',
            created: new Date().toISOString(),
            settings: {
                gridSize: this.viewport.gridSize,
                units: this.viewport.units
            },
            shapes: this.shapes.map(s => s.toJSON())
        };
    }
    
    /**
     * Load shapes from document data
     */
    _loadDocument(data) {
        // Clear existing shapes
        this._clearAllShapes();
        
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
        
        // Apply settings
        if (data.settings) {
            if (data.settings.gridSize) {
                this.viewport.setGridSize(data.settings.gridSize);
                if (this.ui.gridSize) {
                    this.ui.gridSize.value = data.settings.gridSize;
                }
            }
        }
        
        this.selection.setShapes(this.shapes);
        this.renderShapes(true);
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
        this.selection.setShapes(this.shapes);
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
     * Check for auto-saved content on startup
     */
    _checkAutoSave() {
        if (this.fileManager.hasAutoSave()) {
            const saved = this.fileManager.loadAutoSave();
            if (saved && saved.data && saved.data.shapes && saved.data.shapes.length > 0) {
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