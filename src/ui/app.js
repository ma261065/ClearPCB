/**
 * App.js - Main application entry point
 * 
 * Initializes ClearPCB with PixiJS-accelerated viewport.
 */

import { Viewport } from '../core/Viewport.js';
import { EventBus, Events, globalEventBus } from '../core/EventBus.js';
import { CommandHistory } from '../core/CommandHistory.js';

class EditorApp {
    constructor() {
        this.container = document.getElementById('canvasContainer');
        this.snapCursor = document.getElementById('snapCursor');
        this.viewport = new Viewport(this.container);
        this.eventBus = globalEventBus;
        this.history = new CommandHistory({
            onChange: (state) => this._onHistoryChange(state)
        });
        
        // Active editor mode
        this.mode = 'schematic';
        
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
        this._setupDemoContent();
        
        // Initial view
        this.viewport.resetView();
        
        console.log('ClearPCB initialized (PixiJS WebGL)');
    }

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
        this.ui.gridSize.addEventListener('change', (e) => {
            this.viewport.setGridSize(parseFloat(e.target.value));
        });

        this.ui.units.addEventListener('change', (e) => {
            this.viewport.setUnits(e.target.value);
        });

        this.ui.showOrigin.addEventListener('change', (e) => {
            this.viewport.setOriginVisible(e.target.checked);
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
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
            
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
    }

    _setupDemoContent() {
        const g = this.viewport.createGraphics();
        
        // PCB board outline (100mm x 80mm) - background
        g.beginFill(0x2d3436);
        g.drawRect(-50, -40, 100, 80);
        g.endFill();
        
        // Board outline stroke
        g.lineStyle(0.5, 0x636e72);
        g.drawRect(-50, -40, 100, 80);
        
        // Mounting holes
        g.beginFill(0xdfe6e9);
        g.drawCircle(-45, -35, 1.6);
        g.drawCircle(45, -35, 1.6);
        g.drawCircle(-45, 35, 1.6);
        g.drawCircle(45, 35, 1.6);
        g.endFill();
        
        // IC outline (DIP package)
        g.lineStyle(0.3, 0x95afc0);
        g.drawRect(-15, -8, 10, 16);
        // IC notch
        g.arc(-10, -8, 1.5, 0, Math.PI);
        
        // IC pins
        g.beginFill(0xff6b6b);
        g.lineStyle(0);
        [-6, -2, 2, 6].forEach(y => {
            g.drawCircle(-17, y, 0.6);
            g.drawCircle(-3, y, 0.6);
        });
        g.endFill();
        
        // Resistor
        g.beginFill(0x4ecdc4);
        g.drawRect(-3, -1, 6, 2);
        g.endFill();
        
        // Resistor pads
        g.beginFill(0xff6b6b);
        g.drawCircle(-5, 0, 0.8);
        g.drawCircle(5, 0, 0.8);
        g.endFill();
        
        // Resistor wires
        g.lineStyle(0.3, 0xffe66d);
        g.moveTo(-5, 0);
        g.lineTo(-3, 0);
        g.moveTo(3, 0);
        g.lineTo(5, 0);
        
        // Capacitor
        g.lineStyle(0.4, 0x4ecdc4);
        g.moveTo(15, -3);
        g.lineTo(15, 3);
        g.moveTo(17, -3);
        g.lineTo(17, 3);
        
        // Capacitor pads
        g.beginFill(0xff6b6b);
        g.lineStyle(0);
        g.drawCircle(12, 0, 0.8);
        g.drawCircle(20, 0, 0.8);
        g.endFill();
        
        // Capacitor wires
        g.lineStyle(0.3, 0xffe66d);
        g.moveTo(12, 0);
        g.lineTo(15, 0);
        g.moveTo(17, 0);
        g.lineTo(20, 0);
        
        // Traces
        g.lineStyle(0.5, 0x00b894);
        g.moveTo(-17, -6);
        g.lineTo(-25, -6);
        g.lineTo(-25, -20);
        g.lineTo(0, -20);
        g.lineTo(0, 0);
        g.lineTo(-5, 0);
        
        g.moveTo(5, 0);
        g.lineTo(10, 0);
        g.lineTo(10, 15);
        g.lineTo(-3, 15);
        g.lineTo(-3, 6);
        
        this.viewport.addContent(g);
        
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