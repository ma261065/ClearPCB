import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const stored = new Map();
globalThis.localStorage = {
    getItem(key) { return stored.get(key) ?? null; },
    setItem(key, value) { stored.set(key, value); },
};
globalThis.window = new EventTarget();
globalThis.HTMLElement = class extends EventTarget {};
const buttons = new Map(['themeToggle', 'pcbThemeToggle'].map(id => [id, new HTMLElement()]));
const attributes = new Map();
globalThis.document = {
    getElementById(id) { return buttons.get(id) || null; },
    documentElement: {
        setAttribute(key, value) { attributes.set(key, value); },
        removeAttribute(key) { attributes.delete(key); },
    },
};
const shared = await import('../src/shared/ui/theme.js');
const { bindThemeToggle, toggleTheme, loadTheme } = await import('../src/ui/modules/theme.js');
let schematicUpdates = 0;
let pcbUpdates = 0;
let symbols = 0;
const schematic = {
    viewport: { updateTheme() { schematicUpdates++; }, addComponentContent() {} },
    components: [{ createSymbolElement() { symbols++; return {}; } }],
    _toggleTheme() { toggleTheme(this); },
    _loadTheme() { loadTheme(this); },
};
bindThemeToggle(schematic);
const source = readFileSync(new URL('../src/ui/PCBApp.js', import.meta.url), 'utf8');
const start = source.indexOf('    _bindThemeToggle() {');
const end = source.indexOf('\n    //', start);
assert.ok(start >= 0 && end > start);
const bindPCB = new Function('toggleSharedTheme', 'syncThemeToggleButtons',
    `return ({ ${source.slice(start, end)} })._bindThemeToggle;`)(shared.toggleTheme, shared.syncThemeToggleButtons);
bindPCB.call({
    themeToggle: buttons.get('pcbThemeToggle'),
    viewport: { updateTheme() { pcbUpdates++; } },
});
schematicUpdates = 0;
for (const [index, id] of ['pcbThemeToggle', 'themeToggle', 'themeToggle', 'pcbThemeToggle'].entries()) {
    buttons.get(id).dispatchEvent(new Event('click'));
    const expected = index % 2 === 0 ? 'light' : 'dark';
    assert.equal(shared.getSavedTheme(), expected);
    assert.equal(attributes.get('data-theme') || 'dark', expected);
    assert.equal(schematicUpdates, index + 1, 'Either toggle refreshes the schematic once');
    assert.equal(pcbUpdates, index + 1, 'Either toggle refreshes PCB once');
    assert.equal(symbols, index + 1, 'Either toggle refreshes schematic symbols');
    for (const button of buttons.values()) assert.equal(button.textContent, shared.getThemeIcon(expected));
}
console.log('PASS either editor theme toggle updates both viewports, schematic symbols, button icons, and saved theme');