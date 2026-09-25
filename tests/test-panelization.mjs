import assert from 'node:assert/strict';
import { pointInPolygon } from '../src/core/geometry.js';

globalThis.window = { addEventListener() {} };
globalThis.document = { getElementById: () => null };
const { PANEL_DEFAULTS, panelSettings, buildPanelLayout } = await import('../src/pcb/modules/panelization.js');
const { SetPanelizationCommand, renderPanelPreview, resetPanelPreview, panelPreviewOutlinePath, panelPreviewSupportContours, updatePanelRailConstraints } = await import('../src/pcb/modules/panelization-ui.js');
const { EditTextCommand, RemoveTextCommand } = await import('../src/pcb/modules/text-commands.js');
const { panelRasterSize } = await import('../src/pcb/modules/panelization-raster.js');
const { rectangleBoardOutline } = await import('../src/pcb/modules/board-outline.js');
const { preparePcb, serializePcb } = await import('../src/pcb/modules/project-state.js');
const { prepareFabricationSnapshot } = await import('../src/pcb/modules/fabrication-snapshot.js');
const { exportGerbers } = await import('../src/pcb/modules/gerber.js');
const { default: ClipperLib } = await import('../assets/vendor/clipper.esm.js');

{
    const curvedBoard = [{ x: 0, y: 0 }, ...Array.from({ length: 21 }, (_, index) => ({
        x: 10 - 2 * Math.sin(Math.PI * index / 20), y: index / 2,
    })), { x: 0, y: 10 }];
    const previewLayout = {
        instances: [{ points: curvedBoard }, { points: curvedBoard.map(point => ({ x: 24 - point.x, y: point.y })) }],
        tabs: [[{ x: 7, y: 2 }, { x: 17, y: 2 }, { x: 17, y: 8 }, { x: 7, y: 8 }]],
        rails: [[{ x: -4, y: 0 }, { x: -2, y: 0 }, { x: -2, y: 10 }, { x: -4, y: 10 }]],
    };
    const original = JSON.stringify(previewLayout);
    const contours = panelPreviewSupportContours(previewLayout);
    const shaded = point => contours.filter(contour => pointInPolygon(point, contour)).length % 2 === 1;
    assert.ok(shaded({ x: 12, y: 5 }), 'Tab gap remains highlighted');
    assert.ok(shaded({ x: 9, y: 5 }) && shaded({ x: 15, y: 5 }), 'Highlight follows both concave board edges');
    assert.ok(shaded({ x: -3, y: 5 }), 'Rail highlight is retained');
    for (let column = 0; column < 110; column++) {
        for (let row = 0; row < 50; row++) {
            const point = { x: -4.137 + column * 0.27, y: 0.137 + row * 0.19 };
            const expected = [...previewLayout.rails, ...previewLayout.tabs].some(contour => pointInPolygon(point, contour))
                && !previewLayout.instances.some(instance => pointInPolygon(point, instance.points));
            assert.equal(shaded(point), expected, 'Preview shades supports only outside board instances');
        }
    }
    assert.equal(JSON.stringify(previewLayout), original, 'Clipping leaves manufacturing geometry unchanged');
}

for (const axis of ['horizontal', 'vertical']) {
    for (const feature of ['PositioningHoles', 'Fiducials']) {
        const inputs = Object.fromEntries(['railTop', 'railLeft'].map(key =>
            [key, { valueAsNumber: 0, min: '0', validationMessage: '', setCustomValidity(message) { this.validationMessage = message; } }]));
        for (const direction of ['horizontal', 'vertical']) {
            for (const option of ['PositioningHoles', 'Fiducials']) inputs[direction + option] = { checked: false };
        }
        const form = { querySelector(selector) { return inputs[selector.match(/name="([^"]+)"/)[1]]; } };
        const active = inputs[axis === 'horizontal' ? 'railTop' : 'railLeft'];
        const absent = inputs[axis === 'horizontal' ? 'railLeft' : 'railTop'];
        active.valueAsNumber = 5;
        inputs[axis + feature].checked = true;
        assert.equal(updatePanelRailConstraints(form), '');
        assert.equal(active.min, '5', 'Active feature rail pair stops spinning down at 5 mm');
        assert.equal(absent.min, '0', 'The other rail pair remains optional');
        for (const width of [4.5, 0, NaN]) {
            active.valueAsNumber = width;
            assert.match(updatePanelRailConstraints(form), /at least 5 mm/);
            assert.equal(active.min, '5', 'Typing zero cannot remove the minimum');
            assert.match(active.validationMessage, /at least 5 mm/);
        }
        active.valueAsNumber = 5;
        assert.equal(updatePanelRailConstraints(form), '');
        assert.equal(active.validationMessage, '');
        inputs[axis + feature].checked = false;
        active.valueAsNumber = 0;
        assert.equal(updatePanelRailConstraints(form), '');
        assert.equal(active.min, '0', 'Disabling features permits rail removal');
    }
}

{
    const source = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    assert.equal(panelPreviewOutlinePath([source], source), '', 'Source outline is not drawn twice');
    assert.equal(panelPreviewOutlinePath([[...source].reverse()], source), '', 'Reversed contours are also redundant');
    const expanded = [{ x: -5, y: 0 }, { x: 15, y: 0 }, { x: 15, y: 15 }, { x: -5, y: 15 }];
    const path = panelPreviewOutlinePath([expanded], source);
    assert.equal(path, 'M-5,0L0,0M10,0L15,0M15,0L15,15M15,15L-5,15M-5,15L-5,0',
        'Only the shared part of a longer panel edge is removed');
    const copy = source.map(point => ({ x: point.x + 20, y: point.y }));
    assert.equal(panelPreviewOutlinePath([copy], source), 'M20,0L30,0M30,0L30,10M30,10L20,10M20,10L20,0',
        'Other boards retain their panel outlines');
    const original = JSON.stringify([source, expanded]);
    panelPreviewOutlinePath([expanded], source);
    assert.equal(JSON.stringify([source, expanded]), original, 'Preview filtering does not mutate manufacturing geometry');
}

const app = {
    placements: new Map(), _placementOverrides: new Map(), tracks: [], vias: [], texts: new Map(),
    copperFills: [], boardShapes: [rectangleBoardOutline(20, 10)],
    _boardWidth: 20, _boardHeight: 10, _boardRadius: 0,
    _getRoutingParams: () => ({ clearance: 0.2, trackWidth: 0.25, viaDiameter: 0.6, viaDrill: 0.3 }),
    _getRouterMode: () => 'pathfinder',
    _renderText() {}, _removeTextElement() {}, _refreshText() {},
};
const originalOutline = structuredClone(app.boardShapes);
const layout = buildPanelLayout(app, PANEL_DEFAULTS);
assert.equal(layout.instances.length, 4);
assert.deepEqual(layout.instances.map(({ dx, dy }) => [dx, dy]), [[0, 0], [22, 0], [0, 12], [22, 12]]);
assert.deepEqual(layout.bounds, { x: 0, y: -17, w: 42, h: 36 });
assert.ok(layout.drills.length > 0);
assert.equal(layout.cuts.length, 0);
assert.ok(layout.note.some(line => line.includes('2 rows x 2 columns')));
const inSubstrate = (x, y) => layout.contours.reduce((inside, contour) =>
    ClipperLib.Clipper.PointInPolygon({ X: x * 1000, Y: y * 1000 },
        contour.map(point => ({ X: Math.round(point.x * 1000), Y: Math.round(point.y * 1000) }))) ? !inside : inside, false);
assert.equal(inSubstrate(21, -5), false, 'routing gap between boards remains open');
assert.equal(inSubstrate(21, -7.5), true, 'tab connects adjacent boards');
assert.equal(inSubstrate(10, -11), false, 'rail is routed away from board except at tabs');
assert.equal(inSubstrate(5, -11), true, 'rail tab remains connected');
assert.deepEqual(app.boardShapes, originalOutline, 'panel geometry does not mutate source');
assert.throws(() => panelSettings({ rows: 1.5 }), /whole numbers/);
assert.throws(() => panelSettings({ rows: 20, columns: 20 }), /100 boards/);
assert.throws(() => panelSettings({ rowSpacing: NaN }), /Spacing/);
assert.throws(() => panelSettings({ holeDiameter: 0.8, holePitch: 0.8 }), /pitch/);
assert.equal(panelSettings({}).verticalTabsPerEdge, 2);
assert.equal(panelSettings({}).horizontalTabsPerEdge, 2);
assert.deepEqual(panelSettings({ tabsPerEdge: 3 }),
    { ...PANEL_DEFAULTS, verticalTabsPerEdge: 3, horizontalTabsPerEdge: 3 },
    'legacy shared tab count migrates to both axes');
assert.deepEqual(panelSettings({ tabsPerEdge: 3, verticalTabsPerEdge: 1 }),
    { ...PANEL_DEFAULTS, verticalTabsPerEdge: 1, horizontalTabsPerEdge: 3 },
    'explicit axis count overrides the legacy count');
assert.equal(panelSettings({}).verticalTabOffset, 0);
assert.equal(panelSettings({}).horizontalTabOffset, 0);
assert.deepEqual(panelSettings({ tabOffset: -0.5 }),
    { ...PANEL_DEFAULTS, verticalTabOffset: -0.5, horizontalTabOffset: -0.5 },
    'legacy shared offset migrates to both axes');
assert.deepEqual(panelSettings({ tabOffset: -0.5, verticalTabOffset: 0 }),
    { ...PANEL_DEFAULTS, verticalTabOffset: 0, horizontalTabOffset: -0.5 },
    'explicit axis offset overrides the legacy offset, including zero');
for (const tabsPerEdge of [0, 1.5, 21, NaN]) {
    assert.throws(() => panelSettings({ tabsPerEdge }), /Tabs per edge/);
    assert.throws(() => panelSettings({ verticalTabsPerEdge: tabsPerEdge }), /Tabs per edge/);
    assert.throws(() => panelSettings({ horizontalTabsPerEdge: tabsPerEdge }), /Tabs per edge/);
}
for (const tabOffset of [-101, 101, NaN, Infinity]) {
    assert.throws(() => panelSettings({ tabOffset }), /Tab offset/);
    assert.throws(() => panelSettings({ verticalTabOffset: tabOffset }), /Tab offset/);
    assert.throws(() => panelSettings({ horizontalTabOffset: tabOffset }), /Tab offset/);
}
for (const arrangement of [{ rows: 1, columns: 2, along: 'y' }, { rows: 2, columns: 1, along: 'x' }]) {
    const options = { rows: arrangement.rows, columns: arrangement.columns,
        railTop: 0, railBottom: 0, tabWidth: 2 };
    for (const tabsPerEdge of [1, 2, 3]) {
        const countKey = arrangement.along === 'y' ? 'verticalTabsPerEdge' : 'horizontalTabsPerEdge';
        const otherCountKey = arrangement.along === 'y' ? 'horizontalTabsPerEdge' : 'verticalTabsPerEdge';
        const countOptions = { ...options, [countKey]: tabsPerEdge, [otherCountKey]: 20 };
        const centered = buildPanelLayout(app, countOptions);
        assert.equal(centered.tabs.length, tabsPerEdge, 'one connecting edge has the requested tab count');
        assert.equal(centered.drills.length, tabsPerEdge * 4, 'each tab has two holes at each end');
        const across = arrangement.along === 'x' ? 'y' : 'x';
        const edge = across === 'x' ? 20 : 0;
        centered.drills.forEach((drill, index) => {
            assert.equal(drill[across], edge + (index % 2 ? 1.75 : 0.25),
                'opposing holes move a radius into the tab from each board edge');
        });
        for (const tabOffset of [-0.5, 0.5]) {
            const offsetKey = arrangement.along === 'y' ? 'verticalTabOffset' : 'horizontalTabOffset';
            const otherOffsetKey = arrangement.along === 'y' ? 'horizontalTabOffset' : 'verticalTabOffset';
            const unchanged = buildPanelLayout(app, { ...countOptions, [otherOffsetKey]: 100 });
            assert.deepEqual(unchanged.tabs, centered.tabs, 'other-axis offset does not move tabs or affect edge fit');
            assert.deepEqual(unchanged.drills, centered.drills, 'other-axis offset does not move drills');
            const shifted = buildPanelLayout(app, { ...countOptions, [offsetKey]: tabOffset, [otherOffsetKey]: 100 });
            const across = arrangement.along === 'x' ? 'y' : 'x';
            shifted.tabs.forEach((tab, tabIndex) => tab.forEach((point, pointIndex) => {
                const original = centered.tabs[tabIndex][pointIndex];
                assert.ok(Math.abs(point[arrangement.along] - original[arrangement.along] - tabOffset) < 1e-9);
                assert.equal(point[across], original[across]);
            }));
            shifted.drills.forEach((drill, index) => {
                assert.ok(Math.abs(drill[arrangement.along] - centered.drills[index][arrangement.along] - tabOffset) < 1e-9);
                assert.equal(drill[across], centered.drills[index][across]);
            });
        }
    }
}
const oneTab = buildPanelLayout(app, { tabsPerEdge: 1, tabOffset: 0.5 });
assert.equal(oneTab.tabs.length * 2, layout.tabs.length, 'count applies to board and rail connections');
const mixedTabs = buildPanelLayout(app, { verticalTabsPerEdge: 1, horizontalTabsPerEdge: 3 });
assert.equal(mixedTabs.tabs.length, 20, 'two vertical connections use one tab and six horizontal board/rail connections use three');
for (const [rail, axis, coordinates] of [
    ['railTop', 'y', [-11.75, -10.25]], ['railBottom', 'y', [0.25, 1.75]],
    ['railLeft', 'x', [-1.75, -0.25]], ['railRight', 'x', [20.25, 21.75]],
]) {
    const railLayout = buildPanelLayout(app, { rows: 1, columns: 1,
        railTop: 0, railBottom: 0, railLeft: 0, railRight: 0, [rail]: 5 });
    assert.ok(railLayout.drills.length > 0);
    railLayout.drills.forEach((drill, index) => {
        assert.equal(drill[axis], coordinates[index % 2], 'board and rail holes are offset toward the connecting tab');
    });
}
for (const columnSpacing of [1, 1.1]) {
    assert.throws(() => buildPanelLayout(app, { rows: 1, columns: 2,
        railTop: 0, railBottom: 0, columnSpacing, holeDiameter: 0.6 }), /drill rows would touch or overlap/);
}
assert.throws(() => buildPanelLayout(app, { rows: 1, columns: 2,
    railTop: 0, railBottom: 0, columnSpacing: 1 }), /drill rows would touch or overlap/);
assert.throws(() => buildPanelLayout(app, { tabsPerEdge: 4 }), /without touching/);
for (const tabOffset of [-1, 1]) {
    assert.throws(() => buildPanelLayout(app, { tabOffset }), /edge end/);
}
assert.throws(() => buildPanelLayout(app, { rowSpacing: 0 }), /at least 1 mm/);
const rounded = { ...app, boardShapes: [rectangleBoardOutline(20, 10, 2)] };
assert.ok(buildPanelLayout(rounded, PANEL_DEFAULTS).contours.length > 0);
assert.throws(() => buildPanelLayout(rounded, { separation: 'vcut' }), /square corners/);
assert.ok(buildPanelLayout({ ...app, boardShapes: [{ id: 'circle', kind: 'circle',
    layer: 'board-outline', x: 10, y: -10, radius: 10 }] }, PANEL_DEFAULTS).drills.length > 0);

const command = new SetPanelizationCommand(app, PANEL_DEFAULTS);
const appliedSettings = { ...PANEL_DEFAULTS, noteCreated: true };
command.execute();
assert.deepEqual(app.panelization, appliedSettings);
assert.equal(app.texts.size, layout.note.length, 'panel note lines are ordinary authored texts');
assert.ok([...app.texts.values()].every(text => text.layer === 'top-document'));
const noteIds = [...app.texts.keys()];
command.undo();
assert.equal(app.panelization, null);
assert.equal(app.texts.size, 0, 'undo panel creation removes its texts');
command.execute();
assert.deepEqual([...app.texts.keys()], noteIds, 'redo restores the same text objects');
const noteEdit = new EditTextCommand(app, noteIds[0], { content: 'Custom panel note', x: 7 });
noteEdit.execute();
const noteDelete = new RemoveTextCommand(app, noteIds[1]);
noteDelete.execute();
const edit = new SetPanelizationCommand(app, { ...app.panelization, columns: 3 });
edit.execute();
assert.equal(app.panelization.columns, 3);
assert.equal(app.texts.get(noteIds[0]).content, 'Custom panel note', 'panel edits preserve text edits');
assert.equal(app.texts.get(noteIds[0]).x, 7, 'panel edits preserve text position');
assert.equal(app.texts.has(noteIds[1]), false, 'panel edits do not regenerate deleted notes');
edit.undo();
assert.equal(app.panelization.columns, 2);
const saved = serializePcb(app);
const restored = preparePcb(JSON.parse(JSON.stringify(saved)));
assert.deepEqual(restored.panelization, appliedSettings, 'settings survive project round trip');
assert.equal(restored.texts.find(text => text.id === noteIds[0]).content, 'Custom panel note');
assert.equal(restored.texts.some(text => text.id === noteIds[1]), false, 'deleted notes remain deleted after load');
const reapply = new SetPanelizationCommand({ ...app, panelization: restored.panelization }, restored.panelization);
assert.equal(reapply.noteCommands.length, 0, 'reloaded panels do not regenerate their note');
noteDelete.undo();
noteEdit.undo();
const tabEdit = new SetPanelizationCommand(app, { ...app.panelization, verticalTabsPerEdge: 1, horizontalTabsPerEdge: 2,
    verticalTabOffset: -0.5, horizontalTabOffset: 0.75 });
tabEdit.execute();
assert.deepEqual(preparePcb(JSON.parse(JSON.stringify(serializePcb(app)))).panelization,
    { ...appliedSettings, verticalTabsPerEdge: 1, horizontalTabsPerEdge: 2, verticalTabOffset: -0.5, horizontalTabOffset: 0.75 },
    'independent tab counts and offsets survive project round trip');
const tabSnapshot = await prepareFabricationSnapshot(app);
assert.equal(tabSnapshot.panelization.verticalTabsPerEdge, 1);
assert.equal(tabSnapshot.panelization.horizontalTabsPerEdge, 2);
assert.equal(tabSnapshot.panelization.verticalTabOffset, -0.5);
assert.equal(tabSnapshot.panelization.horizontalTabOffset, 0.75);
tabEdit.undo();
assert.deepEqual(app.panelization, appliedSettings, 'undo restores tab count and offset');
assert.equal(restored.boardShapes.length, 1, 'ghosts are not authored board shapes');
assert.equal(preparePcb(null).panelization, null, 'old/new documents have no panel');
const remove = new SetPanelizationCommand(app, null);
remove.execute();
assert.equal('panelization' in serializePcb(app), false);
assert.equal(app.texts.size, layout.note.length, 'removing panel settings leaves ordinary text untouched');
remove.undo();
assert.deepEqual(app.panelization, appliedSettings);
const legacyApp = { ...app, panelization: { ...PANEL_DEFAULTS }, texts: new Map() };
new SetPanelizationCommand(legacyApp, legacyApp.panelization).execute();
assert.equal(legacyApp.texts.size, layout.note.length, 'applying a legacy panel creates editable notes');

app.vias.push({ id: 'via', x: 5, y: -5, diameter: 1, drill: 0.3, net: '' });
app.placements.set('U1', { x: 8, y: -5, rotation: 90, mirror: true,
    reference: 'U1', refVisible: true,
    padOffsets: [{ dx: 0, dy: 0, width: 2, height: 1, layer: 'top', shape: 'rect' }],
});
for (const layer of ['top-copper', 'bottom-copper', 'top-silk', 'bottom-silk']) {
    app.boardShapes.push({ id: `ring-${layer}`, kind: 'circle', layer, copperMode: 'add',
        x: 14, y: -5, radius: 2, lineWidth: 0.2, filled: false });
}
app.boardShapes.push({ id: 'copper-cut', kind: 'polygon', layer: 'top-copper',
    copperMode: 'remove-copper', filled: true, lineWidth: 0.1,
    points: [{ x: 13, y: -6 }, { x: 15, y: -6 }, { x: 14, y: -4 }] });
const snapshot = await prepareFabricationSnapshot(app);
app.panelization.columns = 3;
assert.equal(snapshot.panelization.columns, 2, 'fabrication captures detached panel settings');
app.panelization.columns = 2;
const files = exportGerbers(snapshot);
const single = exportGerbers({ ...snapshot, panelization: null });
for (const name of ['board.gtl', 'board.gbl', 'board.gts', 'board.gbs', 'board.gtp', 'board.gbp', 'board.gto', 'board.gbo']) {
    const content = files.get(name);
    assert.doesNotMatch(content, /%AB|%SR/, `${name} has no executable repetition`);
    assert.match(content, /^G04 Panelize: Stamp Hole, Column: 2, Row: 2, Board Size: 20\.00mm x 10\.00mm, Panelized Board Size: 42\.00mm x 36\.00mm\*\n/);
    assert.equal(content.slice(content.indexOf('\n') + 1), single.get(name),
        `${name} preserves source-board artwork exactly after its panel instruction header`);
    assert.deepEqual(content.match(/%ADD[^\n]+/g), single.get(name).match(/%ADD[^\n]+/g),
        `${name} keeps aperture dimensions unchanged`);
    assert.equal((content.match(/M02\*/g) || []).length, 1);
}
assert.equal((files.get('board.gtl').match(/G03\*/g) || []).length, 1, 'source arcs are stored once');
assert.equal((files.get('board.gtl').match(/%LPC\*%/g) || []).length, 1, 'source clear polarity is stored once');
assert.equal((files.get('board.gtl').match(/G36\*/g) || []).length,
    (single.get('board.gtl').match(/G36\*/g) || []).length, 'source clear regions are stored once');
const largePanel = exportGerbers({ ...snapshot, panelization: { ...PANEL_DEFAULTS, rows: 10, columns: 5 } });
assert.match(largePanel.get('board.gtl'), /Panelize: Stamp Hole, Column: 5, Row: 10/);
assert.match(largePanel.get('board.gtl'), /X5000000Y5000000D03\*/,
    'source artwork stays at its original position');
assert.ok(largePanel.get('board.gtl').length < single.get('board.gtl').length * 1.1 + 200,
    '50-board artwork stays close to single-board size');
assert.equal(largePanel.get('board-PTH.drl'), single.get('board-PTH.drl'));
assert.equal(files.get('board-PTH.drl'), single.get('board-PTH.drl'), 'component drills are not repeated');
assert.equal((files.get('board-NPTH.drl').match(/^X/gm) || []).length, layout.drills.length);
assert.equal(files.has('board-vscore.gbr'), false);
assert.deepEqual(JSON.parse(files.get('panel-settings.json')), appliedSettings);
assert.match(files.get('panel-notes.txt'), /MANUFACTURER PANELIZATION REQUIRED/);
assert.match(files.get('panel-notes.txt'), /column step X=\+22\.000000, row step Y=-12\.000000/);
assert.match(files.get('panel-notes.txt'), /DO NOT repeat those holes/);
assert.doesNotMatch(single.get('board.gtl'), /%ABD/);
assert.equal((single.get('board-PTH.drl').match(/^X/gm) || []).length, 1);

assert.deepEqual(layout.positioningHoles, [], 'rail features default off');
assert.deepEqual(layout.fiducials, []);
for (const prefix of ['horizontal', 'vertical']) {
    assert.throws(() => panelSettings({ [`${prefix}Fiducials`]: 1 }), /boolean/);
    assert.throws(() => panelSettings({ [`${prefix}PositioningHoles`]: 'yes' }), /boolean/);
    const featureSettings = { ...PANEL_DEFAULTS, railTop: 6, railBottom: 6, railLeft: 6, railRight: 6,
        [`${prefix}PositioningHoles`]: true, [`${prefix}Fiducials`]: true };
    const featureLayout = buildPanelLayout(app, featureSettings);
    assert.equal(featureLayout.positioningHoles.length, 4);
    assert.equal(featureLayout.fiducials.length, 4);
    for (const feature of [...featureLayout.positioningHoles, ...featureLayout.fiducials]) {
        assert.ok(prefix === 'horizontal' ? feature.y < -10 || feature.y > 12 : feature.x < 0 || feature.x > 42,
            'features appear only on the enabled edge orientation');
        assert.ok(featureLayout.rails.some(rail => feature.x - 1.5 >= rail[0].x + 1 - 1e-9
            && feature.x + 1.5 <= rail[2].x - 1 + 1e-9
            && feature.y - 1.5 >= rail[0].y + 1 - 1e-9
            && feature.y + 1.5 <= rail[2].y - 1 + 1e-9), 'feature fits entirely inside a rail with clearance');
    }
    const featureFiles = exportGerbers({ ...snapshot, panelization: featureSettings });
    for (const name of ['board.gtl', 'board.gbl', 'board.gts', 'board.gbs']) {
        const content = featureFiles.get(name);
        const tail = content.slice(content.indexOf('G04 Panel rail fiducials'));
        assert.equal((tail.match(/D03\*/g) || []).length, 4, 'rail marks are flashed once per actual panel position');
        const aperture = tail.match(/\nD(\d+)\*/)[1];
        assert.ok(content.includes(`%ADD${aperture}C,${name.endsWith('s') ? '3.0000' : '1.0000'}*%`));
        for (const mark of featureLayout.fiducials) {
            assert.ok(tail.includes(`X${Math.round(mark.x * 1e6)}Y${Math.round(-mark.y * 1e6)}D03*`));
        }
        assert.equal((content.match(/M02\*/g) || []).length, 1);
    }
    const withoutFeatures = exportGerbers({ ...snapshot, panelization: {
        ...featureSettings, [`${prefix}PositioningHoles`]: false, [`${prefix}Fiducials`]: false } });
    for (const name of ['board.gtp', 'board.gbp', 'board.gto', 'board.gbo', 'board.gko', 'board-PTH.drl']) {
        assert.equal(featureFiles.get(name), withoutFeatures.get(name), 'rail features do not change paste, silk, routes or plated drills');
    }
    assert.equal((featureFiles.get('board-NPTH.drl').match(/^X/gm) || []).length, featureLayout.drills.length);
    for (const hole of featureLayout.positioningHoles) {
        assert.ok(featureFiles.get('board-NPTH.drl').includes(`X${hole.x.toFixed(3)}Y${(-hole.y).toFixed(3)}`));
    }
    const featureApp = { ...app, panelization: featureSettings };
    assert.deepEqual(preparePcb(JSON.parse(JSON.stringify(serializePcb(featureApp)))).panelization, featureSettings);
    assert.deepEqual((await prepareFabricationSnapshot(featureApp)).panelization, featureSettings);
}
assert.throws(() => buildPanelLayout(app, { verticalPositioningHoles: true }), /require a left or right rail/);
assert.throws(() => buildPanelLayout(app, { railTop: 0, railBottom: 0, horizontalFiducials: true }), /require a top or bottom rail/);
assert.throws(() => buildPanelLayout(app, { railTop: 4, horizontalPositioningHoles: true }), /at least 5 mm/);
assert.throws(() => buildPanelLayout(app, { rows: 1, columns: 1, railLeft: 5,
    verticalPositioningHoles: true, verticalFiducials: true }), /too short/);
const fiducialsOnly = buildPanelLayout(app, { horizontalFiducials: true });
assert.equal(fiducialsOnly.fiducials.length, 4);
assert.equal(fiducialsOnly.drills.length, layout.drills.length, 'fiducials do not drill holes');
const holesOnly = buildPanelLayout(app, { horizontalPositioningHoles: true });
assert.equal(holesOnly.positioningHoles.length, 4);
assert.equal(holesOnly.fiducials.length, 0);

const scoredSettings = { ...PANEL_DEFAULTS, separation: 'vcut', rowSpacing: 0, columnSpacing: 0 };
const scored = buildPanelLayout(app, scoredSettings);
assert.equal(scored.cuts.length, 4, 'one column score and three row/rail scores');
assert.equal(scored.drills.length, 0);
const scoredFiles = exportGerbers({ ...snapshot, panelization: scoredSettings });
assert.match(scoredFiles.get('board.gtl'), /^G04 Panelize: V-Cut, Column: 2, Row: 2/);
assert.match(scoredFiles.get('board-vscore.gbr'), /NOT through routes/);
assert.equal(scoredFiles.has('board-NPTH.drl'), false);
const scoredFeatures = { ...scoredSettings, horizontalPositioningHoles: true, horizontalFiducials: true };
assert.equal(buildPanelLayout(app, scoredFeatures).drills.length, 4, 'V-cut panels also support tooling holes');
assert.ok(exportGerbers({ ...snapshot, panelization: scoredFeatures }).has('board-NPTH.drl'));
assert.equal((scoredFiles.get('board.gko').match(/D02\*/g) || []).length, 1, 'scores are not through-cut outlines');
const slotted = { ...snapshot, boardShapes: [...snapshot.boardShapes,
    { id: 'slot', layer: 'hole', kind: 'rect', filled: true, lineWidth: 0,
        points: [{ x: 8, y: -7 }, { x: 12, y: -7 }, { x: 12, y: -3 }, { x: 8, y: -3 }] }],
};
assert.equal((exportGerbers(slotted).get('board.gko').match(/D02\*/g) || []).length,
    (files.get('board.gko').match(/D02\*/g) || []).length + 4, 'each board retains its routed cutout');
const edgeCutout = right => ({ id: 'edge-cutout', layer: 'hole', kind: 'rect', filled: true, lineWidth: 0,
    points: [{ x: 19, y: -8 }, { x: right, y: -8 }, { x: right, y: -7 }, { x: 19, y: -7 }] });
const clippedCutoutFiles = exportGerbers({ ...snapshot, boardShapes: [...snapshot.boardShapes, edgeCutout(20)] });
const oversizedCutoutFiles = exportGerbers({ ...snapshot, boardShapes: [...snapshot.boardShapes, edgeCutout(50)] });
assert.equal(oversizedCutoutFiles.get('board.gko'), clippedCutoutFiles.get('board.gko'),
    'source cutouts extending through tabs and neighboring rails/boards are clipped before repetition');
const crossingSlot = { id: 'edge-slot', layer: 'hole', kind: 'line', lineWidth: 2, plated: false,
    points: [{ x: 19.5, y: -8 }, { x: 19.5, y: -7 }] };
const crossingSlotFiles = exportGerbers({ ...snapshot, boardShapes: [...snapshot.boardShapes, crossingSlot] });
assert.equal(crossingSlotFiles.get('board-NPTH.drl'), files.get('board-NPTH.drl'),
    'a source slot whose tool diameter crosses the edge is routed as a clipped cutout, not a full NPTH slot');
assert.notEqual(crossingSlotFiles.get('board.gko'), files.get('board.gko'), 'the clipped slot remains in the routed profile');
const platedCrossingSlotFiles = exportGerbers({ ...snapshot,
    boardShapes: [...snapshot.boardShapes, { ...crossingSlot, plated: true }] });
assert.equal(platedCrossingSlotFiles.get('board-PTH.drl'), files.get('board-PTH.drl'),
    'crossing plated hole-layer slots must not drill beyond the clipped routed profile');
assert.equal(platedCrossingSlotFiles.get('board.gko'), crossingSlotFiles.get('board.gko'));
const circlePanel = {
    placements: new Map(), boardWidth: 100.33, boardHeight: 80.01,
    boardShapes: [rectangleBoardOutline(100.33, 80.01, 2)],
    panelization: { ...PANEL_DEFAULTS, railLeft: 5, railRight: 7, tabWidth: 6,
        holeDiameter: 0.7, holePitch: 1.2, verticalTabsPerEdge: 5, horizontalTabsPerEdge: 4,
        horizontalTabOffset: 2.6 },
};
const circlePanelBase = exportGerbers(circlePanel);
for (const plated of [false, true]) {
    const result = exportGerbers({ ...circlePanel, boardShapes: [...circlePanel.boardShapes,
        { id: 'crossing-circle', kind: 'circle', layer: 'hole', filled: true, lineWidth: 0,
            x: 42.8397, y: -75.8597, radius: 7.2842, plated }] });
    assert.equal(result.get('board-PTH.drl'), circlePanelBase.get('board-PTH.drl'),
        'edge-crossing circles are not exported as unclipped plated drills');
    assert.equal(result.get('board-NPTH.drl'), circlePanelBase.get('board-NPTH.drl'),
        'edge-crossing circles are not exported as unclipped non-plated drills');
    assert.notEqual(result.get('board.gko'), circlePanelBase.get('board.gko'));
    const contours = [];
    for (const match of result.get('board.gko').matchAll(/X(-?\d+)Y(-?\d+)D0([12])\*/g)) {
        if (match[3] === '2') contours.push([]);
        contours.at(-1).push({ x: Number(match[1]), y: Number(match[2]) });
    }
    for (const contour of contours) {
        const horizontalEdges = contour.slice(1).flatMap((end, index) => {
            const start = contour[index];
            return start.y === end.y && start.x !== end.x
                ? [{ y: start.y, min: Math.min(start.x, end.x), max: Math.max(start.x, end.x) }] : [];
        });
        horizontalEdges.forEach((edge, index) => {
            for (const other of horizontalEdges.slice(index + 1)) {
                assert.ok(edge.y !== other.y || Math.min(edge.max, other.max) <= Math.max(edge.min, other.min),
                    'circle-to-routing-gap junction must not retrace an overlapping board-edge segment');
            }
        });
    }
}
const drilled = { ...snapshot, placements: new Map([['P1', { x: 10, y: -5, rotation: 0,
    padOffsets: [{ dx: 0, dy: 0, width: 3, height: 2, layer: 'top', drill: 0.8, slotLength: 2, slotAngle: 0 }] }]]),
    boardShapes: [...snapshot.boardShapes, { id: 'npth', kind: 'circle', layer: 'hole',
        x: 3, y: -3, radius: 0.5, filled: true, lineWidth: 0, plated: false }] };
const drilledPanel = exportGerbers(drilled);
const drilledSingle = exportGerbers({ ...drilled, panelization: null });
assert.equal(drilledPanel.get('board-PTH.drl'), drilledSingle.get('board-PTH.drl'), 'plated slots remain source-only');
assert.equal((drilledPanel.get('board-PTH.drl').match(/G85/g) || []).length, 1);
assert.equal((drilledPanel.get('board-NPTH.drl').match(/^X/gm) || []).length,
    (drilledSingle.get('board-NPTH.drl').match(/^X/gm) || []).length + layout.drills.length,
    'source NPTH holes occur once plus all panel mouse-bites');
assert.deepEqual(panelRasterSize({ w: 20, h: 10 }, 1), { width: 256, height: 128 });
assert.deepEqual(panelRasterSize({ w: 20, h: 10 }, 20), { width: 512, height: 256 });
assert.deepEqual(panelRasterSize({ w: 20, h: 10 }, 1000, 3), { width: 2048, height: 1024 });
let createdNodes = 0;
const createNode = (localName = 'g') => {
    createdNodes++;
    return {
        localName, nodeName: localName, nodeType: 1,
        style: {}, dataset: {}, attributes: [], children: [], parentNode: null,
        get id() { return this.getAttribute('id') || ''; },
        set id(value) { this.setAttribute('id', value); },
        getAttribute(name) { return this.attributes.find(attribute => attribute.name === name)?.value ?? null; },
        setAttribute(name, value) { this.setAttributeNS(null, name, value); },
        setAttributeNS(namespaceURI, name, value) {
            const attribute = this.attributes.find(item => item.name === name);
            if (attribute) attribute.value = value;
            else this.attributes.push({ name, localName: name.split(':').at(-1), namespaceURI, value });
        },
        querySelectorAll() { return this.children.flatMap(child => [child, ...child.querySelectorAll()]); },
        cloneNode(deep) {
            const clone = createNode(this.localName);
            clone.style = { ...this.style };
            clone.dataset = { ...this.dataset };
            for (const attribute of this.attributes) clone.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value);
            if (deep) for (const child of this.children) clone.appendChild(child.cloneNode(true));
            return clone;
        },
        appendChild(child) { child.remove(); this.children.push(child); child.parentNode = this; return child; },
        insertBefore(child, reference) {
            child.remove();
            this.children.splice(this.children.indexOf(reference), 0, child);
            child.parentNode = this;
            return child;
        },
        remove() {
            if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
            this.parentNode = null;
        },
    };
};
const priorDocument = globalThis.document;
const priorObserver = globalThis.MutationObserver;
const priorSetTimeout = globalThis.setTimeout;
const priorClearTimeout = globalThis.clearTimeout;
const priorImage = globalThis.Image;
const priorSerializer = globalThis.XMLSerializer;
const priorNode = globalThis.Node;
const priorNodeFilter = globalThis.NodeFilter;
const priorComputedStyle = window.getComputedStyle;
const priorCreateURL = URL.createObjectURL;
const priorRevokeURL = URL.revokeObjectURL;
const decodedImages = [];
const serializedRoots = [];
const activeURLs = new Map();
const canvasSizes = [];
let urlId = 0;
globalThis.Image = class {
    constructor() { decodedImages.push(this); }
};
globalThis.XMLSerializer = class {
    serializeToString(root) { serializedRoots.push(root); return '<svg xmlns="http://www.w3.org/2000/svg"/>'; }
};
globalThis.Node = { ELEMENT_NODE: 1 };
globalThis.NodeFilter = { SHOW_ELEMENT: 1 };
window.getComputedStyle = () => ({ fill: '#abcdef', opacity: '1' });
URL.createObjectURL = blob => { const url = `blob:panel-${++urlId}`; activeURLs.set(url, blob); return url; };
URL.revokeObjectURL = url => activeURLs.delete(url);
const observers = [];
const timers = new Map();
let timerId = 0;
globalThis.MutationObserver = class {
    constructor(callback) { this.callback = callback; this.targets = []; this.disconnected = false; observers.push(this); }
    observe(target) { this.targets.push(target); }
    disconnect() { this.disconnected = true; }
};
globalThis.setTimeout = callback => { timers.set(++timerId, callback); return timerId; };
globalThis.clearTimeout = id => timers.delete(id);
globalThis.document = { ...priorDocument,
    createElementNS: (namespace, name) => createNode(name),
    createNodeIterator(root) {
        const nodes = [root, ...root.querySelectorAll()];
        return { nextNode: () => nodes.shift() || null };
    },
    createElement(name) {
        assert.equal(name, 'canvas');
        return { width: 0, height: 0, getContext: () => ({ drawImage() {} }),
            toBlob(callback) { canvasSizes.push([this.width, this.height]); callback(new Blob(['png'], { type: 'image/png' })); } };
    },
};
const beginRefresh = () => {
    assert.equal(timers.size, 1);
    const callback = [...timers.values()][0];
    timers.clear();
    return callback();
};
try {
    const root = createNode('svg');
    const sharedDefs = root.appendChild(createNode('defs'));
    sharedDefs.appendChild(createNode('clipPath')).id = 'copper-clip';
    const layers = new Map(['board-outline', 'top-copper', 'top-document', 'hole'].map(id => [id, root.appendChild(createNode())]));
    layers.get('hole').setAttribute('clip-path', 'url(#prior-hole-clip)');
    const sourceArtwork = layers.get('top-copper').appendChild(createNode());
    sourceArtwork.id = 'source-image';
    sourceArtwork.setAttribute('transform', 'translate(0,0)');
    const sourceUse = layers.get('top-copper').appendChild(createNode('use'));
    sourceUse.setAttribute('href', '#source-image');
    sourceUse.setAttribute('clip-path', 'url(#source-image)');
    const previewApp = {
        boardShapes: [rectangleBoardOutline(20, 10)], panelization: { ...PANEL_DEFAULTS },
        viewport: { svg: root, scale: 1, addContent: node => root.appendChild(node) }, _layerGroups: layers,
        _getLayerGroup(id) { return this._layerGroups.get(id); },
    };
    let preview = renderPanelPreview(previewApp);
    assert.match(layers.get('hole').getAttribute('clip-path'), /pcb-panel-artwork-\d+-holes/,
        'source hole layer is clipped while the panel is visible');
    const panelGroup = root.children.at(-1);
    const defs = panelGroup.children[1];
    const rasterImage = defs.children[0];
    assert.equal(rasterImage.localName, 'image', 'attached preview stores a raster image, not cloned artwork');
    assert.equal(defs.children.length, 1);
    assert.equal(rasterImage.children.length, 0);
    assert.equal(panelGroup.children.filter(child => child.localName === 'use').length, 3, 'all ghosts share one image');
    const initialRefresh = beginRefresh();
    const detached = serializedRoots.at(-1);
    assert.equal(detached.children[0].children[0].id, 'copper-clip', 'shared clipping definitions are serialized');
    const clonedArtwork = detached.children.at(-1).children[1].children[0];
    const clonedUse = detached.children.at(-1).children[1].children[1];
    assert.equal(clonedArtwork.id, sourceArtwork.id, 'IDs remain local to the detached SVG');
    assert.equal(clonedArtwork.getAttribute('fill'), '#abcdef', 'computed colours survive serialization');
    assert.equal(clonedUse.getAttribute('href'), '#source-image');
    assert.equal(clonedUse.getAttribute('clip-path'), 'url(#source-image)');
    decodedImages.at(-1).onload();
    await initialRefresh;
    const originalURL = rasterImage.getAttribute('href');
    assert.equal(activeURLs.get(originalURL).type, 'image/png');
    assert.deepEqual(canvasSizes.at(-1), [256, 128]);
    assert.equal(observers[0].targets.includes(layers.get('top-document')), false, 'generated notes are not observed');
    const initialNodeCount = createdNodes;
    assert.equal(renderPanelPreview(previewApp), preview, 'unchanged previews reuse layout');
    assert.equal(createdNodes, initialNodeCount, 'unchanged previews create no SVG nodes');
    layers.get('top-copper').appendChild(createNode());
    const artworkNodeCount = createdNodes;
    assert.equal(renderPanelPreview(previewApp), preview, 'artwork edits retain the cached preview');
    assert.equal(createdNodes, artworkNodeCount, 'artwork edits do not recreate ghosts or notes');
    for (let move = 1; move <= 20; move++) {
        sourceArtwork.setAttribute('transform', `translate(${move},0)`);
        observers[0].callback([{ type: 'attributes', attributeName: 'transform', target: sourceArtwork }]);
    }
    assert.equal(timers.size, 1, 'drag frames coalesce into one idle refresh');
    assert.equal(createdNodes, artworkNodeCount, 'drag frames do not clone artwork');
    assert.equal(clonedArtwork.getAttribute('transform'), 'translate(0,0)', 'ghost artwork stays frozen during movement');
    assert.equal(rasterImage.getAttribute('href'), originalURL, 'drag frames retain the old bitmap');
    const idleRefresh = beginRefresh();
    assert.equal(serializedRoots.at(-1).children.at(-1).children[1].children[0].getAttribute('transform'), 'translate(20,0)');
    decodedImages.at(-1).onload();
    await idleRefresh;
    assert.equal(activeURLs.has(originalURL), false, 'replaced bitmap URL is released');
    observers[1].callback();
    assert.equal(timers.size, 0, 'panning at the same resolution does not rebuild the bitmap');
    sourceArtwork.setAttribute('class', 'culled');
    observers[0].callback([{ type: 'attributes', attributeName: 'class', oldValue: '', target: sourceArtwork }]);
    assert.equal(timers.size, 0, 'viewport culling does not rebuild the bitmap');
    previewApp.viewport.scale = 20;
    observers[1].callback();
    const zoomTimer = [...timers.keys()][0];
    previewApp.viewport.scale = 21;
    observers[1].callback();
    assert.equal(timers.size, 1);
    assert.equal(timers.has(zoomTimer), false, 'continued zoom postpones refresh within the same resolution step');
    const beforeZoomURL = rasterImage.getAttribute('href');
    const zoomRefresh = beginRefresh();
    assert.equal(rasterImage.getAttribute('href'), beforeZoomURL, 'old bitmap remains during zoom refresh');
    observers[0].callback([{ type: 'childList', target: layers.get('top-copper') }]);
    decodedImages.at(-1).onload();
    await zoomRefresh;
    assert.equal(rasterImage.getAttribute('href'), beforeZoomURL, 'stale async render does not replace the bitmap');
    const latestRefresh = beginRefresh();
    decodedImages.at(-1).onload();
    await latestRefresh;
    assert.deepEqual(canvasSizes.at(-1), [512, 256], 'zoom refresh uses a higher-resolution bitmap');
    previewApp.boardShapes[0].points[1].x = 22;
    previewApp.boardShapes[0].points[2].x = 22;
    let changed = renderPanelPreview(previewApp);
    assert.notEqual(changed, preview, 'in-place outline edits invalidate layout');
    assert.equal(observers[0].disconnected, true, 'rebuild disconnects the old observer');
    assert.equal(changed.sourceBounds.w, 22);
    preview = changed;
    previewApp.panelization.columns = 3;
    changed = renderPanelPreview(previewApp);
    assert.notEqual(changed, preview, 'in-place settings edits invalidate layout');
    assert.equal(changed.instances.length, 6);
    preview = changed;
    layers.get('top-copper').remove();
    layers.set('top-copper', root.appendChild(createNode()));
    changed = renderPanelPreview(previewApp);
    assert.notEqual(changed, preview, 'replaced source layers rebuild references');
    const authoredNote = layers.get('top-document').appendChild(createNode());
    authoredNote.remove();
    preview = renderPanelPreview(previewApp);
    assert.equal(preview, changed, 'deleting document text does not rebuild panel geometry');
    assert.equal(layers.get('top-document').children.length, 0, 'preview does not regenerate deleted text');
    layers.get('top-document').appendChild(authoredNote);
    observers.at(-1).callback();
    const pendingRefresh = beginRefresh();
    resetPanelPreview(previewApp);
    decodedImages.at(-1).onload();
    await pendingRefresh;
    assert.equal(layers.get('hole').getAttribute('clip-path'), 'url(#prior-hole-clip)', 'reset restores prior hole clipping');
    assert.equal(timers.size, 0, 'reset cancels pending snapshot work');
    assert.equal(observers.at(-1).disconnected, true, 'reset disconnects observation');
    assert.equal(activeURLs.size, 0, 'reset releases bitmap and in-flight source URLs');
    assert.equal(root.children.length, layers.size + 1, 'reset removes generated preview geometry');
    assert.equal(layers.get('top-document').children[0], authoredNote, 'reset leaves authored document text untouched');
    assert.notEqual(renderPanelPreview(previewApp), preview, 'reset invalidates cached layout');
    resetPanelPreview(previewApp);
    for (const id of ['clearance-overlay', 'selection-overlay', 'drc-overlay']) {
        layers.set(id, root.appendChild(createNode()));
    }
    const nodeHandle = layers.get('selection-overlay').appendChild(createNode('rect'));
    for (const columns of [2, 3]) {
        previewApp.panelization.columns = columns;
        renderPanelPreview(previewApp);
        const panel = root.children.find(child => child.getAttribute('class') === 'pcb-panel-preview');
        assert.ok(panel);
        for (const id of ['clearance-overlay', 'selection-overlay', 'drc-overlay']) {
            assert.ok(root.children.indexOf(panel) < root.children.indexOf(layers.get(id)),
                `Panel outlines stay below ${id} on creation and rebuild`);
        }
        assert.equal(layers.get('selection-overlay').children[0], nodeHandle);
    }
    resetPanelPreview(previewApp);
} finally {
    globalThis.document = priorDocument;
    globalThis.MutationObserver = priorObserver;
    globalThis.setTimeout = priorSetTimeout;
    globalThis.clearTimeout = priorClearTimeout;
    globalThis.Image = priorImage;
    globalThis.XMLSerializer = priorSerializer;
    globalThis.Node = priorNode;
    globalThis.NodeFilter = priorNodeFilter;
    window.getComputedStyle = priorComputedStyle;
    URL.createObjectURL = priorCreateURL;
    URL.revokeObjectURL = priorRevokeURL;
}
console.log('PASS: panel geometry, ghost settings persistence, undo and source-board fabrication with panel instructions');