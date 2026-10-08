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

/** @typedef {import('../core/EventBus.js').EventBus} EventBus */
/** @typedef {import('../core/LazyLoader.js').LazyLoader} LazyLoader */
/** @typedef {import('./Component.js').ComponentDefinition} ComponentDefinition */
/** @typedef {import('./ComponentLibrary.js').ComponentLibrary} ComponentLibrary */
/** @typedef {import('../shared/pcb/footprint.js').FootprintBox} FootprintBox */

/** @typedef {{next: () => number, invalidate: () => void, isCurrent: (token: number) => boolean}} GenerationGate */
/** @typedef {{run: (...args: any[]) => void, cancel: () => void, dispose: () => void}} DebouncedRunner */
/** @typedef {{loaded: number, total: number, message: string}} SearchProgress */
/** @typedef {{setModel: (modelText: string) => boolean, dispose: () => void}} Model3DViewerLike */
/** @typedef {Record<string, string|number|boolean|null|undefined>} ComponentProperties */
/** @typedef {{x?: number, y?: number, anchor?: string, rotation?: number}} SymbolTextPosition */
/** @typedef {{number?: string|number, name?: string, x: number, y: number, orientation?: string, length?: number, pinType?: string, shape?: string, bubble?: boolean, namePos?: SymbolTextPosition, numberPos?: SymbolTextPosition, kicadNumberYOffset?: number, _pathData?: string}} SymbolPinLike */
/** @typedef {{type?: string, stroke?: string, strokeWidth?: number, fill?: string, x1?: number, y1?: number, x2?: number, y2?: number, x?: number, y?: number, width?: number, height?: number, rx?: number, cx?: number, cy?: number, r?: number, ry?: number, points?: Array<[number, number]>, d?: string, text?: string, anchor?: string, baseline?: string, color?: string, fontSize?: number}} SymbolGraphicLike */
/** @typedef {{pins?: SymbolPinLike[], graphics?: SymbolGraphicLike[], symbol?: SymbolDefinitionLike, properties?: ComponentProperties, name?: string, description?: string, category?: string, _kicadRaw?: unknown, _source?: string, kicadTextOffset?: number}} SymbolDefinitionLike */
/** @typedef {ComponentDefinition & {symbol?: SymbolDefinitionLike, properties?: ComponentProperties, footprint?: string, footprintName?: string, footprintFilters?: string[], footprintShapes?: string[]|null, footprintBBox?: FootprintBox|null, hasFootprint?: boolean, has3d?: boolean, model3dObj?: string|null, model3dUrl?: string|null, model3dName?: string|null, package?: string, packageId?: string, thumbUrl?: string, imageUrl?: string, lcscPartNumber?: string, _kicadRaw?: unknown}} PickerComponentDefinition */
/** @typedef {PickerComponentDefinition & {symbol?: SymbolDefinitionLike, properties?: ComponentProperties}} KiCadDefinition */
/** @typedef {{name: string, library: string}} KiCadSearchResult */
/** @typedef {{footprintName?: string, package?: string, footprintShapes?: string[]|null, footprintBBox?: FootprintBox|null, model3dName?: string|null, hasFootprint?: boolean, has3d?: boolean, model3dUrl?: string|null, model3dObj?: string|null}} EasyEDADetail */
/** @typedef {{error?: boolean, message?: string, mpn?: string, lcscPartNumber?: string, package?: string, manufacturer?: string, description?: string, price?: number|null, stock?: number, isBasic?: boolean, isPreferred?: boolean, thumbUrl?: string, imageUrl?: string, _thumbPromise?: Promise<string|null>|null, _detailPromise?: Promise<EasyEDADetail|null>|null, _definitionPromise?: Promise<PickerComponentDefinition|null>|null, _detail?: EasyEDADetail|null}} LCSCSearchResult */
/** @typedef {{hasFootprint?: boolean, has3d?: boolean, modelUrl?: string}} FootprintAvailability */
/** @typedef {{shapes?: string[], bbox?: FootprintBox|null}} FootprintPreview */
/** @typedef {{libraryIndex?: unknown, _indexProgress?: SearchProgress|null, corsProxy?: string, ensureIndexLoaded: (onProgress?: (progress: SearchProgress) => void) => Promise<void>, checkFootprintAvailability: (footprintName: string) => Promise<FootprintAvailability>, fetchFootprintPreview: (footprintName: string) => Promise<FootprintPreview>, findFootprintCandidatesByFilters: (filters: string[], options?: {limit?: number}) => Promise<string[]>}} KiCadFetcherLike */
/** @typedef {{fetchComponentMetadata: (lcscPartNumber: string) => Promise<EasyEDADetail|null>, fetchEasyedaProductImage: (lcscPartNumber: string) => Promise<string|null>}} LCSCFetcherLike */
/** @typedef {ComponentLibrary & {lcscFetcher: LCSCFetcherLike, kicadFetcher: KiCadFetcherLike, getAllDefinitions: () => PickerComponentDefinition[], getByCategory: (category: string) => PickerComponentDefinition[], getCategoryNames: () => string[], addDefinition: (definition: PickerComponentDefinition, source?: string) => PickerComponentDefinition}} PickerLibrary */
/** @typedef {{clearCache: () => void, searchLocal: (query: string) => PickerComponentDefinition[], searchLCSC: (query: string) => Promise<LCSCSearchResult[]>, searchKiCad: (query: string) => Promise<KiCadSearchResult[]>, fetchFromLCSC: (lcscId: string) => Promise<PickerComponentDefinition|null>, fetchFromKiCad: (library: string, symbolName: string) => Promise<KiCadDefinition|null>}} SearchManagerLike */
/** @typedef {{eventBus?: EventBus}} ComponentPickerOptions */

/**
 * @template T
 * @returns {T}
 */
function lateInit() {
    return /** @type {T} */ (null);
}

export class ComponentPicker {
    /**
     * Creates a new ComponentPicker instance for browsing and selecting components.
     * @param {ComponentPickerOptions} [options] - Configuration options.
     */
    constructor(options = {}) {
        /** @type {PickerLibrary} */
        this.library = /** @type {PickerLibrary} */ (getComponentLibrary());
        /** @type {EventBus} */
        this.eventBus = options.eventBus || globalEventBus;
        
        // Initialize SearchManager if needed
        if (!getSearchManager()) {
            initSearchManager(this.library);
        }
        /** @type {SearchManagerLike} */
        this.searchManager = /** @type {SearchManagerLike} */ (getSearchManager());
        
        /** @type {HTMLElement} */
        this.element = lateInit();
        /** @type {HTMLInputElement} */
        this.searchInput = lateInit();
        /** @type {HTMLButtonElement} */
        this.searchClearBtn = lateInit();
        /** @type {HTMLInputElement} */
        this.exactMatchInput = lateInit();
        /** @type {HTMLSelectElement} */
        this.categorySelect = lateInit();
        /** @type {HTMLElement} */
        this.body = lateInit();
        /** @type {HTMLElement} */
        this.bodyEl = lateInit();
        /** @type {HTMLElement} */
        this.listEl = lateInit();
        /** @type {HTMLElement} */
        this.previewSvg = lateInit();
        /** @type {HTMLElement} */
        this.previewLoadingOverlay = lateInit();
        /** @type {HTMLElement} */
        this.previewLoadingText = lateInit();
        /** @type {HTMLElement} */
        this.previewInfo = lateInit();
        /** @type {HTMLElement} */
        this.packageRow = lateInit();
        /** @type {HTMLSelectElement} */
        this.packageSelect = lateInit();
        /** @type {HTMLElement} */
        this.previewImage = lateInit();
        /** @type {HTMLElement} */
        this.previewFootprint = lateInit();
        /** @type {HTMLElement} */
        this.previewFootprintInfo = lateInit();
        /** @type {HTMLElement} */
        this.preview3d = lateInit();
        /** @type {HTMLElement} */
        this.preview3dInfo = lateInit();
        /** @type {HTMLButtonElement} */
        this.placeBtn = lateInit();
        /** @type {NodeListOf<HTMLButtonElement>} */
        this.modeButtons = lateInit();
        /** @type {HTMLElement} */
        this.categoriesEl = lateInit();
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
        
        createPickerDOM(this);
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
