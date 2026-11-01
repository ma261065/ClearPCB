import assert from 'node:assert/strict';
import { Component } from '../../src/components/Component.js';
import { BuiltInComponents } from '../../src/components/BuiltInComponents.js';
import { collectCoincidentComponentPins } from '../../src/core/component-pin-connectivity.js';
import { extractNetlist } from '../../src/core/netlist.js';
import {
    affectsConnectionDots,
    clearConnectionDots,
    renderConnectionDots,
} from '../../src/schematic/modules/connection-dots.js';
import { renderShape } from '../../src/schematic/render/shape-renderer.js';
import { NoConnect } from '../../src/shapes/noconnect.js';
import { Wire } from '../../src/shapes/wire.js';
import { SCHEMATIC_CONNECTION_TOLERANCE } from '../../src/core/component-pin-connectivity.js';
import { fakeElement, installFakeDom } from './helpers/fake-dom.mjs';

installFakeDom();
const definition = BuiltInComponents.find(component => component.name === 'Resistor');
const first = new Component(definition, { id: 'first', reference: 'R1', x: 0, y: 0 });
const second = new Component(definition, { id: 'second', reference: 'R2', x: 0, y: 0 });
const firstPin = first.getPinPosition('2');
const secondPin = second.getPinPosition('1');
second.x += firstPin.x - secondPin.x;
second.y += firstPin.y - secondPin.y;
const state = { components: [first, second], shapes: [] };
const before = state.components.map(component => component.toJSON());

const contacts = collectCoincidentComponentPins(state.components);
assert.equal(contacts.length, 1);
assert.deepEqual(contacts[0].pins.map(pin => pin.key), ['first:2', 'second:1']);
assert.deepEqual(state.components.map(component => component.toJSON()), before,
    'Direct-pin contact query does not mutate component geometry');

const joinedNet = extractNetlist(state).find(net => net.net === 'R1.2');
assert.deepEqual(joinedNet?.pins, [
    { componentId: 'first', pinNumber: '2' },
    { componentId: 'second', pinNumber: '1' },
], 'Directly touching pins share one electrical net');
assert.equal(extractNetlist(state).some(net => net.net === 'R2.1'), false,
    'Joined second pin does not retain a separate default net');

const contentLayer = fakeElement('g');
const app = { ...state, viewport: { scale: 10, contentLayer } };
renderConnectionDots(app);
const group = contentLayer.children.at(-1);
assert.equal(group.children.length, 1);
assert.equal(group.children[0].classList.contains('direct-pin-junction-dot'), true);
assert.equal(group.children[0].getAttribute('fill'), '#00cc66');
assert.equal(Number(group.children[0].getAttribute('cx')), firstPin.x);
assert.equal(Number(group.children[0].getAttribute('cy')), firstPin.y);

second.x += 1;
renderConnectionDots(app);
assert.equal(group.children.length, 0, 'Separating the components removes the derived join dot');
assert.deepEqual(extractNetlist(state).find(net => net.net === 'R2.1')?.pins,
    [{ componentId: 'second', pinNumber: '1' }],
    'Separating the components restores independent default nets');

const marker = new NoConnect({ ...firstPin, pinConnection: { componentId: first.id, pinNumber: '2' } });
app.shapes.push(marker);
const netlistBefore = extractNetlist(app);
renderConnectionDots(app);
assert.equal(group.children.length, 1, 'No Connect on a pin shows a connection dot');
assert.equal(group.children[0].getAttribute('fill'), '#00cc66');
assert.equal(Number(group.children[0].getAttribute('cx')), firstPin.x);
assert.equal(Number(group.children[0].getAttribute('cy')), firstPin.y);
assert.deepEqual(extractNetlist(app), netlistBefore, 'The visual dot does not create an electrical connection');
marker.visible = false;
renderConnectionDots(app);
assert.equal(group.children.length, 0, 'Hidden markers do not show dots');
marker.visible = true;
marker.x += SCHEMATIC_CONNECTION_TOLERANCE + 1e-6;
renderConnectionDots(app);
assert.equal(group.children.length, 0, 'An off-pin marker does not show a stale bond dot');
marker.x = firstPin.x;
marker.pinConnection.pinNumber = 'missing';
renderConnectionDots(app);
assert.equal(group.children.length, 0, 'Invalid bonds do not claim a pin connection');
marker.pinConnection = null;
renderConnectionDots(app);
assert.equal(group.children.length, 1, 'Legacy on-pin markers without a saved bond also show the dot');
app.shapes.push(marker.clone());
renderConnectionDots(app);
assert.equal(group.children.length, 1, 'Coincident markers do not duplicate dots');
app.shapes.length = 0;
renderConnectionDots(app);
assert.equal(group.children.length, 0, 'Deleting markers clears their connection dots');

// --- No Connect markers on wires ---
const wire = new Wire({ points: [{ x: 50, y: 50 }, { x: 70, y: 50 }] });
app.shapes.push(wire);
const onNode = new NoConnect({ x: 70, y: 50 });
app.shapes.push(onNode);
const wireNetlistBefore = extractNetlist(app);
renderConnectionDots(app);
assert.equal(group.children.length, 1, 'No Connect on a wire endpoint shows a connection dot');
assert.equal(Number(group.children[0].getAttribute('cx')), 70);
assert.equal(Number(group.children[0].getAttribute('cy')), 50);
assert.deepEqual(extractNetlist(app), wireNetlistBefore,
    'The wire contact dot does not create an electrical connection');

onNode.x = 60;
renderConnectionDots(app);
assert.equal(group.children.length, 1, 'No Connect mid-segment shows a connection dot');
assert.equal(Number(group.children[0].getAttribute('cx')), 60);

onNode.y = 50 + SCHEMATIC_CONNECTION_TOLERANCE / 2;
renderConnectionDots(app);
assert.equal(group.children.length, 1, 'Near-segment markers snap the dot onto the wire');
assert.equal(Number(group.children[0].getAttribute('cy')), 50,
    'The dot is drawn at the contact point on the wire, not at the marker');

onNode.y = 50 + SCHEMATIC_CONNECTION_TOLERANCE + 1e-6;
renderConnectionDots(app);
assert.equal(group.children.length, 0, 'A marker off the wire shows no dot');

onNode.y = 50;
onNode.visible = false;
renderConnectionDots(app);
assert.equal(group.children.length, 0, 'Hidden markers on wires show no dot');
onNode.visible = true;

const onPinAndWire = new NoConnect({ ...firstPin });
const pinWire = new Wire({ points: [{ ...firstPin }, { x: firstPin.x + 20, y: firstPin.y }] });
app.shapes.push(pinWire, onPinAndWire);
renderConnectionDots(app);
assert.equal(group.children.length, 2,
    'A marker touching both a pin and a wire shows a single dot');

app.shapes.splice(app.shapes.indexOf(wire), 1);
renderConnectionDots(app);
assert.equal(group.children.length, 1, 'Deleting the wire clears its contact dot');
assert.equal(affectsConnectionDots(wire), true, 'Wire edits refresh the derived dots');

clearConnectionDots(app);
assert.equal(group.children.length, 0,
    'Replacing the document clears derived connection dots without waiting for a zoom render');

// Every connection indicator is rendered in the same overlay and deduplicated.
const unifiedLayer = fakeElement('g');
const unifiedApp = { components: [], shapes: [], viewport: { scale: 10, contentLayer: unifiedLayer } };
const unifiedWire = new Wire({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }] });
const nodeIds = [...unifiedWire.nodes.keys()];
const branch = unifiedWire.addNode(10, -10);
unifiedWire.addEdge(nodeIds[1], branch);
unifiedWire.pinConnections.set(nodeIds[0], { componentId: 'part', pinNumber: '1' });
unifiedWire.pinConnections.set(nodeIds[1], { componentId: 'part', pinNumber: '2' });
unifiedApp.shapes.push(unifiedWire, new NoConnect({ x: 10, y: 0 }));

const wireElement = renderShape(unifiedWire, 10);
assert.equal(wireElement.querySelector('.junction-dot'), null,
    'Wire SVG no longer owns graph-junction dots');
assert.equal(wireElement.querySelector('.pin-connection-dot'), null,
    'Wire SVG no longer owns pin-connection dots');

renderConnectionDots(unifiedApp);
const unifiedGroup = unifiedLayer.children.at(-1);
assert.equal(unifiedGroup.classList.contains('schematic-connection-dots'), true);
assert.equal(unifiedGroup.children.length, 2,
    'Coincident junction, pin and No Connect sources deduplicate to one circle');
const centreDot = unifiedGroup.children.find(dot => Number(dot.getAttribute('cx')) === 10);
assert.equal(centreDot.classList.contains('schematic-connection-dot'), true);
assert.equal(centreDot.classList.contains('junction-dot'), true);
assert.equal(centreDot.classList.contains('pin-connection-dot'), true);
assert.equal(centreDot.classList.contains('direct-pin-junction-dot'), true);
const endpointDot = unifiedGroup.children.find(dot => Number(dot.getAttribute('cx')) === 0);
assert.equal(endpointDot.classList.contains('pin-connection-dot'), true);
assert.equal(endpointDot.classList.contains('junction-dot'), false);

console.log('PASS unified schematic connection-dot overlay, contacts, deduplication and cleanup');
