/**
 * ComponentPicker results-list owner. Renders local, EasyEDA, and KiCad rows plus lazy mini-preview loading.
 */

import { LazyLoader } from '../../core/LazyLoader.js';
import { fetchAndPlace, fetchAndPlaceKiCad, selectKiCadResult, selectLCSCResult } from './online-selection.js';
import { beginPlacement } from './placement.js';
import { applyLCSCThumbnail, createMiniPreview, normalizeDefinition, updatePreview } from './symbol-preview.js';
import { exactMatchQuery, isExactNameMatch, pickerResultNames, showNoResults } from './ui-state.js';

/** @typedef {import('../ComponentPicker.js').ComponentPicker} ComponentPicker */
/** @typedef {import('../ComponentPicker.js').KiCadSearchResult} KiCadSearchResult */
/** @typedef {import('../ComponentPicker.js').LCSCSearchResult} LCSCSearchResult */
/** @typedef {import('../ComponentPicker.js').PickerComponentDefinition} PickerComponentDefinition */

/**
 * Populates the results list with KiCad library search results.
 * @param {KiCadSearchResult[]} results - Array of KiCad search result objects.
 */
export function populateKiCadResults(/** @type {ComponentPicker} */ picker, results) {
    picker.listEl.innerHTML = `
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
        
        item.addEventListener('click', () => selectKiCadResult(picker, result, item));
        item.addEventListener('dblclick', () => fetchAndPlaceKiCad(picker, result));
        
        picker.listEl.appendChild(item);
    }
}

/**
 * Populates the results list with local library fallback results.
 * @param {PickerComponentDefinition[]} results - Array of local component definitions.
 * @param {string} query - The original search query for display.
 * @returns {Promise<void>}
 */
export async function populateLocalFallbackResults(/** @type {ComponentPicker} */ picker, results, query) {
    picker.listEl.innerHTML = `
        <div class="cp-kicad-notice">
            <strong>Local Library Results</strong>
            <br><small>Showing matches from built-in library for "${query}"</small>
        </div>
    `;
    
    for (const comp of results) {
        const item = document.createElement('div');
        item.className = 'cp-item';
        item.setAttribute('data-name', comp.name);
        
        const miniSvg = await createMiniPreview(picker, comp);
        
        item.innerHTML = `
            <div class="cp-item-icon">${miniSvg}</div>
            <div class="cp-item-info">
                <div class="cp-item-name">${comp.name}</div>
                <div class="cp-item-desc">${comp.description || ''}</div>
            </div>
        `;
        
        item.addEventListener('click', () => selectComponent(picker, comp, item));
        item.addEventListener('dblclick', () => {
            selectComponent(picker, comp);
        });
        
        picker.listEl.appendChild(item);
    }
}

/**
 * Populates the results list with combined EasyEDA and KiCad search results in a two-column layout.
 */
export function populateLCSCResults(/** @type {ComponentPicker} */ picker) {
    picker.listEl.innerHTML = '';
    
    // Remove any existing header row from previous searches
    const existingHeader = picker.body.querySelector('.cp-results-header-row');
    if (existingHeader) {
        existingHeader.remove();
    }
    
    const exact = exactMatchQuery(picker);
    const hasOnlineError = picker.lcscResults.length === 1 && picker.lcscResults[0].error;
    const lcscResults = exact && !hasOnlineError
        ? picker.lcscResults.filter(result => isExactNameMatch(exact, pickerResultNames.online(result)))
        : picker.lcscResults;
    const kicadResults = exact
        ? picker.kicadResults.filter(result => isExactNameMatch(exact, pickerResultNames.kicad(result)))
        : picker.kicadResults;
    const hasOnlineResults = lcscResults.length > 0 && !hasOnlineError;
    const hasKiCadResults = kicadResults.length > 0;

    if (!hasOnlineResults && !hasKiCadResults) {
        if (hasOnlineError) {
            picker.listEl.innerHTML = `
                <div class="cp-error">
                    ${picker.lcscResults[0].message}
                </div>
            `;
        } else {
            showNoResults(picker, exact);
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

        for (const result of lcscResults) {
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
            const stock = result.stock || 0;
            const stockStr = stock > 0
                ? `<span style="color:var(--schematic-component)">${stock.toLocaleString()} in stock</span>`
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
                applyLCSCThumbnail(picker, /** @type {HTMLElement} */ (iconEl), result);
            }

            item.addEventListener('click', () => selectLCSCResult(picker, result, item));
            item.addEventListener('dblclick', () => fetchAndPlace(picker, result));

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

        for (const result of kicadResults) {
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

            item.addEventListener('click', () => selectKiCadResult(picker, result, item));
            item.addEventListener('dblclick', () => fetchAndPlaceKiCad(picker, result));

            kicadInner.appendChild(item);
        }

        const kicadSpacer = document.createElement('div');
        kicadSpacer.className = 'cp-results-spacer';
        kicadInner.appendChild(kicadSpacer);

        kicadCol.appendChild(kicadInner);

        resultsGrid.appendChild(kicadCol);
    }

    picker.body.insertBefore(headerRow, picker.listEl);
    picker.listEl.appendChild(resultsGrid);
    balanceResultsColumns(picker);
}

/**
 * Balances scroll behavior of the two results columns so shorter lists don't scroll past their content.
 */
export function balanceResultsColumns(/** @type {ComponentPicker} */ picker) {
    requestAnimationFrame(() => {
        const grid = /** @type {HTMLElement|null} */ (picker.listEl.querySelector('.cp-results-grid'));
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
            const scrollTop = picker.listEl.scrollTop;
            
            lists.forEach((list, idx) => {
                const contentHeight = contentHeights[idx];
                const availableHeight = picker.listEl.clientHeight;
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
        if (picker._scrollHandler) {
            picker.listEl.removeEventListener('scroll', picker._scrollHandler);
        }
        picker._scrollHandler = handleScroll;
        picker.listEl.addEventListener('scroll', handleScroll);

        // Set grid height to tallest content
        grid.style.minHeight = `${maxHeight}px`;
    });
}

/**
 * Populates the category dropdown with available component categories from the library.
 */
export function populateCategories(/** @type {ComponentPicker} */ picker) {
    const categories = picker.library.getCategoryNames();
    categories.sort();
    
    for (const cat of categories) {
        const option = document.createElement('option');
        option.value = cat;
        option.textContent = cat;
        picker.categorySelect.appendChild(option);
    }
}

/**
 * Populates the component list based on the current search query and selected category.
 */
export function populateComponents(/** @type {ComponentPicker} */ picker) {
    picker.listEl.innerHTML = '';
    picker.componentItems.clear();
    
    // Cleanup previous lazy loader
    if (picker.lazyLoader) {
        picker.lazyLoader.destroy();
    }
    
    /** @type {PickerComponentDefinition[]} */
    let components;
    if (picker.searchQuery) {
        // Use SearchManager for local search
        components = picker.searchManager.searchLocal(picker.searchQuery);
        const exact = exactMatchQuery(picker);
        if (exact) components = components.filter(comp => isExactNameMatch(exact, pickerResultNames.local(comp)));
    } else if (picker.selectedCategory === 'All') {
        components = picker.library.getAllDefinitions();
    } else {
        components = picker.library.getByCategory(picker.selectedCategory);
    }
    
    if (!components || components.length === 0) {
        if (exactMatchQuery(picker)) showNoResults(picker, exactMatchQuery(picker));
        else picker.listEl.innerHTML = '<div class="cp-empty">No components found.</div>';
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
            selectComponent(picker, comp, item);
        });
        
        item.addEventListener('dblclick', () => {
            selectComponent(picker, comp);
        });
        
        picker.listEl.appendChild(item);
        picker.componentItems.set(item, comp);
    }
    
    // Set up lazy loading for component previews
    setupLazyLoading(picker);
}

/**
 * Sets up lazy loading for component preview thumbnails using an IntersectionObserver.
 */
export function setupLazyLoading(/** @type {ComponentPicker} */ picker) {
    // Create lazy loader for rendering component previews
    picker.lazyLoader = new LazyLoader({
        container: picker.listEl,
        threshold: 0.1,
        rootMargin: '50px',
        batchSize: 5,
        renderCallback: async (element, item) => {
            const comp = /** @type {PickerComponentDefinition|null|undefined} */ (item.data);
            if (!comp) return;
            
            try {
                const miniSvg = await createMiniPreview(picker, comp);
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
    for (const [element, comp] of picker.componentItems) {
        picker.lazyLoader.register(element, comp);
    }
}

/**
 * Selects a local component and updates the preview panel.
 * @param {PickerComponentDefinition} comp - The component definition to select.
 * @param {HTMLElement} [itemEl] - The clicked DOM element to highlight.
 */
export function selectComponent(/** @type {ComponentPicker} */ picker, comp, itemEl) {
    const normalized = normalizeDefinition(picker, comp);
    // Update selection state
    if (itemEl) {
        picker.listEl.querySelectorAll('.cp-item').forEach(el => {
            el.classList.remove('selected');
        });
        itemEl.classList.add('selected');
    }
    
    picker.selectedComponent = /** @type {PickerComponentDefinition} */ (normalized);
    picker.selectedLCSCResult = null;  // Clear any LCSC selection
    picker.placeBtn.disabled = false;
    picker.placeBtn.textContent = 'Place Component';
    
    // Reset button handler for local components
    picker.placeBtn.onclick = () => {
        if (picker.selectedComponent) {
            beginPlacement(picker, picker.selectedComponent);
        }
    };

    if (picker.previewImage) {
        picker.previewImage.innerHTML = '';
    }
    
    // Update preview
    updatePreview(picker, normalized);
}
