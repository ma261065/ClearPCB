/**
 * ComponentPicker search owner. Manages search mode, debounced online queries, and KiCad index progress.
 */

import { populateComponents, populateKiCadResults, populateLCSCResults, populateLocalFallbackResults } from './results-list.js';
import { updatePackageSelector } from './symbol-preview.js';
import { showIndexingProgress, showLCSCPrompt, showLoading } from './ui-state.js';

/**
 * Switches between local and LCSC/online search modes.
 * @param {string} mode - The search mode ('local' or 'lcsc').
 */
export function setSearchMode(/** @type {any} */ picker, mode) {
    picker.searchMode = mode;
    picker.searchDebouncer.cancel();
    picker.searchRequestGate.invalidate();
    picker.selectionRequestGate.invalidate();
    picker.isSearching = false;
    
    // Update button states
    picker.modeButtons.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === mode);
    });
    
    // Show/hide categories (only for local mode)
    picker.categoriesEl.style.display = mode === 'local' ? 'block' : 'none';
    
    // Update placeholder
    picker.searchInput.placeholder = mode === 'lcsc' 
        ? 'Search online (e.g., NE555, C46749)...'
        : 'Search components...';
    
    // Clear selection and refresh list
    picker.selectedComponent = null;
    picker.placeBtn.disabled = true;
    updatePackageSelector(picker, null);
    picker.previewSvg.innerHTML = '';
    picker.previewInfo.innerHTML = '';
    
    if (mode === 'lcsc') {
        picker.lcscResults = [];
        if (picker.searchQuery.length >= 2) {
            searchLCSC(picker);
        } else {
            showLCSCPrompt(picker);
            prepareKiCadIndex(picker);
        }
    } else {
        populateComponents(picker);
    }
}

/**
 * Load the index on first Online use, showing progress until a usable index exists.
 */
export async function prepareKiCadIndex(/** @type {any} */ picker) {
    const fetcher = picker.library?.kicadFetcher;
    if (!picker.isOpen || picker.searchMode !== 'lcsc' || !fetcher || fetcher.libraryIndex) {
        return;
    }

    const watchId = picker.searchRequestGate.next();
    const initial = fetcher._indexProgress || {
        loaded: 0,
        total: 0,
        message: 'Loading KiCad library index...'
    };
    let sawProgress = false;
    showIndexingProgress(picker, initial.message, initial.loaded, initial.total);

    try {
        await fetcher.ensureIndexLoaded((progress) => {
            if (picker.isOpen && picker.searchMode === 'lcsc'
                && picker.searchQuery.trim().length < 2
                && picker.searchRequestGate.isCurrent(watchId)) {
                sawProgress = true;
                showIndexingProgress(picker, progress.message, progress.loaded, progress.total);
            }
        });
    } catch (error) {
        if (picker.isOpen && picker.searchMode === 'lcsc'
            && picker.searchQuery.trim().length < 2
            && picker.searchRequestGate.isCurrent(watchId)) {
            picker.listEl.innerHTML = `
                <div class="cp-error">
                    Failed to load KiCad index. Try the Local library or retry your search.
                </div>
            `;
        }
        return;
    }

    if (picker.isOpen && picker.searchMode === 'lcsc'
        && picker.searchQuery.trim().length < 2
        && picker.searchRequestGate.isCurrent(watchId)) {
        // If we never got progress updates, index likely came from cache immediately.
        // Return to prompt in that case.
        if (!sawProgress) {
            showLCSCPrompt(picker);
        }
    }
}

/**
 * Debounces the LCSC search to avoid excessive API calls during typing.
 */
export function debouncedLCSCSearch(/** @type {any} */ picker) {
    picker.searchDebouncer.run();
}

/**
 * Searches online EasyEDA and KiCad catalogs for components matching the current query.
 * @returns {Promise<void>}
 */
export async function searchLCSC(/** @type {any} */ picker) {
    const query = picker.searchQuery.trim();
    
    if (query.length < 2) {
        showLCSCPrompt(picker);
        return;
    }
    
    picker.isSearching = true;
    showLoading(picker);
    
    // Track search generation to prevent stale results overwriting newer ones
    const searchId = picker.searchRequestGate.next();

    try {
        const fetcher = picker.library.kicadFetcher;
        if (!fetcher.libraryIndex) {
            showIndexingProgress(picker, 'Loading KiCad library index...', 0, 0);
            await fetcher.ensureIndexLoaded((progress) => {
                if (picker.searchMode === 'lcsc' && picker.searchRequestGate.isCurrent(searchId)) {
                    showIndexingProgress(picker, progress.message, progress.loaded, progress.total);
                }
            });
            if (!picker.searchRequestGate.isCurrent(searchId) || picker.searchMode !== 'lcsc') return;
        }
        showLoading(picker);

        // Search both EasyEDA (online) and KiCad
        const [onlineResults, kicadResults] = await Promise.all([
            picker.searchManager.searchLCSC(query),
            picker.searchManager.searchKiCad(query)
        ]);

        // Discard results if a newer search has been initiated
        if (!picker.searchRequestGate.isCurrent(searchId) || picker.searchMode !== 'lcsc') return;

        picker.lcscResults = onlineResults || [];
        picker.kicadResults = kicadResults || [];
        populateLCSCResults(picker);
    } catch (error) {
        if (!picker.searchRequestGate.isCurrent(searchId) || picker.searchMode !== 'lcsc') return;
        console.error('LCSC search error:', error);
        picker.listEl.innerHTML = `
            <div class="cp-error">
                Search failed. Try the Local library instead.
            </div>
        `;
    } finally {
        if (picker.searchRequestGate.isCurrent(searchId)) {
            picker.isSearching = false;
        }
    }
}

/**
 * Falls back to KiCad and local library search when LCSC search fails.
 * @param {string} query - The search query string.
 * @returns {Promise<void>}
 */
export async function searchKiCadFallback(/** @type {any} */ picker, query) {
    try {
        // Use SearchManager for KiCad search
        const kicadResults = await picker.searchManager.searchKiCad(query);
        
        if (kicadResults && kicadResults.length > 0) {
            populateKiCadResults(picker, kicadResults);
        } else {
            // Also search local library via SearchManager
            const localResults = picker.searchManager.searchLocal(query);
            if (localResults.length > 0) {
                populateLocalFallbackResults(picker, localResults, query);
            } else {
                picker.listEl.innerHTML = `
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
        picker.listEl.innerHTML = `
            <div class="cp-error">
                Search failed. Try the Local library instead.
            </div>
        `;
    }
}
