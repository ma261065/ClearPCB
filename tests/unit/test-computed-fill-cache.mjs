import assert from 'node:assert/strict';
import { CopperFill } from '../../src/shapes/copper-fill.js';
import { PcbDocument } from '../../src/core/PcbDocument.js';
import { getComputedFill, setComputedFill } from '../../src/pcb/modules/computed-fill-cache.js';
import { recomputeFillsNow } from '../../src/pcb/modules/fill-refresh.js';
import { loadClipper } from '../../src/pcb/modules/copper-fill-geom.js';
import { runDRC } from '../../src/pcb/modules/drc.js';
import { collectCopperArtwork } from '../../src/pcb/modules/copper-artwork.js';
import { prepareFabricationSnapshot } from '../../src/pcb/modules/fabrication-snapshot.js';
import { fillRefreshError, isFillRefreshPending, setBoardViewPanel, setDragOverlaysDeferred, setFillRefreshPending, setFillRefreshSuspended } from '../../src/pcb/modules/refresh-state.js';
import { getDrcPresentation } from '../../src/pcb/modules/drc-state.js';
import { installFakeDom } from './helpers/fake-dom.mjs';

installFakeDom();
const { Board2D } = await import('../../src/pcb/modules/board2d.js');
const { buildFillMesh } = await import('../../src/pcb/modules/board3d-layers.js');
await loadClipper();

const rectangle = (a, b) => [{ x: a, y: -a }, { x: b, y: -a }, { x: b, y: -b }, { x: a, y: -b }];
const fill = new CopperFill({ id: 'fill_1', net: 'GND', outline: rectangle(1.123456, 9) });
const model = new PcbDocument();
model.boardShapes.push(fill);
const before = model.serialize();
for (const point of fill.outline) Object.freeze(point);
Object.freeze(fill.outline);
Object.freeze(fill);
let checks = 0, previews = 0;
const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
globalThis.requestAnimationFrame = () => { checks++; return checks; };
const app = { placements: new Map(), tracks: [], vias: [], pads: [], texts: new Map(), netlist: [],
    boardShapes: model.boardShapes, copperFills: [fill], board: { width: 10, height: 10, radius: 0 },
    pcbDocument: model,
    getRoutingParams: () => ({ clearance: 0.2 }), getLayerGroup: () => null,
    existingLayerGroups() { return this._layerGroups; },
    _layerGroups: new Map() };
setBoardViewPanel(app, { refresh() { previews++; } });
getDrcPresentation(app).shouldRun = () => true;
assert.equal(getComputedFill(fill), null);
assert.equal('_computed' in fill, false, 'Authored fill entities have no derived result field');
assert.ok(runDRC(app).violations.some(item => item.rule === 'fill'));
assert.equal(recomputeFillsNow(app), true);
const result = getComputedFill(fill);
assert.ok(result.length);
assert.equal(checks, 1);
assert.equal(previews, 1);
assert.equal(runDRC(app).ok, true);
assert.equal(collectCopperArtwork(app).areas.length, result.length);
assert.deepEqual(model.serialize(), before, 'Recomputation leaves authored model data unchanged');
assert.equal(fill.outline[0].x, 1.123456, 'Recomputation does not round live geometry');

const suspensionSetters = { _deferDragOverlays: setDragOverlaysDeferred, _suspendFillRefresh: setFillRefreshSuspended };
for (const flag of ['_deferDragOverlays', '_suspendFillRefresh']) {
    suspensionSetters[flag](app, true);
    assert.equal(recomputeFillsNow(app), undefined);
    assert.equal(getComputedFill(fill), result, 'Deferred edits retain the prior result until refresh');
    suspensionSetters[flag](app, false);
}
assert.equal(checks, 1);
assert.equal(previews, 1);
// Subsequent consumer tests install settled snapshots directly, outside the refresh service.
setFillRefreshPending(app, false);
const replacement = CopperFill.fromJSON(fill.toJSON());
assert.equal(replacement.id, fill.id);
assert.equal(getComputedFill(replacement), null, 'Loaded replacements cannot inherit a same-ID cache');
assert.equal(getComputedFill(fill.clone()), null, 'Cloning copies authored data only');
const other = Object.freeze(new CopperFill({ id: fill.id, outline: rectangle(2, 8) }));
setComputedFill(other, []);
assert.deepEqual(getComputedFill(other), []);
assert.equal(getComputedFill(fill), result, 'Separate models with equal IDs retain independent results');

const regions = [{ outer: rectangle(1, 9), holes: [rectangle(4, 6)] }];
setComputedFill(fill, regions);
const mesh = buildFillMesh([fill]);
const area = mesh.faces.reduce((sum, { idx }) => {
    const [a, b, c] = idx.map(index => mesh.verts[index]);
    return sum + Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x)) / 2;
}, 0);
assert.ok(Math.abs(area - 60) < 1e-9, '3D consumes the current cached islands with holes');
const bottom = Object.freeze(new CopperFill({ layer: 'bottom-copper', outline: rectangle(1, 9) }));
setComputedFill(bottom, regions);
assert.ok(buildFillMesh([bottom]).verts[0].y < mesh.verts[0].y, 'Bottom pours remain on the bottom plane');
const paths = [];
let path;
const copperContext = { setTransform() {}, save() {}, restore() {},
    beginPath() { path = []; }, moveTo(x, y) { path.push(['M', x, y]); },
    lineTo(x, y) { path.push(['L', x, y]); }, closePath() { path.push(['Z']); },
    fill(rule) { paths.push({ path, rule }); } };
const context = { canvas: { width: 100, height: 100, ownerDocument: {
    createElement: () => ({ getContext: () => copperContext }),
} }, getTransform() { return {}; }, setTransform() {}, save() {}, restore() {}, drawImage() {} };
const preview = { side: 'top', data: { fills: [fill, bottom] } };
Board2D.prototype._drawCopper.call(preview, context);
assert.equal(paths.length, 1, 'Flat preview uses only the selected copper side');
assert.equal(paths[0].rule, 'evenodd');
assert.equal(paths[0].path.filter(item => item[0] === 'M').length, 2, 'Flat preview retains the pour hole');
setComputedFill(fill, []);
assert.equal(runDRC(app).ok, true, 'Computed empty is not pending');
assert.equal(collectCopperArtwork(app).areas.length, 0);
assert.equal(buildFillMesh([fill]).faces.length, 0);
paths.length = 0;
Board2D.prototype._drawCopper.call(preview, context);
assert.equal(paths.length, 0, 'Flat preview follows cache replacement without stale copper');
setComputedFill(fill, null);
assert.ok(runDRC(app).violations.some(item => item.rule === 'fill'), 'Invalidated results are explicitly pending');
setComputedFill(fill, regions);
const snapshot = await prepareFabricationSnapshot(app);
assert.ok(snapshot.fills[0]._computed.length, 'Detached export results retain their transfer representation');
assert.notDeepEqual(snapshot.fills[0]._computed, regions, 'Export computes from authored geometry, not stale preview');
assert.equal(getComputedFill(fill), regions, 'Export never replaces live preview results');
assert.deepEqual(model.serialize(), before);

const broken = new CopperFill({ id: 'broken', outline: rectangle(1, 9) });
broken.getOutline = () => { throw new Error('Invalid test geometry'); };
setComputedFill(broken, regions);
app.copperFills = [broken];
app.boardShapes = [broken];
const errors = [];
const logError = console.error;
try {
    console.error = (...args) => errors.push(args);
    recomputeFillsNow(app);
} finally {
    console.error = logError;
}
assert.equal(getComputedFill(broken), regions, 'A failed batch retains settled artwork instead of publishing partial geometry');
assert.equal(isFillRefreshPending(app), true, 'Retained artwork is explicitly awaiting a successful refresh');
assert.match(fillRefreshError(app).message, /Invalid test geometry/);
assert.ok(runDRC(app).violations.some(item => item.rule === 'fill' && /refresh failed/.test(item.message)),
    'Retained successful geometry cannot hide the failed refresh from DRC');
assert.equal(errors.length, 1);
assert.match(errors[0][0], /retaining settled pours/);
assert.match(errors[0][1].message, /Invalid test geometry/);
if (originalRequestAnimationFrame) globalThis.requestAnimationFrame = originalRequestAnimationFrame;
else delete globalThis.requestAnimationFrame;
console.log('PASS external fill results, frozen model, identity, preview/DRC consumers and export isolation');
