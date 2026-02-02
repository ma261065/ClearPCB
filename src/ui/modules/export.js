export async function savePdf(app) {
    try {
        const pdfFileName = (app.fileManager?.fileName || 'schematic')
            .replace(/\.[^/.]+$/, '') + '.pdf';

        // Save current selection and clear it before export to avoid selection handles
        const previousSelection = app.selection.getSelection();
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

        const pdf = new jsPDF(pdfConfig);

        const svg2pdf = window.svg2pdf?.svg2pdf || window.svg2pdf?.default || window.svg2pdf;
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
        app.selection.clearSelection();
        for (const shape of previousSelection) {
            app.selection.select(shape, true);
        }
        app.renderShapes(true);
    } catch (err) {
        alert('Failed to save PDF: ' + (err?.message || 'Unknown error'));
        // Restore selection in case of error
        app.selection.clearSelection();
        for (const shape of previousSelection) {
            app.selection.select(shape, true);
        }
        app.renderShapes(true);
    }
}

export async function printSchematic(app) {
    try {
        // Save current selection and clear it before print
        const previousSelection = app.selection.getSelection();
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
                app.selection.clearSelection();
                for (const shape of previousSelection) {
                    app.selection.select(shape, true);
                }
                app.renderShapes(true);
            }, 500);
        }, 250);
    } catch (err) {
        alert('Failed to print: ' + (err?.message || 'Unknown error'));
        // Restore selection in case of error
        app.selection.clearSelection();
        const previousSelection = app.selection.getSelection();
        for (const shape of previousSelection) {
            app.selection.select(shape, true);
        }
        app.renderShapes(true);
    }
}

export function loadVectorPdfLibs(app) {
    if (app._pdfVectorLoader) return app._pdfVectorLoader;

    const loadScript = (src) => new Promise((resolve, reject) => {
        const existing = Array.from(document.scripts).find(s => s.src === src);
        if (existing) {
            existing.addEventListener('load', () => resolve());
            existing.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)));
            return;
        }
        const script = document.createElement('script');
        script.src = src;
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`Failed to load ${src}`));
        document.head.appendChild(script);
    });

    app._pdfVectorLoader = (async () => {
        await loadScript('./assets/vendor/jspdf.umd.min.js');
        await loadScript('./assets/vendor/svg2pdf.umd.min.js');

        const svg2pdfFn = window.svg2pdf?.svg2pdf || window.svg2pdf?.default || window.svg2pdf;
        if (!window.jspdf?.jsPDF || typeof svg2pdfFn !== 'function') {
            throw new Error('Vector PDF libraries failed to load');
        }
        return window.jspdf.jsPDF;
    })();

    return app._pdfVectorLoader;
}

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

        if ((fill === null || fill === 'none') && (stroke === null || stroke === 'none')) {
            if (['line', 'path', 'polyline', 'polygon', 'rect', 'circle', 'ellipse'].includes(tag)) {
                el.setAttribute('stroke', '#000000');
            }
        }
    });
}

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
        const style = window.getComputedStyle(origNode);

        for (const prop of props) {
            const cssValue = style[prop];
            if (cssValue && cssValue !== 'initial' && cssValue !== 'inherit') {
                const attr = prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
                cloneNode.setAttribute(attr, cssValue);
            }
        }

        if (origNode.nodeName.toLowerCase() === 'text') {
            cloneNode.textContent = origNode.textContent;
        }

        origNode = origIter.nextNode();
        cloneNode = cloneIter.nextNode();
    }
}

export async function saveBlobAsFile(blob, suggestedName, mimeType, extensions) {
    if ('showSaveFilePicker' in window) {
        try {
            const handle = await window.showSaveFilePicker({
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

export function renderViewportToCanvas(app, scale = 2) {
    return new Promise((resolve, reject) => {
        try {
            const svgNode = app.viewport.svg.cloneNode(true);
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
