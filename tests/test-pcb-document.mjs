import assert from 'node:assert/strict';
import { ProjectDocument } from '../src/core/ProjectDocument.js';
import { PcbDocument } from '../src/core/PcbDocument.js';
import { compactProjectAliases, normalizePcbSection } from '../src/core/project-field-aliases.js';
import { defaultPcbStackup } from '../src/core/project-format.js';
import { Track } from '../src/shapes/track.js';
import { Via } from '../src/shapes/via.js';
import { Pad } from '../src/shapes/pad.js';

assert.equal(typeof window, 'undefined');
assert.equal(typeof document, 'undefined');
const project = new ProjectDocument();
const model = project.pcbDocument;
const track = new Track({
    id: 'route-1', net: 'GND', width: 0.234567,
    graphNodes: { n0: { x: 1.234567, y: 2 }, n1: { x: 5, y: 2 }, n2: { x: 5, y: 6 } },
    graphEdges: { e0: { from: 'n0', to: 'n1' }, e1: { from: 'n1', to: 'n2' } },
    edgeWidths: { e1: 0.4 }, edgeLayers: { e1: 'bottom-copper' }, edgeBulges: { e0: 0.25 },
    padConnections: { n0: { componentId: 'U1', pinNumber: '3' } },
});
const via = new Via({ id: 'via_80', x: 5, y: 2, diameter: 0.6, drill: 0.3, net: 'GND' });
const pad = new Pad({ id: 'pad_90', x: 5, y: 6, size: 2, drill: 0.8,
    shape: 'oval', ratio: 2, rotation: 30, layers: 'bottom-copper', net: 'GND', locked: true });
model.tracks.push(track);
model.vias.push(via);
model.pads.push(pad);
const artwork = {};
artwork.self = artwork;
track._svgElements = [artwork];
const saved = model.serializeCopper();
assert.doesNotThrow(() => JSON.stringify(saved), 'Rendering state is never serialized');
assert.equal(track.width, 0.234567, 'Saving leaves live precision untouched');
assert.equal(track.nodes.get('n0').x, 1.234567);
const compact = compactProjectAliases({ pcb: { stackup: defaultPcbStackup(), ...saved } }).pcb;
const reloaded = new PcbDocument();
const arrays = [reloaded.tracks, reloaded.vias, reloaded.pads];
for (const input of [compact, normalizePcbSection(compact)]) {
    const prepared = PcbDocument.prepareCopper(input);
    reloaded.loadCopper(input, prepared);
    assert.equal(reloaded.tracks[0], prepared.tracks[0], 'Loading adopts prepared entities without cloning');
    assert.equal(reloaded.vias[0], prepared.vias[0]);
    assert.equal(reloaded.pads[0], prepared.pads[0]);
    assert.deepEqual(reloaded.serializeCopper(), saved, 'Both field formats preserve geometry and metadata');
    assert.equal(reloaded.tracks, arrays[0]);
    assert.equal(reloaded.vias, arrays[1]);
    assert.equal(reloaded.pads, arrays[2]);
}
assert.equal(new Via({ x: 0, y: 0, diameter: 0.6, drill: 0.3 }).id, 'via_81');
assert.equal(new Pad().id, 'pad_91', 'Loading restores ID reservations after clearing');
const before = reloaded.serializeCopper();
assert.throws(() => reloaded.loadCopper({ stackup: defaultPcbStackup(), tracks: [{ type: 'circle' }] }), /Invalid PCB track/);
assert.deepEqual(reloaded.serializeCopper(), before, 'Invalid input is rejected before replacing live copper');
assert.throws(() => reloaded.loadCopper({ stackup: {
    copperLayers: ['top-copper', 'inner-copper-1', 'inner-copper-2', 'bottom-copper'],
} }), /two-layer/);
assert.deepEqual(reloaded.serializeCopper(), before);
saved.vias[0].x = 999;
assert.equal(via.x, 5, 'Serialized snapshots do not alias live objects');
assert.equal(reloaded.vias[0].x, 5, 'Loaded data does not alias its input');
reloaded.clearCopper();
assert.deepEqual(reloaded.serializeCopper(), { tracks: [], vias: [], pads: [] });
assert.equal(reloaded.tracks, arrays[0], 'Clearing retains collection identity');
assert.equal(model.tracks[0], track, 'Separate project models are independent');
console.log('PASS headless PCB copper ownership, alias compatibility, precision, topology and ID restoration');

globalThis.window = { addEventListener() {} };
globalThis.document = { getElementById: () => null };
const { default: PCBApp } = await import('../src/ui/PCBApp.js');
const { CommandHistory } = await import('../src/core/CommandHistory.js');
const { AddTrackCommand, AddViaCommand, RemoveTrackCommand, RemoveViaCommand } =
    await import('../src/pcb/modules/track-commands.js');
const { AddPadCommand, RemovePadCommand, MovePadCommand } = await import('../src/pcb/modules/pad-commands.js');
const { cancelPictureCopperRefresh } = await import('../src/pcb/modules/picture-refresh.js');
track._svgElements = [];
const app = new PCBApp(project);
assert.equal(app.pcbDocument, model);
assert.equal(app.tracks[0], track, 'Constructing a view must not clear an already-loaded model');
assert.equal(app.vias[0], via);
assert.equal(app.pads[0], pad);
assert.equal(app.placementState, model.placementState);
assert.equal(app.designSettings, model.designSettings);
assert.notEqual(new PCBApp().pcbDocument, model, 'Standalone views retain independent models');
app._getLayerGroup = () => null;
app._refreshClearanceHalos = () => {};
app._refreshFills = () => {};
const history = new CommandHistory();
try {
    for (const [key, object, Add, Remove] of [
        ['tracks', track, AddTrackCommand, RemoveTrackCommand],
        ['vias', via, AddViaCommand, RemoveViaCommand],
        ['pads', pad, AddPadCommand, RemovePadCommand],
    ]) {
        history.execute(new Remove(app, object));
        assert.equal(model[key].length, 0, `${key} removal mutates the authoritative collection`);
        history.undo();
        assert.equal(model[key][0], object);
        history.redo();
        assert.equal(model[key].length, 0);
        history.execute(new Add(app, object));
        assert.equal(model[key][0], object);
        history.undo();
        assert.equal(model[key].length, 0);
        history.redo();
        assert.equal(model[key][0], object, `${key} redo retains entity identity`);
        assert.equal(app[key], model[key], 'Array replacement must not detach the view from the model');
    }
    history.execute(new MovePadCommand(app, pad, { x: 5, y: 6 }, { x: 12, y: 18 }));
    assert.equal(model.serializeCopper().pads[0].x, 12);
    history.undo();
    assert.equal(model.serializeCopper().pads[0].x, 5);
    history.redo();
    assert.equal(model.serializeCopper().pads[0].x, 12);
    model.tracks = [];
    assert.equal(app.tracks.length, 0, 'Model-side array replacement is visible to the editor');
    history.execute(new AddTrackCommand(app, track, [via]));
    assert.equal(model.tracks[0], track);
    assert.equal(model.vias.length, 1, 'Adding a route does not duplicate an existing associated via');
    history.undo();
    assert.equal(model.tracks.length, 0);
    assert.equal(model.vias.length, 0);
    history.redo();
    assert.equal(model.tracks[0], track);
    assert.equal(model.vias[0], via);
} finally {
    cancelPictureCopperRefresh(app);
}
console.log('PASS real PCB construction and copper command execute/undo/redo update the project model');
