import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.window = { addEventListener() {} };
globalThis.document = { activeElement: null, body: { contains: () => false } };
globalThis.localStorage = { length: 0, getItem: () => null, setItem() {} };
globalThis.fetch = () => { throw new Error('Unexpected remote access in lifecycle fixture'); };
const { ComponentPicker } = await import('../src/components/ComponentPicker.js');
const { KiCadFetcher, warmKiCadIndex } = await import('../src/components/KiCadFetcher.js');
const { createGenerationGate, createDebouncedRunner } = await import('../src/components/async-control.js');
const { ModalManager } = await import('../src/core/ModalManager.js');
const { onToolSelected, onComponentPickerClosed } = await import('../src/schematic/modules/tool.js');

const css = readFileSync(new URL('../src/ui/schematic.css', import.meta.url), 'utf8');
const closeStyle = css.match(/\.cp-close\s*\{([^}]+)\}/)?.[1] || '';
for (const dimension of ['width', 'height']) {
    assert.ok(Number(closeStyle.match(new RegExp(`\\b${dimension}:\\s*(\\d+)px`))?.[1]) >= 36,
        `Picker close button has a usable ${dimension}`);
}
assert.ok(Number(closeStyle.match(/font-size:\s*(\d+)px/)?.[1]) >= 24, 'Picker X is clearly visible');
assert.match(closeStyle, /flex-shrink:\s*0/, 'Header cannot shrink the close target');

const schematic = readFileSync(new URL('../src/ui/SchematicApp.js', import.meta.url), 'utf8');
assert.match(schematic, /^\s+warmKiCadIndex\(this\.componentLibrary\);$/m,
    'Schematic startup immediately warms the index');

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
async function flush() {
    for (let i = 0; i < 4; i++) await Promise.resolve();
}
function fixture({ cached = false, mode = 'lcsc' } = {}) {
    const load = deferred(), progress = [], calls = [], renders = [];
    const fetcher = {
        libraryIndex: cached ? { symbols: { Device: ['R'] } } : null,
        ensureIndexLoaded(callback) {
            calls.push('index');
            progress.push(callback);
            return load.promise;
        },
    };
    const picker = Object.assign(Object.create(ComponentPicker.prototype), {
        library: { kicadFetcher: fetcher }, isOpen: false, searchMode: mode, searchQuery: '',
        componentItems: new Map(), lazyLoader: null, searchRequestGate: createGenerationGate(),
        selectionRequestGate: createGenerationGate(), modeButtons: [],
        element: { classList: { remove() {}, add() {} }, querySelectorAll: () => [] },
        eventBus: { emit() {} }, listEl: { innerHTML: '' },
        categoriesEl: { style: {} }, searchInput: {}, placeBtn: {}, previewSvg: {}, previewInfo: {},
        _updatePackageSelector() {}, _disposeModel3dViewer() {},
        _showLCSCPrompt() { renders.push('prompt'); },
        _showIndexingProgress(message) { renders.push(message); },
        _showLoading() { renders.push('loading'); },
        _populateComponents() { renders.push('local'); },
        _populateLCSCResults() { renders.push('results'); },
        searchManager: {
            async searchLCSC(query) { calls.push(`online:${query}`); return [{ id: query }]; },
            async searchKiCad(query) { calls.push(`kicad:${query}`); return [{ name: query }]; },
        },
    });
    picker.searchDebouncer = createDebouncedRunner(400, () => picker._searchLCSC());
    return { picker, fetcher, load, progress, calls, renders };
}

{
    const load = deferred(), started = deferred();
    const fetcher = new KiCadFetcher();
    fetcher._detectLatestRelease = async () => {};
    let downloads = 0;
    fetcher._fetchFullSymbolIndex = async () => {
        downloads++;
        started.resolve();
        await load.promise;
        fetcher.libraryIndex = { symbols: { Device: ['R'], Timer: ['NE555'] } };
    };
    assert.equal(warmKiCadIndex({ kicadFetcher: fetcher }), undefined,
        'Startup continues without waiting for the index download');
    await started.promise;
    assert.equal(downloads, 1, 'Download begins before the picker opens');
    const f = fixture();
    f.picker.library.kicadFetcher = fetcher;
    f.picker.toggle();
    fetcher._emitIndexProgress({ loaded: 1, total: 2, message: 'Background progress' });
    assert.equal(f.renders.at(-1), 'Background progress', 'An opened picker joins background progress');
    load.resolve();
    await fetcher.ensureIndexLoaded();
    await flush();
    assert.equal(downloads, 1, 'Startup, picker and search callers share one download');
    f.picker.close();
    f.picker.toggle();
    assert.equal(downloads, 1, 'Reopening uses the warmed index');
    f.picker.close();
}
{
    const load = deferred(), logged = [], warn = console.warn;
    try {
        console.warn = (...args) => logged.push(args);
        assert.equal(warmKiCadIndex({ kicadFetcher: { ensureIndexLoaded: () => load.promise } }), undefined);
        const failure = new Error('Background download failed');
        load.reject(failure);
        await flush();
        assert.equal(logged.length, 1);
        assert.deepEqual(logged[0], ['KiCad background index warm-up failed:', failure]);
        assert.equal(warmKiCadIndex({}), undefined, 'A library without KiCad support is skipped');
    } finally {
        console.warn = warn;
    }
}

{
    const f = fixture();
    await f.picker._prepareKiCadIndex();
    f.picker._setSearchMode('lcsc');
    assert.deepEqual(f.calls, [], 'Constructed/closed pickers do not initialize the index');
    f.picker.toggle();
    assert.equal(f.picker.isOpen, true);
    assert.deepEqual(f.calls, ['index'], 'First Online opening starts loading before a query');
    assert.ok(f.renders.includes('Loading KiCad library index...'));
    f.progress[0]({ message: 'Halfway', loaded: 1, total: 2 });
    assert.equal(f.renders.at(-1), 'Halfway');
    f.fetcher.libraryIndex = { symbols: { Device: ['R'] } };
    f.load.resolve();
    await flush();
    f.picker.close();
    f.picker.toggle();
    assert.equal(f.calls.length, 1, 'Reopening an already loaded catalog does not reload it');
    f.picker.close();
}
{
    const f = fixture({ mode: 'local' });
    f.picker.toggle();
    await f.picker._prepareKiCadIndex();
    assert.equal(f.calls.length, 0, 'The Local picker does not request another index load');
    f.picker._setSearchMode('lcsc');
    assert.equal(f.calls.length, 1, 'Switching an open picker to Online starts indexing');
    f.load.resolve();
    await flush();
    assert.equal(f.renders.at(-1), 'prompt', 'A hydrated cache without progress returns to the prompt');
    f.picker.close();
}
{
    const f = fixture({ cached: true });
    f.picker.toggle();
    assert.equal(f.calls.length, 0);
    assert.equal(f.renders.length, 0, 'Already available cache does not flash a progress indicator');
    f.picker.close();
}
for (const finish of ['close', 'local', 'new-query']) {
    const f = fixture();
    f.picker.toggle();
    if (finish === 'close') f.picker.close();
    else if (finish === 'local') f.picker._setSearchMode('local');
    else { f.picker.searchQuery = 'resistor'; f.picker.searchRequestGate.next(); }
    const before = [...f.renders];
    f.progress[0]({ message: 'Late progress', loaded: 1, total: 2 });
    f.load.reject(new Error('Stale index failure'));
    await flush();
    assert.deepEqual(f.renders, before, `${finish}: stale index progress does not replace current UI`);
    assert.equal(f.picker.listEl.innerHTML, '');
    f.picker.close();
}
{
    const f = fixture();
    f.picker.toggle();
    f.load.reject(new Error('Offline'));
    await flush();
    assert.match(f.picker.listEl.innerHTML, /Failed to load KiCad index/);
    assert.match(f.picker.listEl.innerHTML, /Local library/);
    f.picker.close();
}
{
    const f = fixture();
    f.picker.toggle();
    f.picker.searchQuery = 'NE555';
    const search = f.picker._searchLCSC();
    f.progress[0]({ message: 'Obsolete opening progress', loaded: 0, total: 1 });
    assert.notEqual(f.renders.at(-1), 'Obsolete opening progress');
    f.fetcher.libraryIndex = { symbols: {} };
    f.load.resolve();
    await search;
    assert.deepEqual(f.calls.slice(-2), ['online:NE555', 'kicad:NE555']);
    assert.equal(f.picker.isSearching, false);
    assert.deepEqual(f.picker.lcscResults, [{ id: 'NE555' }]);
    f.picker.close();
}
{
    const f = fixture();
    f.picker.isOpen = true;
    f.picker.searchQuery = 'NE555';
    const error = console.error, logged = [];
    try {
        console.error = (...args) => logged.push(args);
        const search = f.picker._searchLCSC();
        f.load.reject(new Error('Initial indexing failed'));
        await assert.doesNotReject(search, 'First-search index failures use the normal search error path');
        assert.equal(f.picker.isSearching, false, 'Index failures cannot leave a permanent loading state');
        assert.match(f.picker.listEl.innerHTML, /Search failed/);
        assert.equal(logged.length, 1);
        assert.equal(f.calls.some(call => call.startsWith('online:')), false);
    } finally {
        console.error = error;
    }
}
assert.equal(ModalManager.top(), null);
{
    const fetcher = new KiCadFetcher();
    const writes = [];
    fetcher._getGitRefs = () => ['release', 'main'];
    fetcher._detectLatestRelease = async () => {};
    fetcher._setContentCache = (key, value) => { writes.push({ key, value }); return true; };
    fetcher._fetchGitLabTreePage = async () => null;
    await assert.rejects(fetcher.ensureIndexLoaded(), /complete KiCad symbol index/,
        'Exhausted remote refs must reject, not resolve with no usable index');
    assert.equal(fetcher.libraryIndex, null);
    assert.equal(fetcher._indexLoadPromise, null, 'A failed load can be retried');
    assert.equal(writes.length, 0);
    const completeEntries = [
        { type: 'blob', path: 'Device.kicad_symdir/R.kicad_sym' },
        { type: 'blob', path: 'Timer.kicad_symdir/NE555.kicad_sym' },
    ];
    for (const partial of ['missing-library', 'missing-page']) {
        fetcher._fetchGitLabTreePage = async ({ page }) => page > 1 ? null : {
            json: partial === 'missing-library' ? completeEntries.slice(0, 1) : completeEntries,
            headers: { get: name => name === 'x-total' ? '2'
                : name === 'x-total-pages' ? (partial === 'missing-page' ? '2' : '1') : null },
        };
        await assert.rejects(fetcher.ensureIndexLoaded(), /complete KiCad symbol index/);
        assert.equal(fetcher.libraryIndex, null);
        assert.equal(writes.length, 0, 'Partial data never replaces the index or enters the cache');
    }
    fetcher._fetchGitLabTreePage = async () => ({
        json: completeEntries,
        headers: { get: name => name === 'x-total' ? '2' : name === 'x-total-pages' ? '1' : null },
    });
    await fetcher.ensureIndexLoaded();
    assert.deepEqual(fetcher.libraryIndex, { symbols: { Device: ['R'], Timer: ['NE555'] } });
    assert.equal(writes.length, 1, 'A successful retry publishes and caches the complete result once');
    const usable = fetcher.libraryIndex;
    fetcher._fetchGitLabTreePage = async () => null;
    await assert.rejects(fetcher._fetchFullSymbolIndex(), /complete KiCad symbol index/);
    assert.equal(fetcher.libraryIndex, usable, 'Failed background refresh preserves an existing usable index');
    assert.equal(writes.length, 1);
}
{
    const createElement = document.createElement;
    const node = () => {
        const classes = new Set(), events = new Map(), controls = new Map();
        return {
            style: {}, innerHTML: '',
            classList: { add: value => classes.add(value), remove: value => classes.delete(value),
                contains: value => classes.has(value) },
            addEventListener: (name, callback) => events.set(name, callback),
            click: () => events.get('click')?.(), focus() {},
            querySelector(selector) {
                if (!controls.has(selector)) controls.set(selector, node());
                return controls.get(selector);
            },
            querySelectorAll: () => [],
        };
    };
    document.createElement = node;
    try {
        for (const action of ['button', 'escape', 'toggle', 'close']) for (const placing of [false, true]) {
            const { picker } = fixture({ mode: 'local' });
            picker._createDOM();
            assert.match(picker.element.innerHTML, /<button type="button" class="cp-close app-modal-close"[^>]*aria-label="Close component picker"[^>]*>&times;<\/button>/,
                'accessible X button uses the existing close-button styling');
            let closed = 0, disposed = 0, lazyDestroyed = 0, cancelled = 0;
            const changes = [];
            const app = {
                currentTool: 'select', interactionState: 'idle', componentPicker: picker,
                viewport: { svg: { style: {} } },
                selection: { clearSelection() {}, getSelection: () => [] },
                renderShapes() {}, cancelDrawing() {}, hideCrosshair() {},
                updateShapePanelOptions() {}, updatePropertiesPanel() {},
                setToolCursor(tool) { this.viewport.svg.style.cursor = tool === 'select' ? 'default' : 'crosshair'; },
                refreshRibbon() { this.activeButton = this.currentTool; },
                selectTool(tool) { changes.push(tool); onToolSelected(this, tool); },
                cancelComponentPlacement() { cancelled++; this.placingComponent = null; },
            };
            picker._disposeModel3dViewer = () => { disposed++; };
            picker.eventBus.emit = name => {
                if (name === 'component:pickerClosed') {
                    assert.equal(picker.isOpen, false);
                    assert.equal(ModalManager.top(), null);
                    assert.equal(picker.lazyLoader, null, 'cleanup finishes before the app switches tools');
                    closed++;
                    onComponentPickerClosed(app);
                } else if (name === 'component:selected') {
                    app.placingComponent = {};
                    app.interactionState = 'placing';
                }
            };
            app.selectTool('component');
            picker.lazyLoader = { destroy() { lazyDestroyed++; } };
            if (placing) {
                picker._normalizeDefinition = value => value;
                picker._updatePreview = () => {};
                picker._setPlaceBtnLoading = () => {};
                picker._setPreviewLoading = () => {};
                picker._beginPlacement({ name: 'Resistor' });
                assert.equal(app.currentTool, 'component', 'Place Component still starts placement, not Select');
                assert.equal(picker.isOpen, true);
                assert.equal(closed, 0);
            }
            if (action === 'button') picker.element.querySelector('.cp-close').click();
            else if (action === 'escape') ModalManager.top().onEscape();
            else picker[action]();
            assert.equal(picker.isOpen, false);
            assert.ok(picker.element.classList.contains('collapsed'));
            assert.equal(ModalManager.top(), null);
            assert.equal(app.currentTool, 'select', `${action}: closing returns to Select`);
            assert.equal(app.interactionState, 'idle');
            assert.equal(app.activeButton, 'select');
            assert.equal(app.viewport.svg.style.cursor, 'default');
            assert.equal(cancelled, placing ? 1 : 0);
            assert.equal(disposed, 1);
            assert.equal(lazyDestroyed, 1);
            assert.deepEqual(changes, ['component', 'select'], 'no duplicate/reentrant tool transition');
            picker.close();
            assert.equal(closed, 1, 'repeated closure does not emit duplicate notifications');

            app.selectTool('component');
            assert.equal(ModalManager.top().id, 'componentPicker', 'picker can reopen normally');
            app.selectTool('wire');
            assert.equal(picker.isOpen, false);
            assert.equal(app.currentTool, 'wire', 'closing as part of another tool selection must not override it');
            assert.equal(app.activeButton, 'wire');
            assert.equal(closed, 2);
            assert.equal(ModalManager.top(), null);
        }
    } finally {
        document.createElement = createElement;
    }
}
console.log('PASS component index lifecycle, accessible picker close, Select restoration and placement/tool handoff');
