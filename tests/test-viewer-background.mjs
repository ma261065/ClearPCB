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
assert.equal(Object.hasOwn(VIEWER_BACKGROUND, 'css'), false, 'No separate CSS background is defined');

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
assert.doesNotMatch(board3d, /VIEWER_BACKGROUND\.css|cpcb3d-cover|setClearColor/,
    'The viewer uses its rendered background without a pre-render cover or explicit fallback');

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

const clipStates = [false];
const renderStates = [{ composite: 'source-over', transform: [1, 0, 0, 1, 0, 0] }];
const backgroundPasses = [];
const clears = [];
const renderContext = {
    ...context,
    clearRect(...bounds) {
        clears.push({ ...structuredClone(renderStates.at(-1)), bounds });
    },
    get globalCompositeOperation() { return renderStates.at(-1).composite; },
    set globalCompositeOperation(value) { renderStates.at(-1).composite = value; },
    setTransform(...transform) { renderStates.at(-1).transform = transform; },
    save() {
        clipStates.push(clipStates.at(-1));
        renderStates.push(structuredClone(renderStates.at(-1)));
    },
    restore() { clipStates.pop(); renderStates.pop(); },
    clip() { clipStates[clipStates.length - 1] = true; },
    fillRect(...bounds) {
        backgroundPasses.push({ ...structuredClone(renderStates.at(-1)), bounds,
            clipped: clipStates.at(-1), holesDrawn });
    },
};
let holesDrawn = false;
const renderViewer = {
    canvas: { clientWidth: 200, clientHeight: 100, width: 200, height: 100 },
    ctx: renderContext,
    data: { boardShapes: [{ kind: 'circle', layer: 'hole', x: 10, y: 0, radius: 5 }] },
    mirror: -1, scale: 4, tx: 25, ty: 30,
    _boardRect() { return { x: 0, y: 0, w: 20, h: 20 }; },
    _boardPath() {},
    _drawBoard() { assert.equal(clipStates.at(-1), false); },
    _drawMaskOpenings() { assert.equal(clipStates.at(-1), true); },
    _drawCopper() { assert.equal(clipStates.at(-1), true); },
    _drawSolderMask() { assert.equal(clipStates.at(-1), true); },
    _drawSilk() { assert.equal(clipStates.at(-1), true); },
    _drawHoles() {
        holesDrawn = true;
        assert.equal(clipStates.at(-1), false,
            'Edge-crossing holes must erase the outline stroke outside the board clip');
    },
};
Board2D.prototype.render.call(renderViewer);
assert.equal(holesDrawn, true);
assert.deepEqual(clipStates, [false]);
assert.deepEqual(backgroundPasses, [
    { composite: 'destination-over', transform: [1, 0, 0, 1, 0, 0], bounds: [0, 0, 200, 100],
        clipped: false, holesDrawn: true },
], 'One screen-space background pass fills the entire canvas behind the board and cutouts');
assert.deepEqual(clears, [
    { composite: 'source-over', transform: [1, 0, 0, 1, 0, 0], bounds: [0, 0, 200, 100] },
], 'Each frame clears the previous board and background in device coordinates');
assert.equal(renderContext.globalCompositeOperation, 'source-over');

for (const exportScale of [1, 3]) {
    for (const data of [renderViewer.data, null]) {
        backgroundPasses.length = 0;
        clears.length = 0;
        holesDrawn = false;
        Board2D.prototype.render.call({ ...renderViewer, data, _exportScale: exportScale });
        assert.equal(backgroundPasses.length, 1, 'Normal, empty and export frames paint the background once');
        assert.deepEqual(backgroundPasses[0].bounds, [0, 0, 200 * exportScale, 100 * exportScale]);
        assert.deepEqual(backgroundPasses[0].transform, [1, 0, 0, 1, 0, 0]);
        assert.equal(backgroundPasses[0].holesDrawn, !!data);
        assert.equal(clears.length, 1, 'Repeated renders do not retain stale geometry');
    }
}

console.log('PASS viewer gradients render in canvas without fallback backgrounds and with one 2D background pass');
