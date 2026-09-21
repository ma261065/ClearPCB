import assert from 'node:assert/strict';
import { padFlashOutline, resolvePadFlashes } from '../src/pcb/modules/board-geometry.js';
import { Track } from '../src/shapes/track.js';
globalThis.window = { addEventListener() {} };
const { exportGerbers } = await import('../src/pcb/modules/gerber.js');
const exportBoard = options => exportGerbers({ placements: new Map(), boardWidth: 100, boardHeight: 80, ...options });
for (const shape of ['ellipse', 'rect', 'oval']) {
    for (const rotation of [0, 37, 90]) {
        const placements = new Map([['pad', { x: 20, y: -20, rotation, padOffsets: [
            { dx: 0, dy: 0, width: 2, height: 1, shape, layer: 'top' },
        ] }]]);
        const files = exportBoard({ placements });
        for (const filename of ['board.gtl', 'board.gts', 'board.gtp']) {
            const output = files.get(filename);
            if (shape === 'ellipse' || rotation === 37) {
                assert.ok(output.includes('G36*'), `${shape} ${rotation} ${filename}`);
                assert.ok(!output.includes('C,2*'), 'No bounding circle substitution');
            } else assert.ok(!output.includes('G36*'), 'Keep compact native apertures');
        }
        if (shape === 'rect' && rotation === 37) {
            const point = padFlashOutline(resolvePadFlashes(placements)[0])[0];
            assert.ok(files.get('board.gtl').includes(`X${Math.round(point.x * 1e6)}Y${Math.round(-point.y * 1e6)}`));
        }
    }
}
const track = new Track({ layer: 'top-copper', width: 1, points: [{ x: 100.1, y: -10 }, { x: 100.1, y: -20 }] });
assert.ok(exportBoard({ tracks: [track] }).get('board.gtl').includes('D01*'));
const edgePad = new Map([['pad', { x: 100.1, y: -20, padOffsets: [
    { dx: 0, dy: 0, width: 2, height: 1, shape: 'rect', layer: 'top' },
] }]]);
for (const filename of ['board.gtl', 'board.gts', 'board.gtp']) {
    const output = exportBoard({ placements: edgePad }).get(filename);
    assert.ok(output.includes('G36*'), 'An edge-crossing pad becomes a clipped region');
    assert.ok(!output.includes('D03*'), 'No full flash may extend beyond the board');
    const coordinates = [...output.matchAll(/X(-?\d+)Y(-?\d+)D0[12]\*/g)];
    assert.ok(coordinates.some(point => Number(point[1]) === 100e6), 'The overlapping pad reaches the edge');
    assert.ok(coordinates.every(point => Number(point[1]) <= 100e6), 'Copper, mask and paste stop at the edge');
}
console.log('PASS native and general pad export geometry, mask/paste parity and edge overlap');