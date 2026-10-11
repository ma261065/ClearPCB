import assert from 'node:assert/strict';
import { installFakeDom } from './helpers/fake-dom.mjs';

globalThis.window = { addEventListener() {} };
installFakeDom();
const { PCB_LAYERS, PCB_COPPER_FILLS, pcbLayerOption, refreshPcbLayerOptions, placementBlock, placementBlockMessage, refuseBlockedPlacement } =
    await import('../../src/pcb/modules/layers.js');
const { pcbToolBlock, pcbToolBlockNotice, syncPcbToolBlocks } = await import('../../src/pcb/modules/tool-lifecycle.js');
const { pcbToolTargets, pcbToolAllLayersLocked, pcbToolLayers, pcbToolLayerLocks, preparePcbToolLayer } = await import('../../src/pcb/modules/pcb-tools.js');
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
    const select = document.body.appendChild(document.createElement('select'));
    const option = document.createElement('option');
    option.value = 'bottom-document';
    const description = pcbLayerOption(option.value, 'Bottom Document', { visibleOnly: true });
    Object.assign(option.dataset, description.dataset);
    select.appendChild(option);
    const destination = layer(option.value);
    destination.visible = false;
    destination.locked = true;
    refreshPcbLayerOptions(option.value);
    assert.equal(option.disabled, true);
    assert.match(option.textContent, /🔒/);
    destination.locked = false;
    refreshPcbLayerOptions(option.value);
    assert.equal(option.disabled, true, 'Hidden image layer stays disabled after unlocking');
    assert.equal(option.textContent, 'Bottom Document', 'Hidden-only layers have no lock marker');
    destination.visible = true;
    refreshPcbLayerOptions(option.value);
    assert.equal(option.disabled, false, 'Showing an unlocked image layer restores its option');
    select.remove();

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

    // Blocked tool defaults keep a warning but no unlock/show section.
    const notice = pcbToolBlockNotice(app, 'fill');
    assert.match(notice.warning, /“Bottom Copper Fill” is locked/);
    assert.deepEqual(notice.actions, []);
    assert.equal(fill('bottom-copper').locked, true, 'Properties never unlocks the layer automatically');
    assert.deepEqual(pcbToolBlockNotice(app, 'rect').actions, []);

    for (const item of [...PCB_LAYERS, ...PCB_COPPER_FILLS]) { item.locked = false; item.visible = true; }
    for (const tool of ['line', 'circle', 'arc', 'rect', 'polygon', 'text', 'track', 'fill', 'pad']) {
        const layers = pcbToolLayers(tool).filter(id => id !== 'both');
        app.activeLayer = layers.at(-1);
        preparePcbToolLayer(app, tool);
        assert.equal(pcbToolTargets(app, tool)[0].id, app.activeLayer, `${tool}: active layer is the default`);
        layer(app.activeLayer).locked = true;
        assert.equal(pcbToolAllLayersLocked(app, tool), false, `${tool}: other supported layers keep Home enabled`);
        preparePcbToolLayer(app, tool);
        assert.equal(pcbToolTargets(app, tool)[0].id, layers[0], `${tool}: locked active layer falls back in dropdown order`);
        for (const id of layers) layer(id).locked = true;
        assert.equal(pcbToolAllLayersLocked(app, tool), true, `${tool}: all locked layers disable Home`);
        for (const id of layers) { layer(id).locked = false; layer(id).visible = false; }
        assert.equal(pcbToolAllLayersLocked(app, tool), false, `${tool}: visibility does not disable Home`);
        for (const id of layers) layer(id).visible = true;
    }
    app.activeLayer = 'top-copper';
    fill('top-copper').locked = true;
    assert.equal(pcbToolAllLayersLocked(app, 'fill'), false);
    preparePcbToolLayer(app, 'fill');
    assert.equal(pcbToolTargets(app, 'fill')[0].id, 'bottom-copper', 'Pour row lock also drives fallback');
    fill('bottom-copper').locked = true;
    assert.equal(pcbToolAllLayersLocked(app, 'fill'), true);
    assert.deepEqual(pcbToolLayerLocks('fill'), [
        { id: 'top-copper', fill: true, reason: 'locked' },
        { id: 'bottom-copper', fill: true, reason: 'locked' },
    ], 'Popup lists the actual blocking pour rows, not unlocked copper layers');
    fill('top-copper').locked = fill('bottom-copper').locked = false;
    layer('top-copper').locked = layer('bottom-copper').locked = true;
    assert.deepEqual(pcbToolLayerLocks('pad'), [
        { id: 'top-copper', reason: 'locked' }, { id: 'bottom-copper', reason: 'locked' },
    ], 'Both-side pad choices do not repeat the same layer locks');
    layer('top-copper').locked = layer('bottom-copper').locked = false;
    layer('hole').locked = true;
    assert.equal(pcbToolAllLayersLocked(app, 'hole'), true, 'Hole preset stays restricted to its own layer');
    assert.equal(pcbToolAllLayersLocked(app, 'circle'), false, 'Circle may still appear on other layers');
    layer('hole').locked = false;
    preparePcbToolLayer(app, 'hole');
    assert.equal(app.activeLayer, 'hole');
    console.log('PASS Home availability, active/default fallback, compound pad/pour locks and no unlock section');

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
    console.log('PASS ribbon drawing availability refreshes only when the blocked tools change');
} finally {
    for (const { item, locked, visible } of saved) Object.assign(item, { locked, visible });
}
