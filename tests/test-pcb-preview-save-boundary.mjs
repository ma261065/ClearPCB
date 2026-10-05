import { setDragOverlaysDeferred, setFillRefreshSuspended } from '../src/pcb/modules/refresh-state.js';
import assert from 'node:assert/strict';
import { ProjectDocument } from '../src/core/ProjectDocument.js';
import { Component } from '../src/components/Component.js';
import { Track } from '../src/shapes/track.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { updatePlacementPadPositions } from '../src/core/pcb-placement-geometry.js';
import { createComponentSelectionAdapter } from '../src/pcb/modules/component-selection.js';
import { setPcbInteraction } from '../src/pcb/modules/pcb-interactions.js';
import { prepareFabricationSnapshot } from '../src/pcb/modules/fabrication-snapshot.js';
import { saveFile, saveFileAs } from '../src/schematic/modules/files.js';

globalThis.window = { addEventListener() {} };
const { default: PCBApp } = await import('../src/ui/PCBApp.js');
const originals = Object.fromEntries(['setInterval', 'clearInterval', 'requestIdleCallback',
    'cancelIdleCallback', 'localStorage'].map(key => [key, globalThis[key]]));
const timers = new Map(), idle = new Map(), stored = new Map();
let nextId = 0;
globalThis.setInterval = callback => { timers.set(++nextId, callback); return nextId; };
globalThis.clearInterval = id => timers.delete(id);
globalThis.requestIdleCallback = callback => { idle.set(++nextId, callback); return nextId; };
globalThis.cancelIdleCallback = id => idle.delete(id);
globalThis.localStorage = {
    getItem: key => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, value),
    removeItem: key => stored.delete(key),
};
function flushIdle() {
    for (const [id, callback] of [...idle]) { idle.delete(id); callback(); }
}
function fixture() {
    stored.clear();
    const project = new ProjectDocument();
    project.schematicDocument.components.push(new Component({
        name: 'PreviewSave', _source: 'KiCad', symbol: { pins: [{ number: '1' }] },
        footprintShapes: ['PAD~RECT~2~0~1~1~1~both~1~0~0.5', 'PAD~RECT~-2~0~1~1~1~both~1~0~0.5'],
    }, { id: 'part' }));
    const placement = { x: 10, y: 10, rotation: 0, side: 'top',
        padOffsets: project.getPcbFootprint('part').padOffsets, pads: new Map() };
    updatePlacementPadPositions(placement);
    const track = new Track({ points: [{ x: 12, y: 10 }, { x: 30, y: 10 }],
        padConnections: { n0: { componentId: 'part', pinNumber: '1' } } });
    project.pcbDocument.tracks.push(track);
    const app = {
        project, pcbDocument: project.pcbDocument,
        get tracks() { return Object.getOwnPropertyDescriptor(PCBApp.prototype, 'tracks').get.call(this); },
        placements: new Map([['part', placement]]), history: new CommandHistory(),
        isSectionEditing: PCBApp.prototype.isSectionEditing,
        getLayerGroup: () => null, _markDirty: () => project.fileManager.touch(),
    };
    project.registerView('pcb', app);
    const adapter = createComponentSelectionAdapter(app, 'part', 'component:part');
    project.fileManager.setDirty(true);
    project.startAutoSave();
    const tick = () => timers.get(project.fileManager.autoSaveTimer)();
    const key = project.fileManager.autoSavePrefix + encodeURIComponent(project.fileManager.fileName);
    const begin = () => {
        adapter.beginAnchorDrag('rotate', { x: 20, y: 10 });
        adapter.updateAnchorDrag({ x: 10, y: 20 });
        assert.equal(placement.rotation, 90);
        assert.equal(app.tracks[0].nodes.get('n0').y, 12);
        assert.equal(track.nodes.get('n0').y, 10, 'The authored endpoint is isolated from the rotation preview');
    };
    return { project, app, adapter, track, tick, key, begin };
}
try {
    for (const queuedBefore of [false, true]) for (const commit of [false, true]) {
        const f = fixture();
        const original = f.project.serialize().pcb;
        const originalTrack = f.track.captureState();
        if (queuedBefore) f.tick();
        f.begin();
        if (!queuedBefore) f.tick();
        flushIdle();
        assert.equal(stored.has(f.key), false, 'Autosave must not capture rotated track nodes with the original placement');
        assert.equal(f.project.fileManager._lastAutoSave, null, 'Deferred autosave does not consume its dirty revision');
        assert.throws(() => f.project.serialize(), /Finish the current edit before saving/);
        await assert.rejects(prepareFabricationSnapshot(f.app), /Finish the current edit before exporting/);
        f.adapter.endAnchorDrag(commit);
        f.tick();
        flushIdle();
        assert.ok(stored.has(f.key), 'Autosave resumes after commit or cancellation');
        const saved = JSON.parse(stored.get(f.key)).data;
        assert.deepEqual(saved.pcb, JSON.parse(JSON.stringify(f.project.serialize().pcb)));
        if (!commit) {
            assert.deepEqual(f.project.serialize().pcb, original);
            assert.deepEqual(f.track.captureState(), originalTrack);
        } else {
            assert.equal(f.project.pcbDocument.placementState.overrides.get('part').rotation, 90);
            assert.equal(f.track.nodes.get('n0').y, 12);
        }
        f.project.fileManager.stopAutoSave();
    }
    {
        const requestIdle = globalThis.requestIdleCallback;
        delete globalThis.requestIdleCallback;
        const f = fixture();
        f.begin();
        f.tick();
        assert.equal(stored.has(f.key), false, 'Timer-only browsers also defer active previews');
        f.adapter.endAnchorDrag(false);
        f.tick();
        assert.ok(stored.has(f.key), 'Timer-only autosave resumes without needing another edit');
        f.project.fileManager.stopAutoSave();
        globalThis.requestIdleCallback = requestIdle;
    }
    {
        const f = fixture();
        let writes = 0, successes = 0;
        const alerts = [];
        const host = {
            project: f.project, _serializeDocument: () => f.project.serialize(),
            fileManager: {
                async save() { writes++; return { success: true, clean: false }; },
                async saveAs() { writes++; return { success: true, clean: false }; },
            },
            alert: (message, options) => alerts.push({ message, options }),
            _updateTitle() {}, _showSaveToast: () => successes++,
        };
        f.begin();
        for (const save of [saveFile, saveFileAs]) {
            const result = await save(host);
            assert.equal(result.success, false);
            assert.match(result.error, /Finish the current edit/);
        }
        assert.equal(writes, 0, 'Manual save must reject the preview before opening or writing a file');
        assert.equal(successes, 0);
        assert.equal(alerts.length, 2);
        assert.ok(alerts.every(alert => alert.options.title === 'Save Failed'));
        f.adapter.endAnchorDrag(false);
        assert.equal((await saveFile(host)).success, true);
        assert.equal(writes, 1);
        f.project.fileManager.stopAutoSave();
    }
    for (const flag of ['_drag', '_refDrag', '_textDrag', '_groupDrag', '_shapeDrag', '_vertexDrag',
        '_viaDrag', '_pasteDrop', '_textEdit', '_boardOutlineResize', '_pcbSelectionInteraction',
        '_rotationHandleDrag', '_deferDragOverlays', '_suspendFillRefresh']) {
        const f = fixture();
        const suspensionSetters = { _deferDragOverlays: setDragOverlaysDeferred, _suspendFillRefresh: setFillRefreshSuspended };
        const setFlag = value => {
            if (suspensionSetters[flag]) suspensionSetters[flag](f.app, value);
            else setPcbInteraction(f.app, flag, value);
        };
        setFlag({});
        f.tick();
        flushIdle();
        assert.equal(stored.has(f.key), false, `${flag}: active PCB preview defers autosave`);
        setFlag(null);
        f.tick();
        flushIdle();
        assert.ok(stored.has(f.key), `${flag}: cleared preview allows the pending revision to save`);
        f.project.fileManager.stopAutoSave();
    }
    assert.doesNotThrow(() => new ProjectDocument().serialize(), 'Headless serialization needs no editor');
} finally {
    for (const [key, value] of Object.entries(originals)) {
        if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
}
console.log('PASS model-owned save guard, pointer-preview autosave deferral, idle races, manual failure and post-edit persistence');
