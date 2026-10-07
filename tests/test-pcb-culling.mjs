import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setPcbSelection, syncPcbSelection } from '../src/pcb/modules/selection-registry.js';
import { updatePcbCulling } from '../src/pcb/modules/component-selection.js';

globalThis.window = { addEventListener() {} };

function fixture(count = 3) {
    let writes = 0, selectionReads = 0;
    const node = hidden => {
        const classes = new Set(hidden ? ['culled'] : []);
        return { classes, attributes: new Map(),
            classList: { toggle(name, enabled) {
                writes++;
                if (enabled) classes.add(name);
                else classes.delete(name);
            } },
            setAttribute(name, value) { writes++; this.attributes.set(name, value); },
        };
    };
    const app = {
        viewport: { scale: 1, getVisibleBounds: () => ({ minX: 0, minY: 0, maxX: 100, maxY: 100 }) },
        placements: new Map(Array.from({ length: count }, (_, index) => [`U${index}`, {
            x: (index % 32) * 2, y: Math.floor(index / 32) * 2, rotation: 0, refVisible: false,
            bounds: { x: 0, y: 0, width: 1, height: 1 }, elements: [node(false), node(false)],
            lodEl: node(true), _culled: false, _lodFar: false,
        }])),
    };
    syncPcbSelection(app);
    const getSelection = app._pcbSelection.getSelection.bind(app._pcbSelection);
    app._pcbSelection.getSelection = () => { selectionReads++; return getSelection(); };
    return {
        app, get writes() { return writes; },
        select(...ids) { setPcbSelection(app, ids.map(object => ({ kind: 'component', object }))); },
        cull() { selectionReads = 0; updatePcbCulling(app); return selectionReads; },
        expect(id, detail, placeholder) {
            const placement = app.placements.get(id);
            for (const element of placement.elements) assert.equal(!element.classes.has('culled'), detail, `${id} detail`);
            assert.equal(!placement.lodEl.classes.has('culled'), placeholder, `${id} placeholder`);
        },
    };
}

test('all selected footprints retain detail at low zoom, including after selection changes', () => {
    const view = fixture();
    view.select('U0', 'U2');
    view.cull();
    view.expect('U0', true, false);
    view.expect('U1', false, true);
    view.expect('U2', true, false);
    view.select('U1');
    view.cull();
    view.expect('U0', false, true);
    view.expect('U1', true, false);
    view.expect('U2', false, true);
});

test('dense-board culling does not materialize selection arrays per footprint', () => {
    const view = fixture(512);
    view.select(...Array.from({ length: 256 }, (_, index) => `U${index * 2}`));
    assert.equal(view.cull(), 0, 'Culling uses constant-time selection membership, not selection-list filtering');
});

test('the 24-pixel LOD threshold and unchanged-frame fast paths are preserved', () => {
    const view = fixture(1);
    for (const [scale, detail] of [[1, false], [23.99, false], [24, true], [25, true], [1, false]]) {
        view.app.viewport.scale = scale;
        view.cull();
        view.expect('U0', detail, !detail);
        const writes = view.writes;
        const bounds = view.app.placements.get('U0')._cullBounds;
        view.cull();
        assert.equal(view.writes, writes, 'An unchanged frame does not rewrite visibility or transforms');
        assert.equal(view.app.placements.get('U0')._cullBounds, bounds, 'Unchanged poses reuse world bounds');
    }
});

test('viewport overdraw margins and offscreen selected footprints still cull', () => {
    const view = fixture(1);
    const placement = view.app.placements.get('U0');
    for (const [x, inView] of [[150, true], [150.01, false], [-51, true], [-51.01, false]]) {
        placement.x = x;
        view.cull();
        view.expect('U0', false, inView);
    }
    view.select('U0');
    view.cull();
    view.expect('U0', false, false);
    placement.x = 0;
    view.cull();
    view.expect('U0', true, false);
});

test('empty and uninitialized views require no selection scans', () => {
    assert.equal(fixture(0).cull(), 0);
    const view = fixture();
    view.app.viewport = null;
    assert.equal(view.cull(), 0);
});
