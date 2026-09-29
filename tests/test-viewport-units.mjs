import assert from 'node:assert/strict';
import test from 'node:test';
import { Viewport } from '../src/core/Viewport.js';

function element() {
    return { style: {}, appendChild() {}, setAttribute() {}, querySelector: () => null };
}
globalThis.document = { createElement: element, createElementNS: element };
globalThis.localStorage = { getItem: () => null };

class TestViewport extends Viewport {
    constructor() {
        super({ ...element(), clientWidth: 800, clientHeight: 600 });
    }
    _getThemeColors() { return {}; }
    _loadPersistedTitleBlockData() { return {}; }
    _updateViewBox() {}
    _createGrid() {}
    _createRulers() {}
    _bindEvents() {}
    _disableBrowserZoom() {}
    get scale() { return this.testScale || 4; }
    getVisibleBounds() { return { minX: 0, minY: 0, maxX: this.width / this.scale, maxY: this.height / this.scale }; }
    worldToScreen(point) { return point; }
}

function close(actual, expected, description) {
    assert.ok(Math.abs(actual - expected) <= Math.max(1, Math.abs(expected)) * 1e-12,
        `${description}: expected ${expected}, got ${actual}`);
}

test('Viewport uses the exact inch/mm relationship in both directions', () => {
    const viewport = new TestViewport();
    for (const units of ['mm', 'inch']) {
        viewport.units = units;
        for (const value of [0, 0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.0625, 0.125, 1, 10, -0.125, -100]) {
            const mm = units === 'inch' ? value * 25.4 : value;
            close(viewport.fromDisplayUnits(value), mm, `${value} ${units} to mm`);
            close(viewport.toDisplayUnits(mm), value, `${mm} mm to ${units}`);
        }
    }
    viewport.units = 'inch';
    assert.equal(viewport.formatValue(25.4, 8), '1.00000000');
    for (const option of viewport.getGridOptions()) {
        close(viewport.toDisplayUnits(option.value), Number(option.label.replace('"', '')), 'Grid label matches its physical spacing');
    }
});

function topLabels(viewport) {
    viewport._buildRulers();
    const top = viewport.rulerContainer.innerHTML.match(/<g id="rulerTopTicks-[^"]+">([\s\S]*?)<\/g>/)[1];
    return [...top.matchAll(/<text x="([^"]+)" y="12"[^>]*>([^<]*)<\/text>/g)]
        .map(match => ({ worldX: Number(match[1]) - 2, label: match[2] }));
}

test('Inch ruler ticks align with exact physical dimensions', () => {
    const viewport = new TestViewport();
    viewport.units = 'inch';
    const labels = topLabels(viewport);
    for (const inches of [-1, 0, 1, 2]) {
        const tick = labels.find(item => item.label === `${inches}"`);
        assert.ok(tick, `Missing ${inches}-inch ruler tick`);
        close(tick.worldX, inches * 25.4, `${inches}-inch ruler position`);
    }
});

test('Fractional inch ruler labels retain all required digits', () => {
    const viewport = new TestViewport();
    viewport.units = 'inch';
    viewport.gridVisible = false;
    for (const [scale, spacing] of [[30, 0.125], [60, 0.0625], [8, 0.5], [15, 0.25]]) {
        viewport.testScale = scale;
        const labels = topLabels(viewport);
        for (const multiple of [-1, 1, 3]) {
            const inches = spacing * multiple;
            const tick = labels.find(item => item.label === `${inches}"`);
            assert.ok(tick, `Missing exact ${inches}-inch label at scale ${scale}`);
            close(tick.worldX, inches * 25.4, 'Fractional ruler tick position');
        }
    }
});

test('Metric rulers retain clean labels and bounded tick counts at extreme zoom', () => {
    const viewport = new TestViewport();
    viewport.gridVisible = false;
    for (const [scale, spacing] of [[4, 20], [800, 0.1]]) {
        viewport.testScale = scale;
        const labels = topLabels(viewport);
        assert.ok(labels.some(item => item.label === String(spacing)));
        assert.ok(labels.every(item => !item.label.includes('"')));
    }
    viewport.testScale = 0.000001;
    for (const units of ['mm', 'inch']) {
        viewport.units = units;
        const labels = topLabels(viewport);
        assert.ok(labels.length > 0 && labels.length <= 1001, 'Extreme zoom keeps ruler output bounded');
        assert.ok(labels.every(item => Number.isFinite(item.worldX)));
    }
});

test('A visible 0.1-inch grid gets labels at 0.1-inch grid lines on both rulers', () => {
    const viewport = new TestViewport();
    viewport.units = 'inch';
    viewport.gridSize = 2.54;
    viewport.testScale = 55;
    const labels = topLabels(viewport);
    for (const inches of [-0.1, 0.1, 0.2]) {
        const tick = labels.find(item => item.label === `${inches}"`);
        assert.ok(tick, `Missing ${inches}-inch grid-aligned label`);
        close(tick.worldX, inches * 25.4, 'Grid-aligned top ruler label');
    }
    assert.equal(labels.some(item => item.label === '0.125"'), false);
    const left = [...viewport.rulerContainer.innerHTML.matchAll(/<text x="3" y="([^"]+)"[^>]*>([^<]*)<\/text>/g)]
        .map(match => ({ worldY: Number(match[1]) - 3, label: match[2] }));
    const tick = left.find(item => item.label === '0.1"');
    assert.ok(tick, 'The vertical ruler also labels the 0.1-inch grid line');
    close(tick.worldY, -2.54, 'Vertical ruler retains the inverted Y label convention');
});

test('Visible-grid labels remain on displayed grid lines without crowding across presets and zooms', () => {
    const viewport = new TestViewport();
    for (const units of ['mm', 'inch']) {
        viewport.units = units;
        for (const option of viewport.getGridOptions()) {
            viewport.gridSize = option.value;
            for (const scale of viewport.zoomScales) {
                viewport.testScale = scale;
                const grid = viewport.getEffectiveGridSize();
                const labels = topLabels(viewport);
                assert.ok(labels.length > 0 && labels.length <= 1001);
                for (let index = 0; index < labels.length; index++) {
                    const gridIndex = labels[index].worldX / grid;
                    close(gridIndex, Math.round(gridIndex), `Displayed grid alignment for ${option.value} mm at scale ${scale}`);
                    if (index) {
                        const spacing = (labels[index].worldX - labels[index - 1].worldX) * scale;
                        assert.ok(spacing >= 80 - 1e-8, 'Major labels stay at least 80 screen pixels apart');
                    }
                }
            }
        }
    }
});

test('The ruler tick cap retains grid alignment for unusually large views', () => {
    const viewport = new TestViewport();
    viewport.gridSize = 0.0254;
    viewport.testScale = 500;
    viewport.getVisibleBounds = () => ({ minX: 0, minY: 0, maxX: 50000, maxY: 50000 });
    const labels = topLabels(viewport);
    assert.ok(labels.length > 0 && labels.length <= 1001);
    for (const tick of labels) {
        const gridIndex = tick.worldX / viewport.getEffectiveGridSize();
        close(gridIndex, Math.round(gridIndex), 'Capped ruler label stays on a displayed grid line');
    }
});

test('Grid changes refresh ruler labels while ordinary pans reuse the ruler cache', () => {
    const viewport = new TestViewport();
    viewport.units = 'inch';
    viewport.testScale = 55;
    viewport.rulerContainer.firstElementChild = {};
    viewport._createRulers = Viewport.prototype._createRulers;
    let builds = 0;
    viewport._buildRulers = function () {
        builds++;
        Viewport.prototype._buildRulers.call(this);
    };
    viewport._createRulers();
    assert.equal(builds, 1);
    viewport.viewBox.x += 1;
    viewport._createRulers();
    assert.equal(builds, 1, 'Panning retains the translation-only fast path');
    viewport.setGridSize(2.54);
    assert.equal(builds, 2, 'Grid size changes rebuild labels immediately');
    assert.match(viewport.rulerContainer.innerHTML, />0\.1"<\/text>/);
    viewport.setGridVisible(false);
    assert.equal(builds, 3);
    assert.match(viewport.rulerContainer.innerHTML, />0\.0625"<\/text>/);
    viewport.setGridVisible(true);
    assert.equal(builds, 4);
    viewport.setGridStyle('dots');
    viewport._createRulers();
    assert.equal(builds, 4, 'Line/dot style does not change label spacing');
});
