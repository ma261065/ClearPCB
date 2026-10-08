import assert from 'node:assert/strict';
import { ProjectDocument } from '../../src/core/ProjectDocument.js';
import { CommandHistory } from '../../src/core/CommandHistory.js';
import { AddShapeCommand } from '../../src/schematic/modules/commands.js';
import { Circle } from '../../src/shapes/circle.js';
import { installFakeDom } from './helpers/fake-dom.mjs';

installFakeDom();
const { default: SchematicApp } = await import('../../src/ui/SchematicApp.js');
const { openFile } = await import('../../src/schematic/modules/files.js');
const blank = () => ({ version: '1.0', type: 'clearpcb-project',
    schematic: { shapes: [], components: [] } });
const project = new ProjectDocument();
const app = Object.create(SchematicApp.prototype);
const alerts = [];
Object.assign(app, {
    project, document: project.schematicDocument, fileManager: project.fileManager,
    history: new CommandHistory(),
    componentLibrary: { getDefinition: () => null },
    selection: { clearSelection() {} },
    viewport: {
        scale: 1, gridSize: 1, gridStyle: 'dots', units: 'mm', gridVisible: true, snapToGrid: true,
        getGridOptions: () => [{ value: 1 }],
        setUnits(value) { this.units = value; },
        setGridSize(value) { this.gridSize = value; },
        setGridStyle(value) { this.gridStyle = value; },
        setGridVisible(value) { this.gridVisible = value; },
        removeContent() {},
    },
    updateSelectableItems() {}, _updateUndoRedoButtons() {}, renderShapes() {},
    ui: {}, fitToContent() {},
    alert: message => alerts.push(message), confirm: async () => true,
    commandAddShape(shape) { this.shapes.push(shape); },
    commandRemoveShape(shape) { this.shapes.splice(this.shapes.indexOf(shape), 1); },
});
project.registerView('schematic', app);
const existingShape = new Circle({ radius: 1 });
const existingCommand = new AddShapeCommand(app, existingShape);
app.history.execute(existingCommand);
const shape = new Circle({ radius: 2 });
const command = new AddShapeCommand(app, shape);
app.history.execute(command);
app.history.undo();
project.fileManager.setFileName('original.cpcb');
project.fileManager.setDirty(true);
const oldHandle = { name: 'original.cpcb' };
project.fileManager.fileHandle = oldHandle;
const before = project.serialize().schematic;
const revision = project.fileManager.revision;
const shapes = app.shapes;
const invalid = blank();
invalid.schematic.components.push({
    type: 'component', id: 'missing', dn: 'Unavailable_Custom_Part',
    x: 0, y: 0, ref: 'U1', val: '',
});
project.fileManager.open = async () => ({ success: true, data: invalid, fileName: 'invalid.cpcb' });
await openFile(app);
assert.equal(alerts.length, 1);
assert.match(alerts[0], /Missing component definition/);
assert.equal(project.fileManager.fileName, 'original.cpcb');
assert.equal(project.fileManager.fileHandle, oldHandle);
assert.equal(project.fileManager.isDirty, true);
assert.equal(project.fileManager.revision, revision);
assert.equal(project.fileManager.loading, false);
assert.equal(app.shapes, shapes, 'Failed preflight does not replace live collections');
assert.equal(app.shapes[0], existingShape, 'Failed preflight preserves existing entity identity');
assert.deepEqual(project.serialize().schematic, before);
assert.equal(app.history.undoStack[0], existingCommand);
assert.equal(app.history.redoStack[0], command);
assert.equal(app.history.redo(), true);
assert.equal(app.shapes[1], shape, 'Redo retains the original object and command');
app.history.undo();

let preparations = 0;
const prepare = app.prepareSection.bind(app);
app.prepareSection = data => { preparations++; return prepare(data); };
await project.load(blank());
assert.equal(preparations, 1, 'Adoption consumes prepared entities rather than preparing twice');
assert.equal(app.history.canUndo(), false, 'Successful replacement clears old undo history');
assert.equal(app.history.canRedo(), false, 'Successful replacement still clears old history');
await app.loadSection(blank());
assert.equal(preparations, 2, 'Standalone loadSection still prepares its document');
console.log('PASS real schematic preflight preserves rejected-open history, identity and dirty state');
