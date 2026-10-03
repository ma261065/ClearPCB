import assert from 'node:assert/strict';

const stored = new Map();
globalThis.localStorage = {
    getItem(key) { return stored.get(key) ?? null; },
    setItem(key, value) { stored.set(key, value); },
    removeItem(key) { stored.delete(key); },
};
globalThis.window = new EventTarget();
globalThis.HTMLElement = class extends EventTarget {};
const buttons = new Map(['themeToggle', 'pcbThemeToggle'].map(id => [id, new HTMLElement()]));
const attributes = new Map();
const element = () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {}, getAttribute: () => null, appendChild: child => child, remove() {}, addEventListener() {} });
globalThis.document = {
    getElementById(id) { return buttons.get(id) || null; },
    documentElement: {
        setAttribute(key, value) { attributes.set(key, value); },
        removeAttribute(key) { attributes.delete(key); },
        getAttribute(key) { return attributes.get(key) ?? null; },
    },
    body: element(), createElement: element, createElementNS: element,
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
};
const shared = await import('../src/shared/ui/theme.js');
const { bindThemeToggle, toggleTheme, loadTheme } = await import('../src/ui/modules/theme.js');
const { setPcbSelection } = await import('../src/pcb/modules/selection-registry.js');
const { pcbEditorFixture } = await import('./pcb-editor-fixture.mjs');
let schematicUpdates = 0;
let pcbUpdates = 0;
let symbols = 0;
const schematic = {
    viewport: { updateTheme() { schematicUpdates++; }, addComponentContent() {} },
    components: [{
        id: 'theme-comp',
        x: 0,
        y: 0,
        rotation: 0,
        symbol: { width: 1, height: 1, origin: { x: 0, y: 0 }, graphics: [], pins: [] },
        _getLocalBounds() { symbols++; return { minX: 0, minY: 0, maxX: 1, maxY: 1 }; },
    }],
    _toggleTheme() { toggleTheme(this); },
    _loadTheme() { loadTheme(this); },
};
bindThemeToggle(schematic);
const highlights = [];
const pcb = pcbEditorFixture({
    themeToggle: buttons.get('pcbThemeToggle'),
    viewport: { updateTheme() { pcbUpdates++; } },
    placements: new Map([['part', {}]]),
    _refreshRefHighlight(id) { highlights.push(id); },
});
setPcbSelection(pcb, [{ kind: 'reftext', object: 'part' }]);
highlights.length = 0;
pcb._bindThemeToggle();
schematicUpdates = 0;
for (const [index, id] of ['pcbThemeToggle', 'themeToggle', 'themeToggle', 'pcbThemeToggle'].entries()) {
    buttons.get(id).dispatchEvent(new Event('click'));
    const expected = index % 2 === 0 ? 'light' : 'dark';
    assert.equal(shared.getSavedTheme(), expected);
    assert.equal(attributes.get('data-theme') || 'dark', expected);
    assert.equal(schematicUpdates, index + 1, 'Either toggle refreshes the schematic once');
    assert.equal(pcbUpdates, index + 1, 'Either toggle refreshes PCB once');
    assert.deepEqual(highlights, Array(index + 1).fill('part'), 'Either toggle refreshes the selected reference highlight');
    assert.equal(symbols, index + 1, 'Either toggle refreshes schematic symbols');
    for (const button of buttons.values()) assert.equal(button.textContent, shared.getThemeIcon(expected));
}
console.log('PASS either editor theme toggle updates both viewports, schematic symbols, button icons, and saved theme');