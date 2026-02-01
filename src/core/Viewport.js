/**
 * ViewportSVG - SVG-based viewport with pan/zoom
 * 
 * Uses SVG viewBox for pan/zoom - mathematically perfect scaling.
 */

export class Viewport {
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
        this.axesLayer = this._createGroup('axesLayer');
        this.rulerLayer = null; // Rulers are in screen space, handled separately
        
        // Create ruler container (HTML overlay)
        this.rulerContainer = document.createElement('div');
        this.rulerContainer.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;';
        container.appendChild(this.rulerContainer);
        
        // View state - viewBox defines visible world area
        this.baseWidth = 200; // mm visible at 100% zoom (for display purposes)
        
        // Zoom levels with clean 1-2-5 percentage progression
        // View width = baseWidth / (zoomPercent / 100) = 20000 / zoomPercent
        // Zoom percentages: 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000
        this.zoomLevels = [
            20000,  // 1%
            10000,  // 2%
            4000,   // 5%
            2000,   // 10%
            1000,   // 20%
            400,    // 50%
            200,    // 100%
            100,    // 200%
            40,     // 500%
            20,     // 1000%
            10,     // 2000%
            4,      // 5000%
            2       // 10000%
        ];
        this.zoomIndex = 6; // Start at 200mm (index 6) = 100% zoom
        
        this.viewBox = { x: -100, y: -60, width: 200, height: 120 };
        
        // Constraints (index bounds)
        this.minZoomIndex = 0;
        this.maxZoomIndex = this.zoomLevels.length - 1;
        
        // Grid
        this.gridSize = 1;
        this.gridVisible = true;
        this.gridStyle = 'lines';
        
        // Rulers
        this.rulerSize = 25;
        this.showRulers = true;
        
        // Snapping
        this.snapToGrid = true;
        
        // Paper size
        this.paperSize = null;  // null = no paper outline
        this.paperSizeKey = null;  // Name of the paper size (e.g., 'A4')
        
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
        
        // Cache for getBoundingClientRect (expensive operation)
        this.cachedRect = null;
        this.cachedRectTime = 0;
        const RECT_CACHE_TTL = 10;  // Cache for 10ms (covers most of a frame)
        
        // Cache for viewport change optimization
        this.cachedVisibleBounds = null;
        this.viewChangeTimer = null;
        this.gridDirty = true;  // Track if grid needs redraw
        this.paperDirty = true; // Track if paper outline needs redraw
        
        // Callbacks
        this.onViewChanged = null;
        this.onMouseMove = null;
        
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
        
        // Handle resize
        window.addEventListener('resize', () => {
            this._onResize();
        });
    }
    
    _createGroup(id) {
        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.setAttribute('id', id);
        this.svg.appendChild(g);
        return g;
    }
    
    get width() {
        return this.svg.clientWidth || this.container.clientWidth;
    }
    
    get height() {
        return this.svg.clientHeight || this.container.clientHeight;
    }
    
    get scale() {
        // Pixels per world unit
        return this.width / this.viewBox.width;
    }
    
    get zoom() {
        // Zoom multiplier (1.0 = 100% = baseWidth visible)
        return this.baseWidth / this.viewBox.width;
    }
    
    get viewWidth() {
        // Current view width in mm
        return this.viewBox.width;
    }
    
    get offset() {
        // Center of viewBox in world coords
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
            canvasBg: style.getPropertyValue('--sch-background').trim() || '#1a1a2e',
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
    }

    // ==================== View Management ====================
    
    _updateViewBox() {
        const vb = this.viewBox;
        this.svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.width} ${vb.height}`);
    }
    
    _onResize() {
        // Invalidate rect cache since viewport dimensions changed
        this.cachedRect = null;
        
        // Maintain aspect ratio - adjust height to match new container
        const aspect = this.height / this.width;
        this.viewBox.height = this.viewBox.width * aspect;
        this._updateViewBox();
        this._createGrid();
        this._createRulers();
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
    
    screenToWorld(screenPos) {
        const rect = this._getCachedRect();
        const x = this.viewBox.x + (screenPos.x / rect.width) * this.viewBox.width;
        const y = this.viewBox.y + (screenPos.y / rect.height) * this.viewBox.height;
        return { x, y };
    }
    
    worldToScreen(worldPos) {
        const rect = this._getCachedRect();
        const x = ((worldPos.x - this.viewBox.x) / this.viewBox.width) * rect.width;
        const y = ((worldPos.y - this.viewBox.y) / this.viewBox.height) * rect.height;
        return { x, y };
    }
    
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
    
    getSnappedPosition(worldPos) {
        if (!this.snapToGrid) return worldPos;
        // Always snap to base grid size for precision
        return {
            x: Math.round(worldPos.x / this.gridSize) * this.gridSize,
            y: Math.round(worldPos.y / this.gridSize) * this.gridSize
        };
    }
    
    pan(dx, dy) {
        this.viewBox.x += dx;
        this.viewBox.y += dy;
        this._updateViewBox();
        this._notifyViewChanged();
    }
    
    zoomAt(worldPoint, factor) {
        // Determine zoom direction and step
        // factor > 1 means zoom in (higher index = smaller view width)
        const step = factor > 1 ? 1 : -1;
        this.zoomToLevel(this.zoomIndex + step, worldPoint);
    }
    
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
        this._createGrid();
        this._createRulers();
        this._notifyViewChanged();
    }
    
    zoomIn(worldPoint = null) {
        this.zoomToLevel(this.zoomIndex + 1, worldPoint);
    }
    
    zoomOut(worldPoint = null) {
        this.zoomToLevel(this.zoomIndex - 1, worldPoint);
    }
    
    resetView() {
        // Reset to 100% zoom (200mm view width, index 6)
        // Position origin 10mm in from right edge and 10mm up from bottom edge
        this.zoomIndex = 6;
        const aspect = this.height / this.width;
        this.viewBox.width = this.zoomLevels[this.zoomIndex];
        this.viewBox.height = this.viewBox.width * aspect;
        
        // Position so origin (0,0) is 10mm from left and 10mm from bottom
        const margin = 10; // mm from edges
        this.viewBox.x = -margin;   // Right edge at x=10, so origin at 10 from right
        this.viewBox.y = margin - this.viewBox.height;  // Bottom edge at y=10, so origin at 10 from bottom
        
        this._updateViewBox();
        this._createGrid();
        this._createRulers();
        this._notifyViewChanged();
    }
    
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
        this._createGrid();
        this._createRulers();
        this._notifyViewChanged();
    }
    
    fitToContent() {
        this.fitToBounds(-50, -50, 50, 50);
    }
    
    getVisibleBounds() {
        return {
            minX: this.viewBox.x,
            minY: this.viewBox.y,
            maxX: this.viewBox.x + this.viewBox.width,
            maxY: this.viewBox.y + this.viewBox.height
        };
    }
    
    _notifyViewChanged() {
        // Mark as dirty for lazy redraw
        this.gridDirty = true;
        this.paperDirty = true;
        
        // Debounce the actual redraw (prevents multiple redraws during rapid pan/zoom)
        if (this.viewChangeTimer) {
            clearTimeout(this.viewChangeTimer);
        }
        
        this.viewChangeTimer = setTimeout(() => {
            this.viewChangeTimer = null;
            
            // Check if visible bounds actually changed
            const currentBounds = this.getVisibleBounds();
            const boundsChanged = !this.cachedVisibleBounds || 
                currentBounds.minX !== this.cachedVisibleBounds.minX ||
                currentBounds.minY !== this.cachedVisibleBounds.minY ||
                currentBounds.maxX !== this.cachedVisibleBounds.maxX ||
                currentBounds.maxY !== this.cachedVisibleBounds.maxY;
            
            // Only redraw if bounds actually changed
            if (boundsChanged) {
                this.cachedVisibleBounds = currentBounds;
                if (this.gridDirty) this._createGrid();
                if (this.paperDirty) this._drawPaperOutline();
            }
            
            if (this.onViewChanged) {
                this.onViewChanged({
                    offset: this.offset,
                    zoom: this.zoom,
                    bounds: currentBounds
                });
            }
        }, 0);  // Execute on next frame
    }
    
    // ==================== Grid ====================
    
    setGridSize(size) {
        this.gridSize = Math.max(0.01, size);
        this.gridDirty = true;
        this._createGrid();
    }
    
    setGridStyle(style) {
        if (style === 'lines' || style === 'dots') {
            this.gridStyle = style;
            this.gridDirty = true;
            this._createGrid();
        }
    }
    
    setGridVisible(visible) {
        this.gridVisible = visible;
        this.gridDirty = true;
        this._createGrid();
    }
    
    _createGrid() {
        // Clear existing grid
        this.gridLayer.innerHTML = '';
        this.axesLayer.innerHTML = '';
        
        if (!this.gridVisible) return;
        
        const bounds = this.getVisibleBounds();
        const margin = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
        
        // Use the shared adaptive grid spacing calculation
        const gridSpacing = this.getEffectiveGridSize();
        
        // Calculate range for lines/axes
        const startX = Math.floor((bounds.minX - margin) / gridSpacing) * gridSpacing;
        const endX = Math.ceil((bounds.maxX + margin) / gridSpacing) * gridSpacing;
        const startY = Math.floor((bounds.minY - margin) / gridSpacing) * gridSpacing;
        const endY = Math.ceil((bounds.maxY + margin) / gridSpacing) * gridSpacing;
        
        // Line width in world units (1 screen pixel)
        const strokeWidth = 1 / this.scale;
        
        // Get theme colors
        const colors = this.themeColors || this._getThemeColors();
        
        if (this.gridStyle === 'dots') {
            // Use SVG pattern for efficient dot grid
            const dotSize = strokeWidth * 2.5;
            const patternId = 'dotPattern';
            
            // Pattern origin aligns with world grid
            const patternX = Math.floor(startX / gridSpacing) * gridSpacing;
            const patternY = Math.floor(startY / gridSpacing) * gridSpacing;
            
            const svg = `
                <defs>
                    <pattern id="${patternId}" x="${patternX}" y="${patternY}" width="${gridSpacing}" height="${gridSpacing}" patternUnits="userSpaceOnUse">
                        <circle cx="0" cy="0" r="${dotSize}" fill="${colors.gridMajor}"/>
                    </pattern>
                </defs>
                <rect x="${startX}" y="${startY}" width="${endX - startX}" height="${endY - startY}" fill="url(#${patternId})"/>
            `;
            this.gridLayer.innerHTML = svg;
        } else {
            // Line grid
            let lines = `<g stroke="${colors.gridMinor}" stroke-width="${strokeWidth}">`;
            
            for (let x = startX; x <= endX; x += gridSpacing) {
                if (Math.abs(x) < gridSpacing / 2) continue;
                lines += `<line x1="${x}" y1="${startY}" x2="${x}" y2="${endY}"/>`;
            }
            
            for (let y = startY; y <= endY; y += gridSpacing) {
                if (Math.abs(y) < gridSpacing / 2) continue;
                lines += `<line x1="${startX}" y1="${y}" x2="${endX}" y2="${y}"/>`;
            }
            
            lines += '</g>';
            this.gridLayer.innerHTML = lines;
        }
        
        // Axes
        const axes = `
            <g stroke="${colors.axis}" stroke-width="${strokeWidth}">
                <line x1="${startX}" y1="0" x2="${endX}" y2="0"/>
                <line x1="0" y1="${startY}" x2="0" y2="${endY}"/>
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
    
    _drawPaperOutline() {
        // If reference is lost, try to find the layer in the SVG
        if (!this.paperOutlineLayer || !this.paperOutlineLayer.parentNode) {
            this.paperOutlineLayer = this.svg.querySelector('#paperOutlineLayer');
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
        
        // Draw paper outline with label at top right, outside the corner
        const label = this.paperSizeKey || 'Paper';
        const fontSize = Math.max(12 / this.scale, 2);  // Bigger font
        const paperSvg = `
            <rect x="${x}" y="${y}" width="${width}" height="${height}" stroke="${colors.axis}" stroke-width="${strokeWidth}" fill="none"/>
            <text x="${x + width + 1}" y="${y - 1}" font-size="${fontSize}" fill="${colors.paperLabel}" font-family="sans-serif" text-anchor="end" font-weight="bold">${label}</text>
        `;
        this.paperOutlineLayer.innerHTML = paperSvg;
    }
    
    // ==================== Rulers ====================
    
    _createRulers() {
        if (!this.showRulers) {
            this.rulerContainer.innerHTML = '';
            return;
        }
        
        const rs = this.rulerSize;
        const w = this.width;
        const h = this.height;
        const bounds = this.getVisibleBounds();
        
        // Calculate tick spacing in mm, then convert for display
        const targetPixels = 80;
        const targetMm = targetPixels / this.scale;
        
        // Nice numbers in mm - we'll pick one and display in current units
        const niceNumbersMm = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
        let tickSpacingMm = 1;
        for (const n of niceNumbersMm) {
            if (n >= targetMm) {
                tickSpacingMm = n;
                break;
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
        
        // Debug info - show view width in current units
        const viewWidthDisplay = Math.round((bounds.maxX - bounds.minX) * unitConversion * 10) / 10;
        const unitLabel = this.units === 'inch' ? '"' : this.units;
        svg += `<text x="3" y="15" fill="${colors.rulerText}" font-size="9" font-family="monospace">${viewWidthDisplay}${unitLabel}</text>`;
        
        // Top ruler ticks and labels
        const startX = Math.floor(bounds.minX / tickSpacingMm) * tickSpacingMm;
        const endX = Math.ceil(bounds.maxX / tickSpacingMm) * tickSpacingMm;
        
        for (let worldX = startX; worldX <= endX; worldX += tickSpacingMm) {
            const screenX = this.worldToScreen({ x: worldX, y: 0 }).x;
            if (screenX < rs || screenX > w) continue;
            
            svg += `<line x1="${screenX}" y1="${rs}" x2="${screenX}" y2="${rs - 8}" stroke="${colors.rulerLine}"/>`;
            svg += `<text x="${screenX + 2}" y="12" fill="${colors.rulerText}" font-size="10" font-family="monospace">${formatLabel(worldX)}</text>`;
            
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
            svg += `<text x="3" y="${screenY + 3}" fill="${colors.rulerText}" font-size="10" font-family="monospace">${formatLabel(worldY)}</text>`;
            
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
        
        svg += '</svg>';
        this.rulerContainer.innerHTML = svg;
    }
    
    // ==================== Units ====================
    
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
    
    _disableBrowserZoom() {
        // Prevent Ctrl+wheel browser zoom
        // (handled in wheel event below)
        
        // Prevent Ctrl+Plus/Minus/0 browser zoom
        window.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && (e.key === '+' || e.key === '-' || e.key === '=' || e.key === '0')) {
                e.preventDefault();
            }
        });
    }
    
    // ==================== Events ====================
    
    _bindEvents() {
        // Store handlers for cleanup
        this.boundHandlers.wheel = (e) => {
            e.preventDefault(); // Always prevent default to block browser zoom
            
            const rect = this.svg.getBoundingClientRect();
            const mouseScreen = {
                x: e.clientX - rect.left,
                y: e.clientY - rect.top
            };
            const mouseWorld = this.screenToWorld(mouseScreen);
            
            // Pan amount in world units (scale by view size for consistent feel)
            const panAmount = (this.viewBox.width / 10) * Math.sign(e.deltaY);
            
            if (e.ctrlKey || e.metaKey) {
                // Ctrl+wheel: pan vertically
                this.viewBox.y += panAmount;
                this._updateViewBox();
                this._createRulers();  // Only update rulers, not grid (expensive)
                this._notifyViewChanged();
            } else if (e.shiftKey) {
                // Shift+wheel: pan horizontally
                this.viewBox.x += panAmount;
                this._updateViewBox();
                this._createRulers();  // Only update rulers, not grid (expensive)
                this._notifyViewChanged();
            } else {
                // Regular wheel: zoom
                if (e.deltaY > 0) {
                    this.zoomOut(mouseWorld);
                } else {
                    this.zoomIn(mouseWorld);
                }
            }
        };
        
        // Pan start
        this.boundHandlers.mousedown = (e) => {
            if (e.button === 2 || (e.button === 0 && e.shiftKey)) {
                this.isPanning = true;
                this.panStart = { x: e.clientX, y: e.clientY };
                this.panStartViewBox = { ...this.viewBox };
                this.svg.style.cursor = 'grabbing';
                e.preventDefault();
            }
        };
        
        // Pan move
        this.boundHandlers.mousemove = (e) => {
            const rect = this.svg.getBoundingClientRect();
            const mouseScreen = {
                x: e.clientX - rect.left,
                y: e.clientY - rect.top
            };
            
            if (this.isPanning) {
                const dx = (e.clientX - this.panStart.x) / this.scale;
                const dy = (e.clientY - this.panStart.y) / this.scale;
                this.viewBox.x = this.panStartViewBox.x - dx;
                this.viewBox.y = this.panStartViewBox.y - dy;
                this._updateViewBox();
                this._createRulers();
            }
            
            this.currentMouseWorld = this.screenToWorld(mouseScreen);
            
            if (this.onMouseMove) {
                this.onMouseMove(this.currentMouseWorld, this.getSnappedPosition(this.currentMouseWorld));
            }
        };
        
        // Pan end
        this.boundHandlers.mouseup = (e) => {
            if (this.isPanning) {
                this.isPanning = false;
                this.svg.style.cursor = 'default';
                this._createGrid();
                this._notifyViewChanged();
            }
        };
        
        // Prevent context menu
        this.boundHandlers.contextmenu = (e) => {
            e.preventDefault();
        };
        
        // Handle resize
        this.boundHandlers.resize = () => {
            this._onResize();
        };
        
        // Attach all handlers
        this.svg.addEventListener('wheel', this.boundHandlers.wheel, { passive: false });
        this.svg.addEventListener('mousedown', this.boundHandlers.mousedown);
        this.svg.addEventListener('mousemove', this.boundHandlers.mousemove);
        window.addEventListener('mouseup', this.boundHandlers.mouseup);
        this.svg.addEventListener('contextmenu', this.boundHandlers.contextmenu);
        window.addEventListener('resize', this.boundHandlers.resize);
        
        // Keyboard
        this.boundHandlers.keydown = (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
            
            switch (e.key) {
                case 'Home':
                    this.resetView();
                    break;
                case 'f':
                case 'F':
                    if (!e.ctrlKey && !e.metaKey) {
                        this.fitToContent();
                    }
                    break;
            }
        };
        window.addEventListener('keydown', this.boundHandlers.keydown);
    }
    
    /**
     * Cleanup event listeners to prevent memory leaks
     */
    destroy() {
        if (this.boundHandlers.wheel) this.svg.removeEventListener('wheel', this.boundHandlers.wheel);
        if (this.boundHandlers.mousedown) this.svg.removeEventListener('mousedown', this.boundHandlers.mousedown);
        if (this.boundHandlers.mousemove) this.svg.removeEventListener('mousemove', this.boundHandlers.mousemove);
        if (this.boundHandlers.mouseup) window.removeEventListener('mouseup', this.boundHandlers.mouseup);
        if (this.boundHandlers.contextmenu) this.svg.removeEventListener('contextmenu', this.boundHandlers.contextmenu);
        if (this.boundHandlers.resize) window.removeEventListener('resize', this.boundHandlers.resize);
        if (this.boundHandlers.keydown) window.removeEventListener('keydown', this.boundHandlers.keydown);
        
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
    
    addContent(svgElement) {
        this.contentLayer.appendChild(svgElement);
    }
    
    removeContent(svgElement) {
        if (svgElement.parentNode === this.contentLayer) {
            this.contentLayer.removeChild(svgElement);
        }
    }
    
    createGroup() {
        return document.createElementNS('http://www.w3.org/2000/svg', 'g');
    }
    
    // For compatibility with shape system
    get app() {
        return { view: this.svg };
    }
}