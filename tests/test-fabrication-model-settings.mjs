import assert from 'node:assert/strict';
import { PcbDocument } from '../src/core/PcbDocument.js';
import { CopperFill } from '../src/shapes/copper-fill.js';

globalThis.window = { addEventListener() {} };
const { prepareFabricationSnapshot, prepareSnapshotFills } = await import('../src/pcb/modules/fabrication-snapshot.js');
const { exportGerbers } = await import('../src/pcb/modules/gerber.js');
const routing = { trackWidth: 0.23456789, clearance: 0.12345678, viaDiameter: 0.65432198, viaDrill: 0.32109876 };
const dimensions = { width: 23.45678901, height: 17.23456789, radius: 0.45678901 };
function fixture(panel = false, explicitOutline = false) {
    const model = new PcbDocument();
    model.designSettings.update(routing);
    Object.assign(model.board, dimensions);
    if (panel) model.loadPanelization({ rows: 2, columns: 3, rowSpacing: 2.12345678, columnSpacing: 2.34567891 });
    if (explicitOutline) {
        model.setBoardOutline({ id: 'outline', kind: 'rect', layer: 'board-outline', lineWidth: 0.2,
            points: [{ x: 5.12345678, y: -19.34567891 }, { x: 28.58024579, y: -19.34567891 },
                { x: 28.58024579, y: -2.11111102 }, { x: 5.12345678, y: -2.11111102 }],
            cornerRadius: dimensions.radius });
    }
    const fill = new CopperFill({ net: 'GND',
        outline: [{ x: 1, y: -1 }, { x: 35, y: -1 }, { x: 35, y: -25 }, { x: 1, y: -25 }] });
    model.boardShapes.push(fill);
    const app = {
        pcbDocument: model, placements: new Map(), tracks: model.tracks, vias: model.vias,
        pads: model.pads, texts: model.texts, boardShapes: model.boardShapes, copperFills: [fill], netlist: [],
    };
    for (const field of ['getRoutingParams', '_boardWidth', '_boardHeight', '_boardRadius', 'panelization']) {
        Object.defineProperty(app, field, { get() { throw new Error(`Editor projection read: ${field}`); } });
    }
    return { app, model };
}
for (const panel of [false, true]) for (const explicitOutline of [false, true]) {
    const { app, model } = fixture(panel, explicitOutline);
    const beforeBoard = { ...model.board }, beforePanel = model.serializePanelization();
    const legacy = {
        placements: app.placements, tracks: app.tracks, vias: app.vias, pads: app.pads, texts: app.texts,
        boardShapes: app.boardShapes, copperFills: app.copperFills, netlist: [],
        getRoutingParams: () => ({ ...routing }), panelization: beforePanel,
        _boardWidth: beforeBoard.width, _boardHeight: beforeBoard.height, _boardRadius: beforeBoard.radius,
    };
    const pending = prepareFabricationSnapshot(app, { computeFills: false });
    model.designSettings.update({ clearance: 0.9 });
    model.board.width = 99;
    if (model.panelization) model.panelization.rows = 4;
    const snapshot = await pending;
    assert.deepEqual(snapshot.params, routing, 'Routing settings come from the canonical model before asynchronous work');
    assert.equal(snapshot.boardWidth, beforeBoard.width);
    assert.equal(snapshot.boardHeight, beforeBoard.height);
    assert.equal(snapshot.boardRadius, beforeBoard.radius);
    assert.deepEqual(snapshot.panelization, beforePanel, 'Panel settings are detached from the model');
    const equivalent = await prepareFabricationSnapshot(legacy, { computeFills: false });
    assert.deepEqual(snapshot, equivalent, 'Canonical capture preserves the existing correctly-projected snapshot shape');
    await prepareSnapshotFills(snapshot);
    await prepareSnapshotFills(equivalent);
    assert.deepEqual(snapshot.fills, equivalent.fills, 'Pour clipping and clearance geometry are unchanged');
    if (panel && !explicitOutline) {
        for (const data of [snapshot, equivalent]) {
            assert.throws(() => exportGerbers(data), /Panelization requires a valid closed board outline/,
                'Panel exports still require an explicit outline');
        }
    } else {
        assert.deepEqual(exportGerbers(snapshot), exportGerbers(equivalent),
            'Explicit/legacy outlines and panel exports retain identical Gerber output');
    }
    snapshot.params.clearance = 0.8;
    snapshot.boardWidth = 101;
    if (snapshot.panelization) snapshot.panelization.rows = 5;
    assert.equal(model.designSettings.getRoutingParams().clearance, 0.9);
    assert.equal(model.board.width, 99);
    if (model.panelization) assert.equal(model.panelization.rows, 4);
}
{
    const { app, model } = fixture();
    model.designSettings.getRoutingParams = () => { throw new Error('Invalid model design'); };
    await assert.rejects(prepareFabricationSnapshot(app), /Invalid model design/,
        'An invalid model must not fall back to editor data');
}
console.log('PASS model-owned fabrication settings, dimensions and panels with precision, isolation and unchanged output');
