import { ModalManager } from '../../core/ModalManager.js';
import { isLayerLocked, isLayerVisible } from './layers.js';
import { showBoardShapeProperties } from './board-shapes.js';
import { AddBoardShapeCommand } from './shape-commands.js';
import { setPcbSelection } from './selection-registry.js';
import { renderPcbSelectionAnchors } from './selection-anchors.js';
import { rasterizePicture, pictureShape } from './picture-raster.js';

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
                <label>Resolution<select name="resolution" class="app-modal-input">
                    <option value="64">64 px (long edge)</option><option value="128" selected>128 px (long edge)</option>
                    <option value="256">256 px (long edge)</option><option value="512">512 px (long edge)</option>
                </select></label>
                <label data-net>Net<select name="net" class="app-modal-input"><option value="">Unassigned</option></select></label>
                <label class="picture-threshold">Threshold <output name="thresholdValue">128</output>
                    <input name="threshold" type="range" min="0" max="255" value="128">
                </label>
                <div class="picture-toggles">
                    <label><input name="invert" type="checkbox">Invert</label>
                    <label><input name="mirror" type="checkbox">Mirror horizontally</label>
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
    let closed = false;
    field('layer').value = 'top-silk';
    for (const option of /** @type {HTMLSelectElement} */ (form.elements.namedItem('layer')).options) {
        option.disabled = isLayerLocked(option.value) || !isLayerVisible(option.value);
    }
    const close = () => {
        if (closed) return;
        closed = true;
        generation++;
        bitmap?.close();
        ModalManager.pop('pictureImport');
        dialog.close();
        dialog.remove();
    };
    const update = () => {
        prepared = null;
        accept.disabled = true;
        error.textContent = '';
        summary.textContent = '';
        field('thresholdValue').value = field('threshold').value;
        const layer = field('layer').value;
        field('net').disabled = !layer.endsWith('copper');
        if (!bitmap) return;
        try {
            const maxSide = Number(field('resolution').value);
            const factor = maxSide / Math.max(bitmap.width, bitmap.height);
            samplingCanvas.width = Math.max(1, Math.round(bitmap.width * factor));
            samplingCanvas.height = Math.max(1, Math.round(bitmap.height * factor));
            const context = samplingCanvas.getContext('2d', { willReadFrequently: true });
            context.imageSmoothingEnabled = true;
            context.imageSmoothingQuality = 'high';
            if (field('mirror').checked) {
                context.translate(samplingCanvas.width, 0);
                context.scale(-1, 1);
            }
            context.drawImage(bitmap, 0, 0, samplingCanvas.width, samplingCanvas.height);
            const raster = rasterizePicture(context.getImageData(0, 0, samplingCanvas.width, samplingCanvas.height),
                { threshold: Number(field('threshold').value), invert: field('invert').checked });
            artworkCanvas.width = raster.width;
            artworkCanvas.height = raster.height;
            const artworkContext = artworkCanvas.getContext('2d');
            const preview = artworkContext.createImageData(raster.width, raster.height);
            for (let index = 0; index < raster.mask.length; index++) {
                const shade = raster.mask[index] ? 20 : 255;
                preview.data.set([shade, shade, shade, 255], index * 4);
            }
            artworkContext.putImageData(preview, 0, 0);
            const widthMm = field('width').valueAsNumber;
            const heightMm = widthMm * raster.height / raster.width;
            summary.textContent = `${widthMm.toFixed(2)} x ${heightMm.toFixed(2)} mm | ${(widthMm / raster.width).toFixed(3)} mm/px`;
            if (heightMm > 500) throw new Error('Image height must be at most 500 mm.');
            if (isLayerLocked(layer) || !isLayerVisible(layer)) throw new Error('Choose an unlocked, visible layer.');
            prepared = pictureShape(raster, { widthMm, layer, center: app.viewport.offset, net: field('net').value,
                name: field('file').files?.[0]?.name || 'Image' });
            accept.disabled = false;
        } catch (failure) {
            error.textContent = failure.message;
        }
    };
    field('file').addEventListener('change', async () => {
        const version = ++generation;
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
            update();
        } catch (failure) {
            if (closed || version !== generation) return;
            summary.textContent = '';
            error.textContent = failure.message || 'This image could not be decoded.';
        }
    });
    form.addEventListener('input', event => {
        if (event.target !== field('file')) update();
    });
    form.addEventListener('submit', event => {
        event.preventDefault();
        update();
        if (!prepared || accept.disabled) return;
        document.getElementById('pcbToolSelect')?.click();
        const shape = { ...prepared, id: `pshape_${app._shapeIdCounter++}` };
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