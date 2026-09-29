import assert from 'node:assert/strict';
import { FileManager, readProjectFile } from '../src/core/FileManager.js';
import { validateProject } from '../src/core/project-format.js';
import { compactProjectAliases, normalizeProjectAliases } from '../src/core/project-field-aliases.js';

const longProject = {
    type: 'clearpcb-project',
    version: '1.0',
    schematic: {
        settings: {
            gridSize: 2.54, gridStyle: 'lines', units: 'mm', gridVisible: true, snapToGrid: true,
            paperSize: 'A4', paperOrientation: 'landscape', titleBlock: false,
            titleBlockInfo: false, titleBlockData: {},
        },
        shapes: [{
            id: 'label-1', type: 'text', color: '#fff', layer: 'schematic',
            lineWidth: 0.2, visible: true, locked: false, x: 1, y: 2,
            text: 'LABEL', fontSize: 2, fontFamily: 'sans-serif', textAnchor: 'start',
            rotation: 0, componentId: 'component-1', fieldKey: 'label',
            attachment: { dx: 1 }, border: true,
        }, {
            id: 'wire-1', type: 'wire',
            graphNodes: { n0: [0, 0], n1: [1, 0] }, graphEdges: { e0: ['n0', 'n1'] },
            pinConnections: { n0: { componentId: 'component-1', pinNumber: '1' } },
        }, {
            id: 'nc-1', type: 'noconnect', x: 0, y: 0,
            pinConnection: { componentId: 'component-1', pinNumber: '2' },
        }],
        components: [{
            type: 'component', id: 'component-1', definitionName: 'R', x: 0, y: 0,
            rotation: 0, mirror: false, reference: 'R1', value: '1k',
            showReference: true, showValue: true, properties: {}, visible: true, locked: false,
        }],
        defs: {
            R: {
                name: 'R', category: 'Passive', description: 'Resistor',
                symbol: {
                    width: 10, height: 5, origin: { x: 5, y: 2.5 },
                    graphics: [{
                        type: 'text', x: 5, y: 1, text: '${REF}', fontSize: 1.27,
                        anchor: 'middle', baseline: 'middle', strokeWidth: 0.254,
                    }],
                    pins: [{
                        _id: 'gge6', _key: 'gge6', _pathData: 'M 0 2.54 h 2.54',
                        number: '2', name: '3V3', x: 0, y: 2.54,
                        orientation: 'right', length: 2.54, type: 'passive',
                        namePos: {
                            x: 3.4798, y: 2.8448, rotation: 0, anchor: 'start',
                            fontFamily: null, fontSize: 1.778,
                        },
                    }],
                },
                defaultReference: 'R', defaultValue: '1k', defaultProperties: {},
                _source: 'Project', footprintName: 'R_0603',
                footprintBBox: { x: -1, y: -0.5, width: 2, height: 1 },
                model3dObj: 'o resistor\n', has3d: true,
            },
        },
    },
    pcb: {
        stackup: { copperLayers: ['top-copper', 'bottom-copper'] },
        board: { width: 100, height: 80, radius: 1 },
        design: {
            trackWidth: 0.2, clearance: 0.2, viaDiameter: 0.6, viaDrill: 0.3,
            units: 'mm', router: 'maze',
        },
        settings: { gridSize: 1, gridStyle: 'dots', units: 'mm', gridVisible: true, snapToGrid: true },
        panelization: {
            rows: 2, columns: 2, rowSpacing: 2, columnSpacing: 2, separation: 'tabs',
            railTop: 5, railBottom: 5, railLeft: 0, railRight: 0,
            verticalTabsPerEdge: 2, horizontalTabsPerEdge: 2,
            verticalTabOffset: 0, horizontalTabOffset: 0,
            verticalPositioningHoles: false, horizontalFiducials: false,
            horizontalPositioningHoles: false, verticalFiducials: false,
            tabWidth: 3, holeDiameter: 0.5, holePitch: 0.8,
        },
        tracks: [{
            type: 'track', id: 'track-1', color: '#fff', layer: 'top-copper',
            lineWidth: 0.2, visible: true, locked: false,
            graphNodes: { a: [0, 0], b: [10, 0] }, graphEdges: { e: ['a', 'b'] },
            closed: false, fill: false, fillAlpha: 0, cornerRadius: 0,
            nodeCornerRadii: {}, edgeBulges: {}, edgeLayers: {}, edgeWidths: {},
            net: 'GND', width: 0.2,
            padConnections: { a: { componentId: 'component-1', pinNumber: '1' } },
            sourceBoardShape: {
                id: 'source-shape', kind: 'line', layer: 'top-copper', lineWidth: 0.2,
                filled: false, copperMode: 'add', plated: false, net: '',
                points: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
            },
        }],
        vias: [{
            type: 'via', id: 'via-1', x: 5, y: 0, diameter: 0.6, drill: 0.3,
            net: 'GND', locked: false, visible: true,
            span: { from: 'top-copper', to: 'bottom-copper' },
        }],
        boardShapes: [
            {
                id: 'shape-1', kind: 'rect', layer: 'top-silk', lineWidth: 0.2,
                filled: false, copperMode: 'add', plated: false, net: '',
                segmentWidths: {}, segmentBulges: {}, nodeCornerRadii: {}, cornerRadius: 0,
                points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
            },
            {
                type: 'fill', id: 'fill-1', layer: 'top-copper',
                points: [[0, 0], [2, 0], [2, 2]], net: 'GND',
                locked: false, visible: true, kind: 'polygon',
                cornerRadius: 0, nodeCornerRadii: {}, segmentBulges: {},
            },
        ],
        texts: [{
            id: 'text-1', content: 'REV A', x: 2, y: 3, size: 1,
            rotation: 0, layer: 'top-silk', strokeWidth: 0.15, border: true,
        }],
        placements: {
            'component-1': {
                x: 10, y: 10, rotation: 90, locked: true, mirror: true, side: 'bottom',
                refVisible: false, refDx: 1, refDy: 2, refRot: 90, refSize: 1, refStrokeWidth: 0.15,
            },
        },
    },
};

const original = structuredClone(longProject);
const normalized = validateProject(longProject);
assert.deepEqual(longProject, original, 'alias normalization does not mutate input');
assert.equal(normalized.schematic.shapes[0].t, 'LABEL');
assert.equal(normalized.schematic.components[0].dn, 'R');
assert.equal(normalized.pcb.vias[0].d, 0.6);
assert.equal(normalized.pcb.texts[0].content, 'REV A');

const compact = compactProjectAliases(longProject);
assert.deepEqual(compact.pcb.stackup, { cl: ['top-copper', 'bottom-copper'] });
assert.deepEqual(compact.pcb.board, { w: 100, h: 80, r: 1 });
assert.deepEqual(compact.pcb.design, { tw: 0.2, cl: 0.2, vd: 0.6, dr: 0.3, u: 'mm', rt: 'maze' });
assert.equal(compact.pcb.boardShapes[0].k, 'rect');
assert.equal(compact.pcb.boardShapes[1].k, 'polygon');
assert.equal(compact.pcb.tracks[0].sbs.k, 'line');
assert.equal(compact.pcb.texts[0].bd, true);
assert.equal(compact.pcb.placements['component-1'].rot, 90);
assert.equal(compact.schematic.settings.gs, 2.54);
assert.equal(compact.schematic.shapes[0].bd, true);
assert.deepEqual(compact.schematic.shapes[1].pc.n0, { cid: 'component-1', pn: '1' });
assert.deepEqual(compact.schematic.shapes[2].pn, { cid: 'component-1', pn: '2' });
assert.equal(compact.schematic.components[0].dn, 'R');
assert.equal(compact.schematic.defs.R.n, 'R');
assert.equal(compact.schematic.defs.R.m3o, 'o resistor\n');
assert.deepEqual(compact.schematic.defs.R.sym.p[0], {
    i: 'gge6', k: 'gge6', pd: 'M 0 2.54 h 2.54',
    num: '2', n: '3V3', x: 0, y: 2.54, o: 'right', len: 2.54, t: 'passive',
    np: { x: 3.4798, y: 2.8448, rot: 0, a: 'start', ff: null, fs: 1.778 },
});
assert.deepEqual(compact.schematic.defs.R.sym.g[0], {
    k: 'text', x: 5, y: 1, tx: '${REF}', fs: 1.27,
    a: 'middle', bl: 'middle', sw: 0.254,
});
assert.deepEqual(compact.schematic.defs.R.fbb, { x: -1, y: -0.5, w: 2, h: 1 });
assert.deepEqual(compact.pcb.tracks[0].pdc.a, { cid: 'component-1', pn: '1' });
assert.deepEqual(compactProjectAliases(compact), compact, 'compaction is idempotent');
assert.deepEqual(normalizeProjectAliases(compact), normalized, 'compact and long forms normalize identically');

const equalAliases = structuredClone(longProject);
equalAliases.pcb.board.width = 100;
equalAliases.pcb.board.w = 100;
assert.equal(validateProject(equalAliases).pcb.board.width, 100);
const conflictingAliases = structuredClone(longProject);
conflictingAliases.pcb.board.w = 101;
assert.throws(() => validateProject(conflictingAliases), error =>
    /Conflicting fields "w" and "width"/.test(error.message)
    && /Location: pcb\.board/.test(error.message)
    && /Faulty snippet/.test(error.message));
const conflictingPinAliases = structuredClone(longProject);
conflictingPinAliases.schematic.defs.R.symbol.pins[0].i = 'different-id';
assert.throws(() => validateProject(conflictingPinAliases), error =>
    /Conflicting fields "i" and "_id"/.test(error.message)
    && /Location: schematic\.defs\.R\.symbol\.pins\[0\]\.i/.test(error.message));

const storage = new Map();
globalThis.localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key),
};
const manager = new FileManager();
manager.autoSaveToStorage(longProject, { revision: 1, fileName: 'aliases.cpcb' });
const autosave = JSON.parse(storage.get('clearpcb_autosave_aliases.cpcb'));
assert.deepEqual(autosave.data, compact, 'autosave stores canonical compact fields');

let written;
const result = await manager.saveToHandle(longProject, {
    name: 'aliases.cpcb',
    async createWritable() {
        return {
            async write(blob) { written = blob; },
            async close() {},
        };
    },
});
assert.equal(result.success, true);
const diskProject = await readProjectFile(written);
assert.deepEqual(diskProject, compact, 'file saves store canonical compact fields');

console.log('PASS: project aliases load in either form and all persistence is compact');
