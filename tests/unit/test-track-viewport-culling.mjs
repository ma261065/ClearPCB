import assert from 'node:assert/strict';
import { Track } from '../../src/shapes/track.js';
import { Via } from '../../src/shapes/via.js';
import { fakeElement, installFakeDom } from './helpers/fake-dom.mjs';
import { renderTrack, renderVia, setTrackLabelsVisible, updateTrackViewportCulling } from '../../src/pcb/modules/track-render.js';

installFakeDom();
const groups = new Map(['top-copper', 'bottom-copper', 'top-copper-track-labels', 'bottom-copper-track-labels', 'vias']
    .map(layer => [layer, fakeElement('g')]));
const getGroup = layer => groups.get(layer);
const track = new Track({ net: 'LONG_NET', layer: 'top-copper', width: 0.5,
    points: [{ x: 0, y: 0 }, { x: 200, y: 0 }] });
const via = new Via({ x: 180, y: 0, diameter: 2, drill: 1 });
renderTrack(track, getGroup);
renderVia(via, getGroup);
const labels = [...groups.get('top-copper-track-labels').children];
assert.ok(labels.length > 10);
const view = { minX: -5, minY: -10, maxX: 30, maxY: 10 };
updateTrackViewportCulling([track], [via], view);
assert.ok(labels.some(el => el.classList.contains('culled')), 'Off-screen labels on a visible long run are hidden individually');
assert.ok(labels.some(el => !el.classList.contains('culled')), 'On-screen labels stay visible');
assert.equal(groups.get('top-copper').firstChild.classList.contains('culled'), false, 'Crossing copper is not culled');
assert.ok(groups.get('vias').children.every(el => el.classList.contains('culled')));
let writes = 0;
for (const element of [...labels, ...groups.get('top-copper').children, ...groups.get('vias').children]) {
    const toggle = element.classList.toggle.bind(element.classList);
    element.classList.toggle = (...args) => { writes++; return toggle(...args); };
}
updateTrackViewportCulling([track], [via], view);
assert.equal(writes, 0, 'Unchanged pan coverage performs no visibility writes');
assert.equal(setTrackLabelsVisible(track, false), true, 'Selection can still find culled labels');
updateTrackViewportCulling([track], [via], { minX: 160, minY: -10, maxX: 205, maxY: 10 });
assert.ok(groups.get('vias').children.every(el => !el.classList.contains('culled')));
assert.ok(labels.every(el => el.style.display === 'none'), 'Culling does not undo selection label suppression');
setTrackLabelsVisible(track, true);
updateTrackViewportCulling([track], [via], null);
assert.ok(labels.every(el => !el.classList.contains('culled')), 'Export restores even distant labels');
for (const node of track.nodes.values()) node.x += 500;
renderTrack(track, getGroup);
updateTrackViewportCulling([track], [via], view);
assert.ok(groups.get('top-copper').children.every(el => el.classList.contains('culled')),
    'Rerendered moved tracks use fresh bounds');
renderTrack(track, getGroup, { hideNetLabel: true });
assert.equal(setTrackLabelsVisible(track, true), false, 'Omitted labels retain their existing selection rebuild behavior');
const diagonal = new Track({ net: 'ROTATED_LONG_NET', layer: 'bottom-copper', width: 0.5,
    points: [{ x: -100, y: -100 }, { x: 100, y: 100 }] });
renderTrack(diagonal, getGroup);
updateTrackViewportCulling([diagonal], [], { minX: -2, minY: -2, maxX: 2, maxY: 2 });
assert.ok([...groups.get('bottom-copper-track-labels').children].some(el => !el.classList.contains('culled')),
    'Rotated labels near view edges retain a conservative glyph envelope');
console.log('PASS track run, label and via viewport culling, selection, export restore and rerender');
