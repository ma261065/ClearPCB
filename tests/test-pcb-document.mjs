import assert from 'node:assert/strict';
import { ProjectDocument } from '../src/core/ProjectDocument.js';
import { PcbDocument } from '../src/core/PcbDocument.js';
import { compactProjectAliases, normalizePcbSection } from '../src/core/project-field-aliases.js';
import { defaultPcbStackup } from '../src/core/project-format.js';
import { Track } from '../src/shapes/track.js';
import { Via } from '../src/shapes/via.js';
import { Pad } from '../src/shapes/pad.js';
import { createPcbText, serializePcbText, TEXT_LAYERS } from '../src/core/pcb-text.js';
import { loadBoardShapeData, serializeBoardShapes } from '../src/core/pcb-board-shapes.js';
import { CopperFill } from '../src/shapes/copper-fill.js';
import { boardBoundary, rectangleBoardOutline } from '../src/pcb/modules/board-outline.js';

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
const text = createPcbText({ id: 'annotation', content: 'Data', x: 1.234567, y: -2.345678,
    size: 3.456789, rotation: 23.456789, layer: 'bottom-copper', strokeWidth: 0.234567, border: true });
model.texts.set(text.id, text);
const textSnapshot = serializePcbText(text);
assert.deepEqual(textSnapshot, text, 'Undo/clipboard snapshots retain full text precision');
textSnapshot.x = 999;
assert.equal(text.x, 1.234567, 'Snapshots are independent of the model');
const defaults = createPcbText({ layer: 'unknown', content: '' });
assert.match(defaults.id, /^text-[a-z0-9]+$/);
assert.deepEqual({ ...defaults, id: 'default' }, { id: 'default', content: '', x: 0, y: 0,
    size: 1, rotation: 0, layer: 'top-silk', strokeWidth: 0.15, border: false });
assert.equal('border' in serializePcbText(defaults), false, 'Default border remains omitted');
for (const layer of TEXT_LAYERS) assert.equal(createPcbText({ layer }).layer, layer);
const corners = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 2 }, { x: 0, y: 2 }];
loadBoardShapeData(model, [
    { id: 'pshape_40', kind: 'rect', layer: 'top-silk', points: corners, cornerRadius: 0.2 },
    { id: 'pshape_41', kind: 'circle', layer: 'hole', x: 10, y: 10, radius: 1.234567, plated: true },
], { strict: true });
const rectangle = model.boardShapes[0];
const image = { ...rectangle, id: `pshape_${model.shapeIdCounter++}`, kind: 'image', filled: true, name: 'Artwork',
    artwork: { width: 2, height: 1, rectangles: [{ x: 0, y: 0, width: 2, height: 1 }] } };
model.boardShapes.push(image, { ...image, id: `pshape_${model.shapeIdCounter++}` });
const fill = new CopperFill({ id: 'fill_90', layer: 'top-copper', net: 'GND', outline: corners });
model.boardShapes.push(fill);
const artwork = {};
artwork.self = artwork;
track._svgElements = [artwork];
const saved = model.serializeEntities();
assert.equal(saved.boardShapes[0].points, undefined, 'Rectangle saves remain parametric');
assert.equal(saved.boardShapes[1].radius, 1.2346);
assert.deepEqual(saved.boardShapes[3].artwork, { encoding: 'reference-v1', index: 2 },
    'Repeated image artwork retains deduplicated storage');
assert.equal(model.boardShapes[1].radius, 1.234567, 'Saving leaves live shape geometry unrounded');
assert.deepEqual(saved.texts, [{ id: 'annotation', content: 'Data', x: 1.2346, y: -2.3457,
    size: 3.4568, rotation: 23.4568, layer: 'bottom-copper', strokeWidth: 0.2346, border: true }]);
assert.equal(text.x, 1.234567, 'File rounding does not mutate live text');
assert.doesNotThrow(() => JSON.stringify(saved), 'Rendering state is never serialized');
assert.equal(track.width, 0.234567, 'Saving leaves live precision untouched');
assert.equal(track.nodes.get('n0').x, 1.234567);
const compact = compactProjectAliases({ pcb: { stackup: defaultPcbStackup(), ...saved } }).pcb;
const reloaded = new PcbDocument();
const arrays = [reloaded.tracks, reloaded.vias, reloaded.pads];
const textMap = reloaded.texts;
const shapeArray = reloaded.boardShapes;
for (const input of [compact, normalizePcbSection(compact)]) {
    const prepared = PcbDocument.prepareEntities(input);
    reloaded.loadEntities(input, prepared);
    assert.equal(reloaded.tracks[0], prepared.tracks[0], 'Loading adopts prepared entities without cloning');
    assert.equal(reloaded.vias[0], prepared.vias[0]);
    assert.equal(reloaded.pads[0], prepared.pads[0]);
    assert.equal(reloaded.texts.get(text.id), prepared.texts[0]);
    assert.equal(reloaded.texts, textMap);
    assert.equal(reloaded.boardShapes, shapeArray);
    assert.equal(reloaded.boardShapes[0], prepared.boardShapes[0]);
    assert.equal(reloaded.shapeIdCounter, 44, 'Loaded shape IDs reserve the next generated ID');
    assert.ok(reloaded.boardShapes[4] instanceof CopperFill);
    assert.notEqual(reloaded.boardShapes[2].artwork, reloaded.boardShapes[3].artwork,
        'Referenced image artwork is decoded into independent editable objects');
    assert.deepEqual(reloaded.serializeEntities(), saved, 'Both field formats preserve geometry and metadata');
    assert.equal(reloaded.tracks, arrays[0]);
    assert.equal(reloaded.vias, arrays[1]);
    assert.equal(reloaded.pads, arrays[2]);
}
assert.equal(new Via({ x: 0, y: 0, diameter: 0.6, drill: 0.3 }).id, 'via_81');
assert.equal(new Pad().id, 'pad_91', 'Loading restores ID reservations after clearing');
const before = reloaded.serializeEntities();
assert.throws(() => reloaded.loadEntities({ stackup: defaultPcbStackup(), tracks: [{ type: 'circle' }] }), /Invalid PCB track/);
assert.deepEqual(reloaded.serializeEntities(), before, 'Invalid input is rejected before replacing live entities');
assert.throws(() => reloaded.loadEntities({ stackup: defaultPcbStackup(), texts: [null] }), TypeError);
assert.deepEqual(reloaded.serializeEntities(), before, 'Invalid text preparation cannot clear live entities');
assert.throws(() => reloaded.loadEntities({ stackup: {
    copperLayers: ['top-copper', 'inner-copper-1', 'inner-copper-2', 'bottom-copper'],
} }), /two-layer/);
assert.deepEqual(reloaded.serializeEntities(), before);
for (const boardShapes of [
    [{ kind: 'unknown' }],
    [{ kind: 'line', layer: 'board-outline', points: [{ x: 0, y: 0 }, { x: 2, y: 0 }] }],
    [1, 2].map(index => ({ id: `outline-${index}`, kind: 'circle', layer: 'board-outline', x: 0, y: 0, radius: 2 })),
]) {
    assert.throws(() => reloaded.loadEntities({ stackup: defaultPcbStackup(), boardShapes }),
        /Unknown board shape|one closed/);
    assert.deepEqual(reloaded.serializeEntities(), before, 'Invalid shape/outline preparation cannot replace live entities');
    assert.equal(reloaded.shapeIdCounter, 44);
}
saved.vias[0].x = 999;
assert.equal(via.x, 5, 'Serialized snapshots do not alias live objects');
assert.equal(reloaded.vias[0].x, 5, 'Loaded data does not alias its input');
saved.texts[0].x = 999;
assert.equal(text.x, 1.234567);
assert.equal(reloaded.texts.get(text.id).x, 1.2346, 'Loaded text does not alias its input');
reloaded.clearEntities();
assert.deepEqual(reloaded.serializeEntities(), { boardShapes: [], tracks: [], vias: [], pads: [], texts: [] });
assert.equal(reloaded.tracks, arrays[0], 'Clearing retains collection identity');
assert.equal(reloaded.texts, textMap);
assert.equal(reloaded.boardShapes, shapeArray);
assert.equal(reloaded.shapeIdCounter, 1);
assert.equal(model.tracks[0], track, 'Separate project models are independent');
console.log('PASS headless PCB copper/text ownership, alias compatibility, precision, defaults, topology and ID restoration');

const dimensionsModel = new PcbDocument();
const dimensions = dimensionsModel.board;
const preciseDimensions = { width: 37.123456, height: 21.234567, radius: 2.345678 };
const legacyBoard = { stackup: defaultPcbStackup(), board: preciseDimensions };
for (const data of [legacyBoard, compactProjectAliases({ pcb: legacyBoard }).pcb]) {
    dimensionsModel.loadEntities(data);
    assert.equal(dimensionsModel.board, dimensions, 'Loading retains dimension-object identity');
    assert.deepEqual(dimensions, preciseDimensions, 'Legacy dimensions load without an editor or outline');
    const savedDimensions = dimensionsModel.serializeBoardDimensions();
    assert.deepEqual(savedDimensions, { width: 37.1235, height: 21.2346, radius: 2.3457 });
    savedDimensions.width = 999;
    assert.deepEqual(dimensions, preciseDimensions, 'Save snapshots neither alias nor round live dimensions');
    assert.deepEqual(boardBoundary(dimensionsModel), { x: 0, y: -preciseDimensions.height,
        w: preciseDimensions.width, h: preciseDimensions.height, r: preciseDimensions.radius, points: null },
        'Geometry queries recognize neutral model dimensions without legacy editor fields');
}
for (const [outline, expected] of [
    [rectangleBoardOutline(12, 7, 1), { width: 12, height: 7, radius: 1 }],
    [{ id: 'board-outline', kind: 'polygon', layer: 'board-outline',
        points: [{ x: 0, y: 0 }, { x: 19, y: 0 }, { x: 0, y: -9 }] }, { width: 19, height: 9, radius: 0 }],
    [{ id: 'board-outline', kind: 'circle', layer: 'board-outline', x: 3, y: 7, radius: 4 },
        { width: 8, height: 8, radius: 0 }],
]) {
    dimensionsModel.loadEntities({ ...legacyBoard, boardShapes: [outline] });
    assert.deepEqual(dimensions, expected, 'Actual outline bounds override saved dimension metadata');
    assert.deepEqual(dimensionsModel.serializeBoardDimensions(), expected);
}
for (const data of [null, { stackup: defaultPcbStackup() },
    { stackup: defaultPcbStackup(), board: { width: 0, height: 25, radius: 2 } }]) {
    dimensionsModel.loadEntities(data);
    assert.deepEqual(dimensions, { width: 100, height: 80, radius: 0 },
        'Missing or incomplete legacy dimensions keep the existing New-board defaults');
}
Object.assign(dimensions, preciseDimensions);
dimensionsModel.clearEntities();
assert.equal(dimensionsModel.board, dimensions);
assert.deepEqual(dimensions, { width: 100, height: 80, radius: 0 });
console.log('PASS headless board dimensions, outline precedence, default restoration, geometry queries and save precision');

globalThis.window = { addEventListener() {} };
globalThis.document = {
    getElementById: () => null, documentElement: { getAttribute: () => 'dark' },
    createElementNS() {
        const attributes = new Map();
        return { setAttribute: (key, value) => attributes.set(key, String(value)),
            getAttribute: key => attributes.get(key), style: {}, appendChild() {} };
    },
};
const { default: PCBApp } = await import('../src/ui/PCBApp.js');
const { CommandHistory } = await import('../src/core/CommandHistory.js');
const { AddTrackCommand, AddViaCommand, RemoveTrackCommand, RemoveViaCommand } =
    await import('../src/pcb/modules/track-commands.js');
const { AddPadCommand, RemovePadCommand, MovePadCommand } = await import('../src/pcb/modules/pad-commands.js');
const { cancelPictureCopperRefresh } = await import('../src/pcb/modules/picture-refresh.js');
const { AddTextCommand, RemoveTextCommand, MoveTextCommand, EditTextCommand } =
    await import('../src/pcb/modules/text-commands.js');
const textView = await import('../src/pcb/modules/pcb-text.js');
const shapeView = await import('../src/pcb/modules/board-shapes.js');
const { AddBoardShapeCommand, RemoveBoardShapeCommand } = await import('../src/pcb/modules/shape-commands.js');
const { AddFillCommand, RemoveFillCommand } = await import('../src/pcb/modules/copper-fill-commands.js');
assert.equal(shapeView.serializeBoardShapes, serializeBoardShapes);
assert.equal(textView.createPcbText, createPcbText, 'Existing renderer-module imports reuse the neutral data helper');
assert.equal(textView.serializePcbText, serializePcbText);
assert.equal(textView.TEXT_LAYERS, TEXT_LAYERS);
track._svgElements = [];
Object.assign(model.board, preciseDimensions);
const app = new PCBApp(project);
assert.deepEqual(model.board, preciseDimensions, 'Constructing an editor must not reset loaded dimensions');
assert.deepEqual([app._boardWidth, app._boardHeight, app._boardRadius],
    [preciseDimensions.width, preciseDimensions.height, preciseDimensions.radius]);
assert.equal(app.pcbDocument, model);
assert.equal(app.tracks[0], track, 'Constructing a view must not clear an already-loaded model');
assert.equal(app.vias[0], via);
assert.equal(app.pads[0], pad);
assert.equal(app.texts.get(text.id), text, 'Constructing the editor preserves preloaded text');
assert.equal(app.texts, model.texts);
assert.equal(app.boardShapes[0], rectangle, 'Constructing a view must not clear preloaded board shapes');
assert.equal(app.boardShapes, model.boardShapes);
assert.equal(app._shapeIdCounter, model.shapeIdCounter);
app._shapeIdCounter++;
assert.equal(model.shapeIdCounter, 45, 'Editor ID allocation updates the model counter');
assert.equal(app.placementState, model.placementState);
assert.equal(app.designSettings, model.designSettings);
assert.notEqual(new PCBApp().pcbDocument, model, 'Standalone views retain independent models');
app._getLayerGroup = () => null;
app._refreshClearanceHalos = () => {};
app._refreshFills = () => {};
app._refreshBoardShapeClearance = () => {};
app._scheduleRemovalHatchRender = () => {};
app._updateRatsnest = () => {};
app._recomputeFillsNow = () => false;
app._updateCopperCuts = () => {};
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
    assert.equal(model.serializeEntities().pads[0].x, 12);
    history.undo();
    assert.equal(model.serializeEntities().pads[0].x, 5);
    history.redo();
    assert.equal(model.serializeEntities().pads[0].x, 12);
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
    for (const [shape, Add, Remove] of [
        [rectangle, AddBoardShapeCommand, RemoveBoardShapeCommand],
        [fill, AddFillCommand, RemoveFillCommand],
    ]) {
        const count = model.boardShapes.length;
        history.execute(new Remove(app, shape));
        assert.equal(model.boardShapes.includes(shape), false);
        assert.equal(model.boardShapes.length, count - 1);
        history.undo();
        assert.equal(model.boardShapes.includes(shape), true);
        history.redo();
        assert.equal(model.boardShapes.includes(shape), false);
        history.execute(new Add(app, shape));
        assert.equal(model.boardShapes.includes(shape), true);
        history.undo();
        assert.equal(model.boardShapes.includes(shape), false);
        history.redo();
        assert.equal(model.boardShapes.includes(shape), true);
        assert.equal(model.boardShapes.length, count, 'Shape/fill undo/redo preserves identity without duplication');
    }
    const added = createPcbText({ ...text, id: 'edited-text' });
    history.execute(new AddTextCommand(app, added));
    assert.equal(model.texts.get(added.id), added);
    history.undo();
    assert.equal(model.texts.has(added.id), false);
    history.redo();
    assert.equal(model.texts.get(added.id), added, 'Adding text keeps entity identity through undo/redo');
    history.execute(new MoveTextCommand(app, added.id, added.x, added.y, Math.PI, -Math.PI));
    assert.equal(model.texts.get(added.id).x, Math.PI);
    history.undo();
    assert.equal(added.x, text.x);
    history.redo();
    assert.equal(added.x, Math.PI, 'Move undo/redo does not round coordinates');
    const beforeEdit = serializePcbText(added);
    history.execute(new EditTextCommand(app, added.id, {
        content: '', size: Math.PI, strokeWidth: 0.123456, rotation: 90.123456, layer: 'top-silk', border: false,
    }));
    const afterEdit = serializePcbText(added);
    assert.equal(afterEdit.rotation, 90.123456);
    assert.equal(afterEdit.size, Math.PI);
    assert.equal(afterEdit.border, undefined);
    history.undo();
    assert.deepEqual(serializePcbText(added), beforeEdit);
    history.redo();
    assert.deepEqual(serializePcbText(added), afterEdit);
    history.execute(new RemoveTextCommand(app, added.id));
    assert.equal(model.texts.has(added.id), false);
    history.undo();
    assert.deepEqual(serializePcbText(model.texts.get(added.id)), afterEdit,
        'Delete undo restores the full-precision snapshot with its original ID');
    history.redo();
    assert.equal(model.texts.has(added.id), false);
    history.undo();
    history.undo();
    assert.deepEqual(serializePcbText(model.texts.get(added.id)), beforeEdit,
        'Earlier edits still undo correctly after delete/restore replaces the text object');
    app.texts = new Map([[text.id, text]]);
    assert.equal(model.texts, app.texts, 'Editor-side map replacement updates the model');
    model.texts = new Map();
    assert.equal(app.texts.size, 0, 'Model-side map replacement is visible to the editor');
    app.boardShapes = [fill];
    assert.equal(model.boardShapes, app.boardShapes);
    assert.deepEqual(app.copperFills, [fill], 'Pour queries use the authoritative board-shape collection');
} finally {
    cancelPictureCopperRefresh(app);
}
console.log('PASS real PCB construction and copper/text command execute/undo/redo update the project model');
