/**
 * SearchManager - Centralized search, filtering, and caching
 * 
 * Provides a unified interface for component searches across:
 * - Local library
 * - KiCad library (with caching)
 * - LCSC online catalog
 * 
 * Features:
 * - Result caching with TTL
 * - Fallback chain (LCSC -> KiCad -> Local)
 * - Search result validation
 * - Performance metrics
 */

import { storageManager } from './StorageManager.js';

export class SearchManager {
    constructor(componentLibrary) {
        this.library = componentLibrary;
        this.searchCache = new Map();
        this.stats = {
            cacheHits: 0,
            cacheMisses: 0,
            searchCount: 0
        };
    }

    /**
     * Clear all search caches
     */
    clearCache() {
        this.searchCache.clear();
        // Also clear localStorage caches
        for (const key of Object.keys(localStorage)) {
            if (key.startsWith('clearpcb_search_')) {
                localStorage.removeItem(key);
            }
        }
    }

    /**
     * Get search statistics
     */
    getStats() {
        return { ...this.stats };
    }

    /**
     * Search local library
     */
    searchLocal(query) {
        if (!query || query.length === 0) {
            return this.library.getAllDefinitions();
        }
        return this.library.searchLocal(query);
    }

    /**
     * Search KiCad library with caching
     */
    async searchKiCad(query) {
        if (!query || query.length < 2) {
            return [];
        }

        // Check in-memory cache first
        const cacheKey = `kicad:${query.toLowerCase()}`;
        if (this.searchCache.has(cacheKey)) {
            this.stats.cacheHits++;
            console.log('SearchManager: KiCad cache hit');
            return this.searchCache.get(cacheKey);
        }

        this.stats.cacheMisses++;
        this.stats.searchCount++;

        try {
            const results = await this.library.searchKiCad(query);
            
            // Cache the results (24-hour TTL)
            this.searchCache.set(cacheKey, results);
            storageManager.set(`clearpcb_search_kicad_${query}`, results, 24 * 60 * 60);
            
            return results || [];
        } catch (error) {
            console.error('SearchManager: KiCad search error:', error);
            return [];
        }
    }

    /**
     * Search LCSC with caching
     */
    async searchLCSC(query) {
        if (!query || query.length < 2) {
            return [];
        }

        // Check in-memory cache first
        const cacheKey = `lcsc:${query.toLowerCase()}`;
        if (this.searchCache.has(cacheKey)) {
            this.stats.cacheHits++;
            console.log('SearchManager: LCSC cache hit');
            return this.searchCache.get(cacheKey);
        }

        this.stats.cacheMisses++;
        this.stats.searchCount++;

        try {
            const results = await this.library.searchLCSC(query);
            
            // Cache the results (12-hour TTL for online data)
            this.searchCache.set(cacheKey, results);
            storageManager.set(`clearpcb_search_lcsc_${query}`, results, 12 * 60 * 60);
            
            return results || [];
        } catch (error) {
            console.error('SearchManager: LCSC search error:', error);
            return [];
        }
    }

    /**
     * Unified search with fallback chain
     * Tries: LCSC -> KiCad -> Local
     */
    async search(query, mode = 'auto') {
        if (!query || query.length === 0) {
            return { local: this.searchLocal('') };
        }

        this.stats.searchCount++;

        const results = {
            local: [],
            kicad: [],
            lcsc: []
        };

        try {
            if (mode === 'local' || mode === 'auto') {
                results.local = this.searchLocal(query);
            }

            if (mode === 'online' || mode === 'auto') {
                // Try LCSC first
                results.lcsc = await this.searchLCSC(query);
                
                // If LCSC fails or empty, try KiCad
                if (!results.lcsc || results.lcsc.length === 0) {
                    results.kicad = await this.searchKiCad(query);
                }
            }
        } catch (error) {
            console.error('SearchManager: Search error:', error);
        }

        return results;
    }

    /**
     * Fetch and cache a component from LCSC
     */
    async fetchFromLCSC(lcscId) {
        try {
            const definition = await this.library.fetchFromLCSC(lcscId);
            if (definition) {
                // Cache the component definition
                const cacheKey = `clearpcb_lcsc_component_${lcscId}`;
                storageManager.set(cacheKey, definition, 7 * 24 * 60 * 60);
            }
            return definition;
        } catch (error) {
            console.error('SearchManager: Failed to fetch from LCSC:', error);
            return null;
        }
    }

    /**
     * Fetch and cache a KiCad symbol
     */
    async fetchFromKiCad(library, symbolName) {
        try {
            const symbol = await this.library.kicadFetcher.fetchSymbol(library, symbolName);
            if (symbol) {
                // Cache the symbol
                const cacheKey = `clearpcb_kicad_symbol_${library}_${symbolName}`;
                storageManager.set(cacheKey, symbol, 7 * 24 * 60 * 60);
            }
            return symbol;
        } catch (error) {
            console.error('SearchManager: Failed to fetch from KiCad:', error);
            return null;
        }
    }

    /**
     * Validate search results format
     */
    validateResults(results, type = 'local') {
        if (!Array.isArray(results)) {
            console.warn(`SearchManager: ${type} results is not an array`);
            return [];
        }

        switch (type) {
            case 'local':
                return results.filter(r => r && typeof r === 'object' && r.name);
            
            case 'kicad':
                return results.filter(r => r && r.library && r.name);
            
            case 'lcsc':
                return results.filter(r => r && r.lcscPartNumber);
            
            default:
                return results;
        }
    }

    /**
     * Get cached component definition by name
     */
    getCachedComponent(name) {
        try {
            const cached = storageManager.get(`clearpcb_component_${name}`);
            return cached || null;
        } catch (error) {
            console.warn('SearchManager: Failed to get cached component:', error);
            return null;
        }
    }

    /**
     * Cache a component definition
     */
    cacheComponent(component, ttl = 7 * 24 * 60 * 60) {
        try {
            if (component && component.name) {
                storageManager.set(`clearpcb_component_${component.name}`, component, ttl);
            }
        } catch (error) {
            console.warn('SearchManager: Failed to cache component:', error);
        }
    }
}

/**
 * Global singleton search manager instance
 */
let searchManagerInstance = null;

export function initSearchManager(componentLibrary) {
    if (!searchManagerInstance) {
        searchManagerInstance = new SearchManager(componentLibrary);
    }
    return searchManagerInstance;
}

export function getSearchManager() {
    return searchManagerInstance;
}
