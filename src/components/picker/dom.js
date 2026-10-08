/**
 * ComponentPicker DOM and lifecycle owner. Builds the panel, binds controls, and manages modal open/close cleanup.
 */

import { ModalManager } from '../../core/ModalManager.js';
import { disposeModel3dViewer } from './footprint-preview.js';
import { populateComponents, populateLCSCResults, selectComponent, setupLazyLoading } from './results-list.js';
import { debouncedLCSCSearch, prepareKiCadIndex, setSearchMode } from './search.js';
import { selectBuiltInPackage } from './symbol-preview.js';
import { showLCSCPrompt } from './ui-state.js';

/**
 * Creates the DOM structure for the component picker panel.
 */
export function createPickerDOM(/** @type {any} */ picker) {
    picker.element = document.createElement('div');
    picker.element.className = 'component-picker';
    picker.element.innerHTML = `
        <div class="cp-header">
            <span class="cp-title">Components</span>
            <button type="button" class="cp-close app-modal-close" title="Close component picker" aria-label="Close component picker">&times;</button>
        </div>
        <div class="cp-body">
            <div class="cp-mode-toggle">
                <button class="cp-mode-btn active" data-mode="lcsc">Online</button>
                <button class="cp-mode-btn" data-mode="local">Local</button>
            </div>
            <div class="cp-search">
                <div class="cp-search-field">
                    <input type="text" class="cp-search-input" placeholder="Search components...">
                    <button class="cp-search-clear" title="Clear search" style="display:none;">✕</button>
                </div>
                <label class="cp-exact-match" title="Only show results whose name or part number is exactly the search text">
                    <input type="checkbox" class="cp-exact-match-input"> Exact match
                </label>
            </div>
            <div class="cp-categories">
                <select class="cp-category-select">
                    <option value="All">All Categories</option>
                </select>
            </div>
            <div class="cp-list"></div>
            <div class="cp-preview">
                <div class="cp-preview-image"></div>
                <div class="cp-preview-title">Symbol</div>
                <div class="cp-preview-svg"></div>
                <div class="cp-preview-loading-overlay" style="display:none">
                    <span class="cp-spinner"></span>
                    <span class="cp-preview-loading-text">Loading...</span>
                </div>
                <div class="cp-preview-info"></div>
                <label class="cp-package-row" style="display:none">
                    <span class="cp-preview-title">Package / model</span>
                    <select class="cp-package-select"></select>
                </label>
                <div class="cp-preview-title">Footprint</div>
                <div class="cp-preview-footprint"></div>
                <div class="cp-preview-footprint-info"></div>
                <div class="cp-preview-title">3D Model</div>
                <div class="cp-preview-3d"></div>
                <div class="cp-preview-3d-info"></div>
            </div>
            <div class="cp-actions">
                <button class="cp-place-btn" disabled>Place Component</button>
            </div>
            <div class="cp-hint">
                <kbd>Space</kbd> Rotate &nbsp; <kbd>X</kbd> Flip H &nbsp; <kbd>Y</kbd> Flip V
            </div>
        </div>
    `;
    
    // Get references
    picker.searchInput = /** @type {HTMLInputElement} */ (picker.element.querySelector('.cp-search-input'));
    picker.searchClearBtn = /** @type {HTMLButtonElement} */ (picker.element.querySelector('.cp-search-clear'));
    picker.exactMatchInput = /** @type {HTMLInputElement} */ (picker.element.querySelector('.cp-exact-match-input'));
    picker.categorySelect = /** @type {HTMLSelectElement} */ (picker.element.querySelector('.cp-category-select'));
    picker.body = /** @type {HTMLElement} */ (picker.element.querySelector('.cp-body'));
    picker.listEl = /** @type {HTMLElement} */ (picker.element.querySelector('.cp-list'));
    picker.previewSvg = /** @type {HTMLElement} */ (picker.element.querySelector('.cp-preview-svg'));
    picker.previewLoadingOverlay = /** @type {HTMLElement} */ (picker.element.querySelector('.cp-preview-loading-overlay'));
    picker.previewLoadingText = /** @type {HTMLElement} */ (picker.element.querySelector('.cp-preview-loading-text'));
    picker.previewInfo = /** @type {HTMLElement} */ (picker.element.querySelector('.cp-preview-info'));
    picker.packageRow = /** @type {HTMLElement} */ (picker.element.querySelector('.cp-package-row'));
    picker.packageSelect = /** @type {HTMLSelectElement} */ (picker.element.querySelector('.cp-package-select'));
    picker.previewImage = /** @type {HTMLElement} */ (picker.element.querySelector('.cp-preview-image'));
    picker.previewFootprint = /** @type {HTMLElement} */ (picker.element.querySelector('.cp-preview-footprint'));
    picker.previewFootprintInfo = /** @type {HTMLElement} */ (picker.element.querySelector('.cp-preview-footprint-info'));
    picker.preview3d = /** @type {HTMLElement} */ (picker.element.querySelector('.cp-preview-3d'));
    picker.preview3dInfo = /** @type {HTMLElement} */ (picker.element.querySelector('.cp-preview-3d-info'));
    picker.placeBtn = /** @type {HTMLButtonElement} */ (picker.element.querySelector('.cp-place-btn'));
    picker.bodyEl = /** @type {HTMLElement} */ (picker.element.querySelector('.cp-body'));
    picker.modeButtons = /** @type {NodeListOf<HTMLButtonElement>} */ (picker.element.querySelectorAll('.cp-mode-btn'));
    picker.categoriesEl = /** @type {HTMLElement} */ (picker.element.querySelector('.cp-categories'));
    // Start collapsed if configured
    if (!picker.isOpen) {
        picker.element.classList.add('collapsed');
    }
    
    // Bind events
    picker.element.querySelector('.cp-close').addEventListener('click', () => closePicker(picker));
    picker.packageSelect.addEventListener('change', () => {
        selectBuiltInPackage(picker, picker.packageSelect.value);
    });
    picker.searchInput.addEventListener('input', () => {
        picker.searchQuery = picker.searchInput.value;
        // Show/hide clear button
        picker.searchClearBtn.style.display = picker.searchQuery ? 'block' : 'none';
        if (picker.searchMode === 'lcsc') {
            debouncedLCSCSearch(picker);
        } else {
            populateComponents(picker);
        }
    });
    
    // Exact match re-filters the current results; it never starts a new online search.
    picker.exactMatchInput.addEventListener('change', () => {
        if (picker.searchMode !== 'lcsc') populateComponents(picker);
        else if (picker.searchQuery.trim().length >= 2 && !picker.isSearching
            && (picker.lcscResults.length || picker.kicadResults.length)) populateLCSCResults(picker);
    });

    // Clear button handler
    picker.searchClearBtn.addEventListener('click', () => {
        picker.searchInput.value = '';
        picker.searchQuery = '';
        picker.searchClearBtn.style.display = 'none';
        if (picker.searchMode === 'lcsc') {
            showLCSCPrompt(picker);
        } else {
            populateComponents(picker);
        }
    });
    
    // Note: ESC handling is performed via ModalManager when picker is open
    
    picker.categorySelect.addEventListener('change', () => {
        picker.selectedCategory = picker.categorySelect.value;
        populateComponents(picker);
    });

    
    picker.placeBtn.addEventListener('click', () => {
        if (picker.selectedComponent) {
            selectComponent(picker, picker.selectedComponent);
        }
    });
    
    // Mode toggle buttons
    picker.modeButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            setSearchMode(picker, btn.dataset.mode);
        });
    });
}

/**
 * Toggles the component picker panel open or closed.
 */
export function togglePicker(/** @type {any} */ picker) {
    if (picker.isOpen) {
        closePicker(picker);
        return;
    }
    picker.isOpen = true;
    picker.element.classList.remove('collapsed');
    // Re-initialize lazy loading now that the element is visible
    if (!picker.lazyLoader && picker.componentItems.size > 0) {
        setupLazyLoading(picker);
    }
    ModalManager.push('componentPicker', () => closePicker(picker));
    if (picker.searchMode === 'lcsc' && picker.searchQuery.trim().length < 2) {
        prepareKiCadIndex(picker);
    }
}

/**
 * Closes the component picker panel and cleans up the lazy loader.
 */
export function closePicker(/** @type {any} */ picker) {
    const wasOpen = picker.isOpen;
    picker.isOpen = false;
    picker.element.classList.add('collapsed');
    ModalManager.pop('componentPicker');
    disposeModel3dViewer(picker);
    // Cleanup lazy loader to save memory
    if (picker.lazyLoader) {
        picker.lazyLoader.destroy();
        picker.lazyLoader = null;
    }
    if (wasOpen) picker.eventBus.emit('component:pickerClosed');
}

/**
 * Opens the component picker panel if it is not already open.
 */
export function openPicker(/** @type {any} */ picker) {
    if (!picker.isOpen) {
        togglePicker(picker);
    }
}

/** Put the keyboard in the search field, ready to type a part name. */

export function focusPickerSearch(/** @type {any} */ picker) {
    picker.searchInput?.focus();
}

/**
 * Appends the component picker element to a parent DOM node.
 * @param {HTMLElement} parent - The parent element to append to.
 */
export function appendPickerTo(/** @type {any} */ picker, parent) {
    parent.appendChild(picker.element);
}

/**
 * Returns the currently selected component definition.
 * @returns {Object|null} The selected component, or null if none is selected.
 */
export function getSelectedComponent(/** @type {any} */ picker) {
    return picker.selectedComponent;
}

/**
 * Clears the current component selection and resets the preview panel.
 */
export function clearSelection(/** @type {any} */ picker) {
    picker.selectedComponent = null;
    picker.placeBtn.disabled = true;
    picker.listEl.querySelectorAll('.cp-item').forEach(el => {
        el.classList.remove('selected');
    });
    picker.previewSvg.innerHTML = '';
    picker.previewInfo.innerHTML = '';
}

/**
 * Cleanup and destroy the component picker
 */
export function destroyPicker(/** @type {any} */ picker) {
    closePicker(picker);
    disposeModel3dViewer(picker);
    if (picker.searchDebouncer) {
        picker.searchDebouncer.dispose();
    }
    if (picker._scrollHandler && picker.listEl) {
        picker.listEl.removeEventListener('scroll', picker._scrollHandler);
        picker._scrollHandler = null;
    }
    if (picker.lazyLoader) {
        picker.lazyLoader.destroy();
        picker.lazyLoader = null;
    }
    picker.componentItems.clear();
    if (picker.element && picker.element.parentElement) {
        picker.element.parentElement.removeChild(picker.element);
    }
}
