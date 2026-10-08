/**
 * PCB-specific PDF/print export and shared export naming.
 *
 * The schematic exporter in `shared/ui/export.js` is tied to schematic
 * concepts (paper size, selection, monochrome line art). The PCB needs a
 * different treatment: bounds come from the board outline, layers keep
 * their colours, and on-screen aids (grid, axes, ratlines, clearance
 * halos, selection halos) are stripped. Only the vendor-loading and
 * blob-saving plumbing is shared.
 */

import {
    loadVectorPdfLibs,
    saveBlobAsFile,
    inlineSvgComputedStyles,
} from '../../shared/ui/export.js';
import { PCB_LAYERS } from './layers.js';
import { stripRemovalHatches } from './removal-hatch.js';
import { boardBoundary } from '../../shared/pcb/board-outline.js';
import { ModalManager } from '../../core/ModalManager.js';
import { uncullAllPlacements, updatePcbCulling } from './component-selection.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Margin around the board outline in the exported page, in millimetres. */
const EXPORT_MARGIN_MM = 5;

/** A4 page dimensions in millimetres (portrait). */
const A4_W = 210;
const A4_H = 297;
/** Page margin used by the "Fit to page" scale mode, in millimetres. */
const FIT_MARGIN_MM = 10;

/**
 * @typedef {object} PdfExportOptions
 * @property {Set<string>} layers Layer ids to include in the export.
 * @property {boolean} mono True for black & white, false to keep layer colours.
 * @property {boolean} invert True to invert (light artwork on dark background).
 * @property {'fit'|'actual'|'custom'} scaleMode Page-sizing strategy.
 * @property {number} scalePercent Percentage for 'custom' (and 'actual' = 100).
 */


/**
 * Derive a sensible base file name (no extension) from the project file.
 * @param {PcbEditor} app
 * @param {string} [fallback='pcb'] Base name when no project filename is available.
 * @returns {string}
 */
export function projectBaseName(app, fallback = 'pcb') {
    const fname = app.project?.fileManager?.fileName || fallback;
    return fname.replace(/\.[^./\\]+$/, '') || fallback;
}

/**
 * Save a Blob to disk. Uses the File System Access API when available
 * (proper Save As dialog), falling back to an anchor download. Returns true
 * if a file was saved, false if the user cancelled the picker.
 * @param {Blob | (() => Promise<Blob>)} blob
 * @param {string} suggestedName
 * @param {{description?: string, accept?: Record<string,string[]>, win?: Window|null}} [opts]
 * @returns {Promise<boolean>}
 */
export async function savePcbBlob(blob, suggestedName, opts = {}) {
    // Run the save in the window that owns the user gesture. When a viewer
    // is torn off into a pop-up, the click happens there — using the opener
    // window's picker/anchor would have no user activation and silently fail.
    const targetWin = /** @type {any} */ (opts.win && !opts.win.closed ? opts.win : window);
    const targetDoc = targetWin.document || document;
    if (typeof targetWin.showSaveFilePicker === 'function') {
        try {
            const handle = await targetWin.showSaveFilePicker({
                suggestedName,
                types: opts.accept ? [{
                    description: opts.description || '',
                    accept: opts.accept,
                }] : undefined,
            });
            const data = typeof blob === 'function' ? await blob() : blob;
            const writable = await handle.createWritable();
            await writable.write(data);
            await writable.close();
            return true;
        } catch (err) {
            // User cancelled — not an error.
            if (err && (err.name === 'AbortError' || err.code === 20)) return false;
            throw err;
        }
    }
    // Fallback: anchor download (Firefox / older browsers).
    const data = typeof blob === 'function' ? await blob() : blob;
    const url = URL.createObjectURL(data);
    const a = targetDoc.createElement('a');
    a.href = url;
    a.download = suggestedName;
    (targetDoc.body || targetDoc.documentElement).appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return true;
}

/** Artwork layer ids (z-ordered, bottom to top). Excludes ratlines/overlays. */
const ARTWORK_LAYER_IDS = [
    'board-outline',
    'bottom-mask', 'top-mask',
    'bottom-paste', 'top-paste',
    'bottom-copper', 'top-copper',
    'bottom-silk', 'top-silk',
    'hole',
    'bottom-document', 'top-document',
];

/**
 * List all artwork layers in z-order, annotated with display name, colour
 * and whether they currently have rendered content (used to decide which
 * checkboxes start ticked).
 * @param {PcbEditor} app
 * @returns {Array<{id: string, name: string, color: string, populated: boolean}>}
 */
export function listArtworkLayers(app) {
    const meta = new Map(PCB_LAYERS.map((l) => [l.id, l]));
    const out = [];
    for (const id of ARTWORK_LAYER_IDS) {
        const g = app.existingLayerGroups().get(id);
        const fill = id === 'top-copper' ? app.existingLayerGroups().get('top-fill')
            : id === 'bottom-copper' ? app.existingLayerGroups().get('bottom-fill') : null;
        const populated = !!(g?.childNodes.length || fill?.childNodes.length);
        const m = meta.get(id);
        out.push({ id, name: m?.name || id, color: m?.color || '#888', populated });
    }
    return out;
}

/**
 * Compute the export bounds (in world/mm coordinates) from the live PCB
 * artwork. Unions the bounding boxes of the included artwork layers so the
 * page is cropped snugly to whatever is actually being exported, rather
 * than to the (possibly mismatched) nominal board-outline dimensions.
 * @param {PcbEditor} app
 * @param {Set<string>} [layers] Layer ids to measure; defaults to all artwork.
 * @returns {{x: number, y: number, w: number, h: number}}
 */
function getArtworkBoundsMm(app, layers) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const id of [...ARTWORK_LAYER_IDS, 'top-fill', 'bottom-fill']) {
        const owner = id === 'top-fill' ? 'top-copper' : id === 'bottom-fill' ? 'bottom-copper' : id;
        if (layers && !layers.has(owner)) continue;
        const g = app.existingLayerGroups().get(id);
        if (!g || !g.childNodes.length) continue;
        let bb;
        try {
            bb = g.getBBox();
        } catch {
            continue; // not rendered (e.g. hidden layer)
        }
        if (!bb || (bb.width === 0 && bb.height === 0)) continue;
        minX = Math.min(minX, bb.x);
        minY = Math.min(minY, bb.y);
        maxX = Math.max(maxX, bb.x + bb.width);
        maxY = Math.max(maxY, bb.y + bb.height);
    }
    if (!Number.isFinite(minX)) {
        // Nothing measurable — fall back to the nominal board outline.
        return boardBoundary(app);
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Force every drawable element under `root` to a single colour (used for
 * black & white export). Leaves `fill="none"` / `stroke="none"` intact so
 * intentionally-invisible elements stay invisible.
 * @param {Element} root
 * @param {string} color
 */
function forceMono(root, color) {
    root.querySelectorAll('*').forEach((el) => {
        const fill = el.getAttribute('fill');
        const stroke = el.getAttribute('stroke');
        if (fill && fill !== 'none') el.setAttribute('fill', color);
        if (stroke && stroke !== 'none') el.setAttribute('stroke', color);
    });
}


/**
 * Deep-clone the PCB viewport SVG for export: crop to the included
 * artwork bounds (plus a margin), drop non-artwork layers, unselected
 * layers, and on-screen aids, then apply colour / mono / invert options.
 * @param {PcbEditor} app
 * @param {PdfExportOptions} [opts]
 * @returns {{svgNode: SVGSVGElement, widthMm: number, heightMm: number}}
 */
export function clonePcbViewportForExport(app, opts) {
    const layers = opts?.layers || null;
    const mono = !!opts?.mono;
    const invert = !!opts?.invert;

    const viewport = /** @type {NonNullable<PcbEditor['viewport']>} */ (app.viewport);
    const originalSvg = viewport.svg;
    let svgNode, b;
    uncullAllPlacements(app);
    try {
        svgNode = /** @type {SVGSVGElement} */ (originalSvg.cloneNode(true));
        b = getArtworkBoundsMm(app, layers || undefined);
    } finally {
        updatePcbCulling(app);
    }
    const m = EXPORT_MARGIN_MM;
    const vbX = b.x - m;
    const vbY = b.y - m;
    const vbW = b.w + 2 * m;
    const vbH = b.h + 2 * m;

    const bgColor = invert ? '#000000' : '#ffffff';

    svgNode.setAttribute('xmlns', SVG_NS);
    svgNode.setAttribute('width', String(vbW));
    svgNode.setAttribute('height', String(vbH));
    svgNode.setAttribute('viewBox', `${vbX} ${vbY} ${vbW} ${vbH}`);
    svgNode.setAttribute('style', `background:${bgColor}`);

    // Copy computed colours/strokes from the live SVG so CSS-styled layers
    // survive serialization.
    inlineSvgComputedStyles(originalSvg, svgNode);

    // Strip viewport chrome and non-artwork layers.
    const dropSelectors = [
        '#gridLayer',
        '#axesLayer',
        '#paperOutlineLayer',
        // The editor's <defs>: copper-cut clips are sized to the on-screen view.
        '[data-pcb-defs]',
        '[data-layer="ratlines"]',
        '[data-layer="clearance-overlay"]',
        '.pcb-box-track-sel',
        '.pcb-box-via-sel',
        '.pcb-box-comp-sel',
    ];
    for (const sel of dropSelectors) {
        svgNode.querySelectorAll(sel).forEach((el) => el.remove());
    }
    const artwork = new Set(ARTWORK_LAYER_IDS);
    for (const group of svgNode.querySelectorAll('[data-layer]')) {
        const id = group.getAttribute('data-layer');
        if (!id) {
            group.remove();
            continue;
        }
        const owner = id === 'top-fill' ? 'top-copper' : id === 'bottom-fill' ? 'bottom-copper' : id;
        if (!artwork.has(owner) || (layers && !layers.has(owner))) group.remove();
    }
    svgNode.querySelectorAll('.culled').forEach((element) => element.classList.remove('culled'));
    svgNode.querySelectorAll('.pcb-fp-lod').forEach((element) => element.remove());

    // Strip transient selection / hover halos.
    svgNode.querySelectorAll('.pcb-track-selection, .pcb-track-hover')
        .forEach((el) => el.remove());

    // Copper-removal hatching is an on-screen aid; exports show those shapes as outlines.
    stripRemovalHatches(svgNode);

    // Colour treatment. Black & white forces a single ink colour; inverted
    // B&W draws white-on-black (photo negative). Colour mode keeps the
    // layer colours (inverted colour just darkens the background).
    if (mono) {
        forceMono(svgNode, invert ? '#ffffff' : '#000000');
    }

    // Opaque background behind the artwork.
    const bgRect = document.createElementNS(SVG_NS, 'rect');
    bgRect.setAttribute('x', String(vbX));
    bgRect.setAttribute('y', String(vbY));
    bgRect.setAttribute('width', String(vbW));
    bgRect.setAttribute('height', String(vbH));
    bgRect.setAttribute('fill', bgColor);
    bgRect.setAttribute('stroke', 'none');
    svgNode.insertBefore(bgRect, svgNode.firstChild);

    return { svgNode, widthMm: vbW, heightMm: vbH };
}

/**
 * Show the PCB PDF export options dialog (scale, layers, colour, invert)
 * and resolve with the chosen options, or null if cancelled.
 * @param {PcbEditor} app
 * @returns {Promise<PdfExportOptions|null>}
 */
function showPdfExportDialog(app) {
    return new Promise((resolve) => {
        const populated = listArtworkLayers(app);

        const overlay = document.createElement('div');
        overlay.className = 'app-modal-overlay';

        const layerRows = populated.map((l) => `
            <label style="display:flex;align-items:center;gap:8px;padding:3px 0;cursor:pointer">
                <input type="checkbox" class="pdfLayerChk" value="${l.id}"${l.populated ? ' checked' : ''}>
                <span style="display:inline-block;width:12px;height:12px;border-radius:2px;background:${l.color};border:1px solid rgba(0,0,0,0.3)"></span>
                <span${l.populated ? '' : ' style="color:var(--text-secondary)"'}>${l.name}</span>
            </label>`).join('');

        overlay.innerHTML = `
            <div class="app-modal" style="min-width:360px;max-width:420px">
                <div class="app-modal-title">Export PDF</div>
                <div style="display:flex;flex-direction:column;gap:14px;margin-top:8px">
                    <div>
                        <label style="font-size:11px;color:var(--text-secondary)">Scale</label>
                        <div style="display:flex;gap:8px;align-items:center;margin-top:4px">
                            <select class="app-modal-input" id="pdfScaleMode" style="flex:1">
                                <option value="fit">Fit to page (A4)</option>
                                <option value="actual" selected>Actual size (1:1)</option>
                                <option value="custom">Custom %</option>
                            </select>
                            <input class="app-modal-input" id="pdfScalePct" type="number" value="100" min="1" max="1000" step="1" style="width:80px" disabled>
                            <span style="font-size:12px;color:var(--text-secondary)">%</span>
                        </div>
                    </div>
                    <div>
                        <label style="font-size:11px;color:var(--text-secondary)">Colour</label>
                        <div style="display:flex;gap:16px;margin-top:4px">
                            <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
                                <input type="radio" name="pdfColor" value="color" checked> Colour
                            </label>
                            <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
                                <input type="radio" name="pdfColor" value="bw"> Black &amp; white
                            </label>
                        </div>
                    </div>
                    <div>
                        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
                            <input type="checkbox" id="pdfInvert"> Invert (light artwork on dark background)
                        </label>
                    </div>
                    <div>
                        <label style="font-size:11px;color:var(--text-secondary)">Layers</label>
                        <div style="margin-top:4px;border:1px solid var(--border-color,#444);border-radius:4px;padding:6px 8px">
                            ${layerRows || '<div style="font-size:12px;color:var(--text-secondary)">No artwork to export.</div>'}
                        </div>
                    </div>
                </div>
                <div class="app-modal-actions">
                    <button class="app-modal-btn app-modal-cancel" id="pdfDlgCancel">Cancel</button>
                    <button class="app-modal-btn app-modal-ok" id="pdfDlgOk">Export</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);

        const scaleMode = /** @type {HTMLSelectElement} */ (overlay.querySelector('#pdfScaleMode'));
        const scalePct = /** @type {HTMLInputElement} */ (overlay.querySelector('#pdfScalePct'));
        const invertChk = /** @type {HTMLInputElement} */ (overlay.querySelector('#pdfInvert'));
        const okBtn = overlay.querySelector('#pdfDlgOk');
        const cancelBtn = overlay.querySelector('#pdfDlgCancel');

        // The percentage field is only meaningful for Custom; for Actual it
        // is pinned at 100 and disabled.
        const syncScaleUi = () => {
            const mode = scaleMode.value;
            scalePct.disabled = mode !== 'custom';
            if (mode === 'actual') scalePct.value = '100';
        };
        scaleMode.addEventListener('change', syncScaleUi);
        syncScaleUi();

        let settled = false;
        /** @param {PdfExportOptions|null} result */
        const close = (result) => {
            if (settled) return;
            settled = true;
            ModalManager.pop('pdfExport');
            overlay.remove();
            resolve(result);
        };

        const accept = () => {
            const layers = new Set(
                Array.from(overlay.querySelectorAll('.pdfLayerChk'))
                    .filter((c) => /** @type {HTMLInputElement} */ (c).checked)
                    .map((c) => /** @type {HTMLInputElement} */ (c).value)
            );
            if (layers.size === 0) {
                app.setStatus('Select at least one layer to export');
                return;
            }
            const colorMode = /** @type {HTMLInputElement} */ (
                overlay.querySelector('input[name="pdfColor"]:checked'));
            const mode = /** @type {'fit'|'actual'|'custom'} */ (scaleMode.value);
            let pct = parseFloat(scalePct.value);
            if (!Number.isFinite(pct) || pct <= 0) pct = 100;
            close({
                layers,
                mono: colorMode?.value === 'bw',
                invert: invertChk.checked,
                scaleMode: mode,
                scalePercent: mode === 'actual' ? 100 : pct,
            });
        };

        okBtn?.addEventListener('click', accept);
        cancelBtn?.addEventListener('click', () => close(null));
        ModalManager.push('pdfExport', () => close(null));
    });
}

/**
 * Export the PCB to a vector PDF. Presents an options dialog (scale,
 * layers, colour, invert), then renders and prompts to save.
 * @param {PcbEditor} app
 */
export async function savePcbPdf(app) {
    const opts = await showPdfExportDialog(app);
    if (!opts) return; // cancelled

    try {
        const pdfFileName = projectBaseName(app) + '-pcb.pdf';

        const jsPDF = await loadVectorPdfLibs(app);
        const { svgNode, widthMm, heightMm } = clonePcbViewportForExport(app, opts);

        const w = /** @type {any} */ (window);
        const svg2pdf = w.svg2pdf?.svg2pdf || w.svg2pdf?.default || w.svg2pdf;
        if (typeof svg2pdf !== 'function') {
            throw new Error('svg2pdf is not available');
        }

        const JsPdfCtor = /** @type {any} */ (jsPDF);
        let pdf;
        /** @type {{x: number, y: number, width: number, height: number}} */
        let draw;

        if (opts.scaleMode === 'fit') {
            // Standard A4 page; artwork scaled to fit within margins.
            const landscape = widthMm >= heightMm;
            const pageW = landscape ? A4_H : A4_W;
            const pageH = landscape ? A4_W : A4_H;
            const avW = pageW - 2 * FIT_MARGIN_MM;
            const avH = pageH - 2 * FIT_MARGIN_MM;
            const scale = Math.min(avW / widthMm, avH / heightMm);
            const drawW = widthMm * scale;
            const drawH = heightMm * scale;
            pdf = new JsPdfCtor({
                orientation: landscape ? 'landscape' : 'portrait',
                unit: 'mm',
                format: 'a4',
            });
            draw = {
                x: (pageW - drawW) / 2,
                y: (pageH - drawH) / 2,
                width: drawW,
                height: drawH,
            };
        } else {
            // Actual size (1:1) or custom percentage — the page is sized to
            // the (scaled) artwork so it prints at an exact known scale.
            const f = (opts.scalePercent || 100) / 100;
            const pageW = widthMm * f;
            const pageH = heightMm * f;
            pdf = new JsPdfCtor({
                orientation: pageW >= pageH ? 'landscape' : 'portrait',
                unit: 'mm',
                format: [pageW, pageH],
            });
            draw = { x: 0, y: 0, width: pageW, height: pageH };
        }

        const result = svg2pdf(svgNode, pdf, draw);
        if (result?.then) await result;

        const pdfBlob = pdf.output('blob');
        await saveBlobAsFile(pdfBlob, pdfFileName, 'application/pdf', ['.pdf']);
        app.setStatus('PCB exported to PDF');
    } catch (err) {
        console.error('PCB PDF export failed:', err);
        app.setStatus(`PDF export failed: ${err?.message || err}`);
    }
}

/**
 * Print the PCB via a hidden iframe, sized to the board outline.
 * @param {PcbEditor} app
 */
export async function printPcb(app) {
    try {
        const { svgNode, widthMm, heightMm } = clonePcbViewportForExport(app);

        // Let the SVG scale to fill the printable page. Print preview
        // commonly ignores a custom @page size and falls back to A4, so
        // pinning the SVG to the board's mm size leaves a tiny island in
        // the middle of a large sheet. Filling 100% (with the viewBox
        // preserving aspect ratio) makes the board fit the page instead.
        const landscape = widthMm >= heightMm;
        svgNode.setAttribute('width', '100%');
        svgNode.setAttribute('height', '100%');
        svgNode.setAttribute('preserveAspectRatio', 'xMidYMid meet');

        const iframe = document.createElement('iframe');
        iframe.style.display = 'none';
        iframe.style.width = '1px';
        iframe.style.height = '1px';
        document.body.appendChild(iframe);

        const iframeWin = /** @type {Window} */ (iframe.contentWindow);
        const iframeDoc = iframe.contentDocument || iframeWin.document;
        iframeDoc.open();
        iframeDoc.write('<!DOCTYPE html><html><head><title>Print PCB</title></head><body></body></html>');
        iframeDoc.close();

        const style = iframeDoc.createElement('style');
        style.textContent = `
            * { margin: 0 !important; padding: 0 !important; box-sizing: border-box !important; }
            @page { size: A4 ${landscape ? 'landscape' : 'portrait'}; margin: 10mm !important; }
            @media print {
                body { margin: 0 !important; padding: 0 !important; }
                html { margin: 0 !important; padding: 0 !important; }
            }
            html, body { width: 100%; height: 100%; margin: 0 !important; padding: 0 !important; background: white; overflow: hidden; }
            svg { display: block; width: 100%; height: 100%; margin: 0 !important; }
        `;
        iframeDoc.head.appendChild(style);

        // Import the cloned SVG (built only from DOM APIs — never re-parsed
        // from a user-derived string) into the iframe document.
        const importedSvg = iframeDoc.importNode(svgNode, true);
        iframeDoc.body.appendChild(importedSvg);

        const doPrint = () => {
            try {
                iframeWin.focus();
                iframeWin.print();
            } finally {
                setTimeout(() => {
                    if (iframe.parentNode) document.body.removeChild(iframe);
                }, 500);
            }
        };
        if (iframeWin.document.readyState === 'complete') {
            requestAnimationFrame(doPrint);
        } else {
            iframe.addEventListener('load', doPrint, { once: true });
        }
    } catch (err) {
        console.error('PCB print failed:', err);
        app.setStatus(`Print failed: ${err?.message || err}`);
    }
}
