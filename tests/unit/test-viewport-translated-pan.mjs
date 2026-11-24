import assert from 'node:assert/strict';
import { Viewport } from '../../src/core/Viewport.js';
import { fakeElement, installFakeDom } from './helpers/fake-dom.mjs';

installFakeDom();
class TestViewport extends Viewport {
    _getThemeColors() { return {}; }
    _loadPersistedTitleBlockData() { return {}; }
    _createGrid() {}
    _createRulers() {}
    _bindEvents() {}
    _disableBrowserZoom() {}
    _notifyViewChanged() {}
}

for (const wrapperPan of [false, true]) {
    const viewport = new TestViewport(fakeElement('div'), { wrapperPan });
    viewport.cachedRect = { width: 800, height: 600, left: 0, top: 0 };
    viewport.viewBox = { x: -100, y: -60, width: 200, height: 150 };
    viewport._updateViewBox();
    const initial = viewport.svg.getAttribute('viewBox');
    viewport.startPan(200, 200);
    viewport.updatePan(240, 220);
    assert.equal(viewport.viewBox.x, -110);
    assert.equal(viewport.viewBox.y, -65);
    const pointer = viewport.screenToWorld({ x: 240, y: 220 });
    assert.ok(Math.abs(pointer.x + 50) < 1e-10 && Math.abs(pointer.y + 10) < 1e-10);
    if (wrapperPan) {
        assert.equal(viewport.svg.getAttribute('viewBox'), initial, 'Translated panning avoids SVG viewBox relayout');
        assert.equal(viewport.panWrapper.style.transform, 'translate3d(40px, 20px, 0)');
        viewport.viewBox.width = 100;
        viewport.viewBox.height = 75;
        viewport._updateViewBox();
        assert.equal(viewport.panWrapper.style.transform, 'translate3d(0,0,0)', 'Zoom during pan rebases the scene');
        assert.equal(viewport.svg.getAttribute('viewBox'), '-110 -65 100 75');
        viewport.updatePan(280, 240);
        assert.equal(viewport.panWrapper.style.transform, 'translate3d(0px, 0px, 0)');
        viewport.updatePan(290, 250);
        assert.equal(viewport.panWrapper.style.transform, 'translate3d(10px, 10px, 0)');
    } else {
        assert.notEqual(viewport.svg.getAttribute('viewBox'), initial, 'Default schematic viewport behavior is unchanged');
        assert.equal(viewport.contentLayer.getAttribute('transform'), null);
    }
    viewport.endPan();
    if (wrapperPan) assert.equal(viewport.panWrapper.style.transform, 'translate3d(0,0,0)', 'Release resets the wrapper');
    assert.equal(viewport._panRenderViewBox, null);
    const box = viewport.viewBox;
    assert.equal(viewport.svg.getAttribute('viewBox'), `${box.x} ${box.y} ${box.width} ${box.height}`);
    viewport.startPan(100, 100);
    viewport.updatePan(140, 100);
    const beforeRestart = viewport.panWrapper?.style.transform;
    viewport.startPan(140, 100);
    viewport.updatePan(140, 100);
    assert.equal(viewport.panWrapper?.style.transform, beforeRestart,
        'Pressing a second pan button must not reset the rendered origin or jump the artwork');
    viewport.updatePan(180, 100);
    viewport.endPan();
    if (wrapperPan) assert.equal(viewport.panWrapper.style.transform, 'translate3d(0,0,0)', 'Repeated gestures do not accumulate transforms');
}
console.log('PASS translated PCB panning, coordinate mapping, zoom rebase, release and unchanged default viewport');
