/**
 * ComponentPicker - Panel for browsing and selecting components.
 */

import { getComponentLibrary } from '../components/index.js';
import { globalEventBus } from '../core/EventBus.js';
import { getSearchManager, initSearchManager } from '../core/SearchManager.js';
import { createDebouncedRunner, createGenerationGate } from './async-control.js';
import {
    appendPickerTo,
    bindPickerDOM,
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

/** @typedef {import('../core/EventBus.js').EventBus} EventBus */
/** @typedef {import('../core/LazyLoader.js').LazyLoader} LazyLoader */
/** @typedef {import('../core/SearchManager.js').SearchManager} SearchManager */
/** @typedef {import('./Component.js').ComponentDefinition} ComponentDefinition */
/** @typedef {import('./Component.js').ComponentProperties} ComponentProperties */
/** @typedef {import('./Component.js').ComponentSymbol} ComponentSymbol */
/** @typedef {import('./Component.js').ComponentSymbolGraphic} ComponentSymbolGraphic */
/** @typedef {import('./Component.js').ComponentSymbolPin} ComponentSymbolPin */
/** @typedef {import('./ComponentLibrary.js').ComponentLibrary} ComponentLibrary */
/** @typedef {import('../shared/pcb/footprint.js').FootprintBox} FootprintBox */
/** @typedef {import('./kicad/symbol-index.js').SymbolSearchResult} KiCadSearchResult */
/** @typedef {import('./kicad/footprints.js').FootprintAvailability} FootprintAvailability */
/** @typedef {import('./kicad/footprint-parser.js').FootprintPreview} FootprintPreview */
/** @typedef {import('./LCSCFetcher.js').EasyEDADetail} EasyEDADetail */
/** @typedef {import('./LCSCFetcher.js').LCSCSearchResult} LCSCSearchResult */

/** @typedef {{next: () => number, invalidate: () => void, isCurrent: (token: number) => boolean}} GenerationGate */
/** @typedef {{run: (...args: any[]) => void, cancel: () => void, dispose: () => void}} DebouncedRunner */
/** @typedef {import('./KiCadFetcher.js').KiCadIndexProgress} SearchProgress */
/** @typedef {{setModel: (modelText: string) => boolean, dispose: () => void}} Model3DViewerLike */
/** @typedef {ComponentSymbol} SymbolDefinitionLike */
/** @typedef {ComponentSymbolGraphic} SymbolGraphicLike */
/** @typedef {ComponentSymbolPin} SymbolPinLike */
/** @typedef {ComponentDefinition} PickerComponentDefinition */
/** @typedef {ComponentDefinition} KiCadDefinition */
/** @typedef {{eventBus?: EventBus}} ComponentPickerOptions */

export class ComponentPicker {
    /**
     * Creates a new ComponentPicker instance for browsing and selecting components.
     * @param {ComponentPickerOptions} [options] - Configuration options.
     */
    constructor(options = {}) {
        /** @type {ComponentLibrary} */
        this.library = getComponentLibrary();
        /** @type {EventBus} */
        this.eventBus = options.eventBus || globalEventBus;
        
        // Initialize SearchManager if needed
        if (!getSearchManager()) {
            initSearchManager(this.library);
        }
        const searchManager = getSearchManager();
        if (!searchManager) throw new Error('SearchManager was not initialized');
        /** @type {SearchManager} */
        this.searchManager = searchManager;

        /** @type {PickerComponentDefinition|null} */
        this.selectedComponent = null;
        /** @type {LCSCSearchResult|null} */
        this.selectedLCSCResult = null;
        /** @type {KiCadSearchResult|null} */
        this.selectedKiCadResult = null;
        /** @type {HTMLElement|null} */
        this.selectedKiCadItem = null;
        this.selectedKiCadFootprint = '';
        this.selectedKiCadModel3dUrl = '';
        this.selectedCategory = 'All';
        this.searchQuery = '';
        this.isOpen = false;
        this.searchMode = 'lcsc';  // 'local' or 'lcsc' (online is the default)
        /** @type {LCSCSearchResult[]} */
        this.lcscResults = [];
        /** @type {KiCadSearchResult[]} */
        this.kicadResults = [];
        this.isSearching = false;
        /** @type {GenerationGate} */
        this.searchRequestGate = createGenerationGate();
        /** @type {GenerationGate} */
        this.selectionRequestGate = createGenerationGate();
        /** @type {DebouncedRunner} */
        this.searchDebouncer = createDebouncedRunner(400, () => {
            searchLCSC(this);
        });
        
        // Lazy loading
        /** @type {LazyLoader|null} */
        this.lazyLoader = null;
        /** @type {Map<HTMLElement, PickerComponentDefinition>} */
        this.componentItems = new Map();
        /** @type {(() => void)|null} */
        this._scrollHandler = null;
        this._previewVersion = 0;
        this._model3dPreviewVersion = 0;
        /** @type {Model3DViewerLike|null} */
        this._model3dViewer = null;
        
        const dom = createPickerDOM(this, { bindEvents: false });
        this.element = dom.element;
        this.searchInput = dom.searchInput;
        this.searchClearBtn = dom.searchClearBtn;
        this.exactMatchInput = dom.exactMatchInput;
        this.categorySelect = dom.categorySelect;
        this.body = dom.body;
        this.bodyEl = dom.bodyEl;
        this.listEl = dom.listEl;
        this.previewSvg = dom.previewSvg;
        this.previewLoadingOverlay = dom.previewLoadingOverlay;
        this.previewLoadingText = dom.previewLoadingText;
        this.previewInfo = dom.previewInfo;
        this.packageRow = dom.packageRow;
        this.packageSelect = dom.packageSelect;
        this.previewImage = dom.previewImage;
        this.previewFootprint = dom.previewFootprint;
        this.previewFootprintInfo = dom.previewFootprintInfo;
        this.preview3d = dom.preview3d;
        this.preview3dInfo = dom.preview3dInfo;
        this.placeBtn = dom.placeBtn;
        this.modeButtons = dom.modeButtons;
        this.categoriesEl = dom.categoriesEl;
        bindPickerDOM(this);
        populateCategories(this);
        populateComponents(this);
        // Online is the default search mode: hide the category filter, show the
        // online search prompt and placeholder. Startup warms the KiCad index;
        // opening/searching joins that load or retries it after a failure.
        this.categoriesEl.style.display = 'none';
        this.searchInput.placeholder = 'Search online (e.g., NE555, C46749)...';
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
     * @returns {PickerComponentDefinition|null} The selected component, or null if none is selected.
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
