import assert from 'node:assert/strict';
import { CopperFill } from '../src/shapes/copper-fill.js';
import { Track } from '../src/shapes/track.js';
globalThis.window = { addEventListener() {} };
const { exportGerbers } = await import('../src/pcb/modules/gerber.js');
const { prepareFabricationSnapshot, hasFabricationContent } = await import('../src/pcb/modules/fabrication-snapshot.js');
const outline = [{ x: 1, y: -1 }, { x: 19, y: -1 }, { x: 19, y: -19 }, { x: 1, y: -19 }];
const fill = new CopperFill({ net: 'GND', outline });
const app = { placements: new Map(), tracks: [], vias: [], texts: new Map(), netlist: [],
    boardShapes: [fill], copperFills: [fill], _boardWidth: 20, _boardHeight: 20, _boardRadius: 0,
    _getRoutingParams: () => ({ clearance: 0.2 }), _fillRefreshScheduled: true };
assert.equal(hasFabricationContent(app), true);
const pending = prepareFabricationSnapshot(app);
fill.outline[0].x = 5;
const snapshot = await pending;
assert.equal(snapshot.fills[0].outline[0].x, 1, 'Snapshot captured before asynchronous loading');
assert.ok(snapshot.fills[0]._computed.length > 0, 'Uncomputed pours are prepared for export');
assert.equal(fill._computed, null, 'Export does not mutate the preview cache');
assert.equal(snapshot.boardShapes.length, 0);
await assert.rejects(prepareFabricationSnapshot({ ...app, _deferDragOverlays: true }), /Finish/);
assert.equal(hasFabricationContent({ placements: new Map(), tracks: [], vias: [], texts: new Map(),
    boardShapes: [{ kind: 'image', layer: 'top-silk' }] }), true);
const track = new Track({ points: [{ x: 2, y: -2 }, { x: 18, y: -2 }], width: 0.6 });
app.tracks.push(track);
app.placements.set('pad', { x: 5, y: -5, padOffsets: [{ dx: 0, dy: 0, width: 2, height: 1, layer: 'top' }],
    element: { uncloneable() {} }, model3d: { uncloneable() {} } });
app.vias.push({ id: 'via', x: 10, y: -10, diameter: 1, drill: 0.3, net: '' });
app.boardShapes.push({ id: 'image', kind: 'image', layer: 'top-copper', filled: true,
    points: [{ x: 6, y: -6 }, { x: 7, y: -6 }, { x: 7, y: -7 }, { x: 6, y: -7 }],
    artwork: { width: 1, height: 1, rectangles: [{ x: 0, y: 0, width: 1, height: 1 }] } });
const pendingGeometry = prepareFabricationSnapshot(app);
track.width = 2;
app.placements.get('pad').padOffsets[0].width = 5;
app.vias[0].diameter = 3;
app.boardShapes[1].points[0].x = 15;
const geometry = await pendingGeometry;
assert.equal(geometry.tracks[0].getEdgeWidth([...track.edges.keys()][0]), 0.6);
assert.equal(geometry.placements.get('pad').padOffsets[0].width, 2);
assert.equal(geometry.vias[0].diameter, 1);
assert.equal(geometry.boardShapes[0].points[0].x, 6);
assert.equal(geometry.placements.get('pad').element, undefined);
assert.ok(exportGerbers(geometry).get('board.gtl').includes('G36*'));
track.getEdgeWidth = () => { throw new Error('Invalid track'); };
await assert.rejects(prepareFabricationSnapshot(app), /Invalid track/);
console.log('PASS fresh detached fabrication snapshot, asynchronous isolation and artwork-only export');