/**
 * Paper Size Management
 * Handles paper size selection and display with persistence
 */

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
 * @param {object} app - Application state.
 */
export function bindPaperEvents(app) {
    app.refreshRibbon?.();
}

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
 * @returns {{width: number, height: number}|null} Size in mm, or `null` if not found.
 */
export function getPaperSize(key) {
    return PAPER_SIZES[key] || null;
}

export { PAPER_SIZES };
