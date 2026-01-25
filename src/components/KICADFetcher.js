/**
 * KiCadFetcher - Fetches and parses KiCad symbol and footprint libraries
 * 
 * KiCad libraries use an S-expression format and are hosted on GitLab.
 * Symbols: https://gitlab.com/kicad/libraries/kicad-symbols
 * Footprints: https://gitlab.com/kicad/libraries/kicad-footprints
 * 3D Models: https://gitlab.com/kicad/libraries/kicad-packages3D
 */

export class KiCadFetcher {
    constructor() {
        // GitLab raw file base URLs
        this.symbolsBase = 'https://gitlab.com/kicad/libraries/kicad-symbols/-/raw/master';
        this.footprintsBase = 'https://gitlab.com/kicad/libraries/kicad-footprints/-/raw/master';
        
        // CORS proxy options - corsproxy.io works better for GitLab
        this.corsProxies = [
            'https://corsproxy.io/?',
            'https://api.allorigins.win/raw?url='
        ];
        this.currentProxyIndex = 0;
        
        // Cache fetched data
        this.symbolCache = new Map();
        this.footprintCache = new Map();
        this.libraryIndex = null;
        this.fetchFailed = false;
    }
    
    get corsProxy() {
        return this.corsProxies[this.currentProxyIndex];
    }
    
    _tryNextProxy() {
        this.currentProxyIndex = (this.currentProxyIndex + 1) % this.corsProxies.length;
        console.log('Switching to KiCad proxy:', this.corsProxy);
    }
    
    /**
     * Search for a symbol by MPN or name
     * @param {string} query - Part number or name to search for
     * @returns {Promise<Array>} Matching symbols
     */
    async searchSymbols(query) {
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
        
        return results.slice(0, 50); // Limit results
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
            console.log('KiCadFetcher: Using cached symbol');
            return this.symbolCache.get(cacheKey);
        }
        
        try {
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
     * Fetch a library file from GitLab (with caching)
     */
    async _fetchLibraryFile(library) {
        // Check localStorage cache first
        const cacheKey = `kicad_lib_${library}`;
        const cached = localStorage.getItem(cacheKey);
        if (cached) {
            const parsed = JSON.parse(cached);
            // Cache for 24 hours
            if (Date.now() - parsed.timestamp < 24 * 60 * 60 * 1000) {
                console.log(`Using cached KiCad library: ${library}`);
                return parsed.content;
            }
        }
        
        const targetUrl = `${this.symbolsBase}/${library}.kicad_sym`;
        
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
                
                const response = await fetch(url);
                
                if (!response.ok) {
                    console.warn(`KiCad fetch failed with status ${response.status}, trying next proxy...`);
                    this._tryNextProxy();
                    continue;
                }
                
                const content = await response.text();
                console.log(`KiCad library ${library} fetched, size: ${content.length} bytes`);
                
                // Verify it looks like a KiCad file
                if (!content.includes('kicad_symbol_lib')) {
                    console.warn('Response does not look like a KiCad library file:', content.substring(0, 200));
                    this._tryNextProxy();
                    continue;
                }
                
                // Cache the result
                try {
                    localStorage.setItem(cacheKey, JSON.stringify({
                        content: content,
                        timestamp: Date.now()
                    }));
                    console.log(`Cached KiCad library: ${library}`);
                } catch (e) {
                    // localStorage might be full, ignore
                    console.warn('Could not cache library:', e.message);
                }
                
                return content;
                
            } catch (error) {
                console.error(`KiCad fetch error with proxy ${this.corsProxy}:`, error);
                this._tryNextProxy();
            }
        }
        
        throw new Error(`Failed to fetch KiCad library ${library} - all proxies failed`);
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
                'MCU_Espressif_ESP32': ['ESP32-WROOM-32', 'ESP32-WROVER'],
                'MCU_Espressif_ESP8266': ['ESP-12E', 'ESP-12F', 'ESP-01'],
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
                    return this._convertKiCadSymbol(item);
                }
                
                // Match without library prefix (e.g., "Timer:NE555" matches "NE555")
                if (upperName.endsWith(':' + searchName)) {
                    console.log('Found prefixed match:', cleanName);
                    return this._convertKiCadSymbol(item);
                }
                
                // Partial match (e.g., "NE555" matches "NE555P")
                if (upperName.startsWith(searchName) || upperName.includes(searchName)) {
                    console.log('Found partial match:', cleanName);
                    return this._convertKiCadSymbol(item);
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
            pins: []
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
                    // Skip properties for now (reference, value, footprint, etc.)
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
            shape: 'line'
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
                    break;
                case 'number':
                    pin.number = String(item[1] || '').replace(/^"|"$/g, '');
                    break;
            }
        }
        
        return pin;
    }
    
    /**
     * Parse KiCad rectangle
     * (rectangle (start x1 y1) (end x2 y2) (stroke ...) (fill ...))
     */
    _parseKiCadRectangle(rectSexp) {
        let x1 = 0, y1 = 0, x2 = 0, y2 = 0;
        let stroke = '#880000';
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
        let stroke = '#880000';
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
        let stroke = '#880000';
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
        let stroke = '#880000';
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
        let color = '#880000';
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