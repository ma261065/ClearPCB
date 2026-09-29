import assert from 'node:assert/strict';

globalThis.window = { addEventListener() {} };
globalThis.localStorage = { getItem() { return null; } };
const { default: SchematicApp } = await import('../src/ui/SchematicApp.js');
const { default: PCBApp } = await import('../src/ui/PCBApp.js');
const { ProjectDocument } = await import('../src/core/ProjectDocument.js');
const { newFile, openFile, openRecentFile } = await import('../src/schematic/modules/files.js');

function fixture(outcome = 'success') {
    const tabs = { schematic: 'file', pcb: 'pcb-file' }, events = [];
    const result = outcome === 'cancelled' ? { success: false, cancelled: true }
        : outcome === 'error' ? { success: false, error: 'Unreadable file' }
        : { success: true, data: {}, fileName: 'example.cpcb' };
    const app = {
        project: {
            isDirty: outcome === 'declined',
            async load() {
                if (outcome === 'load-error') throw new Error('Invalid project');
                events.push('loaded');
            },
            pcb: {
                onDocumentReplaced: PCBApp.prototype.onDocumentReplaced,
                _setActiveRibbonTab(tab) { tabs.pcb = tab; events.push('pcb-home'); },
            },
            notifyDocumentReplaced: ProjectDocument.prototype.notifyDocumentReplaced,
        },
        fileManager: {
            loading: outcome === 'busy', saving: false, isDirty: false,
            async open() { events.push('picker'); return result; },
            async openRecent(name) { assert.equal(name, 'example.cpcb'); events.push('recent'); return result; },
            async adoptOpen() {
                if (outcome === 'adoption-error') throw new Error('Could not adopt file');
                events.push('adopted');
            },
            clearAutoSave() {}, newDocument() { events.push('new'); },
        },
        _loadDocument: SchematicApp.prototype._loadDocument,
        _notifyDocumentReplaced: SchematicApp.prototype._notifyDocumentReplaced,
        onDocumentReplaced: SchematicApp.prototype.onDocumentReplaced,
        _setActiveRibbonTab(tab) { tabs.schematic = tab; events.push('schematic-home'); },
        _confirm: async () => false, _alert() { events.push('alert'); },
        _fitToContent() {}, _updateTitle() {},
        selection: { clearSelection() {} }, _clearAllShapes() {}, _clearAllComponents() {},
        viewport: { resetView() {}, setTitleBlockData() {} },
    };
    app.project.views = new Map([['schematic', app], ['pcb', app.project.pcb]]);
    return { app, tabs, events };
}

for (const open of [openFile, app => openRecentFile(app, 'example.cpcb')]) {
    for (const outcome of ['success', 'cancelled', 'error', 'load-error', 'adoption-error', 'declined', 'busy']) {
        const { app, tabs, events } = fixture(outcome);
        await open(app);
        if (outcome === 'success') {
            assert.deepEqual(tabs, { schematic: 'home', pcb: 'pcb-home' });
            assert.ok(events.indexOf('loaded') < events.indexOf('schematic-home'));
            assert.ok(events.indexOf('loaded') < events.indexOf('pcb-home'));
            assert.ok(events.indexOf('adopted') < events.indexOf('schematic-home'));
            assert.ok(events.indexOf('adopted') < events.indexOf('pcb-home'));
        } else {
            assert.deepEqual(tabs, { schematic: 'file', pcb: 'pcb-file' }, `${outcome} leaves both tabs unchanged`);
            assert.equal(events.includes('adopted'), false);
        }
    }
}

{
    const { app, tabs } = fixture();
    let started, release;
    const adopting = new Promise(resolve => { started = resolve; });
    app.fileManager.adoptOpen = () => new Promise(resolve => { release = resolve; started(); });
    const pending = openFile(app);
    await adopting;
    assert.deepEqual(tabs, { schematic: 'file', pcb: 'pcb-file' }, 'Wait for file adoption before switching tabs');
    release();
    await pending;
    assert.deepEqual(tabs, { schematic: 'home', pcb: 'pcb-home' });
}

{
    const { app, tabs } = fixture();
    let release;
    app.project.load = () => new Promise(resolve => { release = resolve; });
    const pending = openRecentFile(app, 'example.cpcb');
    await Promise.resolve();
    assert.deepEqual(tabs, { schematic: 'file', pcb: 'pcb-file' }, 'Stay on File while loading');
    release();
    await pending;
    assert.deepEqual(tabs, { schematic: 'home', pcb: 'pcb-home' });
}

for (const outcome of ['success', 'declined', 'busy']) {
    const { app, tabs, events } = fixture(outcome);
    await newFile(app);
    assert.deepEqual(tabs, outcome === 'success'
        ? { schematic: 'home', pcb: 'pcb-home' } : { schematic: 'file', pcb: 'pcb-file' });
    if (outcome === 'success') assert.ok(events.indexOf('new') < events.indexOf('schematic-home'));
    else assert.equal(events.includes('new'), false);
}

{
    const { app, tabs, events } = fixture();
    app.project = null;
    app.loadSection = async () => { events.push('standalone-loaded'); };
    await openFile(app);
    assert.equal(tabs.schematic, 'home', 'Standalone schematic loads also return Home');
    assert.ok(events.indexOf('standalone-loaded') < events.indexOf('schematic-home'));
}
console.log('PASS New/Open/Recent return both editors Home after success, with no tab change on cancellation or failure');
