import assert from 'node:assert/strict';
import { isPictureCopperRefreshPending } from '../../src/pcb/modules/refresh-state.js';
import { installFakeDom } from './helpers/fake-dom.mjs';

installFakeDom();
const { collectCopper, runDRC } = await import('../../src/pcb/modules/drc.js');
const { reconcileRatsnest, collectBondedCopper, resolveTrackDrawSnap, nearestPointOnNet, setTrackToolLayer } =
    await import('../../src/pcb/modules/track-draw.js');
const { boardShapeClearanceOutlines } = await import('../../src/pcb/modules/copper-fill-geom.js');
const { captureBoardShapeState } = await import('../../src/pcb/modules/board-shapes.js');
const { ModifyBoardShapeCommand } = await import('../../src/pcb/modules/shape-commands.js');
const { pictureShape } = await import('../../src/shared/pcb/picture-raster.js');
const { Track } = await import('../../src/shapes/track.js');

const modes = ['remove-copper', 'remove-solder-mask', 'remove-copper-mask'];
const rectangle = (halfSize) => [
    { x: -halfSize, y: -halfSize }, { x: halfSize, y: -halfSize },
    { x: halfSize, y: halfSize }, { x: -halfSize, y: halfSize },
];
function board(extra = {}) {
    const ratlines = {
        children: [],
        appendChild(line) { line.parentNode = this; this.children.push(line); },
        removeChild(line) { this.children.splice(this.children.indexOf(line), 1); line.parentNode = null; },
    };
    const app = { tracks: [], vias: [], pads: [], boardShapes: [], copperFills: [], placements: new Map(),
        texts: new Map(), netlist: [], _shapeElements: new Map(), viewport: { scale: 100, gridVisible: false },
        getLayerGroup: id => id === 'ratlines' ? ratlines : null, ...extra };
    setTrackToolLayer(app, 'top-copper');
    return app;
}
const shapes = [
    { kind: 'line', points: [{ x: -2, y: 0 }, { x: 2, y: 0 }] },
    { kind: 'rect', points: rectangle(1) },
    { kind: 'polygon', points: rectangle(1), cornerRadius: 0.2 },
    { kind: 'circle', x: 0, y: 0, radius: 1 },
    { kind: 'arc', start: { x: -1, y: -1 }, bulge: { x: 0, y: 0 }, end: { x: 1, y: -1 } },
    pictureShape({ width: 10, height: 10, rectangles: [{ x: 0, y: 0, width: 10, height: 10 }] },
        { widthMm: 2, center: { x: 0, y: 0 }, layer: 'top-copper' }),
];
for (const source of shapes) {
    for (const copperMode of modes) {
        const shape = { ...structuredClone(source), id: 'removal', net: 'N', layer: 'top-copper',
            filled: true, lineWidth: 0.2, copperMode };
        const app = board({ boardShapes: [shape] });
        assert.equal(Object.values(collectCopper(app)).flat().length, 0, `${source.kind}/${copperMode}: not conductive copper`);
        assert.deepEqual(runDRC(app, { clearance: 0.3 }).violations, []);
        assert.deepEqual(boardShapeClearanceOutlines(shape, 0.3), [], 'no clearance halo on removal artwork');
        assert.deepEqual(resolveTrackDrawSnap(app, { x: 0, y: 0 }).contactNets, [], 'removal artwork cannot seed a routing Net');
        assert.equal(nearestPointOnNet(app, 'N', { x: 0, y: 0 }), null, 'removal artwork is not a live guide target');
        app.vias = [0, 10].map((x, id) => ({ id: `v${id}`, x, y: 0, diameter: 0.6, drill: 0.3, net: 'N' }));
        reconcileRatsnest(app);
        assert.equal(app.getLayerGroup('ratlines').children.length, 1, 'removal artwork adds no ratline island or bridge');
        assert.equal(collectBondedCopper(app, { via: app.vias[0] }, { includeShapes: true }).shapes.size, 0);
    }
}

for (const mode of modes) {
    const app = board({ tracks: [
        new Track({ net: 'A', width: 0.2, points: [{ x: -2, y: 0 }, { x: 0, y: 0 }, { x: 2, y: 0 }] }),
        new Track({ net: 'B', width: 0.2, points: [{ x: 0, y: -2 }, { x: 0, y: 0 }, { x: 0, y: 2 }] }),
    ] });
    const cut = { id: 'cut', kind: 'rect', net: 'IGNORED', layer: 'top-copper',
        filled: true, lineWidth: 0.05, copperMode: mode, points: rectangle(0.25) };
    app.boardShapes.push(cut);
    const result = runDRC(app, { clearance: 0.5 });
    if (mode === 'remove-solder-mask') {
        assert.deepEqual(result.violations.map(v => v.rule), ['short'], 'mask removal cannot cure a copper short');
    } else {
        assert.deepEqual(result.violations.map(v => v.rule), ['clearance'],
            'a cut can break a short while leaving an insufficient gap');
        cut.points = rectangle(0.75);
        assert.deepEqual(runDRC(app, { clearance: 0.5 }).violations, [], 'a wide enough cut clears both issues');
        cut.layer = 'bottom-copper';
        assert.deepEqual(runDRC(app, { clearance: 0.5 }).violations.map(v => v.rule), ['short'],
            'opposite-layer removal cannot cure the top-layer short');
    }
}

for (const copperMode of modes) {
    const shape = { id: 'mode-change', kind: 'rect', layer: 'top-copper', net: 'N',
        lineWidth: 0.2, filled: true, copperMode: 'add', points: rectangle(2) };
    const app = board({ boardShapes: [shape] });
    app.vias = [-1, 1].map((x, id) => ({ id: `v${id}`, x, y: 0, diameter: 0.6, drill: 0.3, net: 'N' }));
    let refreshes = 0;
    app.updateRatsnest = () => { refreshes++; reconcileRatsnest(app); };
    app.updateRatsnest();
    assert.equal(app.getLayerGroup('ratlines').children.length, 0, 'additive shape bridges the Vias');
    const before = captureBoardShapeState(shape);
    const command = new ModifyBoardShapeCommand(app, shape, before, { ...before, copperMode });
    command.execute();
    assert.equal(refreshes, 2, 'switching to a removal mode refreshes connectivity immediately');
    assert.equal(isPictureCopperRefreshPending(app), false, 'a semantic mode change is not a deferred geometry edit');
    assert.equal(app.getLayerGroup('ratlines').children.length, 1, 'removed additive bridge is no longer connected');
    command.undo();
    assert.equal(refreshes, 3);
    assert.equal(app.getLayerGroup('ratlines').children.length, 0, 'Undo restores the additive bridge');
    command.execute();
    assert.equal(refreshes, 4);
    assert.equal(app.getLayerGroup('ratlines').children.length, 1, 'Redo excludes the removal shape again');
}

{
    const shape = { id: 'cut', kind: 'rect', net: 'IGNORED', layer: 'top-copper', filled: true,
        lineWidth: 0.05, copperMode: 'remove-solder-mask', points: rectangle(0.75) };
    const app = board({ boardShapes: [shape], tracks: [
        new Track({ net: 'A', points: [{ x: -2, y: 0 }, { x: 0, y: 0 }, { x: 2, y: 0 }] }),
        new Track({ net: 'B', points: [{ x: 0, y: -2 }, { x: 0, y: 0 }, { x: 0, y: 2 }] }),
    ] });
    let violations;
    app.updateRatsnest = () => { violations = runDRC(app, { clearance: 0.5 }).violations; };
    app.updateRatsnest();
    assert.deepEqual(violations.map(v => v.rule), ['short']);
    const before = captureBoardShapeState(shape);
    const command = new ModifyBoardShapeCommand(app, shape, before, { ...before, copperMode: 'remove-copper' });
    command.execute();
    assert.deepEqual(violations, [], 'changing between removal modes immediately exposes the post-cut result');
    command.undo();
    assert.deepEqual(violations.map(v => v.rule), ['short'], 'Undo restores copper, and its short');
    command.execute();
    assert.deepEqual(violations, [], 'Redo removes the shorted copper again');
}

console.log('PASS all removal modes exclude artwork from contacts, guides and clearance; cuts resolve shorts; mode changes and Undo/Redo refresh immediately');
