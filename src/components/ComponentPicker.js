/**
 * ComponentPicker - Panel for browsing and selecting components
 */

import { getComponentLibrary } from './index.js';

export class ComponentPicker {
    constructor(options = {}) {
        this.library = getComponentLibrary();
        this.onComponentSelected = options.onComponentSelected || (() => {});
        this.onClose = options.onClose || (() => {});
        
        this.element = null;
        this.selectedComponent = null;
        this.selectedCategory = 'All';
        this.searchQuery = '';
        this.isOpen = true;
        
        this._createDOM();
        this._populateCategories();
        this._populateComponents();
    }
    
    _createDOM() {
        this.element = document.createElement('div');
        this.element.className = 'component-picker';
        this.element.innerHTML = `
            <div class="cp-header">
                <span class="cp-title">Components</span>
                <button class="cp-toggle" title="Toggle Panel">◀</button>
            </div>
            <div class="cp-body">
                <div class="cp-search">
                    <input type="text" class="cp-search-input" placeholder="Search components...">
                </div>
                <div class="cp-categories">
                    <select class="cp-category-select">
                        <option value="All">All Categories</option>
                    </select>
                </div>
                <div class="cp-list"></div>
                <div class="cp-preview">
                    <div class="cp-preview-title">Preview</div>
                    <div class="cp-preview-svg"></div>
                    <div class="cp-preview-info"></div>
                </div>
                <div class="cp-actions">
                    <button class="cp-place-btn" disabled>Place Component</button>
                </div>
                <div class="cp-hint">
                    <kbd>R</kbd> Rotate &nbsp; <kbd>M</kbd> Mirror
                </div>
            </div>
        `;
        
        // Get references
        this.searchInput = this.element.querySelector('.cp-search-input');
        this.categorySelect = this.element.querySelector('.cp-category-select');
        this.listEl = this.element.querySelector('.cp-list');
        this.previewSvg = this.element.querySelector('.cp-preview-svg');
        this.previewInfo = this.element.querySelector('.cp-preview-info');
        this.placeBtn = this.element.querySelector('.cp-place-btn');
        this.toggleBtn = this.element.querySelector('.cp-toggle');
        this.bodyEl = this.element.querySelector('.cp-body');
        
        // Bind events
        this.searchInput.addEventListener('input', () => {
            this.searchQuery = this.searchInput.value;
            this._populateComponents();
        });
        
        this.categorySelect.addEventListener('change', () => {
            this.selectedCategory = this.categorySelect.value;
            this._populateComponents();
        });
        
        this.placeBtn.addEventListener('click', () => {
            if (this.selectedComponent) {
                this.onComponentSelected(this.selectedComponent);
            }
        });
        
        this.toggleBtn.addEventListener('click', () => {
            this.toggle();
        });
    }
    
    _populateCategories() {
        const categories = this.library.getCategories();
        categories.sort();
        
        for (const cat of categories) {
            const option = document.createElement('option');
            option.value = cat;
            option.textContent = cat;
            this.categorySelect.appendChild(option);
        }
    }
    
    _populateComponents() {
        this.listEl.innerHTML = '';
        
        let components;
        if (this.searchQuery) {
            components = this.library.search(this.searchQuery);
        } else if (this.selectedCategory === 'All') {
            components = this.library.getAllDefinitions();
        } else {
            components = this.library.getByCategory(this.selectedCategory);
        }
        
        // Sort alphabetically
        components.sort((a, b) => a.name.localeCompare(b.name));
        
        for (const comp of components) {
            const item = document.createElement('div');
            item.className = 'cp-item';
            item.setAttribute('data-name', comp.name);
            
            // Create mini preview
            const miniSvg = this._createMiniPreview(comp);
            
            item.innerHTML = `
                <div class="cp-item-icon">${miniSvg}</div>
                <div class="cp-item-info">
                    <div class="cp-item-name">${comp.name}</div>
                    <div class="cp-item-desc">${comp.description || ''}</div>
                </div>
            `;
            
            item.addEventListener('click', () => {
                this._selectComponent(comp, item);
            });
            
            item.addEventListener('dblclick', () => {
                this._selectComponent(comp, item);
                this.onComponentSelected(comp);
            });
            
            this.listEl.appendChild(item);
        }
    }
    
    _selectComponent(comp, itemEl) {
        // Update selection state
        this.listEl.querySelectorAll('.cp-item').forEach(el => {
            el.classList.remove('selected');
        });
        itemEl.classList.add('selected');
        
        this.selectedComponent = comp;
        this.placeBtn.disabled = false;
        
        // Update preview
        this._updatePreview(comp);
    }
    
    _createMiniPreview(comp) {
        if (!comp.symbol) return '<span style="color:#666">?</span>';
        
        const symbol = comp.symbol;
        const padding = 2;
        const width = (symbol.width || 10) + padding * 2;
        const height = (symbol.height || 10) + padding * 2;
        const originX = symbol.origin?.x || width / 2;
        const originY = symbol.origin?.y || height / 2;
        
        // Create mini SVG
        let svg = `<svg viewBox="${-originX - padding} ${-originY - padding} ${width} ${height}" 
                       width="32" height="32" style="overflow:visible">`;
        
        // Render graphics
        svg += this._renderGraphicsToSVG(symbol.graphics, 0.15);
        
        svg += '</svg>';
        return svg;
    }
    
    _updatePreview(comp) {
        if (!comp.symbol) {
            this.previewSvg.innerHTML = '<div style="color:#666;text-align:center;padding:20px">No symbol</div>';
            this.previewInfo.innerHTML = '';
            return;
        }
        
        const symbol = comp.symbol;
        const padding = 5;
        const width = (symbol.width || 10) + padding * 2;
        const height = (symbol.height || 10) + padding * 2;
        const originX = symbol.origin?.x || width / 2;
        const originY = symbol.origin?.y || height / 2;
        
        // Create preview SVG
        let svg = `<svg viewBox="${-originX - padding} ${-originY - padding} ${width} ${height}" 
                       style="width:100%;height:100%;max-height:150px">`;
        
        // Render graphics
        svg += this._renderGraphicsToSVG(symbol.graphics, 0.25);
        
        // Render pins
        if (symbol.pins) {
            for (const pin of symbol.pins) {
                svg += this._renderPinToSVG(pin);
            }
        }
        
        svg += '</svg>';
        this.previewSvg.innerHTML = svg;
        
        // Update info
        let info = `<strong>${comp.name}</strong>`;
        if (comp.description) {
            info += `<br><span style="color:#888">${comp.description}</span>`;
        }
        if (symbol.pins) {
            info += `<br><span style="color:#666">${symbol.pins.length} pins</span>`;
        }
        if (comp.category) {
            info += `<br><span style="color:#666">${comp.category}</span>`;
        }
        this.previewInfo.innerHTML = info;
    }
    
    _renderGraphicsToSVG(graphics, defaultStrokeWidth = 0.254) {
        if (!graphics) return '';
        
        let svg = '';
        for (const g of graphics) {
            const stroke = g.stroke || '#000000';
            const strokeWidth = g.strokeWidth || defaultStrokeWidth;
            const fill = g.fill || 'none';
            
            switch (g.type) {
                case 'line':
                    svg += `<line x1="${g.x1}" y1="${g.y1}" x2="${g.x2}" y2="${g.y2}" 
                                  stroke="${stroke}" stroke-width="${strokeWidth}"/>`;
                    break;
                    
                case 'rect':
                    svg += `<rect x="${g.x}" y="${g.y}" width="${g.width}" height="${g.height}"
                                  stroke="${stroke}" stroke-width="${strokeWidth}" fill="${fill}"
                                  ${g.rx ? `rx="${g.rx}"` : ''}/>`;
                    break;
                    
                case 'circle':
                    svg += `<circle cx="${g.cx}" cy="${g.cy}" r="${g.r}"
                                    stroke="${stroke}" stroke-width="${strokeWidth}" fill="${fill}"/>`;
                    break;
                    
                case 'ellipse':
                    svg += `<ellipse cx="${g.cx}" cy="${g.cy}" rx="${g.rx}" ry="${g.ry}"
                                     stroke="${stroke}" stroke-width="${strokeWidth}" fill="${fill}"/>`;
                    break;
                    
                case 'polyline':
                    const polylinePoints = g.points.map(p => `${p[0]},${p[1]}`).join(' ');
                    svg += `<polyline points="${polylinePoints}"
                                      stroke="${stroke}" stroke-width="${strokeWidth}" fill="${fill}"/>`;
                    break;
                    
                case 'polygon':
                    const polygonPoints = g.points.map(p => `${p[0]},${p[1]}`).join(' ');
                    svg += `<polygon points="${polygonPoints}"
                                     stroke="${stroke}" stroke-width="${strokeWidth}" fill="${fill}"/>`;
                    break;
                    
                case 'path':
                    svg += `<path d="${g.d}" stroke="${stroke}" stroke-width="${strokeWidth}" fill="${fill}"/>`;
                    break;
                    
                case 'text':
                    // Skip text in mini previews, show in full preview
                    if (defaultStrokeWidth > 0.2) {
                        const anchor = g.anchor || 'start';
                        const baseline = g.baseline || 'middle';
                        let text = g.text || '';
                        text = text.replace('${REF}', 'U1').replace('${VALUE}', '').replace('${NAME}', '');
                        if (text) {
                            svg += `<text x="${g.x}" y="${g.y}" font-size="${g.fontSize || 1.27}" 
                                          font-family="sans-serif" fill="${g.color || '#000'}"
                                          text-anchor="${anchor}" dominant-baseline="${baseline}">${text}</text>`;
                        }
                    }
                    break;
            }
        }
        return svg;
    }
    
    _renderPinToSVG(pin) {
        const length = pin.length || 2.54;
        const strokeWidth = 0.2;
        let svg = '';
        
        // Calculate pin line endpoints
        let x1 = pin.x, y1 = pin.y, x2, y2;
        
        switch (pin.orientation) {
            case 'right':
                x2 = pin.x + length; y2 = pin.y;
                break;
            case 'left':
                x2 = pin.x - length; y2 = pin.y;
                break;
            case 'up':
                x2 = pin.x; y2 = pin.y - length;
                break;
            case 'down':
                x2 = pin.x; y2 = pin.y + length;
                break;
            default:
                x2 = pin.x + length; y2 = pin.y;
        }
        
        // Pin line
        if (length > 0) {
            svg += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" 
                          stroke="#000" stroke-width="${strokeWidth}"/>`;
        }
        
        // Pin endpoint
        svg += `<circle cx="${x2}" cy="${y2}" r="0.4" fill="#e94560" stroke="none"/>`;
        
        return svg;
    }
    
    toggle() {
        this.isOpen = !this.isOpen;
        if (this.isOpen) {
            this.element.classList.remove('collapsed');
            this.toggleBtn.textContent = '◀';
        } else {
            this.element.classList.add('collapsed');
            this.toggleBtn.textContent = '▶';
        }
    }
    
    appendTo(parent) {
        parent.appendChild(this.element);
    }
    
    getSelectedComponent() {
        return this.selectedComponent;
    }
    
    clearSelection() {
        this.selectedComponent = null;
        this.placeBtn.disabled = true;
        this.listEl.querySelectorAll('.cp-item').forEach(el => {
            el.classList.remove('selected');
        });
        this.previewSvg.innerHTML = '';
        this.previewInfo.innerHTML = '';
    }
}

export default ComponentPicker;