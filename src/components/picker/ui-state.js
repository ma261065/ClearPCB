/**
 * Shared ComponentPicker UI state helpers. Owns exact-match filtering metadata and small list/button/loading render states.
 */

/** @typedef {import('../ComponentPicker.js').ComponentPicker} ComponentPicker */
/** @typedef {import('../ComponentPicker.js').KiCadSearchResult} KiCadSearchResult */
/** @typedef {import('../ComponentPicker.js').LCSCSearchResult} LCSCSearchResult */
/** @typedef {import('../ComponentPicker.js').PickerComponentDefinition} PickerComponentDefinition */

/**
 * Whether any of a result's names equals the query, ignoring case and surrounding
 * spaces. Used by the picker's "Exact match" filter so a part can be found among
 * others sharing its prefix (e.g. C46749 among C467490...).
 * @param {string} query
 * @param {Array<string|null|undefined>} names
 */
export function isExactNameMatch(query, names) {
    const wanted = String(query || '').trim().toLowerCase();
    return !!wanted && names.some(name => typeof name === 'string' && name.trim().toLowerCase() === wanted);
}

/** Names the exact-match filter compares for each kind of picker result. */
export const pickerResultNames = {
    /** @param {LCSCSearchResult} result */
    online: result => [result.mpn, result.lcscPartNumber],
    /** @param {KiCadSearchResult} result */
    kicad: result => [result.name],
    /** @param {PickerComponentDefinition} component */
    local: component => [component.name],
};

/**
 * Displays the LCSC search prompt with usage examples.
 */
export function showLCSCPrompt(/** @type {ComponentPicker} */ picker) {
    picker.listEl.innerHTML = `
        <div class="cp-lcsc-prompt">
            Search online component catalogs (EasyEDA + KiCad).
            <br><br>
            Examples:
            <br>• C46749 (LCSC part number)
            <br>• NE555 (part name)
            <br>• STM32F103
        </div>
    `;
}

/** The trimmed search text when "Exact match" is ticked, else ''. */

export function exactMatchQuery(/** @type {ComponentPicker} */ picker) {
    return picker.exactMatchInput?.checked ? String(picker.searchQuery || '').trim() : '';
}

/**
 * Show the empty-results message, naming the query when an exact match found nothing.
 * @param {string} exact
 */
export function showNoResults(/** @type {ComponentPicker} */ picker, exact) {
    const empty = document.createElement('div');
    empty.className = 'cp-empty';
    empty.textContent = exact ? `No exact match for "${exact}".` : 'No results found.';
    picker.listEl.replaceChildren(empty);
}

/**
 * Displays a loading spinner in the component list area.
 */
export function showLoading(/** @type {ComponentPicker} */ picker) {
    picker.listEl.innerHTML = `
        <div class="cp-loading">
            <span class="cp-spinner"></span>
            Searching online...
        </div>
    `;
}

/**
 * Set the Place button into a loading state with a spinner, or back to ready.
 * @param {string} text - Button label text
 * @param {boolean} loading - If true, show spinner and disable; if false, just set text
 * @param {boolean} [disabled] - Explicit disabled state (default: true when loading)
 */
export function setPlaceBtnLoading(/** @type {ComponentPicker} */ picker, text, loading, disabled = loading) {
    picker.placeBtn.disabled = disabled;
    if (loading) {
        picker.placeBtn.innerHTML = `<span class="cp-spinner"></span>${text}`;
    } else {
        picker.placeBtn.textContent = text;
    }
}

/**
 * Show/hide the large loading overlay below the symbol preview.
 * @param {string|null} message - Message to show, or null to hide
 */
export function setPreviewLoading(/** @type {ComponentPicker} */ picker, message) {
    if (!picker.previewLoadingOverlay) return;
    if (message) {
        if (picker.previewLoadingText) picker.previewLoadingText.textContent = message;
        picker.previewLoadingOverlay.style.display = '';
    } else {
        picker.previewLoadingOverlay.style.display = 'none';
    }
}

/**
 * Displays an indexing progress bar during KiCad library initialization.
 * @param {string} message - Progress message to display.
 * @param {number} loaded - Number of items loaded so far.
 * @param {number} total - Total number of items to load.
 */
export function showIndexingProgress(/** @type {ComponentPicker} */ picker, message, loaded, total) {
    const pct = total > 0 ? Math.min(100, Math.round(loaded / total * 100)) : 0;
    const barStyle = total > 0
        ? `width:${pct}%; animation:none;`
        : '';
    picker.listEl.innerHTML = `
        <div class="cp-loading cp-indexing">
            <span class="cp-spinner"></span>
            <div class="cp-indexing-message">${message || 'Loading KiCad library index...'}</div>
            <div class="cp-progress-bar"><div class="cp-progress-bar-fill" style="${barStyle}"></div></div>
            <div class="cp-indexing-hint">First-time setup — results are cached for future searches</div>
        </div>
    `;
}
