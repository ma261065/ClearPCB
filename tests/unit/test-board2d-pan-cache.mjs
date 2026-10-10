import assert from 'node:assert/strict';
import { installFakeDom } from './helpers/fake-dom.mjs';
import { Board2D } from '../../src/pcb/modules/board2d.js';

const dom = installFakeDom();
const frames = new Map();
const timers = new Map();
let id = 0, captures = 0, paints = 0, renders = 0;
const owner = {
    requestAnimationFrame(callback) { frames.set(++id, callback); return id; },
    cancelAnimationFrame(frame) { frames.delete(frame); },
    setTimeout(callback, delay) { assert.equal(delay, 300); timers.set(++id, callback); return id; },
    clearTimeout(timer) { timers.delete(timer); },
    addEventListener() {}, removeEventListener() {},
};
const canvas = { ownerDocument: { defaultView: owner }, getContext: () => ({}),
    width: 600, height: 400, getBoundingClientRect: () => ({ left: 10, top: 20, width: 600, height: 400 }),
    addEventListener() {}, removeEventListener() {}, setPointerCapture() {}, releasePointerCapture() {} };
const viewer = new Board2D(canvas);
viewer._capturePanRaster = () => { captures++; return { canvas: { width: 600, height: 400 },
    tx: viewer.tx, ty: viewer.ty, scale: viewer.scale, x: 0, y: 0, dpr: 1, clipped: false }; };
viewer._paintPanRaster = () => { paints++; };
viewer.render = () => { renders++; viewer._cancelPanFrame(); viewer._cancelZoomTimer(); viewer._panRaster = null; };
viewer._onPointerDown({ button: 0, clientX: 10, clientY: 20, pointerId: 1 });
for (let i = 1; i <= 100; i++) viewer._onPointerMove({ clientX: 10 + i, clientY: 20 + i * 2 });
assert.equal(captures, 1);
assert.equal(frames.size, 1, 'pointer bursts schedule only one bitmap paint');
assert.equal(renders, 0, 'pan moves never rerender board geometry');
assert.equal(viewer.tx, 100);
assert.equal(viewer.ty, 200);
const callback = [...frames.values()][0];
frames.clear();
callback();
assert.equal(paints, 1);
viewer._onPointerMove({ clientX: 120, clientY: 230 });
assert.equal(frames.size, 1);
viewer._onPointerUp({ pointerId: 1 });
assert.equal(frames.size, 0);
assert.equal(renders, 1, 'release restores a full-quality board rendering');
assert.equal(viewer._panRaster, null);
viewer._onPointerDown({ button: 2, clientX: 0, clientY: 0, pointerId: 2 });
assert.equal(captures, 1, 'right button does not start a pan');
let boundsChecks = 0;
viewer._minScale = () => { boundsChecks++; return 0.1; };
const worldX = (300 - viewer.tx) / viewer.scale;
const worldY = (200 - viewer.ty) / viewer.scale;
const initialScale = viewer.scale;
for (let i = 0; i < 100; i++) {
    viewer._onWheel({ preventDefault() {}, clientX: 310, clientY: 220, deltaY: -1 });
}
assert.equal(captures, 2, 'wheel burst captures only once');
assert.equal(boundsChecks, 1, 'wheel burst does not repeatedly resolve board bounds');
assert.equal(frames.size, 1, 'wheel burst schedules one bitmap frame');
assert.equal(timers.size, 1, 'wheel burst resets a single settle timer');
assert.equal(renders, 1, 'wheel events do not redraw geometry');
assert.ok(Math.abs((300 - viewer.tx) / viewer.scale - worldX) < 1e-10);
assert.ok(Math.abs((200 - viewer.ty) / viewer.scale - worldY) < 1e-10);
assert.ok(viewer.scale > initialScale);
let drawArgs;
viewer.ctx = { setTransform() {}, clearRect() {}, fillRect() {},
    createRadialGradient: () => ({ addColorStop() {} }),
    drawImage(...args) { drawArgs = args; } };
Board2D.prototype._paintPanRaster.call(viewer);
const ratio = viewer.scale / initialScale;
assert.ok(Math.abs(drawArgs[3] - 600 * ratio) < 1e-10, 'cached image scales with zoom');
assert.ok(Math.abs(drawArgs[1] - (viewer.tx - ratio * viewer._panRaster.tx)) < 1e-10);
const settle = [...timers.values()][0];
timers.clear();
settle();
assert.equal(renders, 2, 'zoom settlement redraws sharply once');
assert.equal(frames.size, 0, 'settlement cancels any unpainted frame');
assert.equal(viewer._panRaster, null);
const settledScale = viewer.scale;
viewer.scale = 2000;
const beforeLimit = captures;
viewer._onWheel({ preventDefault() {}, clientX: 310, clientY: 220, deltaY: -1 });
assert.equal(captures, beforeLimit, 'clamped zoom does not capture or schedule work');
assert.equal(timers.size, 0);
assert.equal(frames.size, 0);
viewer.scale = settledScale;
viewer._onWheel({ preventDefault() {}, clientX: 310, clientY: 220, deltaY: 1 });
viewer.resize();
assert.equal(timers.size, 0, 'resize cancels stale zoom settlement');
assert.equal(viewer._panRaster, null);
viewer._onPointerDown({ button: 0, clientX: 0, clientY: 0, pointerId: 3 });
viewer._onPointerMove({ clientX: 10, clientY: 10 });
viewer._onWheel({ preventDefault() {}, clientX: 310, clientY: 220, deltaY: 1 });
assert.equal(frames.size, 1);
viewer.dispose();
assert.equal(frames.size, 0, 'disposal cancels scheduled bitmap paints');
assert.equal(viewer._panRaster, null);
assert.equal(viewer._drag, null);
assert.equal(timers.size, 0, 'disposal cancels zoom settlement');
void dom;
console.log('PASS 2D pan and zoom cache artwork, coalesce frames, preserve cursor anchoring and clean up');
