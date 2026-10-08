import assert from 'node:assert/strict';
import { installFakeDom } from './helpers/fake-dom.mjs';

installFakeDom();
const { PCB_LAYERS } = await import('../../src/pcb/modules/layers.js');
const { pcbEditorFixture } = await import('./pcb-editor-fixture.mjs');
const {
    PCB_TOOLS, PCB_TOOL_PRESETS, PCB_PLACEMENT_TOOLS, PCB_SHAPE_TOOLS, PCB_RIBBON_PLACEMENT_TOOLS,
    normalizePcbTool, pcbToolLayer, pcbToolTargets, pressPcbTool,
} = await import('../../src/pcb/modules/pcb-tools.js');

// pcb-tools.js holds one entry per PCB tool, and pressPcbTool hands a canvas press to the
// active tool, refusing to start a placement on a locked or hidden layer.

// The table: every entry names itself, has a press and a ribbon button; placement tools
// (those with target layers) own a Properties panel.
const ids = Object.keys(PCB_TOOLS);
for (const [id, tool] of Object.entries(PCB_TOOLS)) {
    assert.equal(tool.id, id, `${id} names itself`);
    assert.equal(typeof tool.press, 'function', `${id} handles a press`);
    assert.ok(tool.button?.title && tool.button?.content, `${id} has a ribbon button`);
    assert.ok(PCB_SHAPE_TOOLS.has(id) ? tool.button.icon : tool.button.id, `${id}'s button has an id, or a shape icon`);
    if (tool.targets) assert.equal(typeof tool.showProperties, 'function', `${id} owns a Properties panel`);
    assert.ok(Object.isFrozen(tool), `${id} is read-only`);
}
const buttonIds = [...Object.values(PCB_TOOLS), ...Object.values(PCB_TOOL_PRESETS)].map(entry => entry.button.id).filter(Boolean);
assert.equal(new Set(buttonIds).size, buttonIds.length, 'ribbon button ids are unique');
assert.deepEqual([...PCB_PLACEMENT_TOOLS].sort(), ids.filter(id => id !== 'select').sort(), 'every tool but Select places objects');
assert.ok([...PCB_SHAPE_TOOLS].every(id => PCB_PLACEMENT_TOOLS.has(id)));
assert.deepEqual(PCB_RIBBON_PLACEMENT_TOOLS, [...PCB_PLACEMENT_TOOLS, 'hole'], 'presets carry ribbon badges too');
for (const preset of Object.values(PCB_TOOL_PRESETS)) assert.ok(PCB_TOOLS[preset.tool], 'a preset picks a real tool');
for (const id of ids) assert.equal(normalizePcbTool(id), id);
for (const other of ['hole', 'measure', undefined, 'toString']) assert.equal(normalizePcbTool(other), 'select', `${other} is not a tool`);

// The dispatcher, on a table of recording tools.
const app = pcbEditorFixture({ activeLayer: 'top-silk', screenToWorld: () => ({ x: 7, y: 8 }) });
const presses = [];
let drawing = false;
const tools = {
    select: { id: 'select', press: (...args) => presses.push(['select', ...args]) },
    place: { id: 'place', targets: () => [{ id: 'top-silk' }], drawing: () => drawing, press: (...args) => presses.push(['place', ...args]) },
};
const event = { clientX: 1, clientY: 2 };
const saved = PCB_LAYERS.map(layer => ({ layer, locked: layer.locked, visible: layer.visible }));
try {
    app.currentTool = 'select';
    assert.equal(pressPcbTool(app, event, { x: 1, y: 1 }, 'hit', tools), true);
    assert.deepEqual(presses.pop(), ['select', app, event, { x: 1, y: 1 }, 'hit'], 'the press goes to the active tool');

    app.currentTool = 'place';
    assert.equal(pressPcbTool(app, event, null, null, tools), true);
    assert.deepEqual(presses.pop(), ['place', app, event, { x: 7, y: 8 }, null], 'an unresolved position comes from the event');

    PCB_LAYERS.find(layer => layer.id === 'top-silk').locked = true;
    assert.equal(pressPcbTool(app, event, null, null, tools), true, 'a refused press is still taken');
    assert.equal(presses.length, 0, 'starting to place on a locked layer is refused');
    drawing = true;
    pressPcbTool(app, event, null, null, tools);
    assert.equal(presses.pop()?.[0], 'place', 'a press that continues a draw is not checked again');
    drawing = false;
    PCB_LAYERS.find(layer => layer.id === 'top-silk').locked = false;
    PCB_LAYERS.find(layer => layer.id === 'top-silk').visible = false;
    pressPcbTool(app, event, null, null, tools);
    assert.equal(presses.length, 0, 'starting to place on a hidden layer is refused');

    app.currentTool = 'measure';
    assert.equal(pressPcbTool(app, event, null, null, tools), false, 'an unknown tool takes no press');
    app.currentTool = 'hasOwnProperty';
    assert.equal(pressPcbTool(app, event, null, null, tools), false, 'nor does an inherited name');
    assert.equal(presses.length, 0);
} finally {
    for (const { layer, locked, visible } of saved) Object.assign(layer, { locked, visible });
}

// The real tools: their targets and status-bar layer follow their own settings.
assert.deepEqual(pcbToolTargets(app, 'via'), [{ id: 'vias' }]);
assert.deepEqual(pcbToolTargets(app, 'hole'), [{ id: 'hole' }], 'a preset has targets');
assert.deepEqual(pcbToolTargets(app, 'select'), []);
assert.equal(pcbToolLayer(app, 'text'), pcbToolTargets(app, 'text')[0].id, 'the status bar names the layer the tool places on');
assert.equal(pcbToolLayer(app, 'via'), 'top-silk', 'a tool without its own layer shows the active layer');

console.log('PASS PCB tools: one entry per tool, and presses refused only when starting on a blocked layer');
