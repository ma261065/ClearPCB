import assert from 'node:assert/strict';
import { pointInPolygon } from '../src/core/geometry.js';
import { resolvePadMaskOpenings } from '../src/pcb/modules/board-geometry.js';
globalThis.window = { addEventListener() {} };
const { buildCopperObstacles } = await import('../src/pcb/modules/copper-obstacles.js');
const { collectCopperSubtractHoles, collectMaskOpeningHoles, buildSilkMesh } = await import('../src/pcb/modules/board3d.js');
const { Board2D } = await import('../src/pcb/modules/board2d.js');
const { exportGerbers } = await import('../src/pcb/modules/gerber.js');
const line = { id: 'line', kind: 'line', layer: 'top-copper', filled: false, lineWidth: 0.2,
    points: [{ x: 10, y: -10 }, { x: 20, y: -10 }, { x: 20, y: -20 }], segmentWidths: { 0: 2 } };
const obstacles = buildCopperObstacles({ texts: new Map(), boardShapes: [line] });
assert.equal(obstacles.length, 2, 'Open polylines have no closing routing obstacle');
assert.deepEqual(obstacles.map(segment => segment.width), [2, 0.2]);
const cut = collectCopperSubtractHoles([{ ...line, copperMode: 'remove-copper' }]);
assert.ok(cut.some(hole => pointInPolygon({ x: 15, y: -9.2 }, hole.ring.map(point => ({ x: point.x, y: point.z })))));
const placements = new Map([['pad', { x: 20, y: -20, rotation: 0, padOffsets: [
    { dx: 0, dy: 0, width: 2, height: 1, shape: 'rect', layer: 'top', mask: true },
    { dx: 5, dy: 0, width: 2, height: 1, shape: 'rect', layer: 'top', mask: false },
] }]]);
assert.equal(resolvePadMaskOpenings(placements, 'top').length, 1);
assert.equal(resolvePadMaskOpenings(placements, 'top')[0].w, 2.1);
assert.equal(collectMaskOpeningHoles([], 'top', placements).length, 1);
assert.equal(collectMaskOpeningHoles([], 'bottom', placements).length, 0);
const draws = [];
Board2D.prototype._drawMaskOpenings.call({ data: { placements }, side: 'top',
    _fillPad(...args) { draws.push(args.slice(1)); } }, {});
assert.equal(draws.length, 1);
assert.equal(draws[0][2], 2.1);
const silkPlacement = { x: 0, y: 0, silks: [{ type: 'path', layer: 'top-silk', filled: true,
    strokeWidth: 0.1, d: 'M10 -10 L30 -10 L30 -30 L10 -30 Z M15 -15 L25 -15 L25 -25 L15 -25 Z' }] };
const silkApp = { placements: new Map([['silk', silkPlacement]]), boardShapes: [] };
const mesh = buildSilkMesh(silkApp);
const covered = point => mesh.faces.some(face => pointInPolygon(point,
    face.idx.map(index => ({ x: mesh.verts[index].x, y: mesh.verts[index].z }))));
assert.equal(covered({ x: 20, y: -20 }), false, '3D retains nested silk holes');
assert.equal(covered({ x: 12, y: -12 }), true);
const gerber = exportGerbers({ ...silkApp, boardWidth: 100, boardHeight: 80 }).get('board.gto');
const regions = [...gerber.matchAll(/G36\*\n([\s\S]*?)G37\*/g)].map(match =>
    [...match[1].matchAll(/X(-?\d+)Y(-?\d+)D0[12]\*/g)].map(point => ({ x: Number(point[1]) / 1e6, y: -Number(point[2]) / 1e6 })));
assert.equal(regions.some(region => pointInPolygon({ x: 20, y: -20 }, region)), false);
silkPlacement.silks = [{ type: 'circle', layer: 'top-silk', filled: true, cx: 20, cy: -20, r: 2, strokeWidth: 1 }];
assert.equal(Math.max(...buildSilkMesh(silkApp).verts.map(point => point.x)), 22.5, 'Filled silk includes outer half-stroke');
console.log('PASS routing widths/closure, 3D removal, pad mask openings and nested silk geometry');