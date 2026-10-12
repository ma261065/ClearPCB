import assert from 'node:assert/strict';
import { duplicateIdRepairMessage, repairDuplicateIds } from '../../src/core/project-format.js';
import { installFakeDom } from './helpers/fake-dom.mjs';

globalThis.window = { addEventListener() {} };
globalThis.localStorage = { getItem() { return null; } };
installFakeDom();
const { loadOpenedProject } = await import('../../src/schematic/modules/files.js');

assert.equal(duplicateIdRepairMessage({ tracks: 0, shapes: 0 }), null);
assert.match(duplicateIdRepairMessage({ tracks: 1, shapes: 0 }), /new IDs to 1 track with duplicate IDs/);
assert.match(duplicateIdRepairMessage({ tracks: 2, shapes: 1 }), /new IDs to 2 tracks and 1 board shape with/);
assert.match(duplicateIdRepairMessage({ tracks: 0, shapes: 3 }), /new IDs to 3 board shapes with/);

const shape = (id, x) => ({ id, kind: 'line', layer: 'top-silk', lineWidth: 0.2, filled: false,
    copperMode: 'add', plated: false, net: '', points: [{ x, y: 0 }, { x: x + 5, y: 0 }] });
const track = (id, x) => ({ type: 'track', id, nd: { n0: [x, 0], n1: [x + 5, 0] }, ed: { e0: ['n0', 'n1'] } });
const project = (pcb) => ({ type: 'clearpcb-project', version: '1.0', schematic: { shapes: [], components: [] },
    pcb: { stackup: { copperLayers: ['top-copper', 'bottom-copper'] }, ...pcb } });

function fixture(data) {
    const events = [];
    const app = {
        project: {
            async load(loaded) { events.push(['load', loaded]); },
            notifyDocumentReplaced() { events.push(['replaced']); },
        },
        fileManager: {
            dirty: null,
            async adoptOpen() { this.dirty = false; events.push(['adopt']); },
            setDirty(value) { this.dirty = value; events.push(['dirty', value]); },
            clearAutoSave() {},
        },
        ui: {},
        fitToContent() {},
        async alert(message, options) { events.push(['alert', message, options.title]); },
    };
    return { app, events, run: () => loadOpenedProject(app, { success: true, data, fileName: 'board.cpcb' }) };
}

{
    const data = project({ tracks: [track('shape_5', 0), track('shape_5', 10)],
        boardShapes: [shape('pshape_92', 0), shape('pshape_92', 10)] });
    const { app, events, run } = fixture(data);
    await run();
    const loaded = events.find(([kind]) => kind === 'load')[1];
    assert.equal(new Set(loaded.pcb.tracks.map(item => item.id)).size, 2, 'duplicate track ids are repaired before loading');
    assert.equal(new Set(loaded.pcb.boardShapes.map(item => item.id)).size, 2, 'duplicate board-shape ids are repaired before loading');
    assert.equal(app.fileManager.dirty, true, 'a repaired file opens unsaved so the fix can be kept');
    const alert = events.find(([kind]) => kind === 'alert');
    assert.match(alert[1], /^Opened board\.cpcb\. Assigned new IDs to 1 track and 1 board shape/);
    assert.equal(alert[2], 'File Repaired');
    assert.ok(events.findIndex(([kind]) => kind === 'adopt') < events.findIndex(([kind]) => kind === 'dirty'));
}

{
    const data = project({ boardShapes: [shape('pshape_1', 0), shape('pshape_2', 10)] });
    const { app, events, run } = fixture(data);
    await run();
    assert.equal(app.fileManager.dirty, false, 'a clean file opens saved');
    assert.ok(!events.some(([kind]) => kind === 'alert'), 'a clean file opens silently');
    assert.deepEqual(events.find(([kind]) => kind === 'load')[1].pcb.boardShapes.map(item => item.id), ['pshape_1', 'pshape_2']);
}

assert.deepEqual(repairDuplicateIds(project({})).tracks, 0);
console.log('PASS opened projects repair duplicate track and board-shape ids, mark the document unsaved and explain why');
