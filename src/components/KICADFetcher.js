/**
 * KiCadFetcher - Fetches and parses KiCad symbol and footprint libraries
 * 
 * KiCad libraries use an S-expression format and are hosted on GitLab.
 * Symbols: https://gitlab.com/kicad/libraries/kicad-symbols
 * Footprints: https://gitlab.com/kicad/libraries/kicad-footprints
 * 3D Models: https://gitlab.com/kicad/libraries/kicad-packages3D
 */

import { storageManager } from '../core/StorageManager.js';

export class KiCadFetcher {
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
        this.libraryIndex = null;
        this.libraryPathIndex = null;
        this.fetchFailed = false;
    }
    
    get corsProxy() {
        return this.corsProxies[0];
    }
    
    /**
     * Search for a symbol by MPN or name
     * @param {string} query - Part number or name to search for
     * @returns {Promise<Array>} Matching symbols
     */
    async searchSymbols(query) {
        // Check search result cache first
        const cacheKey = `kicad_search_${query.toLowerCase()}`;
        const cachedResults = storageManager.get(cacheKey);
        if (cachedResults && Array.isArray(cachedResults)) {
            console.log(`Using cached KiCad search results for: ${query}`);
            return cachedResults;
        }
        
        // Load library index if not cached
        if (!this.libraryIndex) {
            await this._loadLibraryIndex();
        }
        
        const queryLower = query.toLowerCase();
        const results = [];
        
        for (const [libName, symbols] of Object.entries(this.libraryIndex.symbols)) {
            for (const symbolName of symbols) {
                if (symbolName.toLowerCase().includes(queryLower)) {
                    results.push({
                        library: libName,
                        name: symbolName,
                        fullName: `${libName}:${symbolName}`
                    });
                }
            }
        }
        
        const limitedResults = results.slice(0, 50); // Limit results
        
        // Cache the search results (with TTL of 24 hours)
        storageManager.set(cacheKey, limitedResults, 24 * 60 * 60);
        
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
                    symbol._kicadRaw = symContent;
                    symbol.kicadName = symbol.kicadName || symbolName;
                    this.symbolCache.set(cacheKey, symbol);
                    return symbol;
                }
            }

            // Fetch the library file
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

    async checkFootprintAvailability(footprintName) {
        if (!footprintName || typeof footprintName !== 'string') {
            return { hasFootprint: false, has3d: false };
        }

        const [lib, name] = footprintName.split(':');
        if (!lib || !name) {
            return { hasFootprint: false, has3d: false };
        }

        const footprintUrl = `${this.footprintsBase}/${lib}.pretty/${name}.kicad_mod`;
        const modelUrl = `${this.models3dBase}/${lib}.3dshapes/${name}.wrl`;

        const footprintCacheKey = `fp:${footprintUrl}`;
        const modelCacheKey = `3d:${modelUrl}`;

        const hasFootprint = this.footprintExistsCache.has(footprintCacheKey)
            ? this.footprintExistsCache.get(footprintCacheKey)
            : await this._checkUrlExists(footprintUrl);

        const has3d = this.model3dExistsCache.has(modelCacheKey)
            ? this.model3dExistsCache.get(modelCacheKey)
            : await this._checkUrlExists(modelUrl);

        this.footprintExistsCache.set(footprintCacheKey, hasFootprint);
        this.model3dExistsCache.set(modelCacheKey, has3d);

        return { hasFootprint, has3d, footprintUrl, modelUrl };
    }

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

        const baseCandidates = [this.symbolsBase];
        if (this.symbolsBase.includes('/-/raw/master')) {
            baseCandidates.push(this.symbolsBase.replace('/-/raw/master', '/-/raw/main'));
        }
        const expandedBases = [];
        for (const base of baseCandidates) {
            expandedBases.push(base);
            if (!base.endsWith('/symbols')) {
                expandedBases.push(`${base}/symbols`);
            }
        }

        const targetUrls = expandedBases.map(base => `${base}/${library}.kicad_sym`);
        
        for (const targetUrl of targetUrls) {
            // Try each proxy
            for (let attempt = 0; attempt < this.corsProxies.length; attempt++) {
                try {
                    // Build URL based on proxy type
                    let url;
                    if (this.corsProxy.includes('allorigins')) {
                        // allorigins expects encoded URL
                        url = `${this.corsProxy}${encodeURIComponent(targetUrl)}`;
                    } else {
                        // corsproxy.io expects encoded URL too
                        url = `${this.corsProxy}${encodeURIComponent(targetUrl)}`;
                    }
                    
                    console.log(`Fetching KiCad library: ${library}`);
                    
                    const response = await this._fetchWithTimeout(url);
                    
                    if (!response.ok) {
                        console.warn(`KiCad fetch failed with status ${response.status}`);
                        continue;
                    }
                    
                    const content = await response.text();
                    console.log(`KiCad library ${library} fetched, size: ${content.length} bytes`);
                    
                    // Validate content is a string
                    if (typeof content !== 'string') {
                        console.warn('KiCad content is not a string, skipping cache');
                        return null;
                    }
                    
                    // Verify it looks like a KiCad file
                    if (!content.includes('kicad_symbol_lib')) {
                        console.warn('Response does not look like a KiCad library file:', content.substring(0, 200));
                        continue;
                    }
                    
                    // Cache the result with 7-day TTL
                    storageManager.set(cacheKey, content, 7 * 24 * 60 * 60);
                    console.log(`Cached KiCad library: ${library}`);
                    
                    return content;
                    
                } catch (error) {
                    console.error(`KiCad fetch error with proxy ${this.corsProxy}:`, error);
                }
            }
        }
        
        // If initial attempts failed, refresh the index once and retry with discovered paths
        await this._loadLibraryPathIndex(true);
        const refreshedPath = this.libraryPathIndex?.[library];
        if (refreshedPath && !refreshedPath.endsWith('.kicad_symdir')) {
            const retryUrls = baseCandidates.map(base => `${base}/${refreshedPath}`);
            for (const targetUrl of retryUrls) {
                for (let attempt = 0; attempt < this.corsProxies.length; attempt++) {
                    try {
                        let url;
                        if (this.corsProxy.includes('allorigins')) {
                            url = `${this.corsProxy}${encodeURIComponent(targetUrl)}`;
                        } else {
                            url = `${this.corsProxy}${encodeURIComponent(targetUrl)}`;
                        }

                        console.log(`Fetching KiCad library (retry): ${library}`);

                        const response = await this._fetchWithTimeout(url);
                        if (!response.ok) {
                            console.warn(`KiCad fetch failed with status ${response.status}`);
                            continue;
                        }

                        const content = await response.text();
                        if (typeof content !== 'string') {
                            console.warn('KiCad content is not a string, skipping cache');
                            return null;
                        }

                        if (!content.includes('kicad_symbol_lib')) {
                            console.warn('Response does not look like a KiCad library file:', content.substring(0, 200));
                            continue;
                        }

                        storageManager.set(cacheKey, content, 7 * 24 * 60 * 60);
                        console.log(`Cached KiCad library: ${library}`);
                        return content;
                    } catch (error) {
                        console.error(`KiCad fetch error with proxy ${this.corsProxy}:`, error);
                    }
                }
            }
        }

        throw new Error(`Failed to fetch KiCad library ${library} - all proxies failed`);
    }

    async _fetchSymbolFile(symDirPath, symbolName) {
        const fileName = `${symbolName}.kicad_sym`;
        const targetUrls = [
            `${this.symbolsBase}/${symDirPath}/${fileName}`
        ];
        if (this.symbolsBase.includes('/-/raw/master')) {
            targetUrls.push(`${this.symbolsBase.replace('/-/raw/master', '/-/raw/main')}/${symDirPath}/${fileName}`);
        }

        for (const targetUrl of targetUrls) {
            for (let attempt = 0; attempt < this.corsProxies.length; attempt++) {
                try {
                    const url = `${this.corsProxy}${encodeURIComponent(targetUrl)}`;
                    console.log(`Fetching KiCad symbol file: ${symDirPath}/${fileName}`);
                    const response = await this._fetchWithTimeout(url);
                    if (!response.ok) {
                        console.warn(`KiCad fetch failed with status ${response.status}`);
                        continue;
                    }
                    const content = await response.text();
                    if (typeof content !== 'string') {
                        console.warn('KiCad content is not a string, skipping cache');
                        return null;
                    }
                    if (!content.includes('kicad_symbol_lib')) {
                        console.warn('Response does not look like a KiCad library file:', content.substring(0, 200));
                        continue;
                    }
                    return content;
                } catch (error) {
                    console.error(`KiCad fetch error with proxy ${this.corsProxy}:`, error);
                }
            }
        }
        return null;
    }

    async _fetchJsonWithProxy(targetUrl) {
        for (let attempt = 0; attempt < this.corsProxies.length; attempt++) {
            try {
                const url = `${this.corsProxy}${encodeURIComponent(targetUrl)}`;
                const response = await this._fetchWithTimeout(url);
                if (!response.ok) {
                    continue;
                }
                return await response.json();
            } catch (error) {
                console.error(`KiCad fetch error with proxy ${this.corsProxy}:`, error);
            }
        }
        return null;
    }

    async _fetchWithTimeout(url, timeoutMs = 8000) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await fetch(url, { signal: controller.signal });
        } finally {
            clearTimeout(timeoutId);
        }
    }

    async _loadLibraryPathIndex(force = false) {
        if (!force && this.libraryPathIndex) {
            return;
        }

        const cacheKey = 'kicad_library_index';
        if (!force) {
            const cached = storageManager.get(cacheKey);
            if (cached && typeof cached === 'object') {
                this.libraryPathIndex = cached;
                return;
            }
        }

        const projectPath = 'kicad%2Flibraries%2Fkicad-symbols';
        const perPage = 100;
        const refs = ['master', 'main'];

        for (const ref of refs) {
            const index = {};
            let page = 1;
            let hasMore = true;

            while (hasMore) {
                const apiUrl = `https://gitlab.com/api/v4/projects/${projectPath}/repository/tree?ref=${encodeURIComponent(ref)}&per_page=${perPage}&page=${page}`;
                const data = await this._fetchJsonWithProxy(apiUrl);
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
                storageManager.set(cacheKey, index, 7 * 24 * 60 * 60);
                return;
            }
        }
    }

    async _checkUrlExists(targetUrl) {
        for (let attempt = 0; attempt < this.corsProxies.length; attempt++) {
            try {
                let url;
                if (this.corsProxy.includes('allorigins')) {
                    url = `${this.corsProxy}${encodeURIComponent(targetUrl)}`;
                } else {
                    url = `${this.corsProxy}${encodeURIComponent(targetUrl)}`;
                }

                const response = await fetch(url);
                if (response.ok) {
                    return true;
                }
            } catch (error) {
                console.error(`KiCad fetch error with proxy ${this.corsProxy}:`, error);
            }
        }

        return false;
    }

    async _fetchFootprintFile(lib, name) {
        const cacheKey = `kicad_fp_${lib}_${name}`;
        const cached = storageManager.get(cacheKey);
        if (cached && typeof cached === 'string') {
            return cached;
        }

        const targetUrl = `${this.footprintsBase}/${lib}.pretty/${name}.kicad_mod`;

        for (let attempt = 0; attempt < this.corsProxies.length; attempt++) {
            try {
                const url = `${this.corsProxy}${encodeURIComponent(targetUrl)}`;
                const response = await fetch(url);
                if (!response.ok) {
                    continue;
                }

                const content = await response.text();
                if (typeof content !== 'string') {
                    return null;
                }

                if (!content.includes('footprint')) {
                    continue;
                }

                storageManager.set(cacheKey, content, 7 * 24 * 60 * 60);
                return content;
            } catch (error) {
                console.error(`KiCad footprint fetch error with proxy ${this.corsProxy}:`, error);
            }
        }

        return null;
    }

    _parseFootprintPreview(content) {
        if (!content) return null;

        const sexp = this._parseSExp(content);
        if (!Array.isArray(sexp) || sexp[0] !== 'footprint') {
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
     * Load the library index (list of available libraries and symbols)
     * For now, we'll use a hardcoded list of common libraries
     * In production, this could be fetched from a pre-built index
     */
    async _loadLibraryIndex() {
        // Common KiCad symbol libraries relevant for electronics
        this.libraryIndex = {
            symbols: {
                'Timer': ['LM555', 'NE555', 'TLC555', 'ICM7555', 'LMC555', 'NA555', 'SA555', 'SE555'],
                'Amplifier_Operational': ['LM358', 'LM324', 'TL072', 'TL074', 'LM741', 'NE5532', 'OPA2134'],
                'Regulator_Linear': ['LM7805', 'LM7812', 'LM7905', 'LM317', 'LM1117', 'AMS1117'],
                'Regulator_Switching': ['LM2596', 'MC34063', 'TPS61040', 'MT3608', 'MP1584'],
                'MCU_Microchip_ATmega': ['ATmega328P', 'ATmega328', 'ATmega168', 'ATmega2560'],
                'MCU_Microchip_ATtiny': ['ATtiny85', 'ATtiny45', 'ATtiny13', 'ATtiny84'],
                'MCU_ST_STM32F1': ['STM32F103C8', 'STM32F103CB', 'STM32F103RB'],
                'MCU_ST_STM32F4': ['STM32F401CC', 'STM32F411CE', 'STM32F407VG'],
                'MCU_Espressif': ['ESP32-C3', 'ESP32-PICO-D4', 'ESP32-PICO-V3', 'ESP32-PICO-V3-02', 'ESP32-S2', 'ESP32-S3', 'ESP8266EX'],
                'Transistor_BJT': ['BC547', 'BC557', '2N2222', '2N3904', '2N3906', 'TIP120', 'TIP125'],
                'Transistor_FET': ['2N7000', 'BS170', 'IRF520', 'IRF540', 'IRLZ44N', 'AO3400'],
                'Diode': ['1N4148', '1N4007', '1N5819', '1N5822', 'BAT54', 'SS14', 'SS34'],
                'Diode_Bridge': ['DB107', 'KBP210', 'DF10M'],
                'LED': ['LED', 'LED_Small', 'LED_RGB', 'LED_ARGB'],
                'Device': ['R', 'C', 'L', 'Crystal', 'Fuse', 'Battery'],
                'Connector_Generic': ['Conn_01x02', 'Conn_01x03', 'Conn_01x04', 'Conn_01x06', 'Conn_01x08'],
                'Connector_USB': ['USB_A', 'USB_B', 'USB_B_Micro', 'USB_C_Receptacle'],
                'Interface_UART': ['MAX232', 'MAX3232', 'CH340G', 'CP2102'],
                'Interface_CAN_LIN': ['MCP2515', 'MCP2551', 'SN65HVD230'],
                'Memory_EEPROM': ['24LC256', '24LC64', 'AT24C256'],
                'Memory_Flash': ['W25Q32JV', 'W25Q64JV', 'W25Q128JV'],
                'Sensor_Temperature': ['LM35', 'TMP36', 'DS18B20'],
                'Sensor_Humidity': ['DHT11', 'DHT22', 'SHT31'],
                'Sensor_Motion': ['MPU6050', 'MPU9250', 'ADXL345'],
                'Display_Character': ['HD44780'],
                'Driver_Motor': ['L293D', 'L298N', 'DRV8833', 'A4988', 'TMC2209']
            }
        };
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
        
        if (sexp[0] !== 'kicad_symbol_lib') {
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

            symbol.graphics.push({
                type: 'text',
                x: symbol.width + 1,
                y: -1,
                text: '${REF}',
                fontSize: 1.5,
                anchor: 'start',
                baseline: 'middle'
            });
            symbol.graphics.push({
                type: 'text',
                x: symbol.width + 1,
                y: 1.5,
                text: '${VALUE}',
                fontSize: 1.3,
                anchor: 'start',
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
            }
        }
        
        // If no graphics/pins were found, attempt to rebuild from nested units
        if ((symbol.pins.length === 0 && symbol.graphics.length === 0)) {
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
            
            // Add reference and value text (KiCad style - top right)
            symbol.graphics.push({
                type: 'text',
                x: symbol.width + 1,
                y: -1,
                text: '${REF}',
                fontSize: 1.5,
                anchor: 'start',
                baseline: 'middle'
            });
            symbol.graphics.push({
                type: 'text',
                x: symbol.width + 1,
                y: 1.5,
                text: '${VALUE}',
                fontSize: 1.3,
                anchor: 'start',
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

    _buildSymbolFromNestedUnits(symbolSexp) {
        if (!Array.isArray(symbolSexp)) return null;

        const symbol = {
            width: 20,
            height: 20,
            origin: { x: 10, y: 10 },
            graphics: [],
            pins: [],
            properties: {}
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

            symbol.graphics.push({
                type: 'text',
                x: symbol.width + 1,
                y: -1,
                text: '${REF}',
                fontSize: 1.5,
                anchor: 'start',
                baseline: 'middle'
            });
            symbol.graphics.push({
                type: 'text',
                x: symbol.width + 1,
                y: 1.5,
                text: '${VALUE}',
                fontSize: 1.3,
                anchor: 'start',
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
        const { cx, cy, r } = this._circleFromThreePoints(
            startX, startY, midX, midY, endX, endY
        );
        
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
     * Calculate circle from three points
     */
    _circleFromThreePoints(x1, y1, x2, y2, x3, y3) {
        const ax = x1, ay = y1;
        const bx = x2, by = y2;
        const cx = x3, cy = y3;
        
        const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
        
        if (Math.abs(d) < 0.0001) {
            // Points are collinear
            return { cx: x2, cy: y2, r: 1 };
        }
        
        const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
        const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
        
        const r = Math.sqrt((ax - ux) * (ax - ux) + (ay - uy) * (ay - uy));
        
        return { cx: ux, cy: uy, r: r };
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
        }
    }
}

export default KiCadFetcher;