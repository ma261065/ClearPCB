import assert from 'node:assert/strict';
import { Track } from '../src/shapes/track.js';
import { updatePlacementPadPositions, repositionPadConnectedNodes, applyPlacementSide,
    disconnectIncompatiblePadNodes } from '../src/core/pcb-placement-geometry.js';
import { isPlacementMirrored } from '../src/pcb/modules/board-geometry.js';

assert.equal(typeof document, 'undefined');
assert.equal(typeof window, 'undefined');
for (const side of ['top', 'bottom']) for (const mirror of [false, true]) {
    for (const rotation of [0, 37.123456, 90, 180, 270]) {
        const offsets = [
            { padId: '1', number: '1', dx: 1.234567, dy: -2.345678 },
            { padId: '1#2', number: '1', dx: 3.456789, dy: 4.567891 },
            { padId: 2, number: '2', dx: -3, dy: 2 },
            { padId: '3', number: 3, dx: -4, dy: -5 },
        ];
        const beforeOffsets = structuredClone(offsets);
        const pads = new Map([['unrelated', { x: 100, y: 100, number: 'unrelated' }]]);
        const placement = { x: Math.PI, y: -Math.E, rotation, mirror, side, padOffsets: offsets, pads };
        Object.defineProperty(placement, 'elements', { get() { assert.fail('Geometry must not inspect SVG'); } });
        updatePlacementPadPositions(placement);
        const sign = (mirror ? -1 : 1) * (side === 'bottom' ? -1 : 1);
        assert.equal(isPlacementMirrored(placement), sign === -1);
        const radians = rotation * Math.PI / 180;
        for (const offset of offsets) {
            const actual = pads.get(offset.padId);
            const x = Math.PI + sign * offset.dx * Math.cos(radians) - offset.dy * Math.sin(radians);
            const y = -Math.E + sign * offset.dx * Math.sin(radians) + offset.dy * Math.cos(radians);
            assert.ok(Math.abs(actual.x - x) < 1e-12);
            assert.ok(Math.abs(actual.y - y) < 1e-12);
            assert.equal(actual.number, offset.number);
        }
        assert.equal(placement.pads, pads);
        assert.deepEqual(offsets, beforeOffsets);
        assert.deepEqual(pads.get('unrelated'), { x: 100, y: 100, number: 'unrelated' });
        const track = new Track({
            graphNodes: { n0: { x: 999, y: 999 }, n1: { x: 999, y: 999 },
                n2: { x: 999, y: 999 }, n3: { x: 999, y: 999 } },
            graphEdges: { e0: { from: 'n0', to: 'n1' }, e1: { from: 'n1', to: 'n2' }, e2: { from: 'n2', to: 'n3' } },
            padConnections: {
                n0: { componentId: 'U1', pinNumber: '1' },
                n1: { componentId: 'U1', pinNumber: '1#2' },
                n2: { componentId: 'U1', pinNumber: '2' },
                n3: { componentId: 'U1', pinNumber: 3 },
            },
        });
        const other = new Track({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
            padConnections: { n0: { componentId: 'U2', pinNumber: '1' } } });
        const untouched = other.captureState();
        const connections = track.padConnections;
        track.getBounds();
        assert.deepEqual(repositionPadConnectedNodes([track, other], 'U1', pads), new Set([track]));
        assert.equal(track._bounds, null, 'Moved tracks invalidate their own geometry without a renderer');
        assert.equal(track.padConnections, connections);
        for (const [index, offset] of offsets.entries()) {
            const pad = pads.get(offset.padId);
            assert.deepEqual(track.nodes.get(`n${index}`), { x: pad.x, y: pad.y });
        }
        assert.notDeepEqual(track.nodes.get('n0'), track.nodes.get('n1'), 'Duplicate-number pads keep distinct physical positions');
        const bounds = track.getBounds();
        assert.equal(repositionPadConnectedNodes([track, other], 'U1', pads).size, 0);
        assert.equal(track._bounds, bounds, 'Unchanged endpoints retain the existing geometry cache');
        assert.equal(track.getBounds(), bounds, 'Headless bounds reuse does not require clearing render dirtiness');
        offsets[0].dx += 1;
        updatePlacementPadPositions(placement);
        assert.deepEqual(repositionPadConnectedNodes([track, other], 'U1', pads), new Set([track]),
            'Each operation uses the current footprint geometry, not a captured historical footprint');
        assert.deepEqual(other.captureState(), untouched);
        const beforeUnresolved = track.captureState();
        assert.equal(repositionPadConnectedNodes([track], 'U1', new Map()).size, 0);
        assert.deepEqual(track.captureState(), beforeUnresolved);
        assert.equal('_svgElements' in track, false);
    }
}

{
    const placement = {
        side: 'top',
        padOffsets: [
            { padId: '1', number: '1', layer: 'top' },
            { padId: '1#2', number: '1', layer: 'both' },
            { padId: '2', number: '2', layer: 'bottom' },
            { number: 'legacy', layer: 'both' },
        ],
        pasteOffsets: [{ side: 'top' }, { side: 'bottom' }],
    };
    const pads = placement.padOffsets, paste = placement.pasteOffsets;
    for (let cycle = 0; cycle < 2; cycle++) {
        applyPlacementSide(placement, 'bottom');
        applyPlacementSide(placement, 'bottom');
        assert.deepEqual(pads.map(pad => pad.layer), ['bottom', 'both', 'top', 'both']);
        assert.deepEqual(paste.map(aperture => aperture.side), ['bottom', 'top']);
        applyPlacementSide(placement, 'top');
        assert.deepEqual(pads.map(pad => pad.layer), ['top', 'both', 'bottom', 'both']);
        assert.deepEqual(paste.map(aperture => aperture.side), ['top', 'bottom']);
        assert.equal(placement.padOffsets, pads);
        assert.equal(placement.pasteOffsets, paste);
    }
    const bonded = (pinNumber, layer, componentId = 'U1') => new Track({
        points: [{ x: 3.123456, y: -4.234567 }, { x: 10, y: 0 }], layer,
        padConnections: { n0: { componentId, pinNumber } },
    });
    const top = bonded(1, 'top-copper'), bottom = bonded('2', 'bottom-copper');
    const duplicate = bonded('1#2', 'bottom-copper'), legacy = bonded('legacy', 'bottom-copper');
    const unrelated = bonded('1', 'top-copper', 'U2');
    const mixed = bonded('1', 'top-copper');
    const branch = mixed.addNode(20, 20);
    mixed.addEdge('n0', branch, { layer: 'bottom-copper', width: 0.2, bulge: 0 });
    const tracks = [top, bottom, duplicate, legacy, unrelated, mixed];
    const before = tracks.map(track => track.captureState());
    applyPlacementSide(placement, 'bottom');
    const changed = disconnectIncompatiblePadNodes(tracks, 'U1', pads);
    assert.deepEqual(changed, new Set([top, bottom]));
    assert.equal(top.padConnections.size, 0);
    assert.equal(bottom.padConnections.size, 0);
    for (const track of [duplicate, legacy, unrelated, mixed]) assert.equal(track.padConnections.size, 1);
    for (const [index, track] of tracks.entries()) {
        assert.deepEqual(track.captureState().nodes, before[index].nodes, 'Disconnecting never moves a track');
        assert.deepEqual(track.captureState().edges, before[index].edges);
    }
    assert.equal(disconnectIncompatiblePadNodes(tracks, 'U1', pads).size, 0);
}
assert.equal(typeof document, 'undefined');
assert.equal(typeof window, 'undefined');
console.log('PASS renderer-free placement transforms, current pad geometry, physical pad IDs, layers and track bonds');
