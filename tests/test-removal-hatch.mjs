import assert from 'node:assert/strict';

// Minimal SVG DOM: attributes, children, '#id' and '[attr^="prefix"]' selectors.
class El {
    constructor(tagName) {
        this.tagName = tagName;
        this.attributes = new Map();
        this.children = [];
        this.parentNode = null;
        this.dataset = {};
        this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
        const props = {};
        this.style = { props, setProperty(name, value) { props[name] = value; } };
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
    removeAttribute(name) { this.attributes.delete(name); }
    appendChild(child) { child.parentNode?.removeChild(child); child.parentNode = this; this.children.push(child); return child; }
    removeChild(child) { this.children = this.children.filter(c => c !== child); child.parentNode = null; return child; }
    remove() { this.parentNode?.removeChild(this); }
    addEventListener() {}
    removeEventListener() {}
    *descendants() { for (const child of this.children) { yield child; yield* child.descendants(); } }
    querySelectorAll(selector) {
        const prefix = /^\[([\w-]+)\^="(.*)"\]$/.exec(selector);
        if (prefix) return [...this.descendants()].filter(el => el.getAttribute(prefix[1])?.startsWith(prefix[2]));
        if (selector.startsWith('#')) return [...this.descendants()].filter(el => el.getAttribute('id') === selector.slice(1));
        return [];
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

const noop = () => {};
globalThis.window = { addEventListener: noop, removeEventListener: noop, devicePixelRatio: 1 };
globalThis.document = {
    body: new El('body'), documentElement: { getAttribute: () => 'dark' },
    createElement: tag => new El(tag), createElementNS: (_ns, tag) => new El(tag),
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    addEventListener: noop, removeEventListener: noop,
};
globalThis.HTMLElement = class HTMLElement {};
globalThis.localStorage = { getItem: () => null, setItem: noop, removeItem: noop };

const { removalHatchFill, stripRemovalHatches } = await import('../src/pcb/modules/removal-hatch.js');
const { renderBoardShape } = await import('../src/pcb/modules/board-shapes.js');
const { default: PCBApp } = await import('../src/ui/PCBApp.js');

const patternsIn = defs => defs.children.filter(child => child.tagName === 'pattern');

// One pattern per removal mode, in the editor's defs, sized in board millimetres.
{
    const defs = new El('defs');
    const app = { viewport: { scale: 4 }, _ensureSvgDefs: () => defs };
    assert.equal(removalHatchFill(app, 'remove-copper'), 'url(#pcb-removal-hatch-remove-copper)');
    const [pattern] = patternsIn(defs);
    assert.equal(pattern.getAttribute('patternUnits'), 'userSpaceOnUse');
    assert.equal(pattern.getAttribute('patternTransform'), null, 'The hatch zooms with the board');
    assert.equal(pattern.children[0].getAttribute('stroke'), '#5f6770');
    assert.equal(removalHatchFill(app, 'remove-copper'), 'url(#pcb-removal-hatch-remove-copper)');
    assert.equal(patternsIn(defs).length, 1, 'A mode reuses its pattern');
    assert.equal(removalHatchFill(app, 'remove-solder-mask'), 'url(#pcb-removal-hatch-remove-solder-mask)');
    assert.equal(removalHatchFill(app, 'remove-copper-mask'), 'url(#pcb-removal-hatch-remove-copper-mask)');
    const paths = patternsIn(defs).map(p => p.children[0].getAttribute('d'));
    assert.equal(new Set(paths).size, 3, 'Each removal mode has its own hatch');
    assert.match(paths[1], / V /, 'Mask removal is a grid');
    for (const mode of ['add', undefined]) assert.equal(removalHatchFill(app, mode), 'none', `${mode} copper is not hatched`);
    assert.equal(patternsIn(defs).length, 3);
    assert.equal(removalHatchFill({ viewport: { scale: 1 } }, 'remove-copper'), 'none', 'No SVG, no hatch');

    // Replaced defs get their own pattern; another editor on the same defs reuses it.
    const nextDefs = new El('defs');
    app._ensureSvgDefs = () => nextDefs;
    removalHatchFill(app, 'remove-copper');
    assert.equal(patternsIn(nextDefs).length, 1, 'A new <defs> gets the pattern again');
    const sibling = { viewport: { scale: 2 }, _ensureSvgDefs: () => nextDefs };
    removalHatchFill(sibling, 'remove-copper');
    assert.equal(patternsIn(nextDefs).length, 1, 'An existing pattern is not duplicated');
}
console.log('PASS removal hatch patterns: one per mode, reused, in board units, none for additive copper');

// Removal shapes are filled with their hatch; additive copper keeps its colour.
{
    const defs = new El('defs');
    const groups = new Map();
    const app = {
        viewport: { scale: 1 }, _ensureSvgDefs: () => defs, _shapeElements: new Map(),
        getLayerGroup(id) { if (!groups.has(id)) groups.set(id, new El('g')); return groups.get(id); },
    };
    const circle = { kind: 'circle', x: 0, y: 0, radius: 2, layer: 'top-copper', filled: true, lineWidth: 0.2 };
    renderBoardShape(app, { ...circle, id: 'cut', copperMode: 'remove-copper' });
    renderBoardShape(app, { ...circle, id: 'mask', copperMode: 'remove-solder-mask' });
    renderBoardShape(app, { ...circle, id: 'ring', copperMode: 'remove-copper-mask', filled: false });
    renderBoardShape(app, { ...circle, id: 'pad', copperMode: 'add' });
    assert.equal(app._shapeElements.get('cut').getAttribute('fill'), 'url(#pcb-removal-hatch-remove-copper)');
    assert.equal(app._shapeElements.get('mask').getAttribute('fill'), 'url(#pcb-removal-hatch-remove-solder-mask)');
    assert.equal(app._shapeElements.get('ring').getAttribute('fill'), 'url(#pcb-removal-hatch-remove-copper-mask)',
        'An outlined removal shape is hatched across its removal band');
    assert.doesNotMatch(app._shapeElements.get('pad').getAttribute('fill'), /^url\(/);
    assert.ok(groups.get('top-copper-knockout').children.includes(app._shapeElements.get('cut')),
        'Copper removal draws in the knockout layer');
}
console.log('PASS removal shapes are filled with their hatch');

// Holes are stacked above every layer a removal hatch draws in, so they cover it.
{
    const order = [];
    const app = Object.assign(Object.create(PCBApp.prototype), {
        _layerGroups: new Map(), viewport: { addContent: g => order.push(g.getAttribute('data-layer')) },
    });
    app._createLayerGroups();
    const hole = order.indexOf('hole');
    assert.ok(hole >= 0);
    for (const layer of ['top-copper', 'bottom-copper', 'top-copper-knockout', 'bottom-copper-knockout', 'top-silk']) {
        assert.ok(order.indexOf(layer) >= 0 && order.indexOf(layer) < hole, `hole draws above ${layer}`);
    }
}
console.log('PASS holes are stacked above removal hatching');

// Exports show removal shapes as outlines, even after computed styles are inlined.
{
    const root = new El('svg');
    const hatched = root.appendChild(new El('path'));
    hatched.setAttribute('fill', 'url(#pcb-removal-hatch-remove-copper)');
    hatched.style.fill = 'url("#pcb-removal-hatch-remove-copper")';
    const copper = root.appendChild(new El('g')).appendChild(new El('path'));
    copper.setAttribute('fill', '#e74c3c');
    stripRemovalHatches(root);
    assert.equal(hatched.getAttribute('fill'), 'none');
    assert.equal(hatched.style.fill, 'none');
    assert.equal(copper.getAttribute('fill'), '#e74c3c', 'Other fills are untouched');
}
console.log('PASS exports strip removal hatching');
