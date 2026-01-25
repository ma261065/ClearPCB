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
import { KiCadFetcher } from './KiCadFetcher.js';

export class ComponentLibrary {
    constructor() {
        // Component definitions by name
        this.definitions = new Map();
        
        // Categories for organization
        this.categories = new Map();
        
        // LCSC fetcher (metadata, pricing, stock)
        this.lcscFetcher = new LCSCFetcher();
        
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
            const stored = localStorage.getItem('clearpcb_user_components');
            if (stored) {
                const components = JSON.parse(stored);
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
            localStorage.setItem('clearpcb_user_components', JSON.stringify(userComponents));
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
            return cached;
        }
        
        // Step 1: Get LCSC metadata
        console.log(`Fetching LCSC metadata for ${lcscId}...`);
        const metadata = await this.lcscFetcher.fetchComponentMetadata(lcscId);
        
        if (!metadata) {
            throw new Error(`Component ${lcscId} not found on LCSC`);
        }
        
        console.log('LCSC metadata:', metadata);
        
        // Step 2: Try to find matching KiCad symbol
        let symbol = null;
        const kicadMapping = this.lcscFetcher.suggestKiCadMapping(
            metadata.mpn, 
            metadata.category
        );
        
        if (kicadMapping) {
            console.log(`Trying KiCad mapping: ${kicadMapping.library}:${kicadMapping.symbol}`);
            try {
                const kicadResult = await this.kicadFetcher.fetchSymbol(
                    kicadMapping.library,
                    kicadMapping.symbol
                );
                if (kicadResult && kicadResult.symbol) {
                    symbol = kicadResult.symbol;
                    console.log('KiCad symbol found:', symbol);
                }
            } catch (e) {
                console.warn('KiCad fetch failed:', e);
            }
        }
        
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
            stock: metadata.stock,
            price: metadata.price,
            priceBreaks: metadata.priceBreaks,
            isBasic: metadata.isBasic,
            productUrl: metadata.productUrl,
            imageUrl: metadata.imageUrl,
            _source: 'LCSC'
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
        }
        
        // Default: generic IC/box symbol
        return this._createGenericICSymbol(metadata);
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