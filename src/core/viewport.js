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
        this.svg.style.backgroundColor = '#000000';
        this.svg.style.cursor = 'crosshair';
        container.appendChild(this.svg);
        
        // Create layer groups
        this.gridLayer = this._createGroup('gridLayer');
        this.contentLayer = this._createGroup('contentLayer');
        this.axesLayer = this._createGroup('axesLayer');
        this.rulerLayer = null; // Rulers are in screen space, handled separately
        
        // Create ruler container (HTML overlay)
        this.rulerContainer = document.createElement('div');
        this.rulerContainer.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;';
        container.appendChild(this.rulerContainer);
        
        // View state - viewBox defines visible world area
        this.baseWidth = 500; // mm visible at 100% zoom
        this.viewBox = { x: -250, y: -150, width: 500, height: 300 };
        
        // Constraints
        this.minZoom = 0.05;
        this.maxZoom = 50;
        
        // Grid
        this.gridSize = 1;
        this.gridVisible = true;
        this.gridStyle = 'lines';
        
        // Rulers
        this.rulerSize = 25;
        this.showRulers = true;
        
        // Snapping
        this.snapToGrid = true;
        
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
        
        // Callbacks
        this.onViewChanged = null;
        this.onMouseMove = null;
        
        // Setup
        this._updateViewBox();
        this._createGrid();
        this._createRulers();
        this._bindEvents();
        
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
    
    get offset() {
        // Center of viewBox in world coords
        return {
            x: this.viewBox.x + this.viewBox.width / 2,
            y: this.viewBox.y + this.viewBox.height / 2
        };
    }
    
    // ==================== View Management ====================
    
    _updateViewBox() {
        const vb = this.viewBox;
        this.svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.width} ${vb.height}`);
    }
    
    _onResize() {
        // Maintain aspect ratio - adjust height to match new container
        const aspect = this.height / this.width;
        this.viewBox.height = this.viewBox.width * aspect;
        this._updateViewBox();
        this._createGrid();
        this._createRulers();
        this._notifyViewChanged();
    }
    
    screenToWorld(screenPos) {
        const rect = this.svg.getBoundingClientRect();
        const x = this.viewBox.x + (screenPos.x / rect.width) * this.viewBox.width;
        const y = this.viewBox.y + (screenPos.y / rect.height) * this.viewBox.height;
        return { x, y };
    }
    
    worldToScreen(worldPos) {
        const rect = this.svg.getBoundingClientRect();
        const x = ((worldPos.x - this.viewBox.x) / this.viewBox.width) * rect.width;
        const y = ((worldPos.y - this.viewBox.y) / this.viewBox.height) * rect.height;
        return { x, y };
    }
    
    getSnappedPosition(worldPos) {
        if (!this.snapToGrid) return worldPos;
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
        const currentZoom = this.zoom;
        const newZoom = Math.max(this.minZoom, Math.min(this.maxZoom, currentZoom * factor));
        
        if (newZoom !== currentZoom) {
            const newWidth = this.baseWidth / newZoom;
            const newHeight = newWidth * (this.height / this.width);
            
            // Zoom toward the point
            const wx = (worldPoint.x - this.viewBox.x) / this.viewBox.width;
            const wy = (worldPoint.y - this.viewBox.y) / this.viewBox.height;
            
            this.viewBox.width = newWidth;
            this.viewBox.height = newHeight;
            this.viewBox.x = worldPoint.x - wx * newWidth;
            this.viewBox.y = worldPoint.y - wy * newHeight;
            
            this._updateViewBox();
            this._createGrid();
            this._createRulers();
            this._notifyViewChanged();
        }
    }
    
    resetView() {
        const aspect = this.height / this.width;
        this.viewBox.width = this.baseWidth;
        this.viewBox.height = this.baseWidth * aspect;
        this.viewBox.x = -this.viewBox.width / 2;
        this.viewBox.y = -this.viewBox.height / 2;
        this._updateViewBox();
        this._createGrid();
        this._createRulers();
        this._notifyViewChanged();
    }
    
    fitToBounds(minX, minY, maxX, maxY, padding = 20) {
        const contentWidth = maxX - minX;
        const contentHeight = maxY - minY;
        
        if (contentWidth <= 0 || contentHeight <= 0) {
            this.resetView();
            return;
        }
        
        const aspect = this.height / this.width;
        const paddingWorld = padding / this.scale;
        
        // Fit content with padding
        let viewWidth = contentWidth + paddingWorld * 2;
        let viewHeight = contentHeight + paddingWorld * 2;
        
        // Adjust to maintain aspect ratio
        if (viewHeight / viewWidth > aspect) {
            viewWidth = viewHeight / aspect;
        } else {
            viewHeight = viewWidth * aspect;
        }
        
        // Clamp to zoom limits
        const zoom = this.baseWidth / viewWidth;
        const clampedZoom = Math.max(this.minZoom, Math.min(this.maxZoom, zoom));
        viewWidth = this.baseWidth / clampedZoom;
        viewHeight = viewWidth * aspect;
        
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
        if (this.onViewChanged) {
            this.onViewChanged({
                offset: this.offset,
                zoom: this.zoom,
                bounds: this.getVisibleBounds()
            });
        }
    }
    
    // ==================== Grid ====================
    
    setGridSize(size) {
        this.gridSize = Math.max(0.01, size);
        this._createGrid();
    }
    
    setGridStyle(style) {
        if (style === 'lines' || style === 'dots') {
            this.gridStyle = style;
            this._createGrid();
        }
    }
    
    setGridVisible(visible) {
        this.gridVisible = visible;
        this._createGrid();
    }
    
    _createGrid() {
        // Clear existing grid
        this.gridLayer.innerHTML = '';
        this.axesLayer.innerHTML = '';
        
        if (!this.gridVisible) return;
        
        const bounds = this.getVisibleBounds();
        const margin = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
        
        // Adaptive grid spacing
        const minPixelSpacing = 8;
        const minWorldSpacing = minPixelSpacing / this.scale;
        
        let gridSpacing = this.gridSize;
        while (gridSpacing < minWorldSpacing) {
            gridSpacing *= 10;
        }
        
        // Calculate range for lines/axes
        const startX = Math.floor((bounds.minX - margin) / gridSpacing) * gridSpacing;
        const endX = Math.ceil((bounds.maxX + margin) / gridSpacing) * gridSpacing;
        const startY = Math.floor((bounds.minY - margin) / gridSpacing) * gridSpacing;
        const endY = Math.ceil((bounds.maxY + margin) / gridSpacing) * gridSpacing;
        
        // Line width in world units (1 screen pixel)
        const strokeWidth = 1 / this.scale;
        
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
                        <circle cx="0" cy="0" r="${dotSize}" fill="#404040"/>
                    </pattern>
                </defs>
                <rect x="${startX}" y="${startY}" width="${endX - startX}" height="${endY - startY}" fill="url(#${patternId})"/>
            `;
            this.gridLayer.innerHTML = svg;
        } else {
            // Line grid
            let lines = `<g stroke="#262626" stroke-width="${strokeWidth}">`;
            
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
            <g stroke="#828282" stroke-width="${strokeWidth}">
                <line x1="${startX}" y1="0" x2="${endX}" y2="0"/>
                <line x1="0" y1="${startY}" x2="0" y2="${endY}"/>
            </g>
        `;
        this.axesLayer.innerHTML = axes;
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
        
        // Calculate tick spacing
        const targetPixels = 80;
        const targetMm = targetPixels / this.scale;
        const niceNumbers = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
        let tickSpacing = 1;
        for (const n of niceNumbers) {
            if (n >= targetMm) {
                tickSpacing = n;
                break;
            }
        }
        
        // Build ruler SVG
        let svg = `<svg width="${w}" height="${h}" style="position:absolute;top:0;left:0;">`;
        
        // Backgrounds
        svg += `<rect x="0" y="0" width="${w}" height="${rs}" fill="#1a1a1a"/>`;
        svg += `<rect x="0" y="${rs}" width="${rs}" height="${h - rs}" fill="#1a1a1a"/>`;
        svg += `<rect x="0" y="0" width="${rs}" height="${rs}" fill="#1a1a1a"/>`;
        
        // Debug info
        const viewWidth = Math.round(bounds.maxX - bounds.minX);
        svg += `<text x="3" y="15" fill="#888" font-size="9" font-family="monospace">${viewWidth}mm</text>`;
        
        // Top ruler ticks and labels
        const startX = Math.floor(bounds.minX / tickSpacing) * tickSpacing;
        const endX = Math.ceil(bounds.maxX / tickSpacing) * tickSpacing;
        
        for (let worldX = startX; worldX <= endX; worldX += tickSpacing) {
            const screenX = this.worldToScreen({ x: worldX, y: 0 }).x;
            if (screenX < rs || screenX > w) continue;
            
            svg += `<line x1="${screenX}" y1="${rs}" x2="${screenX}" y2="${rs - 8}" stroke="#666"/>`;
            svg += `<text x="${screenX + 2}" y="12" fill="#888" font-size="10" font-family="monospace">${worldX}</text>`;
            
            // Minor ticks
            for (let i = 1; i < 5; i++) {
                const minorX = worldX + (tickSpacing / 5) * i;
                const minorScreenX = this.worldToScreen({ x: minorX, y: 0 }).x;
                if (minorScreenX > rs && minorScreenX < w) {
                    svg += `<line x1="${minorScreenX}" y1="${rs}" x2="${minorScreenX}" y2="${rs - 4}" stroke="#666"/>`;
                }
            }
        }
        
        // Left ruler ticks and labels
        const startY = Math.floor(bounds.minY / tickSpacing) * tickSpacing;
        const endY = Math.ceil(bounds.maxY / tickSpacing) * tickSpacing;
        
        for (let worldY = startY; worldY <= endY; worldY += tickSpacing) {
            const screenY = this.worldToScreen({ x: 0, y: worldY }).y;
            if (screenY < rs || screenY > h) continue;
            
            svg += `<line x1="${rs}" y1="${screenY}" x2="${rs - 8}" y2="${screenY}" stroke="#666"/>`;
            svg += `<text x="3" y="${screenY + 3}" fill="#888" font-size="10" font-family="monospace">${worldY}</text>`;
            
            // Minor ticks
            for (let i = 1; i < 5; i++) {
                const minorY = worldY + (tickSpacing / 5) * i;
                const minorScreenY = this.worldToScreen({ x: 0, y: minorY }).y;
                if (minorScreenY > rs && minorScreenY < h) {
                    svg += `<line x1="${rs}" y1="${minorScreenY}" x2="${rs - 4}" y2="${minorScreenY}" stroke="#666"/>`;
                }
            }
        }
        
        // Borders
        svg += `<line x1="${rs}" y1="0" x2="${rs}" y2="${h}" stroke="#444"/>`;
        svg += `<line x1="0" y1="${rs}" x2="${w}" y2="${rs}" stroke="#444"/>`;
        
        svg += '</svg>';
        this.rulerContainer.innerHTML = svg;
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
        // Wheel zoom
        this.svg.addEventListener('wheel', (e) => {
            e.preventDefault();
            const rect = this.svg.getBoundingClientRect();
            const mouseScreen = {
                x: e.clientX - rect.left,
                y: e.clientY - rect.top
            };
            const mouseWorld = this.screenToWorld(mouseScreen);
            const factor = e.deltaY > 0 ? 0.9 : 1.1;
            this.zoomAt(mouseWorld, factor);
        }, { passive: false });
        
        // Pan start
        this.svg.addEventListener('mousedown', (e) => {
            if (e.button === 2 || (e.button === 0 && e.shiftKey)) {
                this.isPanning = true;
                this.panStart = { x: e.clientX, y: e.clientY };
                this.panStartViewBox = { ...this.viewBox };
                this.svg.style.cursor = 'grabbing';
                e.preventDefault();
            }
        });
        
        // Pan move
        this.svg.addEventListener('mousemove', (e) => {
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
        });
        
        // Pan end
        window.addEventListener('mouseup', (e) => {
            if (this.isPanning) {
                this.isPanning = false;
                this.svg.style.cursor = 'crosshair';
                this._createGrid();
                this._notifyViewChanged();
            }
        });
        
        // Prevent context menu
        this.svg.addEventListener('contextmenu', (e) => {
            e.preventDefault();
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
            }
        });
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