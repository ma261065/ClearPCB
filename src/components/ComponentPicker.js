/**
 * ComponentPicker - Panel for browsing and selecting components.
 */

import { getComponentLibrary } from '../components/index.js';
import { globalEventBus } from '../core/EventBus.js';
import { getSearchManager, initSearchManager } from '../core/SearchManager.js';
import { createDebouncedRunner, createGenerationGate } from './async-control.js';
import {
    appendPickerTo,
    clearSelection,
    closePicker,
    createPickerDOM,
    destroyPicker,
    focusPickerSearch,
    getSelectedComponent,
    openPicker,
    togglePicker
} from './picker/dom.js';
import { populateCategories, populateComponents } from './picker/results-list.js';
import { searchLCSC } from './picker/search.js';
import { showLCSCPrompt } from './picker/ui-state.js';

export class ComponentPicker {
    /**
     * Creates a new ComponentPicker instance for browsing and selecting components.
     * @param {Object} [options] - Configuration options.
     * @param {Object} [options.eventBus] - Event bus for component events.
     */
    constructor(options = {}) {
        this.library = getComponentLibrary();
        this.eventBus = options.eventBus || globalEventBus;
        
        // Initialize SearchManager if needed
        if (!getSearchManager()) {
            initSearchManager(this.library);
        }
        this.searchManager = getSearchManager();
        
        this.element = null;
        this.selectedComponent = null;
        this.selectedLCSCResult = null;
        this.selectedKiCadResult = null;
        this.selectedKiCadFootprint = '';
        this.selectedKiCadModel3dUrl = '';
        this.selectedCategory = 'All';
        this.searchQuery = '';
        this.isOpen = false;
        this.searchMode = 'lcsc';  // 'local' or 'lcsc' (online is the default)
        this.lcscResults = [];
        this.kicadResults = [];
        this.isSearching = false;
        this.searchRequestGate = createGenerationGate();
        this.selectionRequestGate = createGenerationGate();
        this.searchDebouncer = createDebouncedRunner(400, () => {
            searchLCSC(this);
        });
        
        // Lazy loading
        this.lazyLoader = null;
        this.componentItems = new Map();
        
        createPickerDOM(this);
        populateCategories(this);
        populateComponents(this);
        // Online is the default search mode: hide the category filter, show the
        // online search prompt and placeholder. Startup warms the KiCad index;
        // opening/searching joins that load or retries it after a failure.
        /** @type {any} */ (this).categoriesEl.style.display = 'none';
        /** @type {any} */ (this).searchInput.placeholder = 'Search online (e.g., NE555, C46749)...';
        showLCSCPrompt(this);
    }

    /** Toggles the component picker panel open or closed. */
    toggle() {
        togglePicker(this);
    }

    /** Closes the component picker panel and cleans up the lazy loader. */
    close() {
        closePicker(this);
    }

    /** Opens the component picker panel if it is not already open. */
    open() {
        openPicker(this);
    }

    /** Put the keyboard in the search field, ready to type a part name. */
    focusSearch() {
        focusPickerSearch(this);
    }

    /**
     * Appends the component picker element to a parent DOM node.
     * @param {HTMLElement} parent - The parent element to append to.
     */
    appendTo(parent) {
        appendPickerTo(this, parent);
    }

    /**
     * Returns the currently selected component definition.
     * @returns {Object|null} The selected component, or null if none is selected.
     */
    getSelectedComponent() {
        return getSelectedComponent(this);
    }

    /** Clears the current component selection and resets the preview panel. */
    clearSelection() {
        clearSelection(this);
    }

    /** Cleanup and destroy the component picker. */
    destroy() {
        destroyPicker(this);
    }
}

export default ComponentPicker;
