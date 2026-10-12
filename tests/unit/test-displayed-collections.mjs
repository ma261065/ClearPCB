import assert from 'node:assert/strict';
import { installFakeDom } from './helpers/fake-dom.mjs';

installFakeDom();
const { pcbEditorFixture } = await import('./pcb-editor-fixture.mjs');
const { setPcbInteraction } = await import('../../src/pcb/modules/pcb-interactions.js');
const { PREVIEW_SOURCES, displayedCollection } = await import('../../src/pcb/modules/displayed-collections.js');

// PCBApp's collection getters show a preview's detached copies while it runs: the first
// active source in displayed-collections.js that replaces a collection supplies it, in
// the order listed there (outermost first), otherwise the document does.

const COLLECTIONS = ['tracks', 'vias', 'pads', 'texts', 'boardShapes'];
const app = pcbEditorFixture();
const document = app.pcbDocument;

for (const key of COLLECTIONS) {
    assert.equal(app[key], document[key], `with no preview, ${key} is the document's`);
    assert.equal(displayedCollection(app, key), document[key]);
}

// A via drag replaces tracks, vias and pads, and nothing it does not name.
const viaDrag = { preview: { tracks: [], vias: [], pads: [], boardShapes: [], texts: new Map() } };
setPcbInteraction(app, '_viaDrag', viaDrag);
for (const key of ['tracks', 'vias', 'pads']) assert.equal(app[key], viaDrag.preview[key], `a via drag shows its ${key}`);
for (const key of ['texts', 'boardShapes']) assert.equal(app[key], document[key], `a via drag does not replace ${key}`);

// A group move outranks a pointer drag for every collection it holds.
const groupDrag = { preview: { tracks: [], vias: [], pads: [], boardShapes: [] } };
setPcbInteraction(app, '_groupDrag', groupDrag);
for (const key of ['tracks', 'vias', 'pads', 'boardShapes']) assert.equal(app[key], groupDrag.preview[key], `a group move shows its ${key}`);
assert.equal(app.texts, document.texts, 'a group move does not replace texts');

// A source whose preview has not built a collection yet falls through to the next one.
groupDrag.preview.pads = undefined;
assert.equal(app.pads, viaDrag.preview.pads, 'an unbuilt collection falls through to the next source');

setPcbInteraction(app, '_groupDrag', null);
setPcbInteraction(app, '_viaDrag', null);
for (const key of COLLECTIONS) assert.equal(app[key], document[key], `after the previews end, ${key} is the document's again`);

// Setters write the document, never a preview's copy.
const tracks = [];
setPcbInteraction(app, '_viaDrag', viaDrag);
app.tracks = tracks;
setPcbInteraction(app, '_viaDrag', null);
assert.equal(document.tracks, tracks, 'assigning tracks writes the document');

// The table names each source once and only real collections.
assert.equal(new Set(PREVIEW_SOURCES.map(source => source.name)).size, PREVIEW_SOURCES.length, 'source names are unique');
for (const source of PREVIEW_SOURCES) {
    assert.ok(source.collections.length && source.collections.every(key => COLLECTIONS.includes(key)), `${source.name} names real collections`);
    assert.equal(source.preview(app) ?? null, null, `${source.name} is inactive on an idle editor`);
}
console.log('PASS displayed collections: previews replace what they name, outermost first, else the document');
