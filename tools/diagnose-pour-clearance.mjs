import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from '../assets/vendor/fflate.module.js';

globalThis.window = { addEventListener() {} };
globalThis.document = { createElementNS: () => ({ setAttribute() {}, appendChild() {} }) };
const { createShape } = await import('../src/shapes/index.js');
const { Via } = await import('../src/shapes/via.js');
const { generateFootprint } = await import('../src/pcb/modules/footprint.js');
const { extractNetlist } = await import('../src/pcb/modules/netlist.js');
const { loadBoardShapes } = await import('../src/pcb/modules/board-shapes.js');
const { buildFillContext } = await import('../src/pcb/modules/fill-context.js');
const { computeFillPolygons, loadClipper } = await import('../src/pcb/modules/copper-fill-geom.js');
const { runDRC } = await import('../src/pcb/modules/drc.js');

const entries = unzipSync(readFileSync(process.argv[2]));
const schematic = JSON.parse(strFromU8(entries['schematic.json']));
const pcb = JSON.parse(strFromU8(entries['pcb.json']));
const components = schematic.components.map((item) => {
    const definition = item.def || schematic.defs[item.dn || item.definitionName];
    return { id: item.id, reference: item.ref || item.reference, definition, symbol: definition.symbol };
});
const app = {
    placements: new Map(), boardShapes: [], _shapeIdCounter: 1,
    tracks: (pcb.tracks || []).map(createShape), vias: (pcb.vias || []).map((item) => Via.fromJSON(item)),
    texts: new Map((pcb.texts || []).map((item) => [item.id, item])),
    netlist: extractNetlist({ components, shapes: (schematic.shapes || []).map(createShape) }),
    _boardWidth: pcb.board.width, _boardHeight: pcb.board.height, _boardRadius: pcb.board.radius,
    _getRoutingParams: () => pcb.design,
    get copperFills() { return this.boardShapes.filter((shape) => shape.type === 'fill'); },
};
for (const component of components) {
    const definition = component.definition;
    const footprint = generateFootprint('', [], definition.footprintShapes, definition.footprintBBox, definition._source);
    const counts = new Map();
    const padOffsets = footprint.pads.map((pad) => {
        const number = String(pad.number);
        const count = (counts.get(number) || 0) + 1;
        counts.set(number, count);
        return { ...pad, number, padId: count === 1 ? number : `${number}#${count}`, dx: pad.x, dy: pad.y };
    });
    app.placements.set(component.id, { ...pcb.placements[component.id], reference: component.reference,
        padOffsets, silks: footprint.silks });
}
loadBoardShapes(app, pcb.boardShapes, { render: false, strict: true });
const clipper = await loadClipper();
for (const isolated of [false, true]) {
    if (isolated) {
        app.boardShapes = app.copperFills;
        app.tracks = [];
        app.vias = [];
        app.texts.clear();
    }
    const context = buildFillContext(app);
    for (const fill of app.copperFills) fill._computed = computeFillPolygons(fill, context, clipper);
    const result = runDRC(app, { clearance: pcb.design.clearance });
    const padPour = result.violations.filter((item) => item.id.includes('pad:') && item.id.includes('fill:'));
    console.log(JSON.stringify({ isolated, clearance: pcb.design.clearance, pads: context.pads.length,
        totalViolations: result.violations.length, padPourCount: padPour.length,
        examples: padPour.slice(0, 12),
        otherViolations: result.violations.filter((item) => !padPour.includes(item))
            .map((item) => ({ id: item.id, message: item.message })),
        polygons: app.copperFills.map((fill) => fill._computed.map((polygon) => ({ vertices: polygon.outer.length, holes: polygon.holes.length }))),
    }, null, 2));
}