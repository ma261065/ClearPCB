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
            backgroundColor: 0x0a0a14,
            antialias: false,  // Faster without AA
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
        this.contentLayer = new PIXI.Container();
        this.originLayer = new PIXI.Container();
        this.world.addChild(this.contentLayer);
        this.world.addChild(this.originLayer);
        
        // Grid layer is in screen space (child of stage, not world)
        // This avoids texture scaling artifacts
        this.gridLayer = new PIXI.Container();
        this.app.stage.addChildAt(this.gridLayer, 0); // Behind world
        
        // View state
        this.scale = 50;  // Pixels per mm
        this.offset = { x: 0, y: 0 };  // World coords at center
        
        // Constraints
        this.minScale = 1;
        this.maxScale = 500;
        
        // Grid
        this.gridSize = 1;
        this.gridVisible = true;
        this.showOrigin = true;
        this._gridSprite = null;
        this._gridTilePixels = 0;
        this._gridCellPixels = 0;
        
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
        this._bindEvents();
        
        // Handle resize
        window.addEventListener('resize', () => {
            this._updateTransform();
            this._createGrid(); // Recreate to cover new screen size
        });
    }
    
    get width() {
        return this.app.screen.width;
    }
    
    get height() {
        return this.app.screen.height;
    }
    
    get zoom() {
        return this.scale;
    }
    
    set zoom(value) {
        this.scale = value;
    }

    // ==================== Transform Management ====================
    
    _updateTransform() {
        // Position world container so that this.offset is at screen center
        this.world.x = this.width / 2 - this.offset.x * this.scale;
        this.world.y = this.height / 2 - this.offset.y * this.scale;
        this.world.scale.set(this.scale);
        
        // Update grid to match (grid is in screen space)
        this._updateGridOffset();
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
        const newScale = Math.max(this.minScale, Math.min(this.maxScale, this.scale * factor));
        
        if (newScale !== this.scale) {
            const oldScale = this.scale;
            const actualFactor = newScale / this.scale;
            this.offset.x = worldPoint.x - (worldPoint.x - this.offset.x) / actualFactor;
            this.offset.y = worldPoint.y - (worldPoint.y - this.offset.y) / actualFactor;
            this.scale = newScale;
            this._updateTransform();
            
            // Only rebuild grid when zoom changes significantly (crosses a 2x threshold)
            const oldLog = Math.floor(Math.log2(oldScale * this.gridSize));
            const newLog = Math.floor(Math.log2(newScale * this.gridSize));
            if (oldLog !== newLog) {
                this._createGrid();
            }
            
            this._notifyViewChanged();
        }
    }

    resetView() {
        this.offset = { x: 0, y: 0 };
        this.scale = 50;
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
        
        this.scale = Math.min(scaleX, scaleY);
        this.scale = Math.max(this.minScale, Math.min(this.maxScale, this.scale));
        
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
        
        const gridSize = this.gridSize;
        const gridPixelSize = gridSize * this.scale;
        
        // Don't draw if grid too small
        if (gridPixelSize < 4) return;
        
        // Determine major interval
        let majorInterval = 10;
        while (gridPixelSize * majorInterval < 40) {
            majorInterval *= 2;
        }
        
        // Tile size in pixels (one major grid cell)
        // Round to integer to avoid subpixel issues
        const cellPixels = Math.round(gridPixelSize);
        const tilePixels = cellPixels * majorInterval;
        
        if (tilePixels < 8) return;
        
        // Create tile canvas
        const canvas = document.createElement('canvas');
        canvas.width = tilePixels;
        canvas.height = tilePixels;
        const ctx = canvas.getContext('2d');
        
        // Draw minor grid lines
        ctx.strokeStyle = '#1a2744';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 1; i < majorInterval; i++) {
            const pos = i * cellPixels + 0.5;
            ctx.moveTo(pos, 0);
            ctx.lineTo(pos, tilePixels);
            ctx.moveTo(0, pos);
            ctx.lineTo(tilePixels, pos);
        }
        ctx.stroke();
        
        // Draw major grid lines at tile edges
        ctx.strokeStyle = '#243656';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0.5, 0);
        ctx.lineTo(0.5, tilePixels);
        ctx.moveTo(0, 0.5);
        ctx.lineTo(tilePixels, 0.5);
        ctx.stroke();
        
        // Create texture
        const texture = PIXI.Texture.from(canvas);
        texture.baseTexture.scaleMode = PIXI.SCALE_MODES.NEAREST;
        
        // Create tiling sprite covering screen + margin (in pixels, screen space)
        const margin = tilePixels * 2;
        const tilingSprite = new PIXI.TilingSprite(
            texture,
            this.width + margin * 2,
            this.height + margin * 2
        );
        tilingSprite.x = -margin;
        tilingSprite.y = -margin;
        
        // No scaling - tile is already at correct pixel size
        tilingSprite.tileScale.set(1, 1);
        
        this.gridLayer.addChild(tilingSprite);
        this._gridSprite = tilingSprite;
        this._gridTilePixels = tilePixels;
        this._gridCellPixels = cellPixels;
        
        // Update offset to match current view
        this._updateGridOffset();
    }
    
    _updateGridOffset() {
        if (!this._gridSprite) return;
        
        // Calculate where world origin (0,0) appears on screen
        const originScreen = this.worldToScreen({ x: 0, y: 0 });
        
        // Tile offset so grid aligns with world coordinates
        // Use modulo to keep offset within one tile
        const tilePixels = this._gridTilePixels;
        this._gridSprite.tilePosition.x = originScreen.x % tilePixels;
        this._gridSprite.tilePosition.y = originScreen.y % tilePixels;
    }

    _createOrigin() {
        this.originLayer.removeChildren();
        
        if (!this.showOrigin) return;
        
        const origin = new PIXI.Graphics();
        const size = 15;
        const lineWidth = 2;
        
        origin.lineStyle(lineWidth, 0xe94560, 1);
        
        // Crosshair
        origin.moveTo(-size, 0);
        origin.lineTo(size, 0);
        origin.moveTo(0, -size);
        origin.lineTo(0, size);
        
        // Circle
        origin.drawCircle(0, 0, 3);
        
        this.originLayer.addChild(origin);
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