/**
 * KiCad symbol index owns the searchable library index, including published
 * static index hydration, stale-cache refresh and progress callbacks.
 */

import { storageManager } from '../../core/StorageManager.js';
import { KEYWORD_ALIASES, KICAD_FULL_SYMBOL_INDEX_CACHE_KEY, SEARCH_CACHE_TTL_MS } from './constants.js';
import { addSymbolTreeEntries, isLikelyValidSymbolIndex, KICAD_SYMBOLS_PROJECT_PATH, REQUIRED_LIBRARY_NAMES } from '../kicad-index-format.js';

/** @typedef {{library: string, name: string, fullName: string}} SymbolSearchResult */
/** @typedef {{loaded: number, total: number, message: string}} KiCadIndexProgress */
/** @typedef {(progress: KiCadIndexProgress) => void} KiCadIndexProgressCallback */



    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Search for a symbol by MPN or name
     * @param {string} query - Part number or name to search for
     * @returns {Promise<SymbolSearchResult[]>} Matching symbols
     */
export async function searchSymbols(fetcher, query) {
    // Check search result cache first (skip empty arrays — may be stale)
    const cacheKey = `kicad_search_${query.toLowerCase()}`;
    const cachedResults = storageManager.get(cacheKey);
    if (cachedResults && Array.isArray(cachedResults) && cachedResults.length > 0) {
        console.log(`Using cached KiCad search results for: ${query}`);
        return cachedResults;
    }

    // If index is currently being fetched, wait for it
    if (!fetcher.libraryIndex && fetcher._indexLoadPromise) {
        await fetcher._indexLoadPromise;
    }
    // If still not loaded, try to load (shouldn’t normally happen)
    if (!fetcher.libraryIndex) {
        await fetcher.ensureIndexLoaded();
    }

    if (!fetcher.libraryIndex) {
        return [];
    }

    // Split query into individual terms so "10k resistor" matches
    // a symbol whose library+name together contain both "10k" and "resistor".
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

    // Expand keyword aliases: "resistor" → look for symbol names starting
    // with "R", "R_", etc.  Each term can optionally have aliases.
    const termAliases = terms.map(t => {
        const prefixes = KEYWORD_ALIASES.get(t);
        return prefixes
            ? prefixes.map(p => p.toLowerCase())
            : null;            // null means plain substring match
    });

    const results = [];

    for (const [libName, symbols] of Object.entries(fetcher.libraryIndex.symbols)) {
        const libLower = libName.toLowerCase();
        for (const symbolName of symbols) {
            const symLower = symbolName.toLowerCase();
            const combined = libLower + ' ' + symLower;

            const matches = terms.every((t, i) => {
                const aliases = termAliases[i];
                if (aliases) {
                    // Term has aliases — match if symbol name equals an
                    // alias exactly OR starts with alias + '_'  (word
                    // boundary).  e.g. alias 'r' matches 'R' and 'R_Small'
                    // but NOT 'RJ45' or 'RC4558'.
                    return aliases.some(a =>
                        symLower === a || symLower.startsWith(a + '_'))
                        || combined.includes(t);
                }
                return combined.includes(t);
            });

            if (matches) {
                results.push({
                    library: libName,
                    name: symbolName,
                    fullName: `${libName}:${symbolName}`
                });
            }
        }
    }

    const limitedResults = results.slice(0, 50); // Limit results

    // Only cache non-empty results (empty may be due to index not loaded yet)
    if (limitedResults.length > 0) {
        storageManager.set(cacheKey, limitedResults, SEARCH_CACHE_TTL_MS);
    }

    return limitedResults;
}




    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Ensure the symbol index is loaded. Returns immediately if already cached.
     * Otherwise fetches from GitLab (blocking). Callers can pass an onProgress
     * callback to show progress: onProgress({ loaded, total, message }).
     * Multiple concurrent callers share the same in-flight promise.
     * @param {KiCadIndexProgressCallback} [onProgress]
     * @returns {Promise<void>}
     */
export async function ensureIndexLoaded(fetcher, onProgress) {
    if (fetcher.libraryIndex) return;

    // Always keep the latest progress callback so re-triggered searches
    // (e.g. debounced keystrokes) still show the progress bar.
    if (onProgress) {
        fetcher._onProgress = onProgress;
        if (!fetcher.libraryIndex && fetcher._indexLoadPromise) {
            fetcher._emitIndexProgress(fetcher._indexProgress || {
                loaded: 0,
                total: 0,
                message: 'Loading KiCad library index...'
            });
        }
    }

    // Wait for StorageManager to finish loading from IndexedDB
    // before checking the cache, otherwise we'd miss cached data.
    await storageManager.ready;

    const published = await fetcher._loadStaticIndex();
    if (fetcher.libraryIndex) return;
    if (published) {
        fetcher._useSymbolIndex(published.symbols);
        return;
    }

    // Detect latest KiCad release tag (cached, non-blocking after first call)
    await fetcher._detectLatestRelease();

    // Re-check — hydration may have populated the index via another path
    if (fetcher.libraryIndex) return;

    // Stale-while-revalidate: serve expired cache immediately,
    // then refresh in the background so the user can search right away.
    const cacheKey = KICAD_FULL_SYMBOL_INDEX_CACHE_KEY;
    const cached = storageManager.getRaw(cacheKey);

    if (cached && cached.data && typeof cached.data === 'object'
        && Object.keys(cached.data).length > 0) {
        if (isLikelyValidSymbolIndex(cached.data)) {
            fetcher._useSymbolIndex(cached.data);

            if (cached.expired) {
                // Serve stale data now — refresh silently in the background
                console.log('KiCadFetcher: Serving stale index, refreshing in background...');
                fetcher._refreshIndexInBackground();
            }
            return;
        }

        console.warn('KiCadFetcher: Cached symbol index appears incomplete; rebuilding from GitLab.');
    }

    // No cached data at all (first visit) — fetch with progress bar
    if (!fetcher._indexLoadPromise) {
        fetcher._emitIndexProgress({ loaded: 0, total: 0, message: 'Loading KiCad library index...' });
        fetcher._indexLoadPromise = fetcher._fetchFullSymbolIndex()
            .finally(() => {
                fetcher._indexLoadPromise = null;
                fetcher._onProgress = null;
            });
    }
    return fetcher._indexLoadPromise;
}



    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Adopt an already-complete symbol index without overwriting per-library
     * listings fetched earlier.
     * @param {Object.<string, string[]>} symbols
     */
export function _useSymbolIndex(fetcher, symbols) {
    fetcher.libraryIndex = { symbols };
    for (const [lib, names] of Object.entries(symbols)) {
        if (!fetcher._symdirCache.has(lib)) {
            fetcher._symdirCache.set(lib, names);
        }
    }
}



    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Silently refresh the symbol index in the background.
     * Updates in-memory + localStorage caches when done.
     */
export function _refreshIndexInBackground(fetcher) {
    fetcher._fetchFullSymbolIndex().then(() => {
        console.log('KiCadFetcher: Background index refresh complete');
    }).catch(err => {
        console.warn('KiCadFetcher: Background index refresh failed:', err);
    });
}



    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Persist latest index progress and notify active UI callback (if any).
     * @param {{loaded:number,total:number,message:string}} progress
     */
export function _emitIndexProgress(fetcher, progress) {
    fetcher._indexProgress = progress;
    if (fetcher._onProgress) {
        fetcher._onProgress(progress);
    }
}



    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Fetch the complete symbol index from GitLab using the recursive tree API.
     * Parses paths like "Timer.kicad_symdir/NE555D.kicad_sym" to build
     * { Timer: ['NE555D', ...], ... }.  Caches the result for 7 days.
     */
export async function _fetchFullSymbolIndex(fetcher) {
    const refs = fetcher._getGitRefs();
    const pageSize = 100;
    const parallelPages = 8;
    const minCompletionRatio = 0.9;

    /**
     * @param {unknown} entries
     * @param {Record<string, string[]>} index
     * @returns {number}
     */
    const processEntries = (entries, index) => {
        if (!Array.isArray(entries)) {
            return 0;
        }
        addSymbolTreeEntries(entries, index);
        return entries.length;
    };

    for (const ref of refs) {
        /** @type {Record<string, string[]>} */
        const index = {};
        let totalEntries = 0;
        let totalExpected = 0;
        let failedPages = 0;

        fetcher._emitIndexProgress({ loaded: 0, total: 0, message: 'Connecting to KiCad library...' });

        const firstPage = await fetcher._fetchGitLabTreePage({
            projectPath: KICAD_SYMBOLS_PROJECT_PATH,
            recursive: true,
            ref,
            perPage: pageSize,
            page: 1
        }, true);

        if (!firstPage || !Array.isArray(firstPage.json) || firstPage.json.length === 0) {
            continue;
        }

        const xt = firstPage.headers?.get('x-total');
        if (xt) {
            totalExpected = parseInt(xt, 10) || 0;
        }

        totalEntries += processEntries(firstPage.json, index);

        let totalPages = 1;
        const totalPagesHeader = firstPage.headers?.get('x-total-pages');
        if (totalPagesHeader) {
            totalPages = Math.max(1, parseInt(totalPagesHeader, 10) || 1);
        } else if (totalExpected > 0) {
            totalPages = Math.max(1, Math.ceil(totalExpected / pageSize));
        }

        {
            const libCount = Object.keys(index).length;
            const symCount = Object.values(index).reduce((n, a) => n + a.length, 0);
            const pct = totalExpected > 0
                ? ` (${Math.round(totalEntries / totalExpected * 100)}%)`
                : '';
            fetcher._emitIndexProgress({
                loaded: totalEntries,
                total: totalExpected,
                message: `Indexing KiCad library${pct}... ${libCount} libraries, ${symCount} symbols`
            });
        }

        for (let startPage = 2; startPage <= totalPages; startPage += parallelPages) {
            const pages = [];
            for (let page = startPage; page < startPage + parallelPages && page <= totalPages; page++) {
                pages.push(page);
            }

            const pageResults = await Promise.all(
                pages.map(page => fetcher._fetchGitLabTreePage({
                    projectPath: KICAD_SYMBOLS_PROJECT_PATH,
                    recursive: true,
                    ref,
                    perPage: pageSize,
                    page
                }))
            );

            for (const data of pageResults) {
                if (!Array.isArray(data)) {
                    failedPages++;
                    continue;
                }
                totalEntries += processEntries(data, index);
            }

            {
                const libCount = Object.keys(index).length;
                const symCount = Object.values(index).reduce((n, a) => n + a.length, 0);
                const pct = totalExpected > 0
                    ? ` (${Math.round(totalEntries / totalExpected * 100)}%)`
                    : '';
                fetcher._emitIndexProgress({
                    loaded: totalEntries,
                    total: totalExpected,
                    message: `Indexing KiCad library${pct}... ${libCount} libraries, ${symCount} symbols`
                });
            }
        }

        const completionRatio = totalExpected > 0
            ? (totalEntries / totalExpected)
            : 1;
        const hasRequiredLibraries = REQUIRED_LIBRARY_NAMES.every(name =>
            Array.isArray(index[name]) && index[name].length > 0
        );

        if (failedPages > 0 || completionRatio < minCompletionRatio || !hasRequiredLibraries) {
            console.warn(
                `KiCadFetcher: Incomplete index fetch (ref=${ref}, failedPages=${failedPages}, ` +
                `completion=${(completionRatio * 100).toFixed(1)}%, hasRequired=${hasRequiredLibraries}); ` +
                'discarding partial index.'
            );
            continue;
        }

        if (Object.keys(index).length > 0) {
            fetcher.libraryIndex = { symbols: index };
            const saved = fetcher._setContentCache(KICAD_FULL_SYMBOL_INDEX_CACHE_KEY, index);
            if (!saved) {
                console.warn('KiCadFetcher: Failed to cache index in localStorage (quota exceeded?). ' +
                    'The index will need to be re-downloaded on next visit.');
            }

            // Populate the per-library symdir cache
            for (const [lib, symbols] of Object.entries(index)) {
                fetcher._symdirCache.set(lib, symbols);
            }

            console.log(`KiCadFetcher: Full index loaded — ${Object.keys(index).length} libraries, ` +
                `${Object.values(index).reduce((n, a) => n + a.length, 0)} symbols`);
            fetcher._emitIndexProgress({
                loaded: totalExpected || totalEntries,
                total: totalExpected || totalEntries,
                message: 'KiCad library index ready'
            });
            return;
        }
    }
    throw new Error('Unable to load a complete KiCad symbol index.');
}

