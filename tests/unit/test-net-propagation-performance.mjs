import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (!process.argv.includes('--worker')) {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--worker'], {
        encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.error, undefined, `Net propagation timed out: ${result.error?.message}`);
    assert.equal(result.status, 0, result.stderr);
    process.stdout.write(result.stdout);
} else {
    globalThis.window = { addEventListener() {} };
    const { Track } = await import('../../src/shapes/track.js');
    const { Via } = await import('../../src/shapes/via.js');
    const { collectBondedCopper, collectNodeConnections } = await import('../../src/pcb/modules/track-draw.js');
    const { copperShapesTouch } = await import('../../src/pcb/modules/track-contact-geometry.js');
    const { pictureShape } = await import('../../src/shared/pcb/picture-raster.js');
    const artwork = offset => ({
        width: 100, height: 100,
        rectangles: Array.from({ length: 400 }, (_, index) => ({
            x: (index % 20) * 4 + offset, y: Math.floor(index / 20) * 4, width: 1, height: 1,
        })),
    });
    const shapes = [0, 2].map(offset => pictureShape(artwork(offset),
        { widthMm: 100, layer: 'top-copper', center: { x: 200, y: 200 } }));
    const track = new Track({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], net: 'SIGNAL' });
    const via = new Via({ x: 0, y: 0 });
    const app = { tracks: [track], vias: [via], pads: [], placements: new Map(), netlist: [],
        boardShapes: shapes };
    const start = performance.now();
    const bonded = collectBondedCopper(app, { track }, { includeShapes: true });
    const unrelatedMs = performance.now() - start;
    assert.deepEqual([...bonded.vias], [via]);
    assert.equal(bonded.shapes.size, 0);
    assert.ok(unrelatedMs < 500, `Unrelated artwork blocked propagation for ${unrelatedMs.toFixed(1)} ms`);
    const nodeStart = performance.now();
    const nodeGroup = collectNodeConnections(app, new Map([[track, new Set(track.nodes.keys())]]));
    const nodeMs = performance.now() - nodeStart;
    assert.deepEqual([...nodeGroup.vias], [via]);
    assert.equal(nodeGroup.shapes.size, 0);
    assert.ok(nodeMs < 500, `Node-target resolution blocked propagation for ${nodeMs.toFixed(1)} ms`);

    const contactStart = performance.now();
    assert.equal(copperShapesTouch(...shapes), true, 'overlapping picture frames form one logical copper group');
    assert.equal(copperShapesTouch(shapes[0], shapes[0]), true);
    const contactMs = performance.now() - contactStart;
    assert.ok(contactMs < 1000, `Artwork contact checks took ${contactMs.toFixed(1)} ms`);

    // Reaching either frame also reaches the overlapping picture's logical copper.
    track.nodes.values().next().value.x = 150.5;
    track.nodes.values().next().value.y = 150.5;
    const connectedStart = performance.now();
    const connected = collectBondedCopper(app, { track }, { includeShapes: true });
    assert.ok(connected.shapes.has(shapes[0]));
    assert.ok(connected.shapes.has(shapes[1]));
    const connectedMs = performance.now() - connectedStart;
    assert.ok(connectedMs < 1000, `Connected artwork blocked propagation for ${connectedMs.toFixed(1)} ms`);
    const connectedNode = collectNodeConnections(app, new Map([[track, new Set(track.nodes.keys())]]));
    assert.ok(connectedNode.shapes.has(shapes[0]));
    assert.ok(connectedNode.shapes.has(shapes[1]), 'Node validation follows transitive stationary artwork contacts');
    console.log(`PASS bounded Net traversal: unrelated ${unrelatedMs.toFixed(1)} ms, node targets ${nodeMs.toFixed(1)} ms, artwork contacts ${contactMs.toFixed(1)} ms, connected ${connectedMs.toFixed(1)} ms`);
}
