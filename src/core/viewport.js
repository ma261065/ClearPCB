/**
 * Viewport - Core coordinate system and view management for ClearPCB
 * 
 * Coordinate Systems:
 * - World coordinates: The actual design space (in mm by default)
 * - Screen coordinates: Pixel positions on the canvas
 * 
 * The viewport manages the transformation between these systems.
 */

export class Viewport {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        
        // View transformation state
        this.offset = { x: 0, y: 0 };  // World coords at screen center
        this.zoom = 50;  // Pixels per world unit (mm)
        
        // Zoom constraints
        this.minZoom = 1;    // 1 pixel per mm (very zoomed out)
        this.maxZoom = 500;  // 500 pixels per mm (very zoomed in)
        
        // Grid configuration
        this.gridSize = 1;           // World units (mm)
        this.gridVisible = true;
        this.gridStyle = {
            minor: { color: '#1a2744', width: 1 },
            major: { color: '#243656', width: 1 },
            majorInterval: 10  // Major line every N minor lines
        };
        
        // Origin marker
        this.showOrigin = true;
        this.originStyle = {
            color: '#e94560',
            size: 15,  // pixels
            width: 2
        };
        
        // Snapping
        this.snapToGrid = true;
        
        // Units for display
        this.units = 'mm';
        this.unitConversions = {
            mm: 1,
            mil: 1 / 0.0254,
            inch: 1 / 25.4
        };
        
        // Interaction state
        this.isPanning = false;
        this.lastMousePos = { x: 0, y: 0 };
        this.currentMouseWorld = { x: 0, y: 0 };
        this.panStartOffset = { x: 0, y: 0 };
        this.panStartMouse = { x: 0, y: 0 };
        
        // Performance: track dirty state
        this.needsRender = true;
        
        // Overscan buffer for smooth panning
        this.overscan = 400;
        this.canvasWidth = 0;
        this.canvasHeight = 0;
        
        // Grid pattern cache
        this._gridPattern = null;
        this._gridPatternKey = null;
        
        // Callbacks
        this.onViewChanged = null;
        this.onMouseMove = null;
        this.onRender = null;
        
        this._setupCanvas();
        this._bindEvents();
    }

    /**
     * Setup canvas for high DPI displays
     */
    _setupCanvas() {
        this.dpr = window.devicePixelRatio || 1;
        this._resize();
        
        window.addEventListener('resize', () => {
            this._resize();
            this.requestRender();
        });
    }

    _resize() {
        const container = this.canvas.parentElement;
        const rect = container.getBoundingClientRect();
        
        // Overscan: render extra content beyond visible edges
        this.overscan = 400; // pixels of extra content on each side
        
        // Visible size
        this.width = rect.width;
        this.height = rect.height;
        
        // Canvas is larger than visible area
        const canvasWidth = rect.width + this.overscan * 2;
        const canvasHeight = rect.height + this.overscan * 2;
        
        // Set display size (larger than container)
        this.canvas.style.width = canvasWidth + 'px';
        this.canvas.style.height = canvasHeight + 'px';
        
        // Position canvas so overscan is hidden
        this.canvas.style.position = 'absolute';
        this.canvas.style.left = -this.overscan + 'px';
        this.canvas.style.top = -this.overscan + 'px';
        
        // Set actual size for high DPI
        this.canvas.width = canvasWidth * this.dpr;
        this.canvas.height = canvasHeight * this.dpr;
        
        // Full canvas dimensions (including overscan)
        this.canvasWidth = canvasWidth;
        this.canvasHeight = canvasHeight;
        
        // Clear grid pattern cache (DPR might have changed)
        this._gridPattern = null;
        this._gridPatternKey = null;
        
        // Scale context to match
        this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        
        this.needsRender = true;
    }

    /**
     * Bind mouse and keyboard events
     */
    _bindEvents() {
        const canvas = this.canvas;
        const container = canvas.parentElement;
        
        // Mouse wheel for zoom
        canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            const mouseScreen = this._getMousePos(e);
            const mouseWorld = this.screenToWorld(mouseScreen);
            
            // Zoom factor based on scroll delta
            const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
            this.zoomAt(mouseWorld, zoomFactor);
        }, { passive: false });

        // Mouse down
        canvas.addEventListener('mousedown', (e) => {
            if (e.button === 2 || (e.button === 0 && e.shiftKey)) {
                // Right button or shift+left for pan
                this.isPanning = true;
                this.panStartOffset = { ...this.offset };
                this.panStartMouse = this._getMousePos(e);
                canvas.style.cursor = 'grabbing';
                e.preventDefault();
            }
        });

        // Mouse move
        canvas.addEventListener('mousemove', (e) => {
            const mouseScreen = this._getMousePos(e);
            
            if (this.isPanning) {
                // Calculate total drag distance in pixels
                const dx = mouseScreen.x - this.panStartMouse.x;
                const dy = mouseScreen.y - this.panStartMouse.y;
                
                // Check if we've exceeded the overscan buffer
                if (Math.abs(dx) > this.overscan * 0.8 || Math.abs(dy) > this.overscan * 0.8) {
                    // We've panned too far - re-render and reset
                    this.offset.x = this.panStartOffset.x - dx / this.zoom;
                    this.offset.y = this.panStartOffset.y - dy / this.zoom;
                    this.panStartOffset = { ...this.offset };
                    this.panStartMouse = mouseScreen;
                    canvas.style.transform = '';
                    this._forceRender();
                } else {
                    // Use CSS transform for smooth GPU-accelerated movement
                    canvas.style.transform = `translate(${dx}px, ${dy}px)`;
                }
                
                this.lastMousePos = mouseScreen;
            }
            
            // Update current mouse position in world coords
            // During pan, account for the CSS transform offset
            if (this.isPanning) {
                const dx = mouseScreen.x - this.panStartMouse.x;
                const dy = mouseScreen.y - this.panStartMouse.y;
                // Content under cursor was originally at screen pos minus the transform
                this.currentMouseWorld = this.screenToWorld({
                    x: mouseScreen.x - dx,
                    y: mouseScreen.y - dy
                });
            } else {
                this.currentMouseWorld = this.screenToWorld(mouseScreen);
            }
            
            if (this.onMouseMove) {
                this.onMouseMove(this.currentMouseWorld, this.getSnappedPosition(this.currentMouseWorld));
            }
        });

        // Mouse up
        window.addEventListener('mouseup', (e) => {
            if (this.isPanning) {
                this.isPanning = false;
                canvas.style.cursor = 'crosshair';
                
                // Calculate final offset
                const mouseScreen = this._getMousePos(e);
                const dx = mouseScreen.x - this.panStartMouse.x;
                const dy = mouseScreen.y - this.panStartMouse.y;
                this.offset.x = this.panStartOffset.x - dx / this.zoom;
                this.offset.y = this.panStartOffset.y - dy / this.zoom;
                
                // Reset CSS transform and do actual render
                canvas.style.transform = '';
                this.requestRender();
                this._notifyViewChanged();
            }
        });

        // Keyboard shortcuts
        window.addEventListener('keydown', (e) => {
            // Don't capture if in an input
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
                    this.requestRender();
                    break;
                case '+':
                case '=':
                    this.zoomAt(this.offset, 1.2);
                    break;
                case '-':
                    this.zoomAt(this.offset, 0.8);
                    break;
                case ' ':
                    if (!this.isPanning) {
                        this.isPanning = true;
                        this.panStartOffset = { ...this.offset };
                        this.panStartMouse = this.lastMousePos;
                        canvas.style.cursor = 'grab';
                    }
                    e.preventDefault();
                    break;
            }
        });

        window.addEventListener('keyup', (e) => {
            if (e.key === ' ' && this.isPanning) {
                this.isPanning = false;
                canvas.style.cursor = 'crosshair';
                canvas.style.transform = '';
                this.requestRender();
            }
        });

        // Prevent context menu on canvas
        canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    _getMousePos(e) {
        // Get position relative to the container (visible viewport), not the canvas
        const container = this.canvas.parentElement;
        const rect = container.getBoundingClientRect();
        return {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top
        };
    }

    // ==================== Coordinate Transforms ====================

    /**
     * Convert world coordinates to screen coordinates
     * Screen coords are relative to the visible viewport (not the overscan canvas)
     */
    worldToScreen(world) {
        return {
            x: (world.x - this.offset.x) * this.zoom + this.width / 2,
            y: (world.y - this.offset.y) * this.zoom + this.height / 2
        };
    }
    
    /**
     * Convert world coordinates to canvas coordinates (including overscan offset)
     */
    worldToCanvas(world) {
        return {
            x: (world.x - this.offset.x) * this.zoom + this.canvasWidth / 2,
            y: (world.y - this.offset.y) * this.zoom + this.canvasHeight / 2
        };
    }

    /**
     * Convert screen coordinates to world coordinates
     */
    screenToWorld(screen) {
        return {
            x: (screen.x - this.width / 2) / this.zoom + this.offset.x,
            y: (screen.y - this.height / 2) / this.zoom + this.offset.y
        };
    }

    /**
     * Get world coordinate snapped to grid
     */
    getSnappedPosition(world) {
        if (!this.snapToGrid || this.gridSize <= 0) return world;
        return {
            x: Math.round(world.x / this.gridSize) * this.gridSize,
            y: Math.round(world.y / this.gridSize) * this.gridSize
        };
    }

    /**
     * Convert world distance to screen pixels
     */
    worldToScreenDistance(worldDist) {
        return worldDist * this.zoom;
    }

    /**
     * Convert screen pixels to world distance
     */
    screenToWorldDistance(screenDist) {
        return screenDist / this.zoom;
    }

    // ==================== View Control ====================

    /**
     * Pan the view by world coordinate delta
     */
    pan(dx, dy) {
        this.offset.x += dx;
        this.offset.y += dy;
        this.requestRender();
        this._notifyViewChanged();
    }

    /**
     * Zoom at a specific world coordinate
     */
    zoomAt(worldPoint, factor) {
        const newZoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoom * factor));
        
        if (newZoom !== this.zoom) {
            // Adjust offset to keep worldPoint at same screen position
            const actualFactor = newZoom / this.zoom;
            this.offset.x = worldPoint.x - (worldPoint.x - this.offset.x) / actualFactor;
            this.offset.y = worldPoint.y - (worldPoint.y - this.offset.y) / actualFactor;
            this.zoom = newZoom;
            this.requestRender();
            this._notifyViewChanged();
        }
    }

    /**
     * Set zoom level (centered on current view)
     */
    setZoom(newZoom) {
        this.zoomAt(this.offset, newZoom / this.zoom);
    }

    /**
     * Reset view to origin with default zoom
     */
    resetView() {
        this.offset = { x: 0, y: 0 };
        this.zoom = 50;
        this.requestRender();
        this._notifyViewChanged();
    }

    /**
     * Fit view to show a bounding box (with padding)
     */
    fitToBounds(minX, minY, maxX, maxY, padding = 50) {
        const contentWidth = maxX - minX;
        const contentHeight = maxY - minY;
        
        if (contentWidth <= 0 || contentHeight <= 0) {
            this.resetView();
            return;
        }
        
        // Calculate zoom to fit
        const availableWidth = this.width - padding * 2;
        const availableHeight = this.height - padding * 2;
        
        const zoomX = availableWidth / contentWidth;
        const zoomY = availableHeight / contentHeight;
        
        this.zoom = Math.min(zoomX, zoomY);
        this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoom));
        
        // Center on content
        this.offset.x = (minX + maxX) / 2;
        this.offset.y = (minY + maxY) / 2;
        
        this.requestRender();
        this._notifyViewChanged();
    }

    /**
     * Fit view to content - override this with actual content bounds
     */
    fitToContent() {
        // Default: show a 100mm x 100mm area centered on origin
        // This should be overridden when content is added
        this.fitToBounds(-50, -50, 50, 50);
    }

    /**
     * Get visible world bounds (including overscan for rendering)
     */
    getVisibleBounds() {
        const overscanWorld = this.overscan / this.zoom;
        const halfWidth = this.width / 2 / this.zoom;
        const halfHeight = this.height / 2 / this.zoom;
        return {
            minX: this.offset.x - halfWidth - overscanWorld,
            minY: this.offset.y - halfHeight - overscanWorld,
            maxX: this.offset.x + halfWidth + overscanWorld,
            maxY: this.offset.y + halfHeight + overscanWorld
        };
    }

    _notifyViewChanged() {
        if (this.onViewChanged) {
            this.onViewChanged({
                offset: { ...this.offset },
                zoom: this.zoom,
                bounds: this.getVisibleBounds()
            });
        }
    }

    // ==================== Grid Configuration ====================

    setGridSize(size) {
        this.gridSize = Math.max(0.01, size);
        this._gridPattern = null;
        this._gridPatternKey = null;
        this.requestRender();
    }

    setUnits(units) {
        if (this.unitConversions[units]) {
            this.units = units;
        }
    }

    /**
     * Format a world coordinate value for display
     */
    formatValue(worldValue, precision = 2) {
        const converted = worldValue * this.unitConversions[this.units];
        return converted.toFixed(precision);
    }

    // ==================== Rendering ====================

    requestRender() {
        this.needsRender = true;
    }
    
    /**
     * Force immediate render (used during pan when buffer exceeded)
     */
    _forceRender() {
        this.needsRender = true;
        this.render();
        // Also notify app to render content
        if (this.onRender) {
            this.onRender();
        }
    }

    /**
     * Main render function - call this in animation loop
     */
    render() {
        if (!this.needsRender) return false;
        this.needsRender = false;
        
        const ctx = this.ctx;
        
        // Clear full canvas (including overscan)
        ctx.fillStyle = '#0a0a14';
        ctx.fillRect(0, 0, this.canvasWidth, this.canvasHeight);
        
        // Draw grid
        if (this.gridVisible) {
            this._renderGrid();
        }
        
        // Draw origin marker
        if (this.showOrigin) {
            this._renderOrigin();
        }
        
        return true;
    }

    _renderGrid() {
        const ctx = this.ctx;
        const gridSize = this.gridSize;
        
        // Determine if grid should be visible at current zoom
        const gridPixelSize = gridSize * this.zoom;
        
        // Don't render if grid would be too small
        if (gridPixelSize < 4) return;
        
        // Determine major grid interval
        let majorInterval = this.gridStyle.majorInterval;
        while (gridPixelSize * majorInterval < 40) {
            majorInterval *= 2;
        }
        
        // Create or update cached grid pattern
        const patternKey = `${gridPixelSize.toFixed(2)}_${majorInterval}`;
        if (this._gridPatternKey !== patternKey) {
            this._gridPattern = this._createGridPattern(gridPixelSize, majorInterval);
            this._gridPatternKey = patternKey;
        }
        
        if (!this._gridPattern) return;
        
        // Calculate pattern offset to align with world coordinates
        const originCanvas = this.worldToCanvas({ x: 0, y: 0 });
        const tileSize = gridPixelSize * majorInterval;
        const offsetX = originCanvas.x % tileSize;
        const offsetY = originCanvas.y % tileSize;
        
        // Draw pattern
        ctx.save();
        ctx.translate(offsetX, offsetY);
        ctx.fillStyle = this._gridPattern;
        ctx.fillRect(-tileSize, -tileSize, this.canvasWidth + tileSize * 2, this.canvasHeight + tileSize * 2);
        ctx.restore();
    }
    
    _createGridPattern(gridPixelSize, majorInterval) {
        const tileSize = gridPixelSize * majorInterval;
        
        // Create offscreen canvas for the pattern tile
        const tile = document.createElement('canvas');
        tile.width = tileSize * this.dpr;
        tile.height = tileSize * this.dpr;
        const tileCtx = tile.getContext('2d');
        tileCtx.scale(this.dpr, this.dpr);
        
        // Draw minor grid lines
        tileCtx.strokeStyle = this.gridStyle.minor.color;
        tileCtx.lineWidth = this.gridStyle.minor.width;
        tileCtx.beginPath();
        
        for (let i = 1; i < majorInterval; i++) {
            const pos = i * gridPixelSize;
            // Vertical line
            tileCtx.moveTo(pos + 0.5, 0);
            tileCtx.lineTo(pos + 0.5, tileSize);
            // Horizontal line
            tileCtx.moveTo(0, pos + 0.5);
            tileCtx.lineTo(tileSize, pos + 0.5);
        }
        tileCtx.stroke();
        
        // Draw major grid lines (at edges of tile)
        tileCtx.strokeStyle = this.gridStyle.major.color;
        tileCtx.lineWidth = this.gridStyle.major.width;
        tileCtx.beginPath();
        // Left and top edges
        tileCtx.moveTo(0.5, 0);
        tileCtx.lineTo(0.5, tileSize);
        tileCtx.moveTo(0, 0.5);
        tileCtx.lineTo(tileSize, 0.5);
        tileCtx.stroke();
        
        // Create pattern
        return this.ctx.createPattern(tile, 'repeat');
    }

    _renderOrigin() {
        const ctx = this.ctx;
        const origin = this.worldToCanvas({ x: 0, y: 0 });
        const size = this.originStyle.size;
        
        ctx.strokeStyle = this.originStyle.color;
        ctx.lineWidth = this.originStyle.width;
        ctx.lineCap = 'round';
        
        // X axis (horizontal)
        ctx.beginPath();
        ctx.moveTo(origin.x - size, origin.y);
        ctx.lineTo(origin.x + size, origin.y);
        ctx.stroke();
        
        // Y axis (vertical)
        ctx.beginPath();
        ctx.moveTo(origin.x, origin.y - size);
        ctx.lineTo(origin.x, origin.y + size);
        ctx.stroke();
        
        // Small circle at center
        ctx.beginPath();
        ctx.arc(origin.x, origin.y, 3, 0, Math.PI * 2);
        ctx.stroke();
    }

    // ==================== Drawing Helpers ====================

    /**
     * Begin a path in world coordinates - useful for subclasses/extensions
     */
    beginWorldPath() {
        this.ctx.beginPath();
    }

    /**
     * Move to world coordinate
     */
    moveToWorld(x, y) {
        const screen = this.worldToScreen({ x, y });
        this.ctx.moveTo(screen.x, screen.y);
    }

    /**
     * Line to world coordinate
     */
    lineToWorld(x, y) {
        const screen = this.worldToScreen({ x, y });
        this.ctx.lineTo(screen.x, screen.y);
    }

    /**
     * Draw a circle at world coordinate
     */
    circleAtWorld(x, y, radius) {
        const screen = this.worldToScreen({ x, y });
        const screenRadius = radius * this.zoom;
        this.ctx.beginPath();
        this.ctx.arc(screen.x, screen.y, screenRadius, 0, Math.PI * 2);
    }

    /**
     * Draw a rectangle in world coordinates
     */
    rectWorld(x, y, width, height) {
        const topLeft = this.worldToScreen({ x, y });
        const screenWidth = width * this.zoom;
        const screenHeight = height * this.zoom;
        this.ctx.rect(topLeft.x, topLeft.y, screenWidth, screenHeight);
    }
}