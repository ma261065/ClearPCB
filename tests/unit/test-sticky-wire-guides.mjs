import assert from 'node:assert/strict';
import { Component } from '../../src/components/Component.js';
import { Wire } from '../../src/shapes/wire.js';
import { Net } from '../../src/shapes/net.js';
import { installFakeDom, fakeElement } from './helpers/fake-dom.mjs';
import { beginSelectionMove } from '../../src/schematic/modules/drag-gestures.js';
import { captureStickyGuideBaseline, computeStickyWireSnaps } from '../../src/schematic/modules/wire-drag-snap.js';
import { moveDragState } from '../../src/schematic/modules/draw-states.js';
import { getAxisGlowState } from '../../src/shapes/axis-glow.js';
import { getSchematicDrag } from '../../src/schematic/modules/drag.js';

installFakeDom();
const definition = { name: 'Guide probe', symbol: { graphics: [], pins: [{ number: '1', x: 0, y: 0 }] } };
function fixture(axis, throughLabel = false) {
    const component = new Component(definition, { id: 'component' });
    const label = throughLabel ? new Net({ x: 0, y: 0, net: 'Gnd' }) : null;
    const wire = new Wire({ points: [{ x: 0, y: 0 }, axis === 'h' ? { x: -20, y: 0 } : { x: 0, y: -20 }] });
    wire.pinConnections.set([...wire.nodes.keys()][0], {
        componentId: label?.id || component.id, pinNumber: label ? 'conn' : '1',
    });
    const app = { components: [component], shapes: label ? [label, wire] : [wire],
        viewport: { svg: fakeElement('svg'), contentLayer: fakeElement('g'), scale: 20, gridSize: 1,
            layers: new Map(), getSnappedPosition: point => ({ ...point }) },
        selection: { getSelection: () => [component] }, renderShapes() {}, fileManager: { setDirty() {} },
    };
    beginSelectionMove(app, { x: 0, y: 0 }, { x: 0, y: 0 });
    return { app, component, wire, label };
}

for (const axis of ['h', 'v']) {
    for (const throughLabel of [false, true]) {
        const { app, component, wire, label } = fixture(axis, throughLabel);
        moveDragState.mousemove(app, {}, { worldPos: axis === 'h' ? { x: 0, y: 5 } : { x: 5, y: 0 } });
        const movingIds = new Set([component.id, ...(label ? [label.id] : [])]);
        const before = wire.captureState();
        const proposed = { x: 0.02, y: 0.02 };
        const snap = computeStickyWireSnaps(app, movingIds, proposed.x, proposed.y);
        assert.equal(snap.adjustX, 0, 'Auto-following bridge is not a stationary X reference');
        assert.equal(snap.adjustY, 0, 'Auto-following bridge is not a stationary Y reference');
        assert.deepEqual(snap.guides, [], 'Automatically orthogonal pin stubs do not generate H/V indicators');
        assert.deepEqual(wire.captureState(), before, 'Guide query leaves wire geometry untouched');
        const aligned = computeStickyWireSnaps(app, movingIds,
            axis === 'h' ? 0 : -4.98, axis === 'h' ? -4.98 : 0,
            { baseline: getSchematicDrag(app).stickyGuideBaseline });
        assert.deepEqual(aligned.guides, [], 'An already straight wire does not get a component-drag guide');
        assert.ok(Math.abs((axis === 'h' ? aligned.adjustY : aligned.adjustX) + 0.02) < 1e-9);
        for (const offset of [5.03, 5.08, 5.12]) {
            moveDragState.mousemove(app, {}, { worldPos: axis === 'h' ? { x: 0, y: offset } : { x: offset, y: 0 } });
            assert.deepEqual(getAxisGlowState(app).resolved, [], 'Live drag keeps false pin-stub guides cleared');
        }
        moveDragState.mousemove(app, {}, { worldPos: { x: 0, y: 0 } });
        const feedback = getAxisGlowState(app).resolved;
        assert.deepEqual(feedback, []);
        const straight = new Wire();
        straight.applyState(wire.captureState());
        assert.ok(straight.edges.size > 1, 'Preview contains automatic dogleg nodes');
        straight.cleanGraph();
        assert.equal(straight.edges.size, 1, 'The bridge preview itself remains simplifiable but does not create feedback');
    }
}

for (const axis of ['h', 'v']) {
    const component = new Component(definition, { id: 'component' });
    const rotate = ({ x, y }) => axis === 'h' ? { x, y } : { x: -y, y: x };
    const pin = rotate({ x: 0, y: 0 }), corner = rotate({ x: -20, y: 0 }), end = rotate({ x: -20, y: -30 });
    const wire = new Wire({ points: [pin, corner, end] });
    wire.pinConnections.set([...wire.nodes.keys()][0], { componentId: component.id, pinNumber: '1' });
    const app = { components: [component], shapes: [wire],
        viewport: { svg: fakeElement('svg'), contentLayer: fakeElement('g'), scale: 20, gridSize: 1,
            layers: new Map(), getSnappedPosition: point => ({ ...point }) },
        selection: { getSelection: () => [component] }, renderShapes() {}, fileManager: { setDirty() {} },
    };
    beginSelectionMove(app, pin, pin);
    assert.equal(Object.keys(getSchematicDrag(app).stickyGuideBaseline.get(wire).edges).length, 2,
        'The pre-drag dogleg has two simplified edges');
    moveDragState.mousemove(app, {}, { worldPos: corner });
    const guides = getAxisGlowState(app).resolved;
    assert.equal(guides.length, 1, 'A real pre-existing dogleg that disappears receives feedback');
    assert.ok(Math.hypot(guides[0].segment.a.x - corner.x, guides[0].segment.a.y - corner.y) < 1e-9);
    assert.ok(Math.hypot(guides[0].segment.b.x - end.x, guides[0].segment.b.y - end.y) < 1e-9);
    assert.equal(guides[0].segment.collinear, true);
    const cleaned = wire.clone();
    cleaned.cleanGraph();
    assert.equal(cleaned.edges.size, 1, 'Final geometry reduces from two edges to one');
}

{
    for (const axis of ['h', 'v']) {
        for (const continuation of ['straight', 'corner', 'backtrack', 'zero-then-corner', 'curve', 'branch']) {
            const component = new Component(definition, { id: 'component' });
            const rotate = ({ x, y }) => axis === 'h' ? { x, y } : { x: -y, y: x };
            const start = rotate({ x: 0, y: 0 }), bend = rotate({ x: -20, y: 0 });
            const last = rotate(['straight', 'curve', 'branch'].includes(continuation) ? { x: -30, y: 0 }
                : continuation === 'backtrack' ? { x: -10, y: 0 } : { x: -20, y: -10 });
            const wire = new Wire({ points: [start, bend,
                ...(continuation === 'zero-then-corner' ? [bend] : []), last] });
            wire.pinConnections.set([...wire.nodes.keys()][0], { componentId: component.id, pinNumber: '1' });
            if (continuation === 'curve') wire.setEdgeAttr([...wire.edges.keys()][1], 'bulge', 0.5);
            if (continuation === 'branch') {
                const junction = [...wire.nodes.keys()][1];
                const point = rotate({ x: -20, y: 10 });
                const added = wire.addNode(point.x, point.y);
                wire.addEdge(junction, added);
            }
            const app = { components: [component], shapes: [wire],
                viewport: { svg: fakeElement('svg'), contentLayer: fakeElement('g'), scale: 20, gridSize: 1,
                    layers: new Map(), getSnappedPosition: point => ({ ...point }) },
                selection: { getSelection: () => [component] }, renderShapes() {}, fileManager: { setDirty() {} },
            };
            beginSelectionMove(app, start, start);
            moveDragState.mousemove(app, {}, { worldPos: rotate({ x: 0, y: 5 }) });
            moveDragState.mousemove(app, {}, { worldPos: start });
                const guides = getAxisGlowState(app).resolved;
                assert.deepEqual(guides, [],
                    `${axis}/${continuation}: bridge-only geometry never creates a guide on an already straight original wire`);
        }
    }
}

for (const axis of ['h', 'v']) {
    for (const stop of ['end', 'corner', 'branch', 'curve', 'reverse', 'pin']) {
        const { app, component, wire } = fixture(axis);
        const rotate = ({ x, y }) => axis === 'h' ? { x, y } : { x: -y, y: x };
        const first = [...wire.nodes.keys()][1];
        let last = first;
        for (const point of [{ x: -20, y: 0 }, { x: -30, y: 0 }, { x: -40, y: 0 }]) {
            const position = rotate(point);
            const added = wire.addNode(position.x, position.y);
            wire.addEdge(last, added);
            last = added;
        }
        if (stop === 'pin') wire.pinConnections.set(last, { componentId: 'stationary', pinNumber: '1' });
        if (stop !== 'end') {
            const point = rotate(stop === 'reverse' ? { x: -35, y: 0 }
                : ['curve', 'pin'].includes(stop) ? { x: -50, y: 0 } : { x: -40, y: -10 });
            const added = wire.addNode(point.x, point.y);
            const edgeId = wire.addEdge(last, added);
            if (stop === 'curve') wire.setEdgeAttr(edgeId, 'bulge', 0.5);
            if (stop === 'branch') {
                const position = rotate({ x: -50, y: 0 });
                const branch = wire.addNode(position.x, position.y);
                wire.addEdge(last, branch);
            }
            getSchematicDrag(app).stickyGuideBaseline = captureStickyGuideBaseline(app, new Set([component.id]));
        }
        moveDragState.mousemove(app, {}, { worldPos: rotate({ x: 0, y: 5 }) });
        moveDragState.mousemove(app, {}, { worldPos: { x: 0, y: 0 } });
        const guides = getAxisGlowState(app).resolved;
        assert.deepEqual(guides, [], `${axis}/${stop}: already straight geometry remains unhighlighted`);
        const before = wire.captureState();
        const query = computeStickyWireSnaps(app, new Set([component.id]), 0, 0, {
            guidesOnly: true, baseline: getSchematicDrag(app).stickyGuideBaseline,
        });
        assert.deepEqual(query.guides, []);
        assert.deepEqual(wire.captureState(), before, 'Extending the indicator does not collapse or edit authored nodes');
    }
}

for (const distortion of ['offset', 'reversal']) {
    const { app, component, wire } = fixture('h');
    moveDragState.mousemove(app, {}, { worldPos: { x: 0, y: 5 } });
    moveDragState.mousemove(app, {}, { worldPos: { x: 0, y: 0 } });
    const bridge = [...wire.nodes.values()].find(point => point._stickyBridge);
    if (distortion === 'offset') bridge.y += 0.1;
    else bridge.x = 2;
    const before = wire.captureState();
    const result = computeStickyWireSnaps(app, new Set([component.id]), 0, 0, { guidesOnly: true });
    assert.deepEqual(result.guides, [], `Aligned endpoints cannot hide a retained ${distortion} in the actual bridge path`);
    assert.deepEqual(wire.captureState(), before, 'Testing full path geometry remains read-only');
}

{
    const wire = new Wire({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] });
    wire.pinConnections.set([...wire.nodes.keys()][0], { componentId: 'component', pinNumber: '1' });
    const app = { shapes: [wire], viewport: { gridSize: 1, scale: 20 } };
    const snap = computeStickyWireSnaps(app, new Set(['component']), 0, 0);
    assert.deepEqual(snap.guides, [], 'Already horizontal wires without a dogleg have no component-drag indicator');
}

{
    const { app, component, wire } = fixture('h');
    component.definition = { name: 'Two-pin probe', symbol: { graphics: [], pins: [
        { number: '1', x: 0, y: 0 }, { number: '2', x: 0, y: 5 },
    ] } };
    // A hard pin target wins after sticky alignment was calculated.
    const destination = new Component({ name: 'Target', symbol: { graphics: [], pins: [
        { number: '1', x: 0, y: 0 },
    ] } }, { id: 'destination', x: 2.3, y: 5.2 });
    app.components.push(destination);
    moveDragState.mousemove(app, {}, { worldPos: { x: 2, y: 0 } });
    assert.ok(Math.abs(component.x - 2.3) < 1e-9 && Math.abs(component.y - 0.2) < 1e-9);
    assert.equal(app.wireSnapPin.component, destination, 'Free-pin hard target retains priority');
    assert.deepEqual(getAxisGlowState(app).resolved, [], 'Hard-target movement cannot leave a stale H guide at the earlier alignment');
    assert.deepEqual(wire.nodes.values().next().value, { x: component.x, y: component.y },
        'Guide recalculation does not alter the final sticky geometry');
}

{
    const { app, component, wire } = fixture('h');
    // A reference attached to another moving owner is never stationary.
    const stationary = [...wire.nodes.keys()][1];
    wire.pinConnections.set(stationary, { componentId: 'other', pinNumber: '1' });
    const result = computeStickyWireSnaps(app, new Set([component.id, 'other']), 0, 0);
    assert.deepEqual(result.guides, [], 'Generated bridges cannot hide that both ends move together');
}

console.log('PASS component dragging shows only genuine dogleg collinearity, not automatic H/V stubs');
