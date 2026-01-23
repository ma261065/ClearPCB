/**
 * ComponentLibrary - Manages component definitions
 * 
 * Provides:
 * - Built-in component library
 * - User component library (localStorage)
 * - LCSC component fetching
 */

import { Component } from './Component.js';
import { BuiltInComponents } from './BuiltInComponents.js';
import { LCSCFetcher } from './LCSCFetcher.js';

export class ComponentLibrary {
    constructor() {
        // Component definitions by name
        this.definitions = new Map();
        
        // Categories for organization
        this.categories = new Map();
        
        // LCSC fetcher
        this.lcscFetcher = new LCSCFetcher();
        
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
        
        // Store source for categorization
        definition._source = source;
        
        // Add to definitions map
        this.definitions.set(definition.name, definition);
        
        // Add to category
        const category = definition.category || 'Uncategorized';
        if (!this.categories.has(category)) {
            this.categories.set(category, new Set());
        }
        this.categories.get(category).add(definition.name);
        
        // Save if user component
        if (source === 'User') {
            this._saveUserComponents();
        }
        
        return definition;
    }
    
    /**
     * Remove a component definition
     */
    removeDefinition(name) {
        const def = this.definitions.get(name);
        if (!def) return false;
        
        // Remove from category
        const category = def.category || 'Uncategorized';
        if (this.categories.has(category)) {
            this.categories.get(category).delete(name);
        }
        
        // Remove from definitions
        this.definitions.delete(name);
        
        // Save if user component
        if (def._source === 'User') {
            this._saveUserComponents();
        }
        
        return true;
    }
    
    /**
     * Get a component definition by name
     */
    getDefinition(name) {
        return this.definitions.get(name) || null;
    }
    
    /**
     * Get all definitions
     */
    getAllDefinitions() {
        return Array.from(this.definitions.values());
    }
    
    /**
     * Get definitions by category
     */
    getByCategory(category) {
        const names = this.categories.get(category);
        if (!names) return [];
        return Array.from(names).map(name => this.definitions.get(name));
    }
    
    /**
     * Get all categories
     */
    getCategories() {
        return Array.from(this.categories.keys());
    }
    
    /**
     * Search definitions by name or description
     */
    search(query) {
        const q = query.toLowerCase();
        const results = [];
        
        for (const def of this.definitions.values()) {
            const nameMatch = def.name.toLowerCase().includes(q);
            const descMatch = def.description && def.description.toLowerCase().includes(q);
            const keywordMatch = def.keywords && def.keywords.some(k => k.toLowerCase().includes(q));
            
            if (nameMatch || descMatch || keywordMatch) {
                results.push(def);
            }
        }
        
        return results;
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
     * Fetch component from LCSC by part number
     * @param {string} lcscId - LCSC part number (e.g., "C46749")
     * @returns {Promise<object>} Component definition
     */
    async fetchFromLCSC(lcscId) {
        // Check if already cached
        const cached = this.definitions.get(`LCSC_${lcscId}`);
        if (cached) {
            return cached;
        }
        
        // Fetch from LCSC
        const definition = await this.lcscFetcher.fetchComponent(lcscId);
        
        // Add to library
        definition.name = `LCSC_${lcscId}`;
        this.addDefinition(definition, 'LCSC');
        
        return definition;
    }
    
    /**
     * Search LCSC for components
     * @param {string} query - Search query
     * @returns {Promise<Array>} Search results
     */
    async searchLCSC(query) {
        return this.lcscFetcher.search(query);
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