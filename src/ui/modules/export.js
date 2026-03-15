import { showAlert } from './modal.js';

/**
 * Exports the schematic to a vector PDF using jsPDF + svg2pdf,
 * then prompts the user for a save location.
 * @param {object} app - Application state.
 */
export async function savePdf(app) {
    // Save current selection before try block so it's accessible in catch
    const previousSelection = app.selection.getSelection();
    try {
        const pdfFileName = (app.fileManager?.fileName || 'schematic')
            .replace(/\.[^/.]+$/, '') + '.pdf';

        // Clear selection before export to avoid selection handles
        app.selection.clearSelection();
        app.renderShapes(true);

        const jsPDF = await loadVectorPdfLibs(app);
        const { svgNode, paperSize } = cloneViewportSvgForExport(app);
        const width = Number(svgNode.getAttribute('width'));
        const height = Number(svgNode.getAttribute('height'));

        // If paper size is set, use paper dimensions for PDF
        const pdfConfig = paperSize 
            ? {
                orientation: paperSize.width >= paperSize.height ? 'landscape' : 'portrait',
                unit: 'mm',
                format: [paperSize.width, paperSize.height]
              }
            : {
                orientation: width >= height ? 'landscape' : 'portrait',
                unit: 'px',
                format: [width, height]
              };

        const JsPdfCtor = /** @type {any} */ (jsPDF);
        const pdf = new JsPdfCtor(pdfConfig);

        const w = /** @type {any} */ (window);
        const svg2pdf = w.svg2pdf?.svg2pdf || w.svg2pdf?.default || w.svg2pdf;
        if (typeof svg2pdf !== 'function') {
            throw new Error('svg2pdf is not available');
        }

        const result = svg2pdf(svgNode, pdf, {
            x: 0,
            y: 0,
            width,
            height
        });
        if (result?.then) {
            await result;
        }

        const pdfBlob = pdf.output('blob');
        await saveBlobAsFile(pdfBlob, pdfFileName, 'application/pdf', ['.pdf']);

        // Restore previous selection
        app.selection.selectMultiple(previousSelection, false);
        app.renderShapes(true);
    } catch (err) {
            showAlert('Failed to save PDF: ' + (err?.message || 'Unknown error'), { title: 'Export Failed' });
        // Restore selection in case of error
        app.selection.selectMultiple(previousSelection, false);
        app.renderShapes(true);
    }
}

/**
 * Prints the schematic via a hidden iframe with proper page sizing and margins.
 * @param {object} app - Application state.
 */
export async function printSchematic(app) {
    // Save current selection before try block so it's accessible in catch
    const previousSelection = app.selection.getSelection();
    try {
        // Clear selection before print
        app.selection.clearSelection();
        app.renderShapes(true);

        // Create a temporary print window with the SVG
        const { svgNode, paperSize } = cloneViewportSvgForExport(app);
        
        // Get paper dimensions (in mm) - A4 is 210×297mm by default
        let paperWidth = 210;   // mm
        let paperHeight = 297;  // mm
        if (paperSize) {
            paperWidth = paperSize.width;
            paperHeight = paperSize.height;
        }
        
        // Keep SVG dimensions in mm for proper print scaling
        svgNode.setAttribute('width', paperWidth + 'mm');
        svgNode.setAttribute('height', paperHeight + 'mm');
        
        const svgString = new XMLSerializer().serializeToString(svgNode);
        
        // Create an invisible iframe for printing
        const iframe = document.createElement('iframe');
        iframe.style.display = 'none';
        iframe.style.width = '1px';
        iframe.style.height = '1px';
        document.body.appendChild(iframe);

        // Write HTML content to iframe with proper page sizing
        const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
        iframeDoc.open();
        iframeDoc.write(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Print Schematic</title>
                <style>
                    * { margin: 0 !important; padding: 0 !important; box-sizing: border-box !important; }
                    @page {
                        size: ${paperWidth}mm ${paperHeight}mm;
                        margin: 0 !important;
                    }
                    @media print {
                        body { margin: 0 !important; padding: 5mm !important; }
                        html { margin: 0 !important; padding: 0 !important; }
                    }
                    html { 
                        width: 100%;
                        height: 100%;
                        margin: 0 !important;
                        padding: 0 !important;
                    }
                    body { 
                        width: 100%;
                        height: 100%;
                        margin: 0 !important;
                        padding: 5mm !important; /* Force 5mm safe zone */
                        background: white;
                        overflow: hidden;
                    }
                    svg { 
                        width: 100%;
                        height: 100%;
                        display: block;
                        margin: 0 !important;
                        padding: 0 !important;
                    }
                </style>
            </head>
            <body>
                ${svgString}
            </body>
            </html>
        `);
        iframeDoc.close();

        // Wait for iframe to load, then print
        setTimeout(() => {
            iframe.contentWindow.focus();
            iframe.contentWindow.print();
            
            // Remove iframe after print completes
            setTimeout(() => {
                document.body.removeChild(iframe);
                
                // Restore selection
                app.selection.selectMultiple(previousSelection, false);
                app.renderShapes(true);
            }, 500);
        }, 250);
    } catch (err) {
            showAlert('Failed to print: ' + (err?.message || 'Unknown error'), { title: 'Print Failed' });
        // Restore selection in case of error
        app.selection.selectMultiple(previousSelection, false);
        app.renderShapes(true);
    }
}

/**
 * Lazy-loads jspdf and svg2pdf vendor scripts.
 * @param {object} app - Application state.
 * @returns {Promise<Function>} Resolves to the `jsPDF` constructor.
 */
export function loadVectorPdfLibs(app) {
    if (app._pdfVectorLoader) return app._pdfVectorLoader;

    const loadScript = (src) => new Promise((resolve, reject) => {
        const existing = Array.from(document.scripts).find(s => s.src === src);
        if (existing) {
            // Script tag already in DOM — if it has already loaded, resolve immediately
            if (existing.dataset.loaded === 'true') {
                resolve();
            } else if (existing.dataset.failed === 'true') {
                reject(new Error(`Failed to load ${src}`));
            } else {
                existing.addEventListener('load', () => resolve());
                existing.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)));
            }
            return;
        }
        const script = document.createElement('script');
        script.src = src;
        script.async = true;
        script.onload = () => { script.dataset.loaded = 'true'; resolve(); };
        script.onerror = () => { script.dataset.failed = 'true'; reject(new Error(`Failed to load ${src}`)); };
        document.head.appendChild(script);
    });

    app._pdfVectorLoader = (async () => {
        await loadScript('./assets/vendor/jspdf.umd.min.js');
        await loadScript('./assets/vendor/svg2pdf.umd.min.js');

        const w = /** @type {any} */ (window);
        const svg2pdfFn = w.svg2pdf?.svg2pdf || w.svg2pdf?.default || w.svg2pdf;
        if (!w.jspdf?.jsPDF || typeof svg2pdfFn !== 'function') {
            throw new Error('Vector PDF libraries failed to load');
        }
        return w.jspdf.jsPDF;
    })();

    return app._pdfVectorLoader;
}

/**
 * Deep-clones the viewport SVG, sets viewBox to paper or viewport bounds,
 * inlines styles, forces monochrome, and removes grid/axes layers.
 * @param {object} app - Application state.
 * @returns {{svgNode: SVGSVGElement, paperSize: {width: number, height: number}|null}}
 */
export function cloneViewportSvgForExport(app) {
    const originalSvg = app.viewport.svg;
    const svgNode = originalSvg.cloneNode(true);
    const vb = app.viewport.viewBox;
    const width = Math.max(1, Math.round(app.viewport.width));
    const height = Math.max(1, Math.round(app.viewport.height));
    
    // If paper size is set, use paper bounds for export instead of viewport
    const paperSize = app.viewport.paperSize;
    let exportViewBox = vb;
    let exportWidth = width;
    let exportHeight = height;
    
    if (paperSize) {
        // Paper is positioned at (0, -height) in world coords
        // Set viewBox to match paper bounds
        exportViewBox = {
            x: 0,
            y: -paperSize.height,
            width: paperSize.width,
            height: paperSize.height
        };
        exportWidth = paperSize.width;
        exportHeight = paperSize.height;
    }

    svgNode.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    svgNode.setAttribute('width', String(exportWidth));
    svgNode.setAttribute('height', String(exportHeight));
    svgNode.setAttribute('viewBox', `${exportViewBox.x} ${exportViewBox.y} ${exportViewBox.width} ${exportViewBox.height}`);
    svgNode.setAttribute('style', 'background:#ffffff');

    inlineSvgComputedStyles(originalSvg, svgNode);

    forceMonochromeSvg(svgNode);

    const gridLayer = svgNode.querySelector('#gridLayer');
    if (gridLayer) {
        gridLayer.remove();
    }

    const axesLayer = svgNode.querySelector('#axesLayer');
    if (axesLayer) {
        axesLayer.remove();
    }
    
    // Keep paper outline if paper size is set
    const paperOutlineLayer = svgNode.querySelector('#paperOutlineLayer');
    if (paperOutlineLayer && !paperSize) {
        // Only remove if no paper size is set
        paperOutlineLayer.remove();
    }

    const bgRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bgRect.setAttribute('x', String(exportViewBox.x));
    bgRect.setAttribute('y', String(exportViewBox.y));
    bgRect.setAttribute('width', String(exportViewBox.width));
    bgRect.setAttribute('height', String(exportViewBox.height));
    bgRect.setAttribute('fill', '#ffffff');
    bgRect.setAttribute('stroke', 'none');
    svgNode.insertBefore(bgRect, svgNode.firstChild);

    return { svgNode, paperSize };
}

/**
 * Walks all SVG descendants and forces strokes/fills to black and text to
 * black, for print-friendly output.
 * @param {SVGElement} svgRoot - Root SVG element to process.
 */
export function forceMonochromeSvg(svgRoot) {
    const nodes = svgRoot.querySelectorAll('*');
    nodes.forEach((el) => {
        const tag = el.tagName?.toLowerCase();
        if (!tag) return;

        if (el.getAttribute('opacity')) {
            el.setAttribute('opacity', '1');
        }

        if (tag === 'text') {
            el.setAttribute('fill', '#000000');
            el.setAttribute('stroke', 'none');
            return;
        }

        const fill = el.getAttribute('fill');
        const stroke = el.getAttribute('stroke');

        if (fill && fill !== 'none') {
            el.setAttribute('fill', '#000000');
        }

        if (stroke && stroke !== 'none') {
            el.setAttribute('stroke', '#000000');
        }

        // Safety net: force stroke only when fill is truly missing (null),
        // NOT when it's explicitly "none" (intentionally invisible element)
        if (fill === null && (stroke === null || stroke === 'none')) {
            if (['line', 'path', 'polyline', 'polygon', 'rect', 'circle', 'ellipse'].includes(tag)) {
                el.setAttribute('stroke', '#000000');
            }
        }
    });
}

/**
 * Copies computed CSS properties (fill, stroke, font, etc.) from the live SVG
 * to a cloned SVG so styles survive serialization.
 * @param {SVGSVGElement} originalSvg - The live SVG in the DOM.
 * @param {SVGSVGElement} clonedSvg - The deep-cloned SVG to receive styles.
 */
export function inlineSvgComputedStyles(originalSvg, clonedSvg) {
    const props = [
        'fill',
        'stroke',
        'strokeWidth',
        'fontSize',
        'fontFamily',
        'fontWeight',
        'fontStyle',
        'textAnchor',
        'dominantBaseline',
        'opacity'
    ];

    const origIter = document.createNodeIterator(originalSvg, NodeFilter.SHOW_ELEMENT);
    const cloneIter = document.createNodeIterator(clonedSvg, NodeFilter.SHOW_ELEMENT);

    let origNode = origIter.nextNode();
    let cloneNode = cloneIter.nextNode();

    while (origNode && cloneNode) {
        if (origNode.nodeType === Node.ELEMENT_NODE && cloneNode.nodeType === Node.ELEMENT_NODE) {
            const origEl = /** @type {Element} */ (origNode);
            const cloneEl = /** @type {Element} */ (cloneNode);
            const style = window.getComputedStyle(origEl);

            for (const prop of props) {
                const cssValue = style[prop];
                if (cssValue && cssValue !== 'initial' && cssValue !== 'inherit') {
                    const attr = prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
                    cloneEl.setAttribute(attr, cssValue);
                }
            }

            if (origEl.nodeName.toLowerCase() === 'text') {
                cloneEl.textContent = origEl.textContent;
            }
        }

        origNode = origIter.nextNode();
        cloneNode = cloneIter.nextNode();
    }
}

/**
 * Saves a Blob using the File System Access API (`showSaveFilePicker`)
 * with fallback to a download link.
 * @param {Blob} blob - Data to save.
 * @param {string} suggestedName - Default file name.
 * @param {string} mimeType - MIME type for the file.
 * @param {string[]} extensions - Accepted file extensions (e.g. `['.pdf']`).
 */
export async function saveBlobAsFile(blob, suggestedName, mimeType, extensions) {
    const savePicker = /** @type {any} */ (window).showSaveFilePicker;
    if (typeof savePicker === 'function') {
        try {
            const handle = await savePicker({
                suggestedName,
                types: [{ description: 'PDF', accept: { [mimeType]: extensions } }]
            });
            const writable = await handle.createWritable();
            await writable.write(blob);
            await writable.close();
            return;
        } catch (err) {
            if (err?.name === 'AbortError') return;
            throw err;
        }
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = suggestedName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

/**
 * Returns a Promise resolving to an HTML `<canvas>` with the viewport
 * rendered as a rasterized image at the given scale.
 * @param {object} app - Application state.
 * @param {number} [scale=2] - Pixel density multiplier.
 * @returns {Promise<HTMLCanvasElement>}
 */
export function renderViewportToCanvas(app, scale = 2) {
    return new Promise((resolve, reject) => {
        try {
            const svgNode = app.viewport.svg.cloneNode(true);
            inlineSvgComputedStyles(app.viewport.svg, svgNode);
            const vb = app.viewport.viewBox;

            const width = Math.max(1, Math.round(app.viewport.width * scale));
            const height = Math.max(1, Math.round(app.viewport.height * scale));

            svgNode.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
            svgNode.setAttribute('width', String(width));
            svgNode.setAttribute('height', String(height));
            svgNode.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.width} ${vb.height}`);

            const bgRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            bgRect.setAttribute('x', String(vb.x));
            bgRect.setAttribute('y', String(vb.y));
            bgRect.setAttribute('width', String(vb.width));
            bgRect.setAttribute('height', String(vb.height));
            bgRect.setAttribute('fill', '#ffffff');
            svgNode.insertBefore(bgRect, svgNode.firstChild);

            const svgData = new XMLSerializer().serializeToString(svgNode);
            const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
            const url = URL.createObjectURL(svgBlob);

            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                URL.revokeObjectURL(url);
                resolve(canvas);
            };
            img.onerror = () => {
                URL.revokeObjectURL(url);
                reject(new Error('Failed to render SVG'));
            };
            img.src = url;
        } catch (err) {
            reject(err);
        }
    });
}
