import assert from 'node:assert/strict';

globalThis.window = { addEventListener() {} };
globalThis.document = {
    getElementById() { return null; }, querySelector() { return null; },
    createElementNS() {
        const attributes = new Map();
        return { style: {}, children: [], setAttribute(name, value) { attributes.set(name, String(value)); },
            getAttribute(name) { return attributes.get(name) ?? null; }, removeAttribute(name) { attributes.delete(name); },
            appendChild(child) { this.children.push(child); }, remove() {}, querySelectorAll() { return []; } };
    },
};
globalThis.requestAnimationFrame = callback => { callback(); return 1; };
const { beginSelectionInteraction, finishSelectionInteraction } = await import('../src/pcb/modules/selection-interaction.js');
const { createBoardShapeSelectionAdapter, boardShapeHitTest, renderBoardShapeSegmentSelection } = await import('../src/pcb/modules/board-shapes.js');
const { renderPcbSelectionAnchors } = await import('../src/pcb/modules/selection-anchors.js');

for (const guideClick of [false, true]) {
    const shape = { id: 'rounded-segment', kind: 'rect', layer: 'top-copper', lineWidth: 0.2, cornerRadius: 8,
        points: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 30 }, { x: 0, y: 30 }] };
    const app = { boardShapes: [shape], placements: new Map(), tracks: [], vias: [], texts: new Map(),
        _shapeElements: new Map(), _getLayerGroup() { return null; },
        viewport: { scale: 100, setCrosshair() {}, hideCrosshair() {} }, _snapToGrid(point) { return point; },
        history: { execute(command) { command.execute(); } } };
    const first = { x: 12, y: 0 };
    const second = guideClick ? { x: 2, y: 0 } : first;
    assert.ok(beginSelectionInteraction(app, first, false));
    finishSelectionInteraction(app, true);
    const adapter = createBoardShapeSelectionAdapter(app, shape, shape.id);
    const guide = 'M 0 0 L 40 0 L 40 30 L 0 30 Z';
    assert.equal(adapter.getEditPath(), guide, 'Selection guide follows raw nodes despite the radius');
    if (guideClick) assert.equal(boardShapeHitTest(shape, second, 0.1), false, 'Guide sample is outside the physical rounded stroke');
    assert.ok(beginSelectionInteraction(app, second, false), 'Second click on stroke or guide is consumed');
    finishSelectionInteraction(app, true);
    assert.equal(app._selectedBoardShapeSegment?.segment, 0, 'Second click selects the segment');
    assert.equal(adapter.getEditPath(), guide, 'Segment selection retains the complete straight node guide');
    const overlay = document.createElementNS();
    app._getLayerGroup = layer => layer === 'selection-overlay' ? overlay : null;
    renderPcbSelectionAnchors(app);
    renderBoardShapeSegmentSelection(app);
    const guidePath = overlay.children[0].children[0];
    assert.equal(guidePath.getAttribute('d'), guide);
    assert.equal(guidePath.getAttribute('stroke-width'), '1');
    assert.equal(guidePath.getAttribute('vector-effect'), 'non-scaling-stroke');
    const highlight = overlay.children.find(child => child.getAttribute('class') === 'pcb-shape-segment-selection');
    assert.equal(highlight.getAttribute('d'), 'M 8 0 L 32 0');
    assert.equal(highlight.getAttribute('stroke-width'), String(shape.lineWidth));
    assert.equal(highlight.getAttribute('vector-effect'), null, 'Segment highlight scales with the physical stroke');
}
console.log('PASS real second-click segment selection on rounded strokes and straight guides');