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
const { extractComponents } = await import('../src/pcb/modules/netlist.js');
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

const project = serializeDocument({ ...app, components: instances.concat(app.components) });
assert.equal(project.schematic.defs, undefined, 'Different packages of the same symbol need no embedded definitions');
assert.ok(JSON.stringify(project).length < 12000, 'Saving bundled models must not bloat the project');
const manager = new FileManager();
manager.autoSaveToStorage(project, { revision: 1, fileName: 'packages.cpcb' });
const indicator = document.body.children.find(child => child.id === 'clearpcb-autosave-dot');
assert.equal(indicator.style.opacity, '1', 'Autorecovery completes its success notification');
clearTimeout(indicator._t);
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
const placeStart = pcbSource.indexOf('    _placeFootprints(components) {');
const placeEnd = pcbSource.indexOf('\n    /**', placeStart);
const place = new Function('generateFootprint', 'renderFootprint', 'REF_DEFAULT_SIZE', 'REF_DEFAULT_STROKE',
    `return ({${pcbSource.slice(placeStart, placeEnd)}})._placeFootprints;`)(
    generateFootprint, () => new Map(), REF_DEFAULT_SIZE, REF_DEFAULT_STROKE);
const board = {
    placements: new Map(), _autoSlots: new Map(),
    _placementOverrides: new Map([[resistor.id, { x: 23, y: -17 }]]),
    _buildLodPlaceholder() {},
};
for (const packageId of ['default', '0603', '0805']) {
    resistor.packageId = packageId;
    place.call(board, extractComponents(app));
    const placement = board.placements.get(resistor.id);
    assert.equal(placement.x, 23);
    assert.equal(placement.y, -17);
    assert.equal(placement.model3dObj, resistor.definition.model3dObj);
    assert.equal(placement.footprint, resistor.definition.footprint);
    assert.deepEqual([...placement.pads.keys()], ['1', '2']);
    assert.ok(placement.padOffsets.every(pad => packageId === 'default'
        ? pad.layer === 'both' && pad.drill > 0 && !pad.paste
        : pad.layer === 'top' && pad.drill === 0 && pad.paste));
}

const board3dSource = readFileSync(new URL('../src/pcb/modules/board3d.js', import.meta.url), 'utf8');
const meshStart = board3dSource.indexOf('function objModelToMesh(');
const meshEnd = board3dSource.indexOf('\n/**', meshStart);
const placedMesh = new Function('BOARD_THICKNESS', `${board3dSource.slice(meshStart, meshEnd)}; return objModelToMesh;`)(1.6);
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
        const contacts = mesh.verts.filter(vertex => Math.abs(vertex.y - surface) < 1e-6);
        for (const pad of pads) {
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
            `${definition.name}/${option.value}: lead contact follows ${side}/${mirror}/${rotation}`);
        }
        assert.ok(mesh.verts.every(vertex => side === 'bottom' ? vertex.y <= surface + 1e-6 : vertex.y >= surface - 1e-6));
    }
}
console.log('PASS: package selection, undo, multi-selection, clipboard, persistence, offline preview, PCB sync and posed model contacts');
