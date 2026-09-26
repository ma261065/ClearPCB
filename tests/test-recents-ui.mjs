import assert from 'node:assert/strict';
import { renderRecentFiles } from '../src/ui/modules/recents.js';

class FakeElement {
    constructor(tagName) {
        this.tagName = tagName;
        this.children = [];
        this.listeners = new Map();
        this.attributes = new Map();
        this._textContent = '';
    }

    set textContent(value) {
        this._textContent = value;
        if (value === '') this.children = [];
    }

    get textContent() {
        return this._textContent || this.children.map(child => child.textContent).join('');
    }

    appendChild(child) {
        this.children.push(child);
        return child;
    }

    addEventListener(type, listener) {
        this.listeners.set(type, listener);
    }

    setAttribute(name, value) {
        this.attributes.set(name, value);
    }

    async dispatch(type, event = {}) {
        return await this.listeners.get(type)?.(event);
    }
}

globalThis.document = {
    createElement: tagName => new FakeElement(tagName),
};

{
    const container = new FakeElement('div');
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
    assert.match(container.children[0].children[1].attributes.get('aria-label'), /sensor\.cpcb/);
}

{
    const container = new FakeElement('div');
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
