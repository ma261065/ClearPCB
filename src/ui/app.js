/**
 * App.js - Main application entry point
 * 
 * Initializes ClearPCB with viewport, tools, and UI.
 */

import { Viewport } from '../core/Viewport.js';
import { EventBus, Events, globalEventBus } from '../core/EventBus.js';
import { CommandHistory } from '../core/CommandHistory.js';

class EditorApp {
    constructor() {
        this.canvas = document.getElementById('editorCanvas');
        this.viewport = new Viewport(this.canvas);
        this.eventBus = globalEventBus;
        this.history = new CommandHistory({
            onChange: (state) => this._onHistoryChange(state)
        });
        
        // Active editor mode
        this.mode = 'schematic'; // 'schematic' or 'pcb'
        
        // UI elements
        this.ui = {
            cursorPos: document.getElementById('cursorPos'),
            gridSnap: document.getElementById('gridSnap'),
            zoomLevel: document.getElementById('zoomLevel'),
            viewportInfo: document.getElementById('viewportInfo'),
            gridSize: document.getElementById('gridSize'),
            units: document.getElementById('units'),
            showOrigin: document.getElementById('showOrigin'),
            showGrid: document.getElementById('showGrid'),
            snapToGrid: document.getElementById('snapToGrid')
        };
        
        this._setupCallbacks();
        this._bindUIControls();
        this._bindKeyboardShortcuts();
        this._startRenderLoop();
        
        // Demo: Draw some sample content to show the viewport working
        this._setupDemoContent();
        
        // Initial view
        this.viewport.resetView();
        
        console.log('ClearPCB initialized');
    }

    _setupCallbacks() {
        // Update status bar when mouse moves
        this.viewport.onMouseMove = (world, snapped) => {
            const v = this.viewport;
            this.ui.cursorPos.textContent = `${v.formatValue(world.x)}, ${v.formatValue(world.y)} ${v.units}`;
            this.ui.gridSnap.textContent = `${v.formatValue(snapped.x)}, ${v.formatValue(snapped.y)} ${v.units}`;
        };

        // Update status bar when view changes
        this.viewport.onViewChanged = (view) => {
            const zoomPercent = Math.round(this.viewport.zoom / 50 * 100);
            this.ui.zoomLevel.textContent = `${zoomPercent}%`;
            
            const bounds = view.bounds;
            const v = this.viewport;
            this.ui.viewportInfo.textContent = 
                `${v.formatValue(bounds.maxX - bounds.minX)} × ${v.formatValue(bounds.maxY - bounds.minY)} ${v.units}`;
            
            this.eventBus.emit(Events.VIEW_CHANGED, view);
        };
    }

    _bindUIControls() {
        // Grid size selector
        this.ui.gridSize.addEventListener('change', (e) => {
            this.viewport.setGridSize(parseFloat(e.target.value));
        });

        // Units selector
        this.ui.units.addEventListener('change', (e) => {
            this.viewport.setUnits(e.target.value);
        });

        // Origin visibility
        this.ui.showOrigin.addEventListener('change', (e) => {
            this.viewport.showOrigin = e.target.checked;
            this.viewport.requestRender();
        });

        // Grid visibility
        this.ui.showGrid.addEventListener('change', (e) => {
            this.viewport.gridVisible = e.target.checked;
            this.viewport.requestRender();
        });

        // Snap to grid
        this.ui.snapToGrid.addEventListener('change', (e) => {
            this.viewport.snapToGrid = e.target.checked;
        });

        // Zoom buttons
        document.getElementById('zoomFit').addEventListener('click', () => {
            this.viewport.fitToContent();
        });

        document.getElementById('zoomIn').addEventListener('click', () => {
            this.viewport.zoomAt(this.viewport.offset, 1.5);
        });

        document.getElementById('zoomOut').addEventListener('click', () => {
            this.viewport.zoomAt(this.viewport.offset, 0.67);
        });

        document.getElementById('resetView').addEventListener('click', () => {
            this.viewport.resetView();
        });
    }

    _bindKeyboardShortcuts() {
        window.addEventListener('keydown', (e) => {
            // Don't capture if in an input
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
            
            // Undo/Redo
            if (e.ctrlKey || e.metaKey) {
                if (e.key === 'z' && !e.shiftKey) {
                    e.preventDefault();
                    this.history.undo();
                } else if ((e.key === 'z' && e.shiftKey) || e.key === 'y') {
                    e.preventDefault();
                    this.history.redo();
                }
            }
        });
    }

    _onHistoryChange(state) {
        this.eventBus.emit(Events.HISTORY_CHANGED, state);
        this.viewport.requestRender();
    }

    _startRenderLoop() {
        const loop = () => {
            // Render viewport base (grid, origin)
            this.viewport.render();
            
            // Render demo content on top
            this._renderDemoContent();
            
            requestAnimationFrame(loop);
        };
        loop();
    }

    /**
     * Demo content to visualize the coordinate system
     */
    _setupDemoContent() {
        // Some demo shapes in world coordinates (mm)
        this.demoShapes = [
            // A resistor-like symbol at origin
            { type: 'rect', x: -3, y: -1, w: 6, h: 2, color: '#4ecdc4' },
            
            // Connection points (pads)
            { type: 'circle', x: -5, y: 0, r: 0.8, color: '#ff6b6b' },
            { type: 'circle', x: 5, y: 0, r: 0.8, color: '#ff6b6b' },
            
            // Wires
            { type: 'line', x1: -5, y1: 0, x2: -3, y2: 0, color: '#ffe66d', width: 0.3 },
            { type: 'line', x1: 3, y1: 0, x2: 5, y2: 0, color: '#ffe66d', width: 0.3 },
            
            // A capacitor nearby
            { type: 'line', x1: 15, y1: -3, x2: 15, y2: 3, color: '#4ecdc4', width: 0.4 },
            { type: 'line', x1: 17, y1: -3, x2: 17, y2: 3, color: '#4ecdc4', width: 0.4 },
            { type: 'circle', x: 12, y: 0, r: 0.8, color: '#ff6b6b' },
            { type: 'circle', x: 20, y: 0, r: 0.8, color: '#ff6b6b' },
            { type: 'line', x1: 12, y1: 0, x2: 15, y2: 0, color: '#ffe66d', width: 0.3 },
            { type: 'line', x1: 17, y1: 0, x2: 20, y2: 0, color: '#ffe66d', width: 0.3 },
            
            // A simple IC outline (DIP package footprint)
            { type: 'rect', x: -15, y: -8, w: 10, h: 16, color: '#95afc0', fill: false },
            // IC notch
            { type: 'arc', x: -10, y: -8, r: 1.5, start: 0, end: Math.PI, color: '#95afc0' },
            
            // IC pins
            { type: 'circle', x: -17, y: -6, r: 0.6, color: '#ff6b6b' },
            { type: 'circle', x: -17, y: -2, r: 0.6, color: '#ff6b6b' },
            { type: 'circle', x: -17, y: 2, r: 0.6, color: '#ff6b6b' },
            { type: 'circle', x: -17, y: 6, r: 0.6, color: '#ff6b6b' },
            { type: 'circle', x: -3, y: -6, r: 0.6, color: '#ff6b6b' },
            { type: 'circle', x: -3, y: -2, r: 0.6, color: '#ff6b6b' },
            { type: 'circle', x: -3, y: 2, r: 0.6, color: '#ff6b6b' },
            { type: 'circle', x: -3, y: 6, r: 0.6, color: '#ff6b6b' },
            
            // PCB board outline (100mm x 80mm)
            { type: 'rect', x: -50, y: -40, w: 100, h: 80, color: '#2d3436', fill: true, layer: 'back' },
            { type: 'rect', x: -50, y: -40, w: 100, h: 80, color: '#636e72', fill: false },
            
            // Mounting holes
            { type: 'circle', x: -45, y: -35, r: 1.6, color: '#dfe6e9' },
            { type: 'circle', x: 45, y: -35, r: 1.6, color: '#dfe6e9' },
            { type: 'circle', x: -45, y: 35, r: 1.6, color: '#dfe6e9' },
            { type: 'circle', x: 45, y: 35, r: 1.6, color: '#dfe6e9' },
            
            // Some traces
            { type: 'polyline', points: [
                { x: -17, y: -6 }, { x: -25, y: -6 }, { x: -25, y: -20 }, { x: 0, y: -20 }, { x: 0, y: 0 }, { x: -5, y: 0 }
            ], color: '#00b894', width: 0.5 },
            
            { type: 'polyline', points: [
                { x: 5, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 15 }, { x: -3, y: 15 }, { x: -3, y: 6 }
            ], color: '#00b894', width: 0.5 },
        ];
        
        // Override fitToContent to use our demo bounds
        this.viewport.fitToContent = () => {
            this.viewport.fitToBounds(-55, -45, 55, 45);
        };
    }

    _renderDemoContent() {
        const ctx = this.viewport.ctx;
        const v = this.viewport;
        
        // Sort by layer (back first)
        const backShapes = this.demoShapes.filter(s => s.layer === 'back');
        const frontShapes = this.demoShapes.filter(s => s.layer !== 'back');
        
        [...backShapes, ...frontShapes].forEach(shape => {
            ctx.strokeStyle = shape.color;
            ctx.fillStyle = shape.color;
            ctx.lineWidth = shape.width ? shape.width * v.zoom : 2;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            
            switch (shape.type) {
                case 'rect': {
                    const tl = v.worldToScreen({ x: shape.x, y: shape.y });
                    const w = shape.w * v.zoom;
                    const h = shape.h * v.zoom;
                    if (shape.fill !== false) {
                        ctx.fillRect(tl.x, tl.y, w, h);
                    } else {
                        ctx.strokeRect(tl.x, tl.y, w, h);
                    }
                    break;
                }
                
                case 'circle': {
                    const c = v.worldToScreen({ x: shape.x, y: shape.y });
                    const r = shape.r * v.zoom;
                    ctx.beginPath();
                    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
                    ctx.fill();
                    break;
                }
                
                case 'line': {
                    const p1 = v.worldToScreen({ x: shape.x1, y: shape.y1 });
                    const p2 = v.worldToScreen({ x: shape.x2, y: shape.y2 });
                    ctx.beginPath();
                    ctx.moveTo(p1.x, p1.y);
                    ctx.lineTo(p2.x, p2.y);
                    ctx.stroke();
                    break;
                }
                
                case 'polyline': {
                    if (shape.points.length < 2) break;
                    ctx.beginPath();
                    const first = v.worldToScreen(shape.points[0]);
                    ctx.moveTo(first.x, first.y);
                    for (let i = 1; i < shape.points.length; i++) {
                        const p = v.worldToScreen(shape.points[i]);
                        ctx.lineTo(p.x, p.y);
                    }
                    ctx.stroke();
                    break;
                }
                
                case 'arc': {
                    const c = v.worldToScreen({ x: shape.x, y: shape.y });
                    const r = shape.r * v.zoom;
                    ctx.beginPath();
                    ctx.arc(c.x, c.y, r, shape.start, shape.end);
                    ctx.stroke();
                    break;
                }
            }
        });
        
        // Draw snap cursor indicator
        if (this.viewport.snapToGrid) {
            const snapped = v.getSnappedPosition(v.currentMouseWorld);
            const screenPos = v.worldToScreen(snapped);
            
            ctx.strokeStyle = '#e94560';
            ctx.lineWidth = 1;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(screenPos.x - 8, screenPos.y);
            ctx.lineTo(screenPos.x + 8, screenPos.y);
            ctx.moveTo(screenPos.x, screenPos.y - 8);
            ctx.lineTo(screenPos.x, screenPos.y + 8);
            ctx.stroke();
            ctx.setLineDash([]);
        }
    }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.app = new EditorApp();
});