import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    VIEWER_BACKGROUND,
    createViewerBackgroundTexture,
    paintViewerBackground,
} from '../src/pcb/modules/viewer-background.js';

const stops = [];
const fills = [];
const gradients = [];
const gradient = { addColorStop(offset, color) { stops.push([offset, color]); } };
const context = {
    fillStyle: null,
    createRadialGradient(...args) {
        gradients.push(args);
        return gradient;
    },
    fillRect(...args) { fills.push(args); },
};
paintViewerBackground(context, 200, 100);
assert.deepEqual(gradients[0], [100, 50, 0, 100, 50, Math.hypot(100, 50)]);
assert.equal(context.fillStyle, gradient);
assert.deepEqual(stops, [
    [0, VIEWER_BACKGROUND.center],
    [0.52, VIEWER_BACKGROUND.mid],
    [1, VIEWER_BACKGROUND.edge],
]);
assert.deepEqual(fills, [[0, 0, 200, 100]]);
assert.match(VIEWER_BACKGROUND.css, /^radial-gradient\(ellipse at center,/);

const textureCanvas = {
    width: 0,
    height: 0,
    getContext() { return context; },
};
class CanvasTexture {
    constructor(canvas) { this.canvas = canvas; }
}
const texture = createViewerBackgroundTexture(
    { CanvasTexture, SRGBColorSpace: 'srgb' },
    { createElement(tag) { assert.equal(tag, 'canvas'); return textureCanvas; } },
);
assert.equal(texture.canvas.width, 512);
assert.equal(texture.canvas.height, 512);
assert.equal(texture.colorSpace, 'srgb');
assert.deepEqual(gradients[1], [256, 256, 0, 256, 256, Math.hypot(256, 256)]);

const board2d = readFileSync(new URL('../src/pcb/modules/board2d.js', import.meta.url), 'utf8');
const board3d = readFileSync(new URL('../src/pcb/modules/board3d.js', import.meta.url), 'utf8');
assert.match(board2d, /paintViewerBackground\(ctx, cv\.width, cv\.height\)/);
assert.match(board3d, /this\.scene\.background = this\.backgroundTexture/);
assert.match(board3d, /background:\$\{VIEWER_BACKGROUND\.css\}/);

globalThis.window = { addEventListener() {} };
globalThis.document = { createElement() { return {}; } };
const { Board2D } = await import('../src/pcb/modules/board2d.js');
const composites = ['source-over'];
const holeFills = [];
const holeContext = {
    get globalCompositeOperation() { return composites.at(-1); },
    set globalCompositeOperation(value) { composites[composites.length - 1] = value; },
    save() { composites.push(this.globalCompositeOperation); },
    restore() { composites.pop(); },
    set fillStyle(_value) {},
    beginPath() {},
    arc() {},
    fill() { holeFills.push(this.globalCompositeOperation); },
};
const board2D = new Board2D({
    getContext() { return holeContext; },
    addEventListener() {},
});
board2D.data = { placements: new Map(), vias: [{ x: 4, y: 5, drill: 0.6 }], boardShapes: [] };
board2D._drawHoles(holeContext);
assert.deepEqual(holeFills, ['destination-out']);
assert.equal(holeContext.globalCompositeOperation, 'source-over');

console.log('PASS 2D, 3D, export and pre-render surfaces share the navy radial gradient');
