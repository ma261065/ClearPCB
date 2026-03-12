/**
 * KiCadFetcher - Fetches and parses KiCad symbol and footprint libraries
 * 
 * KiCad libraries use an S-expression format and are hosted on GitLab.
 * Symbols: https://gitlab.com/kicad/libraries/kicad-symbols
 * Footprints: https://gitlab.com/kicad/libraries/kicad-footprints
 * 3D Models: https://gitlab.com/kicad/libraries/kicad-packages3D
 */

import { storageManager } from '../core/StorageManager.js';
import { circumcircle } from '../core/geometry.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const SEARCH_CACHE_TTL_MS = DAY_MS;
const CONTENT_CACHE_TTL_MS = 7 * DAY_MS;
const SYMBOL_LIBRARY_MARKER = 'kicad_symbol_lib';
const FOOTPRINT_MARKER = 'footprint';
const CONTENT_PREVIEW_LENGTH = 200;
const KICAD_GIT_REFS = ['master', 'main'];
const KICAD_SYMBOLS_PROJECT_PATH = 'kicad%2Flibraries%2Fkicad-symbols';
const KICAD_LIBRARY_INDEX_CACHE_KEY = 'kicad_library_index';
const KICAD_FULL_SYMBOL_INDEX_CACHE_KEY = 'kicad_full_symbol_index';

export class KiCadFetcher {
    /** Initialise GitLab base URLs, CORS proxies and in-memory caches. */
    constructor() {
        // GitLab raw file base URLs
        this.symbolsBase = 'https://gitlab.com/kicad/libraries/kicad-symbols/-/raw/master';
        this.footprintsBase = 'https://gitlab.com/kicad/libraries/kicad-footprints/-/raw/master';
        this.models3dBase = 'https://gitlab.com/kicad/libraries/kicad-packages3D/-/raw/master';
        
        // CORS proxy options - use Cloudflare Worker
        this.corsProxies = [
            'https://clearpcb.mikealex.workers.dev/?url='
        ];
        
        // Cache fetched data
        this.symbolCache = new Map();
        this.footprintCache = new Map();
        this.footprintExistsCache = new Map();
        this.model3dExistsCache = new Map();
        this.footprintPreviewCache = new Map();
        this._symdirCache = new Map();
        this.libraryIndex = null;
        this._indexLoadPromise = null;
        this.libraryPathIndex = null;
        this.fetchFailed = false;
    }
    
    /** @returns {string} The primary CORS proxy URL. */
    get corsProxy() {
        return this.corsProxies[0];
    }

    /**
     * Keyword aliases for common component types.
     * Maps human-readable terms to KiCad symbol-name prefixes so that
     * searching "resistor" finds R, R_Small, R_US, etc. in the Device library.
     */
    static KEYWORD_ALIASES = new Map([
        ['resistor',    ['R']],
        ['capacitor',   ['C']],
        ['inductor',    ['L']],
        ['led',         ['LED']],
        ['potentiometer', ['R_Potentiometer']],
        ['thermistor',  ['Thermistor']],
        ['fuse',        ['Fuse', 'Polyfuse']],
        ['ferrite',     ['FerriteBead', 'L_Ferrite']],
        ['crystal',     ['Crystal']],
        ['transformer', ['Transformer']],
        ['relay',       ['Relay']],
        ['switch',      ['SW']],
        ['button',      ['SW_Push', 'SW_DPDT']],
        ['mosfet',      ['Q_NMOS', 'Q_PMOS', 'BSS', 'IRF', 'IRLML', 'Si2', 'AO']],
        ['transistor',  ['Q', 'BC', '2N', 'MMBT']],
        ['opamp',       ['LM358', 'LM324', 'TL07', 'TL08', 'OPA', 'MCP60', 'NE5532', 'AD82']],
        ['regulator',   ['LM78', 'LM317', 'AMS1117', 'MCP170', 'AP2112', 'L78']],
        ['op-amp',      ['LM358', 'LM324', 'TL07', 'TL08', 'OPA', 'MCP60', 'NE5532', 'AD82']],
        ['battery',     ['Battery']],
        ['motor',       ['Motor']],
        ['speaker',     ['Speaker']],
        ['microphone',  ['Microphone']],
        ['buzzer',      ['Buzzer']],
        ['varistor',    ['Varistor']],
        ['antenna',     ['Antenna']],
    ]);
    
    /**
     * Search for a symbol by MPN or name
     * @param {string} query - Part number or name to search for
     * @returns {Promise<Array>} Matching symbols
     */
    async searchSymbols(query) {
        // Check search result cache first (skip empty arrays — may be stale)
        const cacheKey = `kicad_search_${query.toLowerCase()}`;
        const cachedResults = storageManager.get(cacheKey);
        if (cachedResults && Array.isArray(cachedResults) && cachedResults.length > 0) {
            console.log(`Using cached KiCad search results for: ${query}`);
            return cachedResults;
        }
        
        // If index is currently being fetched, wait for it
        if (!this.libraryIndex && this._indexLoadPromise) {
            await this._indexLoadPromise;
        }
        // If still not loaded, try to load (shouldn’t normally happen)
        if (!this.libraryIndex) {
            await this.ensureIndexLoaded();
        }
        
        if (!this.libraryIndex) {
            return [];
        }
        
        // Split query into individual terms so "10k resistor" matches
        // a symbol whose library+name together contain both "10k" and "resistor".
        const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

        // Expand keyword aliases: "resistor" → look for symbol names starting
        // with "R", "R_", etc.  Each term can optionally have aliases.
        const termAliases = terms.map(t => {
            const prefixes = KiCadFetcher.KEYWORD_ALIASES.get(t);
            return prefixes
                ? prefixes.map(p => p.toLowerCase())
                : null;            // null means plain substring match
        });

        const results = [];
        
        for (const [libName, symbols] of Object.entries(this.libraryIndex.symbols)) {
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
     * Fetch a specific symbol
     * @param {string} library - Library name (e.g., "Timer")
     * @param {string} symbolName - Symbol name (e.g., "NE555")
     * @returns {Promise<object>} ClearPCB symbol definition
     */
    async fetchSymbol(library, symbolName) {
        const cacheKey = `${library}:${symbolName}`;
        
        console.log(`KiCadFetcher: Fetching symbol ${library}:${symbolName}`);
        
        if (this.symbolCache.has(cacheKey)) {
            const cached = this.symbolCache.get(cacheKey);
            if (cached?.properties && Object.keys(cached.properties).length > 0) {
                console.log('KiCadFetcher: Using cached symbol');
                return cached;
            }
        }
        
        try {
            const directSymDir = `${library}.kicad_symdir`;
            const symContent = await this._fetchSymbolFile(directSymDir, symbolName);
            if (symContent) {
                const symbol = this._parseSymbolFromLibrary(symContent, symbolName);
                if (symbol) {
                    if (symbol.symbol?._extends) {
                        await this._resolveExtends(symbol, library);
                    }
                    symbol._kicadRaw = symContent;
                    symbol.kicadName = symbol.kicadName || symbolName;
                    this.symbolCache.set(cacheKey, symbol);
                    return symbol;
                }
            }

            // Symdir directory listing fallback: find a matching variant
            const matchedName = await this._findMatchingSymbolInDir(library, symbolName);
            if (matchedName && matchedName !== symbolName) {
                console.log(`KiCadFetcher: Resolved ${symbolName} → ${matchedName} via directory listing`);
                const dirContent = await this._fetchSymbolFile(directSymDir, matchedName);
                if (dirContent) {
                    const symbol = this._parseSymbolFromLibrary(dirContent, matchedName);
                    if (symbol) {
                        if (symbol.symbol?._extends) {
                            await this._resolveExtends(symbol, library);
                        }
                        symbol._kicadRaw = dirContent;
                        symbol.kicadName = symbol.kicadName || matchedName;
                        this.symbolCache.set(cacheKey, symbol);
                        return symbol;
                    }
                }
            }

            // Fetch the library file (legacy monolithic format)
            console.log('KiCadFetcher: Fetching library file...');
            const libContent = await this._fetchLibraryFile(library);
            console.log(`KiCadFetcher: Library content received, length: ${libContent?.length || 0}`);
            
            if (!libContent) {
                console.error('KiCadFetcher: No library content received');
                return null;
            }
            
            // Parse and find the specific symbol
            console.log('KiCadFetcher: Parsing symbol from library...');
            const symbol = this._parseSymbolFromLibrary(libContent, symbolName);
            
            if (symbol) {
                console.log('KiCadFetcher: Symbol parsed successfully');
                if (symbol.symbol?._extends) {
                    await this._resolveExtends(symbol, library);
                }
                symbol._kicadRaw = libContent;
                // Fallback: extract Footprint property from raw content if missing
                if (!symbol.properties || Object.keys(symbol.properties).length === 0) {
                    symbol.properties = symbol.properties || {};
                    const lookupName = symbol.kicadName || symbolName;
                    const footprint = this._extractFootprintFromContent(libContent, lookupName);
                    if (footprint) {
                        symbol.properties.Footprint = footprint;
                    }
                }

                this.symbolCache.set(cacheKey, symbol);
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
     * Check whether a KiCad footprint file and its 3D STEP model exist on GitLab.
     * @param {string} footprintName - e.g. 'Resistor_SMD:R_0603_1608Metric'
     * @returns {Promise<{hasFootprint: boolean, has3d: boolean, footprintUrl?: string, modelUrl?: string}>}
     */
    async checkFootprintAvailability(footprintName) {
        if (!footprintName || typeof footprintName !== 'string') {
            return { hasFootprint: false, has3d: false };
        }

        const [lib, name] = footprintName.split(':');
        if (!lib || !name) {
            return { hasFootprint: false, has3d: false };
        }

        const footprintCandidates = this._buildRawUrlCandidates(
            this.footprintsBase,
            `${lib}.pretty/${name}.kicad_mod`
        );
        const modelCandidates = [];
        for (const base of this._getRawBaseCandidates(this.models3dBase)) {
            modelCandidates.push(`${base}/${lib}.3dshapes/${name}.step`);
            modelCandidates.push(`${base}/${lib}.3dshapes/${name}.stp`);
        }

        const footprintResolved = await this._resolveFirstExistingUrl(footprintCandidates, this.footprintExistsCache, 'fp');
        const modelResolved = await this._resolveFirstExistingUrl(modelCandidates, this.model3dExistsCache, '3d');

        return {
            hasFootprint: !!footprintResolved,
            has3d: !!modelResolved,
            footprintUrl: footprintResolved || footprintCandidates[0],
            modelUrl: modelResolved || modelCandidates[0]
        };
    }

    /**
     * Fetch and parse a `.kicad_mod` footprint file into a pad-shape preview.
     * @param {string} footprintName - e.g. 'Resistor_SMD:R_0603_1608Metric'
     * @returns {Promise<{shapes: Array, bbox: Object}|null>}
     */
    async fetchFootprintPreview(footprintName) {
        if (!footprintName || typeof footprintName !== 'string') {
            return null;
        }

        const cacheKey = `fp_preview:${footprintName}`;
        if (this.footprintPreviewCache.has(cacheKey)) {
            return this.footprintPreviewCache.get(cacheKey);
        }

        const [lib, name] = footprintName.split(':');
        if (!lib || !name) {
            return null;
        }

        const content = await this._fetchFootprintFile(lib, name);
        if (!content) {
            return null;
        }

        const preview = this._parseFootprintPreview(content);
        if (preview) {
            this.footprintPreviewCache.set(cacheKey, preview);
        }

        return preview;
    }
    
    /**
     * Fetch a library file from GitLab (with caching)
     */
    async _fetchLibraryFile(library) {
        // Check storage cache first (with 7-day TTL)
        const cacheKey = `kicad_lib_${library}`;
        const cached = storageManager.get(cacheKey);
        if (cached && typeof cached === 'string') {
            console.log(`Using cached KiCad library: ${library}`);
            return cached;
        }

        const targetUrls = this._buildSymbolLibraryUrlCandidates(library);
        const content = await this._fetchFirstValidContentFromUrls(targetUrls, {
            validator: value => this._isValidKiCadSymbolContent(value),
            logPrefix: `Fetching KiCad library: ${library}`
        });
        if (content) {
            console.log(`KiCad library ${library} fetched, size: ${content.length} bytes`);
            this._cacheLibraryContent(cacheKey, library, content);
            return content;
        }
        
        // If initial attempts failed, refresh the index once and retry with discovered paths
        await this._loadLibraryPathIndex(true);
        const refreshedPath = this.libraryPathIndex?.[library];
        if (refreshedPath && !refreshedPath.endsWith('.kicad_symdir')) {
            const retryUrls = this._buildRawUrlCandidates(this.symbolsBase, refreshedPath);
            const retryContent = await this._fetchFirstValidContentFromUrls(retryUrls, {
                validator: value => this._isValidKiCadSymbolContent(value),
                logPrefix: `Fetching KiCad library (retry): ${library}`
            });
            if (retryContent) {
                this._cacheLibraryContent(cacheKey, library, retryContent);
                return retryContent;
            }
        }

        throw new Error(`Failed to fetch KiCad library ${library} - all proxies failed`);
    }

    /**
     * Cache fetched KiCad library content and emit a debug log.
     * @param {string} cacheKey
     * @param {string} library
     * @param {string} content
     */
    _cacheLibraryContent(cacheKey, library, content) {
        this._setContentCache(cacheKey, content);
        console.log(`Cached KiCad library: ${library}`);
    }

    /**
     * Cache content data with the standard content TTL.
     * @param {string} key
     * @param {any} value
     * @returns {boolean}
     */
    _setContentCache(key, value) {
        return storageManager.set(key, value, CONTENT_CACHE_TTL_MS);
    }

    /**
     * Read response text and validate it using the provided validator.
     * @param {Response} response
     * @param {(content: unknown) => boolean} validator
     * @returns {Promise<string|null>}
     */
    async _readValidatedResponseText(response, validator) {
        const content = await response.text();
        return validator(content) ? content : null;
    }

    /**
     * Fetch the first valid text payload from URL candidates.
     * @param {string[]} targetUrls
     * @param {Object} options
     * @param {(content: unknown) => boolean} options.validator
     * @param {string} [options.errorContext='KiCad fetch error']
     * @param {string} [options.logPrefix]
     * @returns {Promise<string|null>}
     */
    async _fetchFirstValidContentFromUrls(targetUrls, { validator, errorContext = 'KiCad fetch error', logPrefix } = {}) {
        for (const targetUrl of targetUrls) {
            if (logPrefix) {
                console.log(logPrefix);
            }

            const response = await this._fetchFirstOkResponse(targetUrl, errorContext);
            if (!response) {
                continue;
            }

            const content = await this._readValidatedResponseText(response, validator);
            if (content) {
                return content;
            }
        }

        return null;
    }

    /**
     * List the contents of a .kicad_symdir directory via GitLab tree API.
     * Results are cached per library name.
     */
    async _listSymdirContents(library) {
        if (this._symdirCache.has(library)) {
            return this._symdirCache.get(library);
        }

        const symDirPath = `${library}.kicad_symdir`;
        const refs = KICAD_GIT_REFS;

        for (const ref of refs) {
            const data = await this._fetchGitLabTreePage({
                projectPath: KICAD_SYMBOLS_PROJECT_PATH,
                path: symDirPath,
                ref,
                perPage: 100,
                page: 1
            });
            if (!Array.isArray(data) || data.length === 0) continue;

            const files = data
                .filter(f => f.type === 'blob' && f.name.endsWith('.kicad_sym'))
                .map(f => f.name.replace(/\.kicad_sym$/, ''));

            if (files.length > 0) {
                this._symdirCache.set(library, files);
                return files;
            }
        }

        this._symdirCache.set(library, []);
        return [];
    }

    /**
     * Find a symbol file in a symdir by exact or prefix match.
     * Returns the actual filename (without .kicad_sym) or null.
     */
    async _findMatchingSymbolInDir(library, symbolName) {
        const files = await this._listSymdirContents(library);
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
     * Fetch a single `.kicad_sym` file from a symdir on GitLab.
     * @param {string} symDirPath - Directory path within the symbols repo
     * @param {string} symbolName - Symbol name (used as filename stem)
     * @returns {Promise<string|null>} Raw file content or null
     */
    async _fetchSymbolFile(symDirPath, symbolName) {
        const fileName = `${symbolName}.kicad_sym`;
        const targetUrls = this._buildRawUrlCandidates(this.symbolsBase, `${symDirPath}/${fileName}`);
        return this._fetchFirstValidContentFromUrls(targetUrls, {
            validator: value => this._isValidKiCadSymbolContent(value),
            logPrefix: `Fetching KiCad symbol file: ${symDirPath}/${fileName}`
        });
    }

    /**
     * Validate that fetched content looks like a KiCad symbol library file.
     * @param {unknown} content
     * @returns {content is string}
     */
    _isValidKiCadSymbolContent(content) {
        if (typeof content !== 'string') {
            console.warn('KiCad content is not a string, skipping cache');
            return false;
        }

        if (!content.includes(SYMBOL_LIBRARY_MARKER)) {
            console.warn('Response does not look like a KiCad library file:', content.substring(0, CONTENT_PREVIEW_LENGTH));
            return false;
        }

        return true;
    }

    /**
     * Validate footprint file content format.
     * @param {unknown} content
     * @returns {content is string}
     */
    _isValidFootprintContent(content) {
        return typeof content === 'string' && content.includes(FOOTPRINT_MARKER);
    }

    /**
     * Parse JSON from a fetch response and optionally include headers.
     * @param {Response} response
     * @param {boolean} [returnHeaders=false]
     * @returns {Promise<Object|null>}
     */
    async _parseJsonFromResponse(response, returnHeaders = false) {
        try {
            const json = await response.json();
            if (returnHeaders) {
                return { json, headers: response.headers };
            }
            return json;
        } catch (error) {
            console.error('KiCad JSON parse error:', error);
            return null;
        }
    }

    /**
     * Fetch JSON from a URL through CORS proxies.
     * @param {string} targetUrl
     * @param {boolean} [returnHeaders=false] - If true, return `{ json, headers }`
     * @returns {Promise<Object|null>}
     */
    async _fetchJsonWithProxy(targetUrl, returnHeaders = false) {
        const response = await this._fetchFirstOkResponse(targetUrl);
        if (!response) {
            return null;
        }

        return this._parseJsonFromResponse(response, returnHeaders);
    }

    /**
     * Build a GitLab repository/tree API URL.
     * @param {Object} params
     * @param {string} params.projectPath
     * @param {string} params.ref
     * @param {number} [params.perPage=100]
     * @param {number} [params.page=1]
     * @param {boolean} [params.recursive=false]
     * @param {string} [params.path]
     * @returns {string}
     */
    _buildGitLabTreeApiUrl({ projectPath, ref, perPage = 100, page = 1, recursive = false, path }) {
        const params = new URLSearchParams({
            ref,
            per_page: String(perPage),
            page: String(page)
        });
        if (recursive) {
            params.set('recursive', 'true');
        }
        if (typeof path === 'string' && path.length > 0) {
            params.set('path', path);
        }

        return `https://gitlab.com/api/v4/projects/${projectPath}/repository/tree?${params.toString()}`;
    }

    /**
     * Fetch a GitLab repository/tree page through the configured proxy chain.
     * @param {Object} params
     * @param {string} params.projectPath
     * @param {string} params.ref
     * @param {number} [params.perPage=100]
     * @param {number} [params.page=1]
     * @param {boolean} [params.recursive=false]
     * @param {string} [params.path]
     * @param {boolean} [returnHeaders=false]
     * @returns {Promise<Object|null>}
     */
    _fetchGitLabTreePage(params, returnHeaders = false) {
        const apiUrl = this._buildGitLabTreeApiUrl(params);
        return this._fetchJsonWithProxy(apiUrl, returnHeaders);
    }

    /**
     * Wrap fetch() with an AbortController timeout.
     * @param {string} url
     * @param {number} [timeoutMs=15000]
     * @returns {Promise<Response>}
     */
    async _fetchWithTimeout(url, timeoutMs = 15000) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await fetch(url, { signal: controller.signal });
        } finally {
            clearTimeout(timeoutId);
        }
    }

    /**
     * Fetch a target URL through configured proxies and return the first successful response.
     * @param {string} targetUrl
     * @param {string} [errorContext='KiCad fetch error']
     * @returns {Promise<Response|null>}
     */
    async _fetchFirstOkResponse(targetUrl, errorContext = 'KiCad fetch error') {
        for (let attempt = 0; attempt < this.corsProxies.length; attempt++) {
            try {
                const proxy = this.corsProxies[attempt];
                const url = `${proxy}${encodeURIComponent(targetUrl)}`;
                const response = await this._fetchWithTimeout(url);
                if (response.ok) {
                    return response;
                }
                console.warn(`KiCad fetch failed with status ${response.status}`);
            } catch (error) {
                console.error(`${errorContext} with proxy ${this.corsProxies[attempt]}:`, error);
            }
        }

        return null;
    }

    /**
     * Load or refresh the library-name → file/directory path index from GitLab.
     * Uses a 7-day TTL cache in localStorage.
     * @param {boolean} [force=false] - Force refresh even if cached
     */
    async _loadLibraryPathIndex(force = false) {
        if (!force && this.libraryPathIndex) {
            return;
        }

        const cacheKey = KICAD_LIBRARY_INDEX_CACHE_KEY;
        if (!force) {
            const cached = storageManager.get(cacheKey);
            if (cached && typeof cached === 'object') {
                this.libraryPathIndex = cached;
                return;
            }
        }

        const perPage = 100;
        const refs = KICAD_GIT_REFS;

        for (const ref of refs) {
            const index = {};
            let page = 1;
            let hasMore = true;

            while (hasMore) {
                const data = await this._fetchGitLabTreePage({
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
                this.libraryPathIndex = index;
                this._setContentCache(cacheKey, index);
                return;
            }
        }
    }

    /**
     * Check whether a URL exists by attempting a fetch through CORS proxies.
     * @param {string} targetUrl
     * @returns {Promise<boolean>}
     */
    async _checkUrlExists(targetUrl) {
        const response = await this._fetchFirstOkResponse(targetUrl);
        return !!response;
    }

    /**
     * Fetch a `.kicad_mod` footprint file with 7-day localStorage caching.
     * @param {string} lib - Footprint library name
     * @param {string} name - Footprint name (without extension)
     * @returns {Promise<string|null>} Raw file content or null
     */
    async _fetchFootprintFile(lib, name) {
        const cacheKey = `kicad_fp_${lib}_${name}`;
        const cached = storageManager.get(cacheKey);
        if (cached && typeof cached === 'string') {
            return cached;
        }

        const targetUrls = this._buildRawUrlCandidates(this.footprintsBase, `${lib}.pretty/${name}.kicad_mod`);

        const content = await this._fetchFirstValidContentFromUrls(targetUrls, {
            validator: value => this._isValidFootprintContent(value),
            errorContext: 'KiCad footprint fetch error'
        });
        if (content) {
            this._setContentCache(cacheKey, content);
            return content;
        }

        return null;
    }

    /**
     * Returns candidate raw bases, preferring configured base then alternate main/master.
     * @param {string} base
     * @returns {string[]}
     */
    _getRawBaseCandidates(base) {
        const candidates = [base];
        if (base.includes('/-/raw/master')) {
            candidates.push(base.replace('/-/raw/master', '/-/raw/main'));
        } else if (base.includes('/-/raw/main')) {
            candidates.push(base.replace('/-/raw/main', '/-/raw/master'));
        }

        return [...new Set(candidates)];
    }

    /**
     * Builds raw URL candidates by combining raw base candidates and relative path.
     * @param {string} base
     * @param {string} relativePath
     * @returns {string[]}
     */
    _buildRawUrlCandidates(base, relativePath) {
        return this._getRawBaseCandidates(base).map(rawBase => `${rawBase}/${relativePath}`);
    }

    /**
     * Builds symbol-library URL candidates including optional /symbols subdir variants.
     * @param {string} library
     * @returns {string[]}
     */
    _buildSymbolLibraryUrlCandidates(library) {
        const expandedBases = [];
        for (const base of this._getRawBaseCandidates(this.symbolsBase)) {
            expandedBases.push(base);
            if (!base.endsWith('/symbols')) {
                expandedBases.push(`${base}/symbols`);
            }
        }

        return expandedBases.map(base => `${base}/${library}.kicad_sym`);
    }

    /**
     * Resolves first existing URL from candidates with existence-cache support.
     * @param {string[]} candidates
     * @param {Map<string, boolean>} cache
     * @param {string} prefix
     * @returns {Promise<string|null>}
     */
    async _resolveFirstExistingUrl(candidates, cache, prefix) {
        for (const candidate of candidates) {
            const key = `${prefix}:${candidate}`;
            const cached = cache.has(key) ? cache.get(key) : null;
            if (cached === true) {
                return candidate;
            }
            if (cached === false) {
                continue;
            }

            const exists = await this._checkUrlExists(candidate);
            cache.set(key, exists);
            if (exists) {
                return candidate;
            }
        }

        return null;
    }

    /**
     * Parse a `.kicad_mod` S-expression into a simplified pad-shapes array
     * with a bounding box, suitable for rendering a footprint preview.
     * @param {string} content - Raw `.kicad_mod` file content
     * @returns {{shapes: Array, bbox: Object}|null}
     */
    _parseFootprintPreview(content) {
        if (!content) return null;

        const sexp = this._parseSExp(content);
        if (!Array.isArray(sexp) || sexp[0] !== FOOTPRINT_MARKER) {
            return null;
        }

        const shapes = [];
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;

        const includeRect = (x, y, w, h) => {
            const rx = x - w / 2;
            const ry = y - h / 2;
            const x2 = rx + w;
            const y2 = ry + h;
            minX = Math.min(minX, rx);
            minY = Math.min(minY, ry);
            maxX = Math.max(maxX, x2);
            maxY = Math.max(maxY, y2);
        };

        for (const item of sexp) {
            if (!Array.isArray(item) || item[0] !== 'pad') continue;

            const shape = typeof item[3] === 'string' ? item[3] : '';
            let atX = 0;
            let atY = 0;
            let rotation = 0;
            let sizeX = 0;
            let sizeY = 0;

            for (const padItem of item) {
                if (!Array.isArray(padItem)) continue;
                if (padItem[0] === 'at') {
                    atX = parseFloat(padItem[1]) || 0;
                    atY = -(parseFloat(padItem[2]) || 0);
                    rotation = padItem.length > 3 ? parseFloat(padItem[3]) || 0 : 0;
                } else if (padItem[0] === 'size') {
                    sizeX = parseFloat(padItem[1]) || 0;
                    sizeY = parseFloat(padItem[2]) || 0;
                }
            }

            if (!sizeX || !sizeY) continue;

            let w = sizeX;
            let h = sizeY;
            if (Math.abs(rotation) % 180 === 90) {
                w = sizeY;
                h = sizeX;
            }

            const isEllipse = shape === 'circle' || shape === 'oval';
            const padType = isEllipse ? 'ELLIPSE' : 'RECT';
            shapes.push(`PAD~${padType}~${atX}~${atY}~${w}~${h}`);
            includeRect(atX, atY, w, h);
        }

        if (shapes.length === 0 || !Number.isFinite(minX)) {
            return null;
        }

        return {
            shapes,
            bbox: {
                x: minX,
                y: minY,
                width: maxX - minX,
                height: maxY - minY
            }
        };
    }

    /**
     * Extract the `Footprint` property value for a given symbol name
     * from raw KiCad library file content.
     * @param {string} content - Raw `.kicad_sym` content
     * @param {string} symbolName
     * @returns {string} Footprint reference or empty string
     */
    _extractFootprintFromContent(content, symbolName) {
        if (!content || !symbolName) return '';

        const cleanName = symbolName.replace(/^"|"$/g, '');
        const symbolToken = `(symbol "${cleanName}"`;
        const idx = content.indexOf(symbolToken);
        if (idx === -1) return '';

        const window = content.slice(idx, idx + 8000);
        const match = window.match(/\(property\s+"Footprint"\s+"([^"]*)"/);
        return match ? match[1] : '';
    }

    
    /**
     * Ensure the symbol index is loaded. Returns immediately if already cached.
     * Otherwise fetches from GitLab (blocking). Callers can pass an onProgress
     * callback to show progress: onProgress({ loaded, total, message }).
     * Multiple concurrent callers share the same in-flight promise.
     */
    async ensureIndexLoaded(onProgress) {
        if (this.libraryIndex) return;

        // Always keep the latest progress callback so re-triggered searches
        // (e.g. debounced keystrokes) still show the progress bar.
        if (onProgress) {
            this._onProgress = onProgress;
        }

        // Wait for StorageManager to finish loading from IndexedDB
        // before checking the cache, otherwise we'd miss cached data.
        await storageManager.ready;

        // Re-check — hydration may have populated the index via another path
        if (this.libraryIndex) return;

        // Stale-while-revalidate: serve expired cache immediately,
        // then refresh in the background so the user can search right away.
        const cacheKey = KICAD_FULL_SYMBOL_INDEX_CACHE_KEY;
        const cached = storageManager.getRaw(cacheKey);

        if (cached && cached.data && typeof cached.data === 'object'
            && Object.keys(cached.data).length > 0) {
            this.libraryIndex = { symbols: cached.data };
            for (const [lib, symbols] of Object.entries(cached.data)) {
                if (!this._symdirCache.has(lib)) {
                    this._symdirCache.set(lib, symbols);
                }
            }

            if (cached.expired) {
                // Serve stale data now — refresh silently in the background
                console.log('KiCadFetcher: Serving stale index, refreshing in background...');
                this._refreshIndexInBackground();
            }
            return;
        }

        // No cached data at all (first visit) — fetch with progress bar
        if (!this._indexLoadPromise) {
            this._indexLoadPromise = this._fetchFullSymbolIndex()
                .finally(() => {
                    this._indexLoadPromise = null;
                    this._onProgress = null;
                });
        }
        return this._indexLoadPromise;
    }

    /**
     * Silently refresh the symbol index in the background.
     * Updates in-memory + localStorage caches when done.
     */
    _refreshIndexInBackground() {
        this._fetchFullSymbolIndex().then(() => {
            console.log('KiCadFetcher: Background index refresh complete');
        }).catch(err => {
            console.warn('KiCadFetcher: Background index refresh failed:', err);
        });
    }

    /**
     * Fetch the complete symbol index from GitLab using the recursive tree API.
     * Parses paths like "Timer.kicad_symdir/NE555D.kicad_sym" to build
     * { Timer: ['NE555D', ...], ... }.  Caches the result for 7 days.
     */
    async _fetchFullSymbolIndex() {
        const refs = KICAD_GIT_REFS;

        for (const ref of refs) {
            const index = {};
            let page = 1;
            let hasMore = true;
            let totalEntries = 0;
            let totalExpected = 0;

            if (this._onProgress) {
                this._onProgress({ loaded: 0, total: 0, message: 'Connecting to KiCad library...' });
            }

            while (hasMore) {
                // On the first page, read the x-total header for progress
                let data;
                if (page === 1) {
                    const result = await this._fetchGitLabTreePage({
                        projectPath: KICAD_SYMBOLS_PROJECT_PATH,
                        recursive: true,
                        ref,
                        perPage: 100,
                        page
                    }, true);
                    if (!result) { hasMore = false; break; }
                    data = result.json;
                    const xt = result.headers?.get('x-total');
                    if (xt) totalExpected = parseInt(xt, 10) || 0;
                } else {
                    data = await this._fetchGitLabTreePage({
                        projectPath: KICAD_SYMBOLS_PROJECT_PATH,
                        recursive: true,
                        ref,
                        perPage: 100,
                        page
                    });
                }

                if (!Array.isArray(data) || data.length === 0) {
                    hasMore = false;
                    break;
                }

                for (const entry of data) {
                    if (entry.type !== 'blob') continue;
                    const p = entry.path;
                    if (!p || !p.endsWith('.kicad_sym')) continue;

                    const parts = p.split('/');
                    if (parts.length !== 2) continue;

                    const dir = parts[0];
                    if (!dir.endsWith('.kicad_symdir')) continue;

                    const libName = dir.replace(/\.kicad_symdir$/, '');
                    const symName = parts[1].replace(/\.kicad_sym$/, '');
                    if (!index[libName]) index[libName] = [];
                    index[libName].push(symName);
                }

                totalEntries += data.length;
                if (this._onProgress) {
                    const libCount = Object.keys(index).length;
                    const symCount = Object.values(index).reduce((n, a) => n + a.length, 0);
                    const pct = totalExpected > 0
                        ? ` (${Math.round(totalEntries / totalExpected * 100)}%)`
                        : '';
                    this._onProgress({
                        loaded: totalEntries,
                        total: totalExpected,
                        message: `Indexing KiCad library${pct}... ${libCount} libraries, ${symCount} symbols`
                    });
                }

                hasMore = data.length >= 100;
                page++;
            }

            if (Object.keys(index).length > 0) {
                this.libraryIndex = { symbols: index };
                const saved = this._setContentCache(KICAD_FULL_SYMBOL_INDEX_CACHE_KEY, index);
                if (!saved) {
                    console.warn('KiCadFetcher: Failed to cache index in localStorage (quota exceeded?). ' +
                        'The index will need to be re-downloaded on next visit.');
                }

                // Populate the per-library symdir cache
                for (const [lib, symbols] of Object.entries(index)) {
                    this._symdirCache.set(lib, symbols);
                }

                console.log(`KiCadFetcher: Full index loaded — ${Object.keys(index).length} libraries, ` +
                    `${Object.values(index).reduce((n, a) => n + a.length, 0)} symbols`);
                return;
            }
        }
    }
    
    /**
     * Parse KiCad S-expression format and extract a symbol
     * @param {string} content - Library file content
     * @param {string} symbolName - Name of symbol to extract
     * @returns {object} ClearPCB symbol definition
     */
    _parseSymbolFromLibrary(content, symbolName) {
        console.log(`Parsing library for symbol: ${symbolName}`);
        console.log(`Content starts with: ${content.substring(0, 100)}`);
        
        // Parse S-expression
        const sexp = this._parseSExp(content);
        
        if (!sexp) {
            console.error('S-expression parsing returned null');
            return null;
        }
        
        console.log(`Parsed S-exp type: ${sexp[0]}`);
        
        if (sexp[0] !== SYMBOL_LIBRARY_MARKER) {
            console.error('Invalid KiCad symbol library format, got:', sexp[0]);
            return null;
        }
        
        // Collect all symbol names for debugging
        const symbolNames = [];
        for (const item of sexp) {
            if (Array.isArray(item) && item[0] === 'symbol') {
                const name = item[1];
                const cleanName = name ? name.replace(/^"|"$/g, '') : '';
                // Only collect top-level symbols (not sub-units like "NE555_1_1")
                if (cleanName && !cleanName.includes('_1_') && !cleanName.includes('_0_')) {
                    symbolNames.push(cleanName);
                }
            }
        }
        console.log('Available symbols in library:', symbolNames.slice(0, 20));
        
        // Find the symbol - try multiple matching strategies
        const searchName = symbolName.toUpperCase();
        
        for (const item of sexp) {
            if (Array.isArray(item) && item[0] === 'symbol') {
                const name = item[1];
                if (!name) continue;
                
                const cleanName = name.replace(/^"|"$/g, '');
                const upperName = cleanName.toUpperCase();
                
                // Skip sub-units (like "NE555_1_1")
                if (cleanName.includes('_1_') || cleanName.includes('_0_')) {
                    continue;
                }
                
                // Exact match
                if (upperName === searchName) {
                    console.log('Found exact match:', cleanName);
                    const symbol = this._convertKiCadSymbol(item);
                    symbol.kicadName = cleanName;
                    return symbol;
                }
                
                // Match without library prefix (e.g., "Timer:NE555" matches "NE555")
                if (upperName.endsWith(':' + searchName)) {
                    console.log('Found prefixed match:', cleanName);
                    const symbol = this._convertKiCadSymbol(item);
                    symbol.kicadName = cleanName;
                    return symbol;
                }
                
                // Partial match (e.g., "NE555" matches "NE555P")
                if (upperName.startsWith(searchName) || upperName.includes(searchName)) {
                    console.log('Found partial match:', cleanName);
                    const symbol = this._convertKiCadSymbol(item);
                    symbol.kicadName = cleanName;
                    return symbol;
                }
            }
        }
        
        console.warn(`Symbol ${symbolName} not found in library. Available: ${symbolNames.join(', ')}`);
        return null;
    }
    
    /**
     * Parse S-expression string into nested arrays
     * @param {string} str - S-expression string
     * @returns {Array} Parsed structure
     */
    _parseSExp(str) {
        const tokens = this._tokenize(str);
        let pos = 0;
        
        const parse = () => {
            if (pos >= tokens.length) return null;
            
            const token = tokens[pos++];
            
            if (token === '(') {
                const list = [];
                while (pos < tokens.length && tokens[pos] !== ')') {
                    const item = parse();
                    if (item !== null) list.push(item);
                }
                pos++; // Skip ')'
                return list;
            } else if (token === ')') {
                return null;
            } else {
                // Return as string or number
                const num = parseFloat(token);
                return isNaN(num) ? token.replace(/^"|"$/g, '') : num;
            }
        };
        
        return parse();
    }

    /**
     * If a parsed symbol has no pins or graphics, try to rebuild it
     * from its unit sub-symbols (e.g. `NE555_1_1`).
     * @param {Array} sexp - Parsed S-expression of the library
     * @param {Object} symbol - Already-converted symbol object
     * @param {string} baseName - Symbol base name (without unit suffix)
     * @returns {Object} Original or rebuilt symbol
     */
    _rebuildSymbolFromUnitsIfNeeded(sexp, symbol, baseName) {
        if ((symbol?.pins?.length || 0) > 0 || (symbol?.graphics?.length || 0) > 0) {
            return symbol;
        }

        const rebuilt = this._buildSymbolFromUnits(sexp, baseName);
        if (rebuilt) {
            rebuilt.properties = symbol.properties || {};
            rebuilt.kicadName = symbol.kicadName || baseName;
            return rebuilt;
        }

        return symbol;
    }

    /**
     * Build a complete symbol by locating and merging all unit sub-symbols
     * (e.g. `SymbolName_1_1`, `_1_2`, ...) from a library S-expression.
     * @param {Array} sexp - Parsed library S-expression
     * @param {string} baseName - Symbol base name
     * @returns {Object|null} Merged symbol or null
     */
    _buildSymbolFromUnits(sexp, baseName) {
        if (!Array.isArray(sexp) || !baseName) return null;
        const cleanBase = baseName.replace(/^"|"$/g, '');
        const prefix = `${cleanBase}_`;

        const unitSymbols = sexp.filter(item => {
            if (!Array.isArray(item) || item[0] !== 'symbol' || typeof item[1] !== 'string') return false;
            const name = item[1].replace(/^"|"$/g, '');
            return name.startsWith(prefix);
        });

        if (unitSymbols.length === 0) {
            console.log('KiCad unit symbols not found for', cleanBase);
            const nearby = sexp
                .filter(item => Array.isArray(item) && item[0] === 'symbol' && typeof item[1] === 'string')
                .map(item => item[1].replace(/^"|"$/g, ''))
                .filter(name => name.includes(cleanBase))
                .slice(0, 20);
            console.log('KiCad symbols containing base name:', cleanBase, nearby);
            return null;
        }

        console.log('KiCad unit symbols found for', cleanBase, unitSymbols.map(u => (typeof u[1] === 'string' ? u[1].replace(/^"|"$/g, '') : u[1])));

        const symbol = {
            width: 20,
            height: 20,
            origin: { x: 10, y: 10 },
            graphics: [],
            pins: [],
            properties: {},
            _source: 'KiCad'
        };

        let minX = Infinity, minY = Infinity;
        let maxX = -Infinity, maxY = -Infinity;

        for (const unit of unitSymbols) {
            const unitResult = this._processSymbolUnit(unit);
            symbol.graphics.push(...unitResult.graphics);
            symbol.pins.push(...unitResult.pins);

            if (unitResult.minX < minX) minX = unitResult.minX;
            if (unitResult.minY < minY) minY = unitResult.minY;
            if (unitResult.maxX > maxX) maxX = unitResult.maxX;
            if (unitResult.maxY > maxY) maxY = unitResult.maxY;
        }

        if (minX !== Infinity) {
            const offsetX = minX;
            const offsetY = minY;

            for (const g of symbol.graphics) {
                this._offsetGraphic(g, -offsetX, -offsetY);
            }

            for (const p of symbol.pins) {
                p.x -= offsetX;
                p.y -= offsetY;
            }

            symbol.width = maxX - minX;
            symbol.height = maxY - minY;
            symbol.origin = {
                x: symbol.width / 2,
                y: symbol.height / 2
            };

            const centerX = symbol.width / 2;
            const topEdge = 0;
            symbol.graphics.push({
                type: 'text',
                x: centerX,
                y: topEdge - 2.1,
                text: '${REF}',
                fontSize: 1.2,
                anchor: 'middle',
                baseline: 'middle'
            });
            symbol.graphics.push({
                type: 'text',
                x: centerX,
                y: topEdge - 0.7,
                text: '${VALUE}',
                fontSize: 1.0,
                anchor: 'middle',
                baseline: 'middle'
            });
        }

        return symbol;
    }
    
    /**
     * Tokenize S-expression string
     */
    _tokenize(str) {
        const tokens = [];
        let i = 0;
        
        while (i < str.length) {
            const char = str[i];
            
            // Skip whitespace
            if (/\s/.test(char)) {
                i++;
                continue;
            }
            
            // Parentheses
            if (char === '(' || char === ')') {
                tokens.push(char);
                i++;
                continue;
            }
            
            // Quoted string
            if (char === '"') {
                let token = '"';
                i++;
                while (i < str.length && str[i] !== '"') {
                    if (str[i] === '\\' && i + 1 < str.length) {
                        token += str[i] + str[i + 1];
                        i += 2;
                    } else {
                        token += str[i];
                        i++;
                    }
                }
                token += '"';
                i++; // Skip closing quote
                tokens.push(token);
                continue;
            }
            
            // Other token (symbol, number)
            let token = '';
            while (i < str.length && !/[\s()]/.test(str[i])) {
                token += str[i];
                i++;
            }
            if (token) tokens.push(token);
        }
        
        return tokens;
    }
    
    /**
     * Convert KiCad symbol to ClearPCB format
     * @param {Array} symbolSexp - Parsed symbol S-expression
     * @returns {object} ClearPCB symbol definition
     */
    _convertKiCadSymbol(symbolSexp) {
        const name = symbolSexp[1].replace(/^"|"$/g, '');
        
        const symbol = {
            width: 20,
            height: 20,
            origin: { x: 10, y: 10 },
            graphics: [],
            pins: [],
            properties: {},
            _source: 'KiCad'
        };
        
        let minX = Infinity, minY = Infinity;
        let maxX = -Infinity, maxY = -Infinity;
        
        // Process symbol elements
        for (let i = 2; i < symbolSexp.length; i++) {
            const item = symbolSexp[i];
            if (!Array.isArray(item)) continue;
            
            const type = item[0];
            
            switch (type) {
                case 'symbol':
                    // Nested symbol (unit) - process its contents
                    const unitResult = this._processSymbolUnit(item);
                    symbol.graphics.push(...unitResult.graphics);
                    symbol.pins.push(...unitResult.pins);
                    // Update bounds
                    if (unitResult.minX < minX) minX = unitResult.minX;
                    if (unitResult.minY < minY) minY = unitResult.minY;
                    if (unitResult.maxX > maxX) maxX = unitResult.maxX;
                    if (unitResult.maxY > maxY) maxY = unitResult.maxY;
                    break;
                    
                case 'property':
                    const prop = this._parseKiCadProperty(item);
                    if (prop && prop.name) {
                        const existing = symbol.properties[prop.name];
                        const next = prop.value;
                        if (!existing && next) {
                            symbol.properties[prop.name] = next;
                        } else if (existing && !next) {
                            // keep existing non-empty value
                        } else if (!existing) {
                            symbol.properties[prop.name] = next;
                        }
                    }
                    break;
                    
                case 'pin':
                    const pin = this._parseKiCadPin(item);
                    if (pin) {
                        symbol.pins.push(pin);
                        minX = Math.min(minX, pin.x);
                        maxX = Math.max(maxX, pin.x);
                        minY = Math.min(minY, pin.y);
                        maxY = Math.max(maxY, pin.y);
                    }
                    break;
                    
                case 'rectangle':
                    const rect = this._parseKiCadRectangle(item);
                    if (rect) {
                        symbol.graphics.push(rect);
                        minX = Math.min(minX, rect.x);
                        maxX = Math.max(maxX, rect.x + rect.width);
                        minY = Math.min(minY, rect.y);
                        maxY = Math.max(maxY, rect.y + rect.height);
                    }
                    break;
                    
                case 'polyline':
                    const polyline = this._parseKiCadPolyline(item);
                    if (polyline) {
                        symbol.graphics.push(polyline);
                        for (const p of polyline.points) {
                            minX = Math.min(minX, p[0]);
                            maxX = Math.max(maxX, p[0]);
                            minY = Math.min(minY, p[1]);
                            maxY = Math.max(maxY, p[1]);
                        }
                    }
                    break;
                    
                case 'circle':
                    const circle = this._parseKiCadCircle(item);
                    if (circle) {
                        symbol.graphics.push(circle);
                        minX = Math.min(minX, circle.cx - circle.r);
                        maxX = Math.max(maxX, circle.cx + circle.r);
                        minY = Math.min(minY, circle.cy - circle.r);
                        maxY = Math.max(maxY, circle.cy + circle.r);
                    }
                    break;
                    
                case 'arc':
                    const arc = this._parseKiCadArc(item);
                    if (arc) {
                        symbol.graphics.push(arc);
                        // Approximate bounds for arc
                        minX = Math.min(minX, arc.cx - arc.r);
                        maxX = Math.max(maxX, arc.cx + arc.r);
                        minY = Math.min(minY, arc.cy - arc.r);
                        maxY = Math.max(maxY, arc.cy + arc.r);
                    }
                    break;
                    
                case 'text':
                    // Skip text for now
                    break;
                    
                case 'extends':
                    // Symbol inherits graphics/pins from a base symbol
                    // (e.g., NE555P extends NE555)
                    symbol._extends = (item[1] || '').replace(/^"|"$/g, '');
                    break;
            }
        }
        
        // If no graphics/pins were found (and not an extends symbol),
        // attempt to rebuild from nested units
        if (symbol.pins.length === 0 && symbol.graphics.length === 0 && !symbol._extends) {
            const nestedCount = symbolSexp.filter(item => Array.isArray(item) && item[0] === 'symbol').length;
            console.log('KiCad nested unit count for symbol', name, nestedCount);
            const rebuilt = this._buildSymbolFromNestedUnits(symbolSexp);
            if (rebuilt) {
                return rebuilt;
            }
        }

        // Deduplicate pins that share the same position and number
        if (symbol.pins.length > 1) {
            const seen = new Set();
            symbol.pins = symbol.pins.filter(pin => {
                const key = pin._coordKey || `${pin.x},${pin.y}`;
                if (seen.has(key)) {
                    return false;
                }
                seen.add(key);
                return true;
            });
        }

        // Calculate dimensions
        if (minX !== Infinity) {
            // Normalize coordinates
            const offsetX = minX;
            const offsetY = minY;
            
            for (const g of symbol.graphics) {
                this._offsetGraphic(g, -offsetX, -offsetY);
            }
            
            for (const p of symbol.pins) {
                p.x -= offsetX;
                p.y -= offsetY;
            }
            
            symbol.width = maxX - minX;
            symbol.height = maxY - minY;
            symbol.origin = {
                x: symbol.width / 2,
                y: symbol.height / 2
            };
            
            // Add reference and value text above the symbol (centered)
            const centerX = symbol.width / 2;
            const topEdge = 0;
            symbol.graphics.push({
                type: 'text',
                x: centerX,
                y: topEdge - 2.1,
                text: '${REF}',
                fontSize: 1.2,
                anchor: 'middle',
                baseline: 'middle'
            });
            symbol.graphics.push({
                type: 'text',
                x: centerX,
                y: topEdge - 0.7,
                text: '${VALUE}',
                fontSize: 1.0,
                anchor: 'middle',
                baseline: 'middle'
            });
        }
        
        return {
            name: name.split(':').pop(),
            description: '',
            category: 'KiCad',
            symbol: symbol,
            _source: 'KiCad'
        };
    }

    /**
     * Build a symbol from nested `(symbol ...)` unit elements within a
     * top-level symbol S-expression. Deduplicates pins and normalises
     * coordinates to a shared origin.
     * @param {Array} symbolSexp - Top-level symbol S-expression
     * @returns {Object|null} Symbol with graphics, pins, and computed bounds
     */
    _buildSymbolFromNestedUnits(symbolSexp) {
        if (!Array.isArray(symbolSexp)) return null;

        const symbol = {
            width: 20,
            height: 20,
            origin: { x: 10, y: 10 },
            graphics: [],
            pins: [],
            properties: {},
            _source: 'KiCad'
        };

        let minX = Infinity, minY = Infinity;
        let maxX = -Infinity, maxY = -Infinity;

        for (let i = 2; i < symbolSexp.length; i++) {
            const item = symbolSexp[i];
            if (!Array.isArray(item) || item[0] !== 'symbol') continue;

            const unitResult = this._processSymbolUnit(item);
            symbol.graphics.push(...unitResult.graphics);
            symbol.pins.push(...unitResult.pins);

            if (unitResult.minX < minX) minX = unitResult.minX;
            if (unitResult.minY < minY) minY = unitResult.minY;
            if (unitResult.maxX > maxX) maxX = unitResult.maxX;
            if (unitResult.maxY > maxY) maxY = unitResult.maxY;
        }

        if (symbol.pins.length === 0 && symbol.graphics.length === 0) {
            return null;
        }

        if (symbol.pins.length > 1) {
            const seen = new Set();
            symbol.pins = symbol.pins.filter(pin => {
                const key = pin._coordKey || `${pin.x},${pin.y}`;
                if (seen.has(key)) {
                    return false;
                }
                seen.add(key);
                return true;
            });
        }

        if (minX !== Infinity) {
            const offsetX = minX;
            const offsetY = minY;

            for (const g of symbol.graphics) {
                this._offsetGraphic(g, -offsetX, -offsetY);
            }

            for (const p of symbol.pins) {
                p.x -= offsetX;
                p.y -= offsetY;
            }

            symbol.width = maxX - minX;
            symbol.height = maxY - minY;
            symbol.origin = {
                x: symbol.width / 2,
                y: symbol.height / 2
            };

            const centerX = symbol.width / 2;
            const topEdge = 0;
            symbol.graphics.push({
                type: 'text',
                x: centerX,
                y: topEdge - 2.1,
                text: '${REF}',
                fontSize: 1.2,
                anchor: 'middle',
                baseline: 'middle'
            });
            symbol.graphics.push({
                type: 'text',
                x: centerX,
                y: topEdge - 0.7,
                text: '${VALUE}',
                fontSize: 1.0,
                anchor: 'middle',
                baseline: 'middle'
            });
        }

        return {
            name: symbolSexp[1]?.replace(/^"|"$/g, '').split(':').pop(),
            description: '',
            category: 'KiCad',
            symbol: symbol,
            _source: 'KiCad'
        };
    }
    
    /**
     * Process a symbol unit (nested symbol element)
     */
    /**
     * Resolve an `extends` reference by fetching the base symbol and
     * copying its graphics/pins into the extending symbol.
     * @param {object} result - Parsed symbol result from _convertKiCadSymbol
     * @param {string} library - Library name (e.g., "Timer")
     * @param {number} depth - Recursion depth guard
     * @returns {Promise<object>} result with graphics/pins populated from base
     */
    async _resolveExtends(result, library, depth = 0) {
        const extendsName = result?.symbol?._extends;
        if (!extendsName || depth > 3) return result;

        // Strip library prefix if present (e.g., "Timer:NE555" → "NE555")
        const baseName = extendsName.includes(':') ? extendsName.split(':').pop() : extendsName;
        console.log(`KiCadFetcher: Resolving extends ${result.name} → ${baseName}`);

        // Try to fetch the base symbol from the same library's symdir
        const directSymDir = `${library}.kicad_symdir`;
        const baseContent = await this._fetchSymbolFile(directSymDir, baseName);
        if (!baseContent) return result;

        const baseResult = this._parseSymbolFromLibrary(baseContent, baseName);
        if (!baseResult?.symbol) return result;

        // Recursively resolve if the base also extends another symbol
        if (baseResult.symbol._extends) {
            await this._resolveExtends(baseResult, library, depth + 1);
        }

        // Copy visual data from base, keep extending symbol's own properties
        result.symbol.graphics = baseResult.symbol.graphics;
        result.symbol.pins = baseResult.symbol.pins;
        result.symbol.width = baseResult.symbol.width;
        result.symbol.height = baseResult.symbol.height;
        result.symbol.origin = baseResult.symbol.origin;
        delete result.symbol._extends;

        return result;
    }

    /**
     * Process a single symbol unit sub-element, extracting its pins,
     * rectangles, polylines, circles and arcs, and tracking min/max bounds.
     * @param {Array} unitSexp - Unit S-expression
     * @returns {{graphics: Array, pins: Array, minX: number, minY: number, maxX: number, maxY: number}}
     */
    _processSymbolUnit(unitSexp) {
        const result = {
            graphics: [],
            pins: [],
            minX: Infinity,
            minY: Infinity,
            maxX: -Infinity,
            maxY: -Infinity
        };
        
        for (let i = 2; i < unitSexp.length; i++) {
            const item = unitSexp[i];
            if (!Array.isArray(item)) continue;
            
            const type = item[0];
            
            switch (type) {
                case 'pin':
                    const pin = this._parseKiCadPin(item);
                    if (pin) {
                        result.pins.push(pin);
                        result.minX = Math.min(result.minX, pin.x);
                        result.maxX = Math.max(result.maxX, pin.x);
                        result.minY = Math.min(result.minY, pin.y);
                        result.maxY = Math.max(result.maxY, pin.y);
                    }
                    break;
                    
                case 'rectangle':
                    const rect = this._parseKiCadRectangle(item);
                    if (rect) {
                        result.graphics.push(rect);
                        result.minX = Math.min(result.minX, rect.x);
                        result.maxX = Math.max(result.maxX, rect.x + rect.width);
                        result.minY = Math.min(result.minY, rect.y);
                        result.maxY = Math.max(result.maxY, rect.y + rect.height);
                    }
                    break;
                    
                case 'polyline':
                    const polyline = this._parseKiCadPolyline(item);
                    if (polyline) {
                        result.graphics.push(polyline);
                        for (const p of polyline.points) {
                            result.minX = Math.min(result.minX, p[0]);
                            result.maxX = Math.max(result.maxX, p[0]);
                            result.minY = Math.min(result.minY, p[1]);
                            result.maxY = Math.max(result.maxY, p[1]);
                        }
                    }
                    break;
                    
                case 'circle':
                    const circle = this._parseKiCadCircle(item);
                    if (circle) {
                        result.graphics.push(circle);
                        result.minX = Math.min(result.minX, circle.cx - circle.r);
                        result.maxX = Math.max(result.maxX, circle.cx + circle.r);
                        result.minY = Math.min(result.minY, circle.cy - circle.r);
                        result.maxY = Math.max(result.maxY, circle.cy + circle.r);
                    }
                    break;
                    
                case 'arc':
                    const arc = this._parseKiCadArc(item);
                    if (arc) {
                        result.graphics.push(arc);
                        result.minX = Math.min(result.minX, arc.cx - arc.r);
                        result.maxX = Math.max(result.maxX, arc.cx + arc.r);
                        result.minY = Math.min(result.minY, arc.cy - arc.r);
                        result.maxY = Math.max(result.maxY, arc.cy + arc.r);
                    }
                    break;
            }
        }
        
        return result;
    }
    
    /**
     * Parse KiCad pin
     * (pin type shape (at x y angle) (length len) (name "name" ...) (number "num" ...))
     */
    _parseKiCadPin(pinSexp) {
        const pin = {
            type: 'pin',
            number: '',
            name: '',
            x: 0,
            y: 0,
            orientation: 'right',
            length: 2.54,
            pinType: 'passive',
            shape: 'line',
            kicadNameFontSize: null,
            kicadNumberFontSize: null
        };

        const extractFontSize = (node) => {
            if (!Array.isArray(node)) return null;
            for (const child of node) {
                if (!Array.isArray(child)) continue;
                if (child[0] === 'effects') {
                    for (const eff of child) {
                        if (!Array.isArray(eff)) continue;
                        if (eff[0] === 'font') {
                            for (const fontItem of eff) {
                                if (!Array.isArray(fontItem)) continue;
                                if (fontItem[0] === 'size') {
                                    const sx = parseFloat(fontItem[1]);
                                    const sy = parseFloat(fontItem[2]);
                                    if (Number.isFinite(sy)) return sy;
                                    if (Number.isFinite(sx)) return sx;
                                }
                            }
                        }
                    }
                }
            }
            return null;
        };
        
        // Get pin type and shape
        if (pinSexp.length > 1) pin.pinType = pinSexp[1];
        if (pinSexp.length > 2) pin.shape = pinSexp[2];
        
        for (const item of pinSexp) {
            if (!Array.isArray(item)) continue;
            
            switch (item[0]) {
                case 'at':
                    // KiCad 6+ uses mm directly, just negate Y
                    pin.x = parseFloat(item[1]) || 0;
                    pin.y = -(parseFloat(item[2]) || 0); // Invert Y axis
                    if (item.length > 3) {
                        const angle = parseFloat(item[3]) || 0;
                        pin.orientation = this._angleToOrientation(angle);
                    }
                    break;
                case 'length':
                    pin.length = parseFloat(item[1]) || 2.54;
                    break;
                case 'name':
                    // Remove quotes if present
                    pin.name = String(item[1] || '').replace(/^"|"$/g, '');
                    pin.kicadNameFontSize = extractFontSize(item) ?? pin.kicadNameFontSize;
                    break;
                case 'number':
                    pin.number = String(item[1] || '').replace(/^"|"$/g, '');
                    pin.kicadNumberFontSize = extractFontSize(item) ?? pin.kicadNumberFontSize;
                    break;
            }
        }
        
        if (Number.isFinite(pin.x) && Number.isFinite(pin.y)) {
            pin._coordKey = `${pin.x.toFixed(3)},${pin.y.toFixed(3)}`;
        }
        return pin;
    }

    /**
     * Parse a `(property "Name" "Value")` S-expression.
     * @param {Array} propSexp
     * @returns {{name: string, value: string}|null}
     */
    _parseKiCadProperty(propSexp) {
        if (!Array.isArray(propSexp) || propSexp.length < 3) return null;
        const nameRaw = propSexp[1];
        const valueRaw = propSexp[2];

        const name = typeof nameRaw === 'string'
            ? nameRaw.replace(/^"|"$/g, '')
            : null;

        const value = typeof valueRaw === 'string'
            ? valueRaw.replace(/^"|"$/g, '')
            : null;

        return { name, value };
    }
    
    /**
     * Parse KiCad rectangle
     * (rectangle (start x1 y1) (end x2 y2) (stroke ...) (fill ...))
     */
    _parseKiCadRectangle(rectSexp) {
        let x1 = 0, y1 = 0, x2 = 0, y2 = 0;
        let stroke = 'var(--sch-symbol-outline)';
        let strokeWidth = 0.254;
        let fill = 'none';
        
        for (const item of rectSexp) {
            if (!Array.isArray(item)) continue;
            
            switch (item[0]) {
                case 'start':
                    x1 = parseFloat(item[1]) || 0;
                    y1 = -(parseFloat(item[2]) || 0);
                    break;
                case 'end':
                    x2 = parseFloat(item[1]) || 0;
                    y2 = -(parseFloat(item[2]) || 0);
                    break;
                case 'stroke':
                    const strokeInfo = this._parseStroke(item);
                    stroke = strokeInfo.color;
                    strokeWidth = strokeInfo.width;
                    break;
                case 'fill':
                    fill = this._parseFill(item);
                    break;
            }
        }
        
        return {
            type: 'rect',
            x: Math.min(x1, x2),
            y: Math.min(y1, y2),
            width: Math.abs(x2 - x1),
            height: Math.abs(y2 - y1),
            stroke: stroke,
            strokeWidth: strokeWidth,
            fill: fill
        };
    }
    
    /**
     * Parse KiCad polyline
     * (polyline (pts (xy x y) (xy x y) ...) (stroke ...) (fill ...))
     */
    _parseKiCadPolyline(polySexp) {
        const points = [];
        let stroke = 'var(--sch-symbol-outline)';
        let strokeWidth = 0.254;
        let fill = 'none';
        
        for (const item of polySexp) {
            if (!Array.isArray(item)) continue;
            
            switch (item[0]) {
                case 'pts':
                    for (let i = 1; i < item.length; i++) {
                        if (Array.isArray(item[i]) && item[i][0] === 'xy') {
                            points.push([
                                parseFloat(item[i][1]) || 0,
                                -(parseFloat(item[i][2]) || 0)
                            ]);
                        }
                    }
                    break;
                case 'stroke':
                    const strokeInfo = this._parseStroke(item);
                    stroke = strokeInfo.color;
                    strokeWidth = strokeInfo.width;
                    break;
                case 'fill':
                    fill = this._parseFill(item);
                    break;
            }
        }
        
        return {
            type: 'polyline',
            points: points,
            stroke: stroke,
            strokeWidth: strokeWidth,
            fill: fill
        };
    }
    
    /**
     * Parse KiCad circle
     * (circle (center x y) (radius r) (stroke ...) (fill ...))
     */
    _parseKiCadCircle(circleSexp) {
        let cx = 0, cy = 0, r = 1;
        let stroke = 'var(--sch-symbol-outline)';
        let strokeWidth = 0.254;
        let fill = 'none';
        
        for (const item of circleSexp) {
            if (!Array.isArray(item)) continue;
            
            switch (item[0]) {
                case 'center':
                    cx = parseFloat(item[1]) || 0;
                    cy = -(parseFloat(item[2]) || 0);
                    break;
                case 'radius':
                    r = parseFloat(item[1]) || 1;
                    break;
                case 'stroke':
                    const strokeInfo = this._parseStroke(item);
                    stroke = strokeInfo.color;
                    strokeWidth = strokeInfo.width;
                    break;
                case 'fill':
                    fill = this._parseFill(item);
                    break;
            }
        }
        
        return {
            type: 'circle',
            cx: cx,
            cy: cy,
            r: r,
            stroke: stroke,
            strokeWidth: strokeWidth,
            fill: fill
        };
    }
    
    /**
     * Parse KiCad arc
     * (arc (start x y) (mid x y) (end x y) (stroke ...) (fill ...))
     */
    _parseKiCadArc(arcSexp) {
        let startX = 0, startY = 0;
        let midX = 0, midY = 0;
        let endX = 0, endY = 0;
        let stroke = 'var(--sch-symbol-outline)';
        let strokeWidth = 0.254;
        let fill = 'none';
        
        for (const item of arcSexp) {
            if (!Array.isArray(item)) continue;
            
            switch (item[0]) {
                case 'start':
                    startX = parseFloat(item[1]) || 0;
                    startY = -(parseFloat(item[2]) || 0);
                    break;
                case 'mid':
                    midX = parseFloat(item[1]) || 0;
                    midY = -(parseFloat(item[2]) || 0);
                    break;
                case 'end':
                    endX = parseFloat(item[1]) || 0;
                    endY = -(parseFloat(item[2]) || 0);
                    break;
                case 'stroke':
                    const strokeInfo = this._parseStroke(item);
                    stroke = strokeInfo.color;
                    strokeWidth = strokeInfo.width;
                    break;
                case 'fill':
                    fill = this._parseFill(item);
                    break;
            }
        }
        
        // Calculate center and radius from three points
        const circ = circumcircle(
            { x: startX, y: startY }, { x: midX, y: midY }, { x: endX, y: endY }
        );
        const cx = circ ? circ.cx : midX;
        const cy = circ ? circ.cy : midY;
        const r = circ ? circ.radius : 1;
        
        // Calculate angles
        const startAngle = Math.atan2(startY - cy, startX - cx);
        const endAngle = Math.atan2(endY - cy, endX - cx);
        
        return {
            type: 'arc',
            cx: cx,
            cy: cy,
            r: r,
            startAngle: startAngle * 180 / Math.PI,
            endAngle: endAngle * 180 / Math.PI,
            stroke: stroke,
            strokeWidth: strokeWidth,
            fill: fill
        };
    }
    
    /**
     * Parse stroke properties
     */
    _parseStroke(strokeSexp) {
        // Use CSS variable for theme-aware colors
        let color = 'var(--sch-symbol-outline)';
        let width = 0.254;
        
        for (const item of strokeSexp) {
            if (!Array.isArray(item)) continue;
            
            switch (item[0]) {
                case 'width':
                    width = parseFloat(item[1]) || 0.254;
                    break;
                case 'color':
                    if (item.length >= 4) {
                        const r = Math.round(parseFloat(item[1]) || 0);
                        const g = Math.round(parseFloat(item[2]) || 0);
                        const b = Math.round(parseFloat(item[3]) || 0);
                        color = `rgb(${r},${g},${b})`;
                    }
                    break;
            }
        }
        
        return { color, width };
    }
    
    /**
     * Parse fill properties
     */
    _parseFill(fillSexp) {
        for (const item of fillSexp) {
            if (!Array.isArray(item)) continue;
            
            if (item[0] === 'type') {
                const fillType = String(item[1] || '').replace(/^"|"$/g, '');
                if (fillType === 'none') {
                    return 'none';
                } else if (fillType === 'outline') {
                    return 'currentColor';
                } else if (fillType === 'background') {
                    return '#ffffcc'; // Light yellow background fill (common in KiCad)
                }
            }
        }
        return 'none';
    }
    
    /**
     * Convert angle to orientation string
     */
    _angleToOrientation(angle) {
        const normalized = ((angle % 360) + 360) % 360;
        if (normalized === 0) return 'right';
        if (normalized === 90) return 'up';
        if (normalized === 180) return 'left';
        if (normalized === 270) return 'down';
        return 'right';
    }
    
    /**
     * Offset a graphic element
     */
    _offsetGraphic(g, dx, dy) {
        switch (g.type) {
            case 'rect':
                g.x += dx;
                g.y += dy;
                break;
            case 'circle':
            case 'arc':
                g.cx += dx;
                g.cy += dy;
                break;
            case 'polyline':
            case 'polygon':
                g.points = g.points.map(p => [p[0] + dx, p[1] + dy]);
                break;
            case 'line':
                g.x1 += dx;
                g.y1 += dy;
                g.x2 += dx;
                g.y2 += dy;
                break;
            case 'text':
                g.x += dx;
                g.y += dy;
                break;
        }
    }
}

export default KiCadFetcher;