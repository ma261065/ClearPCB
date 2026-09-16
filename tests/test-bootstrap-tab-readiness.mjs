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
    const tabs = ['schematic', 'pcb'].map(mode => ({
        dataset: { mode }, listeners: [], classList: { toggle() {} },
        addEventListener(type, handler) { this.listeners.push({ type, handler }); },
        blur() {},
    }));
    const window = {};
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
            initialize() { events.push('pcb-ready'); }
            activate() { events.push('activate'); }
            deactivate() { events.push('deactivate'); }
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
    return { bootstrap, tabs, events, click, finishRecovery, failRecovery };
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
    assert.equal(test.events.at(-1), 'activate', 'PCB is available before recovery bookkeeping finishes');
    assert.equal(test.events.includes('autosave'), false, 'autosave still waits for recovery');
    test.finishRecovery(true);
    await initialization;
    assert.deepEqual(test.events.slice(-2), ['autosave', 'launch']);
    assert.equal(test.tabs[1].listeners.length, 1, 'recovery completion does not duplicate tab listeners');
}

{
    const test = fixture();
    const initialization = test.bootstrap.initialize();
    test.failRecovery(new Error('Recovery failed'));
    await assert.rejects(initialization, /Recovery failed/);
    test.click();
    assert.equal(test.events.at(-1), 'activate', 'recovery failure does not leave the PCB tab unwired');
}
console.log('PASS: PCB tabs are wired before recovery completes and remain guarded during document loading');