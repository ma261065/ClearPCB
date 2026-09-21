import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/ui/AppBootstrap.js', import.meta.url), 'utf8');
const start = source.indexOf('class AppBootstrap {');
const end = source.indexOf('\ndocument.addEventListener(', start);
assert.ok(start >= 0 && end > start);

function fixture() {
    let finishRecovery, failRecovery;
    const recovery = new Promise((resolve, reject) => { finishRecovery = resolve; failRecovery = reject; });
    const events = [];
    const frames = [];
    const idleCallbacks = new Map();
    let idleId = 0;
    const tabs = ['schematic', 'pcb'].map(mode => ({
        dataset: { mode }, listeners: [], classes: new Map(), attributes: new Map(),
        classList: { toggle(name, value) { this.owner.classes.set(name, value); } },
        addEventListener(type, handler) { this.listeners.push({ type, handler }); },
        setAttribute(name, value) { this.attributes.set(name, value); },
        removeAttribute(name) { this.attributes.delete(name); },
        blur() {},
    })).map(tab => { tab.classList.owner = tab; return tab; });
    const window = {
        requestAnimationFrame(callback) { frames.push(callback); },
        cancelAnimationFrame() {},
        requestIdleCallback(callback) { idleCallbacks.set(++idleId, callback); return idleId; },
        cancelIdleCallback(id) { idleCallbacks.delete(id); },
    };
    const dependencies = {
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
    return { bootstrap, tabs, events, click, flushFrame, flushIdle, finishRecovery, failRecovery };
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