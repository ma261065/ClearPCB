import assert from 'node:assert/strict';
import { Component } from '../../src/components/Component.js';
import { Net } from '../../src/shapes/net.js';
import { Wire } from '../../src/shapes/wire.js';
import { ProjectDocument } from '../../src/core/ProjectDocument.js';
import { extractNetlist, SCHEMATIC_CONNECTION_TOLERANCE } from '../../src/core/netlist.js';
import { BuiltInComponents } from '../../src/components/BuiltInComponents.js';
import { defaultPcbStackup } from '../../src/core/project-format.js';

const definition = BuiltInComponents.find(component => component.name === 'Resistor');
const pinsFor = (state, name) => extractNetlist(state).find(entry => entry.net === name)?.pins;

for (const rotation of [0, 37, 90, 180, 270]) {
    for (const mirror of [false, true]) {
        const component = new Component(definition, { id: 'R1', x: 20, y: -30, reference: 'R1', rotation, mirror });
        const point = component.getPinPosition('1');
        const label = new Net({ ...point, net: 'Gnd' });
        const state = { components: [component], shapes: [label] };
        const before = [component.toJSON(), label.toJSON()];
        assert.deepEqual(pinsFor(state, 'Gnd'), [{ componentId: component.id, pinNumber: '1' }]);
        assert.equal(extractNetlist(state).some(net => net.net === 'R1.1'), false,
            'Named pin must not also receive the default single-pin name');
        assert.deepEqual(pinsFor(state, 'R1.2'), [{ componentId: component.id, pinNumber: '2' }]);
        assert.deepEqual([component.toJSON(), label.toJSON()], before, 'Netlist query does not mutate authored state');
        label.net = 'Ground';
        assert.equal(pinsFor(state, 'Gnd'), undefined);
        assert.deepEqual(pinsFor(state, 'Ground'), [{ componentId: component.id, pinNumber: '1' }],
            'Direct label renames are reflected without cached netlist state');
        label.x += SCHEMATIC_CONNECTION_TOLERANCE + 0.01;
        assert.equal(pinsFor(state, 'Ground'), undefined, 'Nearby disconnected label is not a pin net');
        assert.deepEqual(pinsFor(state, 'R1.1'), [{ componentId: component.id, pinNumber: '1' }]);
        label.x -= 0.02;
        assert.ok(pinsFor(state, 'Ground'), 'Matching uses the same tolerance as pin-to-wire attachment');
    }
}

{
    const first = new Component(definition, { id: 'first', x: 0, y: 0, reference: 'R1' });
    const second = new Component(definition, { id: 'second', x: 20, y: 0, reference: 'R2' });
    const labels = [first, second].map(component => new Net({ ...component.getPinPosition('1'), net: 'Gnd' }));
    const state = { components: [first, second], shapes: labels };
    assert.deepEqual(pinsFor(state, 'Gnd').sort((a, b) => a.componentId.localeCompare(b.componentId)), [
        { componentId: 'first', pinNumber: '1' }, { componentId: 'second', pinNumber: '1' },
    ], 'Same-named direct labels form one net across components');
    state.shapes.push(new Net({ ...first.getPinPosition('1'), net: 'Gnd' }));
    assert.equal(pinsFor(state, 'Gnd').length, 2, 'Duplicate labels do not duplicate pins');
    state.shapes.push(new Net({ x: 100, y: 100, net: 'Floating' }));
    assert.equal(pinsFor(state, 'Floating'), undefined, 'Floating labels do not invent physical nets');
}

for (const attachment of ['component', 'label']) {
    const first = new Component(definition, { id: 'first', x: 0, y: 0, reference: 'R1' });
    const second = new Component(definition, { id: 'second', x: 20, y: 0, reference: 'R2' });
    const a = first.getPinPosition('1'), b = second.getPinPosition('1');
    const label = new Net({ ...a, net: 'Gnd' });
    const wire = new Wire({ net: 'Net0001', points: [a, b] });
    const [start, end] = [...wire.nodes.keys()];
    wire.pinConnections.set(start, { componentId: attachment === 'label' ? label.id : first.id,
        pinNumber: attachment === 'label' ? 'conn' : '1' });
    wire.pinConnections.set(end, { componentId: second.id, pinNumber: '1' });
    const state = { components: [first, second], shapes: [wire, label] };
    const before = wire.captureState();
    assert.deepEqual(pinsFor(state, 'Gnd').sort((a, b) => a.componentId.localeCompare(b.componentId)), [
        { componentId: first.id, pinNumber: '1' }, { componentId: second.id, pinNumber: '1' },
    ], 'Direct pin label names the whole connected wire net and exports only physical pins');
    assert.equal(pinsFor(state, 'Net0001'), undefined);
    assert.deepEqual(wire.captureState(), before, 'Export resolves names without rewriting wire geometry or attachments');
    const conflict = new Net({ ...b, net: 'Vcc' });
    state.shapes.push(conflict);
    assert.throws(() => extractNetlist(state), /Conflicting Net labels.*(?:Gnd.*Vcc|Vcc.*Gnd)/,
        'Incompatible labels do not silently select a net or assign the pin to both');
}

{
    const component = new Component(definition, { id: 'resistor', x: 0, y: 0, reference: 'R1' });
    const label = new Net({ ...component.getPinPosition('1'), net: 'Gnd' });
    const project = new ProjectDocument();
    project.schematicDocument.components.push(component);
    project.schematicDocument.shapes.push(label);
    const original = project.getNetlist();
    assert.deepEqual(project.resolvePcbLayout().netlist, original, 'PCB layout gets the same named-pin netlist');
    const copy = new ProjectDocument();
    await copy.load({ ...project.serialize(), pcb: { stackup: defaultPcbStackup(),
        design: project.pcbDocument.designSettings.serialize() } });
    assert.deepEqual(copy.getNetlist(), original, 'Save/open retains direct pin connectivity without a view');
    assert.deepEqual(copy.synchronizePcbLayout().netlist, original);
    copy.schematicDocument.shapes.length = 0;
    assert.equal(copy.getNetlist().some(net => net.net === 'Gnd'), false,
        'Removing the label restores the default pin net');
}

console.log('PASS direct pin NetLabels, pose/mirror/tolerance, shared names, wired labels, model isolation and PCB round trip');
