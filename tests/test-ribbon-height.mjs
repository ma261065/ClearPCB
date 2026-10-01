import assert from 'node:assert/strict';
import { bindRibbonHeight } from '../src/ui/modules/ribbon-height.js';

function fixture() {
    const frames = [], listeners = {}, fontListeners = {};
    globalThis.window = { addEventListener(name, fn) { listeners[name] = fn; } };
    globalThis.document = { fonts: { addEventListener(name, fn) { fontListeners[name] = fn; } } };
    globalThis.requestAnimationFrame = fn => frames.push(fn);
    let width = 1000, reads = 0, writes = 0, failure = false;
    const panels = [50.25, 73.5, 62].map((height, index) => ({
        height, active: index === 1,
        classList: {
            contains() { return panels[index].active; },
            toggle(_name, active) { writes++; panels[index].active = active; },
        },
    }));
    const container = {
        style: { minHeight: '' },
        getBoundingClientRect() {
            reads++;
            if (failure && panels[0].active) throw new Error('measurement failed');
            return { width, height: Math.max(Number.parseFloat(this.style.minHeight) || 0,
                ...panels.filter(panel => panel.active).map(panel => panel.height)) };
        },
    };
    const ribbon = { querySelector: () => container, querySelectorAll: () => panels };
    const retain = bindRibbonHeight(ribbon);
    return { retain, panels, container, frames, listeners, fontListeners,
        resize(value) { width = value; listeners.resize(); },
        fail(value) { failure = value; },
        work: () => ({ reads, writes }), flush: () => frames.splice(0).forEach(fn => fn()) };
}

{
    const f = fixture();
    f.retain();
    assert.equal(f.container.style.minHeight, '74px');
    assert.deepEqual(f.panels.map(panel => panel.active), [false, true, false]);
    const before = f.work();
    for (let i = 0; i < 1000; i++) f.retain();
    assert.equal(f.work().writes, before.writes, 'Unchanged width never cycles panel classes');
    assert.equal(f.work().reads - before.reads, 1000, 'Cache hits need one container read, not one per panel');
    f.panels[1].active = false; f.panels[2].active = true;
    f.retain();
    assert.deepEqual(f.panels.map(panel => panel.active), [false, false, true]);
    assert.equal(f.work().writes, before.writes, 'Switching the visible tab reuses the same maximum');
}

{
    const f = fixture();
    f.retain();
    f.panels[1].height = 55;
    for (let i = 0; i < 100; i++) f.resize(800);
    assert.equal(f.frames.length, 1, 'Resize measurement is coalesced');
    assert.equal(f.container.style.minHeight, '74px', 'Resize does not clear the height before its frame');
    f.flush();
    assert.equal(f.container.style.minHeight, '62px', 'Narrower/wider layouts can shrink as well as grow');
    f.resize(0); f.flush();
    assert.equal(f.container.style.minHeight, '62px', 'Hidden ribbons do not overwrite retained height with zero');
    f.panels[0].height = 90.1;
    f.resize(700); f.flush();
    assert.equal(f.container.style.minHeight, '91px');
}

{
    const f = fixture();
    f.resize(0); f.flush();
    assert.equal(f.work().writes, 0, 'Initial hidden measurement does not cycle tabs');
    f.resize(1000); f.flush();
    const before = f.work();
    f.panels[0].height = 99;
    f.fontListeners.loadingdone(); f.flush();
    assert.equal(f.container.style.minHeight, '99px', 'Font metrics invalidate the width cache');
    assert.ok(f.work().writes > before.writes);
    f.container.style.minHeight = '';
    f.retain();
    assert.equal(f.container.style.minHeight, '99px', 'Externally cleared retained styles are repaired');
}

{
    const f = fixture();
    f.retain();
    f.resize(750);
    f.fail(true);
    assert.throws(() => f.flush(), /measurement failed/);
    assert.deepEqual(f.panels.map(panel => panel.active), [false, true, false]);
    assert.equal(f.container.style.minHeight, '74px', 'Failure preserves presentation');
    f.fail(false);
    const before = f.work();
    f.retain();
    assert.ok(f.work().writes > before.writes, 'Failed measurements are not cached');
}

console.log('PASS ribbon height reuse, resize/font invalidation, hidden layouts, coalescing and failure restoration');
