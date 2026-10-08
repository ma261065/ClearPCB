/**
 * KiCadFetcher - Fetches and parses KiCad symbol and footprint libraries.
 *
 * The class owns the public fetcher state and delegates KiCad-specific
 * responsibilities to focused modules under src/components/kicad/.
 */

import { KEYWORD_ALIASES } from './kicad/constants.js';
import * as KiCadNetwork from './kicad/network.js';
import * as KiCadSymbolFetch from './kicad/symbol-fetch.js';
import * as KiCadSymbolIndex from './kicad/symbol-index.js';
import * as KiCadFootprints from './kicad/footprints.js';
import * as KiCadFootprintParser from './kicad/footprint-parser.js';
import * as KiCadSymbolParser from './kicad/symbol-parser.js';
import * as KiCadSexpParser from './kicad/sexp-parser.js';
import * as KiCadSymbolGraphics from './kicad/symbol-graphics.js';

/** @typedef {import('./Component.js').ComponentDefinition} ComponentDefinition */
/** @typedef {import('./Component.js').ComponentSymbol} ComponentSymbol */
/** @typedef {import('./Component.js').ComponentSymbolGraphic} ComponentSymbolGraphic */
/** @typedef {import('./Component.js').ComponentSymbolPin} ComponentSymbolPin */
/** @typedef {import('./kicad-index-format.js').StaticKiCadIndex} StaticKiCadIndex */
/** @typedef {import('./kicad/symbol-index.js').SymbolSearchResult} SymbolSearchResult */
/** @typedef {import('./kicad/footprints.js').FootprintAvailability} FootprintAvailability */
/** @typedef {import('./kicad/footprint-parser.js').FootprintPreview} FootprintPreview */
/** @typedef {import('./kicad/sexp-parser.js').SExprList} SExprList */
/** @typedef {import('./kicad/network.js').KiCadJsonResponse} KiCadJsonResponse */
/** @typedef {{symbols: Record<string, string[]>}} KiCadLibraryIndex */
/** @typedef {{loaded: number, total: number, message: string}} KiCadIndexProgress */
/** @typedef {(progress: KiCadIndexProgress) => void} KiCadIndexProgressCallback */

export class KiCadFetcher {
    static KEYWORD_ALIASES = KEYWORD_ALIASES;

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
        /** @type {Map<string, ComponentDefinition>} */
        this.symbolCache = new Map();
        /** @type {Map<string, string>} */
        this.footprintCache = new Map();
        /** @type {Map<string, boolean>} */
        this.footprintExistsCache = new Map();
        /** @type {Map<string, boolean>} */
        this.model3dExistsCache = new Map();
        /** @type {Map<string, FootprintPreview>} */
        this.footprintPreviewCache = new Map();
        /** @type {Map<string, string[]>} */
        this.footprintFilterSearchCache = new Map();
        /** @type {Map<string, string[]>} */
        this.footprintLibraryNamesCache = new Map();
        /** @type {Map<string, string[]>} */
        this._symdirCache = new Map();
        /** @type {KiCadLibraryIndex|null} */
        this.libraryIndex = null;
        /** @type {string[]|null} */
        this.footprintNameIndex = null;
        /** @type {Promise<void>|null} */
        this._indexLoadPromise = null;
        /** @type {Promise<void>|null} */
        this._footprintIndexLoadPromise = null;
        /** @type {KiCadIndexProgress|null} */
        this._indexProgress = null;
        /** @type {Record<string, string>|null} */
        this.libraryPathIndex = null;
        this.fetchFailed = false;
        /** @type {string|null} */
        this._latestRelease = null;
        /** @type {Promise<string>|null} */
        this._latestReleasePromise = null;
        /** @type {Promise<StaticKiCadIndex|null>|null} */
        this._staticIndexPromise = null;
        /** @type {KiCadIndexProgressCallback|null} */
        this._onProgress = null;
    }

    /** @returns {string} The primary CORS proxy URL. */
    get corsProxy() {
        return this.corsProxies[0];
    }



    /**
     * Get ordered git refs to try: [latest-release, master, main].
     * Before the release tag is detected, falls back to the hardcoded default.
     * @returns {string[]}
     */
    _getGitRefs() {
        return KiCadNetwork._getGitRefs(this);
    }



    /**
     * Detect the latest stable KiCad library release tag from GitLab.
     * Result is cached in localStorage for 7 days.
     * @returns {Promise<string>}
     */
    _detectLatestRelease() {
        return KiCadNetwork._detectLatestRelease(this);
    }



    /**
     * Load the KiCad index published with the site. Resolves null when it is
     * absent or invalid (e.g. a local checkout), so callers fall back to live
     * GitLab loading. Loaded at most once per fetcher.
     * @returns {Promise<import('./kicad-index-format.js').StaticKiCadIndex|null>}
     */
    _loadStaticIndex() {
        return KiCadNetwork._loadStaticIndex(this);
    }



    /** @returns {Promise<import('./kicad-index-format.js').StaticKiCadIndex|null>} */
    _fetchStaticIndex() {
        return KiCadNetwork._fetchStaticIndex(this);
    }



    /**
     * Latest stable release tag: the published index's tag (so symbol and
     * footprint lookups match the index), else the GitLab tags API.
     * @returns {Promise<string>}
     */
    _fetchLatestRelease() {
        return KiCadNetwork._fetchLatestRelease(this);
    }



    /**
     * Cache fetched KiCad library content and emit a debug log.
     * @param {string} cacheKey
     * @param {string} library
     * @param {string} content
     */
    _cacheLibraryContent(cacheKey, library, content) {
        return KiCadNetwork._cacheLibraryContent(this, cacheKey, library, content);
    }



    /**
     * Cache content data with the standard content TTL.
     * @param {string} key
     * @param {unknown} value
     * @returns {boolean}
     */
    _setContentCache(key, value) {
        return KiCadNetwork._setContentCache(this, key, value);
    }



    /**
     * Read response text and validate it using the provided validator.
     * @param {Response} response
     * @param {(content: unknown) => boolean} validator
     * @returns {Promise<string|null>}
     */
    _readValidatedResponseText(response, validator) {
        return KiCadNetwork._readValidatedResponseText(this, response, validator);
    }



    /**
     * Fetch the first valid text payload from URL candidates.
     * @param {string[]} targetUrls
     * @param {object} options
    * @param {(content: unknown) => boolean} [options.validator]
     * @param {string} [options.errorContext='KiCad fetch error']
     * @param {string} [options.logPrefix]
     * @returns {Promise<string|null>}
     */
    _fetchFirstValidContentFromUrls(targetUrls, options = {}) {
        return KiCadNetwork._fetchFirstValidContentFromUrls(this, targetUrls, options);
    }



    /**
     * Validate that fetched content looks like a KiCad symbol library file.
     * @param {unknown} content
     * @returns {content is string}
     */
    _isValidKiCadSymbolContent(content) {
        return KiCadNetwork._isValidKiCadSymbolContent(this, content);
    }



    /**
     * Validate footprint file content format.
     * @param {unknown} content
     * @returns {content is string}
     */
    _isValidFootprintContent(content) {
        return KiCadNetwork._isValidFootprintContent(this, content);
    }



    /**
     * Parse JSON from a fetch response and optionally include headers.
     * @param {Response} response
     * @param {boolean} [returnHeaders=false]
     * @returns {Promise<KiCadJsonResponse|null>}
     */
    _parseJsonFromResponse(response, returnHeaders = false) {
        return KiCadNetwork._parseJsonFromResponse(this, response, returnHeaders);
    }



    /**
     * Fetch JSON from a URL through CORS proxies.
     * @param {string} targetUrl
     * @param {boolean} [returnHeaders=false] - If true, return `{ json, headers }`
     * @returns {Promise<KiCadJsonResponse|null>}
     */
    _fetchJsonWithProxy(targetUrl, returnHeaders = false) {
        return KiCadNetwork._fetchJsonWithProxy(this, targetUrl, returnHeaders);
    }



    /**
     * Build a GitLab repository/tree API URL.
     * @param {object} params
     * @param {string} params.projectPath
     * @param {string} params.ref
     * @param {number} [params.perPage=100]
     * @param {number} [params.page=1]
     * @param {boolean} [params.recursive=false]
     * @param {string} [params.path]
     * @returns {string}
     */
    _buildGitLabTreeApiUrl(params) {
        return KiCadNetwork._buildGitLabTreeApiUrl(this, params);
    }



    /**
     * Build a GitLab search API URL.
     * @param {{projectPath: string, scope: string, search: string, perPage?: number, page?: number, ref?: string}} params
     * @returns {string}
     */
    _buildGitLabSearchApiUrl(params) {
        return KiCadNetwork._buildGitLabSearchApiUrl(this, params);
    }



    /**
     * Fetch a GitLab repository/tree page through the configured proxy chain.
     * @param {object} params
     * @param {string} params.projectPath
     * @param {string} params.ref
     * @param {number} [params.perPage=100]
     * @param {number} [params.page=1]
     * @param {boolean} [params.recursive=false]
     * @param {string} [params.path]
     * @param {boolean} [returnHeaders=false]
     * @returns {Promise<KiCadJsonResponse|null>}
     */
    _fetchGitLabTreePage(params, returnHeaders = false) {
        return KiCadNetwork._fetchGitLabTreePage(this, params, returnHeaders);
    }



    /**
     * Search blobs in a GitLab project.
     * @param {{projectPath: string, scope: string, search: string, perPage?: number, page?: number, ref?: string}} params
     * @returns {Promise<KiCadJsonResponse|null>}
     */
    _fetchGitLabSearchPage(params) {
        return KiCadNetwork._fetchGitLabSearchPage(this, params);
    }



    /**
     * Wrap fetch() with an AbortController timeout.
     * @param {string} url
     * @param {number} [timeoutMs=15000]
     * @returns {Promise<Response>}
     */
    _fetchWithTimeout(url, timeoutMs = 15000) {
        return KiCadNetwork._fetchWithTimeout(this, url, timeoutMs);
    }



    /**
     * Fetch a target URL through configured proxies and return the first successful response.
     * @param {string} targetUrl
     * @param {string} [errorContext='KiCad fetch error']
     * @returns {Promise<Response|null>}
     */
    _fetchFirstOkResponse(targetUrl, errorContext = 'KiCad fetch error') {
        return KiCadNetwork._fetchFirstOkResponse(this, targetUrl, errorContext);
    }



    /**
     * Check whether a URL exists by attempting a fetch through CORS proxies.
     * @param {string} targetUrl
     * @returns {Promise<boolean>}
     */
    _checkUrlExists(targetUrl) {
        return KiCadNetwork._checkUrlExists(this, targetUrl);
    }



    /**
     * Returns candidate raw bases, preferring configured base then alternate main/master.
     * @param {string} base
     * @returns {string[]}
     */
    _getRawBaseCandidates(base) {
        return KiCadNetwork._getRawBaseCandidates(this, base);
    }



    /**
     * Builds raw URL candidates by combining raw base candidates and relative path.
     * @param {string} base
     * @param {string} relativePath
     * @returns {string[]}
     */
    _buildRawUrlCandidates(base, relativePath) {
        return KiCadNetwork._buildRawUrlCandidates(this, base, relativePath);
    }



    /**
     * Builds symbol-library URL candidates including optional /symbols subdir variants.
     * @param {string} library
     * @returns {string[]}
     */
    _buildSymbolLibraryUrlCandidates(library) {
        return KiCadNetwork._buildSymbolLibraryUrlCandidates(this, library);
    }



    /**
     * Resolves first existing URL from candidates with existence-cache support.
     * @param {string[]} candidates
     * @param {Map<string, boolean>} cache
     * @param {string} prefix
     * @returns {Promise<string|null>}
     */
    _resolveFirstExistingUrl(candidates, cache, prefix) {
        return KiCadNetwork._resolveFirstExistingUrl(this, candidates, cache, prefix);
    }



    /**
     * Fetch a specific symbol
     * @param {string} library - Library name (e.g., "Timer")
     * @param {string} symbolName - Symbol name (e.g., "NE555")
     * @returns {Promise<ComponentDefinition|null>} ClearPCB symbol definition
     */
    fetchSymbol(library, symbolName) {
        return KiCadSymbolFetch.fetchSymbol(this, library, symbolName);
    }



    /**
     * Fetch a library file from GitLab (with caching)
     * @param {string} library
     * @returns {Promise<string>}
     */
    _fetchLibraryFile(library) {
        return KiCadSymbolFetch._fetchLibraryFile(this, library);
    }



    /**
     * Load or refresh the library-name → file/directory path index from GitLab.
     * Uses a 7-day TTL cache in localStorage.
     * @param {boolean} [force=false] - Force refresh even if cached
     */
    _loadLibraryPathIndex(force = false) {
        return KiCadSymbolFetch._loadLibraryPathIndex(this, force);
    }



    /**
     * List the contents of a .kicad_symdir directory via GitLab tree API.
     * Results are cached per library name.
     * @param {string} library
     * @returns {Promise<string[]>}
     */
    _listSymdirContents(library) {
        return KiCadSymbolFetch._listSymdirContents(this, library);
    }



    /**
     * Find a symbol file in a symdir by exact or prefix match.
     * Returns the actual filename (without .kicad_sym) or null.
     * @param {string} library
     * @param {string} symbolName
     * @returns {Promise<string|null>}
     */
    _findMatchingSymbolInDir(library, symbolName) {
        return KiCadSymbolFetch._findMatchingSymbolInDir(this, library, symbolName);
    }



    /**
     * Fetch a single `.kicad_sym` file from a symdir on GitLab.
     * @param {string} symDirPath - Directory path within the symbols repo
     * @param {string} symbolName - Symbol name (used as filename stem)
     * @returns {Promise<string|null>} Raw file content or null
     */
    _fetchSymbolFile(symDirPath, symbolName) {
        return KiCadSymbolFetch._fetchSymbolFile(this, symDirPath, symbolName);
    }



    /**
     * Search for a symbol by MPN or name
     * @param {string} query - Part number or name to search for
     * @returns {Promise<SymbolSearchResult[]>} Matching symbols
     */
    searchSymbols(query) {
        return KiCadSymbolIndex.searchSymbols(this, query);
    }




    /**
     * Ensure the symbol index is loaded. Returns immediately if already cached.
     * Otherwise fetches from GitLab (blocking). Callers can pass an onProgress
     * callback to show progress: onProgress({ loaded, total, message }).
     * Multiple concurrent callers share the same in-flight promise.
     * @param {KiCadIndexProgressCallback} [onProgress]
     * @returns {Promise<void>|undefined}
     */
    ensureIndexLoaded(onProgress) {
        return KiCadSymbolIndex.ensureIndexLoaded(this, onProgress);
    }



    /**
     * Adopt an already-complete symbol index without overwriting per-library
     * listings fetched earlier.
     * @param {Object.<string, string[]>} symbols
     */
    _useSymbolIndex(symbols) {
        return KiCadSymbolIndex._useSymbolIndex(this, symbols);
    }



    /**
     * Silently refresh the symbol index in the background.
     * Updates in-memory + localStorage caches when done.
     */
    _refreshIndexInBackground() {
        return KiCadSymbolIndex._refreshIndexInBackground(this);
    }



    /**
     * Persist latest index progress and notify active UI callback when set.
     * @param {{loaded:number,total:number,message:string}} progress
     */
    _emitIndexProgress(progress) {
        return KiCadSymbolIndex._emitIndexProgress(this, progress);
    }



    /**
     * Fetch the complete symbol index from GitLab using the recursive tree API.
     * Parses paths like "Timer.kicad_symdir/NE555D.kicad_sym" to build
     * { Timer: ['NE555D', ...], ... }.  Caches the result for 7 days.
     */
    _fetchFullSymbolIndex() {
        return KiCadSymbolIndex._fetchFullSymbolIndex(this);
    }



    /**
     * Check whether a KiCad footprint file and its 3D STEP model exist on GitLab.
     * @param {string} footprintName - e.g. 'Resistor_SMD:R_0603_1608Metric'
     * @returns {Promise<FootprintAvailability>}
     */
    checkFootprintAvailability(footprintName) {
        return KiCadFootprints.checkFootprintAvailability(this, footprintName);
    }



    /**
     * Fetch and parse a `.kicad_mod` footprint file into a pad-shape preview.
     * @param {string} footprintName - e.g. 'Resistor_SMD:R_0603_1608Metric'
     * @returns {Promise<FootprintPreview|null>}
     */
    fetchFootprintPreview(footprintName) {
        return KiCadFootprints.fetchFootprintPreview(this, footprintName);
    }



    /**
     * Find likely concrete footprints from KiCad fp-filter patterns.
     * @param {string[]} filters
     * @param {{limit?: number}} [options]
     * @returns {Promise<string[]>}
     */
    findFootprintCandidatesByFilters(filters, options = {}) {
        return KiCadFootprints.findFootprintCandidatesByFilters(this, filters, options);
    }



    /**
     * Convert wildcard fp-filter to a case-insensitive regex.
     * @param {string} filter
     * @returns {RegExp}
     */
    _fpFilterToRegex(filter) {
        return KiCadFootprints._fpFilterToRegex(this, filter);
    }



    /**
     * Load all footprint names inside a specific KiCad footprint library.
     * @param {string} libName
     * @returns {Promise<string[]>}
     */
    _getFootprintNamesForLibrary(libName) {
        return KiCadFootprints._getFootprintNamesForLibrary(this, libName);
    }



    /**
     * Find suffix sibling variants for a concrete footprint in the same library.
     * Example: Lib:Base -> Lib:Base_Handsoldering
     * @param {string} footprintName
     * @returns {Promise<string[]>}
     */
    findFootprintSiblingVariants(footprintName) {
        return KiCadFootprints.findFootprintSiblingVariants(this, footprintName);
    }



    /**
     * Ensure full footprint-name index is loaded for deterministic filter matching.
     * @returns {Promise<void>}
     */
    _ensureFootprintIndexLoaded() {
        return KiCadFootprints._ensureFootprintIndexLoaded(this);
    }



    /**
     * Load complete footprint name index from cache or GitLab tree API.
     * @returns {Promise<void>}
     */
    _loadFootprintNameIndex() {
        return KiCadFootprints._loadFootprintNameIndex(this);
    }



    /**
     * Fetch a `.kicad_mod` footprint file with 7-day localStorage caching.
     * @param {string} lib - Footprint library name
     * @param {string} name - Footprint name (without extension)
     * @returns {Promise<string|null>} Raw file content or null
     */
    _fetchFootprintFile(lib, name) {
        return KiCadFootprints._fetchFootprintFile(this, lib, name);
    }



    /**
     * Parse a `.kicad_mod` S-expression into a simplified pad-shapes array
     * with a bounding box, suitable for rendering a footprint preview.
     * KiCad footprint files are Y-down like ClearPCB, so coordinates are used as
     * written (unlike `.kicad_sym` symbols, which are Y-up).
     * @param {string} content - Raw `.kicad_mod` file content
     * @returns {FootprintPreview|null}
     */
    _parseFootprintPreview(content) {
        return KiCadFootprintParser._parseFootprintPreview(this, content);
    }



    /**
     * Extract the `Footprint` property value for a given symbol name
     * from raw KiCad library file content.
     * @param {string} content - Raw `.kicad_sym` content
     * @param {string} symbolName
     * @returns {string} Footprint reference or empty string
     */
    _extractFootprintFromContent(content, symbolName) {
        return KiCadFootprintParser._extractFootprintFromContent(this, content, symbolName);
    }



    /**
     * Parse KiCad S-expression format and extract a symbol
     * @param {string} content - Library file content
     * @param {string} symbolName - Name of symbol to extract
     * @returns {ComponentDefinition|null} ClearPCB symbol definition
     */
    _parseSymbolFromLibrary(content, symbolName) {
        return KiCadSymbolParser._parseSymbolFromLibrary(this, content, symbolName);
    }



    /**
     * Parse S-expression string into nested arrays
     * @param {string} str - S-expression string
     * @returns {SExprList|null} Parsed structure
     */
    _parseSExp(str) {
        return KiCadSexpParser._parseSExp(this, str);
    }



    /**
     * If a parsed symbol has no pins or graphics, try to rebuild it
     * from its unit sub-symbols (e.g. `NE555_1_1`).
     * @param {SExprList} sexp - Parsed S-expression of the library
     * @param {ComponentSymbol} symbol - Already-converted symbol object
     * @param {string} baseName - Symbol base name (without unit suffix)
     * @returns {ComponentSymbol} Original or rebuilt symbol
     */
    _rebuildSymbolFromUnitsIfNeeded(sexp, symbol, baseName) {
        return KiCadSymbolParser._rebuildSymbolFromUnitsIfNeeded(this, sexp, symbol, baseName);
    }



    /**
     * Build a complete symbol by locating and merging all unit sub-symbols
     * (e.g. `SymbolName_1_1`, `_1_2`, ...) from a library S-expression.
     * @param {SExprList} sexp - Parsed library S-expression
     * @param {string} baseName - Symbol base name
     * @returns {ComponentSymbol|null} Merged symbol or null
     */
    _buildSymbolFromUnits(sexp, baseName) {
        return KiCadSymbolParser._buildSymbolFromUnits(this, sexp, baseName);
    }



    /**
     * Tokenize S-expression string
     * @param {string} str
     * @returns {string[]}
     */
    _tokenize(str) {
        return KiCadSexpParser._tokenize(this, str);
    }



    /**
     * Convert KiCad symbol to ClearPCB format
     * @param {SExprList} symbolSexp - Parsed symbol S-expression
     * @returns {ComponentDefinition|null} ClearPCB symbol definition
     */
    _convertKiCadSymbol(symbolSexp) {
        return KiCadSymbolParser._convertKiCadSymbol(this, symbolSexp);
    }



    /**
     * Build a symbol from nested `(symbol ...)` unit elements within a
     * top-level symbol S-expression. Deduplicates pins and normalises
     * coordinates to a shared origin.
     * @param {SExprList} symbolSexp - Top-level symbol S-expression
     * @returns {ComponentDefinition|null} Symbol with graphics, pins, and computed bounds
     */
    _buildSymbolFromNestedUnits(symbolSexp) {
        return KiCadSymbolParser._buildSymbolFromNestedUnits(this, symbolSexp);
    }



    /**
     * Process a symbol unit (nested symbol element)
     */
    /**
     * Resolve an `extends` reference by fetching the base symbol and
     * copying its graphics/pins into the extending symbol.
     * @param {ComponentDefinition} result - Parsed symbol result from _convertKiCadSymbol
     * @param {string} library - Library name (e.g., "Timer")
     * @param {number} depth - Recursion depth guard
     * @returns {Promise<ComponentDefinition>} result with graphics/pins populated from base
     */
    _resolveExtends(result, library, depth = 0) {
        return KiCadSymbolParser._resolveExtends(this, result, library, depth);
    }



    /**
     * Process a single symbol unit sub-element, extracting its pins,
     * rectangles, polylines, circles and arcs, and tracking min/max bounds.
     * @param {SExprList} unitSexp - Unit S-expression
     * @returns {{graphics: ComponentSymbolGraphic[], pins: ComponentSymbolPin[], minX: number, minY: number, maxX: number, maxY: number}}
     */
    _processSymbolUnit(unitSexp) {
        return KiCadSymbolParser._processSymbolUnit(this, unitSexp);
    }



    /**
     * Parse KiCad pin
     * (pin type shape (at x y angle) (length len) (name "name" ...) (number "num" ...))
     * @param {SExprList} pinSexp
     */
    _parseKiCadPin(pinSexp) {
        return KiCadSymbolGraphics._parseKiCadPin(this, pinSexp);
    }



    /**
     * Parse a `(property "Name" "Value")` S-expression.
     * @param {SExprList} propSexp
     * @returns {{name: string|null, value: string|null}|null}
     */
    _parseKiCadProperty(propSexp) {
        return KiCadSymbolGraphics._parseKiCadProperty(this, propSexp);
    }



    /**
     * Parse KiCad rectangle
     * (rectangle (start x1 y1) (end x2 y2) (stroke ...) (fill ...))
     * @param {SExprList} rectSexp
     */
    _parseKiCadRectangle(rectSexp) {
        return KiCadSymbolGraphics._parseKiCadRectangle(this, rectSexp);
    }



    /**
     * Parse KiCad polyline
     * (polyline (pts (xy x y) (xy x y) ...) (stroke ...) (fill ...))
     * @param {SExprList} polySexp
     */
    _parseKiCadPolyline(polySexp) {
        return KiCadSymbolGraphics._parseKiCadPolyline(this, polySexp);
    }



    /**
     * Parse KiCad circle
     * (circle (center x y) (radius r) (stroke ...) (fill ...))
     * @param {SExprList} circleSexp
     */
    _parseKiCadCircle(circleSexp) {
        return KiCadSymbolGraphics._parseKiCadCircle(this, circleSexp);
    }



    /**
     * Parse KiCad arc
     * (arc (start x y) (mid x y) (end x y) (stroke ...) (fill ...))
     * @param {SExprList} arcSexp
     */
    _parseKiCadArc(arcSexp) {
        return KiCadSymbolGraphics._parseKiCadArc(this, arcSexp);
    }



    /**
     * Parse stroke properties
     * @param {SExprList} strokeSexp
     */
    _parseStroke(strokeSexp) {
        return KiCadSymbolGraphics._parseStroke(this, strokeSexp);
    }



    /**
     * Parse fill properties
     * @param {SExprList} fillSexp
     */
    _parseFill(fillSexp) {
        return KiCadSymbolGraphics._parseFill(this, fillSexp);
    }



    /**
     * Convert angle to orientation string
     * @param {number} angle
     */
    _angleToOrientation(angle) {
        return KiCadSymbolGraphics._angleToOrientation(this, angle);
    }



    /**
     * Offset a graphic element
     * @param {ComponentSymbolGraphic} g
     * @param {number} dx
     * @param {number} dy
     */
    _offsetGraphic(g, dx, dy) {
        return KiCadSymbolGraphics._offsetGraphic(this, g, dx, dy);
    }

}

/**
 * Start the KiCad index download in the background without blocking startup;
 * failures are logged and the picker retries when opened.
 * @param {{ kicadFetcher?: KiCadFetcher }} library
 */
export function warmKiCadIndex(library) {
    library.kicadFetcher?.ensureIndexLoaded()
        ?.catch(err => console.warn('KiCad background index warm-up failed:', err));
}

export default KiCadFetcher;
