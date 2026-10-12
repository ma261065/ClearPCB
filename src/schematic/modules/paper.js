/**
 * Paper Size Management
 * Handles paper size selection and display with persistence
 */
/** @typedef {import('./schematic-editor-api.js').SchematicEditor} SchematicEditor */
/** @typedef {{width: number, height: number}} PaperSize */
/** @typedef {keyof typeof PAPER_SIZES} PaperSizeKey */
/** @typedef {'portrait'|'landscape'} PaperOrientation */

// Standard paper sizes in mm (width × height)
const PAPER_SIZES = {
    // Metric
    'A4': { width: 210, height: 297 },
    'A3': { width: 297, height: 420 },
    'A2': { width: 420, height: 594 },
    'A1': { width: 594, height: 841 },
    'A0': { width: 841, height: 1189 },
    
    // Imperial (converted to mm)
    'Letter': { width: 215.9, height: 279.4 },  // 8.5 × 11 inch
    'Legal': { width: 215.9, height: 355.6 },   // 8.5 × 14 inch
    'Tabloid': { width: 279.4, height: 431.8 }  // 11 × 17 inch
};

const STORAGE_KEY = 'clearpcb_paper_size';
const ORIENTATION_KEY = 'clearpcb_paper_orientation';
const TITLE_BLOCK_KEY = 'clearpcb_title_block';
const TITLE_BLOCK_INFO_KEY = 'clearpcb_title_block_info';

/**
 * Binds change listeners for paper size, orientation, and title block
 * checkboxes; restores persisted state from localStorage.
 * @param {SchematicEditor} app
 */
export function bindPaperEvents(app) {
    app.refreshRibbon?.();
}

/**
 * @param {SchematicEditor} app
 * @param {PaperSizeKey} paperSizeKey
 * @param {PaperOrientation} orientation
 */
function updatePaperDisplay(app, paperSizeKey, orientation) {
    let size = { ...PAPER_SIZES[paperSizeKey] };  // Make a copy
    
    // Swap width/height for portrait orientation
    if (orientation === 'portrait') {
        // Ensure width < height for portrait
        if (size.width > size.height) {
            [size.width, size.height] = [size.height, size.width];
        }
    } else {
        // Ensure width > height for landscape
        if (size.width < size.height) {
            [size.width, size.height] = [size.height, size.width];
        }
    }
    
    app.viewport.setPaperSize(size, paperSizeKey);
}

/**
 * Returns the width and height (in mm) for a named paper size key.
 * @param {string} key - Paper size key (e.g. `'A4'`, `'Letter'`).
 * @returns {PaperSize|null} Size in mm, or `null` if not found.
 */
export function getPaperSize(key) {
    return PAPER_SIZES[/** @type {PaperSizeKey} */ (key)] || null;
}

/**
 * @param {string|null|undefined} key
 * @returns {key is PaperSizeKey}
 */
export function isPaperSizeKey(key) {
    return typeof key === 'string' && Object.hasOwn(PAPER_SIZES, key);
}

export { PAPER_SIZES };
