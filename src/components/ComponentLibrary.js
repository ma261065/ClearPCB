/**
 * ComponentLibrary - Manages component definitions
 * 
 * Provides:
 * - Built-in component library
 * - User component library (localStorage)
 * - LCSC component search and metadata
 * - KiCad symbol/footprint fetching
 * 
 * Architecture:
 * - LCSC provides: pricing, stock, MPN, category, etc.
 * - KiCad provides: schematic symbols, footprints
 * - Components are matched by MPN (Manufacturer Part Number)
 */

import { Component } from './Component.js';
import { BuiltInComponents } from './BuiltInComponents.js';
import { LCSCFetcher } from './LCSCFetcher.js';
import { KiCadFetcher } from './KICADFetcher.js';
import { storageManager } from '../core/StorageManager.js';

export class ComponentLibrary {
    constructor() {
        // Component definitions by name
        this.definitions = new Map();
        
        // Categories for organization
        this.categories = new Map();
        
        // LCSC fetcher (metadata, pricing, stock)
        this.lcscFetcher = new LCSCFetcher();

        // EasyEDA symbol parser version (used to invalidate cached symbols)
        this._easyedaSymbolParserVersion = '2026-02-05-2';
        
        // KiCad fetcher (symbols, footprints)
        this.kicadFetcher = new KiCadFetcher();
        
        // Load built-in components
        this._loadBuiltInComponents();
        
        // Load user components from localStorage
        this._loadUserComponents();
    }
    
    /**
     * Load built-in components
     */
    _loadBuiltInComponents() {
        for (const def of BuiltInComponents) {
            this.addDefinition(def, 'Built-in');
        }
    }
    
    /**
     * Load user-defined components from localStorage
     */
    _loadUserComponents() {
        try {
            const components = storageManager.get('clearpcb_user_components');
            if (components && Array.isArray(components)) {
                for (const def of components) {
                    this.addDefinition(def, 'User');
                }
            }
        } catch (e) {
            console.warn('Failed to load user components:', e);
        }
    }
    
    /**
     * Save user components to localStorage
     */
    _saveUserComponents() {
        try {
            const userComponents = [];
            for (const [name, def] of this.definitions) {
                if (def._source === 'User') {
                    userComponents.push(def);
                }
            }
            storageManager.set('clearpcb_user_components', userComponents);
        } catch (e) {
            console.warn('Failed to save user components:', e);
        }
    }
    
    /**
     * Add a component definition to the library
     */
    addDefinition(definition, source = 'User') {
        // Validate definition
        if (!definition.name) {
            throw new Error('Component definition must have a name');
        }
        
        // Mark source
        definition._source = source;
        
        // Add to definitions
        this.definitions.set(definition.name, definition);
        
        // Add to category
        const category = definition.category || 'Uncategorized';
        if (!this.categories.has(category)) {
            this.categories.set(category, []);
        }
        this.categories.get(category).push(definition.name);
        
        // Save if user component
        if (source === 'User') {
            this._saveUserComponents();
        }
        
        return definition;
    }
    
    /**
     * Get a component definition by name
     */
    getDefinition(name) {
        return this.definitions.get(name) || null;
    }
    
    /**
     * Get all definitions in a category
     */
    getByCategory(category) {
        const names = this.categories.get(category) || [];
        return names.map(name => this.definitions.get(name)).filter(Boolean);
    }
    
    /**
     * Get all category names
     */
    getCategoryNames() {
        return Array.from(this.categories.keys()).sort();
    }
    
    /**
     * Get all component definitions
     */
    getAllDefinitions() {
        return Array.from(this.definitions.values());
    }
    
    /**
     * Search local library
     */
    searchLocal(query) {
        const lowerQuery = query.toLowerCase();
        const results = [];
        
        for (const def of this.definitions.values()) {
            const matchName = def.name.toLowerCase().includes(lowerQuery);
            const matchDesc = (def.description || '').toLowerCase().includes(lowerQuery);
            const matchKeywords = (def.keywords || []).some(k => 
                k.toLowerCase().includes(lowerQuery)
            );
            
            if (matchName || matchDesc || matchKeywords) {
                results.push(def);
            }
        }
        
        return results;
    }
    
    /**
     * Remove a definition from the library
     */
    removeDefinition(name) {
        const def = this.definitions.get(name);
        if (!def) return false;
        
        // Can't remove built-in components
        if (def._source === 'Built-in') {
            throw new Error('Cannot remove built-in components');
        }
        
        // Remove from definitions
        this.definitions.delete(name);
        
        // Remove from category
        const category = def.category || 'Uncategorized';
        const catList = this.categories.get(category);
        if (catList) {
            const idx = catList.indexOf(name);
            if (idx >= 0) catList.splice(idx, 1);
        }
        
        // Save
        this._saveUserComponents();
        
        return true;
    }
    
    /**
     * Create a component instance from a definition
     */
    createComponent(definitionName, options = {}) {
        const def = this.getDefinition(definitionName);
        if (!def) {
            throw new Error(`Component definition not found: ${definitionName}`);
        }
        return new Component(def, options);
    }
    
    /**
     * Search LCSC for components (metadata only)
     * @param {string} query - Search query
     * @returns {Promise<Array>} Search results with pricing/stock info
     */
    async searchLCSC(query) {
        return this.lcscFetcher.search(query);
    }
    
    /**
     * Fetch a complete component from LCSC + KiCad
     * @param {string} lcscId - LCSC part number (e.g., "C46749")
     * @returns {Promise<object>} Component definition with symbol and metadata
     */
    async fetchFromLCSC(lcscId) {
        // Check if already cached
        const cached = this.definitions.get(`LCSC_${lcscId}`);
        if (cached) {
            const needsEasyeda = !cached.symbol
                || cached.symbol._source !== 'EasyEDA'
                || cached._easyedaParserVersion !== this._easyedaSymbolParserVersion;
            const needsFootprint = !cached.hasFootprint;
            if (!needsEasyeda && !needsFootprint) {
                return cached;
            }
        }
        
        // Step 1: Get LCSC metadata
        console.log(`Fetching LCSC metadata for ${lcscId}...`);
        const metadata = await this.lcscFetcher.fetchComponentMetadata(lcscId);
        
        if (!metadata) {
            throw new Error(`Component ${lcscId} not found on LCSC`);
        }
        
        console.log('LCSC metadata:', metadata);
        
        // Step 2: Try to use EasyEDA symbol if available
        let symbol = null;

        if (metadata.easyedaSymbolData) {
            const easyedaSymbol = this._createEasyEDASymbol(metadata.easyedaSymbolData);
            if (easyedaSymbol) {
                symbol = easyedaSymbol;
                symbol._source = 'EasyEDA';
                console.log('EasyEDA symbol found:', symbol);
            }
        }

        // Step 2b: No KiCad fallback. Keep LCSC/EasyEDA symbols separate.
        
        // Step 3: Fall back to generic symbol if no KiCad match
        if (!symbol) {
            console.log('Using generic symbol');
            symbol = this._createGenericSymbol(metadata);
        }
        
        // Step 4: Create component definition
        const definition = {
            name: `LCSC_${lcscId}`,
            description: metadata.description,
            category: metadata.category || 'LCSC',
            datasheet: metadata.datasheet,
            symbol: symbol,
            // LCSC-specific metadata
            supplier_part_numbers: {
                LCSC: lcscId
            },
            mpn: metadata.mpn,
            manufacturer: metadata.manufacturer,
            package: metadata.package,
            footprintName: metadata.footprintName || metadata.package || '',
            footprintShapes: metadata.footprintShapes || null,
            footprintBBox: metadata.footprintBBox || null,
            hasFootprint: !!metadata.hasFootprint,
            model3dName: metadata.model3dName || '',
            has3d: !!metadata.has3d,
            stock: metadata.stock,
            price: metadata.price,
            priceBreaks: metadata.priceBreaks,
            isBasic: metadata.isBasic,
            productUrl: metadata.productUrl,
            imageUrl: metadata.imageUrl,
            _source: 'LCSC',
            _easyedaResolved: symbol?._source === 'EasyEDA',
            _easyedaParserVersion: symbol?._source === 'EasyEDA'
                ? this._easyedaSymbolParserVersion
                : undefined
        };
        
        // Add to library
        this.addDefinition(definition, 'LCSC');
        
        return definition;
    }
    
    /**
     * Create a generic symbol when no KiCad match is found
     */
    _createGenericSymbol(metadata) {
        const category = (metadata.category || '').toLowerCase();
        const pinCount = this._estimatePinCount(metadata);
        
        // Use different generic symbols based on category
        if (category.includes('resistor')) {
            return this._createResistorSymbol();
        } else if (category.includes('capacitor')) {
            return this._createCapacitorSymbol();
        } else if (category.includes('inductor')) {
            return this._createInductorSymbol();
        } else if (category.includes('diode')) {
            return this._createDiodeSymbol();
        } else if (category.includes('led')) {
            return this._createLEDSymbol();
        } else if (category.includes('transistor')) {
            return this._createTransistorSymbol();
        } else if (category.includes('switch') || category.includes('button')) {
            if (pinCount === 3) {
                return this._createSwitch3PinSymbol();
            }
        }
        
        // Default: generic IC/box symbol
        if (pinCount > 0 && pinCount <= 4) {
            return this._createGenericInlineSymbol(pinCount);
        }

        return this._createGenericICSymbol({ ...metadata, pinCount });
    }


    _createEasyEDASymbol(dataStr) {
        if (!dataStr || !Array.isArray(dataStr.shape)) {
            return null;
        }

        const scale = 0.254;
        const bbox = dataStr.BBox || dataStr.bbox || null;
        const hasBBox = bbox && Number.isFinite(bbox.x) && Number.isFinite(bbox.y) && Number.isFinite(bbox.width) && Number.isFinite(bbox.height);

        const rawGraphics = [];
        const rawPins = [];

        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;

        const includePoint = (x, y) => {
            if (!Number.isFinite(x) || !Number.isFinite(y)) return;
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
        };

        const includePin = (pin) => {
            includePoint(pin.x, pin.y);
            const length = Number.isFinite(pin.length) ? pin.length : 0;
            switch (pin.orientation) {
                case 'right':
                    includePoint(pin.x + length, pin.y);
                    break;
                case 'left':
                    includePoint(pin.x - length, pin.y);
                    break;
                case 'up':
                    includePoint(pin.x, pin.y - length);
                    break;
                case 'down':
                    includePoint(pin.x, pin.y + length);
                    break;
                default:
                    includePoint(pin.x + length, pin.y);
            }
        };

        for (const shape of dataStr.shape) {
            if (typeof shape !== 'string' || !shape.length) continue;
            if (/^(P|PIN)~/i.test(shape)) {
                const pin = this._parseEasyEDAPin(shape);
                if (pin) {
                    rawPins.push(pin);
                    includePin(pin);
                }
                continue;
            }

            const graphic = this._parseEasyEDAGraphic(shape);
            if (!graphic) continue;

            rawGraphics.push(graphic);

            switch (graphic.type) {
                case 'line':
                    includePoint(graphic.x1, graphic.y1);
                    includePoint(graphic.x2, graphic.y2);
                    break;
                case 'rect':
                    includePoint(graphic.x, graphic.y);
                    includePoint(graphic.x + graphic.width, graphic.y + graphic.height);
                    break;
                case 'circle':
                    includePoint(graphic.cx - graphic.r, graphic.cy - graphic.r);
                    includePoint(graphic.cx + graphic.r, graphic.cy + graphic.r);
                    break;
                case 'polyline':
                case 'polygon':
                    for (const p of graphic.points || []) {
                        includePoint(p[0], p[1]);
                    }
                    break;
                case 'arc':
                    includePoint(graphic.cx - graphic.r, graphic.cy - graphic.r);
                    includePoint(graphic.cx + graphic.r, graphic.cy + graphic.r);
                    break;
            }
        }

        if (hasBBox) {
            minX = bbox.x;
            minY = bbox.y;
            maxX = bbox.x + bbox.width;
            maxY = bbox.y + bbox.height;
        }

        const widthRaw = maxX - minX;
        const heightRaw = maxY - minY;
        const hasOutline = rawGraphics.some(graphic => graphic.type === 'rect'
            && graphic.width >= widthRaw * 0.5
            && graphic.height >= heightRaw * 0.5);

        if (!hasOutline && rawGraphics.length === 0 && Number.isFinite(widthRaw) && Number.isFinite(heightRaw)) {
            rawGraphics.push({
                type: 'rect',
                x: minX,
                y: minY,
                width: widthRaw,
                height: heightRaw,
                stroke: '#880000',
                strokeWidth: 1,
                fill: 'none'
            });
        }

        if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
            return null;
        }

        const offsetX = minX;
        const offsetY = minY;

        const graphics = rawGraphics.map(graphic => this._transformEasyEDAGraphic(graphic, offsetX, offsetY, scale));
        const pins = rawPins.map(pin => this._transformEasyEDAPin(pin, offsetX, offsetY, scale));

        const width = widthRaw * scale;
        const height = heightRaw * scale;

        graphics.push({
            type: 'text',
            x: width + 1,
            y: -1,
            text: '${REF}',
            fontSize: 1.5,
            anchor: 'start',
            baseline: 'middle'
        });
        graphics.push({
            type: 'text',
            x: width + 1,
            y: 1.5,
            text: '${VALUE}',
            fontSize: 1.3,
            anchor: 'start',
            baseline: 'middle'
        });

        return {
            width,
            height,
            origin: { x: width / 2, y: height / 2 },
            graphics,
            pins,
            _easyedaRawShapes: Array.isArray(dataStr.shape) ? [...dataStr.shape] : []
        };
    }

    _parseEasyEDAGraphic(shape) {
        const parts = shape.split('~');
        const type = parts[0];
        const colorIndex = parts.findIndex(part => typeof part === 'string' && part.startsWith('#'));
        const strokeColor = colorIndex >= 0 ? parts[colorIndex] : '#880000';
        const strokeWidthIndex = colorIndex >= 0 ? colorIndex + 1 : -1;
        const parsedStrokeWidth = Number(parts[strokeWidthIndex]);
        const strokeWidthValue = Number.isFinite(parsedStrokeWidth) ? parsedStrokeWidth : 1;

        switch (type) {
            case 'PL': {
                const coords = (parts[1] || '').trim().split(/\s+/).map(Number);
                if (coords.length < 4) return null;
                const points = [];
                for (let i = 0; i < coords.length - 1; i += 2) {
                    points.push([coords[i], coords[i + 1]]);
                }
                return {
                    type: 'polyline',
                    points,
                    stroke: strokeColor,
                    strokeWidth: strokeWidthValue,
                    fill: 'none'
                };
            }
            case 'PG': {
                const coords = (parts[1] || '').trim().split(/\s+/).map(Number);
                if (coords.length < 6) return null;
                const points = [];
                for (let i = 0; i < coords.length - 1; i += 2) {
                    points.push([coords[i], coords[i + 1]]);
                }
                const fillColor = (parts[5] || '').trim();
                return {
                    type: 'polygon',
                    points,
                    stroke: strokeColor,
                    strokeWidth: strokeWidthValue,
                    fill: fillColor || 'none'
                };
            }
            case 'L': {
                const x1 = Number(parts[1]);
                const y1 = Number(parts[2]);
                const x2 = Number(parts[3]);
                const y2 = Number(parts[4]);
                if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
                return {
                    type: 'line',
                    x1,
                    y1,
                    x2,
                    y2,
                    stroke: strokeColor,
                    strokeWidth: strokeWidthValue
                };
            }
            case 'R': {
                const x = Number(parts[1]);
                const y = Number(parts[2]);
                const w1 = Number(parts[3]);
                const h1 = Number(parts[4]);
                const w2 = Number(parts[5]);
                const h2 = Number(parts[6]);
                const width = Number.isFinite(w2) ? w2 : w1;
                const height = Number.isFinite(h2) ? h2 : h1;
                const rx = Number.isFinite(w2) ? w1 : 0;
                const ry = Number.isFinite(h2) ? h1 : 0;
                if (![x, y, width, height].every(Number.isFinite)) return null;
                return {
                    type: 'rect',
                    x,
                    y,
                    width,
                    height,
                    rx,
                    ry,
                    stroke: strokeColor,
                    strokeWidth: strokeWidthValue,
                    fill: 'none'
                };
            }
            case 'C': {
                const cx = Number(parts[1]);
                const cy = Number(parts[2]);
                const r = Number(parts[3]);
                if (![cx, cy, r].every(Number.isFinite)) return null;
                return {
                    type: 'circle',
                    cx,
                    cy,
                    r,
                    stroke: strokeColor,
                    strokeWidth: strokeWidthValue,
                    fill: 'none'
                };
            }
            case 'PT': {
                const d = (parts[1] || '').trim();
                if (!d) return null;
                const fillColor = (parts[5] || '').trim();
                return {
                    type: 'path',
                    d,
                    stroke: strokeColor,
                    strokeWidth: strokeWidthValue,
                    fill: fillColor || 'none'
                };
            }
            case 'E': {
                const cx = Number(parts[1]);
                const cy = Number(parts[2]);
                const rx = Number(parts[3]);
                const ry = Number(parts[4]);
                if (![cx, cy, rx, ry].every(Number.isFinite)) return null;
                return {
                    type: 'circle',
                    cx,
                    cy,
                    r: Math.max(rx, ry),
                    stroke: strokeColor,
                    strokeWidth: strokeWidthValue,
                    fill: 'none'
                };
            }
            default:
                return null;
        }
    }

    _parseEasyEDAPin(shape) {
        const segments = shape.split('^^');
        const header = segments[0].split('~');

        const headerNumber = String(header[3] || '').trim();
        let x = Number(header[4]);
        let y = Number(header[5]);
        let angle = Number(header[6]);
        const headerId = typeof header[7] === 'string' ? header[7].trim() : '';

        // Fallback for shorter/variant headers (e.g., PIN~...)
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            const numeric = header.map(part => Number(part)).filter(Number.isFinite);
            if (numeric.length >= 2) {
                x = numeric[0];
                y = numeric[1];
                angle = Number.isFinite(numeric[2]) ? numeric[2] : angle;
            }
        }

        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

        let orientation = this._easyedaAngleToOrientation(angle);
        let length = null;

        const pathSegment = segments.find(seg => {
            if (typeof seg !== 'string') return false;
            const trimmed = seg.trim();
            return /^M\s*/i.test(trimmed);
        });
        if (pathSegment) {
            const path = pathSegment.split('~')[0].trim();
            const parsed = this._parseEasyEDAPinPath(path);
            if (parsed) {
                orientation = parsed.orientation;
                length = parsed.length;
            }
        }

        let name = '';
        let number = headerNumber;
        let namePos = null;
        let numberPos = null;
        const labelEntries = [];
        for (const segment of segments.slice(1)) {
            if (typeof segment !== 'string' || !segment.includes('~')) continue;
            const parts = segment.split('~');
            if (parts.length < 5) continue;
            const visibleFlag = Number(parts[0]);
            if (Number.isFinite(visibleFlag) && visibleFlag === 0) continue;
            const text = String(parts[4] || '').trim();
            if (!text) continue;
            const labelX = Number(parts[1]);
            const labelY = Number(parts[2]);
            const labelRot = Number(parts[3]);
            const labelAnchor = String(parts[5] || '').trim();
            const labelFontFamily = String(parts[6] || '').trim() || null;
            let labelFontSize = null;
            const fontToken = String(parts[7] || '').trim();
            if (fontToken) {
                const parsed = parseFloat(fontToken.replace(/pt$/i, ''));
                if (Number.isFinite(parsed)) {
                    labelFontSize = parsed;
                }
            }
            if (!Number.isFinite(labelFontSize)) {
                labelFontSize = 7;
            }
            const pos = (Number.isFinite(labelX) && Number.isFinite(labelY))
                ? {
                    x: labelX,
                    y: labelY,
                    rotation: Number.isFinite(labelRot) ? labelRot : 0,
                    anchor: (labelAnchor === 'start' || labelAnchor === 'end' || labelAnchor === 'middle')
                        ? labelAnchor
                        : undefined,
                    fontFamily: labelFontFamily,
                    fontSize: labelFontSize
                }
                : null;
            if (pos) {
                labelEntries.push({ text, pos });
            }
            // Preserve first encountered non-empty text as name, but positions are assigned by order below
            if (!name && text) {
                name = text;
            }
            if (!number && /^\d+$/.test(text)) {
                number = text;
            }
        }

        if (labelEntries.length > 0) {
            namePos = labelEntries[0].pos;
            if (!name) {
                name = labelEntries[0].text;
            }
        }

        if (labelEntries.length > 1) {
            numberPos = labelEntries[1].pos;
            if (!number && /^\d+$/.test(labelEntries[1].text)) {
                number = labelEntries[1].text;
            }
        }

        return {
            _id: headerId || null,
            _key: headerId || headerNumber || `${x},${y}`,
            number: number || '',
            name: name || number || '',
            x,
            y,
            orientation,
            length,
            type: 'passive',
            shape: 'line',
            namePos,
            numberPos
        };
    }

    _parseEasyEDAPinPath(path) {
        const hMatch = path.match(/M\s*(-?\d+(?:\.\d+)?)\s*[ ,]\s*(-?\d+(?:\.\d+)?)\s*h\s*(-?\d+(?:\.\d+)?)/i);
        if (hMatch) {
            const dx = Number(hMatch[3]);
            return {
                orientation: dx >= 0 ? 'right' : 'left',
                length: Math.abs(dx)
            };
        }

        const vMatch = path.match(/M\s*(-?\d+(?:\.\d+)?)\s*[ ,]\s*(-?\d+(?:\.\d+)?)\s*v\s*(-?\d+(?:\.\d+)?)/i);
        if (vMatch) {
            const dy = Number(vMatch[3]);
            return {
                orientation: dy >= 0 ? 'down' : 'up',
                length: Math.abs(dy)
            };
        }

        const lMatch = path.match(/M\s*(-?\d+(?:\.\d+)?)\s*[ ,]\s*(-?\d+(?:\.\d+)?)\s*L\s*(-?\d+(?:\.\d+)?)\s*[ ,]\s*(-?\d+(?:\.\d+)?)/i);
        if (lMatch) {
            const x1 = Number(lMatch[1]);
            const y1 = Number(lMatch[2]);
            const x2 = Number(lMatch[3]);
            const y2 = Number(lMatch[4]);
            const dx = x2 - x1;
            const dy = y2 - y1;
            const length = Math.hypot(dx, dy);
            if (Math.abs(dx) >= Math.abs(dy)) {
                return {
                    orientation: dx >= 0 ? 'right' : 'left',
                    length
                };
            }
            return {
                orientation: dy >= 0 ? 'down' : 'up',
                length
            };
        }

        return null;
    }

    _easyedaAngleToOrientation(angle) {
        const normalized = ((Number(angle) % 360) + 360) % 360;
        if (normalized === 0) return 'left';
        if (normalized === 90) return 'down';
        if (normalized === 180) return 'right';
        if (normalized === 270) return 'up';
        return 'right';
    }

    _transformEasyEDAGraphic(graphic, offsetX, offsetY, scale) {
        const strokeWidth = Number.isFinite(graphic.strokeWidth) ? graphic.strokeWidth * scale : 0.254;

        switch (graphic.type) {
            case 'line':
                return {
                    ...graphic,
                    x1: (graphic.x1 - offsetX) * scale,
                    y1: (graphic.y1 - offsetY) * scale,
                    x2: (graphic.x2 - offsetX) * scale,
                    y2: (graphic.y2 - offsetY) * scale,
                    strokeWidth
                };
            case 'rect':
                return {
                    ...graphic,
                    x: (graphic.x - offsetX) * scale,
                    y: (graphic.y - offsetY) * scale,
                    width: graphic.width * scale,
                    height: graphic.height * scale,
                    rx: Number.isFinite(graphic.rx) ? graphic.rx * scale * 0.5 : undefined,
                    ry: Number.isFinite(graphic.ry) ? graphic.ry * scale * 0.5 : undefined,
                    strokeWidth
                };
            case 'circle':
                return {
                    ...graphic,
                    cx: (graphic.cx - offsetX) * scale,
                    cy: (graphic.cy - offsetY) * scale,
                    r: graphic.r * scale,
                    strokeWidth
                };
            case 'polyline':
            case 'polygon':
                return {
                    ...graphic,
                    points: (graphic.points || []).map(p => [
                        (p[0] - offsetX) * scale,
                        (p[1] - offsetY) * scale
                    ]),
                    strokeWidth
                };
            case 'arc':
                return {
                    ...graphic,
                    cx: (graphic.cx - offsetX) * scale,
                    cy: (graphic.cy - offsetY) * scale,
                    r: graphic.r * scale,
                    strokeWidth
                };
            case 'path':
                return {
                    ...graphic,
                    transform: `translate(${(-offsetX) * scale},${(-offsetY) * scale}) scale(${scale})`,
                    strokeWidth: graphic.strokeWidth
                };
            default:
                return graphic;
        }
    }

    _transformEasyEDAPin(pin, offsetX, offsetY, scale) {
        const scaleFont = (pos) => {
            if (!pos) return null;
            const fontSize = Number.isFinite(pos.fontSize)
                ? pos.fontSize * scale
                : null;
            return {
                ...pos,
                x: (pos.x - offsetX) * scale,
                y: (pos.y - offsetY) * scale,
                fontSize
            };
        };
        const namePos = scaleFont(pin.namePos);
        const numberPos = scaleFont(pin.numberPos);
        return {
            ...pin,
            x: (pin.x - offsetX) * scale,
            y: (pin.y - offsetY) * scale,
            length: Number.isFinite(pin.length) ? pin.length * scale : null,
            namePos,
            numberPos
        };
    }

    _estimatePinCount(metadata) {
        if (!metadata) return 0;

        if (Array.isArray(metadata.footprintShapes) && metadata.footprintShapes.length > 0) {
            const padSet = new Set();
            for (const shape of metadata.footprintShapes) {
                if (typeof shape !== 'string') continue;
                if (!shape.startsWith('PAD~')) continue;
                const parts = shape.split('~');
                if (parts.length < 6) continue;
                const x = Number(parts[2]);
                const y = Number(parts[3]);
                if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
                padSet.add(`${x.toFixed(2)},${y.toFixed(2)}`);
            }
            if (padSet.size > 0) {
                return padSet.size;
            }
        }

        const pkg = (metadata.package || '').toUpperCase();
        const pinMatch = pkg.match(/(\d+)/);
        if (pinMatch) {
            return parseInt(pinMatch[1], 10);
        }

        return 0;
    }

    _createGenericInlineSymbol(pinCount) {
        const spacing = 2.54;
        const width = 6;
        const height = Math.max(6, (pinCount - 1) * spacing + 2);

        const symbol = {
            width: width + 4,
            height: height,
            origin: { x: (width + 4) / 2, y: height / 2 },
            graphics: [
                {
                    type: 'rect',
                    x: 2,
                    y: 0,
                    width,
                    height,
                    stroke: '#880000',
                    strokeWidth: 0.254,
                    fill: 'none'
                }
            ],
            pins: []
        };

        for (let i = 0; i < pinCount; i++) {
            symbol.pins.push({
                number: String(i + 1),
                name: String(i + 1),
                x: 0,
                y: (height / (pinCount + 1)) * (i + 1),
                orientation: 'right',
                length: 2,
                pinType: 'passive',
                shape: 'line'
            });
        }

        return symbol;
    }

    _createSwitch3PinSymbol() {
        return {
            width: 10,
            height: 8,
            origin: { x: 5, y: 4 },
            graphics: [
                { type: 'line', x1: 2, y1: 4, x2: 8, y2: 2, stroke: '#880000', strokeWidth: 0.254 },
                { type: 'line', x1: 8, y1: 2, x2: 8, y2: 6, stroke: '#880000', strokeWidth: 0.254 }
            ],
            pins: [
                { number: '1', name: '1', x: 0, y: 4, orientation: 'right', length: 2, pinType: 'passive', shape: 'line' },
                { number: '2', name: '2', x: 10, y: 2, orientation: 'left', length: 2, pinType: 'passive', shape: 'line' },
                { number: '3', name: '3', x: 10, y: 6, orientation: 'left', length: 2, pinType: 'passive', shape: 'line' }
            ]
        };
    }
    
    /**
     * Create a generic IC symbol (rectangle with pins)
     */
    _createGenericICSymbol(metadata) {
        // Try to estimate pin count from package
        let pinCount = 8; // Default
        const pkg = (metadata.package || '').toUpperCase();
        
        const pinMatch = pkg.match(/(\d+)/);
        if (pinMatch) {
            pinCount = parseInt(pinMatch[1], 10);
        }
        
        // Calculate dimensions
        const pinsPerSide = Math.ceil(pinCount / 2);
        const pinSpacing = 2.54;
        const height = (pinsPerSide + 1) * pinSpacing;
        const width = 10;
        
        const symbol = {
            width: width + 10,
            height: height + 4,
            origin: { x: (width + 10) / 2, y: (height + 4) / 2 },
            graphics: [
                {
                    type: 'rect',
                    x: 5,
                    y: 2,
                    width: width,
                    height: height,
                    stroke: '#880000',
                    strokeWidth: 0.254,
                    fill: 'none'
                }
            ],
            pins: []
        };
        
        // Add pins on left side
        for (let i = 0; i < pinsPerSide && i * 2 < pinCount; i++) {
            symbol.pins.push({
                number: String(i + 1),
                name: String(i + 1),
                x: 0,
                y: 2 + pinSpacing * (i + 1),
                orientation: 'right',
                length: 5,
                pinType: 'passive',
                shape: 'line'
            });
        }
        
        // Add pins on right side
        for (let i = 0; i < pinsPerSide && pinsPerSide + i < pinCount; i++) {
            symbol.pins.push({
                number: String(pinCount - i),
                name: String(pinCount - i),
                x: width + 10,
                y: 2 + pinSpacing * (i + 1),
                orientation: 'left',
                length: 5,
                pinType: 'passive',
                shape: 'line'
            });
        }
        
        return symbol;
    }
    
    /**
     * Create generic resistor symbol
     */
    _createResistorSymbol() {
        return {
            width: 10,
            height: 3,
            origin: { x: 5, y: 1.5 },
            graphics: [
                {
                    type: 'rect',
                    x: 2.5,
                    y: 0.5,
                    width: 5,
                    height: 2,
                    stroke: '#880000',
                    strokeWidth: 0.254,
                    fill: 'none'
                }
            ],
            pins: [
                { number: '1', name: '1', x: 0, y: 1.5, orientation: 'right', length: 2.5, pinType: 'passive', shape: 'line' },
                { number: '2', name: '2', x: 10, y: 1.5, orientation: 'left', length: 2.5, pinType: 'passive', shape: 'line' }
            ]
        };
    }
    
    /**
     * Create generic capacitor symbol
     */
    _createCapacitorSymbol() {
        return {
            width: 6,
            height: 6,
            origin: { x: 3, y: 3 },
            graphics: [
                { type: 'line', x1: 2.5, y1: 1, x2: 2.5, y2: 5, stroke: '#880000', strokeWidth: 0.254 },
                { type: 'line', x1: 3.5, y1: 1, x2: 3.5, y2: 5, stroke: '#880000', strokeWidth: 0.254 }
            ],
            pins: [
                { number: '1', name: '1', x: 0, y: 3, orientation: 'right', length: 2.5, pinType: 'passive', shape: 'line' },
                { number: '2', name: '2', x: 6, y: 3, orientation: 'left', length: 2.5, pinType: 'passive', shape: 'line' }
            ]
        };
    }
    
    /**
     * Create generic inductor symbol
     */
    _createInductorSymbol() {
        return {
            width: 10,
            height: 4,
            origin: { x: 5, y: 2 },
            graphics: [
                {
                    type: 'polyline',
                    points: [[2.5, 2], [3.5, 0.5], [4.5, 2], [5.5, 0.5], [6.5, 2], [7.5, 0.5], [8.5, 2]],
                    stroke: '#880000',
                    strokeWidth: 0.254,
                    fill: 'none'
                }
            ],
            pins: [
                { number: '1', name: '1', x: 0, y: 2, orientation: 'right', length: 2.5, pinType: 'passive', shape: 'line' },
                { number: '2', name: '2', x: 10, y: 2, orientation: 'left', length: 2.5, pinType: 'passive', shape: 'line' }
            ]
        };
    }
    
    /**
     * Create generic diode symbol
     */
    _createDiodeSymbol() {
        return {
            width: 10,
            height: 4,
            origin: { x: 5, y: 2 },
            graphics: [
                {
                    type: 'polygon',
                    points: [[3.5, 0.5], [3.5, 3.5], [6.5, 2]],
                    stroke: '#880000',
                    strokeWidth: 0.254,
                    fill: 'none'
                },
                { type: 'line', x1: 6.5, y1: 0.5, x2: 6.5, y2: 3.5, stroke: '#880000', strokeWidth: 0.254 }
            ],
            pins: [
                { number: '1', name: 'K', x: 0, y: 2, orientation: 'right', length: 3.5, pinType: 'passive', shape: 'line' },
                { number: '2', name: 'A', x: 10, y: 2, orientation: 'left', length: 3.5, pinType: 'passive', shape: 'line' }
            ]
        };
    }
    
    /**
     * Create generic LED symbol
     */
    _createLEDSymbol() {
        return {
            width: 10,
            height: 5,
            origin: { x: 5, y: 2.5 },
            graphics: [
                {
                    type: 'polygon',
                    points: [[3.5, 0.5], [3.5, 4.5], [6.5, 2.5]],
                    stroke: '#880000',
                    strokeWidth: 0.254,
                    fill: 'none'
                },
                { type: 'line', x1: 6.5, y1: 0.5, x2: 6.5, y2: 4.5, stroke: '#880000', strokeWidth: 0.254 },
                // Light arrows
                { type: 'line', x1: 5.5, y1: 0, x2: 7, y2: -1, stroke: '#880000', strokeWidth: 0.15 },
                { type: 'line', x1: 6.5, y1: 0, x2: 8, y2: -1, stroke: '#880000', strokeWidth: 0.15 }
            ],
            pins: [
                { number: '1', name: 'K', x: 0, y: 2.5, orientation: 'right', length: 3.5, pinType: 'passive', shape: 'line' },
                { number: '2', name: 'A', x: 10, y: 2.5, orientation: 'left', length: 3.5, pinType: 'passive', shape: 'line' }
            ]
        };
    }
    
    /**
     * Create generic transistor symbol (NPN)
     */
    _createTransistorSymbol() {
        return {
            width: 8,
            height: 10,
            origin: { x: 4, y: 5 },
            graphics: [
                // Base line
                { type: 'line', x1: 3, y1: 3, x2: 3, y2: 7, stroke: '#880000', strokeWidth: 0.254 },
                // Collector
                { type: 'line', x1: 3, y1: 4, x2: 6, y2: 2, stroke: '#880000', strokeWidth: 0.254 },
                // Emitter with arrow
                { type: 'line', x1: 3, y1: 6, x2: 6, y2: 8, stroke: '#880000', strokeWidth: 0.254 }
            ],
            pins: [
                { number: '1', name: 'B', x: 0, y: 5, orientation: 'right', length: 3, pinType: 'input', shape: 'line' },
                { number: '2', name: 'C', x: 6, y: 0, orientation: 'down', length: 2, pinType: 'passive', shape: 'line' },
                { number: '3', name: 'E', x: 6, y: 10, orientation: 'up', length: 2, pinType: 'passive', shape: 'line' }
            ]
        };
    }
    
    /**
     * Search KiCad libraries for symbols
     * @param {string} query - Search query (part name)
     * @returns {Promise<Array>} Matching symbols
     */
    async searchKiCad(query) {
        return this.kicadFetcher.searchSymbols(query);
    }
    
    /**
     * Export library to JSON
     */
    exportToJSON() {
        const components = [];
        for (const def of this.definitions.values()) {
            // Don't export built-in components
            if (def._source !== 'Built-in') {
                const { _source, ...clean } = def;
                components.push(clean);
            }
        }
        return JSON.stringify(components, null, 2);
    }
    
    /**
     * Import library from JSON
     */
    importFromJSON(json) {
        const components = JSON.parse(json);
        let imported = 0;
        
        for (const def of components) {
            try {
                this.addDefinition(def, 'User');
                imported++;
            } catch (e) {
                console.warn(`Failed to import component ${def.name}:`, e);
            }
        }
        
        return imported;
    }
}

// Singleton instance
let libraryInstance = null;

export function getComponentLibrary() {
    if (!libraryInstance) {
        libraryInstance = new ComponentLibrary();
    }
    return libraryInstance;
}

export default ComponentLibrary;