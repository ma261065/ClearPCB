/**
 * SchematicApp.js - Schematic Editor Application
 */

import { Viewport } from '../core/Viewport.js';
import { EventBus, Events, globalEventBus } from '../core/EventBus.js';
import { CommandHistory } from '../core/CommandHistory.js';
import { SelectionManager } from '../core/SelectionManager.js';
import { Toolbox } from './Toolbox.js';
import { Line, Circle, Rect, Arc, Polygon } from '../shapes/index.js';

class SchematicApp {
    constructor() {
        this.container = document.getElementById('canvasContainer');
        this.viewport = new Viewport(this.container);
        this.eventBus = globalEventBus;
        this.history = new CommandHistory();
        
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
            snapToGrid: document.getElementById('snapToGrid')
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
        
        console.log('Schematic Editor initialized');
    }

    // ==================== Tool Handling ====================
    
    _onToolSelected(tool) {
        // Cancel any in-progress drawing
        this._cancelDrawing();
        
        this.currentTool = tool;
        
        // Update cursor
        const svg = this.viewport.svg;
        svg.style.cursor = tool === 'select' ? 'crosshair' : 'crosshair';
    }
    
    _onOptionsChanged(options) {
        this.toolOptions = { ...this.toolOptions, ...options };
    }

    // ==================== Shape Management ====================
    
    addShape(shape) {
        this.shapes.push(shape);
        shape.render(this.viewport.scale);
        this.viewport.addContent(shape.element);
        return shape;
    }
    
    removeShape(shape) {
        const idx = this.shapes.indexOf(shape);
        if (idx !== -1) {
            this.shapes.splice(idx, 1);
            this.viewport.removeContent(shape.element);
            this.selection.deselect(shape);
            shape.destroy();
        }
    }
    
    renderShapes() {
        for (const shape of this.shapes) {
            if (shape._dirty || shape.selected || shape.hovered) {
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
        this.viewport.svg.style.cursor = 'default';
    }
    
    _createPreview() {
        // Create SVG element for preview
        this.previewElement = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        this.previewElement.setAttribute('class', 'preview');
        this.previewElement.style.opacity = '0.6';
        this.previewElement.style.pointerEvents = 'none';
        this.viewport.contentLayer.appendChild(this.previewElement);
    }
    
    _updatePreview() {
        if (!this.previewElement || !this.drawStart || !this.drawCurrent) return;
        
        const start = this.drawStart;
        const end = this.drawCurrent;
        const opts = this.toolOptions;
        
        let svg = '';
        
        switch (this.currentTool) {
            case 'line':
            case 'wire':
                svg = `<line x1="${start.x}" y1="${start.y}" x2="${end.x}" y2="${end.y}" 
                        stroke="${opts.color}" stroke-width="${opts.lineWidth}" stroke-linecap="round"/>`;
                break;
                
            case 'rect':
                const x = Math.min(start.x, end.x);
                const y = Math.min(start.y, end.y);
                const w = Math.abs(end.x - start.x);
                const h = Math.abs(end.y - start.y);
                svg = `<rect x="${x}" y="${y}" width="${w}" height="${h}" 
                        stroke="${opts.color}" stroke-width="${opts.lineWidth}" 
                        fill="${opts.fill ? opts.color : 'none'}" fill-opacity="0.3"/>`;
                break;
                
            case 'circle':
                const radius = Math.hypot(end.x - start.x, end.y - start.y);
                svg = `<circle cx="${start.x}" cy="${start.y}" r="${radius}" 
                        stroke="${opts.color}" stroke-width="${opts.lineWidth}" 
                        fill="${opts.fill ? opts.color : 'none'}" fill-opacity="0.3"/>`;
                break;
                
            case 'arc':
                const arcRadius = Math.hypot(end.x - start.x, end.y - start.y);
                const endAngle = Math.atan2(end.y - start.y, end.x - start.x);
                const arcEndX = start.x + arcRadius * Math.cos(endAngle);
                const arcEndY = start.y + arcRadius * Math.sin(endAngle);
                const largeArc = endAngle > Math.PI ? 1 : 0;
                svg = `<path d="M ${start.x + arcRadius} ${start.y} A ${arcRadius} ${arcRadius} 0 ${largeArc} 1 ${arcEndX} ${arcEndY}" 
                        stroke="${opts.color}" stroke-width="${opts.lineWidth}" fill="none" stroke-linecap="round"/>`;
                break;
                
            case 'polygon':
                if (this.polygonPoints.length > 0) {
                    const points = [...this.polygonPoints, end];
                    const pointsStr = points.map(p => `${p.x},${p.y}`).join(' ');
                    svg = `<polyline points="${pointsStr}" 
                            stroke="${opts.color}" stroke-width="${opts.lineWidth}" 
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
            
            // Update hover state (only in select mode when not panning)
            if (!this.viewport.isPanning && this.currentTool === 'select') {
                const hit = this.selection.hitTest(world);
                this.selection.setHovered(hit);
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
        this.renderShapes();
    }

    // ==================== Mouse Events ====================
    
    _bindMouseEvents() {
        const svg = this.viewport.svg;
        
        svg.addEventListener('mousedown', (e) => {
            // Ignore right-click (used for pan)
            if (e.button !== 0) return;
            if (this.viewport.isPanning) return;
            
            const rect = svg.getBoundingClientRect();
            const screenPos = {
                x: e.clientX - rect.left,
                y: e.clientY - rect.top
            };
            const worldPos = this.viewport.screenToWorld(screenPos);
            const snapped = this.viewport.getSnappedPosition(worldPos);
            
            if (this.currentTool === 'select') {
                // Selection mode - handled by click
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
        
        svg.addEventListener('mouseup', (e) => {
            if (e.button !== 0) return;
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
            
            const rect = svg.getBoundingClientRect();
            const screenPos = {
                x: e.clientX - rect.left,
                y: e.clientY - rect.top
            };
            const worldPos = this.viewport.screenToWorld(screenPos);
            
            if (this.currentTool === 'select') {
                this.selection.handleClick(worldPos, e.shiftKey);
                this.renderShapes();
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
    }

    _bindKeyboardShortcuts() {
        window.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
            
            if (e.ctrlKey || e.metaKey) {
                if (e.key === 'z' && !e.shiftKey) {
                    e.preventDefault();
                    this.history.undo();
                } else if ((e.key === 'z' && e.shiftKey) || e.key === 'y') {
                    e.preventDefault();
                    this.history.redo();
                } else if (e.key === 'a') {
                    e.preventDefault();
                    this.selection.selectAll();
                    this.renderShapes();
                }
            } else {
                switch (e.key) {
                    case 'Escape':
                        if (this.isDrawing) {
                            this._cancelDrawing();
                        } else {
                            this.selection.clearSelection();
                            this.renderShapes();
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
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.app = new SchematicApp();
});