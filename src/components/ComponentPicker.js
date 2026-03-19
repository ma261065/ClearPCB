/**
 * ComponentPicker - Panel for browsing and selecting components
 */

import { getComponentLibrary } from '../components/index.js';
import { ModalManager } from '../core/ModalManager.js';
import { globalEventBus } from '../core/EventBus.js';
import { getSearchManager, initSearchManager } from '../core/SearchManager.js';
import { LazyLoader } from '../core/LazyLoader.js';
import { createDebouncedRunner, createGenerationGate } from './async-control.js';

export class ComponentPicker {
    /**
     * Creates a new ComponentPicker instance for browsing and selecting components.
     * @param {Object} [options] - Configuration options.
     * @param {Object} [options.eventBus] - Event bus for component events.
     */
    constructor(options = {}) {
        this.library = getComponentLibrary();
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
        this.searchRequestGate = createGenerationGate();
        this.selectionRequestGate = createGenerationGate();
        this.searchDebouncer = createDebouncedRunner(400, () => {
            this._searchLCSC();
        });
        
        // Lazy loading
        this.lazyLoader = null;
        this.componentItems = new Map();
        
        this._createDOM();
        this._populateCategories();
        this._populateComponents();
    }
    
    /**
     * Creates the DOM structure for the component picker panel.
     */
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
                    <div class="cp-preview-loading-overlay" style="display:none">
                        <span class="cp-spinner"></span>
                        <span class="cp-preview-loading-text">Loading...</span>
                    </div>
                    <div class="cp-preview-info"></div></div>
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
                    <kbd>Space</kbd> Rotate &nbsp; <kbd>X</kbd> Flip H &nbsp; <kbd>Y</kbd> Flip V
                </div>
            </div>
        `;
        
        // Get references
        this.searchInput = /** @type {HTMLInputElement} */ (this.element.querySelector('.cp-search-input'));
        this.searchClearBtn = /** @type {HTMLButtonElement} */ (this.element.querySelector('.cp-search-clear'));
        this.categorySelect = /** @type {HTMLSelectElement} */ (this.element.querySelector('.cp-category-select'));
        this.body = /** @type {HTMLElement} */ (this.element.querySelector('.cp-body'));
        this.listEl = /** @type {HTMLElement} */ (this.element.querySelector('.cp-list'));
        this.previewSvg = /** @type {HTMLElement} */ (this.element.querySelector('.cp-preview-svg'));
        this.previewLoadingOverlay = /** @type {HTMLElement} */ (this.element.querySelector('.cp-preview-loading-overlay'));
        this.previewLoadingText = /** @type {HTMLElement} */ (this.element.querySelector('.cp-preview-loading-text'));
        this.previewInfo = /** @type {HTMLElement} */ (this.element.querySelector('.cp-preview-info'));
        this.previewImage = /** @type {HTMLElement} */ (this.element.querySelector('.cp-preview-image'));
        this.previewFootprint = /** @type {HTMLElement} */ (this.element.querySelector('.cp-preview-footprint'));
        this.previewFootprintInfo = /** @type {HTMLElement} */ (this.element.querySelector('.cp-preview-footprint-info'));
        this.preview3d = /** @type {HTMLElement} */ (this.element.querySelector('.cp-preview-3d'));
        this.preview3dInfo = /** @type {HTMLElement} */ (this.element.querySelector('.cp-preview-3d-info'));
        this.placeBtn = /** @type {HTMLButtonElement} */ (this.element.querySelector('.cp-place-btn'));
        this.bodyEl = /** @type {HTMLElement} */ (this.element.querySelector('.cp-body'));
        this.modeButtons = /** @type {NodeListOf<HTMLButtonElement>} */ (this.element.querySelectorAll('.cp-mode-btn'));
        this.categoriesEl = /** @type {HTMLElement} */ (this.element.querySelector('.cp-categories'));
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
     * Switches between local and LCSC/online search modes.
     * @param {string} mode - The search mode ('local' or 'lcsc').
     */
    _setSearchMode(mode) {
        this.searchMode = mode;
        this.searchDebouncer.cancel();
        this.searchRequestGate.invalidate();
        this.selectionRequestGate.invalidate();
        this.isSearching = false;
        
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
                // If first-time KiCad indexing started in background, surface
                // progress immediately even before the user types a query.
                this._watchKiCadIndexProgressIfLoading();
            }
        } else {
            this._populateComponents();
        }
    }

    /**
     * If KiCad index loading is already in-flight and no usable index exists,
     * display the indexing progress while the user is in Online mode.
     */
    async _watchKiCadIndexProgressIfLoading() {
        const fetcher = this.library?.kicadFetcher;
        if (!fetcher || fetcher.libraryIndex) {
            return;
        }

        const watchId = this.searchRequestGate.next();
        const initial = fetcher._indexProgress || {
            loaded: 0,
            total: 0,
            message: 'Loading KiCad library index...'
        };
        let sawProgress = false;
        this._showIndexingProgress(initial.message, initial.loaded, initial.total);

        try {
            await fetcher.ensureIndexLoaded((progress) => {
                if (this.searchMode === 'lcsc'
                    && this.searchQuery.trim().length < 2
                    && this.searchRequestGate.isCurrent(watchId)) {
                    sawProgress = true;
                    this._showIndexingProgress(progress.message, progress.loaded, progress.total);
                }
            });
        } catch (error) {
            if (this.searchMode === 'lcsc'
                && this.searchQuery.trim().length < 2
                && this.searchRequestGate.isCurrent(watchId)) {
                this.listEl.innerHTML = `
                    <div class="cp-error">
                        Failed to load KiCad index. You can still search EasyEDA results.
                    </div>
                `;
            }
            return;
        }

        if (this.searchMode === 'lcsc'
            && this.searchQuery.trim().length < 2
            && this.searchRequestGate.isCurrent(watchId)) {
            // If we never got progress updates, index likely came from cache immediately.
            // Return to prompt in that case.
            if (!sawProgress) {
                this._showLCSCPrompt();
            }
        }
    }
    
    /**
     * Displays the LCSC search prompt with usage examples.
     */
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
    
    /**
     * Displays a loading spinner in the component list area.
     */
    _showLoading() {
        this.listEl.innerHTML = `
            <div class="cp-loading">
                <span class="cp-spinner"></span>
                Searching online...
            </div>
        `;
    }

    /**
     * Set the Place button into a loading state with a spinner, or back to ready.
     * @param {string} text - Button label text
     * @param {boolean} loading - If true, show spinner and disable; if false, just set text
     * @param {boolean} [disabled] - Explicit disabled state (default: true when loading)
     */
    _setPlaceBtnLoading(text, loading, disabled = loading) {
        this.placeBtn.disabled = disabled;
        if (loading) {
            this.placeBtn.innerHTML = `<span class="cp-spinner"></span>${text}`;
        } else {
            this.placeBtn.textContent = text;
        }
    }

    /**
     * Show/hide the large loading overlay below the symbol preview.
     * @param {string|null} message - Message to show, or null to hide
     */
    _setPreviewLoading(message) {
        if (!this.previewLoadingOverlay) return;
        if (message) {
            if (this.previewLoadingText) this.previewLoadingText.textContent = message;
            this.previewLoadingOverlay.style.display = '';
        } else {
            this.previewLoadingOverlay.style.display = 'none';
        }
    }

    /**
     * Displays an indexing progress bar during KiCad library initialization.
     * @param {string} message - Progress message to display.
     * @param {number} loaded - Number of items loaded so far.
     * @param {number} total - Total number of items to load.
     */
    _showIndexingProgress(message, loaded, total) {
        const pct = total > 0 ? Math.min(100, Math.round(loaded / total * 100)) : 0;
        const barStyle = total > 0
            ? `width:${pct}%; animation:none;`
            : '';
        this.listEl.innerHTML = `
            <div class="cp-loading cp-indexing">
                <span class="cp-spinner"></span>
                <div class="cp-indexing-message">${message || 'Loading KiCad library index...'}</div>
                <div class="cp-progress-bar"><div class="cp-progress-bar-fill" style="${barStyle}"></div></div>
                <div class="cp-indexing-hint">First-time setup — results are cached for future searches</div>
            </div>
        `;
    }
    
    /**
     * Debounces the LCSC search to avoid excessive API calls during typing.
     */
    _debouncedLCSCSearch() {
        this.searchDebouncer.run();
    }
    
    /**
     * Searches online EasyEDA and KiCad catalogs for components matching the current query.
     * @returns {Promise<void>}
     */
    async _searchLCSC() {
        const query = this.searchQuery.trim();
        
        if (query.length < 2) {
            this._showLCSCPrompt();
            return;
        }
        
        this.isSearching = true;
        this._showLoading();
        
        // Track search generation to prevent stale results overwriting newer ones
        const searchId = this.searchRequestGate.next();

        // Ensure the KiCad index is loaded (shows progress bar on first use)
        const fetcher = this.library.kicadFetcher;
        if (!fetcher.libraryIndex) {
            // Show immediate feedback that the index is loading
            if (this.searchRequestGate.isCurrent(searchId)) {
                this._showIndexingProgress('Loading KiCad library index...', 0, 0);
            }
            await fetcher.ensureIndexLoaded((progress) => {
                // Only show indexing progress if still in LCSC mode and same search
                if (this.searchMode === 'lcsc' && this.searchRequestGate.isCurrent(searchId)) {
                    this._showIndexingProgress(progress.message, progress.loaded, progress.total);
                }
            });
            if (!this.searchRequestGate.isCurrent(searchId)) return;
            // If user switched to local mode while indexing, abort this search
            if (this.searchMode !== 'lcsc') return;
        }
        
        this._showLoading();
        
        try {
            // Search both EasyEDA (online) and KiCad
            const [onlineResults, kicadResults] = await Promise.all([
                this.searchManager.searchLCSC(query),
                this.searchManager.searchKiCad(query)
            ]);

            // Discard results if a newer search has been initiated
            if (!this.searchRequestGate.isCurrent(searchId) || this.searchMode !== 'lcsc') return;

            this.lcscResults = onlineResults || [];
            this.kicadResults = kicadResults || [];
            this._populateLCSCResults();
        } catch (error) {
            if (!this.searchRequestGate.isCurrent(searchId) || this.searchMode !== 'lcsc') return;
            console.error('LCSC search error:', error);
            this.listEl.innerHTML = `
                <div class="cp-error">
                    Search failed. Try the Local library instead.
                </div>
            `;
        } finally {
            if (this.searchRequestGate.isCurrent(searchId)) {
                this.isSearching = false;
            }
        }
    }
    
    /**
     * Falls back to KiCad and local library search when LCSC search fails.
     * @param {string} query - The search query string.
     * @returns {Promise<void>}
     */
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
    
    /**
     * Populates the results list with KiCad library search results.
     * @param {Array<Object>} results - Array of KiCad search result objects.
     */
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
    
    /**
     * Populates the results list with local library fallback results.
     * @param {Array<Object>} results - Array of local component definitions.
     * @param {string} query - The original search query for display.
     * @returns {Promise<void>}
     */
    async _populateLocalFallbackResults(results, query) {
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
            
            const miniSvg = await this._createMiniPreview(comp);
            
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
    
    /**
     * Handles selection of a KiCad search result and loads its preview.
     * @param {Object} result - The selected KiCad result object.
     * @param {HTMLElement} itemEl - The clicked DOM element.
     */
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
        this._setPlaceBtnLoading('Checking footprint...', true);
        this._setPreviewLoading('Loading component...');
        this.placeBtn.onclick = null;

                this._loadKiCadFootprintStatus(/** @type {Object} */ (result));
    }

    /**
     * Loads and verifies KiCad footprint and 3D model availability for a selected result.
     * @param {Object} result - The KiCad result to check footprint status for.
     * @returns {Promise<void>}
     */
    async _loadKiCadFootprintStatus(result) {
        const selId = this.selectionRequestGate.next();
        try {
            const kicadDefinition = await this.searchManager.fetchFromKiCad(result.library, result.name);
            if (!this.selectionRequestGate.isCurrent(selId)) return;
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
                        iconEl.innerHTML = await this._createMiniPreview(previewDef);
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
                // Allow placement even without a footprint — it's a schematic symbol
                const placeDefNoFp = this._buildKiCadDefinition(kicadDefinition, result);
                const hasRenderable = (kicadSymbol?.pins?.length || 0) > 0 || (kicadSymbol?.graphics?.length || 0) > 0;
                this.placeBtn.disabled = !hasRenderable;
                this.placeBtn.textContent = hasRenderable ? 'Place Component' : 'No symbol data';
                if (hasRenderable) {
                    this.placeBtn.onclick = () => this._beginPlacement(placeDefNoFp, { skipFootprint3d: true });
                }
                console.log('KiCad footprint not specified for', result.library, result.name, kicadSymbol?.properties);
                return;
            }

            const availability = await this.library.kicadFetcher.checkFootprintAvailability(footprintName);
            if (!this.selectionRequestGate.isCurrent(selId)) return;
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
                // Render 3D STEP preview
                this.preview3d.innerHTML = '<div class="cp-preview-placeholder">Loading 3D model...</div>';
                this.preview3dInfo.innerHTML = '<span style="color:var(--text-muted)">Rendering...</span>';
                try {
                    const { STEPPreview } = await import('./STEPPreview.js');
                    const svgPreview = await STEPPreview.fetchAndRender(availability.modelUrl, {
                        lineColor: '#444444',
                        fillColor: '#666666',
                        lineWidth: 0.8,
                        strokeOpacity: 0.9,
                        fillOpacity: 0.7,
                        proxyUrl: this.library?.kicadFetcher?.corsProxy
                    });
                    this.preview3d.innerHTML = '';
                    const parser = new DOMParser();
                    const svgDoc = parser.parseFromString(svgPreview, 'image/svg+xml');
                    this.preview3d.appendChild(svgDoc.documentElement);
                    this.preview3dInfo.innerHTML = '<span class="cp-preview-ok">3D model available</span>';
                } catch (e) {
                    console.error('3D STEP preview error:', e);
                    this.preview3d.innerHTML = '<div class="cp-preview-placeholder">3D model available (STEP)</div>';
                    this.preview3dInfo.innerHTML = '<span class="cp-preview-ok">3D model available</span>';
                }
            } else {
                this._set3dPreviewStatus('3D model not found', false);
            }

            const ready = availability.hasFootprint;
            const placeDefinition = this._buildKiCadDefinition(kicadDefinition, result);
            this.placeBtn.disabled = !ready;
            this.placeBtn.textContent = ready ? 'Place Component' : 'Missing footprint';
            this.placeBtn.onclick = ready
                ? () => this._beginPlacement(placeDefinition, { skipFootprint3d: true })
                : null;
            this._setPreviewLoading(null);
        } catch (error) {
            console.error('Failed to verify KiCad footprint:', error);
            this._setFootprintPreviewStatus('Footprint check failed', false);
            this._set3dPreviewStatus('3D check failed', false);
            this._setPreviewLoading(null);
            // Still allow placement if we have symbol data
            if (this.selectedKiCadResult) {
                this.placeBtn.disabled = false;
                this.placeBtn.textContent = 'Place Component';
                const fallbackResult = this.selectedKiCadResult;
                this.placeBtn.onclick = () => this._fetchAndPlaceKiCad(fallbackResult);
            } else {
                this.placeBtn.disabled = true;
                this.placeBtn.textContent = 'Check failed';
            }
        }
    }
    
    /**
     * Fetches full KiCad symbol data and initiates component placement.
     * @param {Object} result - The KiCad result to fetch and place.
     * @returns {Promise<void>}
     */
    async _fetchAndPlaceKiCad(result) {
        this.placeBtn.disabled = true;
        this._setPlaceBtnLoading('Fetching...', true);
        
        try {
            // Use SearchManager to fetch from KiCad
            const kicadData = await this.searchManager.fetchFromKiCad(result.library, result.name);
            const kicadSymbol = kicadData?.symbol || kicadData;
            const kicadProperties = kicadData?.properties || kicadData?.symbol?.properties || kicadSymbol?.properties;
            
            if (kicadData) {
                const footprintName = this._getPropertyValue(kicadProperties, 'Footprint');
                if (footprintName) {
                    const availability = await this.library.kicadFetcher.checkFootprintAvailability(footprintName);
                    if (!availability.hasFootprint) {
                        this.previewInfo.innerHTML += `<br><span style="color:var(--text-muted)">Footprint not found on KiCad GitLab</span>`;
                    }
                }

                // Create a component definition from KiCad data
                const definition = this._buildKiCadDefinition(kicadData, result);
                
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
    
    /**
     * Populates the results list with combined EasyEDA and KiCad search results in a two-column layout.
     */
    _populateLCSCResults() {
        this.listEl.innerHTML = '';
        
        // Remove any existing header row from previous searches
        const existingHeader = this.body.querySelector('.cp-results-header-row');
        if (existingHeader) {
            existingHeader.remove();
        }
        
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
                    this._applyLCSCThumbnail(/** @type {HTMLElement} */ (iconEl), result);
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

    /**
     * Balances scroll behavior of the two results columns so shorter lists don't scroll past their content.
     */
    _balanceResultsColumns() {
        requestAnimationFrame(() => {
            const grid = /** @type {HTMLElement|null} */ (this.listEl.querySelector('.cp-results-grid'));
            if (!grid) return;
            const lists = /** @type {HTMLElement[]} */ (Array.from(grid.querySelectorAll('.cp-results-col-list')));
            if (lists.length < 2) return;

            // Remove spacers - we'll use JS to control scroll
            lists.forEach(list => {
                const spacer = list.querySelector('.cp-results-spacer');
                if (spacer) spacer.remove();
            });

            // Get actual content heights (without spacers)
            const contentHeights = lists.map(list => {
                const items = /** @type {HTMLElement[]} */ (Array.from(list.querySelectorAll('.cp-item')));
                return items.reduce((sum, item) => sum + item.offsetHeight + parseFloat(getComputedStyle(item).marginBottom || '0'), 0);
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
                        // Content fits entirely in viewport — pin it so it doesn't scroll away
                        list.style.transform = scrollTop > 0 ? `translateY(${scrollTop}px)` : '';
                    } else if (scrollTop >= maxScroll) {
                        // Scrolled past this list's content — clamp it at the bottom
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
    
    /**
     * Handles selection of an LCSC/EasyEDA search result and loads its preview.
     * @param {Object} result - The selected LCSC result object.
     * @param {HTMLElement} itemEl - The clicked DOM element.
     * @returns {Promise<void>}
     */
    async _selectLCSCResult(result, itemEl) {
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
        this._setPlaceBtnLoading('Preparing...', true);
        this._setPreviewLoading('Loading component...');
        this.placeBtn.onclick = null;

        await this._loadEasyEDADetailForPreview(result);
    }

    /**
     * Loads EasyEDA component detail metadata and updates footprint/3D previews.
     * @param {Object} result - The LCSC result to load detail for.
     * @returns {Promise<void>}
     */
    async _loadEasyEDADetailForPreview(result) {
        const selId = this.selectionRequestGate.next();
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
            if (!this.selectionRequestGate.isCurrent(selId)) return;
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

            const ready = metadata.hasFootprint;
            if (!ready) {
                this.placeBtn.disabled = true;
                this.placeBtn.textContent = 'Missing footprint';
                this.placeBtn.onclick = null;
                return;
            }

            if (!result._definitionPromise) {
                result._definitionPromise = this.searchManager.fetchFromLCSC(result.lcscPartNumber);
            }

            const definition = await result._definitionPromise;
            if (!this.selectionRequestGate.isCurrent(selId)) return;
            if (definition?.symbol) {
                this._updatePreview(definition);
                if (this.selectedLCSCResult === result) {
                    const selectedItem = this.listEl.querySelector('.cp-item.selected');
                    if (selectedItem) {
                        const iconEl = selectedItem.querySelector('.cp-item-icon');
                        if (iconEl) {
                            // Try to show photo first, fall back to rendered symbol
                            const hasPhoto = await this._tryApplyLCSCThumbnail(/** @type {HTMLElement} */ (iconEl), result);
                            if (!hasPhoto) {
                                iconEl.innerHTML = await this._createMiniPreview(definition);
                            }
                        }
                    }
                }
            }

            this.placeBtn.disabled = false;
            this.placeBtn.textContent = 'Place Component';
            this.placeBtn.onclick = () => this._placePrefetchedLCSC(result);
            this._setPreviewLoading(null);
        } catch (error) {
            console.error('Failed to load EasyEDA detail:', error);
            this._setFootprintPreviewStatus('Footprint load failed', false);
            this._set3dPreviewStatus('3D load failed', false);
            this._setPreviewLoading(null);
            this.placeBtn.disabled = true;
            this.placeBtn.textContent = 'Missing footprint/3D';
            this.placeBtn.onclick = null;
        }
    }
    
    /**
     * Fetches full EasyEDA/LCSC component data and initiates placement.
     * @param {Object} result - The LCSC result to fetch and place.
     * @returns {Promise<void>}
     */
    async _fetchAndPlace(result) {
        this.placeBtn.disabled = true;
        this._setPlaceBtnLoading('Placing...', true);

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

                if (!definition.hasFootprint) {
                    this.previewInfo.innerHTML += `<br><span style="color:var(--accent-color)">Missing footprint data</span>`;
                    this._updatePreview(definition);
                    this.placeBtn.disabled = true;
                    this.placeBtn.textContent = 'Missing footprint';
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

    /**
     * Places a component using prefetched LCSC data, including footprint and 3D metadata.
     * @param {Object} result - The LCSC result with prefetched definition data.
     * @returns {Promise<void>}
     */
    async _placePrefetchedLCSC(result) {
        this.placeBtn.disabled = true;
        this._setPlaceBtnLoading('Placing...', true);

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

                if (!definition.hasFootprint) {
                    this.previewInfo.innerHTML += `<br><span style="color:var(--accent-color)">Missing footprint data</span>`;
                    this._updatePreview(definition);
                    this.placeBtn.disabled = true;
                    this.placeBtn.textContent = 'Missing footprint';
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
    
    /**
     * Populates the category dropdown with available component categories from the library.
     */
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
    
    /**
     * Populates the component list based on the current search query and selected category.
     */
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
                <div class="cp-item-icon"></div>
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
    
    /**
     * Sets up lazy loading for component preview thumbnails using an IntersectionObserver.
     */
    _setupLazyLoading() {
        // Create lazy loader for rendering component previews
        this.lazyLoader = new LazyLoader({
            container: this.listEl,
            threshold: 0.1,
            rootMargin: '50px',
            batchSize: 5,
            renderCallback: async (element, item) => {
                const comp = item.data;
                if (!comp) return;
                
                try {
                    const miniSvg = await this._createMiniPreview(comp);
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
                    iconEl.innerHTML = '';
                }
            }
        });
        
        // Register all items for lazy loading
        for (const [element, comp] of this.componentItems) {
            this.lazyLoader.register(element, comp);
        }
    }
    
    /**
     * Selects a local component and updates the preview panel.
     * @param {Object} comp - The component definition to select.
     * @param {HTMLElement} [itemEl] - The clicked DOM element to highlight.
     */
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

    /**
     * Begins component placement by emitting a selection event.
     * @param {Object} definition - The normalized component definition.
     * @param {Object} [options] - Placement options.
     * @param {boolean} [options.skipFootprint3d] - Whether to skip footprint/3D preview updates.
     */
    _beginPlacement(definition, options = {}) {
        if (!definition) return;
        this.selectedComponent = this._normalizeDefinition(definition);
        this._updatePreview(this.selectedComponent, { skipFootprint3d: !!options.skipFootprint3d });

        this._setPlaceBtnLoading('Place Component', false, true);
        this._setPreviewLoading(null);

        this.eventBus.emit('component:selected', this.selectedComponent);
    }

    /**
     * Normalizes a component definition to ensure it has a consistent structure with a symbol property.
     * @param {Object} definition - The raw component definition.
     * @returns {Object} The normalized definition.
     */
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
    
    /**
     * Creates a small SVG preview of a component for use in the list view.
     * @param {Object} comp - The component definition to preview.
     * @returns {Promise<string>} HTML string containing the SVG preview.
     */
    async _createMiniPreview(comp) {
        if (!comp.symbol) return '<span style="color:var(--text-muted)">?</span>';
        
        try {
            // Use the Component class to render the mini preview for consistency
            const { Component } = await import('./Component.js');
            const tempComponent = new Component(comp, { x: 0, y: 0 });
            
            const symbol = comp.symbol;
            const paddingX = 2;
            const paddingY = 2;
            
            // Get bounds from the Component class
            const localBounds = tempComponent._getLocalBounds();
            
            if (!Number.isFinite(localBounds.minX) || !Number.isFinite(localBounds.minY) ||
                !Number.isFinite(localBounds.maxX) || !Number.isFinite(localBounds.maxY)) {
                return '<span style="color:var(--text-muted)">?</span>';
            }
            
            // Create mini SVG using the same rendering as the actual component
            const viewBox = `${localBounds.minX - paddingX} ${localBounds.minY - paddingY} ${localBounds.maxX - localBounds.minX + paddingX * 2} ${localBounds.maxY - localBounds.minY + paddingY * 2}`;
            
            const ns = 'http://www.w3.org/2000/svg';
            const svg = document.createElementNS(ns, 'svg');
            svg.setAttribute('viewBox', viewBox);
            svg.setAttribute('width', '32');
            svg.setAttribute('height', '32');
            svg.setAttribute('style', 'overflow:visible');
            
            // Render graphics
            if (symbol.graphics && Array.isArray(symbol.graphics)) {
                for (const graphic of symbol.graphics) {
                    const el = tempComponent._createGraphicElement(graphic, ns);
                    if (el) svg.appendChild(el);
                }
            }
            
            // Render pins
            if (symbol.pins && Array.isArray(symbol.pins)) {
                for (const pin of symbol.pins) {
                    const pinGroup = tempComponent._createPinElement(pin, ns);
                    if (pinGroup) {
                        // Keep the pin line only; drop dots/labels for small previews.
                        pinGroup.querySelectorAll('text, circle').forEach(el => el.remove());
                        svg.appendChild(pinGroup);
                    }
                }
            }
            
            return svg.outerHTML;
        } catch (error) {
            console.error('Error creating mini preview:', error);
            return '<span style="color:var(--text-muted)">?</span>';
        }
    }

    /**
     * Checks whether a URL points directly to an image file.
     * @param {string} url - The URL to test.
     * @returns {boolean} True if the URL ends with a common image extension.
     */
    _isDirectImageUrl(url) {
        if (!url || typeof url !== 'string') return false;
        return /\.(png|jpe?g|gif|webp)(\?.*)?$/i.test(url);
    }

    /**
     * Applies an LCSC product thumbnail image to the given icon element.
     * @param {HTMLElement} iconEl - The icon container element.
     * @param {Object} result - The LCSC result with thumbnail URL data.
     * @returns {Promise<void>}
     */
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

    /**
     * Attempts to apply an LCSC thumbnail; returns whether a photo was successfully applied.
     * @param {HTMLElement} iconEl - The icon container element.
     * @param {Object} result - The LCSC result with thumbnail URL data.
     * @returns {Promise<boolean>} True if a photo thumbnail was applied.
     */
    async _tryApplyLCSCThumbnail(iconEl, result) {
        const thumbUrl = result.thumbUrl || result.imageUrl || '';
        if (!thumbUrl && (!result.lcscPartNumber || !this.library?.lcscFetcher)) {
            return false;
        }

        if (thumbUrl && this._isDirectImageUrl(thumbUrl)) {
            iconEl.innerHTML = `<img src="${thumbUrl}" alt="" onerror="this.parentElement.innerHTML='<span>📦</span>'">`;
            return true;
        }

        if (!result.lcscPartNumber || !this.library?.lcscFetcher) {
            return false;
        }

        if (!result._thumbPromise) {
            result._thumbPromise = this.library.lcscFetcher.fetchEasyedaProductImage(result.lcscPartNumber);
        }

        try {
            const resolvedUrl = await result._thumbPromise;
            result._thumbPromise = null;
            if (resolvedUrl && this._isDirectImageUrl(resolvedUrl)) {
                iconEl.innerHTML = `<img src="${resolvedUrl}" alt="" onerror="this.parentElement.innerHTML='<span>📦</span>'">`;
                return true;
            }
        } catch (error) {
            result._thumbPromise = null;
        }
        
        return false;
    }

    /**
     * Updates the preview panel's product image for an LCSC result.
     * @param {Object} result - The LCSC result to display the image for.
     * @returns {Promise<void>}
     */
    async _updateLCSCPreviewImage(result) {
        if (!this.previewImage) return;

        this.previewImage.innerHTML = '<div class="cp-preview-placeholder">Loading image...</div>';

        const directUrl = result.imageUrl || result.thumbUrl || '';
        if (directUrl && this._isDirectImageUrl(directUrl)) {
            this.previewImage.innerHTML = `<img src="${directUrl}" alt="" onerror="this.parentElement.innerHTML=''">`;
            return;
        }

        if (!result.lcscPartNumber || !this.library?.lcscFetcher) {
            this.previewImage.innerHTML = '';
            return;
        }

        try {
            const resolvedUrl = await this.library.lcscFetcher.fetchEasyedaProductImage(result.lcscPartNumber);
            if (resolvedUrl) {
                this.previewImage.innerHTML = `<img src="${resolvedUrl}" alt="" onerror="this.parentElement.innerHTML=''">`;
            } else {
                this.previewImage.innerHTML = '';
            }
        } catch (error) {
            this.previewImage.innerHTML = '';
        }
    }
    
    /**
     * Updates the full symbol preview SVG and info panel for a component.
     * @param {Object} comp - The component definition to preview.
     * @param {Object} [options] - Preview options.
     * @param {boolean} [options.skipFootprint3d] - Whether to skip footprint/3D updates.
     * @returns {Promise<void>}
     */
    async _updatePreview(comp, options = {}) {
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
            
            // Use the Component class to render the preview for consistency
            const { Component } = await import('./Component.js');
            const tempComponent = new Component(comp, { x: 0, y: 0 });
            
            const symbol = comp.symbol;
            const paddingX = 6;
            const paddingY = 10;
            
            // Get bounds from the Component class
            const localBounds = tempComponent._getLocalBounds();
            
            // Validate numeric values
            if (!Number.isFinite(localBounds.minX) || !Number.isFinite(localBounds.minY) ||
                !Number.isFinite(localBounds.maxX) || !Number.isFinite(localBounds.maxY)) {
                throw new Error('Invalid symbol bounds');
            }
            
            // Create preview SVG using the same rendering as the actual component
            const viewBox = `${localBounds.minX - paddingX} ${localBounds.minY - paddingY} ${localBounds.maxX - localBounds.minX + paddingX * 2} ${localBounds.maxY - localBounds.minY + paddingY * 2}`;
            
            const ns = 'http://www.w3.org/2000/svg';
            const svg = document.createElementNS(ns, 'svg');
            svg.setAttribute('viewBox', viewBox);
            svg.setAttribute('style', 'width:100%;height:100%;max-height:150px');
            
            // Render graphics
            if (symbol.graphics && Array.isArray(symbol.graphics)) {
                for (const graphic of symbol.graphics) {
                    const el = tempComponent._createGraphicElement(graphic, ns);
                    if (el) svg.appendChild(el);
                }
            }
            
            // Render pins
            if (symbol.pins && Array.isArray(symbol.pins)) {
                for (const pin of symbol.pins) {
                    const pinGroup = tempComponent._createPinElement(pin, ns);
                    if (pinGroup) svg.appendChild(pinGroup);
                }
            }
            
            this.previewSvg.innerHTML = '';
            this.previewSvg.appendChild(svg);
            
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

    /**
     * Computes the bounding box of a symbol's graphics and pins.
     * @param {Object} symbol - The symbol definition with graphics and pins arrays.
     * @returns {Object|null} Bounds object with minX, minY, maxX, maxY, width, height, or null if invalid.
     */
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

    /**
     * Sets the footprint preview section to a status message.
     * @param {string} message - The status message to display.
     * @param {boolean} available - Whether the footprint is available.
     */
    _setFootprintPreviewStatus(message, available) {
        if (!this.previewFootprint) return;
        this.previewFootprint.innerHTML = `<div class="cp-preview-placeholder">${message}</div>`;
        if (this.previewFootprintInfo) {
            this.previewFootprintInfo.innerHTML = available
                ? '<span class="cp-preview-ok">Footprint available</span>'
                : '<span class="cp-preview-warn">Footprint unavailable</span>';
        }
    }

    /**
     * Sets the 3D model preview section to a status message.
     * @param {string} message - The status message to display.
     * @param {boolean} available - Whether the 3D model is available.
     */
    _set3dPreviewStatus(message, available) {
        if (!this.preview3d) return;
        this.preview3d.innerHTML = `<div class="cp-preview-placeholder">${message}</div>`;
        if (this.preview3dInfo) {
            this.preview3dInfo.innerHTML = available
                ? '<span class="cp-preview-ok">3D model available</span>'
                : '<span class="cp-preview-warn">3D model unavailable</span>';
        }
    }

    /**
     * Updates the footprint preview panel with rendered SVG from component metadata.
     * @param {Object} metadata - Component metadata containing footprint shapes and bounding box.
     */
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

    /**
     * Updates the 3D model preview panel by rendering VRML or OBJ model data.
     * @param {Object} metadata - Component metadata containing 3D model URL or OBJ data.
     * @returns {Promise<void>}
     */
    async _update3dPreview(metadata) {
        if (!metadata || !metadata.has3d) {
            this._set3dPreviewStatus('No 3D model', false);
            return;
        }

        const modelName = metadata.model3dName || '3D model';
        
        // Render 3D preview for both KiCad (VRML URLs) and EasyEDA (OBJ data)
        if (metadata.model3dUrl || metadata.model3dObj) {
            this.preview3d.innerHTML = '<div class="cp-preview-placeholder">Loading 3D model...</div>';
            if (this.preview3dInfo) {
                this.preview3dInfo.innerHTML = '<span style="color:var(--text-muted)">Rendering...</span>';
            }

            try {
                const { VRMLPreview } = await import('./VRMLPreview.js');
                let svgPreview;
                
                if (metadata.model3dUrl) {
                    // KiCad VRML model - fetch and render
                    svgPreview = await VRMLPreview.fetchAndRender(metadata.model3dUrl, {
                        lineColor: '#444444',
                        fillColor: '#666666',
                        lineWidth: 0.8,
                        strokeOpacity: 0.9,
                        fillOpacity: 0.7,
                        proxyUrl: this.library?.kicadFetcher?.corsProxy
                    });
                } else if (metadata.model3dObj) {
                    // EasyEDA OBJ model - render directly
                    svgPreview = VRMLPreview.renderOBJ(metadata.model3dObj, {
                        lineColor: '#444444',
                        fillColor: '#666666',
                        lineWidth: 0.8,
                        strokeOpacity: 0.9,
                        fillOpacity: 0.7
                    });
                }
                
                // Parse and insert SVG using DOM
                this.preview3d.innerHTML = '';
                const parser = new DOMParser();
                const svgDoc = parser.parseFromString(svgPreview, 'image/svg+xml');
                const svgElement = svgDoc.documentElement;
                this.preview3d.appendChild(svgElement);
                
                if (this.preview3dInfo) {
                    this.preview3dInfo.innerHTML = `<span class="cp-preview-ok">${modelName}</span>`;
                }
            } catch (error) {
                console.error('Error rendering 3D preview:', error);
                this.preview3d.innerHTML = `<div class="cp-preview-placeholder">🧊 ${modelName}</div>`;
                if (this.preview3dInfo) {
                    this.preview3dInfo.innerHTML = '<span class="cp-preview-ok">3D model available</span>';
                }
            }
        } else {
            // No model data available
            this.preview3d.innerHTML = `<div class="cp-preview-placeholder">🧊 ${modelName}</div>`;
            if (this.preview3dInfo) {
                this.preview3dInfo.innerHTML = '<span class="cp-preview-ok">3D model available</span>';
            }
        }
    }

    /**
     * Renders footprint pad shapes into an SVG string.
     * @param {Array<string>} shapes - Array of shape descriptor strings (e.g., PAD~ format).
     * @param {Object} bbox - Bounding box with x, y, width, height properties.
     * @returns {string} SVG markup string, or empty string if no valid shapes.
     */
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


    /**
     * Builds a normalized component definition from raw KiCad data.
     * @param {Object} kicadData - Raw KiCad symbol data (may contain nested symbol property).
     * @param {Object} result - The KiCad search result with name and library info.
     * @returns {Object} A component definition suitable for placement.
     */
    _buildKiCadDefinition(kicadData, result) {
        const kicadSymbol = kicadData?.symbol || kicadData;
        const kicadProperties = kicadData?.properties || kicadData?.symbol?.properties || kicadSymbol?.properties;
        const def = kicadData?.symbol
            ? { ...kicadData, _source: 'KiCad' }
            : {
                name: `KiCad_${result.name}`,
                description: `${result.name} from KiCad ${result.library} library`,
                category: 'KiCad',
                symbol: kicadSymbol,
                _source: 'KiCad'
            };
        def.defaultValue = this._getPropertyValue(kicadProperties, 'Value') || result.name;
        if (kicadSymbol?._kicadRaw) def._kicadRaw = kicadSymbol._kicadRaw;
        return def;
    }

    /**
     * Retrieves a property value from a properties object using case-insensitive key matching.
     * @param {Object} properties - The properties object to search.
     * @param {string} key - The property key to look up.
     * @returns {string} The property value, or empty string if not found.
     */
    _getPropertyValue(properties, key) {
        if (!properties || typeof properties !== 'object') return '';
        if (properties[key]) return properties[key];

        const lowerKey = key.toLowerCase();
        const match = Object.keys(properties).find(propKey => propKey.toLowerCase() === lowerKey);
        return match ? properties[match] : '';
    }
    
    /**
     * Renders an array of graphic primitives into SVG markup strings.
     * @param {Array<Object>} graphics - Array of graphic objects (line, rect, circle, etc.).
     * @param {number} [defaultStrokeWidth=0.254] - Default stroke width for rendered elements.
     * @returns {string} Concatenated SVG element strings.
     */
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
    
    /**
     * Renders a single component pin as SVG markup including its connection line and endpoint dot.
     * @param {Object} pin - The pin object with x, y coordinates and optional path data.
     * @returns {string} SVG markup string for the pin.
     */
    _renderPinToSVG(pin) {
        try {
            if (!pin || typeof pin.x !== 'number' || typeof pin.y !== 'number') {
                return '';
            }
            
            const strokeWidth = 0.2;
            let svg = '';
            
            // Parse the actual path from pin data if available
            let lineX1, lineY1, lineX2, lineY2;
            
            if (pin._pathData) {
                // Parse SVG path commands (M x y h dx, M x y v dy, M x y L x2 y2)
                const pathMatch = pin._pathData.match(/M\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*([hvL])\s*(-?\d+(?:\.\d+)?)/i);
                if (pathMatch) {
                    lineX1 = Number(pathMatch[1]);
                    lineY1 = Number(pathMatch[2]);
                    const cmd = pathMatch[3].toLowerCase();
                    const value = Number(pathMatch[4]);
                    
                    if (cmd === 'h') {
                        lineX2 = lineX1 + value;
                        lineY2 = lineY1;
                    } else if (cmd === 'v') {
                        lineX2 = lineX1;
                        lineY2 = lineY1 + value;
                    } else if (cmd === 'l') {
                        lineX2 = lineX1 + value;
                        lineY2 = lineY1;
                    }
                } else {
                    // Try alternate format without spaces: M345,285h10
                    const pathMatch2 = pin._pathData.match(/M(-?\d+(?:\.\d+)?)[,\s](-?\d+(?:\.\d+)?)([hvL])(-?\d+(?:\.\d+)?)/i);
                    if (pathMatch2) {
                        lineX1 = Number(pathMatch2[1]);
                        lineY1 = Number(pathMatch2[2]);
                        const cmd = pathMatch2[3].toLowerCase();
                        const value = Number(pathMatch2[4]);
                        
                        if (cmd === 'h') {
                            lineX2 = lineX1 + value;
                            lineY2 = lineY1;
                        } else if (cmd === 'v') {
                            lineX2 = lineX1;
                            lineY2 = lineY1 + value;
                        } else if (cmd === 'l') {
                            lineX2 = lineX1 + value;
                            lineY2 = lineY1;
                        }
                    }
                }
            }
            
            // If we successfully parsed the path, render it
            if (Number.isFinite(lineX1) && Number.isFinite(lineY1) && 
                Number.isFinite(lineX2) && Number.isFinite(lineY2)) {
                svg += `<line x1="${lineX1}" y1="${lineY1}" x2="${lineX2}" y2="${lineY2}" 
                              stroke="var(--schematic-component, #00cc66)" stroke-width="${strokeWidth}"/>`;
            }
            
            // Pin endpoint dot at connection point (pin.x, pin.y)
            svg += `<circle cx="${pin.x}" cy="${pin.y}" r="0.4" fill="var(--schematic-pin, #e94560)" stroke="none"/>`;
            
            return svg;
        } catch (error) {
            console.warn('Error rendering pin:', error, pin);
            return '';
        }
    }
    
    /**
     * Toggles the component picker panel open or closed.
     */
    toggle() {
        this.isOpen = !this.isOpen;
        if (this.isOpen) {
            this.element.classList.remove('collapsed');
            // Register with ModalManager so ESC will close the picker
            ModalManager.push('componentPicker', () => {
                this.close();
                this.eventBus.emit('component:pickerClosed');
            });
        } else {
            this.element.classList.add('collapsed');
            // Unregister from ModalManager
            ModalManager.pop('componentPicker');
        }
    }
    
    /**
     * Closes the component picker panel and cleans up the lazy loader.
     */
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
    
    /**
     * Opens the component picker panel if it is not already open.
     */
    open() {
        if (!this.isOpen) {
            this.toggle();
        }
    }
    
    /**
     * Appends the component picker element to a parent DOM node.
     * @param {HTMLElement} parent - The parent element to append to.
     */
    appendTo(parent) {
        parent.appendChild(this.element);
    }
    
    /**
     * Returns the currently selected component definition.
     * @returns {Object|null} The selected component, or null if none is selected.
     */
    getSelectedComponent() {
        return this.selectedComponent;
    }
    
    /**
     * Clears the current component selection and resets the preview panel.
     */
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
        if (this.searchDebouncer) {
            this.searchDebouncer.dispose();
        }
        if (this._scrollHandler && this.listEl) {
            this.listEl.removeEventListener('scroll', this._scrollHandler);
            this._scrollHandler = null;
        }
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