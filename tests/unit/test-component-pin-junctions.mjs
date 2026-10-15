import assert from 'node:assert/strict';
import { Component } from '../../src/components/Component.js';
import { BuiltInComponents } from '../../src/components/BuiltInComponents.js';
import { collectCoincidentComponentPins } from '../../src/core/component-pin-connectivity.js';
import { extractNetlist } from '../../src/core/netlist.js';
import { renderComponentPinJunctions } from '../../src/schematic/modules/component-pin-junctions.js';
import { NoConnect } from '../../src/shapes/noconnect.js';
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
renderComponentPinJunctions(app);
const group = contentLayer.children.at(-1);
assert.equal(group.children.length, 1);
assert.equal(group.children[0].classList.contains('direct-pin-junction-dot'), true);
assert.equal(group.children[0].getAttribute('fill'), '#00cc66');
assert.equal(Number(group.children[0].getAttribute('cx')), firstPin.x);
assert.equal(Number(group.children[0].getAttribute('cy')), firstPin.y);

second.x += 1;
renderComponentPinJunctions(app);
assert.equal(group.children.length, 0, 'Separating the components removes the derived join dot');
assert.deepEqual(extractNetlist(state).find(net => net.net === 'R2.1')?.pins,
    [{ componentId: 'second', pinNumber: '1' }],
    'Separating the components restores independent default nets');

const marker = new NoConnect({ ...firstPin, pinConnection: { componentId: first.id, pinNumber: '2' } });
app.shapes.push(marker);
const netlistBefore = extractNetlist(app);
renderComponentPinJunctions(app);
assert.equal(group.children.length, 1, 'No Connect on a pin shows a connection dot');
assert.equal(group.children[0].getAttribute('fill'), '#00cc66');
assert.equal(Number(group.children[0].getAttribute('cx')), firstPin.x);
assert.equal(Number(group.children[0].getAttribute('cy')), firstPin.y);
assert.deepEqual(extractNetlist(app), netlistBefore, 'The visual dot does not create an electrical connection');
marker.visible = false;
renderComponentPinJunctions(app);
assert.equal(group.children.length, 0, 'Hidden markers do not show dots');
marker.visible = true;
marker.x += SCHEMATIC_CONNECTION_TOLERANCE + 1e-6;
renderComponentPinJunctions(app);
assert.equal(group.children.length, 0, 'An off-pin marker does not show a stale bond dot');
marker.x = firstPin.x;
marker.pinConnection.pinNumber = 'missing';
renderComponentPinJunctions(app);
assert.equal(group.children.length, 0, 'Invalid bonds do not claim a pin connection');
marker.pinConnection = null;
renderComponentPinJunctions(app);
assert.equal(group.children.length, 1, 'Legacy on-pin markers without a saved bond also show the dot');
app.shapes.push(marker.clone());
renderComponentPinJunctions(app);
assert.equal(group.children.length, 1, 'Coincident markers do not duplicate dots');
app.shapes.length = 0;
renderComponentPinJunctions(app);
assert.equal(group.children.length, 0, 'Deleting markers clears their connection dots');

console.log('PASS direct component-pin electrical groups and derived junction dots');
