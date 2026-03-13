/**
 * ViewportSVG - SVG-based viewport with pan/zoom
 * 
 * Uses SVG viewBox for pan/zoom - mathematically perfect scaling.
 */

export class Viewport {
    /**
     * Create the SVG viewport with pan, zoom, grid, rulers, and paper outline.
     * @param {HTMLElement} container - DOM element to host the SVG canvas.
     */
    constructor(container) {
        this.container = container;
        
        // Create SVG element
        this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        this.svg.style.width = '100%';
        this.svg.style.height = '100%';
        this.svg.style.display = 'block';
        this.svg.style.backgroundColor = 'var(--bg-canvas, #000000)';
        this.svg.style.cursor = 'default';
        container.appendChild(this.svg);
        
        // Theme colors (will be read from CSS variables)
        this.themeColors = this._getThemeColors();
        
        // Create layer groups
        this.gridLayer = this._createGroup('gridLayer');
        this.paperOutlineLayer = this._createGroup('paperOutlineLayer');
        this.contentLayer = this._createGroup('contentLayer');
        
        // Title block in-place edit state
        this._titleBlockEditActive = false;
        this._titleBlockEditInput = null;
        this._cancelTitleBlockEdit = () => {};
        // Sub-layer for components (always below shapes)
        this.componentLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        this.componentLayer.setAttribute('id', 'componentLayer');
        this.contentLayer.appendChild(this.componentLayer);
        this.axesLayer = this._createGroup('axesLayer');
        this.rulerLayer = null; // Rulers are in screen space, handled separately
        
        // Create ruler container (HTML overlay)
        this.rulerContainer = document.createElement('div');
        this.rulerContainer.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;';
        container.appendChild(this.rulerContainer);
        this._rulerCursorXLine = null;
        this._rulerCursorYLine = null;
        
        // View state - viewBox defines visible world area
        this.baseWidth = 200; // mm visible at 100% zoom (for display purposes)
        
        // Zoom levels with clean 1-2-5 percentage progression
        // View width = baseWidth / (zoomPercent / 100) = 20000 / zoomPercent
        // Zoom percentages: 1, 2, 5, 10, 20, 35, 50, 75, 100, 150, 200, 500, 1000, 2000, 5000, 10000
        this.zoomLevels = [
            20000,  // 1%
            10000,  // 2%
            4000,   // 5%
            2000,   // 10%
            1000,   // 20%
            571,    // 35% (20000/35 ≈ 571.43)
            400,    // 50%
            266,    // 75% (20000/75 ≈ 266.67)
            200,    // 100%
            133,    // 150% (20000/150 ≈ 133.33)
            100,    // 200%
            40,     // 500%
            20,     // 1000%
            10,     // 2000%
            4,      // 5000%
            2       // 10000%
        ];
        this.zoomIndex = 8; // Start at 200mm (index 8) = 100% zoom
        
        this.viewBox = { x: -100, y: -60, width: 200, height: 120 };
        
        // Constraints (index bounds)
        this.minZoomIndex = 0;
        this.maxZoomIndex = this.zoomLevels.length - 1;
        
        // Grid
        this.gridSize = 1.27;
        this.gridVisible = true;
        this.gridStyle = 'lines';
        
        // Rulers
        this.rulerSize = 25;
        this.showRulers = true;
        
        // Snapping
        this.snapToGrid = true;
        this.shiftHeld = false;  // tracked from mouse events for shift-reversal
        
        // Paper size
        this.paperSize = null;  // null = no paper outline
        this.paperSizeKey = null;  // Name of the paper size (e.g., 'A4')
        this.showTitleBlock = false; // Double border with zone markers
        this.showTitleBlockInfo = false; // Title block info box
        this._titleBlockStorageKey = 'clearpcb_tb_data';
        const persistedTitleBlockData = this._loadPersistedTitleBlockData();
        this.titleBlockData = {
            title: persistedTitleBlockData.title ?? '',
            rev: persistedTitleBlockData.rev ?? '',
            company: persistedTitleBlockData.company ?? (localStorage.getItem('clearpcb_tb_company') || ''),
            date: persistedTitleBlockData.date ?? new Date().toLocaleDateString(),
            drawnBy: persistedTitleBlockData.drawnBy ?? (localStorage.getItem('clearpcb_tb_drawnBy') || ''),
            sheet: persistedTitleBlockData.sheet ?? '1/1'
        };
        
        // Units
        this.units = 'mm';
        this.unitConversions = {
            'mm': 1,
            'mil': 39.3701,
            'inch': 0.0393701
        };
        
        // Pan state
        this.isPanning = false;
        this.panStart = { x: 0, y: 0 };
        this.panStartViewBox = null;
        this.currentMouseWorld = { x: 0, y: 0 };
        this.shiftHeld = false;
        
        // Cache for getBoundingClientRect (expensive operation)
        this.cachedRect = null;
        this.cachedRectTime = 0;
        // Cache for viewport change optimization
        this.cachedVisibleBounds = null;
        this.viewChangeTimer = null;
        this.gridDirty = true;  // Track if grid needs redraw
        this.paperDirty = true; // Track if paper outline needs redraw
        this._lastNotifiedScale = null; // Track scale for change detection
        
        // Callbacks
        this.onViewChanged = null;
        this.onMouseMove = null;
        this.onViewportCull = null;
        
        // Event handlers (stored for cleanup)
        this.boundHandlers = {
            wheel: null,
            mousedown: null,
            mousemove: null,
            mouseup: null,
            contextmenu: null,
            resize: null,
            keydown: null
        };
        
        // Setup
        this._updateViewBox();
        this._createGrid();
        this._createRulers();
        this._bindEvents();
        this._disableBrowserZoom();
    }
    
    /**
     * Create an SVG `<g>` element and append it to the root SVG.
     * @param {string} id - Element ID attribute.
     * @returns {SVGGElement} The new group element.
     */
    _createGroup(id) {
        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.setAttribute('id', id);
        this.svg.appendChild(g);
        return g;
    }
    
    /** Viewport width in CSS pixels. */
    get width() {
        return this.svg.clientWidth || this.container.clientWidth;
    }
    
    /** Viewport height in CSS pixels. */
    get height() {
        return this.svg.clientHeight || this.container.clientHeight;
    }
    
    /** Pixels per world unit (mm). */
    get scale() {
        return this.width / this.viewBox.width;
    }
    
    /** Zoom multiplier (1.0 = 100% = `baseWidth` mm visible). */
    get zoom() {
        return this.baseWidth / this.viewBox.width;
    }
    
    /** Current visible width in mm. */
    get viewWidth() {
        return this.viewBox.width;
    }
    
    /** Centre of the viewBox in world coordinates. */
    get offset() {
        return {
            x: this.viewBox.x + this.viewBox.width / 2,
            y: this.viewBox.y + this.viewBox.height / 2
        };
    }
    
    // ==================== Theme Support ====================
    
    /**
     * Read theme colors from CSS variables
     */
    _getThemeColors() {
        const style = getComputedStyle(document.documentElement);
        return {
            canvasBg: style.getPropertyValue('--sch-background').trim() || '#1e1e1e',
            gridMinor: style.getPropertyValue('--sch-grid').trim() || 'rgba(255, 255, 255, 0.08)',
            gridMajor: style.getPropertyValue('--sch-grid-major').trim() || 'rgba(255, 255, 255, 0.15)',
            axis: style.getPropertyValue('--sch-axis').trim() || 'rgba(255, 255, 255, 0.25)',
            paperOutline: style.getPropertyValue('--sch-paper-outline').trim() || 'rgba(255, 255, 255, 0.12)',
            paperLabel: style.getPropertyValue('--sch-paper-label').trim() || 'rgba(255, 255, 255, 0.15)',
            rulerBg: style.getPropertyValue('--bg-primary').trim() || '#1a1a1a',
            rulerText: style.getPropertyValue('--text-secondary').trim() || '#888',
            rulerLine: style.getPropertyValue('--text-muted').trim() || '#666',
            rulerBorder: style.getPropertyValue('--border-color').trim() || '#444'
        };
    }
    
    /**
     * Update theme colors and re-render
     */
    updateTheme() {
        this.themeColors = this._getThemeColors();
        this.svg.style.backgroundColor = this.themeColors.canvasBg;
        this._createGrid();
        this._createRulers();
        this._drawPaperOutline();
    }

    // ==================== View Management ====================
    
    /** Push the current viewBox state to the SVG element attribute. */
    _updateViewBox() {
        const vb = this.viewBox;
        this.svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.width} ${vb.height}`);
    }
    
    /** Handle container resize: adjust viewBox height to maintain aspect ratio. */
    _onResize() {
        // Invalidate rect cache since viewport dimensions changed
        this.cachedRect = null;
        
        // Maintain aspect ratio - adjust height to match new container
        const aspect = this.height / this.width;
        this.viewBox.height = this.viewBox.width * aspect;
        this._updateViewBox();
        this._notifyViewChanged();
    }
    
    /**
     * Get cached SVG bounding rect (avoids expensive repeated calls)
     */
    _getCachedRect() {
        const now = performance.now();
        if (!this.cachedRect || (now - this.cachedRectTime) > 10) {
            this.cachedRect = this.svg.getBoundingClientRect();
            this.cachedRectTime = now;
        }
        return this.cachedRect;
    }
    
    /**
     * Convert a screen-space position (pixels relative to SVG element) to world coordinates (mm).
     * @param {{x: number, y: number}} screenPos - Position in pixels relative to SVG top-left.
     * @returns {{x: number, y: number}} World position in mm.
     */
    screenToWorld(screenPos) {
        const rect = this._getCachedRect();
        const x = this.viewBox.x + (screenPos.x / rect.width) * this.viewBox.width;
        const y = this.viewBox.y + (screenPos.y / rect.height) * this.viewBox.height;
        return { x, y };
    }
    
    /**
     * Convert a world-space position (mm) to screen pixels relative to the SVG element.
     * @param {{x: number, y: number}} worldPos - Position in mm.
     * @returns {{x: number, y: number}} Screen position in pixels.
     */
    worldToScreen(worldPos) {
        const rect = this._getCachedRect();
        const x = ((worldPos.x - this.viewBox.x) / this.viewBox.width) * rect.width;
        const y = ((worldPos.y - this.viewBox.y) / this.viewBox.height) * rect.height;
        return { x, y };
    }
    
    /**
     * Calculate the adaptive grid spacing for display using a 1-2-5 sequence.
     * Returns the smallest multiple of the base grid that keeps lines at least
     * `minPixelSpacing` screen pixels apart.
     * @returns {number} Grid spacing in mm.
     */
    getEffectiveGridSize() {
        // Calculate adaptive grid spacing for display using 1-2-5 sequence
        // This gives smoother transitions than 10x jumps
        const minPixelSpacing = 4; // Allow denser grid (was 8)
        const minWorldSpacing = minPixelSpacing / this.scale;
        
        // 1-2-5 sequence multipliers
        const sequence = [1, 2, 5];
        let multiplier = 1;
        let seqIndex = 0;
        
        let gridSpacing = this.gridSize;
        while (gridSpacing < minWorldSpacing) {
            // Move to next in 1-2-5 sequence
            seqIndex++;
            if (seqIndex >= sequence.length) {
                seqIndex = 0;
                multiplier *= 10;
            }
            gridSpacing = this.gridSize * sequence[seqIndex] * multiplier;
        }
        return gridSpacing;
    }
    
    /**
     * Snap a world position to the grid (if snapping is enabled).
     * Holding Shift toggles the snap setting when the grid is visible.
     * @param {{x: number, y: number}} worldPos - Unsnapped world position.
     * @returns {{x: number, y: number}} Snapped (or original) position.
     */
    getSnappedPosition(worldPos) {
        // Shift temporarily reverses the snap setting, but only if grid is visible
        let shouldSnap = this.snapToGrid;
        if (this.shiftHeld && this.gridVisible) shouldSnap = !shouldSnap;
        if (!shouldSnap) return worldPos;
        // Always snap to base grid size for precision
        return {
            x: Math.round(worldPos.x / this.gridSize) * this.gridSize,
            y: Math.round(worldPos.y / this.gridSize) * this.gridSize
        };
    }
    
    /**
     * Pan the view by the given world-unit delta.
     * @param {number} dx - Horizontal offset in mm.
     * @param {number} dy - Vertical offset in mm.
     */
    pan(dx, dy) {
        this.viewBox.x += dx;
        this.viewBox.y += dy;
        this._updateViewBox();
        this._notifyViewChanged();
    }
    
    /**
     * Zoom in or out by one discrete level towards a world point.
     * @param {{x: number, y: number}} worldPoint - Focal point in mm.
     * @param {number} factor - >1 zooms in, <1 zooms out.
     */
    zoomAt(worldPoint, factor) {
        // Determine zoom direction and step
        // factor > 1 means zoom in (higher index = smaller view width)
        const step = factor > 1 ? 1 : -1;
        this.zoomToLevel(this.zoomIndex + step, worldPoint);
    }
    
    /**
     * Jump to a specific zoom level, optionally anchored on a world point.
     * @param {number} index - Target index into `zoomLevels`.
     * @param {{x: number, y: number}|null} [worldPoint=null] - Focal point; defaults to view centre.
     */
    zoomToLevel(index, worldPoint = null) {
        const newIndex = Math.max(this.minZoomIndex, Math.min(this.maxZoomIndex, index));
        
        if (newIndex === this.zoomIndex) return;
        
        const newWidth = this.zoomLevels[newIndex];
        const newHeight = newWidth * (this.height / this.width);
        
        // Default to center if no point specified
        if (!worldPoint) {
            worldPoint = this.offset;
        }
        
        // Zoom toward the point
        const wx = (worldPoint.x - this.viewBox.x) / this.viewBox.width;
        const wy = (worldPoint.y - this.viewBox.y) / this.viewBox.height;
        
        this.zoomIndex = newIndex;
        this.viewBox.width = newWidth;
        this.viewBox.height = newHeight;
        this.viewBox.x = worldPoint.x - wx * newWidth;
        this.viewBox.y = worldPoint.y - wy * newHeight;
        
        this._updateViewBox();
        this._notifyViewChanged();
    }
    
    /**
     * Zoom in by one level towards the given point.
     * @param {{x: number, y: number}|null} [worldPoint=null] - Focal point.
     */
    zoomIn(worldPoint = null) {
        this.zoomToLevel(this.zoomIndex + 1, worldPoint);
    }
    
    /**
     * Zoom out by one level towards the given point.
     * @param {{x: number, y: number}|null} [worldPoint=null] - Focal point.
     */
    zoomOut(worldPoint = null) {
        this.zoomToLevel(this.zoomIndex - 1, worldPoint);
    }
    
    /** Reset zoom to 100% and position the origin 3 mm from the ruler edges. */
    resetView() {
        // Reset to 100% zoom (index 8)
        this.zoomIndex = 8;
        const aspect = this.height / this.width;
        this.viewBox.width = this.zoomLevels[this.zoomIndex];
        this.viewBox.height = this.viewBox.width * aspect;
        
        // Calculate ruler width in world units (mm)
        // scale is pixelsPerMM = width / viewBox.width
        const scale = this.width / this.viewBox.width;
        const rulerOffset = this.showRulers ? (this.rulerSize / scale) : 0;
        
        // Position so origin (0,0) is 3mm from rule edge (visible area)
        const margin = 3; // mm
        
        // Left edge of viewbox (x) needs to be shifted left by (margin + rulerOffset)
        // so that x=0 appears at (margin + rulerOffset) from the left edge of the viewport
        this.viewBox.x = -(margin + rulerOffset);
        
        // Bottom edge of viewbox needs to be shifted down by margin from the content bottom
        // But rulers are typically top/left.
        // If there is no bottom ruler, we just want 3mm from the bottom edge.
        this.viewBox.y = margin - this.viewBox.height;
        
        this._updateViewBox();
        this._notifyViewChanged();
    }
    
    /**
     * Zoom and centre the view to fit the given bounding box.
     * Selects the tightest discrete zoom level that contains the bounds.
     * @param {number} minX - Left edge in mm.
     * @param {number} minY - Top edge in mm.
     * @param {number} maxX - Right edge in mm.
     * @param {number} maxY - Bottom edge in mm.
     * @param {number} [paddingPercent=10] - Extra margin as a % of content size.
     */
    fitToBounds(minX, minY, maxX, maxY, paddingPercent = 10) {
        const contentWidth = maxX - minX;
        const contentHeight = maxY - minY;
        
        if (contentWidth <= 0 || contentHeight <= 0) {
            this.resetView();
            return;
        }
        
        const aspect = this.height / this.width;
        
        // Add padding as a percentage of content size
        const paddingX = contentWidth * (paddingPercent / 100);
        const paddingY = contentHeight * (paddingPercent / 100);
        
        // Calculate required view size to fit content with padding
        let requiredWidth = contentWidth + paddingX * 2;
        let requiredHeight = contentHeight + paddingY * 2;
        
        // Adjust to maintain aspect ratio
        if (requiredHeight / requiredWidth > aspect) {
            requiredWidth = requiredHeight / aspect;
        }
        
        // Find the most zoomed-in level that still fits the content
        // zoomLevels goes from largest (index 0) to smallest (index n-1)
        // We want the smallest viewWidth that is >= requiredWidth
        let bestIndex = 0;  // Default to most zoomed out
        for (let i = this.zoomLevels.length - 1; i >= 0; i--) {
            if (this.zoomLevels[i] >= requiredWidth) {
                bestIndex = i;
                break;
            }
        }
        
        this.zoomIndex = bestIndex;
        const viewWidth = this.zoomLevels[bestIndex];
        const viewHeight = viewWidth * aspect;
        
        // Center on content
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        
        this.viewBox.width = viewWidth;
        this.viewBox.height = viewHeight;
        this.viewBox.x = cx - viewWidth / 2;
        this.viewBox.y = cy - viewHeight / 2;
        
        this._updateViewBox();
        this._notifyViewChanged();
    }
    
    /** Fit the view to a default content area (placeholder). */
    fitToContent() {
        this.fitToBounds(-50, -50, 50, 50);
    }
    
    /**
     * Get the world-coordinate bounds currently visible on screen.
     * @returns {{minX: number, minY: number, maxX: number, maxY: number}}
     */
    getVisibleBounds() {
        return {
            minX: this.viewBox.x,
            minY: this.viewBox.y,
            maxX: this.viewBox.x + this.viewBox.width,
            maxY: this.viewBox.y + this.viewBox.height
        };
    }
    
    // ─── Pan API (called by state machine in mouse-states.js) ────────

    /**
     * Begin a pan operation from the given screen position.
     * @param {number} clientX
     * @param {number} clientY
     */
    startPan(clientX, clientY) {
        this.isPanning = true;
        this.panStart = { x: clientX, y: clientY };
        this.panStartViewBox = { ...this.viewBox };
        this.svg.style.cursor = 'grabbing';
    }

    /**
     * Continue panning to a new screen position.
     * @param {number} clientX
     * @param {number} clientY
     */
    updatePan(clientX, clientY) {
        if (!this.isPanning) return;
        const dx = (clientX - this.panStart.x) / this.scale;
        const dy = (clientY - this.panStart.y) / this.scale;
        this.viewBox.x = this.panStartViewBox.x - dx;
        this.viewBox.y = this.panStartViewBox.y - dy;
        this._updateViewBox();
        if (!this._panUpdatePending) {
            this._panUpdatePending = true;
            requestAnimationFrame(() => {
                this._panUpdatePending = false;
                this._createRulers();
                if (this.onViewportCull) this.onViewportCull();
            });
        }
    }

    /**
     * End current pan operation and notify view change.
     */
    endPan() {
        if (!this.isPanning) return;
        this.isPanning = false;
        this.svg.style.cursor = '';
        this._notifyViewChanged();
    }

    /**
     * Update mouse tracking state (called on every mousemove by dispatcher).
     * @param {MouseEvent} e
     */
    trackMouse(e) {
        const rect = this._getCachedRect();
        const mouseScreen = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        this.currentMouseWorld = this.screenToWorld(mouseScreen);
        this.shiftHeld = e.shiftKey;
        this._updateRulerCursor();
        if (this.onMouseMove) {
            this.onMouseMove(this.currentMouseWorld, this.getSnappedPosition(this.currentMouseWorld));
        }
    }

    /**
     * Schedule a debounced view-change update on the next animation frame.
     * Redraws grid, rulers, and paper outline only when bounds or scale change,
     * then fires the `onViewChanged` callback.
     */
    _notifyViewChanged() {
        // Mark as dirty for lazy redraw
        this.gridDirty = true;
        this.paperDirty = true;
        
        // Debounce the actual redraw (prevents multiple redraws during rapid pan/zoom)
        if (this.viewChangeTimer) {
            cancelAnimationFrame(this.viewChangeTimer);
        }
        
        this.viewChangeTimer = requestAnimationFrame(() => {
            this.viewChangeTimer = null;
            
            // Check if visible bounds actually changed
            const currentBounds = this.getVisibleBounds();
            const boundsChanged = !this.cachedVisibleBounds || 
                currentBounds.minX !== this.cachedVisibleBounds.minX ||
                currentBounds.minY !== this.cachedVisibleBounds.minY ||
                currentBounds.maxX !== this.cachedVisibleBounds.maxX ||
                currentBounds.maxY !== this.cachedVisibleBounds.maxY;
            
            const scaleChanged = this._lastNotifiedScale !== this.scale;

            // Only redraw if bounds actually changed
            if (boundsChanged) {
                this.cachedVisibleBounds = currentBounds;
                // Grid only needs full redraw when scale changes (stroke-width, spacing)
                if (this.gridDirty && scaleChanged) this._createGrid();
                if (this.paperDirty) this._drawPaperOutline();
                this._createRulers();
            }
            
            if (this.onViewChanged) {
                this._lastNotifiedScale = this.scale;
                this.onViewChanged({
                    offset: this.offset,
                    zoom: this.zoom,
                    bounds: currentBounds,
                    scaleChanged
                });
            }
        });  // Execute on next frame
    }
    
    // ==================== Grid ====================
    
    /**
     * Set the base grid spacing and redraw.
     * @param {number} size - Grid cell size in mm (clamped to >= 0.01).
     */
    setGridSize(size) {
        this.gridSize = Math.max(0.01, size);
        this.gridDirty = true;
        this._createGrid();
    }
    
    /**
     * Switch the grid rendering style.
     * @param {'lines'|'dots'} style - Grid style.
     */
    setGridStyle(style) {
        if (style === 'lines' || style === 'dots') {
            this.gridStyle = style;
            this.gridDirty = true;
            this._createGrid();
        }
    }
    
    /**
     * Show or hide the grid.
     * @param {boolean} visible - Whether the grid is visible.
     */
    setGridVisible(visible) {
        this.gridVisible = visible;
        this.gridDirty = true;
        this._createGrid();
    }
    
    /**
     * Rebuild the SVG grid pattern and axis lines for the current view.
     * Uses an SVG `<pattern>` covering 10× the viewport so panning doesn't
     * reveal empty edges before the next animation-frame redraw.
     */
    _createGrid() {
        // Clear existing grid
        this.gridLayer.innerHTML = '';
        this.axesLayer.innerHTML = '';
        
        if (!this.gridVisible) return;
        
        const bounds = this.getVisibleBounds();
        
        // Use the shared adaptive grid spacing calculation
        const gridSpacing = this.getEffectiveGridSize();
        
        // Large fixed coverage rect — pattern tiles automatically, no per-line DOM.
        // Use 10× viewport so pan doesn't reveal edges before next rAF redraw.
        const w = (bounds.maxX - bounds.minX) * 10;
        const h = (bounds.maxY - bounds.minY) * 10;
        const cx = (bounds.minX + bounds.maxX) / 2;
        const cy = (bounds.minY + bounds.maxY) / 2;
        const startX = cx - w / 2;
        const startY = cy - h / 2;
        
        // Line width in world units (1 screen pixel)
        const strokeWidth = 1 / this.scale;
        
        // Get theme colors
        const colors = this.themeColors || this._getThemeColors();
        
        if (this.gridStyle === 'dots') {
            // SVG pattern for dot grid
            const dotSize = strokeWidth * 2.5;
            const svg = `
                <defs>
                    <pattern id="gridPattern" x="0" y="0" width="${gridSpacing}" height="${gridSpacing}" patternUnits="userSpaceOnUse">
                        <circle cx="0" cy="0" r="${dotSize}" fill="${colors.gridMajor}"/>
                    </pattern>
                </defs>
                <rect x="${startX}" y="${startY}" width="${w}" height="${h}" fill="url(#gridPattern)"/>
            `;
            this.gridLayer.innerHTML = svg;
        } else {
            // SVG pattern for line grid — 2 lines per cell instead of hundreds of <line> elements
            const svg = `
                <defs>
                    <pattern id="gridPattern" x="0" y="0" width="${gridSpacing}" height="${gridSpacing}" patternUnits="userSpaceOnUse">
                        <line x1="0" y1="0" x2="0" y2="${gridSpacing}" stroke="${colors.gridMinor}" stroke-width="${strokeWidth}"/>
                        <line x1="0" y1="0" x2="${gridSpacing}" y2="0" stroke="${colors.gridMinor}" stroke-width="${strokeWidth}"/>
                    </pattern>
                </defs>
                <rect x="${startX}" y="${startY}" width="${w}" height="${h}" fill="url(#gridPattern)"/>
            `;
            this.gridLayer.innerHTML = svg;
        }
        
        // Axes  — only two lines
        const axes = `
            <g stroke="${colors.axis}" stroke-width="${strokeWidth}">
                <line x1="${startX}" y1="0" x2="${startX + w}" y2="0"/>
                <line x1="0" y1="${startY}" x2="0" y2="${startY + h}"/>
            </g>
        `;
        this.axesLayer.innerHTML = axes;
    }
    
    // ==================== Paper Size ====================
    
    /**
     * Set the paper size and redraw outline
     * @param {Object|null} paperSize - {width: mm, height: mm} or null to disable
     * @param {string|null} paperSizeKey - Name of the paper size (e.g., 'A4')
     */
    setPaperSize(paperSize, paperSizeKey = null) {
        this.paperSize = paperSize;
        this.paperSizeKey = paperSizeKey;
        this.paperDirty = true;
        this._drawPaperOutline();
    }

    /**
     * Toggle the title-block double-border with zone markers.
     * @param {boolean} show - Whether to display the border.
     */
    setTitleBlock(show) {
        this.showTitleBlock = show;
        this.paperDirty = true;
        this._drawPaperOutline();
    }

    /**
     * Toggle the title-block info box.
     * @param {boolean} show - Whether to display the info box.
     */
    setTitleBlockInfo(show) {
        this.showTitleBlockInfo = show;
        this.paperDirty = true;
        this._drawPaperOutline();
    }

    /**
     * Merge new values into the title-block data and redraw.
     * @param {Object} data - Key/value pairs (title, rev, company, etc.).
     */
    setTitleBlockData(data) {
        Object.assign(this.titleBlockData, data);
        this._persistTitleBlockData();
        this.paperDirty = true;
        this._drawPaperOutline();
    }

    _loadPersistedTitleBlockData() {
        try {
            const raw = localStorage.getItem(this._titleBlockStorageKey);
            if (!raw) return {};
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
            return {};
        }
    }

    _persistTitleBlockData() {
        try {
            localStorage.setItem(this._titleBlockStorageKey, JSON.stringify(this.titleBlockData));
            if (this.titleBlockData.company !== undefined) {
                localStorage.setItem('clearpcb_tb_company', this.titleBlockData.company || '');
            }
            if (this.titleBlockData.drawnBy !== undefined) {
                localStorage.setItem('clearpcb_tb_drawnBy', this.titleBlockData.drawnBy || '');
            }
        } catch {
            // ignore storage failures
        }
    }
    
    /**
     * Rebuild the paper-outline SVG: simple border or title-block border
     * with zone markers, plus the optional info box and paper-size label.
     */
    _drawPaperOutline() {
        // If reference is lost, try to find the layer in the SVG
        if (!this.paperOutlineLayer || !this.paperOutlineLayer.parentNode) {
            this.paperOutlineLayer = /** @type {SVGGElement|null} */ (this.svg.querySelector('#paperOutlineLayer'));
        }
        
        if (!this.paperOutlineLayer) return;
        
        // Ensure layer doesn't intercept mouse events
        this.paperOutlineLayer.setAttribute('pointer-events', 'none');
        
        this.paperOutlineLayer.innerHTML = '';
        if (!this.paperSize) return;
        
        const colors = this.themeColors || this._getThemeColors();
        const strokeWidth = 1 / this.scale;  // Same as grid
        
        const { width, height } = this.paperSize;
        // Position with bottom-left corner at origin
        const x = 0;
        const y = -height;
        
        let paperSvg = '';
        
        if (this.showTitleBlock) {
            // Double border with zone markers
            const margin = 4; // mm
            const outerSW = 0.5; // mm - fixed for print
            const innerSW = 0.25;
            // Target ~50mm per block (A4 landscape: 297/6≈49.5, 210/4≈52.5)
            const targetBlock = 50;
            const cols = Math.max(6, Math.round(width / targetBlock));
            const rows = Math.max(4, Math.round(height / targetBlock));
            const colW = width / cols;
            const rowH = height / rows;
            const fs = margin * 0.55; // label font size
            const color = colors.axis;
            
            // Outer border
            paperSvg += `<rect x="${x}" y="${y}" width="${width}" height="${height}" stroke="${color}" stroke-width="${outerSW}" fill="none"/>`;
            // Inner border
            paperSvg += `<rect x="${x + margin}" y="${y + margin}" width="${width - 2 * margin}" height="${height - 2 * margin}" stroke="${color}" stroke-width="${innerSW}" fill="none"/>`;
            
            // Column zone dividers & labels (top and bottom margins)
            for (let i = 0; i <= cols; i++) {
                const cx = x + i * colW;
                if (i > 0 && i < cols) {
                    paperSvg += `<line x1="${cx}" y1="${y}" x2="${cx}" y2="${y + margin}" stroke="${color}" stroke-width="${innerSW}"/>`;
                    paperSvg += `<line x1="${cx}" y1="${y + height - margin}" x2="${cx}" y2="${y + height}" stroke="${color}" stroke-width="${innerSW}"/>`;
                }
                if (i < cols) {
                    const lx = cx + colW / 2;
                    paperSvg += `<text x="${lx}" y="${y + margin / 2}" font-size="${fs}" fill="${color}" font-family="sans-serif" text-anchor="middle" dominant-baseline="central">${i + 1}</text>`;
                    paperSvg += `<text x="${lx}" y="${y + height - margin / 2}" font-size="${fs}" fill="${color}" font-family="sans-serif" text-anchor="middle" dominant-baseline="central">${i + 1}</text>`;
                }
            }
            
            // Row zone dividers & labels (left and right margins)
            for (let i = 0; i <= rows; i++) {
                const cy = y + i * rowH;
                if (i > 0 && i < rows) {
                    paperSvg += `<line x1="${x}" y1="${cy}" x2="${x + margin}" y2="${cy}" stroke="${color}" stroke-width="${innerSW}"/>`;
                    paperSvg += `<line x1="${x + width - margin}" y1="${cy}" x2="${x + width}" y2="${cy}" stroke="${color}" stroke-width="${innerSW}"/>`;
                }
                if (i < rows) {
                    const letter = String.fromCharCode(65 + i); // A, B, C, D, E, ...
                    const ly = cy + rowH / 2;
                    paperSvg += `<text x="${x + margin / 2}" y="${ly}" font-size="${fs}" fill="${color}" font-family="sans-serif" text-anchor="middle" dominant-baseline="central">${letter}</text>`;
                    paperSvg += `<text x="${x + width - margin / 2}" y="${ly}" font-size="${fs}" fill="${color}" font-family="sans-serif" text-anchor="middle" dominant-baseline="central">${letter}</text>`;
                }
            }
        } else {
            // Simple paper outline
            paperSvg += `<rect x="${x}" y="${y}" width="${width}" height="${height}" stroke="${colors.axis}" stroke-width="${strokeWidth}" fill="none"/>`;
        }

        // ── Title block info box (independent of border) ──
        if (this.showTitleBlockInfo) {
            const tbMargin = this.showTitleBlock ? 4 : 0; // inside inner border vs paper edge
            const tbSW = this.showTitleBlock ? 0.25 : Math.min(0.25, strokeWidth);
            const tbColor = colors.axis;
            paperSvg += this._renderTitleBlockInfo(x, y, width, height, tbMargin, tbSW, tbColor);
        }
        
        // Paper size label (top-right, outside the border)
        const label = this.paperSizeKey || 'Paper';
        const fontSize = Math.max(12 / this.scale, 2);
        paperSvg += `<text x="${x + width + 1}" y="${y - 1}" font-size="${fontSize}" fill="${colors.paperLabel}" font-family="sans-serif" text-anchor="end" font-weight="bold">${label}</text>`;
        
        this.paperOutlineLayer.innerHTML = paperSvg;
    }
    
    /**
     * Render the title block info box (EasyEDA-style) in the bottom-right corner.
     * Sits inside the inner border of the title block.
     */
    _renderTitleBlockInfo(px, py, pw, ph, margin, sw, color) {
        const d = /** @type {{title?: string, rev?: string, company?: string, date?: string, drawnBy?: string, sheet?: string}} */ (this.titleBlockData || {});
        // Info box dimensions (mm)
        const boxW = 120;
        const boxH = 30;
        const rightEdge = px + pw - margin;
        const bottomEdge = py + ph - margin;
        const bx = rightEdge - boxW;
        const by = bottomEdge - boxH;

        // Row heights: top row (title) = 15mm, bottom row = 15mm split into two sub-rows
        const topH = 15;
        const botH = 15;
        const subH = botH / 2;

        // Column splits
        const revW = 25;  // REV column width
        const sheetW = 25; // Sheet column width
        const titleW = boxW - revW;
        const companyDateW = boxW - sheetW;
        const dateW = 35;  // Date column; Drawn By gets the remainder

        // Font sizes
        const labelFs = 2;
        const valueFs = 3.5;
        const pad = 1.5;

        let s = '';

        // Outer box
        s += `<rect x="${bx}" y="${by}" width="${boxW}" height="${boxH}" stroke="${color}" stroke-width="${sw}" fill="none"/>`;

        // ── Top row: TITLE + REV ──
        // Vertical divider between title and rev
        s += `<line x1="${bx + titleW}" y1="${by}" x2="${bx + titleW}" y2="${by + topH}" stroke="${color}" stroke-width="${sw}"/>`;
        // Horizontal divider between top and bottom
        s += `<line x1="${bx}" y1="${by + topH}" x2="${bx + boxW}" y2="${by + topH}" stroke="${color}" stroke-width="${sw}"/>`;

        // Title label + value
        const titleFs = 4.5;
        s += `<text x="${bx + pad}" y="${by + pad + labelFs}" font-size="${labelFs}" fill="${color}" font-family="sans-serif">TITLE:</text>`;
        s += `<text x="${bx + pad}" y="${by + topH / 2 + titleFs / 2 + 2}" font-size="${titleFs}" fill="${color}" font-family="sans-serif">${this._escSvg(d.title || '')}</text>`;

        // Rev label + value
        const revX = bx + titleW;
        s += `<text x="${revX + pad}" y="${by + pad + labelFs}" font-size="${labelFs}" fill="${color}" font-family="sans-serif">REV:</text>`;
        s += `<text x="${revX + pad}" y="${by + topH / 2 + valueFs / 2 + 2}" font-size="${valueFs}" fill="${color}" font-family="sans-serif">${this._escSvg(d.rev || '')}</text>`;

        // ── Bottom row: Company/Date/DrawnBy + Sheet ──
        // Vertical divider between company/date and sheet
        s += `<line x1="${bx + companyDateW}" y1="${by + topH}" x2="${bx + companyDateW}" y2="${by + boxH}" stroke="${color}" stroke-width="${sw}"/>`;
        // Horizontal sub-divider (splits bottom into two sub-rows)
        s += `<line x1="${bx}" y1="${by + topH + subH}" x2="${bx + companyDateW}" y2="${by + topH + subH}" stroke="${color}" stroke-width="${sw}"/>`;
        // Vertical divider between date and drawn by in bottom sub-row
        s += `<line x1="${bx + dateW}" y1="${by + topH + subH}" x2="${bx + dateW}" y2="${by + boxH}" stroke="${color}" stroke-width="${sw}"/>`;

        // Company label + value (top of bottom row)
        const compY = by + topH;
        const bottomValY = compY + subH / 2 + valueFs / 3;
        s += `<text x="${bx + pad}" y="${bottomValY}" font-size="${labelFs}" fill="${color}" font-family="sans-serif">Company:</text>`;
        s += `<text x="${bx + pad + 10}" y="${bottomValY}" font-size="${valueFs}" fill="${color}" font-family="sans-serif">${this._escSvg(d.company || '')}</text>`;

        // Date label + value (bottom-left of bottom row)
        const dateY = compY + subH;
        const dateValY = dateY + subH / 2 + valueFs / 3;
        s += `<text x="${bx + pad}" y="${dateValY}" font-size="${labelFs}" fill="${color}" font-family="sans-serif">Date:</text>`;
        s += `<text x="${bx + pad + 6}" y="${dateValY}" font-size="${valueFs}" fill="${color}" font-family="sans-serif">${this._escSvg(d.date || '')}</text>`;

        // Drawn By label + value (bottom-right of bottom row, left of sheet)
        const drawnX = bx + dateW;
        s += `<text x="${drawnX + pad}" y="${dateValY}" font-size="${labelFs}" fill="${color}" font-family="sans-serif">Drawn By:</text>`;
        s += `<text x="${drawnX + pad + 10}" y="${dateValY}" font-size="${valueFs}" fill="${color}" font-family="sans-serif">${this._escSvg(d.drawnBy || '')}</text>`;

        // Sheet label + value
        const sheetX = bx + companyDateW;
        s += `<text x="${sheetX + pad}" y="${compY + pad + labelFs}" font-size="${labelFs}" fill="${color}" font-family="sans-serif">Sheet:</text>`;
        s += `<text x="${sheetX + pad}" y="${compY + botH / 2 + valueFs / 2}" font-size="${valueFs}" fill="${color}" font-family="sans-serif">${this._escSvg(d.sheet || '')}</text>`;

        // ── Transparent clickable rects for in-place editing ──
        const cells = [
            { key: 'title',   rx: bx,              ry: by,              rw: titleW,        rh: topH },
            { key: 'rev',     rx: bx + titleW,     ry: by,              rw: revW,          rh: topH },
            { key: 'company', rx: bx,              ry: by + topH,       rw: companyDateW,  rh: subH },
            { key: 'date',    rx: bx,              ry: by + topH + subH,rw: dateW,         rh: subH },
            { key: 'drawnBy', rx: bx + dateW,      ry: by + topH + subH,rw: companyDateW - dateW, rh: subH },
            { key: 'sheet',   rx: bx + companyDateW,ry: by + topH,      rw: sheetW,        rh: botH }
        ];
        for (const c of cells) {
            s += `<rect x="${c.rx}" y="${c.ry}" width="${c.rw}" height="${c.rh}" fill="none" pointer-events="all" data-tb-field="${c.key}" style="cursor:text"/>`;
        }

        return s;
    }

    /** Escape text for safe SVG embedding */
    _escSvg(str) {
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    /**
     * Handle double-click on title block cells for in-place editing.
     * Called from mouse.js when no shape was hit at the dblclick location.
     */
    _onTitleBlockDblClick(worldPos) {
        if (!this.showTitleBlockInfo || !this.paperSize) return false;

        // If already editing, cancel the current edit first
        if (this._titleBlockEditActive) {
            this._cancelTitleBlockEdit();
        }

        // Hit-test against the title block cell rects
        const rects = this.paperOutlineLayer.querySelectorAll('rect[data-tb-field]');
        let hitRect = null;
        for (const r of rects) {
            const rx = parseFloat(r.getAttribute('x'));
            const ry = parseFloat(r.getAttribute('y'));
            const rw = parseFloat(r.getAttribute('width'));
            const rh = parseFloat(r.getAttribute('height'));
            if (worldPos.x >= rx && worldPos.x <= rx + rw &&
                worldPos.y >= ry && worldPos.y <= ry + rh) {
                hitRect = r;
                break;
            }
        }
        if (!hitRect) return false;

        const field = hitRect.getAttribute('data-tb-field');
        this._titleBlockEditActive = true;
        this._titleBlockEditCancelled = false;

        // Get the cell rect bounds in SVG world coords
        const rx = parseFloat(hitRect.getAttribute('x'));
        const ry = parseFloat(hitRect.getAttribute('y'));
        const rw = parseFloat(hitRect.getAttribute('width'));
        const rh = parseFloat(hitRect.getAttribute('height'));

        // Dynamic text-width limit: measure actual text width against
        // the available space in the SVG cell instead of a fixed char count.
        // Text offsets account for inline labels (e.g. "Company:", "Date:").
        const textOffsets = { title: 1.5, rev: 1.5, company: 11.5, date: 7.5, drawnBy: 11.5, sheet: 1.5 };
        const fontSizes  = { title: 4.5, rev: 3.5, company: 3.5, date: 3.5, drawnBy: 3.5, sheet: 3.5 };
        const pad = 1.5;
        const availW = rw - (textOffsets[field] || pad) - pad;
        const svgFontSize = fontSizes[field] || 3.5;

        // Lazy-create a canvas context for text measurement
        if (!this._tbMeasureCtx) {
            this._tbMeasureCtx = document.createElement('canvas').getContext('2d');
        }
        const mCtx = this._tbMeasureCtx;
        const refPx = 200; // large reference size for accuracy
        mCtx.font = `${refPx}px sans-serif`;
        const textFits = (text) => {
            const measured = mCtx.measureText(text).width;
            return measured * (svgFontSize / refPx) <= availW;
        };

        // Convert corners to screen coords (relative to SVG element)
        const topLeft = this.worldToScreen({ x: rx, y: ry });
        const botRight = this.worldToScreen({ x: rx + rw, y: ry + rh });
        const svgRect = this.svg.getBoundingClientRect();

        const left = svgRect.left + topLeft.x;
        const top = svgRect.top + topLeft.y;
        const w = botRight.x - topLeft.x;
        const h = botRight.y - topLeft.y;

        // Create HTML input overlay
        const input = document.createElement('input');
        input.type = 'text';
        input.value = this.titleBlockData[field] || '';
        input.style.cssText = `
            position: fixed;
            left: ${left}px;
            top: ${top}px;
            width: ${w}px;
            height: ${h}px;
            box-sizing: border-box;
            border: 2px solid #0078d4;
            border-radius: 0;
            padding: 0 3px;
            margin: 0;
            font-family: sans-serif;
            font-size: ${Math.max(10, h * 0.35)}px;
            background: var(--sch-bg, #1e1e1e);
            color: var(--sch-fg, #ccc);
            outline: none;
            z-index: 10000;
        `;
        document.body.appendChild(input);
        input.focus();
        input.select();

        // Enforce dynamic width limit on every keystroke
        let lastGoodValue = input.value;
        input.addEventListener('input', () => {
            if (textFits(input.value)) {
                lastGoodValue = input.value;
            } else {
                // Revert to last value that fit and restore cursor position
                const pos = Math.max(0, input.selectionStart - 1);
                input.value = lastGoodValue;
                input.setSelectionRange(pos, pos);
            }
        });

        const commit = () => {
            if (this._titleBlockEditCancelled || !input.parentNode) return;
            const val = input.value;
            this.setTitleBlockData({ [field]: val });
            document.body.removeChild(input);
            this._titleBlockEditActive = false;
            this._titleBlockEditInput = null;
        };

        const cancel = () => {
            if (!input.parentNode) return;
            this._titleBlockEditCancelled = true;
            document.body.removeChild(input);
            this._titleBlockEditActive = false;
            this._titleBlockEditInput = null;
        };

        // Click outside the input → commit
        const onMouseDown = (ev) => {
            if (ev.target !== input) {
                ev.preventDefault();
                document.removeEventListener('mousedown', onMouseDown, true);
                commit();
            }
        };
        document.addEventListener('mousedown', onMouseDown, true);

        input.addEventListener('blur', () => {
            // Defer to let mousedown handler run first
            setTimeout(() => {
                document.removeEventListener('mousedown', onMouseDown, true);
                commit();
            }, 0);
        });
        input.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') {
                ev.preventDefault();
                document.removeEventListener('mousedown', onMouseDown, true);
                commit();
            } else if (ev.key === 'Escape') {
                ev.preventDefault();
                ev.stopPropagation();
                document.removeEventListener('mousedown', onMouseDown, true);
                cancel();
            }
        });

        // Store reference so we can cancel externally
        this._titleBlockEditInput = input;
        this._cancelTitleBlockEdit = cancel;

        return true;
    }

    // ==================== Rulers ====================
    
    /**
     * Rebuild the ruler SVGs (top + left) for the current view and units.
     * Computes adaptive tick spacing using unit-appropriate nice-number sequences.
     */
    _createRulers() {
        if (!this.showRulers) {
            this.rulerContainer.innerHTML = '';
            return;
        }
        
        const rs = this.rulerSize;
        const w = this.width;
        const h = this.height;
        const bounds = this.getVisibleBounds();
        
        // Calculate tick spacing based on display units
        const targetPixels = 80;
        const targetMm = targetPixels / this.scale;
        const targetDisplay = targetMm * this.unitConversions[this.units];
        
        // Choose nice tick spacing based on current units
        let tickSpacingMm;
        
        if (this.units === 'inch') {
            // Inch-based nice numbers: 0.0625" (1/16), 0.125" (1/8), 0.25" (1/4), 0.5", 1", 2", 5", 10"
            const niceInches = [0.0625, 0.125, 0.25, 0.5, 1, 2, 5, 10];
            let tickSpacingInch = 0.125;
            for (const n of niceInches) {
                if (n >= targetDisplay) {
                    tickSpacingInch = n;
                    break;
                }
            }
            tickSpacingMm = tickSpacingInch / this.unitConversions['inch']; // Convert back to mm
        } else if (this.units === 'mil') {
            // Mil-based nice numbers: 10, 25, 50, 100, 250, 500, 1000, 2500, 5000
            const niceMils = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
            let tickSpacingMil = 100;
            for (const n of niceMils) {
                if (n >= targetDisplay) {
                    tickSpacingMil = n;
                    break;
                }
            }
            tickSpacingMm = tickSpacingMil / this.unitConversions['mil']; // Convert back to mm
        } else {
            // mm-based nice numbers
            const niceNumbersMm = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
            tickSpacingMm = 1;
            for (const n of niceNumbersMm) {
                if (n >= targetMm) {
                    tickSpacingMm = n;
                    break;
                }
            }
        }
        
        // Unit-specific formatting
        const unitConversion = this.unitConversions[this.units];
        const unitSuffix = this.units === 'inch' ? '"' : (this.units === 'mil' ? '' : '');
        
        // Determine decimal places based on tick spacing in display units
        const tickSpacingDisplay = tickSpacingMm * unitConversion;
        let decimals = 0;
        if (tickSpacingDisplay < 0.01) decimals = 4;
        else if (tickSpacingDisplay < 0.1) decimals = 3;
        else if (tickSpacingDisplay < 1) decimals = 2;
        else if (tickSpacingDisplay < 10) decimals = 1;
        else decimals = 0;
        
        const formatLabel = (mmVal) => {
            const displayVal = mmVal * unitConversion;
            // Clean up floating point artifacts
            const rounded = Math.round(displayVal / (tickSpacingDisplay / 10)) * (tickSpacingDisplay / 10);
            let str = rounded.toFixed(decimals);
            // Remove trailing zeros after decimal point
            if (decimals > 0) {
                str = str.replace(/\.?0+$/, '');
            }
            return str + unitSuffix;
        };
        
        // Get theme colors
        const colors = this.themeColors || this._getThemeColors();
        
        // Build ruler SVG
        let svg = `<svg width="${w}" height="${h}" style="position:absolute;top:0;left:0;">`;
        
        // Backgrounds
        svg += `<rect x="0" y="0" width="${w}" height="${rs}" fill="${colors.rulerBg}"/>`;
        svg += `<rect x="0" y="${rs}" width="${rs}" height="${h - rs}" fill="${colors.rulerBg}"/>`;
        svg += `<rect x="0" y="0" width="${rs}" height="${rs}" fill="${colors.rulerBg}"/>`;
        
        // Top ruler ticks and labels
        const startX = Math.floor(bounds.minX / tickSpacingMm) * tickSpacingMm;
        const endX = Math.ceil(bounds.maxX / tickSpacingMm) * tickSpacingMm;
        
        for (let worldX = startX; worldX <= endX; worldX += tickSpacingMm) {
            const screenX = this.worldToScreen({ x: worldX, y: 0 }).x;
            if (screenX > w) continue;
            
            if (screenX >= rs) {
                svg += `<line x1="${screenX}" y1="${rs}" x2="${screenX}" y2="${rs - 8}" stroke="${colors.rulerLine}"/>`;
                svg += `<text x="${screenX + 2}" y="12" fill="${colors.rulerText}" font-size="10" font-family="monospace">${formatLabel(worldX)}</text>`;
            }
            
            // Minor ticks
            for (let i = 1; i < 5; i++) {
                const minorX = worldX + (tickSpacingMm / 5) * i;
                const minorScreenX = this.worldToScreen({ x: minorX, y: 0 }).x;
                if (minorScreenX > rs && minorScreenX < w) {
                    svg += `<line x1="${minorScreenX}" y1="${rs}" x2="${minorScreenX}" y2="${rs - 4}" stroke="${colors.rulerLine}"/>`;
                }
            }
        }
        
        // Left ruler ticks and labels
        const startY = Math.floor(bounds.minY / tickSpacingMm) * tickSpacingMm;
        const endY = Math.ceil(bounds.maxY / tickSpacingMm) * tickSpacingMm;
        
        for (let worldY = startY; worldY <= endY; worldY += tickSpacingMm) {
            const screenY = this.worldToScreen({ x: 0, y: worldY }).y;
            if (screenY < rs || screenY > h) continue;
            
            svg += `<line x1="${rs}" y1="${screenY}" x2="${rs - 8}" y2="${screenY}" stroke="${colors.rulerLine}"/>`;
            svg += `<text x="3" y="${screenY + 3}" fill="${colors.rulerText}" font-size="10" font-family="monospace">${formatLabel(-worldY)}</text>`;
            
            // Minor ticks
            for (let i = 1; i < 5; i++) {
                const minorY = worldY + (tickSpacingMm / 5) * i;
                const minorScreenY = this.worldToScreen({ x: 0, y: minorY }).y;
                if (minorScreenY > rs && minorScreenY < h) {
                    svg += `<line x1="${rs}" y1="${minorScreenY}" x2="${rs - 4}" y2="${minorScreenY}" stroke="${colors.rulerLine}"/>`;
                }
            }
        }
        
        // Borders
        svg += `<line x1="${rs}" y1="0" x2="${rs}" y2="${h}" stroke="${colors.rulerBorder}"/>`;
        svg += `<line x1="0" y1="${rs}" x2="${w}" y2="${rs}" stroke="${colors.rulerBorder}"/>`;

        // Mouse-position indicators on rulers
        svg += `<line id="rulerCursorX" x1="${rs}" y1="0" x2="${rs}" y2="${rs}" stroke="${colors.axis}" stroke-width="1" stroke-opacity="0.9"/>`;
        svg += `<line id="rulerCursorY" x1="0" y1="${rs}" x2="${rs}" y2="${rs}" stroke="${colors.axis}" stroke-width="1" stroke-opacity="0.9"/>`;
        
        svg += '</svg>';
        this.rulerContainer.innerHTML = svg;
        this._rulerCursorXLine = this.rulerContainer.querySelector('#rulerCursorX');
        this._rulerCursorYLine = this.rulerContainer.querySelector('#rulerCursorY');
        this._updateRulerCursor();
    }

    /** Update ruler mouse-position indicators without rebuilding ruler ticks/labels. */
    _updateRulerCursor() {
        if (!this.showRulers || !this.rulerContainer.firstElementChild) return;

        const rs = this.rulerSize;
        const w = this.width;
        const h = this.height;
        const screen = this.worldToScreen(this.currentMouseWorld || { x: 0, y: 0 });

        const cx = Math.max(rs, Math.min(w, screen.x));
        const cy = Math.max(rs, Math.min(h, screen.y));

        if (this._rulerCursorXLine) {
            this._rulerCursorXLine.setAttribute('x1', String(cx));
            this._rulerCursorXLine.setAttribute('x2', String(cx));
        }

        if (this._rulerCursorYLine) {
            this._rulerCursorYLine.setAttribute('y1', String(cy));
            this._rulerCursorYLine.setAttribute('y2', String(cy));
        }
    }
    
    // ==================== Units ====================
    
    /**
     * Switch display units and refresh rulers.
     * @param {'mm'|'mil'|'inch'} units - Target unit system.
     */
    setUnits(units) {
        if (this.unitConversions[units] && units !== this.units) {
            this.units = units;
            this._createRulers();
            this._notifyViewChanged();
        }
    }
    
    /**
     * Convert mm to current display units
     */
    toDisplayUnits(mmValue) {
        return mmValue * this.unitConversions[this.units];
    }
    
    /**
     * Convert current display units to mm
     */
    fromDisplayUnits(displayValue) {
        return displayValue / this.unitConversions[this.units];
    }
    
    /**
     * Format a world value (mm) for display in current units
     */
    formatValue(worldValue, precision = 2) {
        const converted = worldValue * this.unitConversions[this.units];
        return converted.toFixed(precision);
    }
    
    /**
     * Get sensible grid size options for current units
     * Returns array of { value: mm, label: string }
     */
    getGridOptions() {
        switch (this.units) {
            case 'mil':
                return [
                    { value: 0.0254, label: '1 mil' },
                    { value: 0.127, label: '5 mil' },
                    { value: 0.254, label: '10 mil' },
                    { value: 0.635, label: '25 mil' },
                    { value: 1.27, label: '50 mil' },
                    { value: 2.54, label: '100 mil' }
                ];
            case 'inch':
                return [
                    { value: 0.0254, label: '0.001"' },
                    { value: 0.127, label: '0.005"' },
                    { value: 0.254, label: '0.01"' },
                    { value: 0.635, label: '0.025"' },
                    { value: 1.27, label: '0.05"' },
                    { value: 2.54, label: '0.1"' }
                ];
            case 'mm':
            default:
                return [
                    { value: 0.1, label: '0.1 mm' },
                    { value: 0.25, label: '0.25 mm' },
                    { value: 0.5, label: '0.5 mm' },
                    { value: 1, label: '1 mm' },
                    { value: 1.27, label: '1.27 mm (50 mil)' },
                    { value: 2.54, label: '2.54 mm (100 mil)' }
                ];
        }
    }
    
    // ==================== Browser Zoom Prevention ====================
    
    /** Prevent Ctrl+Plus/Minus/0 from triggering the browser's native zoom. */
    _disableBrowserZoom() {
        // Prevent Ctrl+Plus/Minus/0 browser zoom
        this.boundHandlers.browserZoom = (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
            if ((e.ctrlKey || e.metaKey) && (e.key === '+' || e.key === '-' || e.key === '=' || e.key === '0')) {
                e.preventDefault();
            }
        };
        window.addEventListener('keydown', this.boundHandlers.browserZoom);

        // Prevent Ctrl+wheel browser zoom anywhere in the app (not just SVG)
        this.boundHandlers.browserWheelZoom = (e) => {
            if ((e.ctrlKey || e.metaKey) && e.deltaY !== 0) {
                e.preventDefault();
            }
        };
        window.addEventListener('wheel', this.boundHandlers.browserWheelZoom, { passive: false });
    }
    
    // ==================== Events ====================
    
    /** Bind wheel, mouse, keyboard, and resize event handlers to the SVG and window. */
    _bindEvents() {
        // Store handlers for cleanup
        this.boundHandlers.wheel = (e) => {
            e.preventDefault(); // Always prevent default to block browser zoom
            
            const rect = this._getCachedRect();
            const mouseScreen = {
                x: e.clientX - rect.left,
                y: e.clientY - rect.top
            };
            const mouseWorld = this.screenToWorld(mouseScreen);
            
            // Trackpad pinch-to-zoom fires as ctrlKey + wheel in most browsers.
            // Detect it: ctrlKey is set, but deltaMode is 0 (pixel) and deltaY
            // is a small fractional value (not the ±100/±120 of a real mouse wheel).
            const isTrackpadPinch = (e.ctrlKey || e.metaKey) &&
                                    e.deltaMode === 0 &&
                                    Math.abs(e.deltaY) < 50;

            if (isTrackpadPinch) {
                // Treat as zoom (same as regular wheel)
                if (e.deltaY > 0) {
                    this.zoomOut(mouseWorld);
                } else if (e.deltaY < 0) {
                    this.zoomIn(mouseWorld);
                }
            } else if (e.ctrlKey || e.metaKey) {
                // Real Ctrl+wheel: pan vertically
                const panAmount = (this.viewBox.width / 10) * Math.sign(e.deltaY);
                this.viewBox.y += panAmount;
                this._updateViewBox();
                this._notifyViewChanged();
            } else if (e.shiftKey) {
                // Shift+wheel: pan horizontally
                const panAmount = (this.viewBox.width / 10) * Math.sign(e.deltaY);
                this.viewBox.x += panAmount;
                this._updateViewBox();
                this._notifyViewChanged();
            } else {
                // Regular wheel: zoom
                if (e.deltaY > 0) {
                    this.zoomOut(mouseWorld);
                } else if (e.deltaY < 0) {
                    this.zoomIn(mouseWorld);
                }
            }
        };
        
        // Pan start
        // NOTE: pan mousedown/mousemove/mouseup are handled by the state machine
        // in mouse.js / mouse-states.js. Viewport exposes startPan / updatePan / endPan
        // methods instead. Only wheel, contextmenu, resize, and keyboard stay here.
        
        // Prevent context menu (state machine handles right-click logic)
        // Handle resize
        this.boundHandlers.resize = () => {
            this._onResize();
        };
        
        // Attach handlers (no mousedown/mousemove/mouseup/contextmenu — those are in mouse.js)
        this.svg.addEventListener('wheel', this.boundHandlers.wheel, { passive: false });
        window.addEventListener('resize', this.boundHandlers.resize);
        
        // Keyboard
        this.boundHandlers.keydown = (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
            
            switch (e.key) {
                case 'Home':
                    this.resetView();
                    break;
                // 'F' for fit-to-content handled in keyboard.js (needs app context)
            }
        };
        window.addEventListener('keydown', this.boundHandlers.keydown);
    }
    
    /**
     * Cleanup event listeners to prevent memory leaks
     */
    destroy() {
        if (this.viewChangeTimer) {
            cancelAnimationFrame(this.viewChangeTimer);
            this.viewChangeTimer = null;
        }
        if (this.boundHandlers.wheel) this.svg.removeEventListener('wheel', this.boundHandlers.wheel);
        if (this.boundHandlers.resize) window.removeEventListener('resize', this.boundHandlers.resize);
        if (this.boundHandlers.keydown) window.removeEventListener('keydown', this.boundHandlers.keydown);
        if (this.boundHandlers.browserZoom) window.removeEventListener('keydown', this.boundHandlers.browserZoom);
        if (this.boundHandlers.browserWheelZoom) window.removeEventListener('wheel', this.boundHandlers.browserWheelZoom);
        
        // Remove SVG element
        if (this.svg.parentNode) {
            this.svg.parentNode.removeChild(this.svg);
        }
        
        // Clear ruler container
        if (this.rulerContainer && this.rulerContainer.parentNode) {
            this.rulerContainer.parentNode.removeChild(this.rulerContainer);
        }
    }
    
    // ==================== Content Management ====================
    
    /**
     * Append an SVG element to the main content layer.
     * @param {SVGElement} svgElement - Element to add.
     */
    addContent(svgElement) {
        this.contentLayer.appendChild(svgElement);
    }
    
    /**
     * Remove an SVG element from the content or component layer.
     * @param {SVGElement} svgElement - Element to remove.
     */
    removeContent(svgElement) {
        if (svgElement.parentNode === this.contentLayer ||
            svgElement.parentNode === this.componentLayer) {
            svgElement.parentNode.removeChild(svgElement);
        }
    }

    /**
     * Append an SVG element to the component sub-layer (rendered below shapes).
     * @param {SVGElement} svgElement - Element to add.
     */
    addComponentContent(svgElement) {
        this.componentLayer.appendChild(svgElement);
    }
    
    /**
     * Create a detached SVG `<g>` element.
     * @returns {SVGGElement} New group element.
     */
    createGroup() {
        return document.createElementNS('http://www.w3.org/2000/svg', 'g');
    }
    
    // For compatibility with shape system
    get app() {
        return { view: this.svg };
    }
}