/**
 * App.js - Main application entry point (SVG version)
 */

import { Viewport } from '../core/viewport.js';
import { EventBus, Events, globalEventBus } from '../core/eventbus.js';
import { CommandHistory } from '../core/commandhistory.js';
import { SelectionManager } from '../core/selectionmanager.js';
import { Line, Circle, Rect, Arc, Pad, Via, Polygon } from '../shapes/index.js';

class EditorApp {
    constructor() {
        this.container = document.getElementById('canvasContainer');
        this.snapCursor = document.getElementById('snapCursor');
        this.viewport = new Viewport(this.container);
        this.eventBus = globalEventBus;
        this.history = new CommandHistory({
            onChange: (state) => this._onHistoryChange(state)
        });
        
        // Shape management
        this.shapes = [];
        this.selection = new SelectionManager({
            onSelectionChanged: (shapes) => this._onSelectionChanged(shapes)
        });
        this.selection.setShapes(this.shapes);
        
        // Active editor mode
        this.mode = 'select';
        
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
        
        this._setupCallbacks();
        this._bindUIControls();
        this._bindKeyboardShortcuts();
        this._bindMouseEvents();
        this._setupDemoContent();
        
        // Initial view
        this.viewport.resetView();
        
        console.log('ClearPCB initialized (SVG)');
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

    // ==================== Callbacks ====================

    _setupCallbacks() {
        let lastStatusUpdate = 0;
        const STATUS_THROTTLE = 50;
        
        this.viewport.onMouseMove = (world, snapped) => {
            // Hide snap cursor during pan
            if (this.viewport.isPanning) {
                this.snapCursor.style.display = 'none';
            } else if (this.viewport.snapToGrid) {
                const screenPos = this.viewport.worldToScreen(snapped);
                this.snapCursor.style.transform = `translate(${screenPos.x - 10}px, ${screenPos.y - 10}px)`;
                this.snapCursor.style.display = 'block';
            } else {
                this.snapCursor.style.display = 'none';
            }
            
            // Update hover state
            if (!this.viewport.isPanning) {
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
            const zoomPercent = Math.round(this.viewport.zoom * 100);
            this.ui.zoomLevel.textContent = `${zoomPercent}%`;
            
            const bounds = view.bounds;
            const v = this.viewport;
            this.ui.viewportInfo.textContent = 
                `${v.formatValue(bounds.maxX - bounds.minX)} × ${v.formatValue(bounds.maxY - bounds.minY)} ${v.units}`;
            
            this.eventBus.emit(Events.VIEW_CHANGED, view);
        };
    }
    
    _onSelectionChanged(shapes) {
        console.log(`Selection: ${shapes.length} shape(s)`);
        this.renderShapes();
    }

    // ==================== Mouse Events ====================
    
    _bindMouseEvents() {
        const svg = this.viewport.svg;
        
        svg.addEventListener('click', (e) => {
            if (this.viewport.isPanning) return;
            
            const rect = svg.getBoundingClientRect();
            const screenPos = {
                x: e.clientX - rect.left,
                y: e.clientY - rect.top
            };
            const worldPos = this.viewport.screenToWorld(screenPos);
            
            this.selection.handleClick(worldPos, e.shiftKey);
            this.renderShapes();
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
            this.viewport.fitToContent();
        });

        document.getElementById('zoomIn').addEventListener('click', () => {
            const center = this.viewport.offset;
            this.viewport.zoomAt(center, 1.5);
        });

        document.getElementById('zoomOut').addEventListener('click', () => {
            const center = this.viewport.offset;
            this.viewport.zoomAt(center, 0.67);
        });

        document.getElementById('resetView').addEventListener('click', () => {
            this.viewport.resetView();
        });
    }

    _bindKeyboardShortcuts() {
        window.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
            
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
                        this.selection.clearSelection();
                        this.renderShapes();
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

    _onHistoryChange(state) {
        this.eventBus.emit(Events.HISTORY_CHANGED, state);
    }

    // ==================== Demo Content ====================

    _setupDemoContent() {
        // Board outline
        this.addShape(new Rect({
            x: -50, y: -40, width: 100, height: 80,
            color: '#636e72',
            fill: true,
            fillColor: '#2d3436',
            fillAlpha: 1,
            lineWidth: 0.5,
            layer: 'board'
        }));
        
        // Mounting holes
        [[-45, -35], [45, -35], [-45, 35], [45, 35]].forEach(([x, y]) => {
            this.addShape(new Circle({
                x, y, radius: 1.6,
                color: '#dfe6e9',
                fill: true,
                fillAlpha: 1,
                lineWidth: 0,
                layer: 'holes'
            }));
        });
        
        // IC package outline
        this.addShape(new Rect({
            x: -15, y: -8, width: 10, height: 16,
            color: '#95afc0',
            lineWidth: 0.3,
            layer: 'silkscreen'
        }));
        
        // IC pads
        [-6, -2, 2, 6].forEach(y => {
            this.addShape(new Pad({
                x: -17, y, width: 1.2, height: 1.2,
                shape: 'circle',
                color: '#ff6b6b',
                layer: 'top'
            }));
            this.addShape(new Pad({
                x: -3, y, width: 1.2, height: 1.2,
                shape: 'circle',
                color: '#ff6b6b',
                layer: 'top'
            }));
        });
        
        // Resistor body
        this.addShape(new Rect({
            x: -3, y: -1, width: 6, height: 2,
            color: '#4ecdc4',
            fill: true,
            fillAlpha: 1,
            lineWidth: 0,
            layer: 'top'
        }));
        
        // Resistor pads
        this.addShape(new Pad({
            x: -5, y: 0, width: 1.6, height: 1.6,
            shape: 'circle',
            color: '#ff6b6b',
            layer: 'top'
        }));
        this.addShape(new Pad({
            x: 5, y: 0, width: 1.6, height: 1.6,
            shape: 'circle',
            color: '#ff6b6b',
            layer: 'top'
        }));
        
        // Capacitor
        this.addShape(new Line({
            x1: 15, y1: -3, x2: 15, y2: 3,
            color: '#4ecdc4',
            lineWidth: 0.4,
            layer: 'top'
        }));
        this.addShape(new Line({
            x1: 17, y1: -3, x2: 17, y2: 3,
            color: '#4ecdc4',
            lineWidth: 0.4,
            layer: 'top'
        }));
        
        // Capacitor pads
        this.addShape(new Pad({
            x: 12, y: 0, width: 1.6, height: 1.6,
            shape: 'circle',
            color: '#ff6b6b',
            layer: 'top'
        }));
        this.addShape(new Pad({
            x: 20, y: 0, width: 1.6, height: 1.6,
            shape: 'circle',
            color: '#ff6b6b',
            layer: 'top'
        }));
        
        // Traces
        this.addShape(new Polygon({
            points: [
                { x: -17, y: -6 },
                { x: -25, y: -6 },
                { x: -25, y: -20 },
                { x: 0, y: -20 },
                { x: 0, y: 0 },
                { x: -5, y: 0 }
            ],
            color: '#00b894',
            lineWidth: 0.5,
            fill: false,
            closed: false,
            layer: 'top'
        }));
        
        this.addShape(new Polygon({
            points: [
                { x: 5, y: 0 },
                { x: 10, y: 0 },
                { x: 10, y: 15 },
                { x: -3, y: 15 },
                { x: -3, y: 6 }
            ],
            color: '#00b894',
            lineWidth: 0.5,
            fill: false,
            closed: false,
            layer: 'top'
        }));
        
        // Vias
        this.addShape(new Via({
            x: 0, y: -20,
            diameter: 1.0,
            hole: 0.5,
            layer: 'top'
        }));
        
        this.addShape(new Via({
            x: 10, y: 15,
            diameter: 1.0,
            hole: 0.5,
            layer: 'top'
        }));
        
        // Arc example
        this.addShape(new Arc({
            x: 30, y: 0,
            radius: 8,
            startAngle: -Math.PI / 2,
            endAngle: Math.PI / 2,
            color: '#9b59b6',
            lineWidth: 0.4,
            layer: 'top'
        }));
        
        // Override fitToContent
        this.viewport.fitToContent = () => {
            this.viewport.fitToBounds(-55, -45, 55, 45);
        };
    }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.app = new EditorApp();
});