import assert from 'node:assert/strict';
import { installFakeDom } from './helpers/fake-dom.mjs';

globalThis.window = { addEventListener() {} };
installFakeDom();
const { PCB_LAYERS, PCB_COPPER_FILLS, placementBlock, placementBlockMessage, refuseBlockedPlacement } =
    await import('../../src/pcb/modules/layers.js');
const { pcbToolBlock, pcbToolBlockNotice, syncPcbToolBlocks } = await import('../../src/pcb/modules/tool-lifecycle.js');
const { pcbToolTargets } = await import('../../src/pcb/modules/pcb-tools.js');
const { setTextToolDefaults, getTextToolDefaults } = await import('../../src/pcb/modules/text-properties.js');
const { setFillToolDefaults } = await import('../../src/pcb/modules/copper-fill-draw.js');
const { setTrackToolLayer } = await import('../../src/pcb/modules/track-draw.js');
const { getPadToolDefaults } = await import('../../src/pcb/modules/pad-tool.js');
const { pcbEditorFixture } = await import('./pcb-editor-fixture.mjs');

const layer = id => PCB_LAYERS.find(item => item.id === id);
const fill = id => PCB_COPPER_FILLS.find(item => item.id === id);
const saved = [...PCB_LAYERS, ...PCB_COPPER_FILLS].map(item => ({ item, locked: item.locked, visible: item.visible }));
const app = pcbEditorFixture({ activeLayer: 'top-silk' });
let ribbonRefreshes = 0;
app.refreshPcbRibbon = () => { ribbonRefreshes++; };

try {
    // Each tool names the rows it would draw on, from its own settings.
    assert.deepEqual(pcbToolTargets(app, 'via'), [{ id: 'vias' }]);
    assert.deepEqual(pcbToolTargets(app, 'pad'), [{ id: 'top-copper' }, { id: 'bottom-copper' }], 'a through pad spans both sides');
    getPadToolDefaults(app).layers = 'bottom-copper';
    assert.deepEqual(pcbToolTargets(app, 'pad'), [{ id: 'bottom-copper' }]);
    setTextToolDefaults(app, { ...getTextToolDefaults(app), layer: 'bottom-silk' });
    assert.deepEqual(pcbToolTargets(app, 'text'), [{ id: 'bottom-silk' }]);
    setTrackToolLayer(app, 'bottom-copper');
    assert.deepEqual(pcbToolTargets(app, 'track'), [{ id: 'bottom-copper' }]);
    setFillToolDefaults(app, { layer: 'bottom-copper' });
    assert.deepEqual(pcbToolTargets(app, 'fill'), [{ id: 'bottom-copper' }, { id: 'bottom-copper', fill: true }],
        'a pour needs its copper layer and that side\'s Copper Fill row');
    assert.deepEqual(pcbToolTargets(app, 'rect'), [{ id: 'top-silk' }]);
    assert.deepEqual(pcbToolTargets(app, 'hole'), [{ id: 'hole' }]);
    assert.deepEqual(pcbToolTargets(app, 'select'), [], 'tools that place nothing are never blocked');
    console.log('PASS each placement tool names the layers its settings draw on');

    // Locked is reported before hidden, and Copper Fill rows block pours.
    assert.equal(placementBlock([{ id: 'top-silk' }]), null);
    layer('top-silk').visible = false;
    assert.deepEqual(placementBlock([{ id: 'top-silk' }]), { id: 'top-silk', fill: false, reason: 'hidden' });
    assert.equal(placementBlockMessage(placementBlock([{ id: 'top-silk' }])), '“Top Silk” is hidden');
    layer('bottom-silk').locked = true;
    assert.deepEqual(placementBlock([{ id: 'top-silk' }, { id: 'bottom-silk' }]),
        { id: 'bottom-silk', fill: false, reason: 'locked' }, 'a lock is reported before a hidden layer');
    fill('bottom-copper').locked = true;
    assert.equal(placementBlockMessage(pcbToolBlock(app, 'fill')), '“Bottom Copper Fill” is locked');
    assert.equal(pcbToolBlock(app, 'track'), null, 'the copper layer itself is still open to tracks');
    assert.equal(refuseBlockedPlacement(app, [{ id: 'top-copper' }]), false);
    assert.equal(refuseBlockedPlacement(app, pcbToolTargets(app, 'fill')), true);
    console.log('PASS locked before hidden, and Copper Fill rows block new pours');

    // The Properties notice lifts the block it names.
    const notice = pcbToolBlockNotice(app, 'fill');
    assert.match(notice.warning, /“Bottom Copper Fill” is locked/);
    const action = notice.actions[0].actions[0];
    assert.equal(action.label, 'Unlock Bottom Copper Fill');
    action.run();
    assert.equal(fill('bottom-copper').locked, false);
    assert.deepEqual(pcbToolBlockNotice(app, 'fill'), { actions: [] });
    const show = pcbToolBlockNotice(app, 'rect').actions[0].actions[0];
    assert.equal(show.label, 'Show Top Silk');
    show.run();
    assert.equal(layer('top-silk').visible, true);
    console.log('PASS the Properties notice unlocks or shows the layer it names');

    // The ribbon refreshes only when which tools are blocked changes.
    ribbonRefreshes = 0;
    syncPcbToolBlocks(app);
    syncPcbToolBlocks(app);
    assert.equal(ribbonRefreshes <= 1, true);
    const settled = ribbonRefreshes;
    layer('vias').locked = true;
    syncPcbToolBlocks(app);
    syncPcbToolBlocks(app);
    assert.equal(ribbonRefreshes, settled + 1, 'one refresh for the Via lock, none when nothing changed');
    console.log('PASS ribbon tool badges refresh only when the blocked tools change');
} finally {
    for (const { item, locked, visible } of saved) Object.assign(item, { locked, visible });
}
