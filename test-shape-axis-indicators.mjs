/** Headless regression tests for Track-style generic-shape H/V/45 glow. */

globalThis.window = { addEventListener() {} };

function element(tagName) {
    return {
        tagName,
        attributes: new Map(),
        children: [],
        style: {},
        setAttribute(name, value) { this.attributes.set(name, String(value)); },
        getAttribute(name) { return this.attributes.get(name) || null; },
        removeAttribute(name) { this.attributes.delete(name); },
        appendChild(child) { this.children.push(child); return child; },
        insertBefore(child, reference) {
            const index = this.children.indexOf(reference);
            if (index < 0) this.children.push(child);
            else this.children.splice(index, 0, child);
            return child;
        },
        remove() {},
        querySelectorAll() { return []; },
        classList: { add() {} },
    };
}

globalThis.document = {
    createElementNS(_namespace, tagName) { return element(tagName); },
    getElementById() { return null; },
};

const { startBoardShapeDrag, handleBoardShapeDrag } = await import('./src/pcb/modules/board-shapes.js');
const { makeAxisGlowHalo } = await import('./src/pcb/modules/axis-glow.js');

let failures = 0;

function expect(name, condition) {
    if (condition) {
        console.log(`PASS: ${name}`);
        return;
    }
    failures++;
    console.error(`FAIL: ${name}`);
}

function glowFor(point, scale = 1) {
    const overlay = element('g');
    const shape = {
        id: 'line_1',
        kind: 'line',
        layer: 'top-copper',
        lineWidth: 0.2,
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
    };
    const app = {
        boardShapes: [shape],
        viewport: { scale, setCrosshair() {} },
        _snapToGrid(value) { return value; },
        _getLayerGroup() { return overlay; },
        _shapeElements: new Map(),
    };
    startBoardShapeDrag(app, shape, { x: 0, y: 0 }, 0);
    handleBoardShapeDrag(app, point);
    return overlay.children.filter((child) => child.tagName === 'line');
}

function hasTrackStyleGlow(point, dashed) {
    const lines = glowFor(point);
    const halo = lines.find((line) => line.getAttribute('stroke') !== '#ffffff');
    const centerline = lines.find((line) => line.getAttribute('stroke') === '#ffffff');
    return !!halo && !!centerline
        && (dashed ? !!centerline.getAttribute('stroke-dasharray') : !centerline.getAttribute('stroke-dasharray'));
}

expect('horizontal snap shows the Track halo and solid centerline', hasTrackStyleGlow({ x: 0.1, y: 0.1 }, false));
expect('vertical snap shows the Track halo and solid centerline', hasTrackStyleGlow({ x: 10.1, y: 5 }, false));
expect('diagonal snap shows the Track halo and dashed centerline', hasTrackStyleGlow({ x: 5, y: 5.1 }, true));

function haloForScale(scale) {
    return makeAxisGlowHalo({ viewport: { scale } }, {
        a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, width: 0.2,
    }, '#E69F00');
}

const haloAtScaleOne = haloForScale(100);
const haloAtScaleTwo = haloForScale(200);
expect('halo width is identical regardless of the drag start zoom',
    Math.abs(Number(haloAtScaleOne?.getAttribute('stroke-width')) - 0.3) < 1e-9
    && Math.abs(Number(haloAtScaleTwo?.getAttribute('stroke-width')) - 0.3) < 1e-9);

const haloAtLowZoom = haloForScale(0.5);
const lowZoomRing = (Number(haloAtLowZoom?.getAttribute('stroke-width')) - 0.2) / 2 * 0.5;
expect('halo retains a 4px-per-side floor at low zoom', lowZoomRing >= 3.999);

if (failures) process.exitCode = 1;