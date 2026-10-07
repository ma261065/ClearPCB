import assert from 'node:assert/strict';
import { installFakeDom } from './helpers/fake-dom.mjs';

installFakeDom();

const { default: PCBApp } = await import('../src/ui/PCBApp.js');
const { PcbDocument } = await import('../src/core/PcbDocument.js');
const { setPcbSelection } = await import('../src/pcb/modules/selection-registry.js');
const { PCB_LAYERS, isViaVisible, isViaLocked, notifyLayerLockChanged } = await import('../src/pcb/modules/layers.js');
const { resolveShapeDrawLayer } =
    await import('../src/pcb/modules/board-shapes.js');
const { showBoardShapeToolProperties, showBoardShapeProperties } = await import('../src/pcb/modules/board-shape-properties.js');
const { syncPcbSelection } = await import('../src/pcb/modules/selection-registry.js');

const panel = document.createElement('div');
panel.id = 'pcbPropertiesPanel';
const items = document.createElement('div');
items.id = 'pcbPropsItems';
panel.appendChild(items);
document.body.appendChild(panel);
const fire = (control, type, extra = {}) => control.dispatchEvent({ type, ...extra });
const app = Object.create(PCBApp.prototype);
const layerGroups = new Map();
app.pcbDocument = new PcbDocument();
Object.assign(app, {
    activeLayer: 'top-silk',
    boardShapes: [], placements: new Map(), tracks: [], vias: [], pads: [], texts: new Map(),
    viewport: { scale: 1 },
    _layerGroups: layerGroups,
    getLayerGroup(id) {
        if (!layerGroups.has(id)) layerGroups.set(id, document.createElementNS('http://www.w3.org/2000/svg', 'g'));
        return layerGroups.get(id);
    },
    propertiesItems: () => items,
    setPropertiesTitle() {},
    setActiveRibbonTab() {},
    setPcbStatus() {},
    syncClipboardButtons() {},
});
syncPcbSelection(app);

function selectableLayers(id) {
    const select = items.innerHTML.match(new RegExp(`<select id="${id}"[^>]*>([\\s\\S]*?)</select>`));
    if (select) {
        return [...select[1].matchAll(/<option value="([^"]*)"([^>]*)>/g)]
            .filter(([, , attributes]) => !/\b(hidden|disabled)\b/.test(attributes))
            .map(([, value]) => value);
    }
    const control = document.getElementById(id);
    assert.ok(control, `${id} is rendered`);
    return control.children
        .filter(option => option.tagName === 'option' && option.textContent && !option.hidden && !option.disabled)
        .map(option => option.value);
}

const expectedShapeLayers = [
    'top-copper', 'bottom-copper', 'top-silk', 'bottom-silk',
    'top-document', 'bottom-document', 'hole',
];
const points = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 8 }, { x: 0, y: 8 }];
for (const kind of ['line', 'circle', 'rect', 'polygon', 'arc']) {
    showBoardShapeToolProperties(app, kind);
    assert.deepEqual(selectableLayers('pcbToolShapeLayer'), expectedShapeLayers,
        `${kind}: creation offers only the existing valid shape layers`);
    const shape = {
        id: kind, kind, layer: 'top-silk', lineWidth: 0.2, points,
        x: 5, y: 4, radius: 3, start: points[0], end: points[1], bulge: { x: 5, y: 3 },
    };
    const second = { ...shape, id: `${kind}-second`, layer: 'bottom-silk' };
    app.boardShapes = [shape, second];
    for (const selection of [[shape], [shape, second]]) {
        setPcbSelection(app, selection.map(object => ({ kind: 'shape', object })));
        showBoardShapeProperties(app, shape);
        assert.deepEqual(selectableLayers('pcbPropShapeLayer'), expectedShapeLayers,
            `${kind}: single and multi-shape properties exclude Via`);
    }
    const options = app._pcbMultiPropertyCapabilities({ kind: 'shape', object: shape }).layer.options;
    assert.deepEqual(options.map(([id]) => id),
        PCB_LAYERS.filter(layer => !['board-outline', 'vias'].includes(layer.id)).map(layer => layer.id),
        `${kind}: mixed-selection capabilities exclude Via without changing other options`);
}

app.activeLayer = 'vias';
showBoardShapeToolProperties(app, 'rect');
assert.deepEqual(selectableLayers('pcbToolShapeLayer'), expectedShapeLayers);
assert.equal(layerOption('pcbToolShapeLayer', 'top-silk').selected, true);
assert.equal(resolveShapeDrawLayer(app, 'vias'), 'top-silk',
    'starting a shape while Via is active follows the existing non-graphic layer fallback');
for (const layer of expectedShapeLayers) {
    assert.equal(resolveShapeDrawLayer(app, layer), layer);
}
assert.equal(resolveShapeDrawLayer(app, 'bottom-paste'), 'bottom-silk');
assert.equal(resolveShapeDrawLayer(app, 'board-outline'), 'top-silk');

const legacy = { id: 'legacy', kind: 'rect', layer: 'vias', points, lineWidth: 0.2 };
app.boardShapes = [legacy];
setPcbSelection(app, [{ kind: 'shape', object: legacy }]);
showBoardShapeProperties(app, legacy);
assert.deepEqual(selectableLayers('pcbPropShapeLayer'), expectedShapeLayers,
    'an existing invalid assignment does not make Via a selectable destination');
assert.equal(legacy.layer, 'vias', 'inspecting an existing shape does not silently migrate its data');

const viaLayer = PCB_LAYERS.find(layer => layer.id === 'vias');
assert.ok(viaLayer, 'Via remains in the display-layer registry');
try {
    viaLayer.visible = false;
    viaLayer.locked = true;
    assert.equal(isViaVisible(), false);
    assert.equal(isViaLocked(), true);
} finally {
    viaLayer.visible = true;
    viaLayer.locked = false;
}

console.log('PASS shape creation, single/multi-selection layer options, Via fallback and display controls');

function layerOption(selectId, layerId) {
    const select = items.innerHTML.match(new RegExp(`<select id="${selectId}"[^>]*>([\\s\\S]*?)</select>`));
    if (select) {
        const option = select[1].match(new RegExp(`<option value="${layerId}"([^>]*)>([^<]*)</option>`));
        assert.ok(option, `${layerId} is present in ${selectId}`);
        return { disabled: /\bdisabled\b/.test(option[1]), selected: /\bselected\b/.test(option[1]),
            label: option[2] };
    }
    return renderedLayerOption(selectId, layerId);
}
function renderedLayerOption(selectId, layerId) {
    const select = document.getElementById(selectId);
    assert.ok(select, `${selectId} is rendered`);
    const option = select.children.find(child => child.value === layerId);
    assert.ok(option, `${layerId} is present in ${selectId}`);
    return { disabled: !!option.disabled, selected: select.value === layerId, label: option.textContent };
}
const holeLayer = PCB_LAYERS.find(layer => layer.id === 'hole');
const silkLayer = PCB_LAYERS.find(layer => layer.id === 'bottom-silk');
const priorLocks = [holeLayer.locked, silkLayer.locked];
try {
    for (const locked of [true, false]) {
        holeLayer.locked = silkLayer.locked = locked;
        for (const kind of ['line', 'circle', 'rect', 'polygon', 'arc']) {
            app.activeLayer = 'hole';
            showBoardShapeToolProperties(app, kind);
            assert.deepEqual(layerOption('pcbToolShapeLayer', 'hole'),
                { disabled: locked, selected: !locked, label: `Hole${locked ? ' \u{1F512}\uFE0E' : ''}` });
            const shape = { ...legacy, id: kind, kind, layer: 'top-silk',
                x: 5, y: 4, radius: 3, start: points[0], end: points[1], bulge: { x: 5, y: 3 } };
            const second = { ...shape, id: `${kind}-second` };
            app.boardShapes = [shape, second];
            for (const selected of [[shape], [shape, second]]) {
                setPcbSelection(app, selected.map(object => ({ kind: 'shape', object })));
                showBoardShapeProperties(app, shape);
                assert.deepEqual(layerOption('pcbPropShapeLayer', 'hole'),
                    { disabled: locked, selected: false, label: `Hole${locked ? ' \u{1F512}\uFE0E' : ''}` });
                assert.deepEqual(layerOption('pcbPropShapeLayer', 'top-silk'),
                    { disabled: false, selected: true, label: 'Top Silk' });
            }
            app._showPcbMultiSelectionProperties([shape, second].map(object => ({ kind: 'shape', object })));
            assert.equal(renderedLayerOption('pcbPropIntersection_layer', 'hole').disabled, locked);
            assert.equal(renderedLayerOption('pcbPropIntersection_layer', 'hole').label, `Hole${locked ? ' \u{1F512}\uFE0E' : ''}`);
        }
        const image = { ...legacy, id: 'image', kind: 'image', layer: 'top-silk',
            artwork: { width: 10, height: 8, rectangles: [] } };
        app.boardShapes = [image];
        setPcbSelection(app, [{ kind: 'shape', object: image }]);
        showBoardShapeProperties(app, image);
        assert.deepEqual(layerOption('pcbPropImageLayer', 'bottom-silk'),
            { disabled: locked, selected: false, label: `Bottom Silk${locked ? ' \u{1F512}\uFE0E' : ''}` });
    }

    const option = { value: 'hole', dataset: { pcbLayerLabel: 'Hole' }, textContent: 'Hole',
        disabled: false, selected: true };
    document.querySelectorAll = selector => {
        assert.equal(selector, 'option[value="hole"][data-pcb-layer-label]');
        return [option];
    };
    globalThis.requestAnimationFrame = callback => { callback(); return 1; };
    globalThis.localStorage = { setItem() {} };
    app._layerGroups = new Map();
    app._hoveredTrackOrVia = null;
    app._refreshPcbSelectionHighlights = () => {};
    const formBefore = items.innerHTML;
    for (const locked of [true, true, false, false, true]) {
        holeLayer.locked = locked;
        notifyLayerLockChanged(app, 'hole', locked);
        assert.equal(option.disabled, locked, 'Layer-panel notifications immediately update open options');
        assert.equal(option.textContent, `Hole${locked ? ' \u{1F512}\uFE0E' : ''}`, 'Monochrome lock symbols never accumulate');
        assert.equal(option.selected, true, 'Lock changes preserve the displayed assignment');
        assert.equal(items.innerHTML, formBefore, 'Lock changes do not rebuild the shape property form');
    }

    const mixedShapes = [
        { ...legacy, id: 'first', layer: 'top-silk' },
        { ...legacy, id: 'second', layer: 'top-document' },
    ];
    app.history = { execute() { assert.fail('A locked destination must not enter history'); } };
    app._showPcbMultiSelectionProperties(mixedShapes.map(object => ({ kind: 'shape', object })));
    const multiLayer = document.getElementById('pcbPropIntersection_layer');
    multiLayer.value = 'hole';
    fire(multiLayer, 'change');
    assert.deepEqual(mixedShapes.map(shape => shape.layer), ['top-silk', 'top-document'],
        'Forced multi-selection changes cannot bypass the destination lock');
    app.activeLayer = 'top-silk';
    showBoardShapeToolProperties(app, 'rect');
    const toolControl = document.getElementById('pcbToolShapeLayer');
    toolControl.value = 'hole';
    fire(toolControl, 'change');
    assert.equal(app.activeLayer, 'top-silk', 'Even a forced change cannot choose a locked destination');
    assert.equal(toolControl.value, 'top-silk');
    holeLayer.locked = false;
    toolControl.value = 'hole';
    fire(toolControl, 'change');
    assert.equal(app.activeLayer, 'hole', 'Hole can be chosen after unlocking');
    assert.equal(layerOption('pcbToolShapeLayer', 'hole').selected, true);
    assert.equal(layerOption('pcbToolShapeLayer', 'hole').disabled, false);
} finally {
    [holeLayer.locked, silkLayer.locked] = priorLocks;
}
console.log('PASS locked shape-layer icons, disabled options, live refresh and choosing Hole after unlock');
