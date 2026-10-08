/**
 * KiCad symbol fetching owns resolving library/symdir paths and fetching raw
 * symbol files before handing them to the symbol parser.
 */

import { storageManager } from '../../core/StorageManager.js';
import { KICAD_LIBRARY_INDEX_CACHE_KEY, CONTENT_CACHE_TTL_MS } from './constants.js';
import { KICAD_SYMBOLS_PROJECT_PATH } from '../kicad-index-format.js';

/** @typedef {{type?: string, path?: string, name?: string}} GitLabTreeEntry */



    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Fetch a specific symbol
     * @param {string} library - Library name (e.g., "Timer")
     * @param {string} symbolName - Symbol name (e.g., "NE555")
     * @returns {Promise<import('../Component.js').ComponentDefinition|null>} ClearPCB symbol definition
     */
export async function fetchSymbol(fetcher, library, symbolName) {
    const cacheKey = `${library}:${symbolName}`;

    console.log(`KiCadFetcher: Fetching symbol ${library}:${symbolName}`);

    if (fetcher.symbolCache.has(cacheKey)) {
        const cached = fetcher.symbolCache.get(cacheKey);
        if (cached?.properties && Object.keys(cached.properties).length > 0) {
            console.log('KiCadFetcher: Using cached symbol');
            return cached;
        }
    }

    try {
        const directSymDir = `${library}.kicad_symdir`;
        const symContent = await fetcher._fetchSymbolFile(directSymDir, symbolName);
        if (symContent) {
            const symbol = fetcher._parseSymbolFromLibrary(symContent, symbolName);
            if (symbol) {
                if (symbol.symbol?._extends) {
                    await fetcher._resolveExtends(symbol, library);
                }
                symbol._kicadRaw = symContent;
                symbol.kicadName = symbol.kicadName || symbolName;
                fetcher.symbolCache.set(cacheKey, symbol);
                return symbol;
            }
        }

        // Symdir directory listing fallback: find a matching variant
        const matchedName = await fetcher._findMatchingSymbolInDir(library, symbolName);
        if (matchedName && matchedName !== symbolName) {
            console.log(`KiCadFetcher: Resolved ${symbolName} → ${matchedName} via directory listing`);
            const dirContent = await fetcher._fetchSymbolFile(directSymDir, matchedName);
            if (dirContent) {
                const symbol = fetcher._parseSymbolFromLibrary(dirContent, matchedName);
                if (symbol) {
                    if (symbol.symbol?._extends) {
                        await fetcher._resolveExtends(symbol, library);
                    }
                    symbol._kicadRaw = dirContent;
                    symbol.kicadName = symbol.kicadName || matchedName;
                    fetcher.symbolCache.set(cacheKey, symbol);
                    return symbol;
                }
            }
        }

        // Fetch the library file (legacy monolithic format)
        console.log('KiCadFetcher: Fetching library file...');
        const libContent = await fetcher._fetchLibraryFile(library);
        console.log(`KiCadFetcher: Library content received, length: ${libContent?.length || 0}`);

        if (!libContent) {
            console.error('KiCadFetcher: No library content received');
            return null;
        }

        // Parse and find the specific symbol
        console.log('KiCadFetcher: Parsing symbol from library...');
        const symbol = fetcher._parseSymbolFromLibrary(libContent, symbolName);

        if (symbol) {
            console.log('KiCadFetcher: Symbol parsed successfully');
            if (symbol.symbol?._extends) {
                await fetcher._resolveExtends(symbol, library);
            }
            symbol._kicadRaw = libContent;
            // Fallback: extract Footprint property from raw content if missing
            if (!symbol.properties || Object.keys(symbol.properties).length === 0) {
                symbol.properties = symbol.properties || {};
                const lookupName = symbol.kicadName || symbolName;
                const footprint = fetcher._extractFootprintFromContent(libContent, lookupName);
                if (footprint) {
                    symbol.properties.Footprint = footprint;
                }
            }

            fetcher.symbolCache.set(cacheKey, symbol);
        } else {
            console.warn('KiCadFetcher: Symbol not found after parsing');
        }

        return symbol;
    } catch (error) {
        console.error(`KiCadFetcher: Failed to fetch symbol ${library}:${symbolName}:`, error);
        return null;
    }
}



    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Fetch a library file from GitLab (with caching)
     * @param {string} library
     * @returns {Promise<string>}
     */
export async function _fetchLibraryFile(fetcher, library) {
    // Check storage cache first (with 7-day TTL)
    const cacheKey = `kicad_lib_${library}`;
    const cached = storageManager.get(cacheKey);
    if (cached && typeof cached === 'string') {
        console.log(`Using cached KiCad library: ${library}`);
        return cached;
    }

    const targetUrls = fetcher._buildSymbolLibraryUrlCandidates(library);
    const content = await fetcher._fetchFirstValidContentFromUrls(targetUrls, {
        validator: value => fetcher._isValidKiCadSymbolContent(value),
        logPrefix: `Fetching KiCad library: ${library}`
    });
    if (content) {
        console.log(`KiCad library ${library} fetched, size: ${content.length} bytes`);
        fetcher._cacheLibraryContent(cacheKey, library, content);
        return content;
    }

    // If initial attempts failed, refresh the index once and retry with discovered paths
    await fetcher._loadLibraryPathIndex(true);
    const refreshedPath = fetcher.libraryPathIndex?.[library];
    if (refreshedPath && !refreshedPath.endsWith('.kicad_symdir')) {
        const retryUrls = fetcher._buildRawUrlCandidates(fetcher.symbolsBase, refreshedPath);
        const retryContent = await fetcher._fetchFirstValidContentFromUrls(retryUrls, {
            validator: value => fetcher._isValidKiCadSymbolContent(value),
            logPrefix: `Fetching KiCad library (retry): ${library}`
        });
        if (retryContent) {
            fetcher._cacheLibraryContent(cacheKey, library, retryContent);
            return retryContent;
        }
    }

    throw new Error(`Failed to fetch KiCad library ${library} - all proxies failed`);
}



    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Load or refresh the library-name → file/directory path index from GitLab.
     * Uses a 7-day TTL cache in localStorage.
     * @param {boolean} [force=false] - Force refresh even if cached
     */
export async function _loadLibraryPathIndex(fetcher, force = false) {
    if (!force && fetcher.libraryPathIndex) {
        return;
    }

    const cacheKey = KICAD_LIBRARY_INDEX_CACHE_KEY;
    if (!force) {
        const cached = storageManager.get(cacheKey);
        if (cached && typeof cached === 'object') {
            fetcher.libraryPathIndex = cached;
            return;
        }
    }

    const perPage = 100;
    const refs = fetcher._getGitRefs();

    for (const ref of refs) {
        /** @type {Record<string, string>} */
        const index = {};
        let page = 1;
        let hasMore = true;

        while (hasMore) {
            const data = await fetcher._fetchGitLabTreePage({
                projectPath: KICAD_SYMBOLS_PROJECT_PATH,
                ref,
                perPage,
                page
            });
            if (!Array.isArray(data) || data.length === 0) {
                hasMore = false;
                break;
            }

            for (const entry of data) {
                if (typeof entry?.path !== 'string') continue;
                if (entry.type === 'blob' && entry.path.endsWith('.kicad_sym')) {
                    const name = entry.path.split('/').pop()?.replace(/\.kicad_sym$/i, '');
                    if (!name) continue;
                    if (!index[name]) {
                        index[name] = entry.path;
                    }
                    continue;
                }
                if (entry.type === 'tree' && entry.path.endsWith('.kicad_symdir')) {
                    const name = entry.path.split('/').pop()?.replace(/\.kicad_symdir$/i, '');
                    if (!name) continue;
                    if (!index[name]) {
                        index[name] = entry.path;
                    }
                }
            }

            page += 1;
        }

        if (Object.keys(index).length > 0) {
            fetcher.libraryPathIndex = index;
            fetcher._setContentCache(cacheKey, index);
            return;
        }
    }
}



    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * List the contents of a .kicad_symdir directory via GitLab tree API.
     * Results are cached per library name.
     * @param {string} library
     * @returns {Promise<string[]>}
     */
export async function _listSymdirContents(fetcher, library) {
    if (fetcher._symdirCache.has(library)) {
        return /** @type {string[]} */ (fetcher._symdirCache.get(library));
    }

    const symDirPath = `${library}.kicad_symdir`;
    const refs = fetcher._getGitRefs();

    for (const ref of refs) {
        const data = await fetcher._fetchGitLabTreePage({
            projectPath: KICAD_SYMBOLS_PROJECT_PATH,
            path: symDirPath,
            ref,
            perPage: 100,
            page: 1
        });
        if (!Array.isArray(data) || data.length === 0) continue;

        const files = /** @type {GitLabTreeEntry[]} */ (data)
            .filter(f => f.type === 'blob' && typeof f.name === 'string' && f.name.endsWith('.kicad_sym'))
            .map(f => /** @type {string} */ (f.name).replace(/\.kicad_sym$/, ''));

        if (files.length > 0) {
            fetcher._symdirCache.set(library, files);
            return files;
        }
    }

    fetcher._symdirCache.set(library, []);
    return [];
}



    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Find a symbol file in a symdir by exact or prefix match.
     * Returns the actual filename (without .kicad_sym) or null.
     * @param {string} library
     * @param {string} symbolName
     * @returns {Promise<string|null>}
     */
export async function _findMatchingSymbolInDir(fetcher, library, symbolName) {
    const files = await fetcher._listSymdirContents(library);
    if (!files.length) return null;

    const searchUpper = symbolName.toUpperCase();

    // Exact match first
    const exact = files.find(f => f.toUpperCase() === searchUpper);
    if (exact) return exact;

    // Prefix match – prefer shorter (more generic) names
    const prefixMatches = files
        .filter(f => f.toUpperCase().startsWith(searchUpper))
        .sort((a, b) => a.length - b.length);

    return prefixMatches.length > 0 ? prefixMatches[0] : null;
}



    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Fetch a single `.kicad_sym` file from a symdir on GitLab.
     * @param {string} symDirPath - Directory path within the symbols repo
     * @param {string} symbolName - Symbol name (used as filename stem)
     * @returns {Promise<string|null>} Raw file content or null
     */
export async function _fetchSymbolFile(fetcher, symDirPath, symbolName) {
    const fileName = `${symbolName}.kicad_sym`;
    const targetUrls = fetcher._buildRawUrlCandidates(fetcher.symbolsBase, `${symDirPath}/${fileName}`);
    return fetcher._fetchFirstValidContentFromUrls(targetUrls, {
        validator: value => fetcher._isValidKiCadSymbolContent(value),
        logPrefix: `Fetching KiCad symbol file: ${symDirPath}/${fileName}`
    });
}

