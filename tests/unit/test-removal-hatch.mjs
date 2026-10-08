import assert from 'node:assert/strict';
import { fakeElement, installFakeDom } from './helpers/fake-dom.mjs';
import { pcbEditorStubs } from './helpers/pcb-editor-stubs.mjs';

function descendants(node) {
    return node.children.flatMap(child => [child, ...descendants(child)]);
}

function element(tagName) {
    const el = fakeElement(tagName);
    el.localName = el.tagName;
    el.style.setProperty = (name, value) => { el.style[name] = value; };
    const querySelectorAll = el.querySelectorAll.bind(el);
    el.querySelectorAll = selector => {
        const prefix = /^\[([\w-]+)\^="(.*)"\]$/.exec(selector);
        return prefix ? descendants(el).filter(child => child.getAttribute(prefix[1])?.startsWith(prefix[2]))
            : querySelectorAll(selector);
    };
    el.querySelector = selector => el.querySelectorAll(selector)[0] || null;
    return el;
}

const document = installFakeDom();
document.createElement = tag => element(tag);
document.createElementNS = (_ns, tag) => element(tag);

const { removalHatchFill, stripRemovalHatches } = await import('../../src/pcb/modules/removal-hatch.js');
const { getBoardShapeElement, renderBoardShape } = await import('../../src/pcb/modules/board-shape-render.js');
const { default: PCBApp } = await import('../../src/ui/PCBApp.js');

const patternsIn = defs => defs.children.filter(child => child.tagName === 'pattern');
const appWithDefs = (defs, scale = 4) => {
    defs.setAttribute('data-pcb-defs', '');
    const svg = element('svg');
    svg.appendChild(defs);
    return { viewport: { scale, svg } };
};

// One pattern per removal mode, in the editor's defs, sized in board millimetres.
{
    const defs = element('defs');
    const app = appWithDefs(defs);
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
    const nextDefs = element('defs');
    nextDefs.setAttribute('data-pcb-defs', '');
    app.viewport.svg.children = [nextDefs];
    nextDefs.parentNode = app.viewport.svg;
    removalHatchFill(app, 'remove-copper');
    assert.equal(patternsIn(nextDefs).length, 1, 'A new <defs> gets the pattern again');
    const sibling = appWithDefs(nextDefs, 2);
    removalHatchFill(sibling, 'remove-copper');
    assert.equal(patternsIn(nextDefs).length, 1, 'An existing pattern is not duplicated');
}
console.log('PASS removal hatch patterns: one per mode, reused, in board units, none for additive copper');

// Removal shapes are filled with their hatch; additive copper keeps its colour.
{
    const defs = element('defs');
    const groups = new Map();
    const app = { ...pcbEditorStubs(),
        ...appWithDefs(defs, 1), _shapeElements: new Map(),
        getLayerGroup(id) { if (!groups.has(id)) groups.set(id, element('g')); return groups.get(id); },
    };
    const circle = { kind: 'circle', x: 0, y: 0, radius: 2, layer: 'top-copper', filled: true, lineWidth: 0.2 };
    renderBoardShape(app, { ...circle, id: 'cut', copperMode: 'remove-copper' });
    renderBoardShape(app, { ...circle, id: 'mask', copperMode: 'remove-solder-mask' });
    renderBoardShape(app, { ...circle, id: 'ring', copperMode: 'remove-copper-mask', filled: false });
    renderBoardShape(app, { ...circle, id: 'pad', copperMode: 'add' });
    assert.equal(getBoardShapeElement(app, 'cut').getAttribute('fill'), 'url(#pcb-removal-hatch-remove-copper)');
    assert.equal(getBoardShapeElement(app, 'mask').getAttribute('fill'), 'url(#pcb-removal-hatch-remove-solder-mask)');
    assert.equal(getBoardShapeElement(app, 'ring').getAttribute('fill'), 'url(#pcb-removal-hatch-remove-copper-mask)',
        'An outlined removal shape is hatched across its removal band');
    assert.doesNotMatch(getBoardShapeElement(app, 'pad').getAttribute('fill'), /^url\(/);
    assert.ok(groups.get('top-copper-knockout').children.includes(getBoardShapeElement(app, 'cut')),
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
    const root = element('svg');
    const hatched = root.appendChild(element('path'));
    hatched.setAttribute('fill', 'url(#pcb-removal-hatch-remove-copper)');
    hatched.style.fill = 'url("#pcb-removal-hatch-remove-copper")';
    const copper = root.appendChild(element('g')).appendChild(element('path'));
    copper.setAttribute('fill', '#e74c3c');
    stripRemovalHatches(root);
    assert.equal(hatched.getAttribute('fill'), 'none');
    assert.equal(hatched.style.fill, 'none');
    assert.equal(copper.getAttribute('fill'), '#e74c3c', 'Other fills are untouched');
}
console.log('PASS exports strip removal hatching');
