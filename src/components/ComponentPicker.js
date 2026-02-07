/**
 * ComponentPicker - Panel for browsing and selecting components
 */

import { getComponentLibrary } from '../components/index.js';
import { ModalManager } from '../core/ModalManager.js';
import { globalEventBus } from '../core/EventBus.js';
import { getSearchManager, initSearchManager } from '../core/SearchManager.js';
import { LazyLoader } from '../core/LazyLoader.js';

export class ComponentPicker {
    constructor(options = {}) {
        this.library = getComponentLibrary();
        this.onComponentSelected = options.onComponentSelected || (() => {});
        this.onClose = options.onClose || (() => {});
        this.eventBus = options.eventBus || globalEventBus;
        
        // Initialize SearchManager if needed
        if (!getSearchManager()) {
            initSearchManager(this.library);
        }
        this.searchManager = getSearchManager();
        
        this.element = null;
        this.selectedComponent = null;
        this.selectedLCSCResult = null;
        this.selectedKiCadResult = null;
        this.selectedCategory = 'All';
        this.searchQuery = '';
        this.isOpen = false;
        this.searchMode = 'local';  // 'local' or 'lcsc'
        this.lcscResults = [];
        this.kicadResults = [];
        this.isSearching = false;
        this.searchDebounceTimer = null;
        
        // Lazy loading
        this.lazyLoader = null;
        this.componentItems = new Map();
        
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
            </div>
            <div class="cp-body">
                <div class="cp-mode-toggle">
                    <button class="cp-mode-btn active" data-mode="local">Local</button>
                    <button class="cp-mode-btn" data-mode="lcsc">Online</button>
                </div>
                <div class="cp-search">
                    <input type="text" class="cp-search-input" placeholder="Search components...">
                    <button class="cp-search-clear" title="Clear search" style="display:none;">✕</button>
                </div>
                <div class="cp-categories">
                    <select class="cp-category-select">
                        <option value="All">All Categories</option>
                    </select>
                </div>
                <div class="cp-list"></div>
                <div class="cp-preview">
                    <div class="cp-preview-image"></div>
                    <div class="cp-preview-title">Symbol</div>
                    <div class="cp-preview-svg"></div>
                    <div class="cp-preview-info"></div>
                    <div class="cp-preview-title">Footprint</div>
                    <div class="cp-preview-footprint"></div>
                    <div class="cp-preview-footprint-info"></div>
                    <div class="cp-preview-title">3D Model</div>
                    <div class="cp-preview-3d"></div>
                    <div class="cp-preview-3d-info"></div>
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
        this.searchClearBtn = this.element.querySelector('.cp-search-clear');
        this.categorySelect = this.element.querySelector('.cp-category-select');
        this.body = this.element.querySelector('.cp-body');
        this.listEl = this.element.querySelector('.cp-list');
        this.previewSvg = this.element.querySelector('.cp-preview-svg');
        this.previewInfo = this.element.querySelector('.cp-preview-info');
        this.previewImage = this.element.querySelector('.cp-preview-image');
        this.previewFootprint = this.element.querySelector('.cp-preview-footprint');
        this.previewFootprintInfo = this.element.querySelector('.cp-preview-footprint-info');
        this.preview3d = this.element.querySelector('.cp-preview-3d');
        this.preview3dInfo = this.element.querySelector('.cp-preview-3d-info');
        this.placeBtn = this.element.querySelector('.cp-place-btn');
        this.bodyEl = this.element.querySelector('.cp-body');
        this.modeButtons = this.element.querySelectorAll('.cp-mode-btn');
        this.categoriesEl = this.element.querySelector('.cp-categories');
        // Start collapsed if configured
        if (!this.isOpen) {
            this.element.classList.add('collapsed');
        }
        
        // Bind events
        this.searchInput.addEventListener('input', () => {
            this.searchQuery = this.searchInput.value;
            // Show/hide clear button
            this.searchClearBtn.style.display = this.searchQuery ? 'block' : 'none';
            if (this.searchMode === 'lcsc') {
                this._debouncedLCSCSearch();
            } else {
                this._populateComponents();
            }
        });
        
        // Clear button handler
        this.searchClearBtn.addEventListener('click', () => {
            this.searchInput.value = '';
            this.searchQuery = '';
            this.searchClearBtn.style.display = 'none';
            if (this.searchMode === 'lcsc') {
                this._showLCSCPrompt();
            } else {
                this._populateComponents();
            }
        });
        
        // Note: ESC handling is performed via ModalManager when picker is open
        
        this.categorySelect.addEventListener('change', () => {
            this.selectedCategory = this.categorySelect.value;
            this._populateComponents();
        });

        
        this.placeBtn.addEventListener('click', () => {
            if (this.selectedComponent) {
                this._selectComponent(this.selectedComponent);
            }
        });
        
        // Toggle control removed - panel is managed by toolbox and ESC
        
        // Mode toggle buttons
        this.modeButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                this._setSearchMode(btn.dataset.mode);
            });
        });
    }
    
    /**
     * Internal method to handle component selection.
     * Emits EventBus event and calls callback.
     * Wraps in try-catch for error resilience.
     */
    _selectComponent(component) {
        try {
            if (!component) {
                throw new Error('Component is null or undefined');
            }
            
            // Validate component has required fields
            if (typeof component !== 'object') {
                throw new Error(`Invalid component type: ${typeof component}`);
            }
            
            // Emit EventBus event (preferred)
            this.eventBus.emit('component:selected', component);
            
            // Also call callback if present (for backward compatibility)
            if (this.onComponentSelected) {
                this.onComponentSelected(component);
            }
        } catch (error) {
            console.error('Error selecting component:', error);
            this.previewInfo.innerHTML = `<div style="color:var(--accent-color)">Error: ${error.message}</div>`;
        }
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
                Search online component catalogs (EasyEDA + KiCad).
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
            // Search both EasyEDA (online) and KiCad
            const [onlineResults, kicadResults] = await Promise.all([
                this.searchManager.searchLCSC(query),
                this.searchManager.searchKiCad(query)
            ]);

            this.lcscResults = onlineResults || [];
            this.kicadResults = kicadResults || [];
            this._populateLCSCResults();
        } catch (error) {
            console.error('LCSC search error:', error);
            this.listEl.innerHTML = `
                <div class="cp-error">
                    Search failed. Try the Local library instead.
                </div>
            `;
        } finally {
            this.isSearching = false;
        }
    }
    
    async _searchKiCadFallback(query) {
        try {
            // Use SearchManager for KiCad search
            const kicadResults = await this.searchManager.searchKiCad(query);
            
            if (kicadResults && kicadResults.length > 0) {
                this._populateKiCadResults(kicadResults);
            } else {
                // Also search local library via SearchManager
                const localResults = this.searchManager.searchLocal(query);
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
                this._selectComponent(comp);
            });
            
            this.listEl.appendChild(item);
        }
    }
    
    _selectKiCadResult(result, itemEl) {
        this.listEl.querySelectorAll('.cp-item').forEach(el => el.classList.remove('selected'));
        itemEl.classList.add('selected');
        
        this.selectedKiCadResult = result;
        this.selectedKiCadItem = itemEl;
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

        if (this.previewImage) {
            this.previewImage.innerHTML = '';
        }

        this.previewSvg.innerHTML = '<div class="cp-preview-placeholder">Loading symbol...</div>';
        this._setFootprintPreviewStatus('Checking KiCad footprint...', false);
        this._set3dPreviewStatus('Checking 3D model...', false);

        this.placeBtn.disabled = true;
        this.placeBtn.textContent = 'Checking footprint/3D...';
        this.placeBtn.onclick = null;

        this._loadKiCadFootprintStatus(result);
    }

    async _loadKiCadFootprintStatus(result) {
        try {
            const kicadDefinition = await this.searchManager.fetchFromKiCad(result.library, result.name);
            const kicadSymbol = kicadDefinition?.symbol || kicadDefinition;
            const kicadProperties = kicadDefinition?.properties || kicadDefinition?.symbol?.properties || kicadSymbol?.properties;
            const footprintName = this._getPropertyValue(kicadProperties, 'Footprint');

            if (kicadSymbol) {
                const previewDef = kicadDefinition?.symbol
                    ? kicadDefinition
                    : {
                        name: `KiCad_${result.name}`,
                        description: `${result.name} from KiCad ${result.library} library`,
                        category: 'KiCad',
                        symbol: kicadSymbol
                    };
                if (kicadSymbol?._kicadRaw) {
                    previewDef._kicadRaw = kicadSymbol._kicadRaw;
                }

                this._updatePreview(previewDef, { skipFootprint3d: true });

                if (this.selectedKiCadItem) {
                    const iconEl = this.selectedKiCadItem.querySelector('.cp-item-icon');
                    if (iconEl) {
                        iconEl.innerHTML = this._createMiniPreview(previewDef);
                    }
                }

                const hasRenderable = (kicadSymbol?.pins?.length || 0) > 0 || (kicadSymbol?.graphics?.length || 0) > 0;
                if (!hasRenderable) {
                    this.previewSvg.innerHTML = '<div class="cp-preview-placeholder">No KiCad symbol graphics available</div>';
                }
            }

            if (!footprintName) {
                this._setFootprintPreviewStatus('Footprint not specified', false);
                this._set3dPreviewStatus('3D model not verified', false);
                this.placeBtn.disabled = true;
                this.placeBtn.textContent = 'Missing footprint/3D';
                console.log('KiCad footprint not specified for', result.library, result.name, kicadSymbol?.properties);
                return;
            }

            const availability = await this.library.kicadFetcher.checkFootprintAvailability(footprintName);
            if (availability.hasFootprint) {
                const preview = await this.library.kicadFetcher.fetchFootprintPreview(footprintName);
                if (preview?.shapes && preview.shapes.length > 0) {
                    const svg = this._renderFootprintSVG(preview.shapes, preview.bbox);
                    if (svg) {
                        this.previewFootprint.innerHTML = svg;
                        this.previewFootprintInfo.innerHTML = `<span class="cp-preview-ok">${footprintName}</span>`;
                    } else {
                        this.previewFootprint.innerHTML = `<div class="cp-preview-placeholder">${footprintName}</div>`;
                        this.previewFootprintInfo.innerHTML = '<span class="cp-preview-ok">Footprint available</span>';
                    }
                } else {
                    this.previewFootprint.innerHTML = `<div class="cp-preview-placeholder">${footprintName}</div>`;
                    this.previewFootprintInfo.innerHTML = '<span class="cp-preview-ok">Footprint available</span>';
                }
            } else {
                this._setFootprintPreviewStatus('Footprint not found', false);
            }

            if (availability.has3d) {
                this.preview3d.innerHTML = '<div class="cp-preview-placeholder">3D model found</div>';
                this.preview3dInfo.innerHTML = '<span class="cp-preview-ok">3D model available</span>';
            } else {
                this._set3dPreviewStatus('3D model not found', false);
            }

            const ready = availability.hasFootprint && availability.has3d;
            const placeDefinition = kicadDefinition?.symbol
                ? { ...kicadDefinition, _source: 'KiCad' }
                : {
                    name: `KiCad_${result.name}`,
                    description: `${result.name} from KiCad ${result.library} library`,
                    category: 'KiCad',
                    symbol: kicadSymbol,
                    _source: 'KiCad'
                };
            if (kicadSymbol?._kicadRaw) {
                placeDefinition._kicadRaw = kicadSymbol._kicadRaw;
            }
            this.placeBtn.disabled = !ready;
            this.placeBtn.textContent = ready ? 'Place Component' : 'Missing footprint/3D';
            this.placeBtn.onclick = ready
                ? () => this._beginPlacement(placeDefinition, { skipFootprint3d: true })
                : null;
        } catch (error) {
            console.error('Failed to verify KiCad footprint:', error);
            this._setFootprintPreviewStatus('Footprint check failed', false);
            this._set3dPreviewStatus('3D check failed', false);
            this.placeBtn.disabled = true;
            this.placeBtn.textContent = 'Missing footprint/3D';
        }
    }
    
    async _fetchAndPlaceKiCad(result) {
        this.placeBtn.disabled = true;
        this.placeBtn.textContent = 'Fetching...';
        
        try {
            // Use SearchManager to fetch from KiCad
            const kicadData = await this.searchManager.fetchFromKiCad(result.library, result.name);
            const kicadSymbol = kicadData?.symbol || kicadData;
            const kicadProperties = kicadData?.properties || kicadData?.symbol?.properties || kicadSymbol?.properties;
            
            if (kicadData) {
                const footprintName = this._getPropertyValue(kicadProperties, 'Footprint');
                if (footprintName) {
                    const availability = await this.library.kicadFetcher.checkFootprintAvailability(footprintName);
                    if (!availability.hasFootprint || !availability.has3d) {
                        this.previewInfo.innerHTML += `<br><span style="color:var(--accent-color)">Missing footprint/3D data</span>`;
                        return;
                    }
                } else {
                    this.previewInfo.innerHTML += `<br><span style="color:var(--accent-color)">Missing footprint/3D data</span>`;
                    return;
                }

                // Create a component definition from KiCad data
                const definition = kicadData?.symbol
                    ? { ...kicadData, _source: 'KiCad' }
                    : {
                        name: `KiCad_${result.name}`,
                        description: `${result.name} from KiCad ${result.library} library`,
                        category: 'KiCad',
                        symbol: kicadSymbol,
                        _source: 'KiCad'
                    };
                
                this.library.addDefinition(definition, 'KiCad');
                this._beginPlacement(definition, { skipFootprint3d: true });
                
                if (definition.symbol) {
                    this._updatePreview(definition);
                }
            }
        } catch (error) {
            console.error('Failed to fetch KiCad symbol:', error);
            this.previewInfo.innerHTML += `<br><span style="color:var(--accent-color)">Failed: ${error.message}</span>`;
        } finally {
            this.placeBtn.disabled = false;
            this.placeBtn.textContent = 'Place Component';
        }
    }
    
    _populateLCSCResults() {
        this.listEl.innerHTML = '';
        const hasOnlineError = this.lcscResults.length === 1 && this.lcscResults[0].error;
        const hasOnlineResults = this.lcscResults.length > 0 && !hasOnlineError;
        const hasKiCadResults = this.kicadResults.length > 0;

        if (!hasOnlineResults && !hasKiCadResults) {
            if (hasOnlineError) {
                this.listEl.innerHTML = `
                    <div class="cp-error">
                        ${this.lcscResults[0].message}
                    </div>
                `;
            } else {
                this.listEl.innerHTML = `
                    <div class="cp-empty">
                        No results found.
                    </div>
                `;
            }
            return;
        }

        // Create header row (outside scrollable area)
        const headerRow = document.createElement('div');
        headerRow.className = 'cp-results-header-row';

        // Create results grid for content (inside scrollable area)
        const resultsGrid = document.createElement('div');
        resultsGrid.className = 'cp-results-grid';

        if (hasOnlineResults) {
            // Add header to header row
            const onlineHeader = document.createElement('div');
            onlineHeader.className = 'cp-results-header';
            onlineHeader.innerHTML = `
                <strong>EasyEDA Results</strong>
                <br><small>Online parts with metadata</small>
            `;
            headerRow.appendChild(onlineHeader);

            // Add column to grid
            const onlineCol = document.createElement('div');
            onlineCol.className = 'cp-results-col';

            const onlineInner = document.createElement('div');
            onlineInner.className = 'cp-results-col-list';

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
                        <span>📦</span>
                    </div>
                    <div class="cp-item-info">
                        <div class="cp-item-name">${result.mpn || result.lcscPartNumber}${badges}</div>
                        <div class="cp-item-desc">${result.lcscPartNumber} ${result.package ? '• ' + result.package : ''}</div>
                        <div class="cp-item-meta">${priceStr} ${stockStr}</div>
                    </div>
                `;

                const iconEl = item.querySelector('.cp-item-icon');
                if (iconEl) {
                    this._applyLCSCThumbnail(iconEl, result);
                }

                item.addEventListener('click', () => this._selectLCSCResult(result, item));
                item.addEventListener('dblclick', () => this._fetchAndPlace(result));

                onlineInner.appendChild(item);
            }

            const onlineSpacer = document.createElement('div');
            onlineSpacer.className = 'cp-results-spacer';
            onlineInner.appendChild(onlineSpacer);

            onlineCol.appendChild(onlineInner);

            resultsGrid.appendChild(onlineCol);
        }

        if (hasKiCadResults) {
            // Add header to header row
            const kicadHeader = document.createElement('div');
            kicadHeader.className = 'cp-results-header';
            kicadHeader.innerHTML = `
                <strong>KiCad Results</strong>
                <br><small>Symbols from KiCad libraries</small>
            `;
            headerRow.appendChild(kicadHeader);

            // Add column to grid
            const kicadCol = document.createElement('div');
            kicadCol.className = 'cp-results-col';

            const kicadInner = document.createElement('div');
            kicadInner.className = 'cp-results-col-list';

            for (const result of this.kicadResults) {
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

                kicadInner.appendChild(item);
            }

            const kicadSpacer = document.createElement('div');
            kicadSpacer.className = 'cp-results-spacer';
            kicadInner.appendChild(kicadSpacer);

            kicadCol.appendChild(kicadInner);

            resultsGrid.appendChild(kicadCol);
        }

        this.body.insertBefore(headerRow, this.listEl);
        this.listEl.appendChild(resultsGrid);
        this._balanceResultsColumns();
    }

    _balanceResultsColumns() {
        requestAnimationFrame(() => {
            const grid = this.listEl.querySelector('.cp-results-grid');
            if (!grid) return;
            const lists = Array.from(grid.querySelectorAll('.cp-results-col-list'));
            if (lists.length < 2) return;

            // Remove spacers - we'll use JS to control scroll
            lists.forEach(list => {
                const spacer = list.querySelector('.cp-results-spacer');
                if (spacer) spacer.remove();
            });

            // Get actual content heights (without spacers)
            const contentHeights = lists.map(list => {
                const items = Array.from(list.querySelectorAll('.cp-item'));
                return items.reduce((sum, item) => sum + item.offsetHeight + parseFloat(getComputedStyle(item).marginBottom || 0), 0);
            });

            const maxHeight = Math.max(...contentHeights);

            // Add scroll handler to clamp shorter lists
            const handleScroll = () => {
                const scrollTop = this.listEl.scrollTop;
                
                lists.forEach((list, idx) => {
                    const contentHeight = contentHeights[idx];
                    const availableHeight = this.listEl.clientHeight;
                    const maxScroll = contentHeight - availableHeight;
                    
                    if (maxScroll <= 0) {
                        // Content is shorter than viewport, no scrolling needed
                        list.style.transform = '';
                    } else if (scrollTop > maxScroll) {
                        // Clamp: move list down to compensate for excess scroll
                        list.style.transform = `translateY(${scrollTop - maxScroll}px)`;
                    } else {
                        list.style.transform = '';
                    }
                });
            };

            // Remove old listener if it exists
            if (this._scrollHandler) {
                this.listEl.removeEventListener('scroll', this._scrollHandler);
            }
            this._scrollHandler = handleScroll;
            this.listEl.addEventListener('scroll', handleScroll);

            // Set grid height to tallest content
            grid.style.minHeight = `${maxHeight}px`;
        });
    }
    
    _selectLCSCResult(result, itemEl) {
        this.listEl.querySelectorAll('.cp-item').forEach(el => el.classList.remove('selected'));
        itemEl.classList.add('selected');
        
        this.selectedLCSCResult = result;
        this.selectedComponent = null;
        
        this.previewSvg.innerHTML = `
            <div class="cp-lcsc-preview-placeholder">
                <span style="font-size:48px">📦</span>
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

        this._updateLCSCPreviewImage(result);
        
        this._setFootprintPreviewStatus('Loading footprint...', false);
        this._set3dPreviewStatus('Loading 3D data...', false);

        this.placeBtn.disabled = true;
        this.placeBtn.textContent = 'Preparing...';
        this.placeBtn.onclick = null;

        this._loadEasyEDADetailForPreview(result);
    }

    async _loadEasyEDADetailForPreview(result) {
        try {
            if (!result || !result.lcscPartNumber) {
                this._setFootprintPreviewStatus('No footprint data', false);
                this._set3dPreviewStatus('No 3D model', false);
                this.placeBtn.disabled = true;
                this.placeBtn.textContent = 'Missing footprint/3D';
                this.placeBtn.onclick = null;
                return;
            }

            if (!result._detailPromise) {
                result._detailPromise = this.library.lcscFetcher.fetchComponentMetadata(result.lcscPartNumber);
            }

            const metadata = await result._detailPromise;
            if (!metadata) {
                this._setFootprintPreviewStatus('No footprint data', false);
                this._set3dPreviewStatus('No 3D model', false);
                this.placeBtn.disabled = true;
                this.placeBtn.textContent = 'Missing footprint/3D';
                this.placeBtn.onclick = null;
                return;
            }

            result._detail = metadata;
            result._detailPromise = null;

            this._updateFootprintPreview(metadata);
            this._update3dPreview(metadata);

            const ready = metadata.hasFootprint && metadata.has3d;
            if (!ready) {
                this.placeBtn.disabled = true;
                this.placeBtn.textContent = 'Missing footprint/3D';
                this.placeBtn.onclick = null;
                return;
            }

            if (!result._definitionPromise) {
                result._definitionPromise = this.searchManager.fetchFromLCSC(result.lcscPartNumber);
            }

            const definition = await result._definitionPromise;
            if (definition?.symbol) {
                this._updatePreview(definition);
                if (this.selectedLCSCResult === result) {
                    const selectedItem = this.listEl.querySelector('.cp-item.selected');
                    if (selectedItem) {
                        const iconEl = selectedItem.querySelector('.cp-item-icon');
                        if (iconEl) {
                            iconEl.innerHTML = this._createMiniPreview(definition);
                        }
                    }
                }
            }

            this.placeBtn.disabled = false;
            this.placeBtn.textContent = 'Place Component';
            this.placeBtn.onclick = () => this._placePrefetchedLCSC(result);
        } catch (error) {
            console.error('Failed to load EasyEDA detail:', error);
            this._setFootprintPreviewStatus('Footprint load failed', false);
            this._set3dPreviewStatus('3D load failed', false);
            this.placeBtn.disabled = true;
            this.placeBtn.textContent = 'Missing footprint/3D';
            this.placeBtn.onclick = null;
        }
    }
    
    async _fetchAndPlace(result) {
        this.placeBtn.disabled = true;
        this.placeBtn.textContent = 'Placing...';

        let fetchedDefinition = null;
        
        try {
            if (result?._detailPromise) {
                await result._detailPromise;
            }

            // Use SearchManager to fetch from LCSC
            const definition = result?._definitionPromise
                ? await result._definitionPromise
                : await this.searchManager.fetchFromLCSC(result.lcscPartNumber);
            
            if (definition) {
                fetchedDefinition = definition;

                const detail = result?._detail;
                if (detail) {
                    definition.footprintName = definition.footprintName || detail.footprintName || detail.package || '';
                    definition.footprintShapes = definition.footprintShapes || detail.footprintShapes || null;
                    definition.footprintBBox = definition.footprintBBox || detail.footprintBBox || null;
                    definition.model3dName = definition.model3dName || detail.model3dName || '';
                    definition.hasFootprint = definition.hasFootprint || !!detail.hasFootprint || !!(detail.footprintShapes && detail.footprintShapes.length > 0);
                    definition.has3d = definition.has3d || !!detail.has3d || !!detail.model3dName;
                }

                if (!definition.hasFootprint || !definition.has3d) {
                    this.previewInfo.innerHTML += `<br><span style="color:var(--accent-color)">Missing footprint/3D data</span>`;
                    this._updatePreview(definition);
                    this.placeBtn.disabled = true;
                    this.placeBtn.textContent = 'Missing footprint/3D';
                    this.placeBtn.onclick = null;
                    return;
                }

                this._beginPlacement(definition);
            }
        } catch (error) {
            console.error('Failed to fetch component:', error);
            this.previewInfo.innerHTML += `<br><span style="color:var(--accent-color)">Failed: ${error.message}</span>`;
        } finally {
            if (!fetchedDefinition) {
                this.placeBtn.disabled = false;
                this.placeBtn.textContent = 'Place Component';
            }
        }
    }

    async _placePrefetchedLCSC(result) {
        this.placeBtn.disabled = true;
        this.placeBtn.textContent = 'Placing...';

        try {
            if (result?._detailPromise) {
                await result._detailPromise;
            }

            if (!result?._definitionPromise) {
                result._definitionPromise = this.searchManager.fetchFromLCSC(result.lcscPartNumber);
            }

            const definition = await result._definitionPromise;
            if (definition) {
                const detail = result?._detail;
                if (detail) {
                    definition.footprintName = definition.footprintName || detail.footprintName || detail.package || '';
                    definition.footprintShapes = definition.footprintShapes || detail.footprintShapes || null;
                    definition.footprintBBox = definition.footprintBBox || detail.footprintBBox || null;
                    definition.model3dName = definition.model3dName || detail.model3dName || '';
                    definition.hasFootprint = definition.hasFootprint || !!detail.hasFootprint || !!(detail.footprintShapes && detail.footprintShapes.length > 0);
                    definition.has3d = definition.has3d || !!detail.has3d || !!detail.model3dName;
                }

                if (!definition.hasFootprint || !definition.has3d) {
                    this.previewInfo.innerHTML += `<br><span style="color:var(--accent-color)">Missing footprint/3D data</span>`;
                    this._updatePreview(definition);
                    this.placeBtn.disabled = true;
                    this.placeBtn.textContent = 'Missing footprint/3D';
                    this.placeBtn.onclick = null;
                    return;
                }

                this._beginPlacement(definition);
            }
        } catch (error) {
            console.error('Failed to place component:', error);
            this.previewInfo.innerHTML += `<br><span style="color:var(--accent-color)">Failed: ${error.message}</span>`;
            this.placeBtn.disabled = false;
            this.placeBtn.textContent = 'Place Component';
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
        this.componentItems.clear();
        
        // Cleanup previous lazy loader
        if (this.lazyLoader) {
            this.lazyLoader.destroy();
        }
        
        let components;
        if (this.searchQuery) {
            // Use SearchManager for local search
            components = this.searchManager.searchLocal(this.searchQuery);
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
        
        // Create item elements with placeholder (no SVG yet)
        for (const comp of components) {
            const item = document.createElement('div');
            item.className = 'cp-item';
            item.setAttribute('data-name', comp.name);
            
            // Placeholder content (light weight)
            item.innerHTML = `
                <div class="cp-item-icon" style="background:#333;min-width:40px;min-height:40px"></div>
                <div class="cp-item-info">
                    <div class="cp-item-name">${comp.name}</div>
                    <div class="cp-item-desc">${comp.description || ''}</div>
                </div>
            `;
            
            item.addEventListener('click', () => {
                this._selectComponent(comp, item);
            });
            
            item.addEventListener('dblclick', () => {
                this._selectComponent(comp);
            });
            
            this.listEl.appendChild(item);
            this.componentItems.set(item, comp);
        }
        
        // Set up lazy loading for component previews
        this._setupLazyLoading();
    }
    
    _setupLazyLoading() {
        // Create lazy loader for rendering component previews
        this.lazyLoader = new LazyLoader({
            container: this.listEl,
            threshold: 0.1,
            rootMargin: '50px',
            batchSize: 5,
            renderCallback: (element, item) => {
                const comp = item.data;
                if (!comp) return;
                
                try {
                    const miniSvg = this._createMiniPreview(comp);
                    const iconEl = element.querySelector('.cp-item-icon');
                    if (iconEl) {
                        iconEl.innerHTML = miniSvg;
                    }
                } catch (error) {
                    console.warn('LazyLoader: Error rendering preview:', error);
                }
            },
            unrenderCallback: (element, item) => {
                // Optionally unrender to save memory
                const iconEl = element.querySelector('.cp-item-icon');
                if (iconEl) {
                    iconEl.innerHTML = '<div style="background:#333;width:100%;height:100%"></div>';
                }
            }
        });
        
        // Register all items for lazy loading
        for (const [element, comp] of this.componentItems) {
            this.lazyLoader.register(element, comp);
        }
    }
    
    _selectComponent(comp, itemEl) {
        const normalized = this._normalizeDefinition(comp);
        // Update selection state
        if (itemEl) {
            this.listEl.querySelectorAll('.cp-item').forEach(el => {
                el.classList.remove('selected');
            });
            itemEl.classList.add('selected');
        }
        
        this.selectedComponent = normalized;
        this.selectedLCSCResult = null;  // Clear any LCSC selection
        this.placeBtn.disabled = false;
        this.placeBtn.textContent = 'Place Component';
        
        // Reset button handler for local components
        this.placeBtn.onclick = () => {
            if (this.selectedComponent) {
                this._beginPlacement(this.selectedComponent);
            }
        };

        if (this.previewImage) {
            this.previewImage.innerHTML = '';
        }
        
        // Update preview
        this._updatePreview(normalized);
    }

    _beginPlacement(definition, options = {}) {
        if (!definition) return;
        this.selectedComponent = this._normalizeDefinition(definition);
        this._updatePreview(this.selectedComponent, { skipFootprint3d: !!options.skipFootprint3d });

        if (this.onComponentSelected) {
            this.onComponentSelected(this.selectedComponent);
        } else {
            this.eventBus.emit('component:selected', this.selectedComponent);
        }
    }

    _normalizeDefinition(definition) {
        if (!definition || typeof definition !== 'object') return definition;

        if (definition.symbol && definition.symbol.graphics) {
            return definition;
        }

        if (definition.symbol && definition.symbol.symbol) {
            return { ...definition, symbol: definition.symbol.symbol };
        }

        if (!definition.symbol && (definition.graphics || definition.pins)) {
            return {
                name: definition.name || 'Component',
                description: definition.description || '',
                category: definition.category || 'Uncategorized',
                symbol: definition
            };
        }

        return definition;
    }
    
    _createMiniPreview(comp) {
        if (!comp.symbol) return '<span style="color:var(--text-muted)">?</span>';
        
        const symbol = comp.symbol;
        const paddingX = 2;
        const paddingY = 2;
        const bounds = this._computeSymbolBounds(symbol);
        const fallbackWidth = (symbol.width || 10) + paddingX * 2;
        const fallbackHeight = (symbol.height || 10) + paddingY * 2;
        const fallbackOriginX = symbol.origin?.x || fallbackWidth / 2;
        const fallbackOriginY = symbol.origin?.y || fallbackHeight / 2;
        const viewBox = bounds
            ? `${bounds.minX - paddingX} ${bounds.minY - paddingY} ${bounds.width + paddingX * 2} ${bounds.height + paddingY * 2}`
            : `${-fallbackOriginX - paddingX} ${-fallbackOriginY - paddingY} ${fallbackWidth} ${fallbackHeight}`;
        
        // Create mini SVG
        let svg = `<svg viewBox="${viewBox}" 
                       width="32" height="32" style="overflow:visible">`;
        
        // Render graphics
        svg += this._renderGraphicsToSVG(symbol.graphics, 0.18);

        // Render pins for better differentiation
        if (symbol.pins && Array.isArray(symbol.pins)) {
            for (const pin of symbol.pins) {
                svg += this._renderPinToSVG(pin);
            }
        }
        
        svg += '</svg>';
        return svg;
    }

    _isDirectImageUrl(url) {
        if (!url || typeof url !== 'string') return false;
        return /\.(png|jpe?g|gif|webp)(\?.*)?$/i.test(url);
    }

    async _applyLCSCThumbnail(iconEl, result) {
        const thumbUrl = result.thumbUrl || result.imageUrl || '';
        if (!thumbUrl) return;

        if (this._isDirectImageUrl(thumbUrl)) {
            iconEl.innerHTML = `<img src="${thumbUrl}" alt="" onerror="this.parentElement.innerHTML='<span>📦</span>'">`;
            return;
        }

        if (!result.lcscPartNumber || !this.library?.lcscFetcher) return;

        if (!result._thumbPromise) {
            result._thumbPromise = this.library.lcscFetcher.fetchEasyedaProductImage(result.lcscPartNumber);
        }

        try {
            const resolvedUrl = await result._thumbPromise;
            result._thumbPromise = null;
            if (resolvedUrl && this._isDirectImageUrl(resolvedUrl)) {
                iconEl.innerHTML = `<img src="${resolvedUrl}" alt="" onerror="this.parentElement.innerHTML='<span>📦</span>'">`;
            }
        } catch (error) {
            result._thumbPromise = null;
        }
    }

    async _updateLCSCPreviewImage(result) {
        if (!this.previewImage) return;

        this.previewImage.innerHTML = '<div class="cp-preview-placeholder">Loading image...</div>';

        const directUrl = result.imageUrl || result.thumbUrl || '';
        if (directUrl && this._isDirectImageUrl(directUrl)) {
            this.previewImage.innerHTML = `<img src="${directUrl}" alt="" style="max-width:100%;max-height:120px;object-fit:contain" onerror="this.parentElement.innerHTML=''">`;
            return;
        }

        if (!result.lcscPartNumber || !this.library?.lcscFetcher) {
            this.previewImage.innerHTML = '';
            return;
        }

        try {
            const resolvedUrl = await this.library.lcscFetcher.fetchEasyedaProductImage(result.lcscPartNumber);
            if (resolvedUrl) {
                this.previewImage.innerHTML = `<img src="${resolvedUrl}" alt="" style="max-width:100%;max-height:120px;object-fit:contain" onerror="this.parentElement.innerHTML=''">`;
            } else {
                this.previewImage.innerHTML = '';
            }
        } catch (error) {
            this.previewImage.innerHTML = '';
        }
    }
    
    _updatePreview(comp, options = {}) {
        try {
            if (!comp || !comp.symbol) {
                this.previewSvg.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:20px">No symbol</div>';
                this.previewInfo.innerHTML = '';
                if (!options.skipFootprint3d) {
                    this._setFootprintPreviewStatus('No footprint data', false);
                    this._set3dPreviewStatus('No 3D model', false);
                }
                return;
            }
            
            const symbol = comp.symbol;
            const paddingX = 6;
            const paddingY = 10;
            const bounds = this._computeSymbolBounds(symbol);
            const fallbackWidth = (symbol.width || 10) + paddingX * 2;
            const fallbackHeight = (symbol.height || 10) + paddingY * 2;
            const fallbackOriginX = symbol.origin?.x || fallbackWidth / 2;
            const fallbackOriginY = symbol.origin?.y || fallbackHeight / 2;
            
            // Validate numeric values
            if (bounds) {
                if (!Number.isFinite(bounds.minX) || !Number.isFinite(bounds.minY) ||
                    !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) {
                    throw new Error('Invalid symbol bounds');
                }
            } else {
                if (!Number.isFinite(fallbackOriginX) || !Number.isFinite(fallbackOriginY) || 
                    !Number.isFinite(fallbackWidth) || !Number.isFinite(fallbackHeight)) {
                    throw new Error('Invalid symbol dimensions');
                }
            }
            
            // Create preview SVG
            const viewBox = bounds
                ? `${bounds.minX - paddingX} ${bounds.minY - paddingY} ${bounds.width + paddingX * 2} ${bounds.height + paddingY * 2}`
                : `${-fallbackOriginX - paddingX} ${-fallbackOriginY - paddingY} ${fallbackWidth} ${fallbackHeight}`;

            let svg = `<svg viewBox="${viewBox}" 
                           style="width:100%;height:100%;max-height:150px">`;
            
            // Render graphics
            svg += this._renderGraphicsToSVG(symbol.graphics, 0.25);
            
            // Render pins
            if (symbol.pins && Array.isArray(symbol.pins)) {
                for (const pin of symbol.pins) {
                    svg += this._renderPinToSVG(pin);
                }
            }
            
            svg += '</svg>';
            this.previewSvg.innerHTML = svg;
            
            // Update info
            let info = `<strong>${comp.name || 'Component'}</strong>`;
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

            if (!options.skipFootprint3d) {
                this._updateFootprintPreview(comp);
                this._update3dPreview(comp);
            }
        } catch (error) {
            console.error('Error updating preview:', error);
            this.previewSvg.innerHTML = '<div style="color:var(--accent-color);text-align:center;padding:20px">Preview error</div>';
            this.previewInfo.innerHTML = `<span style="color:var(--accent-color);font-size:12px">${error.message}</span>`;
            if (!options.skipFootprint3d) {
                this._setFootprintPreviewStatus('Footprint preview error', false);
                this._set3dPreviewStatus('3D preview error', false);
            }
        }
    }

    _computeSymbolBounds(symbol) {
        if (!symbol) return null;

        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;

        const includePoint = (x, y) => {
            if (!Number.isFinite(x) || !Number.isFinite(y)) return;
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
        };

        if (Array.isArray(symbol.graphics)) {
            for (const g of symbol.graphics) {
                if (!g || typeof g !== 'object') continue;
                switch (g.type) {
                    case 'line':
                        includePoint(g.x1, g.y1);
                        includePoint(g.x2, g.y2);
                        break;
                    case 'rect':
                        includePoint(g.x, g.y);
                        includePoint(g.x + g.width, g.y + g.height);
                        break;
                    case 'circle':
                        includePoint(g.cx - g.r, g.cy - g.r);
                        includePoint(g.cx + g.r, g.cy + g.r);
                        break;
                    case 'arc':
                        includePoint(g.cx - g.r, g.cy - g.r);
                        includePoint(g.cx + g.r, g.cy + g.r);
                        break;
                    case 'polyline':
                    case 'polygon':
                        if (Array.isArray(g.points)) {
                            for (const p of g.points) {
                                if (Array.isArray(p) && p.length >= 2) {
                                    includePoint(p[0], p[1]);
                                }
                            }
                        }
                        break;
                    case 'text':
                        includePoint(g.x, g.y);
                        break;
                }
            }
        }

        if (Array.isArray(symbol.pins)) {
            for (const pin of symbol.pins) {
                if (!pin || !Number.isFinite(pin.x) || !Number.isFinite(pin.y)) continue;

                includePoint(pin.x, pin.y);

                const length = Number.isFinite(pin.length) ? pin.length : 2.54;
                let x2 = pin.x;
                let y2 = pin.y;

                switch (pin.orientation) {
                    case 'right':
                        x2 = pin.x + length;
                        break;
                    case 'left':
                        x2 = pin.x - length;
                        break;
                    case 'up':
                        y2 = pin.y - length;
                        break;
                    case 'down':
                        y2 = pin.y + length;
                        break;
                    default:
                        x2 = pin.x + length;
                }

                includePoint(x2, y2);
            }
        }

        if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
            return null;
        }

        return {
            minX,
            minY,
            maxX,
            maxY,
            width: maxX - minX,
            height: maxY - minY
        };
    }

    _setFootprintPreviewStatus(message, available) {
        if (!this.previewFootprint) return;
        this.previewFootprint.innerHTML = `<div class="cp-preview-placeholder">${message}</div>`;
        if (this.previewFootprintInfo) {
            this.previewFootprintInfo.innerHTML = available
                ? '<span class="cp-preview-ok">Footprint available</span>'
                : '<span class="cp-preview-warn">Footprint unavailable</span>';
        }
    }

    _set3dPreviewStatus(message, available) {
        if (!this.preview3d) return;
        this.preview3d.innerHTML = `<div class="cp-preview-placeholder">${message}</div>`;
        if (this.preview3dInfo) {
            this.preview3dInfo.innerHTML = available
                ? '<span class="cp-preview-ok">3D model available</span>'
                : '<span class="cp-preview-warn">3D model unavailable</span>';
        }
    }

    _updateFootprintPreview(metadata) {
        if (!metadata || !metadata.hasFootprint) {
            this._setFootprintPreviewStatus('No footprint data', false);
            return;
        }

        const name = metadata.footprintName || metadata.package || 'Footprint';
        const svg = this._renderFootprintSVG(metadata.footprintShapes, metadata.footprintBBox);
        if (!svg) {
            this.previewFootprint.innerHTML = `<div class="cp-preview-placeholder">${name}</div>`;
            if (this.previewFootprintInfo) {
                this.previewFootprintInfo.innerHTML = '<span class="cp-preview-ok">Footprint available</span>';
            }
            return;
        }

        this.previewFootprint.innerHTML = svg;
        if (this.previewFootprintInfo) {
            this.previewFootprintInfo.innerHTML = `<span class="cp-preview-ok">${name}</span>`;
        }
    }

    _update3dPreview(metadata) {
        if (!metadata || !metadata.has3d) {
            this._set3dPreviewStatus('No 3D model', false);
            return;
        }

        const modelName = metadata.model3dName || '3D model';
        this.preview3d.innerHTML = `<div class="cp-preview-placeholder">🧊 ${modelName}</div>`;
        if (this.preview3dInfo) {
            this.preview3dInfo.innerHTML = '<span class="cp-preview-ok">3D model available</span>';
        }
    }

    _renderFootprintSVG(shapes, bbox) {
        if (!Array.isArray(shapes) || shapes.length === 0) return '';

        const padding = 2;
        let viewBox = '-5 -5 10 10';
        if (bbox && Number.isFinite(bbox.x) && Number.isFinite(bbox.y) && Number.isFinite(bbox.width) && Number.isFinite(bbox.height)) {
            viewBox = `${bbox.x - padding} ${bbox.y - padding} ${bbox.width + padding * 2} ${bbox.height + padding * 2}`;
        }

        let svg = `<svg viewBox="${viewBox}" style="width:100%;height:100%;max-height:100px">`;
        if (bbox && Number.isFinite(bbox.x) && Number.isFinite(bbox.y) && Number.isFinite(bbox.width) && Number.isFinite(bbox.height)) {
            svg += `<rect x="${bbox.x}" y="${bbox.y}" width="${bbox.width}" height="${bbox.height}" fill="none" stroke="var(--text-muted)" stroke-width="0.3"/>`;
        }

        for (const shape of shapes) {
            if (typeof shape !== 'string') continue;
            if (!shape.startsWith('PAD~')) continue;

            const parts = shape.split('~');
            const padType = parts[1];
            const x = parseFloat(parts[2]);
            const y = parseFloat(parts[3]);
            const w = parseFloat(parts[4]);
            const h = parseFloat(parts[5]);

            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) continue;

            if (padType === 'RECT') {
                const rx = x - w / 2;
                const ry = y - h / 2;
                svg += `<rect x="${rx}" y="${ry}" width="${w}" height="${h}" fill="var(--accent-color)" fill-opacity="0.2" stroke="var(--accent-color)" stroke-width="0.2"/>`;
            } else if (padType === 'ELLIPSE') {
                svg += `<ellipse cx="${x}" cy="${y}" rx="${w / 2}" ry="${h / 2}" fill="var(--accent-color)" fill-opacity="0.2" stroke="var(--accent-color)" stroke-width="0.2"/>`;
            }
        }

        svg += '</svg>';
        return svg;
    }


    _getPropertyValue(properties, key) {
        if (!properties || typeof properties !== 'object') return '';
        if (properties[key]) return properties[key];

        const lowerKey = key.toLowerCase();
        const match = Object.keys(properties).find(propKey => propKey.toLowerCase() === lowerKey);
        return match ? properties[match] : '';
    }
    
    _renderGraphicsToSVG(graphics, defaultStrokeWidth = 0.254) {
        try {
            if (!graphics || !Array.isArray(graphics)) return '';
            
            let svg = '';
            for (const g of graphics) {
                try {
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
                            if (g.points && Array.isArray(g.points)) {
                                const polylinePoints = g.points.map(p => `${p[0]},${p[1]}`).join(' ');
                                svg += `<polyline points="${polylinePoints}"
                                                  stroke="${stroke}" stroke-width="${strokeWidth}" fill="${fill}"/>`;
                            }
                            break;
                            
                        case 'polygon':
                            if (g.points && Array.isArray(g.points)) {
                                const polygonPoints = g.points.map(p => `${p[0]},${p[1]}`).join(' ');
                                svg += `<polygon points="${polygonPoints}"
                                                 stroke="${stroke}" stroke-width="${strokeWidth}" fill="${fill}"/>`;
                            }
                            break;
                            
                        case 'path':
                            if (g.d) {
                                svg += `<path d="${g.d}" stroke="${stroke}" stroke-width="${strokeWidth}" fill="${fill}"/>`;
                            }
                            break;
                            
                        case 'text':
                            // Skip text in mini previews, show in full preview
                            if (defaultStrokeWidth > 0.2 && g.text) {
                                const anchor = g.anchor || 'start';
                                const baseline = g.baseline || 'middle';
                                let text = g.text.replace('${REF}', 'U1').replace('${VALUE}', '').replace('${NAME}', '');
                                let textColor = g.color || '#000';
                                if (textColor === '#000000' || textColor === '#000' || textColor === 'black') {
                                    textColor = 'var(--schematic-text, #cccccc)';
                                }
                                svg += `<text x="${g.x}" y="${g.y}" font-size="${g.fontSize || 1.27}" 
                                              font-family="sans-serif" fill="${textColor}"
                                              text-anchor="${anchor}" dominant-baseline="${baseline}">${text}</text>`;
                            }
                            break;
                    }
                } catch (itemError) {
                    console.warn('Error rendering graphic item:', itemError, g);
                    // Skip this item and continue with others
                }
            }
            return svg;
        } catch (error) {
            console.error('Error rendering graphics:', error);
            return '';
        }
    }
    
    _renderPinToSVG(pin) {
        try {
            if (!pin || typeof pin.x !== 'number' || typeof pin.y !== 'number') {
                return '';
            }
            
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
            
            // Validate coordinates
            if (!Number.isFinite(x1) || !Number.isFinite(y1) || 
                !Number.isFinite(x2) || !Number.isFinite(y2)) {
                return '';
            }
            
            // Pin line
            if (length > 0) {
                svg += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" 
                              stroke="var(--schematic-component, #00cc66)" stroke-width="${strokeWidth}"/>`;
            }
            
            // Pin endpoint
            svg += `<circle cx="${x2}" cy="${y2}" r="0.4" fill="var(--schematic-pin, #e94560)" stroke="none"/>`;
            
            return svg;
        } catch (error) {
            console.warn('Error rendering pin:', error, pin);
            return '';
        }
    }
    
    toggle() {
        this.isOpen = !this.isOpen;
        if (this.isOpen) {
            this.element.classList.remove('collapsed');
            // Register with ModalManager so ESC will close the picker
            ModalManager.push('componentPicker', () => {
                this.close();
                if (this.onClose) this.onClose();
            });
        } else {
            this.element.classList.add('collapsed');
            // Unregister from ModalManager
            ModalManager.pop('componentPicker');
        }
    }
    
    close() {
        if (this.isOpen) {
            this.toggle();
        }
        // Cleanup lazy loader to save memory
        if (this.lazyLoader) {
            this.lazyLoader.destroy();
            this.lazyLoader = null;
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
    
    /**
     * Cleanup and destroy the component picker
     */
    destroy() {
        this.close();
        if (this.lazyLoader) {
            this.lazyLoader.destroy();
            this.lazyLoader = null;
        }
        this.componentItems.clear();
        if (this.element && this.element.parentElement) {
            this.element.parentElement.removeChild(this.element);
        }
    }
}

export default ComponentPicker;