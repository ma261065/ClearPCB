/**
 * LCSCFetcher - Fetches component data from LCSC/EasyEDA
 * 
 * Uses the EasyEDA API to retrieve schematic symbols and PCB footprints
 * for components available on LCSC.
 * 
 * Note: This uses reverse-engineered API endpoints. The API may change.
 */

export class LCSCFetcher {
    constructor() {
        // EasyEDA API endpoints
        this.apiBase = 'https://easyeda.com/api/components';
        this.searchApi = 'https://easyeda.com/api/components/search';
        
        // CORS proxy for browser usage (you may need to set up your own)
        this.corsProxy = '';  // e.g., 'https://cors-anywhere.herokuapp.com/'
        
        // Cache fetched components
        this.cache = new Map();
    }
    
    /**
     * Fetch component by LCSC part number
     * @param {string} lcscId - LCSC part number (e.g., "C46749")
     * @returns {Promise<object>} ClearPCB component definition
     */
    async fetchComponent(lcscId) {
        // Check cache
        if (this.cache.has(lcscId)) {
            return this.cache.get(lcscId);
        }
        
        // Normalize ID
        const id = lcscId.toUpperCase().replace(/^C/, 'C');
        
        try {
            // Fetch from EasyEDA API
            const rawData = await this._fetchFromEasyEDA(id);
            
            // Convert to ClearPCB format
            const definition = this._convertToClearPCB(rawData, id);
            
            // Cache it
            this.cache.set(lcscId, definition);
            
            return definition;
        } catch (error) {
            console.error(`Failed to fetch component ${lcscId}:`, error);
            throw new Error(`Failed to fetch component ${lcscId}: ${error.message}`);
        }
    }
    
    /**
     * Fetch raw data from EasyEDA API
     */
    async _fetchFromEasyEDA(lcscId) {
        // Try the component UUID lookup first
        const searchUrl = `${this.corsProxy}https://easyeda.com/api/products/${lcscId}/components`;
        
        const response = await fetch(searchUrl, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
            }
        });
        
        if (!response.ok) {
            throw new Error(`API returned ${response.status}`);
        }
        
        const data = await response.json();
        
        if (!data.success && !data.result) {
            throw new Error('Component not found');
        }
        
        return data.result || data;
    }
    
    /**
     * Convert EasyEDA format to ClearPCB format
     */
    _convertToClearPCB(rawData, lcscId) {
        const definition = {
            name: rawData.title || lcscId,
            description: rawData.description || '',
            category: this._mapCategory(rawData.category),
            datasheet: rawData.datasheet || '',
            supplier_part_numbers: {
                lcsc: lcscId
            },
            manufacturer: rawData.manufacturer || '',
            mpn: rawData.mpn || '',  // Manufacturer part number
            symbol: null,
            footprint: null,
            keywords: []
        };
        
        // Parse symbol if present
        if (rawData.symbol || rawData.schematic) {
            definition.symbol = this._parseSymbol(rawData.symbol || rawData.schematic);
        }
        
        // Parse footprint if present
        if (rawData.footprint || rawData.package) {
            definition.footprint = this._parseFootprint(rawData.footprint || rawData.package);
        }
        
        return definition;
    }
    
    /**
     * Parse EasyEDA symbol format to ClearPCB symbol format
     * EasyEDA uses a tilde-delimited format for shapes
     */
    _parseSymbol(symbolData) {
        if (!symbolData) return null;
        
        // If it's a string, it's in EasyEDA's compressed format
        if (typeof symbolData === 'string') {
            return this._parseCompressedSymbol(symbolData);
        }
        
        // If it's already an object
        const symbol = {
            width: 10,
            height: 10,
            origin: { x: 5, y: 5 },
            graphics: [],
            pins: []
        };
        
        // Parse shapes array
        if (symbolData.shape) {
            for (const shapeStr of symbolData.shape) {
                const parsed = this._parseShapeString(shapeStr);
                if (parsed) {
                    if (parsed.type === 'pin') {
                        symbol.pins.push(parsed);
                    } else {
                        symbol.graphics.push(parsed);
                    }
                }
            }
        }
        
        // Calculate bounds
        this._calculateSymbolBounds(symbol);
        
        return symbol;
    }
    
    /**
     * Parse compressed symbol string
     * Format: shapes are separated by #@$, attributes by ~
     */
    _parseCompressedSymbol(str) {
        const symbol = {
            width: 10,
            height: 10,
            origin: { x: 5, y: 5 },
            graphics: [],
            pins: []
        };
        
        // Split by shape delimiter
        const shapes = str.split('#@$');
        
        for (const shapeStr of shapes) {
            if (!shapeStr.trim()) continue;
            
            const parsed = this._parseShapeString(shapeStr);
            if (parsed) {
                if (parsed.type === 'pin') {
                    symbol.pins.push(parsed);
                } else {
                    symbol.graphics.push(parsed);
                }
            }
        }
        
        this._calculateSymbolBounds(symbol);
        
        return symbol;
    }
    
    /**
     * Parse a single shape string from EasyEDA format
     * Format varies by shape type, separated by ~
     */
    _parseShapeString(str) {
        const parts = str.split('~');
        const type = parts[0];
        
        try {
            switch (type) {
                case 'P':  // Pin
                case 'PIN':
                    return this._parsePin(parts);
                    
                case 'R':  // Rectangle
                case 'RECT':
                    return this._parseRect(parts);
                    
                case 'E':  // Ellipse/Circle
                case 'ELLIPSE':
                    return this._parseEllipse(parts);
                    
                case 'PL':  // Polyline
                case 'POLYLINE':
                    return this._parsePolyline(parts);
                    
                case 'PG':  // Polygon
                case 'POLYGON':
                    return this._parsePolygon(parts);
                    
                case 'L':  // Line
                case 'LINE':
                    return this._parseLine(parts);
                    
                case 'A':  // Arc
                case 'ARC':
                    return this._parseArc(parts);
                    
                case 'PT':  // Path
                case 'PATH':
                    return this._parsePath(parts);
                    
                case 'T':  // Text
                case 'TEXT':
                    return this._parseText(parts);
                    
                default:
                    // console.log('Unknown shape type:', type, parts);
                    return null;
            }
        } catch (e) {
            console.warn('Failed to parse shape:', str, e);
            return null;
        }
    }
    
    /**
     * Parse pin: P~show~x~y~rotation~id~number~name~length~...
     */
    _parsePin(parts) {
        // EasyEDA pin format (varies by version)
        // Try to extract key info
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
        
        // Parse based on number of parts
        if (parts.length >= 8) {
            pin.x = this._toMM(parseFloat(parts[2]) || 0);
            pin.y = this._toMM(parseFloat(parts[3]) || 0);
            const rotation = parseFloat(parts[4]) || 0;
            pin.number = parts[6] || '';
            pin.name = parts[7] || '';
            pin.length = this._toMM(parseFloat(parts[8]) || 5);
            
            // Convert rotation to orientation
            pin.orientation = this._rotationToOrientation(rotation);
        }
        
        return pin;
    }
    
    /**
     * Parse rectangle: R~x~y~width~height~stroke~strokeWidth~fill~...
     */
    _parseRect(parts) {
        return {
            type: 'rect',
            x: this._toMM(parseFloat(parts[1]) || 0),
            y: this._toMM(parseFloat(parts[2]) || 0),
            width: this._toMM(parseFloat(parts[3]) || 0),
            height: this._toMM(parseFloat(parts[4]) || 0),
            stroke: parts[5] || '#000000',
            strokeWidth: this._toMM(parseFloat(parts[6]) || 1),
            fill: parts[7] || 'none'
        };
    }
    
    /**
     * Parse ellipse: E~cx~cy~rx~ry~stroke~strokeWidth~fill~...
     */
    _parseEllipse(parts) {
        const rx = this._toMM(parseFloat(parts[3]) || 0);
        const ry = this._toMM(parseFloat(parts[4]) || rx);
        
        if (Math.abs(rx - ry) < 0.01) {
            return {
                type: 'circle',
                cx: this._toMM(parseFloat(parts[1]) || 0),
                cy: this._toMM(parseFloat(parts[2]) || 0),
                r: rx,
                stroke: parts[5] || '#000000',
                strokeWidth: this._toMM(parseFloat(parts[6]) || 1),
                fill: parts[7] || 'none'
            };
        }
        
        return {
            type: 'ellipse',
            cx: this._toMM(parseFloat(parts[1]) || 0),
            cy: this._toMM(parseFloat(parts[2]) || 0),
            rx: rx,
            ry: ry,
            stroke: parts[5] || '#000000',
            strokeWidth: this._toMM(parseFloat(parts[6]) || 1),
            fill: parts[7] || 'none'
        };
    }
    
    /**
     * Parse polyline: PL~points~stroke~strokeWidth~fill~...
     */
    _parsePolyline(parts) {
        const pointsStr = parts[1] || '';
        const points = this._parsePoints(pointsStr);
        
        return {
            type: 'polyline',
            points: points,
            stroke: parts[2] || '#000000',
            strokeWidth: this._toMM(parseFloat(parts[3]) || 1),
            fill: parts[4] || 'none'
        };
    }
    
    /**
     * Parse polygon: PG~points~stroke~strokeWidth~fill~...
     */
    _parsePolygon(parts) {
        const pointsStr = parts[1] || '';
        const points = this._parsePoints(pointsStr);
        
        return {
            type: 'polygon',
            points: points,
            stroke: parts[2] || '#000000',
            strokeWidth: this._toMM(parseFloat(parts[3]) || 1),
            fill: parts[4] || '#000000'
        };
    }
    
    /**
     * Parse line: L~x1~y1~x2~y2~stroke~strokeWidth~...
     */
    _parseLine(parts) {
        return {
            type: 'line',
            x1: this._toMM(parseFloat(parts[1]) || 0),
            y1: this._toMM(parseFloat(parts[2]) || 0),
            x2: this._toMM(parseFloat(parts[3]) || 0),
            y2: this._toMM(parseFloat(parts[4]) || 0),
            stroke: parts[5] || '#000000',
            strokeWidth: this._toMM(parseFloat(parts[6]) || 1)
        };
    }
    
    /**
     * Parse arc: A~pathData~stroke~strokeWidth~fill~...
     */
    _parseArc(parts) {
        return {
            type: 'path',
            d: parts[1] || '',
            stroke: parts[2] || '#000000',
            strokeWidth: this._toMM(parseFloat(parts[3]) || 1),
            fill: parts[4] || 'none'
        };
    }
    
    /**
     * Parse path: PT~pathData~stroke~strokeWidth~fill~...
     */
    _parsePath(parts) {
        return {
            type: 'path',
            d: parts[1] || '',
            stroke: parts[2] || '#000000',
            strokeWidth: this._toMM(parseFloat(parts[3]) || 1),
            fill: parts[4] || 'none'
        };
    }
    
    /**
     * Parse text: T~text~x~y~rotation~fontSize~...
     */
    _parseText(parts) {
        return {
            type: 'text',
            text: parts[1] || '',
            x: this._toMM(parseFloat(parts[2]) || 0),
            y: this._toMM(parseFloat(parts[3]) || 0),
            rotation: parseFloat(parts[4]) || 0,
            fontSize: this._toMM(parseFloat(parts[5]) || 10),
            anchor: 'start',
            color: parts[8] || '#000000'
        };
    }
    
    /**
     * Parse points string "x1,y1 x2,y2 ..." to array
     */
    _parsePoints(str) {
        const points = [];
        const pairs = str.split(' ');
        
        for (const pair of pairs) {
            const [x, y] = pair.split(',').map(v => this._toMM(parseFloat(v) || 0));
            if (!isNaN(x) && !isNaN(y)) {
                points.push([x, y]);
            }
        }
        
        return points;
    }
    
    /**
     * Convert EasyEDA units (10x mils) to mm
     */
    _toMM(value) {
        // EasyEDA uses 10x mils internally
        // 1 mil = 0.0254 mm
        // 10x mil = 0.254 mm per unit
        return value * 0.254;
    }
    
    /**
     * Convert rotation angle to orientation string
     */
    _rotationToOrientation(rotation) {
        const normalized = ((rotation % 360) + 360) % 360;
        if (normalized >= 315 || normalized < 45) return 'right';
        if (normalized >= 45 && normalized < 135) return 'down';
        if (normalized >= 135 && normalized < 225) return 'left';
        return 'up';
    }
    
    /**
     * Calculate symbol bounds and set origin
     */
    _calculateSymbolBounds(symbol) {
        let minX = Infinity, minY = Infinity;
        let maxX = -Infinity, maxY = -Infinity;
        
        const updateBounds = (x, y) => {
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
        };
        
        for (const g of symbol.graphics) {
            switch (g.type) {
                case 'rect':
                    updateBounds(g.x, g.y);
                    updateBounds(g.x + g.width, g.y + g.height);
                    break;
                case 'circle':
                    updateBounds(g.cx - g.r, g.cy - g.r);
                    updateBounds(g.cx + g.r, g.cy + g.r);
                    break;
                case 'ellipse':
                    updateBounds(g.cx - g.rx, g.cy - g.ry);
                    updateBounds(g.cx + g.rx, g.cy + g.ry);
                    break;
                case 'line':
                    updateBounds(g.x1, g.y1);
                    updateBounds(g.x2, g.y2);
                    break;
                case 'polyline':
                case 'polygon':
                    for (const [x, y] of g.points) {
                        updateBounds(x, y);
                    }
                    break;
            }
        }
        
        for (const p of symbol.pins) {
            updateBounds(p.x, p.y);
        }
        
        if (minX !== Infinity) {
            symbol.width = maxX - minX;
            symbol.height = maxY - minY;
            symbol.origin = {
                x: (maxX + minX) / 2,
                y: (maxY + minY) / 2
            };
        }
    }
    
    /**
     * Parse EasyEDA footprint to ClearPCB format
     */
    _parseFootprint(footprintData) {
        if (!footprintData) return null;
        
        const footprint = {
            width: 10,
            height: 10,
            origin: { x: 5, y: 5 },
            pads: [],
            graphics: []
        };
        
        // Similar parsing logic for footprint shapes
        if (typeof footprintData === 'string') {
            const shapes = footprintData.split('#@$');
            for (const shapeStr of shapes) {
                const parsed = this._parseFootprintShape(shapeStr);
                if (parsed) {
                    if (parsed.type === 'pad') {
                        footprint.pads.push(parsed);
                    } else {
                        footprint.graphics.push(parsed);
                    }
                }
            }
        }
        
        return footprint;
    }
    
    /**
     * Parse footprint shape string
     */
    _parseFootprintShape(str) {
        const parts = str.split('~');
        const type = parts[0];
        
        try {
            switch (type) {
                case 'PAD':
                    return this._parsePad(parts);
                case 'TRACK':
                    return this._parseTrack(parts);
                case 'CIRCLE':
                    return this._parseFootprintCircle(parts);
                case 'ARC':
                    return this._parseFootprintArc(parts);
                case 'RECT':
                    return this._parseFootprintRect(parts);
                case 'TEXT':
                    return this._parseFootprintText(parts);
                default:
                    return null;
            }
        } catch (e) {
            return null;
        }
    }
    
    /**
     * Parse pad: PAD~shape~x~y~width~height~drill~number~...
     */
    _parsePad(parts) {
        return {
            type: 'pad',
            number: parts[7] || '',
            shape: (parts[1] || 'rect').toLowerCase(),
            x: this._toMM(parseFloat(parts[2]) || 0),
            y: this._toMM(parseFloat(parts[3]) || 0),
            width: this._toMM(parseFloat(parts[4]) || 0),
            height: this._toMM(parseFloat(parts[5]) || 0),
            drill: parts[6] ? this._toMM(parseFloat(parts[6])) : null,
            layers: ['F.Cu', 'F.Paste', 'F.Mask'],
            padType: parts[6] ? 'th' : 'smd'
        };
    }
    
    /**
     * Parse track (silkscreen line)
     */
    _parseTrack(parts) {
        const pointsStr = parts[4] || '';
        const coords = pointsStr.split(' ').map(v => this._toMM(parseFloat(v) || 0));
        
        if (coords.length >= 4) {
            return {
                type: 'line',
                x1: coords[0],
                y1: coords[1],
                x2: coords[2],
                y2: coords[3],
                layer: parts[2] || 'F.SilkS',
                stroke: this._toMM(parseFloat(parts[1]) || 1)
            };
        }
        return null;
    }
    
    _parseFootprintCircle(parts) {
        return {
            type: 'circle',
            cx: this._toMM(parseFloat(parts[1]) || 0),
            cy: this._toMM(parseFloat(parts[2]) || 0),
            r: this._toMM(parseFloat(parts[3]) || 0),
            layer: parts[5] || 'F.SilkS',
            stroke: this._toMM(parseFloat(parts[4]) || 0.15)
        };
    }
    
    _parseFootprintArc(parts) {
        return {
            type: 'arc',
            d: parts[1] || '',
            layer: parts[3] || 'F.SilkS',
            stroke: this._toMM(parseFloat(parts[2]) || 0.15)
        };
    }
    
    _parseFootprintRect(parts) {
        return {
            type: 'rect',
            x: this._toMM(parseFloat(parts[1]) || 0),
            y: this._toMM(parseFloat(parts[2]) || 0),
            width: this._toMM(parseFloat(parts[3]) || 0),
            height: this._toMM(parseFloat(parts[4]) || 0),
            layer: parts[6] || 'F.SilkS',
            stroke: this._toMM(parseFloat(parts[5]) || 0.15)
        };
    }
    
    _parseFootprintText(parts) {
        return {
            type: 'text',
            text: parts[1] || '',
            x: this._toMM(parseFloat(parts[2]) || 0),
            y: this._toMM(parseFloat(parts[3]) || 0),
            layer: parts[7] || 'F.SilkS',
            fontSize: this._toMM(parseFloat(parts[5]) || 10)
        };
    }
    
    /**
     * Map EasyEDA category to ClearPCB category
     */
    _mapCategory(category) {
        const mapping = {
            'Resistors': 'Passive Components',
            'Capacitors': 'Passive Components',
            'Inductors': 'Passive Components',
            'Diodes': 'Discrete Semiconductors',
            'Transistors': 'Discrete Semiconductors',
            'LEDs': 'Optoelectronics',
            'ICs': 'Integrated Circuits',
            'Connectors': 'Connectors',
            'Crystals': 'Frequency Control',
            'Switches': 'Electromechanical',
            'Relays': 'Electromechanical'
        };
        
        return mapping[category] || category || 'Uncategorized';
    }
    
    /**
     * Search LCSC for components
     */
    async search(query) {
        // This would require the LCSC search API
        // For now, return empty - real implementation would query LCSC
        console.log('LCSC search not implemented - query:', query);
        return [];
    }
}

export default LCSCFetcher;