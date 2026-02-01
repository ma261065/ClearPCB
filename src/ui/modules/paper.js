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

export function bindPaperEvents(app) {
    const paperSelect = document.getElementById('paperSize');
    const orientationSelect = document.getElementById('paperOrientation');
    
    if (!paperSelect) return;
    
    // Restore saved orientation
    const savedOrientation = localStorage.getItem(ORIENTATION_KEY) || 'landscape';
    if (orientationSelect) {
        orientationSelect.value = savedOrientation;
    }
    
    // Restore saved paper size with current orientation
    const savedPaperSize = localStorage.getItem(STORAGE_KEY);
    
    if (savedPaperSize && PAPER_SIZES[savedPaperSize]) {
        paperSelect.value = savedPaperSize;
        updatePaperDisplay(app, savedPaperSize, savedOrientation);
    }
    
    paperSelect.addEventListener('change', (e) => {
        const paperSizeKey = e.target.value;
        const orientation = orientationSelect ? orientationSelect.value : 'landscape';
        
        if (!paperSizeKey || !PAPER_SIZES[paperSizeKey]) {
            app.viewport.setPaperSize(null, null);
            localStorage.removeItem(STORAGE_KEY);
        } else {
            updatePaperDisplay(app, paperSizeKey, orientation);
            localStorage.setItem(STORAGE_KEY, paperSizeKey);
        }
    });
    
    if (orientationSelect) {
        orientationSelect.addEventListener('change', (e) => {
            const orientation = e.target.value;
            const paperSizeKey = paperSelect.value;
            
            localStorage.setItem(ORIENTATION_KEY, orientation);
            
            if (paperSizeKey && PAPER_SIZES[paperSizeKey]) {
                updatePaperDisplay(app, paperSizeKey, orientation);
            }
        });
    }
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

export function getPaperSize(key) {
    return PAPER_SIZES[key] || null;
}

export { PAPER_SIZES };
