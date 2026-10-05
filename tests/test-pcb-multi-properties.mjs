import assert from 'node:assert/strict';
import { ProjectDocument } from '../src/core/ProjectDocument.js';
import { Component } from '../src/components/Component.js';

globalThis.window = { addEventListener() {} };
globalThis.requestAnimationFrame = callback => { callback(); return 1; };
globalThis.cancelAnimationFrame = () => {};
const items = { innerHTML: '', querySelector() { return null; } };
globalThis.document = {
    getElementById() { return null; },
};

const { default: PCBApp } = await import('../src/ui/PCBApp.js');
const { setPcbSelection } = await import('../src/pcb/modules/selection-registry.js');
const app = Object.create(PCBApp.prototype);
app.project = new ProjectDocument();
app.pcbDocument = app.project.pcbDocument;
app.tracks = [{ net: 'GND' }];
app.vias = [{ net: 'GND' }];
app.pads = [];
app.placements = new Map();
app.placementState = app.pcbDocument.placementState;
app._placementOverrides = app.placementState.overrides;
app.boardShapes = [];
app.netlist = [];
app.propertiesItems = () => items;
app.setPropertiesTitle = () => {};
app.setActiveRibbonTab = () => {};
app.syncClipboardButtons = () => {};
app.setPcbStatus = () => {};
app._recomputeFillsNow = () => {};
app._refreshFillProperties = () => {};

app._showPcbMultiSelectionProperties([
    { kind: 'track', object: { net: 'GND' } },
    { kind: 'via', object: { net: 'GND' } },
]);
assert.match(items.innerHTML, /pcbPropMultiNet/, 'Track and Via expose their shared Net property');
assert.match(items.innerHTML, /prop-net-control/, 'mixed Net uses the standard editable picker control');
assert.match(items.innerHTML, /prop-net-menu/, 'mixed Net exposes the standard styled menu');
assert.match(items.innerHTML, /button type="button" data-net="GND"/, 'the current Net is available in the picker');
assert.doesNotMatch(items.innerHTML, /datalist|list="pcbPropMultiNetList"/,
    'mixed Net does not use the browser-native datalist');
assert.doesNotMatch(items.innerHTML, /Diameter|Width|Drill/,
    'Track and Via do not expose properties that are not shared');

app._showPcbMultiSelectionProperties([
    { kind: 'track', object: { net: 'GND', width: 0.2 } },
    { kind: 'track', object: { net: 'VCC', width: 0.3 } },
]);
assert.match(items.innerHTML, /pcbPropMultiNet/, 'multiple Tracks expose Net');
assert.match(items.innerHTML, /pcbPropMultiTrackWidth/, 'multiple Tracks expose Width');
assert.match(items.innerHTML, /placeholder="Mixed"/, 'mixed values are represented without choosing one');

const makePad = (id, net, rotation) => ({
    id, net, shape: 'rectangle', size: 1, ratio: 2, drill: 0.4, rotation, layers: 'both',
    captureState() {
        return {
            id: this.id, net: this.net, shape: this.shape, size: this.size, ratio: this.ratio,
            drill: this.drill, rotation: this.rotation, layers: this.layers,
        };
    },
    applyState(state) { Object.assign(this, state); },
});
app.pads = [
    makePad('p1', 'GND', 0),
    makePad('p2', 'VCC', 15),
    makePad('p3', 'GND', 30),
    makePad('p4', '', 45),
];
app.getLayerGroup = () => null;
setPcbSelection(app, app.pads.map(object => ({ kind: 'pad', object })));
const controls = new Map();
for (const selector of ['#pcbPropPadShape', '#pcbPropPadLayers', '#pcbPropPadSize',
    '#pcbPropPadRatio', '#pcbPropPadDrill', '#pcbPropPadRotation',
    '#pcbPropIntersection_rotation', '#pcbPropMultiNet']) {
    controls.set(selector, {
        value: '',
        listeners: new Map(),
        addEventListener(type, callback) { this.listeners.set(type, callback); },
        emit(type) { this.listeners.get(type)?.({ target: this }); },
    });
}
items.querySelector = selector => controls.get(selector) || null;
let applyPadNet;
let applyIntersectionNet;
app.bindToolNetControl = (_items, inputId, onChange) => {
    if (inputId === 'pcbPropPadNet') applyPadNet = onChange;
    else if (inputId === 'pcbPropMultiNet') applyIntersectionNet = onChange;
    else assert.fail(`Unexpected Net input: ${inputId}`);
};
let lastCommand = null;
app.history = { execute(command) { lastCommand = command; command.execute(); } };
app.refreshFills = () => {};
app._showPadProperties(app.pads[0]);
assert.match(items.innerHTML, /id="pcbPropPadNet" value="" placeholder="Mixed"/,
   'multiple Pads with different Nets show a mixed Net value');
assert.match(items.innerHTML, /id="pcbPropPadRotation" value="" placeholder="Mixed"/,
   'multiple Pads with different rotations show a mixed Rotation value');
applyPadNet('SIGNAL');
assert.deepEqual(app.pads.map(pad => pad.net), ['SIGNAL', 'SIGNAL', 'SIGNAL', 'SIGNAL'],
   'changing the Pad Net applies to every selected Pad');
const rotationInput = controls.get('#pcbPropPadRotation');
rotationInput.value = '90';
rotationInput.emit('input');
assert.deepEqual(app.pads.map(pad => pad.rotation), [90, 90, 90, 90],
   'live Rotation editing updates every selected Pad');
rotationInput.emit('change');
assert.deepEqual(app.pads.map(pad => pad.rotation), [90, 90, 90, 90],
   'committing Rotation preserves the batch edit');
lastCommand.undo();
assert.deepEqual(app.pads.map(pad => pad.rotation), [0, 15, 30, 45],
   'one Undo restores every Pad rotation');
assert.deepEqual(app.pads.map(pad => pad.net), ['SIGNAL', 'SIGNAL', 'SIGNAL', 'SIGNAL'],
   'undoing Rotation does not undo an earlier batch Net edit');

const textA = { id: 't1', content: 'A', layer: 'top-silk', size: 1, rotation: 0, strokeWidth: 0.1, border: false };
const textB = { id: 't2', content: 'B', layer: 'bottom-silk', size: 2, rotation: 90, strokeWidth: 0.2, border: true };
app.texts = new Map([[textA.id, textA], [textB.id, textB]]);
app._showPcbMultiSelectionProperties([
   { kind: 'text', object: textA },
   { kind: 'text', object: textB },
]);
for (const property of ['layer', 'size', 'rotation', 'lineWidth', 'border']) {
   assert.match(items.innerHTML, new RegExp(`pcbPropIntersection_${property}`),
       `multiple Text objects expose ${property}`);
}

app.placements.set('U1', {
   x: 0, y: 0, pads: new Map(),
   side: 'top', rotation: 0, locked: false, refVisible: true,
   refSize: 1, refRot: 0, refStrokeWidth: 0.1,
});
app.placements.set('U2', {
   x: 10, y: 0, pads: new Map(),
   side: 'bottom', rotation: 90, locked: false, refVisible: false,
   refSize: 2, refRot: 90, refStrokeWidth: 0.2,
});
for (const id of ['U1', 'U2']) {
   app.project.schematicDocument.components.push(new Component({ name: 'EmptyFootprint', symbol: { pins: [] } }, { id }));
}
app._showPcbMultiSelectionProperties([
   { kind: 'component', object: 'U1' },
   { kind: 'component', object: 'U2' },
]);
for (const property of ['locked', 'refVisible', 'layer', 'rotation']) {
   assert.match(items.innerHTML, new RegExp(`pcbPropIntersection_${property}`),
       `multiple Components expose ${property}`);
}
const componentRotationInput = controls.get('#pcbPropIntersection_rotation');
componentRotationInput.value = '180';
componentRotationInput.emit('change');
assert.deepEqual(['U1', 'U2'].map(id => app.placements.get(id).rotation), [0, 90],
   'shared number fields wait for the value to settle before committing');
componentRotationInput.emit('blur');
assert.deepEqual(['U1', 'U2'].map(id => app.placements.get(id).rotation), [180, 180],
   'changing shared Component Rotation updates every selected Component');
lastCommand.undo();
assert.deepEqual(['U1', 'U2'].map(id => app.placements.get(id).rotation), [0, 90],
   'one Undo restores every Component rotation');

app._showPcbMultiSelectionProperties([
   { kind: 'text', object: textA },
   { kind: 'reftext', object: 'U1' },
]);
for (const property of ['size', 'rotation', 'lineWidth']) {
   assert.match(items.innerHTML, new RegExp(`pcbPropIntersection_${property}`),
       `Text and References expose shared ${property}`);
}
assert.doesNotMatch(items.innerHTML, /pcbPropIntersection_(layer|border)/,
   'Text-only properties are omitted from a mixed Text and Reference selection');

const makeFill = (id, net, layer, cornerRadius) => ({
   id, type: 'fill', kind: 'rect', net, layer, cornerRadius,
   outline: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 0, y: 5 }],
   nodeCornerRadii: {}, segmentBulges: {},
   getBounds() { return { minX: 0, minY: 0, maxX: 10, maxY: 5 }; },
   getOutline() { return this.outline.map(point => ({ ...point })); },
   captureState() {
       return {
           id: this.id, type: this.type, kind: this.kind, net: this.net, layer: this.layer,
           cornerRadius: this.cornerRadius, outline: this.getOutline(),
           nodeCornerRadii: { ...this.nodeCornerRadii }, segmentBulges: { ...this.segmentBulges },
       };
   },
   applyState(state) { Object.assign(this, structuredClone(state)); },
});
const fills = [makeFill('f1', 'GND', 'top-copper', 0), makeFill('f2', 'VCC', 'bottom-copper', 1)];
app._showPcbMultiSelectionProperties(fills.map(object => ({ kind: 'fill', object })));
for (const property of ['net', 'layer', 'shapeKind', 'cornerRadius', 'width', 'height']) {
   const id = property === 'net' ? 'pcbPropMultiNet' : `pcbPropIntersection_${property}`;
   assert.match(items.innerHTML, new RegExp(id), `multiple Copper Fills expose ${property}`);
}
applyIntersectionNet('POWER');
assert.deepEqual(fills.map(fill => fill.net), ['POWER', 'POWER'],
   'changing shared Fill Net updates every selected Fill');
lastCommand.undo();
assert.deepEqual(fills.map(fill => fill.net), ['GND', 'VCC'],
   'one Undo restores every Fill Net');

const image = (id, layer, rotation = 0) => {
   const radians = -rotation * Math.PI / 180;
   const ux = { x: Math.cos(radians) * 10, y: Math.sin(radians) * 10 };
   const uy = { x: -Math.sin(radians) * 5, y: Math.cos(radians) * 5 };
   return {
       id, kind: 'image', layer, net: '', copperMode: 'add',
       artwork: { invert: false, flipHorizontal: false, flipVertical: false },
       points: [{ x: 0, y: 0 }, ux, { x: ux.x + uy.x, y: ux.y + uy.y }, uy],
   };
};
app._showPcbMultiSelectionProperties([
   { kind: 'shape', object: image('i1', 'top-silk', 0) },
   { kind: 'shape', object: image('i2', 'bottom-silk', 90) },
]);
for (const property of ['layer', 'width', 'height', 'rotation', 'invert', 'flipHorizontal', 'flipVertical']) {
   assert.match(items.innerHTML, new RegExp(`pcbPropIntersection_${property}`),
       `multiple Images expose ${property}`);
}

app._showPcbMultiSelectionProperties([
   { kind: 'track', object: app.tracks[0] },
   { kind: 'via', object: app.vias[0] },
   { kind: 'pad', object: app.pads[0] },
   { kind: 'fill', object: fills[0] },
   { kind: 'shape', object: { ...image('i3', 'top-copper'), net: 'GND' } },
]);
assert.match(items.innerHTML, /pcbPropMultiNet/, 'all Net-bearing object families share Net');
assert.doesNotMatch(items.innerHTML, /pcbPropIntersection_(layer|size|rotation|lineWidth)/,
   'mixed Net-bearing families expose only their true property intersection');

console.log('PASS: PCB multi-selection properties use the shared property intersection');
