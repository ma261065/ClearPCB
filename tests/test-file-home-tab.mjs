import assert from 'node:assert/strict';

globalThis.window = { addEventListener() {} };
globalThis.localStorage = { getItem() { return null; } };
const { default: SchematicApp } = await import('../src/ui/SchematicApp.js');
const { default: PCBApp } = await import('../src/ui/PCBApp.js');
const { ProjectDocument } = await import('../src/core/ProjectDocument.js');
const { PcbDocument } = await import('../src/core/PcbDocument.js');
const { SchematicDocument } = await import('../src/core/SchematicDocument.js');
const { newFile, openFile, openRecentFile } = await import('../src/schematic/modules/files.js');

function fixture(outcome = 'success') {
    const tabs = { schematic: 'file', pcb: 'pcb-file' }, events = [];
    const result = outcome === 'cancelled' ? { success: false, cancelled: true }
        : outcome === 'error' ? { success: false, error: 'Unreadable file' }
        : { success: true, data: {}, fileName: 'example.cpcb' };
    const app = {
        project: {
            pcbDocument: new PcbDocument(),
            schematicDocument: new SchematicDocument(),
            isDirty: outcome === 'declined',
            serialize: ProjectDocument.prototype.serialize,
            canSerialize: ProjectDocument.prototype.canSerialize,
            async reset() {
                if (outcome === 'reset-error') throw new Error('Reset failed');
                await ProjectDocument.prototype.reset.call(this);
            },
            async load() {
                if (outcome === 'load-error') throw new Error('Invalid project');
                events.push('loaded');
            },
            pcb: {
                clearSection() {},
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
        clearSection: SchematicApp.prototype.clearSection,
        serializeSection: SchematicApp.prototype.serializeSection,
        getViewSettings: SchematicApp.prototype.getViewSettings,
        shapes: [], components: [],
        _notifyDocumentReplaced: SchematicApp.prototype._notifyDocumentReplaced,
        onDocumentReplaced: SchematicApp.prototype.onDocumentReplaced,
        _setActiveRibbonTab(tab) { tabs.schematic = tab; events.push('schematic-home'); },
        confirm: async () => false, alert() { events.push('alert'); },
        fitToContent() {}, _updateTitle() {},
        selection: { clearSelection() {} }, _clearAllShapes() {}, _clearAllComponents() {},
        viewport: { resetView() {}, setTitleBlockData() {} },
    };
    app.project.fileManager = app.fileManager;
    app.document = app.project.schematicDocument;
    app.project.schematic = app;
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

for (const outcome of ['success', 'declined', 'busy', 'reset-error']) {
    const { app, tabs, events } = fixture(outcome);
    await newFile(app);
    assert.deepEqual(tabs, outcome === 'success'
        ? { schematic: 'home', pcb: 'pcb-home' } : { schematic: 'file', pcb: 'pcb-file' });
    if (outcome === 'success') assert.ok(events.indexOf('new') < events.indexOf('schematic-home'));
    else assert.equal(events.includes('new'), false);
    if (outcome === 'reset-error') assert.ok(events.includes('alert'));
}

{
    const { app, tabs, events } = fixture();
    app.project = null;
    app.loadSection = async () => { events.push('standalone-loaded'); };
    await openFile(app);
    assert.equal(tabs.schematic, 'home', 'Standalone schematic loads also return Home');
    assert.ok(events.indexOf('standalone-loaded') < events.indexOf('schematic-home'));
}
{
    const project = new ProjectDocument();
    const pcbTitle = {};
    globalThis.document = { getElementById: id => id === 'pcbDocTitle' ? pcbTitle : null };
    window.app = { _updateTitle() { assert.fail('PCB edits must not update an unrelated global schematic'); } };
    const host = {
        project, fileManager: project.fileManager, ui: { docTitle: {} },
        onProjectChanged: SchematicApp.prototype.onProjectChanged,
        _updateTitle: SchematicApp.prototype._updateTitle,
    };
    const pcb = Object.assign(Object.create(PCBApp.prototype), {
        pcbDocument: project.pcbDocument,
        refreshClearanceHalos() {}, _scheduleDRC() {},
    });
    project.registerView('schematic', host, { isUiHost: true });
    project.registerView('pcb', pcb);
    project.fileManager.setFileName('owned.cpcb');
    project.fileManager.onDirtyChanged = () => assert.fail('PCB edits must not trigger schematic dirty/stale listeners');
    const revision = project.fileManager.revision;
    for (let edit = 1; edit <= 2; edit++) {
        pcb._markDirty();
        assert.equal(project.fileManager.revision, revision + edit);
        assert.equal(project.fileManager.isDirty, false);
        assert.equal(project.isDirty, true);
        assert.equal(host.ui.docTitle.textContent, '\u2022owned.cpcb');
        assert.equal(pcbTitle.textContent, '\u2022owned.cpcb');
        assert.equal(document.title, 'ClearPCB (\u2022owned.cpcb)');
        project.markAllSectionsClean();
        host._updateTitle();
        assert.equal(host.ui.docTitle.textContent, 'owned.cpcb');
        assert.equal(pcbTitle.textContent, 'owned.cpcb');
    }
}
{
    const calls = [];
    const node = () => {
        const handlers = new Map(), classes = new Set();
        return { children: [], appendChild(child) { this.children.push(child); }, setAttribute() {},
            addEventListener: (event, handler) => handlers.set(event, handler),
            click: event => handlers.get('click')?.(event || { stopPropagation() {} }),
            classList: { contains: name => classes.has(name), remove: name => classes.delete(name),
                toggle(name) { if (!classes.delete(name)) classes.add(name); } },
        };
    };
    const ids = ['New', 'Open', 'Save', 'SaveAs', 'ExportPdf', 'Print', 'Import', 'ImportMenu', 'OpenRecent', 'RecentMenu'];
    const elements = new Map(ids.map(id => [`pcbRibbon${id}`, node()]));
    globalThis.document = { getElementById: id => elements.get(id) || null,
        querySelectorAll: () => [], addEventListener() {}, createElement: node };
    Object.defineProperty(window, 'bootstrap', {
        get() { assert.fail('PCB File commands must use their own project'); },
    });
    const { bindPcbControls } = await import('../src/pcb/modules/controls.js');
    const project = {
        newDocument() { calls.push('new'); }, open() { calls.push('open'); },
        openRecent(name) { calls.push(name); }, importEasyEDA() { calls.push('import'); },
        async save() { calls.push('save'); return { success: true }; },
        async saveAs() { calls.push('saveAs'); return { success: true }; },
        fileManager: { getRecentFiles: () => [{ name: 'owned.cpcb' }] },
    };
    const pcbControls = { project: null, _showSaveToast() { calls.push('toast'); },
        savePdf() { calls.push('pdf'); }, print() { calls.push('print'); } };
    bindPcbControls(pcbControls);
    pcbControls.project = project;
    for (const id of ['New', 'Open', 'OpenRecent']) await elements.get(`pcbRibbon${id}`).click();
    elements.get('pcbRibbonRecentMenu').children[0].children[0].click();
    elements.get('pcbRibbonImportMenu').click({ target: { closest: () => ({ dataset: { format: 'easyeda-sch' } }) } });
    for (const id of ['Save', 'SaveAs', 'ExportPdf', 'Print']) await elements.get(`pcbRibbon${id}`).click();
    assert.deepEqual(calls, ['new', 'open', 'owned.cpcb', 'import', 'save', 'toast', 'saveAs', 'toast', 'pdf', 'print']);
    await SchematicApp.prototype.onAutoSaveError.call({
        async alert(message, options) {
            assert.match(message, /Auto-save failed/);
            assert.equal(options.title, 'Auto-save Failed');
            calls.push('warning');
        },
    });
    assert.equal(calls.at(-1), 'warning');
}
console.log('PASS file navigation, project-owned dirty notifications and File-menu/error wiring');
