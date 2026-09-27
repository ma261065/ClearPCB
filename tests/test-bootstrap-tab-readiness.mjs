import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/ui/AppBootstrap.js', import.meta.url), 'utf8');
const start = source.indexOf('class AppBootstrap {');
const end = source.indexOf('\ndocument.addEventListener(', start);
assert.ok(start >= 0 && end > start);

function fixture() {
    let keydown = null;
    let modal = null;
    let finishRecovery, failRecovery;
    const recovery = new Promise((resolve, reject) => { finishRecovery = resolve; failRecovery = reject; });
    const events = [];
    const frames = [];
    const idleCallbacks = new Map();
    let idleId = 0;
    const tabs = ['schematic', 'pcb'].map(mode => ({
        dataset: { mode }, listeners: [], classes: new Map(), attributes: new Map(),
        classList: { toggle(name, value) { this.owner.classes.set(name, value); },
            contains(name) { return this.owner.classes.get(name) === true; } },
        addEventListener(type, handler) { this.listeners.push({ type, handler }); },
        setAttribute(name, value) { this.attributes.set(name, value); },
        removeAttribute(name) { this.attributes.delete(name); },
        blur() {},
    })).map(tab => { tab.classList.owner = tab; return tab; });
    const window = {
        addEventListener(type, handler) { if (type === 'keydown') keydown = handler; },
        requestAnimationFrame(callback) { frames.push(callback); },
        cancelAnimationFrame() {},
        requestIdleCallback(callback) { idleCallbacks.set(++idleId, callback); return idleId; },
        cancelIdleCallback(id) { idleCallbacks.delete(id); },
    };
    const dependencies = {
        ModalManager: { top: () => modal },
        window,
        document: { querySelectorAll: () => tabs, querySelector: () => null, getElementById: () => null },
        installNumberInputFormatting() {},
        ProjectDocument: class {
            fileManager = { loading: false };
            registerView() {}
            startAutoSave() { events.push('autosave'); }
        },
        PCBApp: class {
            _active = false;
            _stale = true;
            initialize() { events.push('pcb-ready'); }
            activate() { events.push('activate'); }
            deactivate() { events.push('deactivate'); }
            preload() { this._stale = false; events.push('preload'); }
        },
        SchematicApp: class {
            constructor() { events.push('schematic-ready'); }
            _recoverAutoSave() { events.push('recover'); return recovery; }
        },
    };
    const Bootstrap = new Function(...Object.keys(dependencies), `${source.slice(start, end)}\nreturn AppBootstrap;`)
        (...Object.values(dependencies));
    const bootstrap = new Bootstrap();
    bootstrap._registerServiceWorker = () => {};
    bootstrap._bindKeyboardDispatcher = () => {};
    bootstrap._setupLaunchQueue = () => events.push('launch');
    const click = () => tabs[1].listeners.find(listener => listener.type === 'click')?.handler();
    const flushFrame = () => frames.shift()?.();
    const flushIdle = () => idleCallbacks.values().next().value?.();
    return { bootstrap, tabs, events, click, flushFrame, flushIdle, finishRecovery, failRecovery,
        bindKeyboard: () => Bootstrap.prototype._bindKeyboardDispatcher.call(bootstrap),
        key: event => keydown(event), setModal: value => { modal = value; } };
}

{
    const test = fixture();
    const modes = [];
    let pcbKeys = 0;
    test.tabs[0].classList.toggle('active', true);
    test.bootstrap.pcbApp = { _active: false, handleKeyDown() { pcbKeys++; return true; } };
    test.bootstrap.switchMode = mode => {
        modes.push(mode);
        test.tabs.forEach(tab => tab.classList.toggle('active', tab.dataset.mode === mode));
        test.bootstrap.pcbApp._active = mode === 'pcb';
    };
    test.bindKeyboard();
    const event = overrides => ({ key: 'Tab', ctrlKey: true, defaultPrevented: false, stopped: false,
        preventDefault() { this.defaultPrevented = true; },
        stopImmediatePropagation() { this.stopped = true; }, ...overrides });
    for (const overrides of [{}, {}, { shiftKey: true }, { ctrlKey: false, metaKey: true }]) {
        const press = event(overrides);
        test.key(press);
        assert.ok(press.defaultPrevented && press.stopped, 'mode cycling consumes the shortcut');
    }
    assert.deepEqual(modes, ['pcb', 'schematic', 'pcb', 'schematic'], 'Ctrl+Tab cycles repeatedly in both directions');
    assert.equal(pcbKeys, 0, 'mode cycling precedes PCB shortcut dispatch');
    test.key(event({ ctrlKey: false }));
    test.key(event({ defaultPrevented: true }));
    test.setModal({ id: 'settings' });
    test.key(event({}));
    assert.equal(modes.length, 4, 'plain Tab, consumed keys, and blocking modals do not switch mode');
    test.setModal({ id: 'text-edit' });
    test.key(event({ target: { tagName: 'INPUT', type: 'text' } }));
    assert.equal(modes.at(-1), 'pcb', 'mode cycling remains available while editing text');
}

{
    const test = fixture();
    const initialization = test.bootstrap.initialize();
    assert.equal(test.tabs[1].listeners.length, 1, 'PCB tab is wired while recovery is still pending');
    assert.deepEqual(test.events, ['pcb-ready', 'schematic-ready', 'recover']);
    test.bootstrap.project.fileManager.loading = true;
    test.click();
    assert.equal(test.events.includes('activate'), false, 'mode switching cannot race a document load');
    test.bootstrap.project.fileManager.loading = false;
    test.click();
    test.flushFrame();
    await Promise.resolve();
    test.flushFrame();
    await Promise.resolve();
    assert.equal(test.events.at(-1), 'activate', 'PCB is available before recovery bookkeeping finishes');
    assert.equal(test.events.includes('autosave'), false, 'autosave still waits for recovery');
    test.finishRecovery(true);
    await initialization;
    assert.deepEqual(test.events.slice(-2), ['autosave', 'launch']);
    assert.equal(test.tabs[1].listeners.length, 1, 'recovery completion does not duplicate tab listeners');
    test.flushIdle();
    assert.equal(test.tabs[1].classes.get('loading'), true, 'idle PCB preload exposes its spinner before rendering');
    test.flushFrame();
    test.flushFrame();
    assert.equal(test.events.at(-1), 'preload', 'PCB rendering starts during idle after recovery');
    assert.equal(test.tabs[1].classes.get('loading'), false, 'idle PCB rendering clears its spinner');
}

{
    const test = fixture();
    test.bootstrap._initializeStartupSplash = async () => test.events.push('splash');
    const initialization = test.bootstrap.initialize();
    assert.equal(test.events.includes('splash'), false, 'startup splash waits for autosave recovery');
    test.finishRecovery(false);
    await initialization;
    assert.ok(test.events.indexOf('recover') < test.events.indexOf('splash'));
    assert.ok(test.events.indexOf('splash') < test.events.indexOf('autosave'));
}

{
    const test = fixture();
    test.bootstrap.schematicApp = { shapes: [], components: [] };
    test.bootstrap.pcbApp = {
        tracks: [], vias: [], boardShapes: [], texts: new Map(),
        _placementOverrides: new Map(), _boardOutlineDrawn: false,
    };
    assert.equal(test.bootstrap._isProjectBlank(), true);
    test.bootstrap.pcbApp.tracks.push({});
    assert.equal(test.bootstrap._isProjectBlank(), false, 'PCB content suppresses the splash');
    test.bootstrap.pcbApp.tracks.length = 0;
    test.bootstrap.schematicApp.components.push({});
    assert.equal(test.bootstrap._isProjectBlank(), false, 'schematic content suppresses the splash');
}

{
    const test = fixture();
    const loadingPaint = test.bootstrap.project.onLoadingChange(true);
    for (const tab of test.tabs) {
        assert.equal(tab.classes.get('loading'), true);
        assert.equal(tab.attributes.get('aria-busy'), 'true');
    }
    await loadingPaint;
    await test.bootstrap.project.onLoadingChange(false);
    for (const tab of test.tabs) {
        assert.equal(tab.classes.get('loading'), false);
        assert.equal(tab.attributes.has('aria-busy'), false);
    }
}

{
    const test = fixture();
    test.bootstrap.pcbApp = { _stale: true, activate() { this._stale = false; test.events.push('activate'); } };
    const switching = test.bootstrap.switchMode('pcb');
    assert.equal(test.tabs[1].classes.get('loading'), true, 'PCB spinner appears before deferred rendering');
    assert.equal(test.events.includes('activate'), false, 'PCB rendering waits until the spinner can paint');
    test.flushFrame();
    await Promise.resolve();
    assert.equal(test.events.includes('activate'), false, 'one frame is reserved to paint the spinner');
    test.flushFrame();
    await switching;
    assert.equal(test.events.at(-1), 'activate');
    assert.equal(test.tabs[1].classes.get('loading'), false, 'PCB spinner clears after activation finishes');
    assert.equal(test.tabs[1].attributes.has('aria-busy'), false);
}

{
    const test = fixture();
    const initialization = test.bootstrap.initialize();
    test.failRecovery(new Error('Recovery failed'));
    await assert.rejects(initialization, /Recovery failed/);
    test.click();
    test.flushFrame();
    await Promise.resolve();
    test.flushFrame();
    await Promise.resolve();
    assert.equal(test.events.at(-1), 'activate', 'recovery failure does not leave the PCB tab unwired');
}
console.log('PASS: PCB tabs are wired before recovery completes and remain guarded during document loading');