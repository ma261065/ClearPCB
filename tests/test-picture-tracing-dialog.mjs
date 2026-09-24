import assert from 'node:assert/strict';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { installVTracerEnvironment } from './helpers/vtracer-environment.mjs';

const vtraceEnvironment = installVTracerEnvironment({ failures: 1 });

function element() {
    const listeners = new Map();
    return { style: {}, value: '', checked: false, textContent: '', hidden: false,
        get valueAsNumber() { return Number(this.value); },
        addEventListener(name, listener) {
            if (!listeners.has(name)) listeners.set(name, []);
            listeners.get(name).push(listener);
        },
        async emit(name, event = {}) { for (const listener of listeners.get(name) || []) await listener(event); },
        setAttribute() {}, getAttribute() { return ''; }, appendChild() {}, remove() {}, focus() {},
        getBoundingClientRect() { return { left: 0, top: 0, width: 600, height: 600 }; },
    };
}
let empty = false;
const fills = [];
const imageDraws = [];
function canvas() {
    const context = {
        clearRect() {}, drawImage(...args) { imageDraws.push(args); }, translate() {}, scale() {}, putImageData() {},
        beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, save() {}, restore() {}, transform() {}, arc() {},
        fill(rule) { fills.push({ rule, color: this.fillStyle }); }, fillRect() {},
        createImageData(width, height) { return { data: new Uint8ClampedArray(width * height * 4) }; },
        getImageData(left, top, width, height) {
            const data = new Uint8ClampedArray(width * height * 4);
            for (let row = 0; row < height; row++) for (let column = 0; column < width; column++) {
                const shade = !empty && column >= 8 && column < 48 && row >= 8 && row < 48 ? 255 : 0;
                data.set([shade, shade, shade, 255], (row * width + column) * 4);
            }
            return { width, height, data };
        },
    };
    return { ...element(), width: 64, height: 64, getContext() { return context; } };
}
const fields = new Map(Object.entries({ layer: 'top-silk', width: '30', resolution: '64', net: '',
    conversion: 'pixels', traceResolution: 'source', threshold: '128', thresholdValue: '', simplify: '1', simplifyValue: '',
    despeckle: '0', despeckleValue: '', invert: '', mirror: '', flipVertical: '', preserveCorners: '', file: '',
    smooth: '1', smoothValue: '', speckle: '0', speckleValue: '',
    dotSize: '0.8',
}).map(([name, value]) => [name, Object.assign(element(), { value })]));
fields.get('preserveCorners').checked = true;
fields.get('layer').options = [{ value: 'top-silk' }];
fields.get('file').files = [{ name: 'trial.png', size: 64,
    slice() { return { async arrayBuffer() { return Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]).buffer; } }; } }];
const form = Object.assign(element(), { elements: { namedItem(name) { return fields.get(name); } } });
const accept = element();
const summary = element();
const error = element();
const controls = [element(), element(), element()].map(control => Object.assign(control, {
    getAttribute() { return 'trace'; },
}));
const sharedControls = [element()];
const halftoneControls = [Object.assign(element(), { getAttribute() { return 'halftone'; } })];
const vtraceControls = [element(), element()].map(control => Object.assign(control, {
    getAttribute() { return 'vtrace'; },
}));
const pixelControls = [element()];
const lookups = new Map([
    ['form', form], ['.app-modal-title', element()], ['[data-preview="original"]', canvas()],
    ['[data-preview="artwork"]', canvas()], ['.picture-summary', summary], ['.picture-error', error],
    ['[type="submit"]', accept], ['[data-cancel]', element()], ['.picture-previews', element()],
]);
const dialog = Object.assign(element(), { closed: false,
    querySelector(selector) { return lookups.get(selector); },
    querySelectorAll(selector) { return selector === '[data-pixel-control]' ? pixelControls : [...sharedControls, ...controls, ...vtraceControls, ...halftoneControls]; },
    showModal() {}, close() { this.closed = true; },
});
const resizeListeners = new Set();
globalThis.window = { devicePixelRatio: 2,
    addEventListener(name, listener) { if (name === 'resize') resizeListeners.add(listener); },
    removeEventListener(name, listener) { if (name === 'resize') resizeListeners.delete(listener); } };
const createdCanvases = [];
globalThis.document = { body: element(), documentElement: { clientWidth: 1000, clientHeight: 800 },
    getElementById() { return null; },
    createElement(tag) {
        if (tag === 'dialog') return dialog;
        if (tag === 'canvas') {
            const preview = canvas();
            preview.popoverOpen = false;
            preview.showPopover = () => { preview.popoverOpen = true; };
            preview.hidePopover = () => { preview.popoverOpen = false; };
            createdCanvases.push(preview);
            return preview;
        }
        return element();
    },
    createElementNS() { return element(); },
};
globalThis.createImageBitmap = async () => ({ width: 1302, height: 527, close() {} });
const { showPictureImport } = await import('../src/pcb/modules/picture-import.js');
let placed = null;
const app = { viewport: { scale: 10, offset: { x: 0, y: 0 }, container: element() },
    boardShapes: [], placements: new Map(), tracks: [], vias: [], texts: new Map(), _shapeElements: new Map(),
    _shapeIdCounter: 1, history: new CommandHistory(), _getLayerGroup() { return null; },
    _beginPasteDrop(result) { placed = result; },
};
showPictureImport(app);
const fullPreview = createdCanvases.find(preview => preview.className === 'picture-full-preview');
const originalPreview = lookups.get('[data-preview="original"]');
const artworkPreview = lookups.get('[data-preview="artwork"]');
const previewArea = lookups.get('.picture-previews');
await originalPreview.emit('pointerenter', { pointerType: 'mouse' });
assert.equal(fullPreview.hidden, true, 'No enlarged preview before loading an image');
await previewArea.emit('pointerleave');
assert.ok(dialog.innerHTML.includes('ImageTracerJS (trial)'));
assert.ok(dialog.innerHTML.includes('VTracer (trial)'));
assert.ok(dialog.innerHTML.includes('Halftone dots'));
assert.ok(dialog.innerHTML.includes('Dot size (mm)'));
assert.ok(!dialog.innerHTML.includes('Dots (long edge)'));
assert.equal(accept.disabled, true);
assert.ok(controls.every(control => control.hidden));
await fields.get('file').emit('change');
assert.equal(accept.disabled, false);
assert.match(summary.textContent, /Rectangles:/);
await originalPreview.emit('pointerenter', { pointerType: 'mouse' });
assert.equal(fullPreview.hidden, false);
assert.equal(fullPreview.popoverOpen, true);
assert.equal(fullPreview.style.width, '968px');
assert.equal(fullPreview.width, 1936, 'Full preview respects device pixel ratio');
assert.equal(imageDraws.at(-1)[0].width, 1302, 'Original is drawn from the full source bitmap');
await originalPreview.emit('pointerleave');
assert.equal(fullPreview.hidden, false, 'Crossing the gap keeps the original visible');
assert.equal(fullPreview.popoverOpen, true, 'Crossing the gap does not close the popover');
await artworkPreview.emit('pointerenter', { pointerType: 'mouse' });
assert.equal(fullPreview.hidden, false, 'Entering artwork switches without dismissing the preview');
assert.deepEqual(fills.at(-1), { rule: 'evenodd', color: '#fff' });
await artworkPreview.emit('pointerleave');
assert.equal(fullPreview.hidden, false, 'Crossing back keeps artwork visible');
await originalPreview.emit('pointerenter', { pointerType: 'mouse' });
assert.equal(fullPreview.hidden, false);
assert.equal(imageDraws.at(-1)[0].width, 1302, 'Returning to original redraws the source bitmap');
await previewArea.emit('pointerleave');
assert.equal(fullPreview.hidden, true);
assert.equal(fullPreview.popoverOpen, false);
await artworkPreview.emit('pointerenter', { pointerType: 'touch' });
assert.equal(fullPreview.hidden, true, 'Touch does not leave a hover overlay open');
await artworkPreview.emit('focus');
assert.equal(fullPreview.hidden, false, 'Keyboard focus opens artwork preview');
assert.deepEqual(fills.at(-1), { rule: 'evenodd', color: '#fff' }, 'Artwork is redrawn from geometry at full size');
document.documentElement.clientWidth = 390;
document.documentElement.clientHeight = 600;
for (const listener of resizeListeners) listener();
assert.equal(fullPreview.style.width, '358px', 'Popup fits a narrow viewport');
await artworkPreview.emit('blur');
assert.equal(fullPreview.hidden, true);
document.documentElement.clientWidth = 1000;
document.documentElement.clientHeight = 800;
fields.get('conversion').value = 'trace';
fields.get('width').value = '5';
const loading = form.emit('input', { target: fields.get('conversion') });
assert.equal(accept.disabled, true, 'Import disabled during asynchronous tracing');
await loading;
assert.equal(error.textContent, '');
assert.equal(accept.disabled, false);
assert.ok(controls.every(control => !control.hidden));
assert.ok(vtraceControls.every(control => control.hidden));
assert.ok(pixelControls.every(control => control.hidden));
assert.match(summary.textContent, /1302 x 527 px/);
fields.get('traceResolution').value = '512';
await form.emit('input', { target: fields.get('traceResolution') });
assert.match(summary.textContent, /512 x 207 px/);
fields.get('traceResolution').value = '2048';
await form.emit('input', { target: fields.get('traceResolution') });
assert.match(summary.textContent, /1302 x 527 px/, 'Tracing does not upscale smaller sources');
assert.match(summary.textContent, /Contours:.*Points:/);
assert.deepEqual(fills.at(-1), { rule: 'evenodd', color: '#fff' }, 'Preview renders material in white with holes');
empty = true;
await form.emit('input', { target: fields.get('threshold') });
assert.match(error.textContent, /empty/);
assert.equal(accept.disabled, true);
empty = false;
const staleTrace = form.emit('input', { target: fields.get('threshold') });
fields.get('conversion').value = 'pixels';
fields.get('width').value = '30';
await form.emit('input', { target: fields.get('conversion') });
await staleTrace;
assert.match(summary.textContent, /Rectangles:/, 'Older trace results do not replace the latest mode');
assert.ok(pixelControls.every(control => !control.hidden));
fields.get('conversion').value = 'vtrace';
await form.emit('input', { target: fields.get('conversion') });
assert.match(error.textContent, /VTracer download failed \(503\)/);
assert.equal(accept.disabled, true);
await form.emit('input', { target: fields.get('conversion') });
assert.equal(vtraceEnvironment.loads, 2, 'Failed WASM initialization can be retried');
assert.equal(error.textContent, '');
assert.ok(vtraceControls.every(control => !control.hidden));
assert.ok(controls.every(control => control.hidden), 'ImageTracer controls are hidden for VTracer');
assert.ok(sharedControls.every(control => !control.hidden));
assert.equal(accept.disabled, false);
assert.match(summary.textContent, /1302 x 527 px.*Contours:.*Points:/);
const staleVTrace = form.emit('input', { target: fields.get('smooth') });
fields.get('conversion').value = 'pixels';
await form.emit('input', { target: fields.get('conversion') });
await staleVTrace;
assert.match(summary.textContent, /Rectangles:/);
fields.get('conversion').value = 'halftone';
await form.emit('input', { target: fields.get('conversion') });
assert.equal(error.textContent, '');
assert.equal(accept.disabled, false);
assert.equal(fields.get('threshold').disabled, true);
assert.ok(halftoneControls.every(control => !control.hidden));
assert.ok([...controls, ...vtraceControls].every(control => control.hidden));
assert.match(summary.textContent, /Dots:.*\/ 20000/);
assert.ok(!summary.textContent.includes('Points:'), 'Halftones have no polygon point budget');
const halftoneSummary = summary.textContent;
fields.get('dotSize').value = '1.6';
await form.emit('input', { target: fields.get('dotSize') });
assert.equal(error.textContent, '');
assert.notEqual(summary.textContent, halftoneSummary, 'Dot-size input recalculates the grid');
fields.get('dotSize').value = '0';
await form.emit('input', { target: fields.get('dotSize') });
assert.equal(accept.disabled, true);
assert.match(error.textContent, /settings/);
fields.get('dotSize').value = '0.8';
fields.get('threshold').value = '255';
await form.emit('input', { target: fields.get('threshold') });
assert.equal(summary.textContent, halftoneSummary, 'Halftoning bypasses threshold');
fields.get('threshold').value = '128';
const staleHalftone = form.emit('input', { target: fields.get('dotSize') });
fields.get('conversion').value = 'pixels';
await form.emit('input', { target: fields.get('conversion') });
await staleHalftone;
assert.match(summary.textContent, /Rectangles:/);
assert.equal(fields.get('threshold').disabled, false);
fields.get('conversion').value = 'vtrace';
empty = true;
await form.emit('input', { target: fields.get('conversion') });
assert.equal(accept.disabled, true);
assert.match(error.textContent, /empty/);
empty = false;
await originalPreview.emit('pointerenter', { pointerType: 'mouse' });
await form.emit('submit', { preventDefault() {} });
assert.equal(fullPreview.hidden, true, 'Closing the importer dismisses the popup');
assert.equal(fullPreview.popoverOpen, false);
assert.equal(resizeListeners.size, 0, 'Closing removes popup resize listeners');
assert.equal(dialog.closed, true);
assert.equal(placed.shapes.length, 1);
assert.ok(placed.shapes[0].artwork.contours.length > 0);
assert.equal(placed.shapes[0].artwork.width, 1302);
assert.equal(placed.shapes[0].artwork.rectangles, undefined);
assert.equal(app.history.undoStack.length, 1);
app.history.undo();
assert.equal(app.boardShapes.length, 0);
console.log('PASS tracing dialog controls, real contour preview, loading/error states, stale-result protection and undoable import');