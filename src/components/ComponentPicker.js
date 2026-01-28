/**
 * ComponentPicker - Panel for browsing and selecting components
 */

import { getComponentLibrary } from '../components/index.js';

export class ComponentPicker {
    constructor(options = {}) {
        this.library = getComponentLibrary();
        this.onComponentSelected = options.onComponentSelected || (() => {});
        this.onClose = options.onClose || (() => {});
        
        this.element = null;
        this.selectedComponent = null;
        this.selectedLCSCResult = null;
        this.selectedKiCadResult = null;
        this.selectedCategory = 'All';
        this.searchQuery = '';
        this.isOpen = true;
        this.searchMode = 'local';  // 'local' or 'lcsc'
        this.lcscResults = [];
        this.isSearching = false;
        this.searchDebounceTimer = null;
        
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
                <div class="cp-mode-toggle">
                    <button class="cp-mode-btn active" data-mode="local">Local</button>
                    <button class="cp-mode-btn" data-mode="lcsc">Online</button>
                </div>
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
        this.modeButtons = this.element.querySelectorAll('.cp-mode-btn');
        this.categoriesEl = this.element.querySelector('.cp-categories');
        
        // Bind events
        this.searchInput.addEventListener('input', () => {
            this.searchQuery = this.searchInput.value;
            if (this.searchMode === 'lcsc') {
                this._debouncedLCSCSearch();
            } else {
                this._populateComponents();
            }
        });
        
        // Handle ESC key - close picker and notify parent
        this.element.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                this.close();
                // Call onClose callback
                if (this.onClose) {
                    this.onClose();
                }
            }
        }, true); // Use capture phase to intercept before other handlers
        
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
        
        // Mode toggle buttons
        this.modeButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                this._setSearchMode(btn.dataset.mode);
            });
        });
    }
    
    _setSearchMode(mode) {
        this.searchMode = mode;
        
        // Update button states
        this.modeButtons.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === mode);
        });
        
        // Show/hide categories (only for local mode)
        this.categoriesEl.style.display = mode === 'local' ? 'block' : 'none';
        
        // Update placeholder
        this.searchInput.placeholder = mode === 'lcsc' 
            ? 'Search online (e.g., NE555, C46749)...'
            : 'Search components...';
        
        // Clear selection and refresh list
        this.selectedComponent = null;
        this.placeBtn.disabled = true;
        this.previewSvg.innerHTML = '';
        this.previewInfo.innerHTML = '';
        
        if (mode === 'lcsc') {
            this.lcscResults = [];
            if (this.searchQuery.length >= 2) {
                this._searchLCSC();
            } else {
                this._showLCSCPrompt();
            }
        } else {
            this._populateComponents();
        }
    }
    
    _showLCSCPrompt() {
        this.listEl.innerHTML = `
            <div class="cp-lcsc-prompt">
                Search online component catalogs.
                <br><br>
                Examples:
                <br>• C46749 (LCSC part number)
                <br>• NE555 (part name)
                <br>• STM32F103
                <br><br>
                <small style="color:var(--text-muted)">⚠️ Online search may be unavailable due to CORS restrictions. Use Local library for reliable access.</small>
            </div>
        `;
    }
    
    _showLoading() {
        this.listEl.innerHTML = `
            <div class="cp-loading">
                <span class="cp-spinner"></span>
                Searching online...
            </div>
        `;
    }
    
    _debouncedLCSCSearch() {
        if (this.searchDebounceTimer) {
            clearTimeout(this.searchDebounceTimer);
        }
        this.searchDebounceTimer = setTimeout(() => {
            this._searchLCSC();
        }, 400);
    }
    
    async _searchLCSC() {
        const query = this.searchQuery.trim();
        
        if (query.length < 2) {
            this._showLCSCPrompt();
            return;
        }
        
        this.isSearching = true;
        this._showLoading();
        
        try {
            this.lcscResults = await this.library.searchLCSC(query);
            
            // Check if LCSC returned an error - if so, try KiCad fallback
            if (this.lcscResults.length === 1 && this.lcscResults[0].error) {
                console.log('LCSC failed, trying KiCad fallback...');
                await this._searchKiCadFallback(query);
                return;
            }
            
            // If no results from LCSC, also try KiCad
            if (this.lcscResults.length === 0) {
                console.log('No LCSC results, trying KiCad fallback...');
                await this._searchKiCadFallback(query);
                return;
            }
            
            this._populateLCSCResults();
        } catch (error) {
            console.error('LCSC search error:', error);
            // Try KiCad fallback on error
            await this._searchKiCadFallback(query);
        } finally {
            this.isSearching = false;
        }
    }
    
    async _searchKiCadFallback(query) {
        try {
            const kicadResults = await this.library.searchKiCad(query);
            
            if (kicadResults && kicadResults.length > 0) {
                this._populateKiCadResults(kicadResults);
            } else {
                // Also search local library
                const localResults = this.library.searchLocal(query);
                if (localResults.length > 0) {
                    this._populateLocalFallbackResults(localResults, query);
                } else {
                    this.listEl.innerHTML = `
                        <div class="cp-empty">
                            No results found in LCSC or KiCad libraries.
                            <br><br>
                            <small>Try searching the Local library or add a custom component.</small>
                        </div>
                    `;
                }
            }
        } catch (error) {
            console.error('KiCad fallback search error:', error);
            this.listEl.innerHTML = `
                <div class="cp-error">
                    Search failed. Try the Local library instead.
                </div>
            `;
        }
    }
    
    _populateKiCadResults(results) {
        this.listEl.innerHTML = `
            <div class="cp-kicad-notice">
                <strong>KiCad Library Results</strong>
                <br><small>LCSC unavailable - showing open-source KiCad symbols</small>
            </div>
        `;
        
        for (const result of results) {
            const item = document.createElement('div');
            item.className = 'cp-item cp-kicad-item';
            
            item.innerHTML = `
                <div class="cp-item-icon">
                    <span style="font-size:18px">📐</span>
                </div>
                <div class="cp-item-info">
                    <div class="cp-item-name">${result.name}</div>
                    <div class="cp-item-desc">${result.library}</div>
                </div>
            `;
            
            item.addEventListener('click', () => this._selectKiCadResult(result, item));
            item.addEventListener('dblclick', () => this._fetchAndPlaceKiCad(result));
            
            this.listEl.appendChild(item);
        }
    }
    
    _populateLocalFallbackResults(results, query) {
        this.listEl.innerHTML = `
            <div class="cp-kicad-notice">
                <strong>Local Library Results</strong>
                <br><small>Showing matches from built-in library for "${query}"</small>
            </div>
        `;
        
        for (const comp of results) {
            const item = document.createElement('div');
            item.className = 'cp-item';
            item.setAttribute('data-name', comp.name);
            
            const miniSvg = this._createMiniPreview(comp);
            
            item.innerHTML = `
                <div class="cp-item-icon">${miniSvg}</div>
                <div class="cp-item-info">
                    <div class="cp-item-name">${comp.name}</div>
                    <div class="cp-item-desc">${comp.description || ''}</div>
                </div>
            `;
            
            item.addEventListener('click', () => this._selectComponent(comp, item));
            item.addEventListener('dblclick', () => {
                this._selectComponent(comp, item);
                this.onComponentSelected(comp);
            });
            
            this.listEl.appendChild(item);
        }
    }
    
    _selectKiCadResult(result, itemEl) {
        this.listEl.querySelectorAll('.cp-item').forEach(el => el.classList.remove('selected'));
        itemEl.classList.add('selected');
        
        this.selectedKiCadResult = result;
        this.selectedComponent = null;
        this.selectedLCSCResult = null;
        
        this.previewSvg.innerHTML = `
            <div style="text-align:center;padding:20px">
                <span style="font-size:48px">📐</span>
            </div>
        `;
        
        this.previewInfo.innerHTML = `
            <strong>${result.name}</strong>
            <br><span style="color:var(--text-muted)">Library: ${result.library}</span>
            <br><span style="color:var(--schematic-component)">KiCad Symbol</span>
        `;
        
        this.placeBtn.disabled = false;
        this.placeBtn.textContent = 'Fetch & Place';
        this.placeBtn.onclick = () => this._fetchAndPlaceKiCad(result);
    }
    
    async _fetchAndPlaceKiCad(result) {
        this.placeBtn.disabled = true;
        this.placeBtn.textContent = 'Fetching...';
        
        try {
            const kicadData = await this.library.kicadFetcher.fetchSymbol(result.library, result.name);
            
            if (kicadData) {
                // Create a component definition from KiCad data
                const definition = {
                    name: `KiCad_${result.name}`,
                    description: `${result.name} from KiCad ${result.library} library`,
                    category: 'KiCad',
                    symbol: kicadData.symbol,
                    _source: 'KiCad'
                };
                
                this.library.addDefinition(definition, 'KiCad');
                this.selectedComponent = definition;
                this.onComponentSelected(definition);
                
                if (definition.symbol) {
                    this._updatePreview(definition);
                }
            }
        } catch (error) {
            console.error('Failed to fetch KiCad symbol:', error);
            this.previewInfo.innerHTML += `<br><span style="color:var(--accent-color)">Failed: ${error.message}</span>`;
        } finally {
            this.placeBtn.disabled = false;
            this.placeBtn.textContent = 'Fetch & Place';
        }
    }
    
    _populateLCSCResults() {
        this.listEl.innerHTML = '';
        
        if (this.lcscResults.length === 0) {
            this.listEl.innerHTML = `
                <div class="cp-empty">
                    No results found.
                </div>
            `;
            return;
        }
        
        // Check for error result
        if (this.lcscResults.length === 1 && this.lcscResults[0].error) {
            this.listEl.innerHTML = `
                <div class="cp-error">
                    ${this.lcscResults[0].message}
                </div>
            `;
            return;
        }
        
        for (const result of this.lcscResults) {
            if (result.error) continue;
            
            const item = document.createElement('div');
            item.className = 'cp-item cp-lcsc-item';
            
            // Show basic/preferred badge
            let badges = '';
            if (result.isBasic) {
                badges += '<span class="cp-badge cp-badge-basic" title="Basic Part">Basic</span>';
            }
            if (result.isPreferred) {
                badges += '<span class="cp-badge cp-badge-preferred" title="Preferred Part">★</span>';
            }
            
            // Format price
            const priceStr = result.price != null ? `$${result.price.toFixed(4)}` : '';
            
            // Format stock
            const stockStr = result.stock > 0 
                ? `<span style="color:var(--schematic-component)">${result.stock.toLocaleString()} in stock</span>`
                : '<span style="color:var(--accent-color)">Out of stock</span>';
            
            item.innerHTML = `
                <div class="cp-item-icon cp-lcsc-icon">
                    ${result.imageUrl 
                        ? `<img src="${result.imageUrl}" alt="" onerror="this.parentElement.innerHTML='<span>📦</span>'">` 
                        : '<span>📦</span>'}
                </div>
                <div class="cp-item-info">
                    <div class="cp-item-name">${result.mpn || result.lcscPartNumber}${badges}</div>
                    <div class="cp-item-desc">${result.lcscPartNumber} ${result.package ? '• ' + result.package : ''}</div>
                    <div class="cp-item-meta">${priceStr} ${stockStr}</div>
                </div>
            `;
            
            item.addEventListener('click', () => this._selectLCSCResult(result, item));
            item.addEventListener('dblclick', () => this._fetchAndPlace(result));
            
            this.listEl.appendChild(item);
        }
    }
    
    _selectLCSCResult(result, itemEl) {
        this.listEl.querySelectorAll('.cp-item').forEach(el => el.classList.remove('selected'));
        itemEl.classList.add('selected');
        
        this.selectedLCSCResult = result;
        this.selectedComponent = null;
        
        this.previewSvg.innerHTML = `
            <div class="cp-lcsc-preview-placeholder">
                ${result.imageUrl 
                    ? `<img src="${result.imageUrl}" alt="${result.mpn}" style="max-width:100%;max-height:80px">` 
                    : '<span style="font-size:48px">📦</span>'}
            </div>
        `;
        
        // Build info display
        let info = `<strong>${result.mpn || result.lcscPartNumber}</strong>`;
        if (result.lcscPartNumber) info += `<br><span style="color:var(--text-secondary)">${result.lcscPartNumber}</span>`;
        if (result.manufacturer) info += `<br><span style="color:var(--text-muted)">${result.manufacturer}</span>`;
        if (result.description) info += `<br><span style="color:var(--text-muted);font-size:10px">${result.description.substring(0, 100)}${result.description.length > 100 ? '...' : ''}</span>`;
        if (result.package) info += `<br><span style="color:var(--text-muted)">Package: ${result.package}</span>`;
        
        // Price breaks
        if (result.price != null) {
            info += `<br><span style="color:var(--schematic-component)">$${result.price.toFixed(4)}/pc</span>`;
        }
        
        // Stock
        if (result.stock > 0) {
            info += `<br><span style="color:var(--text-muted)">${result.stock.toLocaleString()} in stock</span>`;
        } else {
            info += `<br><span style="color:var(--accent-color)">Out of stock</span>`;
        }
        
        // Basic/Extended status
        if (result.isBasic) {
            info += `<br><span class="cp-badge cp-badge-basic">Basic Part</span>`;
        }
        
        this.previewInfo.innerHTML = info;
        
        this.placeBtn.disabled = false;
        this.placeBtn.textContent = 'Fetch & Place';
        this.placeBtn.onclick = () => this._fetchAndPlace(result);
    }
    
    async _fetchAndPlace(result) {
        this.placeBtn.disabled = true;
        this.placeBtn.textContent = 'Fetching...';
        
        try {
            const definition = await this.library.fetchFromLCSC(result.lcscPartNumber);
            
            if (definition) {
                this.selectedComponent = definition;
                this.onComponentSelected(definition);
                
                if (definition.symbol) {
                    this._updatePreview(definition);
                }
            }
        } catch (error) {
            console.error('Failed to fetch component:', error);
            this.previewInfo.innerHTML += `<br><span style="color:var(--accent-color)">Failed: ${error.message}</span>`;
        } finally {
            this.placeBtn.disabled = false;
            this.placeBtn.textContent = 'Fetch & Place';
        }
    }
    
    _populateCategories() {
        const categories = this.library.getCategoryNames();
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
            components = this.library.searchLocal(this.searchQuery);
        } else if (this.selectedCategory === 'All') {
            components = this.library.getAllDefinitions();
        } else {
            components = this.library.getByCategory(this.selectedCategory);
        }
        
        if (!components || components.length === 0) {
            this.listEl.innerHTML = '<div class="cp-empty">No components found.</div>';
            return;
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
        this.selectedLCSCResult = null;  // Clear any LCSC selection
        this.placeBtn.disabled = false;
        this.placeBtn.textContent = 'Place Component';
        
        // Reset button handler for local components
        this.placeBtn.onclick = () => {
            if (this.selectedComponent) {
                this.onComponentSelected(this.selectedComponent);
            }
        };
        
        // Update preview
        this._updatePreview(comp);
    }
    
    _createMiniPreview(comp) {
        if (!comp.symbol) return '<span style="color:var(--text-muted)">?</span>';
        
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
            this.previewSvg.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:20px">No symbol</div>';
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
            info += `<br><span style="color:var(--text-secondary)">${comp.description}</span>`;
        }
        if (symbol.pins) {
            info += `<br><span style="color:var(--text-muted)">${symbol.pins.length} pins</span>`;
        }
        if (comp.category) {
            info += `<br><span style="color:var(--text-muted)">${comp.category}</span>`;
        }
        this.previewInfo.innerHTML = info;
    }
    
    _renderGraphicsToSVG(graphics, defaultStrokeWidth = 0.254) {
        if (!graphics) return '';
        
        let svg = '';
        for (const g of graphics) {
            // Use theme colors - replace black with CSS variable
            let stroke = g.stroke || '#000000';
            if (stroke === '#000000' || stroke === '#000' || stroke === 'black') {
                stroke = 'var(--schematic-component, #00cc66)';
            }
            const strokeWidth = g.strokeWidth || defaultStrokeWidth;
            let fill = g.fill || 'none';
            if (fill === '#000000' || fill === '#000' || fill === 'black') {
                fill = 'var(--schematic-component, #00cc66)';
            }
            
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
                        let textColor = g.color || '#000';
                        if (textColor === '#000000' || textColor === '#000' || textColor === 'black') {
                            textColor = 'var(--schematic-text, #cccccc)';
                        }
                        if (text) {
                            svg += `<text x="${g.x}" y="${g.y}" font-size="${g.fontSize || 1.27}" 
                                          font-family="sans-serif" fill="${textColor}"
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
                          stroke="var(--schematic-component, #00cc66)" stroke-width="${strokeWidth}"/>`;
        }
        
        // Pin endpoint
        svg += `<circle cx="${x2}" cy="${y2}" r="0.4" fill="var(--schematic-pin, #e94560)" stroke="none"/>`;
        
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
    
    close() {
        if (this.isOpen) {
            this.toggle();
        }
    }
    
    open() {
        if (!this.isOpen) {
            this.toggle();
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