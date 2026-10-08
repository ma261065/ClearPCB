/**
 * Schematic view lifecycle boundary. Only schematic-view.js creates, attaches,
 * redraws, culls or detaches entity SVG; commands, file loading, clipboard, theme
 * and editor code call its helpers. Entity SVG is built by schematic renderers.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    mountShape, unmountShape, ensureShapeMounted, redrawShape, mountComponent, unmountComponent,
    rebuildComponentSymbol, refreshComponentPose, discardShapeView, discardComponentView,
    prepareDocumentView, mountDocument, withContentDetached, cloneEntityElement, viewElementOf, isCulled,
} from '../../src/schematic/modules/schematic-view.js';
import { Shape } from '../../src/shapes/shape.js';
import { Component } from '../../src/components/Component.js';
import { ensureView, viewOf, componentViewOf } from '../../src/schematic/render/shape-view-state.js';
import { fakeElement, installFakeDom } from './helpers/fake-dom.mjs';

function node(name) {
    const element = fakeElement(name);
    element.name = name;
    element.removed = 0;
    element.attributes = new Map();
    const setAttribute = element.setAttribute.bind(element);
    const getAttribute = element.getAttribute.bind(element);
    const removeAttribute = element.removeAttribute.bind(element);
    const remove = element.remove.bind(element);
    element.setAttribute = (key, value) => { element.attributes.set(key, String(value)); setAttribute(key, value); };
    element.getAttribute = key => element.attributes.get(key) ?? getAttribute(key);
    element.removeAttribute = key => { element.attributes.delete(key); removeAttribute(key); };
    element.remove = () => { element.removed++; remove(); };
    element.cloneNode = () => ({ clonedFrom: element });
    return element;
}

function viewApp() {
    const svg = node('svg');
    const contentLayer = svg.appendChild(node('content'));
    const after = svg.appendChild(node('overlay'));
    const componentLayer = node('components');
    return {
        svg, after,
        viewport: {
            scale: 4, contentLayer, componentLayer,
            addContent(element) { contentLayer.appendChild(element); },
            addComponentContent(element) { componentLayer.appendChild(element); },
            removeContent(element) {
                if (element.parentNode === contentLayer || element.parentNode === componentLayer) {
                    element.parentNode.removeChild(element);
                }
            },
        },
    };
}

const document = installFakeDom();
document.createElementNS = (_namespace, tag) => node(tag);

class TestShape extends Shape {
    constructor(id) { super({ id }); this._culled = false; }
    clone() { return new TestShape(this.id + '-clone'); }
}

function shape(id) {
    return new TestShape(id);
}

function component(id) {
    return new Component({
        name: id,
        symbol: {
            width: 2,
            height: 2,
            origin: { x: 0, y: 0 },
            graphics: [{ type: 'rect', x: 0, y: 0, width: 2, height: 2 }],
            pins: [],
        },
    }, { id, x: 1, y: 2 });
}

{
    const app = viewApp();
    const wire = shape('wire');
    mountShape(app, wire);
    assert.equal(viewOf(wire).lastScale, 4, 'mount draws at the current scale');
    assert.equal(viewOf(wire).element.parentNode, app.viewport.contentLayer, 'mount attaches to the content layer');
    ensureShapeMounted(app, wire);
    const mountedElement = viewOf(wire).element;
    ensureShapeMounted(app, wire);
    assert.equal(viewOf(wire).element, mountedElement, 'an attached shape is not mounted twice');

    ensureView(wire).anchorsGroup = app.viewport.contentLayer.appendChild(node('anchors'));
    const element = viewOf(wire).element;
    unmountShape(wire);
    assert.equal(element.parentNode || viewOf(wire).anchorsGroup.parentNode, null, 'unmount detaches SVG and handles');
    assert.equal(viewOf(wire).element, element, 'unmount keeps the SVG for undo');
    ensureShapeMounted(app, wire);
    assert.equal(viewOf(wire).element.parentNode, app.viewport.contentLayer, 'a detached shape is mounted again');
    redrawShape(app, wire);
    assert.equal(viewOf(wire).lastScale, 4);

    assert.equal(viewElementOf(wire), viewOf(wire).element);
    assert.equal(viewElementOf(null), null);
    assert.equal(cloneEntityElement(wire).clonedFrom, viewOf(wire).element);
    assert.equal(cloneEntityElement(shape('bare')), null, 'entities without SVG have no ghost');
    assert.equal(isCulled(wire), false);
    wire._culled = true;
    assert.equal(isCulled(wire), true);

    discardShapeView(app, wire);
    assert.equal(viewOf(wire), undefined);
    assert.equal(app.viewport.contentLayer.children.length, 0);
}

{
    const app = viewApp();
    const part = component('U1');
    mountComponent(app, part);
    mountComponent(app, part);
    const mounted = componentViewOf(part).element;
    assert.equal(componentViewOf(part).element, mounted, 'mount reuses an existing symbol');
    assert.equal(mounted.parentNode, app.viewport.componentLayer);

    refreshComponentPose(part);
    assert.equal(componentViewOf(part).element.attributes.get('transform'), 'translate(1,2)');
    assert.equal(componentViewOf(part).element, mounted, 'a translation keeps the symbol');
    part.x = 0;
    part.y = 0;
    refreshComponentPose(part, { rebuild: true });
    assert.notEqual(componentViewOf(part).element, mounted, 'rotation or mirror rebuilds the symbol');
    assert.equal(componentViewOf(part).element.attributes.has('transform'), false, 'an identity pose clears the transform');

    const before = componentViewOf(part).element;
    rebuildComponentSymbol(app, part);
    assert.equal(before.removed, 1);
    assert.notEqual(componentViewOf(part).element, before);
    assert.equal(componentViewOf(part).element.parentNode, app.viewport.componentLayer, 'a rebuilt symbol is attached');

    unmountComponent(part);
    assert.equal(componentViewOf(part).element.parentNode, null);
    unmountComponent(component('unbuilt'));
    discardComponentView(app, part);
    assert.equal(componentViewOf(part), undefined);
}

{
    const app = viewApp();
    const wire = shape('wire');
    const part = component('U2');
    prepareDocumentView(app, { shapes: [{ shape: wire }], components: [part] });
    assert.equal((viewOf(wire)?.element ? 1 : 0) + (componentViewOf(part)?.element ? 1 : 0), 2, 'prepared documents get SVG before they go live');
    assert.equal(viewOf(wire).element.parentNode || componentViewOf(part).element.parentNode, null, 'prepared SVG is not attached yet');
    app.shapes = [wire];
    app.components = [part];
    mountDocument(app);
    assert.equal(viewOf(wire).element.parentNode, app.viewport.contentLayer);
    assert.equal(componentViewOf(part).element.parentNode, app.viewport.componentLayer);
}

{
    const app = viewApp();
    const layer = app.viewport.contentLayer;
    const value = withContentDetached(app, () => {
        assert.equal(layer.parentNode, null, 'work runs with the content layer detached');
        return 7;
    });
    assert.equal(value, 7);
    assert.deepEqual(app.svg.children, [layer, app.after], 'the layer returns to its original position');
    assert.throws(() => withContentDetached(app, () => { throw new Error('boom'); }), /boom/);
    assert.deepEqual(app.svg.children, [layer, app.after], 'the layer is restored when work throws');
}

// Static guard: entity SVG lifecycle only inside schematic-view.js.
const src = fileURLToPath(new URL('../../src/', import.meta.url));
const files = [];
(function walk(dir) {
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name.endsWith('.js')) files.push(path);
    }
})(src);
const VIEW_LIFECYCLE = /\.render\(|\baddContent\(|\baddComponentContent\(|\bremoveContent\(|createSymbolElement\(|_recreateElement\(|_buildTransform\(|\.anchorsGroup\b|\.element\b|\bviewOf\(|\bensureView\(|\bcomponentViewOf\(|\bensureComponentView\(|\b_culled\b|\b_lodFar\b/;
// The inline text editor adds its own overlay, and the component picker owns its panel.
const allowed = new Set([
    'schematic/modules/text-edit.js: app.viewport.addContent(group);',
    'schematic/modules/text-edit.js: app.viewport.addContent(temp);',
    'schematic/modules/tool.js: const searchInput = app.componentPicker.element.querySelector(\'.cp-search-input\');',
]);
const offenders = [];
for (const file of files) {
    const rel = relative(src, file).split(sep).join('/');
    const editorCode = rel.startsWith('schematic/') || rel === 'ui/SchematicApp.js';
    if (!editorCode || rel === 'schematic/modules/schematic-view.js' || rel.startsWith('schematic/render/')) continue;
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
        const text = line.trim();
        if (text.startsWith('//') || text.startsWith('*')) continue;
        if (VIEW_LIFECYCLE.test(text) && !allowed.has(`${rel}: ${text}`)) offenders.push(`${rel}: ${text}`);
    }
}
assert.deepEqual(offenders, [], 'schematic editor code manages entity SVG only through schematic-view.js');

console.log('PASS schematic view lifecycle: mount/unmount/redraw/pose/discard/prepare/detach helpers and boundary guard');
