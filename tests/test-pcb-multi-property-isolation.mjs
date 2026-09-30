import assert from 'node:assert/strict';
import { ProjectDocument } from '../src/core/ProjectDocument.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { captureBoardShapeState } from '../src/core/pcb-board-shapes.js';
import { Track } from '../src/shapes/track.js';
import { CopperFill } from '../src/shapes/copper-fill.js';
import { cancelPictureCopperRefresh } from '../src/pcb/modules/picture-refresh.js';
import { getComputedFill, setComputedFill } from '../src/pcb/modules/computed-fill-cache.js';

let allocations = 0;
class Element {
    constructor() { allocations++; this.children = []; this.attributes = new Map(); this.style = {}; this.dataset = {}; }
    setAttribute(key, value) { this.attributes.set(key, String(value)); }
    getAttribute(key) { return this.attributes.get(key) ?? null; }
    removeAttribute(key) { this.attributes.delete(key); }
    appendChild(child) { child.remove(); this.children.push(child); child.parentNode = this; }
    removeChild(child) { child.remove(); }
    remove() {
        if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
        this.parentNode = null;
    }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    addEventListener() {}
}
globalThis.window = { addEventListener() {} };
globalThis.document = { getElementById: () => null, createElementNS: () => new Element() };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
const { default: PCBApp } = await import('../src/ui/PCBApp.js');

const points = () => [
    { x: Math.PI, y: -Math.E }, { x: 15.123456789, y: -Math.E },
    { x: 15.123456789, y: 7.987654321 }, { x: Math.PI, y: 7.987654321 },
];
function shape(kind) {
    const object = {
        id: `shape-${kind}`, kind, layer: 'top-copper', net: 'GND', copperMode: 'add',
        lineWidth: 0.234567891, filled: true, plated: true, cornerRadius: 0.123456789,
        points: points(), nodeCornerRadii: { 1: 0.234567891 },
        segmentWidths: { 0: 0.345678912 }, segmentBulges: { 0: 0.123456789 },
    };
    if (kind === 'circle') {
        delete object.points;
        Object.assign(object, { x: Math.PI, y: -Math.E, radius: 3.123456789 });
    } else if (kind === 'arc') {
        delete object.points;
        Object.assign(object, { start: points()[0], end: points()[1], bulge: { x: 6.123456789, y: -7.123456789 } });
    } else if (kind === 'image') {
        const cosine = Math.cos(-0.123456789), sine = Math.sin(-0.123456789);
        object.points = points().map(({ x, y }) => ({ x: x * cosine - y * sine, y: x * sine + y * cosine }));
        object.artwork = {
            width: 4, height: 2, invert: false, flipHorizontal: false, flipVertical: false,
            rectangles: [{ x: 0, y: 0, width: 4, height: 2 }],
        };
    }
    return object;
}
function fill(kind) {
    return new CopperFill({
        id: `fill-${kind}`, kind, net: 'GND', layer: 'top-copper',
        outline: kind === 'circle' ? [] : points(),
        cornerRadius: kind === 'circle' ? 0 : 0.123456789,
        x: Math.PI, y: -Math.E, radius: 3.123456789,
        segmentBulges: kind === 'polygon' ? { 0: 0.123456789 } : {},
    });
}
function track() {
    const object = new Track({
        id: 'track', points: points().slice(0, 3), width: 0.234567891, net: 'GND',
        edgeBulges: { e0: 0.123456789 }, nodeCornerRadii: { n1: 0.345678912 },
        padConnections: { n0: { componentId: 'U1', pinNumber: '1' } },
    });
    for (const id of object.edges.keys()) object.setEdgeAttr(id, 'width', object.width);
    return object;
}
function fixture(kind, object) {
    const app = Object.create(PCBApp.prototype);
    app.project = new ProjectDocument();
    app.pcbDocument = app.project.pcbDocument;
    const model = app.pcbDocument;
    (kind === 'track' ? model.tracks : model.boardShapes).push(object);
    const cachedFill = kind === 'fill' ? object : fill('polygon');
    if (cachedFill !== object) model.boardShapes.push(cachedFill);
    setComputedFill(cachedFill, [{ outer: cachedFill.getOutline(), holes: [] }]);
    app.history = new CommandHistory();
    app.placements = new Map();
    app.netlist = [];
    app._shapeElements = new Map();
    app._boardShapeClearanceCache = new Map([[object.id, { elements: [], authored: object }]]);
    let work = 0;
    app._getLayerGroup = () => null;
    app._getRoutingParams = () => ({ viaDiameter: 0.6, viaDrill: 0.3 });
    app._pcbPropsItems = () => null;
    app._refreshFills = app._recomputeFillsNow = app._refreshFillProperties = () => { work++; };
    app._updateCopperCuts = app._updateRatsnest = app._refreshClearanceHalos = () => { work++; };
    app._refreshBoardShapeClearance = () => { work++; };
    app._board3d = { refresh() { work++; } };
    return { app, model, object, cachedFill, work: () => work,
        capabilities: app._pcbMultiPropertyCapabilities({ kind, object }) };
}
function freeze(object) {
    if (!object || typeof object !== 'object' || Object.isFrozen(object)) return;
    if (object instanceof Map) for (const value of object.values()) freeze(value);
    for (const value of Object.values(object)) freeze(value);
    Object.freeze(object);
}
const state = object => object.captureState ? object.captureState() : captureBoardShapeState(object);
function netPanel(app, entries) {
    const items = { innerHTML: '', querySelector: selector => selector === '#pcbPropMultiNet' ? {} : null };
    let commit;
    app._pcbPropsItems = () => items;
    app._setPcbPropsTitle = () => {};
    app._bindToolNetControl = (_items, _id, callback) => { commit = callback; };
    app._showPcbMultiSelectionProperties(entries);
    return value => commit(value);
}
function guard(f) {
    const geometry = f.model.captureGeometry(), saved = f.model.serialize(), authored = state(f.object);
    const references = Object.entries(f.object).filter(([, value]) => value && typeof value === 'object');
    const computed = getComputedFill(f.cachedFill), clearance = f.app._boardShapeClearanceCache.get(f.object.id);
    const undo = [...f.app.history.undoStack], redo = [...f.app.history.redoStack];
    const work = f.work(), svg = allocations;
    return () => {
        assert.deepEqual(f.model.captureGeometry(), geometry, 'Preparation preserves exact model geometry');
        assert.deepEqual(f.model.serialize(), saved, 'Preparation preserves serialization');
        assert.deepEqual(state(f.object), authored);
        for (const [key, value] of references) assert.equal(f.object[key], value, `${key} identity survives preparation`);
        assert.equal(getComputedFill(f.cachedFill), computed, 'Settled fill cache identity is unchanged');
        assert.equal(f.app._boardShapeClearanceCache.get(f.object.id), clearance);
        assert.deepEqual(f.app.history.undoStack, undo);
        assert.deepEqual(f.app.history.redoStack, redo);
        assert.equal(f.work(), work, 'Preparation performs no rendering or derived refresh');
        assert.equal(allocations, svg, 'Preparation allocates no SVG');
        assert.equal(f.app._pictureCopperRefreshPending, undefined);
    };
}

const cases = [];
for (const kind of ['line', 'rect', 'polygon', 'arc', 'circle', 'image']) {
    const values = { net: 'SIGNAL', layer: 'bottom-silk', ...(kind === 'image'
        ? { width: 18.123456789, height: 13.234567891, rotation: 37.123456789,
            invert: true, flipHorizontal: true, flipVertical: true }
        : { lineWidth: 0.456789123 }) };
    for (const [key, value] of Object.entries(values)) cases.push({ make: () => shape(kind), kind: 'shape', key, value });
}
for (const kind of ['rect', 'polygon', 'circle']) {
    const values = { net: 'SIGNAL', layer: 'bottom-copper', ...(kind === 'circle'
        ? { diameter: 9.123456789 }
        : { cornerRadius: 0.456789123, ...(kind === 'rect' ? { width: 18.123456789, height: 13.234567891 } : {}) }) };
    for (const [key, value] of Object.entries(values)) cases.push({ make: () => fill(kind), kind: 'fill', key, value });
    for (const other of ['rect', 'polygon', 'circle'].filter(value => value !== kind)) {
        cases.push({ make: () => fill(kind), kind: 'fill', key: 'shapeKind', value: other });
    }
}
cases.push({ make: track, kind: 'track', key: 'lineWidth', value: 0.456789123 });

let count = 0;
for (const test of cases) {
    const f = fixture(test.kind, test.make()), unchanged = guard(f), capability = f.capabilities[test.key];
    freeze(f.object);
    assert.equal(capability.command(capability.get()), null, `${f.object.id}/${test.key}: unchanged values have no command`);
    const command = capability.command(test.value);
    assert.ok(command, `${f.object.id}/${test.key}: changed values have a command`);
    assert.equal(command.shape || command.fill || command.track, f.object, 'Commands target canonical objects, not candidates');
    unchanged();
    if (f.object.artwork) {
        assert.equal(command.before.artwork, f.object.artwork);
        assert.equal(command.after.artwork.rectangles, f.object.artwork.rectangles, 'Artwork geometry is shared read-only');
        if (['invert', 'flipHorizontal', 'flipVertical'].includes(test.key)) {
            assert.notEqual(command.after.artwork, f.object.artwork);
        } else assert.equal(command.after.artwork, f.object.artwork);
    }
    count++;
}
for (const test of cases) {
    const f = fixture(test.kind, test.make()), before = f.model.captureGeometry();
    const command = f.capabilities[test.key].command(test.value);
    const expected = structuredClone(command.after);
    try {
        f.app.history.execute(command);
        assert.deepEqual(state(f.object), expected, `${f.object.id}/${test.key}: exact prepared state is accepted`);
        const accepted = f.model.captureGeometry();
        assert.equal(f.app.history.undoStack.length, 1);
        f.app.history.undo();
        assert.deepEqual(f.model.captureGeometry(), before, `${f.object.id}/${test.key}: exact undo`);
        f.app.history.redo();
        assert.deepEqual(f.model.captureGeometry(), accepted, `${f.object.id}/${test.key}: exact redo`);
    } finally {
        cancelPictureCopperRefresh(f.app);
    }
    count++;
}

{
    const f = fixture('shape', shape('image')), unchanged = guard(f);
    const badNet = { toString() { throw new Error('snapshot rejected'); } };
    assert.throws(() => f.capabilities.net.command(badNet), /snapshot rejected/);
    unchanged();
}
{
    const f = fixture('fill', fill('rect')), unchanged = guard(f);
    const capture = CopperFill.prototype.captureState;
    CopperFill.prototype.captureState = function () {
        if (this !== f.object && this.net === 'SIGNAL') throw new Error('candidate snapshot rejected');
        return capture.call(this);
    };
    try {
        assert.throws(() => f.capabilities.net.command('SIGNAL'), /candidate snapshot rejected/);
    } finally {
        CopperFill.prototype.captureState = capture;
    }
    unchanged();
}
{
    const f = fixture('shape', shape('image')), unchanged = guard(f);
    for (let i = 0; i < 1000; i++) {
        assert.equal(f.capabilities.width.command(f.capabilities.width.get()), null);
        assert.equal(f.capabilities.rotation.command(f.capabilities.rotation.get()), null);
    }
    unchanged();
}
{
    const f = fixture('shape', shape('rect'));
    const image = shape('image'), region = fill('circle');
    f.model.boardShapes.push(image, region);
    const before = f.model.captureGeometry();
    const entries = [
        { kind: 'shape', object: f.object }, { kind: 'shape', object: image }, { kind: 'fill', object: region },
    ];
    const commit = netPanel(f.app, entries);
    f.app.history.execute({ execute() {}, undo() {} });
    f.app.history.undo();
    const unchanged = guard(f);
    commit('GND');
    unchanged();
    try {
        commit('MIXED');
        assert.deepEqual(entries.map(entry => entry.object.net), ['MIXED', 'MIXED', 'MIXED']);
        const accepted = f.model.captureGeometry();
        assert.equal(f.app.history.undoStack.length, 1, 'Mixed edits remain one atomic history entry');
        assert.equal(f.app.history.redoStack.length, 0);
        f.app.history.undo();
        assert.deepEqual(f.model.captureGeometry(), before);
        f.app.history.redo();
        assert.deepEqual(f.model.captureGeometry(), accepted);
    } finally {
        cancelPictureCopperRefresh(f.app);
    }
}
{
    const f = fixture('shape', shape('rect'));
    const region = fill('rect');
    f.model.boardShapes.push(region);
    const commit = netPanel(f.app, [
        { kind: 'shape', object: f.object }, { kind: 'fill', object: region },
    ]);
    const unchanged = guard(f);
    const capture = CopperFill.prototype.captureState;
    CopperFill.prototype.captureState = function () {
        if (this !== region && this.net === 'SIGNAL') throw new Error('second candidate rejected');
        return capture.call(this);
    };
    try {
        assert.throws(() => commit('SIGNAL'), /second candidate rejected/);
    } finally {
        CopperFill.prototype.captureState = capture;
    }
    unchanged();
}

console.log(`PASS: ${count} frozen/preparation/history cases plus throwing, mixed-batch and 1000-update no-op isolation checks`);
