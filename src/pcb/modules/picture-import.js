import { ModalManager } from '../../core/ModalManager.js';
import { isLayerLocked, isLayerVisible } from './layers.js';
import { showBoardShapeProperties } from './board-shapes.js';
import { AddBoardShapeCommand } from './shape-commands.js';
import { setPcbSelection } from './selection-registry.js';
import { renderPcbSelectionAnchors } from './selection-anchors.js';
import { rasterizePicture, pictureShape, drawPicture, MAX_PICTURE_REGIONS, MAX_PICTURE_VERTICES, MAX_PICTURE_CIRCLES, MAX_TRACE_RESOLUTION } from './picture-raster.js';

export function showPictureImport(app) {
    if (document.getElementById('pcb-picture-import')) return;
    const dialog = document.createElement('dialog');
    dialog.id = 'pcb-picture-import';
    dialog.className = 'app-modal picture-import';
    dialog.setAttribute('aria-labelledby', 'picture-import-title');
    dialog.innerHTML = `
        <form method="dialog">
            <div class="app-modal-title" id="picture-import-title">Import Picture</div>
            <label class="picture-file">Image<input name="file" type="file" accept="image/png,image/jpeg,.png,.jpg,.jpeg" required></label>
            <div class="picture-previews">
                <figure><figcaption>Original</figcaption><canvas data-preview="original" width="256" height="180" aria-label="Original image"></canvas></figure>
                <figure><figcaption>Artwork</figcaption><canvas data-preview="artwork" width="256" height="180" aria-label="Thresholded artwork"></canvas></figure>
            </div>
            <div class="picture-fields">
                <label>Layer<select name="layer" class="app-modal-input">
                    <option value="top-silk">Top Silk</option><option value="bottom-silk">Bottom Silk</option>
                    <option value="top-copper">Top Copper</option><option value="bottom-copper">Bottom Copper</option>
                    <option value="top-document">Top Document</option><option value="bottom-document">Bottom Document</option>
                </select></label>
                <label>Width (mm)<input name="width" class="app-modal-input" type="number" min="0.1" max="500" step="0.1" value="30" required></label>
                <label data-pixel-control>Resolution<select name="resolution" class="app-modal-input">
                    <option value="64">64 px (long edge)</option><option value="128" selected>128 px (long edge)</option>
                    <option value="256">256 px (long edge)</option><option value="512">512 px (long edge)</option>
                </select></label>
                <label data-trace-control hidden>Resolution<select name="traceResolution" class="app-modal-input">
                    <option value="source" selected>Source (up to ${MAX_TRACE_RESOLUTION} px)</option>
                    <option value="512">512 px (long edge)</option>
                    <option value="1024">1024 px (long edge)</option>
                    <option value="2048">2048 px (long edge)</option>
                </select></label>
                <label data-net>Net<select name="net" class="app-modal-input"><option value="">Unassigned</option></select></label>
                <label>Conversion<select name="conversion" class="app-modal-input">
                    <option value="pixels" selected>Pixel rectangles</option>
                    <option value="trace">ImageTracerJS (trial)</option>
                    <option value="vtrace">VTracer (trial)</option>
                    <option value="halftone">Halftone dots</option>
                </select></label>
                <label class="picture-threshold">Threshold <output name="thresholdValue">128</output>
                    <input name="threshold" type="range" min="0" max="255" value="128">
                </label>
                <label data-trace-control="trace" hidden>Simplify <output name="simplifyValue">1</output>
                    <input name="simplify" type="range" min="0" max="5" step="0.1" value="1">
                </label>
                <label data-trace-control="trace" hidden>Despeckle <output name="despeckleValue">0</output>
                    <input name="despeckle" type="range" min="0" max="128" step="1" value="0">
                </label>
                <label data-trace-control="vtrace" hidden>Smoothing (px) <output name="smoothValue">1</output>
                    <input name="smooth" type="range" min="0" max="5" step="0.1" value="1">
                </label>
                <label data-trace-control="vtrace" hidden>Speckle Size (px) <output name="speckleValue">0</output>
                    <input name="speckle" type="range" min="0" max="128" step="1" value="0">
                </label>
                <label data-trace-control="halftone" hidden>Dot size (mm)
                    <input name="dotSize" class="app-modal-input" type="number" min="0.05" max="10" step="0.05" value="0.8" required title="Maximum dot diameter; image tones produce smaller dots">
                </label>
                <div class="picture-toggles">
                    <label data-trace-control="trace" hidden><input name="preserveCorners" type="checkbox" checked>Preserve Corners</label>
                    <label><input name="invert" type="checkbox">Invert</label>
                    <label><input name="mirror" type="checkbox">Flip Horizontal</label>
                    <label><input name="flipVertical" type="checkbox">Flip Vertical</label>
                </div>
            </div>
            <output class="picture-summary" aria-live="polite"></output>
            <div class="picture-error" role="alert"></div>
            <div class="app-modal-actions">
                <button class="app-modal-btn" type="button" data-cancel>Cancel</button>
                <button class="app-modal-btn app-modal-ok" type="submit" disabled>Import</button>
            </div>
        </form>`;
    document.body.appendChild(dialog);
    const title = /** @type {HTMLElement} */ (dialog.querySelector('.app-modal-title'));
    title.style.cursor = 'move';
    title.style.touchAction = 'none';
    title.style.userSelect = 'none';
    let drag = null;
    title.addEventListener('pointerdown', event => {
        if (event.button !== 0 || !event.isPrimary) return;
        const bounds = dialog.getBoundingClientRect();
        drag = { pointerId: event.pointerId, offsetX: event.clientX - bounds.left, offsetY: event.clientY - bounds.top };
        dialog.style.position = 'fixed';
        dialog.style.inset = 'auto';
        dialog.style.margin = '0';
        dialog.style.left = `${bounds.left}px`;
        dialog.style.top = `${bounds.top}px`;
        title.setPointerCapture(event.pointerId);
        event.preventDefault();
    });
    title.addEventListener('pointermove', event => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        const bounds = dialog.getBoundingClientRect();
        const maxLeft = Math.max(0, document.documentElement.clientWidth - bounds.width);
        const maxTop = Math.max(0, document.documentElement.clientHeight - bounds.height);
        dialog.style.left = `${Math.max(0, Math.min(maxLeft, event.clientX - drag.offsetX))}px`;
        dialog.style.top = `${Math.max(0, Math.min(maxTop, event.clientY - drag.offsetY))}px`;
    });
    const endDrag = event => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        drag = null;
        if (title.hasPointerCapture(event.pointerId)) title.releasePointerCapture(event.pointerId);
    };
    title.addEventListener('pointerup', endDrag);
    title.addEventListener('pointercancel', endDrag);
    title.addEventListener('lostpointercapture', endDrag);
    const form = dialog.querySelector('form');
    const field = name => /** @type {HTMLInputElement} */ (form.elements.namedItem(name));
    const netSelect = /** @type {HTMLSelectElement} */ (form.elements.namedItem('net'));
    const netNames = new Set();
    for (const source of [app.netlist, app.tracks, app.vias, app.boardShapes, app.copperFills]) {
        for (const item of source || []) {
            const net = String(item?.net || '').trim();
            if (net) netNames.add(net);
        }
    }
    for (const net of [...netNames].sort()) {
        const option = document.createElement('option');
        option.value = net;
        option.textContent = net;
        netSelect.appendChild(option);
    }
    const sourceCanvas = /** @type {HTMLCanvasElement} */ (dialog.querySelector('[data-preview="original"]'));
    const artworkCanvas = /** @type {HTMLCanvasElement} */ (dialog.querySelector('[data-preview="artwork"]'));
    const error = dialog.querySelector('.picture-error');
    const summary = dialog.querySelector('.picture-summary');
    const accept = /** @type {HTMLButtonElement} */ (dialog.querySelector('[type="submit"]'));
    const samplingCanvas = document.createElement('canvas');
    let bitmap = null;
    let prepared = null;
    let generation = 0;
    let previewGeneration = 0;
    let closed = false;
    const fullPreview = document.createElement('canvas');
    fullPreview.className = 'picture-full-preview';
    fullPreview.hidden = true;
    fullPreview.setAttribute('popover', 'manual');
    fullPreview.setAttribute('aria-hidden', 'true');
    dialog.appendChild(fullPreview);
    let hoveredPreview = null;
    const hideFullPreview = () => {
        if (!fullPreview.hidden) fullPreview.hidePopover?.();
        fullPreview.hidden = true;
    };
    const refreshFullPreview = () => {
        if (closed || !hoveredPreview || !bitmap || (hoveredPreview === artworkCanvas && !prepared)) {
            hideFullPreview();
            return;
        }
        const factor = Math.min(1, (document.documentElement.clientWidth - 32) / bitmap.width,
            (document.documentElement.clientHeight - 32) / bitmap.height);
        const width = Math.max(1, Math.floor(bitmap.width * factor));
        const height = Math.max(1, Math.floor(bitmap.height * factor));
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2, 4096 / Math.max(width, height));
        fullPreview.width = Math.max(1, Math.round(width * pixelRatio));
        fullPreview.height = Math.max(1, Math.round(height * pixelRatio));
        fullPreview.style.width = `${width}px`;
        fullPreview.style.height = `${height}px`;
        const context = fullPreview.getContext('2d');
        if (!context) return;
        if (hoveredPreview === sourceCanvas) {
            context.drawImage(bitmap, 0, 0, fullPreview.width, fullPreview.height);
        } else {
            context.fillStyle = '#000';
            context.fillRect(0, 0, fullPreview.width, fullPreview.height);
            const origin = prepared.points[0];
            const scale = fullPreview.width / Math.hypot(prepared.points[1].x - origin.x, prepared.points[1].y - origin.y);
            context.save();
            context.transform(scale, 0, 0, scale, -origin.x * scale, -origin.y * scale);
            context.fillStyle = '#fff';
            drawPicture(context, prepared);
            context.restore();
        }
        fullPreview.hidden = false;
        fullPreview.showPopover?.();
    };
    for (const preview of [sourceCanvas, artworkCanvas]) {
        preview.tabIndex = 0;
        preview.addEventListener('pointerenter', event => {
            if (event.pointerType === 'touch') return;
            hoveredPreview = preview;
            refreshFullPreview();
        });
        preview.addEventListener('focus', () => {
            hoveredPreview = preview;
            refreshFullPreview();
        });
        const dismiss = () => {
            if (hoveredPreview !== preview) return;
            hoveredPreview = null;
            hideFullPreview();
        };
        preview.addEventListener('pointerleave', dismiss);
        preview.addEventListener('blur', dismiss);
    }
    window.addEventListener('resize', refreshFullPreview);
    field('layer').value = 'top-silk';
    for (const option of /** @type {HTMLSelectElement} */ (form.elements.namedItem('layer')).options) {
        option.disabled = isLayerLocked(option.value) || !isLayerVisible(option.value);
    }
    const close = () => {
        if (closed) return;
        closed = true;
        generation++;
        hideFullPreview();
        window.removeEventListener('resize', refreshFullPreview);
        bitmap?.close();
        ModalManager.pop('pictureImport');
        dialog.close();
        dialog.remove();
    };
    const update = async () => {
        const version = ++previewGeneration;
        prepared = null;
        hideFullPreview();
        accept.disabled = true;
        error.textContent = '';
        summary.textContent = '';
        field('thresholdValue').value = field('threshold').value;
        field('simplifyValue').value = field('simplify').value;
        field('despeckleValue').value = field('despeckle').value;
        field('smoothValue').value = field('smooth').value;
        field('speckleValue').value = field('speckle').value;
        const conversion = field('conversion').value;
        const tracing = conversion === 'trace' || conversion === 'vtrace';
        const halftoning = conversion === 'halftone';
        const contourMode = tracing || halftoning;
        field('threshold').disabled = halftoning;
        field('dotSize').disabled = !halftoning;
        dialog.querySelectorAll('[data-trace-control]').forEach(control => {
            const engine = control.getAttribute('data-trace-control');
            control.hidden = !contourMode || !!engine && engine !== conversion;
        });
        dialog.querySelectorAll('[data-pixel-control]').forEach(control => {
            control.hidden = contourMode;
        });
        const layer = field('layer').value;
        field('net').disabled = !layer.endsWith('copper');
        if (!bitmap) return;
        try {
            const maxSide = contourMode
                ? (field('traceResolution').value === 'source' ? MAX_TRACE_RESOLUTION : Number(field('traceResolution').value))
                : Number(field('resolution').value);
            const samplingFactor = maxSide / Math.max(bitmap.width, bitmap.height);
            const factor = contourMode ? Math.min(1, samplingFactor) : samplingFactor;
            samplingCanvas.width = Math.max(1, Math.round(bitmap.width * factor));
            samplingCanvas.height = Math.max(1, Math.round(bitmap.height * factor));
            const context = samplingCanvas.getContext('2d', { willReadFrequently: true });
            context.imageSmoothingEnabled = true;
            context.imageSmoothingQuality = 'high';
            const flipHorizontal = field('mirror').checked;
            const flipVertical = field('flipVertical').checked;
            context.translate(flipHorizontal ? samplingCanvas.width : 0, flipVertical ? samplingCanvas.height : 0);
            context.scale(flipHorizontal ? -1 : 1, flipVertical ? -1 : 1);
            context.drawImage(bitmap, 0, 0, samplingCanvas.width, samplingCanvas.height);
            const pixels = context.getImageData(0, 0, samplingCanvas.width, samplingCanvas.height);
            const raster = halftoning ? null : rasterizePicture(pixels,
                { threshold: Number(field('threshold').value), invert: field('invert').checked, maskOnly: tracing });
            artworkCanvas.width = pixels.width;
            artworkCanvas.height = pixels.height;
            const artworkContext = artworkCanvas.getContext('2d');
            if (raster) {
                const preview = artworkContext.createImageData(raster.width, raster.height);
                for (let index = 0; index < raster.mask.length; index++) {
                    const shade = raster.mask[index] ? 255 : 0;
                    preview.data.set([shade, shade, shade, 255], index * 4);
                }
                artworkContext.putImageData(preview, 0, 0);
            }
            const widthMm = field('width').valueAsNumber;
            const heightMm = widthMm * pixels.height / pixels.width;
            if (raster) summary.textContent = `${widthMm.toFixed(2)} x ${heightMm.toFixed(2)} mm | ${(widthMm / raster.width).toFixed(3)} mm/px | Rectangles: ${raster.rectangles.length} / ${MAX_PICTURE_REGIONS}`;
            if (heightMm > 500) throw new Error('Image height must be at most 500 mm.');
            if (isLayerLocked(layer) || !isLayerVisible(layer)) throw new Error('Choose an unlocked, visible layer.');
            let artwork = raster;
            if (halftoning) {
                summary.textContent = 'Generating dots...';
                const { halftonePicture } = await import('./picture-halftone.js');
                if (closed || version !== previewGeneration) return;
                artwork = halftonePicture(pixels, { widthMm, dotSizeMm: field('dotSize').valueAsNumber, invert: field('invert').checked });
            } else if (tracing) {
                summary.textContent = 'Tracing image...';
                const tracer = conversion === 'vtrace'
                    ? await import('./picture-vtrace.js') : await import('./picture-trace.js');
                if (closed || version !== previewGeneration) return;
                artwork = await tracer.tracePicture(raster, conversion === 'vtrace'
                    ? { smooth: Number(field('smooth').value), speckle: Number(field('speckle').value) }
                    : { simplify: Number(field('simplify').value), despeckle: Number(field('despeckle').value),
                        preserveCorners: field('preserveCorners').checked });
                if (closed || version !== previewGeneration) return;
            }
            if (contourMode) {
                const usage = halftoning ? `Dots: ${artwork.circles.length} / ${MAX_PICTURE_CIRCLES}`
                    : `Contours: ${artwork.contours.length} / ${MAX_PICTURE_REGIONS} | Points: ${artwork.contours.reduce((total, contour) => total + contour.length, 0)} / ${MAX_PICTURE_VERTICES}`;
                summary.textContent = `${widthMm.toFixed(2)} x ${heightMm.toFixed(2)} mm | ${pixels.width} x ${pixels.height} px | ${usage}`;
            }
            prepared = pictureShape(artwork, { widthMm, layer, center: app.viewport.offset, net: field('net').value,
                name: field('file').files?.[0]?.name || 'Image' });
            if (contourMode) {
                const previewScale = 512 / Math.max(pixels.width, pixels.height);
                artworkCanvas.width = Math.max(1, Math.round(pixels.width * previewScale));
                artworkCanvas.height = Math.max(1, Math.round(pixels.height * previewScale));
                artworkContext.fillStyle = '#000';
                artworkContext.fillRect(0, 0, artworkCanvas.width, artworkCanvas.height);
                const scale = artworkCanvas.width / widthMm;
                const origin = prepared.points[0];
                artworkContext.save();
                artworkContext.transform(scale, 0, 0, scale, -origin.x * scale, -origin.y * scale);
                artworkContext.fillStyle = '#fff';
                drawPicture(artworkContext, prepared);
                artworkContext.restore();
            }
            accept.disabled = false;
            refreshFullPreview();
            return prepared;
        } catch (failure) {
            if (closed || version !== previewGeneration) return;
            prepared = null;
            accept.disabled = true;
            summary.textContent = halftoning ? 'Halftone unavailable' : tracing ? 'Tracing unavailable' : summary.textContent;
            error.textContent = failure.message;
        }
    };
    field('file').addEventListener('change', async () => {
        const version = ++generation;
        previewGeneration++;
        hideFullPreview();
        bitmap?.close();
        bitmap = null;
        prepared = null;
        accept.disabled = true;
        error.textContent = '';
        summary.textContent = '';
        sourceCanvas.getContext('2d').clearRect(0, 0, sourceCanvas.width, sourceCanvas.height);
        artworkCanvas.getContext('2d').clearRect(0, 0, artworkCanvas.width, artworkCanvas.height);
        const file = field('file').files?.[0];
        if (!file) return;
        summary.textContent = 'Loading image...';
        try {
            if (file.size > 20 * 1024 * 1024) throw new Error('Choose an image smaller than 20 MB.');
            const header = new Uint8Array(await file.slice(0, 8).arrayBuffer());
            const png = [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => header[index] === byte);
            const jpeg = header[0] === 255 && header[1] === 216 && header[2] === 255;
            if (!png && !jpeg) throw new Error('Choose a PNG or JPEG image.');
            const decoded = await createImageBitmap(file);
            if (closed || version !== generation) { decoded.close(); return; }
            if (decoded.width * decoded.height > 40000000) {
                decoded.close();
                throw new Error('Choose an image smaller than 40 megapixels.');
            }
            bitmap = decoded;
            const factor = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height));
            sourceCanvas.width = Math.max(1, Math.round(bitmap.width * factor));
            sourceCanvas.height = Math.max(1, Math.round(bitmap.height * factor));
            sourceCanvas.getContext('2d').drawImage(bitmap, 0, 0, sourceCanvas.width, sourceCanvas.height);
            await update();
        } catch (failure) {
            if (closed || version !== generation) return;
            summary.textContent = '';
            error.textContent = failure.message || 'This image could not be decoded.';
        }
    });
    form.addEventListener('input', event => {
        if (event.target !== field('file')) return update();
    });
    form.addEventListener('submit', async event => {
        event.preventDefault();
        const imported = await update();
        if (!imported || accept.disabled || closed) return;
        document.getElementById('pcbToolSelect')?.click();
        const shape = { ...imported, id: `pshape_${app._shapeIdCounter++}` };
        const historyDepth = app.history.undoStack.length;
        app._suspendFillRefresh = true;
        app._fillRefreshPending = false;
        app._suspendBoardViewRefresh = true;
        app.history.execute(new AddBoardShapeCommand(app, shape));
        setPcbSelection(app, [{ kind: 'shape', object: shape }]);
        renderPcbSelectionAnchors(app);
        showBoardShapeProperties(app, shape);
        close();
        app._beginPasteDrop({ shapes: [shape] }, historyDepth);
        app._setStatus?.('Click to place image');
    });
    dialog.querySelector('[data-cancel]').addEventListener('click', close);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    ModalManager.push('pictureImport', close);
    dialog.showModal();
    update();
    field('file').focus();
    const canvasBounds = app.viewport.container.getBoundingClientRect();
    const dialogBounds = dialog.getBoundingClientRect();
    const maxLeft = Math.max(0, document.documentElement.clientWidth - dialogBounds.width);
    const maxTop = Math.max(0, document.documentElement.clientHeight - dialogBounds.height);
    dialog.style.position = 'fixed';
    dialog.style.inset = 'auto';
    dialog.style.margin = '0';
    dialog.style.left = `${Math.max(0, Math.min(maxLeft, canvasBounds.left + (canvasBounds.width - dialogBounds.width) / 2))}px`;
    dialog.style.top = `${Math.max(0, Math.min(maxTop, canvasBounds.top + (canvasBounds.height - dialogBounds.height) / 2))}px`;
}