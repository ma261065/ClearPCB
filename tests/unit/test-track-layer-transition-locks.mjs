import assert from 'node:assert/strict';
import { installFakeDom, fakeElement } from './helpers/fake-dom.mjs';
import { pcbEditorStubs } from './helpers/pcb-editor-stubs.mjs';
import { PCB_LAYERS } from '../../src/pcb/modules/layers.js';
import { setPcbInteraction } from '../../src/pcb/modules/pcb-interactions.js';
import {
    getTrackDraw, handleTrackDrawKey, toggleTrackLayer, refreshTrackDrawPreview, cancelTrackDraw,
} from '../../src/pcb/modules/track-draw.js';
import { CommandHistory } from '../../src/core/CommandHistory.js';

const document = installFakeDom();
Object.assign(window, { innerWidth: 1400, innerHeight: 900 });
const saved = PCB_LAYERS.map(layer => ({ layer, locked: layer.locked, visible: layer.visible }));
const layer = id => PCB_LAYERS.find(layer => layer.id === id);
try {
    for (const source of ['bottom-copper', 'top-copper']) {
        const destination = source === 'bottom-copper' ? 'top-copper' : 'bottom-copper';
        for (const blockers of [
            [{ id: destination, reason: 'locked' }],
            [{ id: 'vias', reason: 'locked' }],
            [{ id: 'vias', reason: 'locked' }, { id: destination, reason: 'locked' }],
            [{ id: destination, reason: 'hidden' }],
            [{ id: 'vias', reason: 'hidden' }],
        ]) {
            for (const entry of PCB_LAYERS) { entry.locked = false; entry.visible = true; }
            for (const block of blockers) {
                if (block.reason === 'locked') layer(block.id).locked = true;
                else layer(block.id).visible = false;
            }
            const groups = new Map(['top-copper', 'bottom-copper', 'vias', 'hole'].map(id => [id, fakeElement('g')]));
            const svg = fakeElement('svg');
            svg.getBoundingClientRect = () => ({ left: 100, top: 150 });
            const messages = [];
            const app = { ...pcbEditorStubs(), tracks: [], vias: [], pads: [], boardShapes: [], copperFills: [],
                placements: new Map(), netlist: [], currentTool: 'track',
                getLayerGroup: id => groups.get(id),
                viewport: { scale: 20, svg, currentMouseWorld: { x: 11.1, y: -4.1 },
                    worldToScreen: point => ({ x: point.x * 20, y: point.y * 20 + 200 }),
                    hideCrosshair() {} },
                history: new CommandHistory(), setStatus: message => messages.push(message) };
            app.pcbDocument = { tracks: app.tracks, vias: app.vias, pads: app.pads,
                boardShapes: app.boardShapes, copperFills: app.copperFills };
            app.history.execute({ execute() {}, undo() {} });
            app.history.undo();
            const draw = { points: [{ x: 1, y: -2 }, { x: 6, y: -3 }], edgeLayers: [source],
                currentLayer: source, width: 0.2, net: 'N', axisLock: null, previewElements: [],
                snap: { x: 11, y: -4 }, startPad: null, endPad: null };
            setPcbInteraction(app, '_trackDraw', draw);
            refreshTrackDrawPreview(app);
            const before = structuredClone({ points: draw.points, layers: draw.edgeLayers, snap: draw.snap });
            const preview = [...draw.previewCache];
            const redo = [...app.history.redoStack];
            const expected = blockers.map(block => layer(block.id).name).join(', ')
                + ` ${blockers.length === 1 ? 'layer' : 'layers'} ${blockers[0].reason}`;
            for (const action of [
                () => handleTrackDrawKey(app, { key: ' ', code: 'Space' }),
                () => toggleTrackLayer(app),
            ]) {
                action();
                assert.equal(getTrackDraw(app), draw);
                assert.deepEqual({ points: draw.points, layers: draw.edgeLayers, snap: draw.snap }, before,
                    'Refusal must not insert a waypoint or change snap/edge layers');
                assert.equal(draw.currentLayer, source);
                assert.deepEqual([...draw.previewCache], preview, 'Refusal leaves preview elements unchanged');
                assert.deepEqual(app.tracks, []);
                assert.deepEqual(app.vias, []);
                assert.equal(app.history.undoStack.length, 0);
                assert.deepEqual(app.history.redoStack, redo);
                assert.equal(messages.at(-1), expected);
                const bubble = document.getElementById('pcbLockedLayerBubble');
                assert.equal(bubble.querySelector('.pcb-locked-bubble-text').textContent, expected);
                assert.equal(bubble.querySelector('button'), null, 'The popup has no unlock action');
                assert.equal(bubble.style.top, '268px', 'Popup uses the raw cursor position, not a snapped waypoint');
            }
            cancelTrackDraw(app);
        }
    }
} finally {
    for (const { layer, locked, visible } of saved) Object.assign(layer, { locked, visible });
}
console.log('PASS atomic Space/direct track transition refusal for via/destination locks and visibility on both copper sides');
