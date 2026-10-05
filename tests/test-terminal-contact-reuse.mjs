import assert from 'node:assert/strict';
import { PcbDocument } from '../src/core/PcbDocument.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { ModifyPadCommand } from '../src/core/pcb-pad-commands.js';
import { Track } from '../src/shapes/track.js';
import { Pad } from '../src/shapes/pad.js';
import { Via } from '../src/shapes/via.js';
import { CopperFill } from '../src/shapes/copper-fill.js';
import { padFlashOutline } from '../src/shared/pcb/board-geometry.js';
import { buildCopperClusters } from '../src/pcb/modules/copper-connectivity.js';
import { getComputedFill, setComputedFill } from '../src/pcb/modules/computed-fill-cache.js';
import {
    resolveTerminalCopperContact, resolveTrackContactGeometry, copperRegionShape, copperContactsTouch,
    prepareCopperRegionContact, installCopperRegionContact,
} from '../src/pcb/modules/track-contact-geometry.js';

class Element {
    constructor() { this.children = []; this.attributes = new Map(); this.style = {}; this.dataset = {}; }
    setAttribute(key, value) { this.attributes.set(key, String(value)); }
    getAttribute(key) { return this.attributes.get(key) ?? null; }
    removeAttribute(key) { this.attributes.delete(key); }
    appendChild(child) { child.remove(); this.children.push(child); child.parentNode = this; }
    insertBefore(child, sibling) {
        if (!sibling) return this.appendChild(child);
        child.remove(); this.children.splice(this.children.indexOf(sibling), 0, child); child.parentNode = this;
    }
    remove() {
        if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
        this.parentNode = null;
    }
    get firstChild() { return this.children[0] || null; }
    cloneNode() { const copy = new Element(); copy.attributes = new Map(this.attributes); return copy; }
    querySelectorAll(selector) {
        const attribute = /^\[([^=]+)="([^"]+)"\]$/.exec(selector);
        const matches = child => selector.startsWith('.')
            ? (child.getAttribute('class') || '').split(' ').includes(selector.slice(1))
            : attribute && child.getAttribute(attribute[1]) === attribute[2];
        return this.children.flatMap(child => [
            ...(matches(child) ? [child] : []), ...child.querySelectorAll(selector),
        ]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
globalThis.window = { addEventListener() {} };
globalThis.document = { createElementNS: () => new Element() };
const { reconcileRatsnest, collectBondedCopper } = await import('../src/pcb/modules/track-draw.js');
const { adoptFillResults } = await import('../src/pcb/modules/fill-refresh.js');

const rectangle = (x, y, width, height) => [
    { x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height },
];
function fixture(model = new PcbDocument()) {
    const groups = new Map(['ratlines', 'top-fill', 'bottom-fill'].map(id => [id, new Element()]));
    const app = { pcbDocument: model, placements: new Map(), netlist: [],
        getLayerGroup: id => groups.get(id),
        _clearFillGroups() {
            for (const id of ['top-fill', 'bottom-fill']) {
                const group = groups.get(id);
                while (group.firstChild) group.firstChild.remove();
            }
        },
        _board3d: { refresh() {} },
    };
    for (const key of ['tracks', 'vias', 'pads', 'boardShapes', 'copperFills']) {
        Object.defineProperty(app, key, { get: () => app.pcbDocument[key] });
    }
    return app;
}

// The prior annulus construction is an independent parity oracle, not the new helper.
function coldContact(cluster) {
    const terminal = cluster.pad || cluster.via;
    const outer = cluster.pad?.outline || padFlashOutline({
        x: terminal.x, y: terminal.y, w: cluster.viaRadius * 2, h: cluster.viaRadius * 2, shape: 'circle',
    }, 1e-4);
    const holes = [], slot = terminal.slot;
    if (terminal.drill > 0) holes.push(padFlashOutline({
        x: slot ? (slot.x1 + slot.x2) / 2 : terminal.x,
        y: slot ? (slot.y1 + slot.y2) / 2 : terminal.y,
        w: terminal.drill + (slot ? Math.hypot(slot.x2 - slot.x1, slot.y2 - slot.y1) : 0),
        h: terminal.drill, shape: slot ? 'oval' : 'circle',
        rad: slot ? Math.atan2(slot.y2 - slot.y1, slot.x2 - slot.x1) : 0,
    }, 1e-4));
    return resolveTrackContactGeometry(copperRegionShape({ outer, holes }));
}
function checkParity(cluster, entry) {
    const cold = coldContact(cluster);
    assert.deepEqual(entry.resolved.bounds, cold.bounds);
    assert.deepEqual(entry.shape.region, cold.region);
    const { minX, minY, maxX, maxY } = cold.bounds;
    for (let i = -1; i <= 5; i++) for (let j = -1; j <= 5; j++) {
        const x = minX + (maxX - minX) * i / 4, y = minY + (maxY - minY) * j / 4;
        for (const shape of [
            { kind: 'circle', x, y, radius: 0.02, filled: true, lineWidth: 0 },
            { kind: 'line', points: [{ x, y }, { x: x + 0.01, y: y + 0.04 }], lineWidth: 0.001 },
        ]) {
            const probe = resolveTrackContactGeometry(shape);
            assert.equal(copperContactsTouch(entry.resolved, probe), copperContactsTouch(cold, probe));
            assert.equal(copperContactsTouch(probe, entry.resolved), copperContactsTouch(probe, cold));
        }
    }
}
const terminal = app => buildCopperClusters(app).find(cluster => ['via', 'pad'].includes(cluster.kind));
const padFixture = () => {
    const app = fixture();
    app.pads.push(new Pad({ id: 'same-id', x: Math.PI, y: Math.E, shape: 'stadium',
        rotation: 37.123456789, size: 2.123456789, ratio: 1.7, drill: 0.5123456789, net: 'N' }));
    return app;
};
const viaFixture = () => {
    const app = fixture();
    app.vias.push(new Via({ id: 'same-id', x: Math.PI, y: Math.E,
        diameter: 1.123456789, drill: 0.3123456789, net: 'N' }));
    return app;
};
const placementFixture = () => {
    const app = fixture();
    app.placements.set('U1', { x: Math.PI, y: Math.E, rotation: 23.123456789, side: 'top',
        padOffsets: [{ padId: '1', number: '1', dx: 2.123456789, dy: -0.987654321,
            width: 3.123456789, height: 1.912345678, shape: 'oval',
            drill: 0.6123456789, slotLength: 1.912345678, slotAngle: 17.123456789 }] });
    app.netlist = [{ net: 'N', pins: [{ componentId: 'U1', pinNumber: '1' }] }];
    return app;
};
const legacyPlacementFixture = () => {
    const app = fixture();
    app.placements.set('U1', { pads: new Map([['1', { x: Math.PI, y: Math.E,
        width: 3.123456789, height: 2.123456789, shape: 'rect', drill: 0.5123456789 }]]) });
    return app;
};

let cases = 0;
for (const [make, edits] of [
    [padFixture, [
        app => { app.pads[0].x += 1e-9; }, app => { app.pads[0].y -= 1e-9; },
        app => { app.pads[0].rotation += 1e-9; }, app => { app.pads[0].size += 1e-9; },
        app => { app.pads[0].ratio += 1e-9; }, app => { app.pads[0].drill += 1e-9; },
        app => { app.pads[0].shape = 'oval'; },
        app => { app.pads[0] = new Pad({ ...app.pads[0].captureState(), x: 7.123456789 }); },
    ]],
    [viaFixture, [
        app => { app.vias[0].x += 1e-9; }, app => { app.vias[0].y -= 1e-9; },
        app => { app.vias[0].diameter += 1e-9; }, app => { app.vias[0].drill += 1e-9; },
        app => { app.vias[0].drill = 0; },
        app => { app.vias[0].slot = { x1: 2, y1: 2, x2: 3, y2: 2.3 }; },
    ]],
    [placementFixture, [
        app => { app.placements.get('U1').x += 1e-9; },
        app => { app.placements.get('U1').y += 1e-9; },
        app => { app.placements.get('U1').rotation += 1e-9; },
        app => { app.placements.get('U1').mirror = true; },
        app => { app.placements.get('U1').side = 'bottom'; },
        ...['dx', 'dy', 'width', 'height', 'drill', 'slotLength', 'slotAngle'].map(key =>
            app => { app.placements.get('U1').padOffsets[0][key] += 1e-9; }),
        app => { app.placements.get('U1').padOffsets[0].shape = 'rect'; },
        app => { app.placements.get('U1').padOffsets[0].slotLength = 0; },
    ]],
    [legacyPlacementFixture, ['x', 'y', 'width', 'height', 'drill'].map(key =>
        app => { app.placements.get('U1').pads.get('1')[key] += 1e-9; })],
]) for (const edit of edits) {
    const app = make(), first = terminal(app), entry = resolveTerminalCopperContact(first);
    const saved = structuredClone(entry.shape.region);
    assert.equal(resolveTerminalCopperContact(terminal(app), entry), entry);
    checkParity(first, entry);
    edit(app);
    const next = terminal(app), changed = resolveTerminalCopperContact(next, entry);
    assert.notEqual(changed, entry, 'Changed full-precision physical inputs invalidate the contact');
    assert.deepEqual(entry.shape.region, saved, 'Old contact owns its geometry independently of authored edits');
    checkParity(next, changed);
    assert.equal(resolveTerminalCopperContact(terminal(app), changed), changed);
    cases++;
}

{
    const app = placementFixture(), cluster = terminal(app), entry = resolveTerminalCopperContact(cluster);
    assert.notEqual(entry.shape.region.outer, cluster.pad.outline);
    cluster.pad.outline[0].x += 1e-9;
    assert.notEqual(resolveTerminalCopperContact(cluster, entry), entry, 'Direct posed-outline edits invalidate too');
    for (const key of ['x1', 'y1', 'x2', 'y2']) {
        const fresh = terminal(app), before = resolveTerminalCopperContact(fresh);
        fresh.pad.slot[key] += 1e-9;
        assert.notEqual(resolveTerminalCopperContact(fresh, before), before, `Slot ${key} invalidates`);
    }
}

{
    const app = padFixture(), pad = app.pads[0], history = new CommandHistory();
    const before = pad.captureState(), after = { ...before, x: 7.123456789, rotation: 63.987654321 };
    let entry = resolveTerminalCopperContact(terminal(app));
    const initial = structuredClone(entry.shape.region);
    history.execute(new ModifyPadCommand(pad, before, after));
    entry = resolveTerminalCopperContact(terminal(app), entry);
    const accepted = structuredClone(entry.shape.region);
    assert.notDeepEqual(accepted, initial);
    assert.equal(history.undo(), true);
    entry = resolveTerminalCopperContact(terminal(app), entry);
    assert.deepEqual(entry.shape.region, initial);
    assert.equal(history.redo(), true);
    entry = resolveTerminalCopperContact(terminal(app), entry);
    assert.deepEqual(entry.shape.region, accepted);
}

// Count actual ephemeral terminal snapshots and lazy triangulation inputs, not elapsed-time proxies.
{
    const cluster = terminal(placementFixture()), entry = resolveTerminalCopperContact(cluster);
    const clone = globalThis.structuredClone, flatMap = Array.prototype.flatMap;
    let snapshots = 0, triangulations = 0;
    const probe = resolveTrackContactGeometry({ kind: 'circle', x: cluster.pad.x, y: cluster.pad.y,
        radius: 0.01, lineWidth: 0, filled: true });
    try {
        globalThis.structuredClone = value => { snapshots++; return clone(value); };
        Array.prototype.flatMap = function (...args) {
            if (this[0] === entry.shape.region.outer[0]
                && this.length === entry.shape.region.outer.length + entry.shape.region.holes[0].length) triangulations++;
            return flatMap.apply(this, args);
        };
        for (let i = 0; i < 1000; i++) {
            assert.equal(resolveTerminalCopperContact(cluster, entry), entry);
            assert.equal(copperContactsTouch(entry.resolved, probe), false, 'Slotted bore remains empty');
        }
        assert.equal(snapshots, 0);
        assert.equal(triangulations, 1, 'The first contact query triangulates once; 999 warm queries reuse it');
    } finally { globalThis.structuredClone = clone; Array.prototype.flatMap = flatMap; }
}

function countSnapshots(run) {
    const clone = globalThis.structuredClone, sort = Array.prototype.sort;
    let snapshots = 0, vertices = 0, contactSorts = 0, sortedContacts = 0;
    try {
        globalThis.structuredClone = value => {
            if (value?.kind === 'polygon' && value.filled && value.lineWidth === 0) {
                snapshots++; vertices += value.points.length;
            }
            return clone(value);
        };
        Array.prototype.sort = function (...args) {
            if (this[0]?.item?.bounds && this[0].bounds) {
                contactSorts++; sortedContacts += this.length;
            }
            return sort.apply(this, args);
        };
        run();
    } finally { globalThis.structuredClone = clone; Array.prototype.sort = sort; }
    return { snapshots, vertices, contactSorts, sortedContacts };
}
{
    const app = padFixture();
    app.vias.push(...viaFixture().vias);
    const fill = new CopperFill({ net: 'N', outline: rectangle(0, 0, 10, 10) });
    const region = { outer: fill.outline, holes: [] };
    app.boardShapes.push(fill);
    setComputedFill(fill, [region]);
    installCopperRegionContact(region, prepareCopperRegionContact(region));
    const saved = app.pcbDocument.captureGeometry(), serialized = app.pcbDocument.serialize();
    for (const item of [...app.pads, ...app.vias]) Object.freeze(item);
    assert.equal(countSnapshots(() => reconcileRatsnest(app)).snapshots, 2);
    assert.equal(countSnapshots(() => reconcileRatsnest(app)).snapshots, 0);
    assert.equal(countSnapshots(() => {
        const bonded = collectBondedCopper(app, { via: app.vias[0] }, { includeShapes: true });
        assert.ok(bonded.shapes.has(fill));
        assert.ok(bonded.padKeys.has('null|same-id'));
    }).snapshots, 0, 'Bonded traversal reuses the preceding ratsnest terminal pass');
    assert.deepEqual(app.pcbDocument.captureGeometry(), saved);
    assert.deepEqual(app.pcbDocument.serialize(), serialized);
    assert.equal(getComputedFill(fill)[0], region);
    app.pads[0] = new Pad({ ...app.pads[0].captureState(), x: 30 });
    assert.equal(countSnapshots(() => reconcileRatsnest(app)).snapshots, 1);
    assert.equal(collectBondedCopper(app, { via: app.vias[0] }, { includeShapes: true }).padKeys.size, 0,
        'Same ID on a different object cannot retain the previous physical contact');
    const old = app.pcbDocument, replacement = new PcbDocument();
    replacement.pads.push(...old.pads); replacement.vias.push(...old.vias);
    app.pcbDocument = replacement;
    assert.equal(countSnapshots(() => reconcileRatsnest(app)).snapshots, 2, 'Document replacement drops the pass cache');
    const pad = app.pads[0], via = app.vias[0];
    replacement.clear();
    reconcileRatsnest(app);
    app.pads.push(pad); app.vias.push(via);
    assert.equal(countSnapshots(() => reconcileRatsnest(app)).snapshots, 2, 'Empty reconciliation releases old terminals');
    app.pads.splice(0, 1);
    reconcileRatsnest(app);
    app.pads.push(pad);
    assert.equal(countSnapshots(() => reconcileRatsnest(app)).snapshots, 1, 'Only the latest pass remains retained');
    replacement.clear();
    collectBondedCopper(app, {}, { includeShapes: true });
    app.pads.push(pad); app.vias.push(via);
    assert.equal(countSnapshots(() => reconcileRatsnest(app)).snapshots, 2, 'Empty bonded traversal also releases the cache');
}

{
    const app = padFixture(), pad = app.pads[0];
    pad.x = 0; pad.y = 0; pad.drill = 0; pad.layers = 'top-copper';
    const track = new Track({ points: [{ x: 0.5, y: 0 }, { x: 3, y: 0 }], net: 'N', layer: 'top-copper' });
    app.tracks.push(track);
    const bonded = () => collectBondedCopper(app, { track }, { includeShapes: true });
    assert.equal(bonded().padNetByKey.get('null|same-id'), 'N');
    pad.net = 'NEW';
    assert.equal(countSnapshots(() => assert.equal(bonded().padNetByKey.get('null|same-id'), 'NEW')).snapshots, 0,
        'Current net membership is independent of cached geometry');
    pad.layers = 'bottom-copper';
    assert.equal(countSnapshots(() => assert.equal(bonded().padKeys.size, 0)).snapshots, 0,
        'Current layer membership is independent of cached geometry');
    app.pads.push(new Pad({ ...pad.captureState(), layers: 'top-copper', x: 50, net: 'DISTANT' }));
    assert.equal(bonded().padKeys.size, 0, 'Distinct simultaneous objects with the same ID never alias different geometry');
    const shape = { kind: 'circle', x: 0, y: 0, radius: 1, filled: true };
    const first = resolveTrackContactGeometry(shape);
    shape.radius = 2;
    assert.notEqual(resolveTrackContactGeometry(shape), first, 'Authored shape validation remains unchanged');
}

{
    const app = placementFixture(), offset = app.placements.get('U1').padOffsets[0];
    offset.drill = 0;
    offset.layer = 'top';
    const cluster = terminal(app), entry = resolveTerminalCopperContact(cluster);
    const track = new Track({ net: 'N', points: [
        { x: cluster.pad.x + 0.05, y: cluster.pad.y }, { x: cluster.pad.x + 0.1, y: cluster.pad.y },
    ] });
    app.tracks.push(track);
    const bonded = () => collectBondedCopper(app, { track }, { includeShapes: true });
    assert.equal(bonded().padNetByKey.get('U1|1'), 'N');
    app.netlist[0].net = 'CHANGED';
    assert.equal(countSnapshots(() => assert.equal(bonded().padNetByKey.get('U1|1'), 'CHANGED')).snapshots, 0);
    offset.layer = 'bottom';
    assert.equal(countSnapshots(() => assert.equal(bonded().padKeys.size, 0)).snapshots, 0);
    assert.equal(resolveTerminalCopperContact(terminal(app), entry), entry,
        'Placed-pad net/layer updates do not require new physical geometry');
}

// Headless SVG, actual adoption/connectivity, unchanged prepared pour inputs; only terminal cache warmth differs.
{
    const model = new PcbDocument(), warm = fixture(model);
    const fill = new CopperFill({ net: 'N', outline: rectangle(-2, -2, 46, 45) });
    model.boardShapes.push(fill);
    for (let row = 0; row < 10; row++) for (let col = 0; col < 10; col++) {
        const x = col * 4, y = row * 4;
        model.vias.push(new Via({ x, y, diameter: 1.123456789, drill: 0.4123456789, net: 'N' }));
        model.pads.push(new Pad({ x: x + 1.2, y: y + 1.2, shape: col % 2 ? 'round' : 'stadium',
            size: 1.123456789, ratio: 1.7, drill: 0.4123456789, rotation: 37.123456789, net: 'N' }));
        model.tracks.push(new Track({ net: 'N', width: 0.1,
            points: Array.from({ length: 40 }, (_, index) => ({ x: index * 1.05, y: y + col * 0.2 + 0.1 })) }));
    }
    const ring = (radius, count, x, y) => Array.from({ length: count }, (_, index) => ({
        x: x + radius * Math.cos(index * Math.PI * 2 / count),
        y: y + radius * Math.sin(index * Math.PI * 2 / count),
    }));
    const region = { outer: fill.outline, holes: Array.from({ length: 16 }, (_, index) =>
        ring(0.25, 64, index % 4 * 8 + 3, Math.floor(index / 4) * 8 + 3)) };
    const packet = prepareCopperRegionContact(region);
    const saved = model.captureGeometry(), serialized = model.serialize();
    const times = { cold: [], warm: [] }, allocations = {};
    for (let trial = 0; trial < 7; trial++) {
        for (const mode of trial % 2 ? ['warm', 'cold'] : ['cold', 'warm']) {
            const app = mode === 'warm' ? warm : fixture(model);
            const payload = structuredClone(packet);
            let elapsed;
            const counts = countSnapshots(() => {
                const start = performance.now();
                adoptFillResults(app, [fill], [[payload.region]], [[payload]]);
                elapsed = performance.now() - start;
            });
            if (trial) times[mode].push(elapsed);
            allocations[mode] = counts;
        }
    }
    assert.equal(allocations.cold.snapshots, 200);
    assert.equal(allocations.warm.snapshots, 0);
    assert.deepEqual(model.captureGeometry(), saved);
    assert.deepEqual(model.serialize(), serialized);
    const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    console.log('BENCH terminal contact reuse (headless SVG, real warm adoption):', JSON.stringify({
        tracks: 100, nodes: 4000, pads: 100, vias: 100, holes: 16,
        coldAdoptionMedianMs: median(times.cold), warmAdoptionMedianMs: median(times.warm),
        coldSnapshots: allocations.cold.snapshots, warmSnapshots: allocations.warm.snapshots,
        coldSnapshotVertices: allocations.cold.vertices, warmSnapshotVertices: allocations.warm.vertices,
        coldContactSorts: allocations.cold.contactSorts, warmContactSorts: allocations.warm.contactSorts,
        coldSortedContacts: allocations.cold.sortedContacts, warmSortedContacts: allocations.warm.sortedContacts,
    }));
}
console.log(`PASS terminal contact reuse: ${cases} physical-edit cases, exact parity, history, ownership, lifetime and work counts`);
