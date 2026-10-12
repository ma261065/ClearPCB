import assert from 'node:assert/strict';
import { renderRecentFiles } from '../../src/shared/ui/recents.js';
import { fakeElement, installFakeDom } from './helpers/fake-dom.mjs';

const document = installFakeDom();
function element(tagName) {
    const el = fakeElement(tagName);
    el.dispatch = async (type, event = {}) => {
        for (const listener of el.listeners.get(type) || []) await listener(event);
    };
    return el;
}

document.createElement = tagName => element(tagName);

{
    const container = element('div');
    const opened = [];
    const removed = [];
    let entries = [
        { name: 'power.cpcb', path: 'C:\\Boards\\power.cpcb' },
        { name: 'sensor.cpcb', path: 'sensor.cpcb' },
    ];
    const fileManager = {
        async getRecentFiles() { return entries; },
        async removeRecent(name) {
            removed.push(name);
            entries = entries.filter(entry => entry.name !== name);
        },
    };

    await renderRecentFiles({
        container,
        getFileManager: () => fileManager,
        openRecent: name => opened.push(name),
    });

    assert.equal(container.children.length, 2);
    assert.equal(container.children[0].children[0].children[0].textContent, 'power.cpcb');
    assert.equal(container.children[0].children[0].children[1].textContent, 'C:\\Boards\\power.cpcb');
    await container.children[0].children[0].dispatch('click');
    assert.deepEqual(opened, ['power.cpcb']);

    let stopped = false;
    await container.children[0].children[1].dispatch('click', {
        stopPropagation() { stopped = true; },
    });
    assert.equal(stopped, true);
    assert.deepEqual(removed, ['power.cpcb']);
    assert.equal(container.children.length, 1, 'removing a recent refreshes the list');
    assert.match(container.children[0].children[1].getAttribute('aria-label'), /sensor\.cpcb/);
}

{
    const container = element('div');
    await renderRecentFiles({
        container,
        getFileManager: () => ({ getRecentFiles: async () => [] }),
        openRecent() {},
    });
    assert.equal(container.children.length, 1);
    assert.equal(container.children[0].className, 'dropdown-item recent-empty');
    assert.equal(container.children[0].textContent, 'No recent files');
}

console.log('Recent-files UI tests passed');
