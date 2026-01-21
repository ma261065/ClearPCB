/**
 * Viewport - WebGL-accelerated viewport using PixiJS
 * 
 * Pan and zoom are instant because they just change the world container's transform.
 * No re-rendering of geometry needed.
 */

export class Viewport {
    constructor(container) {
        this.container = container;
        
        // Create PixiJS application with optimized settings
        this.app = new PIXI.Application({
            resizeTo: container,
            backgroundColor: 0x000000,  // Black like EasyEDA
            antialias: false,
            resolution: window.devicePixelRatio || 1,
            autoDensity: true,
            powerPreference: 'high-performance',
        });
        container.appendChild(this.app.view);
        
        // Log renderer type
        console.log('PixiJS Renderer:', this.app.renderer.constructor.name);
        
        // World container - all content goes here
        // Pan/zoom transforms this container, not individual objects
        this.world = new PIXI.Container();
        this.app.stage.addChild(this.world);
        
        // Layers within world (for content that transforms with pan/zoom)
        this.gridLayer = new PIXI.Container();
        this.contentLayer = new PIXI.Container();
        this.originLayer = new PIXI.Container();
        this.world.addChild(this.gridLayer);
        this.world.addChild(this.contentLayer);
        this.world.addChild(this.originLayer);
        
        // Ruler layer (screen space, on top of everything)
        this.rulerLayer = new PIXI.Container();
        this.app.stage.addChild(this.rulerLayer);
        this.rulerSize = 25; // pixels
        this.showRulers = true;
        
        // View state
        // At 100% zoom, viewport shows 500mm width
        this.baseWidth = 500; // mm visible at 100% zoom
        this.scale = 1; // Will be set properly in resetView
        this.offset = { x: 0, y: 0 };  // World coords at center
        
        // Constraints (zoom range: 5% to 5000%)
        this.minZoom = 0.05;
        this.maxZoom = 50;
        
        // Grid
        this.gridSize = 1;
        this.gridVisible = true;
        this.gridStyle = 'lines'; // 'lines' or 'dots'
        this.showOrigin = true;
        
        // Snapping
        this.snapToGrid = true;
        
        // Units
        this.units = 'mm';
        this.unitConversions = {
            mm: 1,
            mil: 1 / 0.0254,
            inch: 1 / 25.4
        };
        
        // Interaction state
        this.isPanning = false;
        this.panStart = { x: 0, y: 0 };
        this.panStartOffset = { x: 0, y: 0 };
        this.currentMouseWorld = { x: 0, y: 0 };
        
        // Callbacks
        this.onViewChanged = null;
        this.onMouseMove = null;
        
        // Setup
        this._updateTransform();
        this._createGrid();
        this._createOrigin();
        this._createRulers();
        this._bindEvents();
        
        // Handle resize
        window.addEventListener('resize', () => {
            this._updateTransform();
            this._createGrid();
            this._createRulers();
        });
    }
    
    get width() {
        return this.app.screen.width;
    }
    
    get height() {
        return this.app.screen.height;
    }
    
    get zoom() {
        // Returns zoom as a multiplier (1.0 = 100%)
        const baseScale = this.width / this.baseWidth;
        return this.scale / baseScale;
    }
    
    set zoom(value) {
        const baseScale = this.width / this.baseWidth;
        this.scale = value * baseScale;
    }

    // ==================== Transform Management ====================
    
    _updateTransform() {
        // Position world container so that this.offset is at screen center
        this.world.x = this.width / 2 - this.offset.x * this.scale;
        this.world.y = this.height / 2 - this.offset.y * this.scale;
        this.world.scale.set(this.scale);
    }

    // ==================== Coordinate Transforms ====================

    worldToScreen(world) {
        return {
            x: (world.x - this.offset.x) * this.scale + this.width / 2,
            y: (world.y - this.offset.y) * this.scale + this.height / 2
        };
    }

    screenToWorld(screen) {
        return {
            x: (screen.x - this.width / 2) / this.scale + this.offset.x,
            y: (screen.y - this.height / 2) / this.scale + this.offset.y
        };
    }

    getSnappedPosition(world) {
        if (!this.snapToGrid || this.gridSize <= 0) return { ...world };
        return {
            x: Math.round(world.x / this.gridSize) * this.gridSize,
            y: Math.round(world.y / this.gridSize) * this.gridSize
        };
    }

    // ==================== View Control ====================

    pan(dx, dy) {
        this.offset.x += dx;
        this.offset.y += dy;
        this._updateTransform();
        this._notifyViewChanged();
    }

    zoomAt(worldPoint, factor) {
        const baseScale = this.width / this.baseWidth;
        const minScale = baseScale * this.minZoom;
        const maxScale = baseScale * this.maxZoom;
        const newScale = Math.max(minScale, Math.min(maxScale, this.scale * factor));
        
        if (newScale !== this.scale) {
            const actualFactor = newScale / this.scale;
            this.offset.x = worldPoint.x - (worldPoint.x - this.offset.x) / actualFactor;
            this.offset.y = worldPoint.y - (worldPoint.y - this.offset.y) / actualFactor;
            this.scale = newScale;
            this._updateTransform();
            this._createGrid();
            this._notifyViewChanged();
        }
    }

    resetView() {
        this.offset = { x: 0, y: 0 };
        // At 100% zoom, show baseWidth (500mm) across viewport
        this.scale = this.width / this.baseWidth;
        this._updateTransform();
        this._createGrid();
        this._notifyViewChanged();
    }

    fitToBounds(minX, minY, maxX, maxY, padding = 50) {
        const contentWidth = maxX - minX;
        const contentHeight = maxY - minY;
        
        if (contentWidth <= 0 || contentHeight <= 0) {
            this.resetView();
            return;
        }
        
        const availableWidth = this.width - padding * 2;
        const availableHeight = this.height - padding * 2;
        
        const scaleX = availableWidth / contentWidth;
        const scaleY = availableHeight / contentHeight;
        
        const baseScale = this.width / this.baseWidth;
        const minScale = baseScale * this.minZoom;
        const maxScale = baseScale * this.maxZoom;
        
        this.scale = Math.min(scaleX, scaleY);
        this.scale = Math.max(minScale, Math.min(maxScale, this.scale));
        
        this.offset.x = (minX + maxX) / 2;
        this.offset.y = (minY + maxY) / 2;
        
        this._updateTransform();
        this._createGrid();
        this._notifyViewChanged();
    }

    fitToContent() {
        this.fitToBounds(-50, -50, 50, 50);
    }

    getVisibleBounds() {
        const topLeft = this.screenToWorld({ x: 0, y: 0 });
        const bottomRight = this.screenToWorld({ x: this.width, y: this.height });
        return {
            minX: topLeft.x,
            minY: topLeft.y,
            maxX: bottomRight.x,
            maxY: bottomRight.y
        };
    }

    _notifyViewChanged() {
        this._createRulers();
        if (this.onViewChanged) {
            this.onViewChanged({
                offset: { ...this.offset },
                zoom: this.scale,
                bounds: this.getVisibleBounds()
            });
        }
    }

    // ==================== Grid ====================

    setGridSize(size) {
        this.gridSize = Math.max(0.01, size);
        this._createGrid();
    }

    _createGrid() {
        // Remove old grid
        this.gridLayer.removeChildren();
        
        if (!this.gridVisible) return;
        
        // Get visible bounds with margin for panning
        const bounds = this.getVisibleBounds();
        const viewWidth = bounds.maxX - bounds.minX;
        const viewHeight = bounds.maxY - bounds.minY;
        const margin = Math.max(viewWidth, viewHeight);
        
        // Minimum screen pixels between grid lines for visibility
        const minPixelSpacing = 8;
        const minWorldSpacing = minPixelSpacing / this.scale;
        
        // Find display spacing - smallest multiple of gridSize that's visible
        let gridSpacing = this.gridSize;
        while (gridSpacing < minWorldSpacing) {
            gridSpacing *= 10; // Jump by factors of 10
        }
        
        // Calculate index range
        const startXi = Math.floor((bounds.minX - margin) / gridSpacing);
        const endXi = Math.ceil((bounds.maxX + margin) / gridSpacing);
        const startYi = Math.floor((bounds.minY - margin) / gridSpacing);
        const endYi = Math.ceil((bounds.maxY + margin) / gridSpacing);
        
        // World extent
        const minY = startYi * gridSpacing;
        const maxY = endYi * gridSpacing;
        const minX = startXi * gridSpacing;
        const maxX = endXi * gridSpacing;
        
        const pxInWorld = 1 / this.scale;
        
        if (this.gridStyle === 'dots') {
            // Dot grid
            const dots = new PIXI.Graphics();
            dots.beginFill(0x262626);
            
            const dotSize = pxInWorld * 1.5;
            for (let xi = startXi; xi <= endXi; xi++) {
                for (let yi = startYi; yi <= endYi; yi++) {
                    const x = xi * gridSpacing;
                    const y = yi * gridSpacing;
                    dots.drawRect(x - dotSize/2, y - dotSize/2, dotSize, dotSize);
                }
            }
            dots.endFill();
            this.gridLayer.addChild(dots);
        } else {
            // Line grid
            const grid = new PIXI.Graphics();
            grid.lineStyle({
                width: pxInWorld,
                color: 0x262626,
                alignment: 0.5,
                native: true
            });
            
            // Vertical lines (skip x=0)
            for (let i = startXi; i <= endXi; i++) {
                if (i === 0) continue;
                const x = i * gridSpacing;
                grid.moveTo(x, minY);
                grid.lineTo(x, maxY);
            }
            // Horizontal lines (skip y=0)
            for (let i = startYi; i <= endYi; i++) {
                if (i === 0) continue;
                const y = i * gridSpacing;
                grid.moveTo(minX, y);
                grid.lineTo(maxX, y);
            }
            
            this.gridLayer.addChild(grid);
        }
        
        // Axis lines (highlighted: #828282)
        const axes = new PIXI.Graphics();
        axes.lineStyle({
            width: pxInWorld,
            color: 0x828282,
            alignment: 0.5,
            native: true
        });
        
        // X axis (y=0)
        axes.moveTo(minX, 0);
        axes.lineTo(maxX, 0);
        // Y axis (x=0)
        axes.moveTo(0, minY);
        axes.lineTo(0, maxY);
        
        this.gridLayer.addChild(axes);
    }
    
    setGridStyle(style) {
        if (style === 'lines' || style === 'dots') {
            this.gridStyle = style;
            this._createGrid();
        }
    }
    
    _updateGridOffset() {
        // Not needed
    }

    _createOrigin() {
        this.originLayer.removeChildren();
        // Origin is now shown via highlighted axes in grid
    }
    
    _createRulers() {
        this.rulerLayer.removeChildren();
        
        if (!this.showRulers) return;
        
        const rs = this.rulerSize;
        const w = this.width;
        const h = this.height;
        
        // Ruler backgrounds
        const bg = new PIXI.Graphics();
        bg.beginFill(0x1a1a1a);
        bg.drawRect(0, 0, w, rs);       // Top ruler
        bg.drawRect(0, rs, rs, h - rs); // Left ruler
        bg.drawRect(0, 0, rs, rs);      // Corner
        bg.endFill();
        this.rulerLayer.addChild(bg);
        
        // Calculate tick spacing based on zoom
        // We want roughly 50-100 pixels between major ticks
        const pixelsPerMm = this.scale;
        const targetPixels = 80;
        const targetMm = targetPixels / pixelsPerMm;
        
        // Find nice round number for tick spacing
        const niceNumbers = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
        let tickSpacing = 1;
        for (const n of niceNumbers) {
            if (n >= targetMm) {
                tickSpacing = n;
                break;
            }
        }
        
        // Debug: Show grid info in corner
        const bounds = this.getVisibleBounds();
        const viewWidth = Math.round(bounds.maxX - bounds.minX);
        const debugText = new PIXI.Text(`${viewWidth}mm`, {
            fontSize: 9,
            fill: 0x888888,
            fontFamily: 'monospace'
        });
        debugText.x = 2;
        debugText.y = 8;
        this.rulerLayer.addChild(debugText);
        
        // Get visible world bounds
        
        // Draw ticks and labels
        const ticks = new PIXI.Graphics();
        ticks.lineStyle(1, 0x666666);
        
        // Top ruler (X axis)
        const startX = Math.floor(bounds.minX / tickSpacing) * tickSpacing;
        const endX = Math.ceil(bounds.maxX / tickSpacing) * tickSpacing;
        
        for (let worldX = startX; worldX <= endX; worldX += tickSpacing) {
            const screenX = this.worldToScreen({ x: worldX, y: 0 }).x;
            if (screenX < rs || screenX > w) continue;
            
            // Major tick
            ticks.moveTo(screenX, rs);
            ticks.lineTo(screenX, rs - 8);
            
            // Label
            const label = new PIXI.Text(worldX.toString(), {
                fontSize: 10,
                fill: 0x888888,
                fontFamily: 'monospace'
            });
            label.x = screenX + 2;
            label.y = 2;
            this.rulerLayer.addChild(label);
            
            // Minor ticks (5 divisions)
            for (let i = 1; i < 5; i++) {
                const minorX = worldX + (tickSpacing / 5) * i;
                const minorScreenX = this.worldToScreen({ x: minorX, y: 0 }).x;
                if (minorScreenX > rs && minorScreenX < w) {
                    ticks.moveTo(minorScreenX, rs);
                    ticks.lineTo(minorScreenX, rs - 4);
                }
            }
        }
        
        // Left ruler (Y axis)
        const startY = Math.floor(bounds.minY / tickSpacing) * tickSpacing;
        const endY = Math.ceil(bounds.maxY / tickSpacing) * tickSpacing;
        
        for (let worldY = startY; worldY <= endY; worldY += tickSpacing) {
            const screenY = this.worldToScreen({ x: 0, y: worldY }).y;
            if (screenY < rs || screenY > h) continue;
            
            // Major tick
            ticks.moveTo(rs, screenY);
            ticks.lineTo(rs - 8, screenY);
            
            // Label (rotated)
            const label = new PIXI.Text(worldY.toString(), {
                fontSize: 10,
                fill: 0x888888,
                fontFamily: 'monospace'
            });
            label.x = 2;
            label.y = screenY + 2;
            this.rulerLayer.addChild(label);
            
            // Minor ticks
            for (let i = 1; i < 5; i++) {
                const minorY = worldY + (tickSpacing / 5) * i;
                const minorScreenY = this.worldToScreen({ x: 0, y: minorY }).y;
                if (minorScreenY > rs && minorScreenY < h) {
                    ticks.moveTo(rs, minorScreenY);
                    ticks.lineTo(rs - 4, minorScreenY);
                }
            }
        }
        
        // Border lines
        ticks.lineStyle(1, 0x444444);
        ticks.moveTo(rs, 0);
        ticks.lineTo(rs, h);
        ticks.moveTo(0, rs);
        ticks.lineTo(w, rs);
        
        this.rulerLayer.addChild(ticks);
    }

    setGridVisible(visible) {
        this.gridVisible = visible;
        this._createGrid();
    }

    setOriginVisible(visible) {
        this.showOrigin = visible;
        this._createOrigin();
    }

    // ==================== Units ====================

    setUnits(units) {
        if (this.unitConversions[units]) {
            this.units = units;
        }
    }

    formatValue(worldValue, precision = 2) {
        const converted = worldValue * this.unitConversions[this.units];
        return converted.toFixed(precision);
    }

    // ==================== Events ====================

    _bindEvents() {
        const view = this.app.view;
        
        // Wheel zoom
        view.addEventListener('wheel', (e) => {
            e.preventDefault();
            const rect = view.getBoundingClientRect();
            const mouseScreen = {
                x: e.clientX - rect.left,
                y: e.clientY - rect.top
            };
            const mouseWorld = this.screenToWorld(mouseScreen);
            const factor = e.deltaY > 0 ? 0.9 : 1.1;
            this.zoomAt(mouseWorld, factor);
        }, { passive: false });

        // Pan start
        view.addEventListener('mousedown', (e) => {
            if (e.button === 2 || (e.button === 0 && e.shiftKey)) {
                this.isPanning = true;
                this.panStart = { x: e.clientX, y: e.clientY };
                this.panStartOffset = { ...this.offset };
                view.style.cursor = 'grabbing';
                e.preventDefault();
            }
        });

        // Pan move
        view.addEventListener('mousemove', (e) => {
            const rect = view.getBoundingClientRect();
            const mouseScreen = {
                x: e.clientX - rect.left,
                y: e.clientY - rect.top
            };
            
            if (this.isPanning) {
                const dx = e.clientX - this.panStart.x;
                const dy = e.clientY - this.panStart.y;
                this.offset.x = this.panStartOffset.x - dx / this.scale;
                this.offset.y = this.panStartOffset.y - dy / this.scale;
                this._updateTransform();
                this._createRulers();
            }
            
            this.currentMouseWorld = this.screenToWorld(mouseScreen);
            
            if (this.onMouseMove) {
                this.onMouseMove(this.currentMouseWorld, this.getSnappedPosition(this.currentMouseWorld));
            }
        });

        // Pan end
        window.addEventListener('mouseup', (e) => {
            if (this.isPanning) {
                this.isPanning = false;
                view.style.cursor = 'crosshair';
                this._createGrid();
                this._notifyViewChanged();
            }
        });

        // Keyboard
        window.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
            
            switch (e.key) {
                case 'Home':
                    this.resetView();
                    break;
                case 'f':
                case 'F':
                    this.fitToContent();
                    break;
                case 'g':
                case 'G':
                    this.gridVisible = !this.gridVisible;
                    this._createGrid();
                    break;
                case '+':
                case '=':
                    this.zoomAt(this.offset, 1.2);
                    break;
                case '-':
                    this.zoomAt(this.offset, 0.8);
                    break;
            }
        });

        // Prevent context menu
        view.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    // ==================== Drawing API ====================

    /**
     * Create a graphics object for drawing
     */
    createGraphics() {
        return new PIXI.Graphics();
    }

    /**
     * Add a graphics object to the content layer
     */
    addContent(graphics) {
        this.contentLayer.addChild(graphics);
    }

    /**
     * Remove a graphics object from the content layer
     */
    removeContent(graphics) {
        this.contentLayer.removeChild(graphics);
    }

    /**
     * Clear all content
     */
    clearContent() {
        this.contentLayer.removeChildren();
    }
}