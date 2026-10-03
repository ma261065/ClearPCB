import assert from 'node:assert/strict';
import { PcbDocument } from '../src/core/PcbDocument.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { Track } from '../src/shapes/track.js';
import { CopperFill } from '../src/shapes/copper-fill.js';
import { captureBoardShapeState } from '../src/core/pcb-board-shapes.js';
import { setPropertyEditor } from '../src/pcb/modules/property-editors.js';
import { setBoardShapeNodeFocus, setBoardShapeSegmentFocus } from '../src/pcb/modules/board-shape-state.js';

globalThis.window = { addEventListener() {} };
globalThis.document = {
    getElementById() { return null; },
    querySelector() { return null; },
    createElementNS() {
        const attributes = new Map();
        return {
            setAttribute(name, value) { attributes.set(name, String(value)); },
            getAttribute(name) { return attributes.get(name) ?? null; },
            removeAttribute(name) { attributes.delete(name); },
            appendChild() {},
        };
    },
};

const { deleteBoxSelection } = await import('../src/pcb/modules/box-select.js');
const { setPcbSelection, getPcbSelection } = await import('../src/pcb/modules/selection-registry.js');
const { runPcbDeleteAction } = await import('../src/pcb/modules/editor-actions.js');
const { default: PCBApp } = await import('../src/ui/PCBApp.js');

const kinds = ['line', 'rect', 'polygon', 'circle', 'arc'];
const dispatches = [
    deleteBoxSelection, runPcbDeleteAction,
    app => PCBApp.prototype.handleKeyDown.call(app, { key: 'Delete' }),
    app => PCBApp.prototype.handleKeyDown.call(app, { key: 'Backspace' }),
];
for (const dispatch of dispatches) {
for (const layer of ['hole', 'top-copper', 'top-silk']) {
    for (const selectionKinds of [...kinds.map((kind) => [kind]), kinds]) {
        const shapes = selectionKinds.map((kind, index) => ({
            id: `shape-${index}`, kind, layer, lineWidth: 1,
            points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
            x: 5, y: 5, radius: 5,
            start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, bulge: { x: 5, y: 5 },
        }));
        let properties = 'Shape Properties';
        let clearCount = 0;
        let activeTab = 'pcb-properties';
        let tabChanges = 0;
        const pcbDocument = new PcbDocument();
        pcbDocument.boardShapes.push(...shapes);
        const app = {
            _active: true,
            pcbDocument, boardShapes: pcbDocument.boardShapes, placements: new Map(), tracks: [], vias: [], texts: new Map(),
            _shapeElements: new Map(), getLayerGroup() { return null; },
            history: new CommandHistory(),
            clearProperties() {
                assert.equal(this.boardShapes.length, 0);
                assert.deepEqual(getPcbSelection(this), []);
                properties = 'Properties';
                clearCount++;
            },
            setActiveRibbonTab(tab) {
                assert.equal(properties, 'Properties');
                activeTab = tab;
                tabChanges++;
            },
        };
        setPcbSelection(app, shapes.map((object) => ({ kind: 'shape', object })));
        assert.equal(dispatch(app), true);
        assert.equal(properties, 'Properties');
        assert.equal(clearCount, 1);
        assert.equal(activeTab, 'pcb-home');
        assert.equal(tabChanges, 1);
        activeTab = 'pcb-design';
        assert.equal(dispatch(app), false);
        assert.equal(clearCount, 1);
        assert.equal(activeTab, 'pcb-design');
        assert.equal(tabChanges, 1);
        assert.equal(app.history.undoStack.length, 1, 'The entire selection is one undoable action');
        app.history.undo();
        const byId = items => [...items].sort((a, b) => a.id.localeCompare(b.id));
        assert.deepEqual(byId(app.boardShapes), byId(shapes), 'Undo restores every original shape and its geometry');
        app.history.redo();
        assert.deepEqual(app.boardShapes, []);
    }
}
}

console.log('PASS: keyboard/direct board-shape deletion, mixed selections, Properties/Home cleanup, exact undo/redo and empty selection');

function fixture() {
    const model = new PcbDocument();
    const events = [];
    const app = {
        _active: true, _shapeIdCounter: 1, pcbDocument: model, placements: model.placements,
        tracks: model.tracks, vias: model.vias, pads: model.pads, texts: model.texts, boardShapes: model.boardShapes,
        history: new CommandHistory(), _shapeElements: new Map(), getLayerGroup() { return null; },
        clearProperties() { events.push('properties'); }, setActiveRibbonTab(tab) { events.push(tab); },
        _cancelPasteDrop() { this._pasteDrop = null; events.push('paste'); },
    };
    const shape = { id: 'rect', kind: 'rect', layer: 'top-silk', lineWidth: 0.234567,
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }] };
    model.boardShapes.push(shape);
    setPcbSelection(app, [{ kind: 'shape', object: shape }]);
    return { app, shape, model, events };
}

for (const dispatch of dispatches.slice(1)) {
    for (const guard of ['_active', '_trackDraw', '_fillDraw', '_shapeDraw', '_pasteDrop']) {
        const { app, shape, events } = fixture();
        app[guard] = guard === '_active' ? false : {};
        setPropertyEditor(app, 'boardShape', { cancel() { assert.fail('Guarded deletion must not cancel Properties'); } });
        assert.equal(dispatch(app), guard === '_pasteDrop');
        assert.deepEqual(app.boardShapes, [shape]);
        assert.deepEqual(getPcbSelection(app, 'shape'), [shape]);
        assert.equal(app.history.undoStack.length, 0);
        assert.deepEqual(events, guard === '_pasteDrop' ? ['paste'] : []);
    }
    {
        const { app, shape, events } = fixture();
        setPropertyEditor(app, 'boardShape', { cancel() { events.push('shape-preview'); } });
        setPropertyEditor(app, 'track', { cancel() { events.push('track-preview'); } });
        const execute = app.history.execute.bind(app.history);
        app.history.execute = command => { events.push('execute'); execute(command); };
        assert.equal(dispatch(app), true);
        assert.deepEqual(events, ['shape-preview', 'track-preview', 'execute', 'properties', 'pcb-home']);
        app.history.undo();
        assert.deepEqual(app.boardShapes, [shape]);
    }
    {
        const { app, shape } = fixture();
        setPropertyEditor(app, 'boardShape', { cancel() { throw new Error('Rejected property cancellation'); } });
        assert.throws(() => dispatch(app), /Rejected property cancellation/);
        assert.deepEqual(app.boardShapes, [shape], 'Cleanup failure must not proceed to deletion');
        assert.equal(app.history.undoStack.length, 0);
    }
    for (const focus of ['node', 'segment']) {
        const { app, shape, events } = fixture();
        const before = captureBoardShapeState(shape);
        if (focus === 'node') setBoardShapeNodeFocus(app, { shapeId: shape.id, index: 1 });
        else setBoardShapeSegmentFocus(app, { shapeId: shape.id, segment: 1 });
        assert.equal(dispatch(app), true);
        assert.equal(app.boardShapes.length, 1, 'Refinement deletes geometry, not the entire shape');
        assert.equal(app.boardShapes[0].points.length, focus === 'node' ? 3 : 4);
        assert.equal(app.boardShapes[0].kind, focus === 'node' ? 'polygon' : 'line');
        assert.equal(events.includes('pcb-home'), false, 'Refined edits retain the Properties context');
        assert.equal(app.history.undoStack.length, 1);
        app.history.undo();
        assert.deepEqual(captureBoardShapeState(shape), before);
    }
    {
        const { app, shape } = fixture();
        shape.layer = 'board-outline';
        assert.equal(dispatch(app), false, 'An unrefined board outline cannot be removed');
        assert.deepEqual(app.boardShapes, [shape]);
        assert.equal(app.history.undoStack.length, 0);
    }
    for (const size of [3, 4]) {
        const { app, model, shape } = fixture();
        const fill = new CopperFill({ outline: shape.points.slice(0, size) });
        model.boardShapes.splice(0, 1, fill);
        setPcbSelection(app, [{ kind: 'fill', object: fill }]);
        app._fillEdit = { fillId: fill.id, node: 1 };
        const before = fill.captureState();
        assert.equal(dispatch(app), true, 'Even a blocked refined deletion is consumed');
        assert.equal(fill.outline.length, 3);
        assert.deepEqual(model.boardShapes, [fill], 'Fill refinement never falls through to whole-fill deletion');
        assert.equal(app.history.undoStack.length, size === 4 ? 1 : 0);
        if (size === 4) app.history.undo();
        assert.deepEqual(fill.captureState(), before);
    }
    for (const mixed of [false, true]) {
        const { app, model, shape } = fixture();
        const track = new Track({ points: [{ x: 1.234567, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }] });
        model.tracks.push(track);
        app._trackEdit = { track, edgeId: [...track.edges.keys()][0] };
        setPcbSelection(app, [{ kind: 'track', object: track }, ...(mixed ? [{ kind: 'shape', object: shape }] : [])]);
        const before = track.captureState();
        assert.equal(dispatch(app), true);
        assert.equal(model.tracks.reduce((sum, item) => sum + item.edges.size, 0), mixed ? 0 : 1,
            'Track refinement applies only to a single selected track');
        assert.equal(model.boardShapes.length, mixed ? 0 : 1);
        assert.equal(app.history.undoStack.length, 1);
        app.history.undo();
        assert.deepEqual(model.tracks, [track]);
        assert.deepEqual(track.captureState(), before);
    }
}
for (const key of ['Delete', 'Backspace']) {
    for (const target of [{ tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { tagName: 'SELECT' }, { isContentEditable: true }]) {
        const { app, shape } = fixture();
        assert.equal(PCBApp.prototype.handleKeyDown.call(app, { key, target }), false);
        assert.deepEqual(app.boardShapes, [shape]);
        assert.equal(app.history.undoStack.length, 0);
    }
}
console.log('PASS: deletion guards, native field ownership, cancellation priority/failure, shape/fill/track refinement and outline protection');