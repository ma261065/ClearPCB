import assert from 'node:assert/strict';
import { fitContentBounds, fitToContent } from '../../src/shared/ui/viewport.js';
import { Viewport } from '../../src/core/Viewport.js';

const calls = [];
const viewport = {
    fitToBounds(...args) { calls.push(args); },
    resetView(margins) { calls.push(['empty', margins]); },
};
for (const bounds of [
    { minX: 15, minY: -40, maxX: 80, maxY: -10 },
    { minX: -20, minY: -30, maxX: 40, maxY: 25 },
]) {
    fitContentBounds(viewport, bounds);
    const pcbFraming = calls.pop();
    fitToContent({ viewport, shapes: [{ getBounds: () => bounds }], components: [] });
    assert.deepEqual(calls.pop(), pcbFraming, 'Schematic content uses the shared PCB Fit offsets');
    assert.deepEqual(pcbFraming, [
        Math.min(0, bounds.minX) - 10, Math.min(0, bounds.minY),
        Math.max(0, bounds.maxX), Math.max(0, bounds.maxY) + 10, 0, 'bottom-left',
    ]);
}
fitToContent({ viewport, shapes: [], components: [] });
assert.deepEqual(calls.pop(), ['empty', { leftMargin: 10, bottomMargin: 10 }],
    'Empty schematic keeps its safe initial zoom but uses the same Fit margins');
const view = {
    width: 1000, height: 600, zoomScales: [2, 4, 8, 16], minZoomIndex: 0,
    viewBox: {}, _hasValidSize: () => true, _updateViewBox() {}, _notifyViewChanged() {},
    fitToBounds: Viewport.prototype.fitToBounds,
};
fitContentBounds(view, { minX: 0, minY: -80, maxX: 100, maxY: 0 });
assert.equal(view.viewBox.x, -10);
assert.equal(view.viewBox.y + view.viewBox.height, 10);
assert.ok(view.viewBox.width >= 110 && view.viewBox.height >= 90, 'Fit contains the full content and offsets');
const emptyView = {
    width: 1000, height: 600, zoomScales: Array.from({ length: 9 }, () => 5),
    showRulers: true, rulerSize: 25, viewBox: {}, _hasValidSize: () => true,
    _updateViewBox() {}, _notifyViewChanged() {}, resetView: Viewport.prototype.resetView,
};
for (const showRulers of [false, true]) {
    emptyView.showRulers = showRulers;
    fitToContent({ viewport: emptyView, shapes: [], components: [] });
    assert.equal(emptyView.zoomIndex, 8, 'Empty Fit retains the normal 100% zoom');
    assert.equal(emptyView.viewBox.x, -(10 + (showRulers ? 5 : 0)),
        'Empty Fit has a 10 mm left margin inside the ruler');
    assert.equal(emptyView.viewBox.y + emptyView.viewBox.height, 10);
    emptyView.resetView();
    assert.equal(emptyView.viewBox.x, -(3 + (showRulers ? 5 : 0)),
        'Ordinary initial/reset callers retain their existing ruler-aware framing');
    assert.equal(emptyView.viewBox.y + emptyView.viewBox.height, 3);
}
for (const rulerSize of [0, 25, 40]) for (const width of [577, 1000, 1400]) {
    const fitted = { ...view, width, height: 650, viewBox: {}, rulerSize, showRulers: rulerSize > 0 };
    fitContentBounds(fitted, { minX: 0, minY: -80, maxX: 100, maxY: 0 });
    const scale = fitted.zoomScales[fitted.zoomIndex];
    assert.ok(Math.abs((-fitted.viewBox.x * scale - rulerSize) / scale - 10) < 1e-9);
    assert.equal(fitted.viewBox.y + fitted.viewBox.height, 10);
    assert.ok((100 - fitted.viewBox.x) * scale <= width,
        'Zoom fits the right edge after reserving the left ruler');
    assert.ok((-80 - fitted.viewBox.y) * scale >= rulerSize,
        'Zoom fits the top edge below the top ruler');
}
const tightView = { ...view, width: 450, height: 650, viewBox: {}, showRulers: true, rulerSize: 25 };
fitContentBounds(tightView, { minX: 0, minY: -80, maxX: 100, maxY: 0 });
assert.equal(tightView.zoomScales[tightView.zoomIndex], 2,
    'Fit must step down a zoom level when the ruler makes the tighter level too small');
const hiddenView = { ...emptyView, _hasValidSize: () => false, viewBox: { x: 1, y: 2, width: 3, height: 4 } };
fitToContent({ viewport: hiddenView, shapes: [], components: [] });
assert.deepEqual(hiddenView.viewBox, { x: 1, y: 2, width: 3, height: 4 }, 'Fit does not corrupt a hidden viewport');
console.log('PASS shared schematic/PCB Fit framing, origin inclusion, exact margins and empty schematic fallback');
