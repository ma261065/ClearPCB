import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

class Element {
    children = [];
    style = {};
    classList = { add() {}, remove() {} };
    appendChild(child) { this.children.push(child); }
    contains(child) { return this.children.includes(child); }
    replaceChildren() { this.children = []; }
    setAttribute() {}
    remove() {}
}
const storage = new Map();
globalThis.localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key),
};
globalThis.window = { addEventListener() {}, dispatchEvent() {} };
globalThis.document = {
    createElement: () => new Element(),
    createElementNS: () => new Element(),
    getElementById: () => null,
    body: new Element(),
};
globalThis.fetch = () => { throw new Error('Built-in packages must not fetch remote models'); };

const { BuiltInComponents } = await import('../src/components/BuiltInComponents.js');
const { getBuiltInPackageOptions } = await import('../src/components/BuiltInPackages.js');
const { Component } = await import('../src/components/Component.js');
const { ComponentPicker } = await import('../src/components/ComponentPicker.js');
const { CommandHistory } = await import('../src/core/CommandHistory.js');
const { applyCommonProperty } = await import('../src/ui/modules/properties.js');
const { copySelection, confirmPaste } = await import('../src/ui/modules/clipboard.js');
const { createComponentFromData, serializeDocument } = await import('../src/schematic/modules/files.js');
const { FileManager, readProjectFile } = await import('../src/core/FileManager.js');
const { validateProject } = await import('../src/core/project-format.js');
const { extractComponents } = await import('../src/core/netlist.js');
const { ProjectDocument } = await import('../src/core/ProjectDocument.js');
const { generateFootprint, REF_DEFAULT_SIZE, REF_DEFAULT_STROKE } = await import('../src/pcb/modules/footprint.js');
const { hasAny3DModel } = await import('../src/components/model3d-source.js');
const { parseObjModel } = await import('../src/shared/3d/model-rendering.js');
const definitions = new Map(BuiltInComponents.map(definition => [definition.name, definition]));
const library = { getDefinition: name => definitions.get(name) };
const envelope = components => ({ type: 'clearpcb-project', version: '1.0',
    schematic: { shapes: [], components } });

const instances = [];
for (const definition of definitions.values()) {
    const first = new Component(definition);
    const sibling = new Component(definition);
    const original = first.captureState();
    assert.ok(hasAny3DModel(definition), `${definition.name}: default model available`);
    assert.equal(first.toJSON().def, undefined, 'Bundled geometry is not embedded');
    assert.equal(first.toJSON().pkg, undefined, 'Default package preserves old instance format');
    assert.equal(first.getPropertyDescriptors().find(item => item.key === 'packageId').type, 'select');
    for (const option of getBuiltInPackageOptions(definition)) {
        first.packageId = option.value;
        assert.deepEqual(first.symbol, definition.symbol, 'Package changes keep the original symbol and pin IDs');
        assert.equal(sibling.definition, definition, 'Instance changes must not mutate a sibling');
        const saved = first.toJSON();
        const loaded = createComponentFromData({ componentLibrary: library }, saved);
        assert.equal(loaded.packageId, option.value);
        assert.equal(loaded.definition.footprint, first.definition.footprint);
        assert.equal(loaded.definition.model3dObj, first.definition.model3dObj);
        assert.equal(loaded.definition._source, 'Built-in');
        assert.doesNotThrow(() => validateProject(envelope([saved])));
    }
    first.applyState(original);
    assert.equal(first.packageId, 'default');
    assert.equal(first.definition.footprint, definition.footprint);
    first.packageId = getBuiltInPackageOptions(definition)[1].value;
    instances.push(first, sibling);
}

const userDefinition = { ...definitions.get('Resistor'), _source: 'User', model3dObj: 'custom-model', packageId: 'supplier-package' };
const custom = new Component(userDefinition);
assert.ok(!custom.getPropertyDescriptors().some(item => item.key === 'packageId'));
assert.equal(custom.toJSON().def.model3dObj, 'custom-model');
assert.equal(custom.toJSON().pkg, undefined, 'Supplier metadata is not a built-in package selection');
assert.throws(() => { custom.packageId = '0603'; });
assert.equal(custom.definition, userDefinition);

const resistor = new Component(definitions.get('Resistor'), { reference: 'R1', value: '10k' });
const capacitor = new Component(definitions.get('Capacitor'), { reference: 'C1', value: '100n' });
const history = new CommandHistory();
let alerts = 0;
const app = {
    components: [resistor, capacitor], shapes: [], componentLibrary: library, history,
    selection: { getSelection: () => app.components },
    viewport: { gridSize: 1, gridStyle: 'dots', gridVisible: true, snapToGrid: true, units: 'mm' },
    renderShapes() {}, fileManager: { setDirty() {} }, _updatePropertiesPanel() {},
    _alert() { alerts++; },
};
applyCommonProperty(app, 'packageId', '0603');
assert.equal(resistor.packageId, '0603');
assert.equal(capacitor.packageId, '0603');
assert.notEqual(resistor.definition.model3dObj, capacitor.definition.model3dObj);
history.undo();
assert.equal(resistor.packageId, 'default');
assert.equal(capacitor.packageId, 'default');
history.redo();
assert.equal(resistor.packageId, '0603');
assert.equal(capacitor.packageId, '0603');
applyCommonProperty(app, 'packageId', 'not-a-package');
assert.equal(alerts, 1, 'Invalid bulk selection is reported, not partly applied');
assert.equal(resistor.packageId, '0603');
assert.equal(history.undoStack.length, 1);

const propertiesSource = readFileSync(new URL('../src/ui/modules/properties.js', import.meta.url), 'utf8');
const mergeStart = propertiesSource.indexOf('function mergeDescriptors(');
const mergeEnd = propertiesSource.indexOf('\nfunction headerLabel(', mergeStart);
const merge = new Function(`${propertiesSource.slice(mergeStart, mergeEnd)}; return mergeDescriptors;`)();
const mixed = merge([resistor, new Component(definitions.get('PMOS'))]).find(item => item.key === 'packageId');
assert.ok(mixed.options.length > 0);
assert.ok(!mixed.options.some(option => option.value === '0603'), 'Only mutually supported packages appear');

const { SchematicDocument } = await import('../src/core/SchematicDocument.js');
const saveModel = new SchematicDocument();
saveModel.components = instances.concat(app.components);
saveModel.shapes = app.shapes;
const project = serializeDocument({ document: saveModel, viewport: app.viewport });
assert.equal(project.schematic.defs, undefined, 'Different packages of the same symbol need no embedded definitions');
assert.ok(JSON.stringify(project).length < 12000, 'Saving bundled models must not bloat the project');
const manager = new FileManager();
let autoSaveSuccesses = 0;
manager.onAutoSaveSuccess = () => { autoSaveSuccesses++; };
manager.autoSaveToStorage(project, { revision: 1, fileName: 'packages.cpcb' });
await Promise.resolve();
assert.equal(autoSaveSuccesses, 1, 'Autorecovery completes its success notification');
assert.equal(document.body.children.some(child => child.id === 'clearpcb-autosave-dot'), false,
    'Storage does not render the success indicator');
const recovered = JSON.parse(storage.get('clearpcb_autosave_packages.cpcb')).data;
assert.deepEqual(recovered, project);
let written;
const saved = await manager.saveToHandle(project, { name: 'packages.cpcb', async createWritable() {
    return { async write(blob) { written = blob; }, async close() {} };
} });
assert.equal(saved.success, true);
const reopened = validateProject(await readProjectFile(written));
for (const [index, data] of reopened.schematic.components.entries()) {
    const instance = createComponentFromData(app, data);
    const before = instances.concat(app.components)[index];
    assert.equal(instance.definition.model3dObj, before.definition.model3dObj);
    assert.equal(instance.packageId, before.packageId);
}
const longForm = resistor.toJSON();
longForm.packageId = longForm.pkg;
delete longForm.pkg;
assert.equal(validateProject(envelope([longForm])).schematic.components[0].pkg, '0603');
for (const pkg of [null, 42, '', 'unknown', 'sot23']) {
    assert.throws(() => validateProject(envelope([{ ...resistor.toJSON(), pkg }])), /package/i);
}
const embedded = envelope([resistor.toJSON()]);
embedded.schematic.defs = { Resistor: custom.toJSON().def };
assert.throws(() => validateProject(embedded), /built-in library definition/);

const picker = Object.create(ComponentPicker.prototype);
picker.packageSelect = new Element();
picker.packageRow = new Element();
picker.placeBtn = {};
picker.previewImage = new Element();
picker._updatePreview = definition => picker._updatePackageSelector(definition);
picker._setPlaceBtnLoading = () => {};
picker._setPreviewLoading = () => {};
let placed;
picker.eventBus = { emit(event, definition) { assert.equal(event, 'component:selected'); placed = definition; } };
picker._selectComponent(definitions.get('Resistor'));
assert.equal(picker.packageRow.style.display, 'block');
picker._selectBuiltInPackage('0603');
picker.placeBtn.onclick();
assert.equal(placed.packageId, '0603', 'Picker places the chosen package, not the library default');
assert.equal(new Component(placed).packageId, '0603');
picker._updatePackageSelector(userDefinition);
assert.equal(picker.packageRow.style.display, 'none');
picker._updatePackageSelector(null);
assert.equal(picker.packageSelect.children.length, 0);

const preview = Object.create(ComponentPicker.prototype);
preview.preview3d = new Element();
preview.preview3dInfo = new Element();
const pendingPreview = preview._update3dPreview(resistor.definition);
preview._set3dPreviewStatus('Selection cleared', false);
await pendingPreview;
assert.match(preview.preview3d.innerHTML, /Selection cleared/,
    'An obsolete model import must not create a WebGL viewer or overwrite the new preview');
assert.equal(preview._model3dViewer, undefined);

let pasteCommand;
const clipboardApp = {
    ...app, components: [resistor], pastingClipboard: true, currentTool: 'select',
    selection: { getSelection: () => [resistor], selectMultiple() {} },
    viewport: { getSnappedPosition: point => point, svg: new Element() },
    history: { execute(command) { pasteCommand = command; } },
    _generateReference: () => 'R2',
};
copySelection(clipboardApp);
resistor.packageId = '0805';
confirmPaste(clipboardApp, { x: 20, y: 30 });
assert.equal(pasteCommand.components[0].packageId, '0603', 'Clipboard captures the package at copy time');
assert.equal(pasteCommand.components[0].value, '10k');
assert.equal(pasteCommand.components[0].reference, 'R2');
assert.equal(resistor.packageId, '0805');

const pcbSource = readFileSync(new URL('../src/ui/PCBApp.js', import.meta.url), 'utf8');
const placeStart = pcbSource.indexOf('    _placeFootprints(placements) {');
const placeEnd = pcbSource.indexOf('\n    /**', placeStart);
const renderedFootprints = new Map();
const place = new Function('renderFootprint', 'REF_DEFAULT_SIZE', 'REF_DEFAULT_STROKE',
    `return ({${pcbSource.slice(placeStart, placeEnd)}})._placeFootprints;`)(
    (geometry, reference) => { renderedFootprints.set(reference, geometry); return new Map(); },
    REF_DEFAULT_SIZE, REF_DEFAULT_STROKE);
const pcbProject = new ProjectDocument();
pcbProject.schematicDocument.components.push(resistor);
pcbProject.pcbDocument.placementState.record(resistor.id, { x: 23, y: -17 });
const board = {
    placements: new Map(),
    _buildLodPlaceholder() {},
};
for (const packageId of ['default', '0603', '0805']) {
    resistor.packageId = packageId;
    place.call(board, pcbProject.resolvePcbLayout().placements);
    const placement = board.placements.get(resistor.id);
    const footprint = pcbProject.getPcbFootprint(resistor.id);
    assert.deepEqual(renderedFootprints.get(resistor.reference), footprint.geometry, 'Rendering receives the same geometry as headless resolution');
    assert.deepEqual(placement.padOffsets, footprint.padOffsets, 'Live placement and model resolution use the same current package');
    assert.deepEqual(placement.pasteOffsets, footprint.pasteOffsets);
    assert.equal(placement.x, 23);
    assert.equal(placement.y, -17);
    assert.equal(placement.model3dObj, resistor.definition.model3dObj);
    assert.equal(placement.footprint, resistor.definition.footprint);
    assert.deepEqual([...placement.pads.keys()], ['1', '2']);
    assert.ok(placement.padOffsets.every(pad => packageId === 'default'
        ? pad.layer === 'both' && pad.drill > 0 && !pad.paste
        : pad.layer === 'top' && pad.drill === 0 && pad.paste));
}

const duplicateComponent = new Component({
    name: 'DuplicateStencil', _source: 'KiCad', symbol: { pins: [] },
    footprintShapes: ['PAD~RECT~-2~0~1~1~1~top~1~0', 'PAD~RECT~2~0~1~1~1~both~1~0~0.5',
        'PASTE~RECT~0~0~0.5~0.5~top'],
}, { reference: 'J1' });
pcbProject.schematicDocument.components.push(duplicateComponent);
place.call(board, pcbProject.resolvePcbLayout().placements);
const duplicatePlacement = board.placements.get(duplicateComponent.id);
const duplicateFootprint = pcbProject.getPcbFootprint(duplicateComponent.id);
assert.deepEqual(duplicatePlacement.padOffsets, duplicateFootprint.padOffsets);
assert.deepEqual(duplicatePlacement.pasteOffsets, duplicateFootprint.pasteOffsets);
assert.deepEqual([...duplicatePlacement.pads], [
    ['1', { x: 8, y: -10, number: '1' }],
    ['1#2', { x: 12, y: -10, number: '1' }],
], 'Live placement retains separate physical pads and excludes stencil apertures from routing');
assert.deepEqual(renderedFootprints.get(duplicateComponent.reference), duplicateFootprint.geometry);

const board3dSource = readFileSync(new URL('../src/pcb/modules/board3d.js', import.meta.url), 'utf8');
const meshStart = board3dSource.indexOf('function objModelToMesh(');
const meshEnd = board3dSource.indexOf('\n/**', meshStart);
const placedMesh = new Function('BOARD_THICKNESS', `${board3dSource.slice(meshStart, meshEnd)}; return objModelToMesh;`)(1.6);
const metalColors = new Set(['180,188,198', '211,166,57']);
function leadSection(mesh, height) {
    const points = [];
    for (const face of mesh.faces) {
        if (!metalColors.has(face.color.join(','))) continue;
        const vertices = face.idx.map(index => mesh.verts[index]);
        for (let index = 0; index < vertices.length; index++) {
            const first = vertices[index], second = vertices[(index + 1) % vertices.length];
            if (Math.abs(first.y - height) < 1e-6) points.push(first);
            if ((first.y - height) * (second.y - height) < 0) {
                const t = (height - first.y) / (second.y - first.y);
                points.push({ x: first.x + t * (second.x - first.x), z: first.z + t * (second.z - first.z) });
            }
        }
    }
    return points;
}
for (const definition of definitions.values()) for (const option of getBuiltInPackageOptions(definition)) {
    const comp = new Component(definition, { packageId: option.value });
    const data = extractComponents({ components: [comp] })[0];
    const parsed = parseObjModel(data.model3dObj);
    const pads = generateFootprint(data.footprint, data.pins, data.footprintShapes, data.footprintBBox, data.source).pads;
    for (const side of ['top', 'bottom']) for (const mirror of [false, true]) for (const rotation of [0, 90, 37]) {
        const pl = { x: 23, y: -17, rotation, mirror, side };
        const mesh = placedMesh(parsed, pl);
        const angle = rotation * Math.PI / 180;
        const surface = side === 'bottom' ? 0 : 1.6;
        for (const pad of pads) for (const depth of pad.drill > 0 ? [0, 0.8, 1.6, 2.1] : [0]) {
            const contacts = leadSection(mesh, surface + (side === 'bottom' ? depth : -depth));
            const x = mirror !== (side === 'bottom') ? -pad.x : pad.x;
            const expected = { x: pl.x + x * Math.cos(angle) - pad.y * Math.sin(angle),
                z: pl.y + x * Math.sin(angle) + pad.y * Math.cos(angle) };
            assert.ok(contacts.some(point => {
                const dx = point.x - expected.x, dy = point.z - expected.z;
                const localX = dx * Math.cos(angle) + dy * Math.sin(angle);
                const localY = -dx * Math.sin(angle) + dy * Math.cos(angle);
                if (pad.shape === 'ellipse') {
                    return (localX / (pad.width / 2)) ** 2 + (localY / (pad.height / 2)) ** 2 <= 1 + 1e-6;
                }
                return Math.abs(localX) <= pad.width / 2 + 1e-6 && Math.abs(localY) <= pad.height / 2 + 1e-6;
            }),
            `${definition.name}/${option.value}: lead crosses pad at depth ${depth} for ${side}/${mirror}/${rotation}`);
        }
        const extent = pads.some(pad => pad.drill > 0) ? 2.1 : 0;
        const tip = side === 'bottom' ? Math.max(...mesh.verts.map(vertex => vertex.y))
            : Math.min(...mesh.verts.map(vertex => vertex.y));
        assert.ok(Math.abs(tip - (surface + (side === 'bottom' ? extent : -extent))) < 1e-6,
            'TH pins protrude exactly 0.5 mm beyond the opposite face; SMT stays on the mounting surface');
        for (const face of mesh.faces.filter(face => !metalColors.has(face.color.join(',')))) {
            assert.ok(face.idx.every(index => side === 'bottom'
                ? mesh.verts[index].y <= surface + 1e-6 : mesh.verts[index].y >= surface - 1e-6),
            'package bodies and markings remain outside the board');
        }
        const offsetMesh = placedMesh(parsed, { ...pl, model3dPlacement: { z: 0.4 } });
        mesh.verts.forEach((vertex, index) => assert.ok(Math.abs(offsetMesh.verts[index].y
            - vertex.y - (side === 'bottom' ? -0.4 : 0.4)) < 1e-6, 'authored model height offset is preserved'));
    }
}
for (const material of ['external', 'm_180_188_198']) {
    const parsed = parseObjModel(`newmtl ${material}\nKd 0.7 0.7 0.7\nusemtl ${material}\n`
        + 'v 0 0 -2.6\nv 1 0 0\nv 0 1 2\nf 1 2 3\n');
    assert.equal(parsed.source, material === 'external' ? 'easyeda' : 'kicad');
    const top = placedMesh(parsed, { x: 0, y: 0, side: 'top' });
    const bottom = placedMesh(parsed, { x: 0, y: 0, side: 'bottom' });
    assert.equal(Math.min(...top.verts.map(vertex => vertex.y)), 1.6, 'imported models retain minimum-Z seating');
    assert.equal(Math.abs(Math.max(...bottom.verts.map(vertex => vertex.y))), 0, 'bottom imported model seating unchanged');
}
console.log('PASS: package selection, undo, multi-selection, clipboard, persistence, offline preview, PCB sync and posed model contacts');
