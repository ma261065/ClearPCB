import assert from 'node:assert/strict';
import { installFakeDom } from './helpers/fake-dom.mjs';
import { pcbEditorStubs } from './helpers/pcb-editor-stubs.mjs';

installFakeDom();
const { Track } = await import('../../src/shapes/track.js');
const { hitTestTrack } = await import('../../src/pcb/modules/track-select.js');
const { getPcbSelectionHits } = await import('../../src/pcb/modules/selection-registry.js');

for (const scale of [5, 20, 100, 500]) {
    const gap = 0.1 + 14 / scale;
    const tracks = [0, gap].map((y, index) => new Track({
        net: `NET${index}`, width: 0.1, layer: 'top-copper',
        points: [{ x: 0, y }, { x: 20, y }],
    }));
    const app = {
        ...pcbEditorStubs(), placements: new Map(), tracks, vias: [], pads: [],
        boardShapes: [], texts: new Map(), viewport: { scale },
    };
    for (const track of tracks) {
        const point = { x: 8, y: track.nodes.values().next().value.y };
        assert.equal(hitTestTrack(app, point)?.track, track);
        assert.equal(getPcbSelectionHits(app, point)[0]?.object, track,
            `Click and hover must identify the same net at scale ${scale}`);
    }
    const via = { id: 'nearby-via', x: 8, y: -gap, diameter: 0.1, drill: 0.05 };
    app.vias.push(via);
    assert.equal(getPcbSelectionHits(app, { x: 8, y: 0 })[0]?.object, tracks[0],
        'A nearby via outside the hover margin cannot steal the track click');
}
console.log('PASS track/via click and hover margins agree across zoom levels and neighbouring nets');
