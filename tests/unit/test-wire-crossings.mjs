import assert from 'node:assert/strict';
import { Wire } from '../../src/shapes/wire.js';
import { renderShape } from '../../src/schematic/render/shape-renderer.js';
import { renderWireCrossings } from '../../src/schematic/modules/wire-crossings.js';
import { installFakeDom, fakeElement } from './helpers/fake-dom.mjs';

installFakeDom();
const scale = 10;
function fixture(wires) {
    const contentLayer = fakeElement('g');
    for (const wire of wires) contentLayer.appendChild(renderShape(wire, scale));
    const app = { shapes: wires, viewport: { scale, contentLayer } };
    const before = wires.map(wire => wire.captureState());
    renderWireCrossings(app);
    assert.deepEqual(wires.map(wire => wire.captureState()), before, 'Crossing presentation never edits connectivity or geometry');
    return { app, group: contentLayer.children.at(-1) };
}
const line = (id, points, width = 0.25) => new Wire({ id, points, lineWidth: width, color: '#00cc66' });
{
    const horizontal = line('horizontal', [{ x: -20, y: 0 }, { x: 20, y: 0 }], 0.5);
    const vertical = line('vertical', [{ x: 0, y: -20 }, { x: 0, y: 20 }], 0.75);
    const { app, group } = fixture([horizontal, vertical]);
    assert.equal(group.children.length, 2, 'One interior crossing has exactly two side borders');
    const [firstBorder, secondBorder] = group.children;
    assert.equal(firstBorder.classList.contains('wire-crossing-border'), true);
    assert.equal(secondBorder.classList.contains('wire-crossing-border'), true);
    assert.equal(firstBorder.getAttribute('stroke'), 'var(--sch-background, #1e1e1e)');
    assert.equal(secondBorder.getAttribute('stroke'), 'var(--sch-background, #1e1e1e)');
    assert.equal(Number(firstBorder.getAttribute('stroke-width')), 1 / scale);
    assert.equal(Number(secondBorder.getAttribute('stroke-width')), 1 / scale);
    assert.ok(Math.abs(Math.abs(Number(firstBorder.getAttribute('x1')) - Number(secondBorder.getAttribute('x1')))
        * scale - (0.75 * scale + 1)) < 1e-9,
    'Side-border centres sit half a pixel beyond the rendered wire edges');
    assert.equal(firstBorder.getAttribute('data-wire-id'), 'vertical',
        'Later-rendered vertical wire deterministically receives the crossover border');
    const borderLength = Math.hypot(Number(firstBorder.getAttribute('x2')) - Number(firstBorder.getAttribute('x1')),
        Number(firstBorder.getAttribute('y2')) - Number(firstBorder.getAttribute('y1')));
    assert.ok(borderLength * scale >= horizontal.lineWidth * scale + 2 - 1e-9,
        'Side borders span the full crossed-wire width');
    assert.equal(group.parentNode, app.viewport.contentLayer);
    renderWireCrossings(app);
    assert.equal(group.children.length, 2, 'Repeated render reconciles rather than accumulating cues');
}
{
    const thick = line('thick', [{ x: -20, y: 0 }, { x: 20, y: 0 }], 5);
    const overpass = line('overpass', [{ x: 0, y: -20 }, { x: 0, y: 20 }], 0.5);
    const { group } = fixture([thick, overpass]);
    const borderLine = group.children[0];
    const borderLength = Math.hypot(Number(borderLine.getAttribute('x2')) - Number(borderLine.getAttribute('x1')),
        Number(borderLine.getAttribute('y2')) - Number(borderLine.getAttribute('y1')));
    assert.ok(borderLength * scale >= thick.lineWidth * scale + 2 - 1e-9,
        'Extreme zoom or a thick crossed wire cannot truncate the crossover borders');
}
{
    const underpass = line('angled-underpass', [{ x: -20, y: -20 }, { x: 20, y: 20 }], 2);
    const overpass = line('horizontal-overpass', [{ x: -20, y: 0 }, { x: 20, y: 0 }], 1);
    const { group } = fixture([underpass, overpass]);
    const borders = group.children.slice(0, 2);
    const midpoints = borders.map(border => ({
        x: (Number(border.getAttribute('x1')) + Number(border.getAttribute('x2'))) / 2,
        y: (Number(border.getAttribute('y1')) + Number(border.getAttribute('y2'))) / 2,
    }));
    assert.ok(Math.abs(midpoints[0].x - midpoints[1].x) > 0.1,
        'Angled crossings shift the two side borders to their actual edge intersections');
    const radius = underpass.lineWidth / 2 + 1 / scale;
    for (const borderLine of borders) {
        for (const suffix of ['1', '2']) {
            const x = Number(borderLine.getAttribute(`x${suffix}`));
            const y = Number(borderLine.getAttribute(`y${suffix}`));
            assert.ok(Math.abs(Math.abs(y - x) / Math.SQRT2 - radius) < 1e-9,
                'Each border stops at the angled underpass boundary instead of protruding past it');
        }
    }
}
{
    const horizontal = line('selected-horizontal', [{ x: -20, y: 0 }, { x: 20, y: 0 }]);
    const vertical = line('later-vertical', [{ x: 0, y: -20 }, { x: 0, y: 20 }]);
    const contentLayer = fakeElement('g');
    const app = {
        shapes: [horizontal, vertical],
        viewport: { scale, contentLayer },
        selection: { isSelected: wire => wire === horizontal },
    };
    renderWireCrossings(app);
    assert.equal(contentLayer.children.at(-1).children[0].getAttribute('data-wire-id'), horizontal.id,
        'A selected wire receives the border because selection raises it visually');
}
for (const wires of [
    [line('endpoint', [{ x: -10, y: 0 }, { x: 0, y: 0 }]),
        line('through', [{ x: 0, y: -10 }, { x: 0, y: 10 }])],
    [line('shared-a', [{ x: -10, y: 0 }, { x: 0, y: 0 }]),
        line('shared-b', [{ x: 0, y: 0 }, { x: 10, y: 0 }])],
    [line('parallel-a', [{ x: -10, y: 0 }, { x: 10, y: 0 }]),
        line('parallel-b', [{ x: -10, y: 1 }, { x: 10, y: 1 }])],
]) {
    assert.equal(fixture(wires).group.children.length, 0, 'Nodes, T-junctions and non-crossings have no nonconnection cue');
}
{
    const first = line('first', [{ x: -20, y: 0 }, { x: 20, y: 0 }]);
    const second = line('second', [{ x: -10, y: -10 }, { x: -10, y: 10 }, { x: 10, y: 10 }, { x: 10, y: -10 }]);
    const { app, group } = fixture([first, second]);
    assert.equal(group.children.length, 4, 'Multiple crossings are independently marked');
    second.nodes.values().next().value.x = 0;
    second.nodes.values().next().value.y = 0;
    renderWireCrossings(app);
    assert.equal(group.children.length, 2, 'Moving a crossing onto an authored node removes only that cue');
    app.shapes.length = 0;
    renderWireCrossings(app);
    assert.equal(group.children.length, 0, 'Deleting wires removes all cues');
}
{
    const arc = line('arc', [{ x: -10, y: 0 }, { x: 10, y: 0 }]);
    arc.setEdgeAttr([...arc.edges.keys()][0], 'bulge', 1);
    const probe = line('probe', [{ x: 0, y: -15 }, { x: 0, y: 15 }]);
    assert.equal(fixture([arc, probe]).group.children.length, 2, 'Curved wire crossings use sampled tangent geometry');
}
console.log('PASS local 1px nonconnection borders, deterministic overpass, junction exclusion, curves and cleanup');
