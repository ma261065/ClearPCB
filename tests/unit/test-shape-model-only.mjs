import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Polyline } from '../../src/shapes/polyline.js';
import { Text } from '../../src/shapes/text.js';
import { Component } from '../../src/components/Component.js';
import { renderShape } from '../../src/schematic/render/shape-renderer.js';
import { deleteView, viewOf } from '../../src/schematic/render/shape-view-state.js';
import { fakeElement, installFakeDom } from './helpers/fake-dom.mjs';

const document = installFakeDom();
function svgElement(tagName) {
    const element = fakeElement(tagName);
    element.getBBox = () => {
        if (element.tagName === 'g') {
            const text = element.children.find(child => child.tagName === 'text');
            if (text) return text.getBBox();
        }
        if (element.tagName === 'text') {
            return {
                x: Number(element.getAttribute('x')) || 0,
                y: (Number(element.getAttribute('y')) || 0) - 3,
                width: 12,
                height: 3,
            };
        }
        return { x: 0, y: 0, width: 0, height: 0 };
    };
    return element;
}
document.createElementNS = (_namespace, tagName) => svgElement(tagName);

{
    const shapesDir = fileURLToPath(new URL('../../src/shapes/', import.meta.url));
    const allowed = new Set(['axis-glow.js', 'property-preview.js']);
    const offenders = [];
    for (const name of readdirSync(shapesDir)) {
        if (!name.endsWith('.js') || allowed.has(name)) continue;
        const source = readFileSync(join(shapesDir, name), 'utf8');
        for (const [index, line] of source.split(/\r?\n/).entries()) {
            if (/\bdocument\.|createElementNS|\.element\b|anchorsGroup|\brender\s*\(/.test(line)) {
                offenders.push(`${name}:${index + 1}: ${line.trim()}`);
            }
        }
    }
    assert.deepEqual(offenders, [], 'shape model files must not own schematic SVG rendering');
}

{
    const componentPath = fileURLToPath(new URL('../../src/components/Component.js', import.meta.url));
    const source = readFileSync(componentPath, 'utf8');
    const offenders = [];
    for (const [index, line] of source.split(/\r?\n/).entries()) {
        if (/\bdocument\.|createElementNS|\.element\b|pinElements|_highlightEl|_lockIconEl|_buildTransform|createSymbolElement|_recreateElement|\brender\s*\(/.test(line)) {
            offenders.push(`Component.js:${index + 1}: ${line.trim()}`);
        }
    }
    assert.deepEqual(offenders, [], 'Component model must not own schematic SVG rendering');

    const component = new Component({
        name: 'Guard',
        symbol: { width: 1, height: 1, origin: { x: 0, y: 0 }, graphics: [], pins: [] },
    }, { id: 'guard' });
    assert.equal('element' in component, false);
    assert.equal('pinElements' in component, false);
}

{
    const polyline = new Polyline({
        graphNodes: { a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, c: { x: 10, y: 10 } },
        graphEdges: { e0: { from: 'a', to: 'b' }, e1: { from: 'b', to: 'c' } },
    });
    polyline.applyState({ ...polyline.captureState(), type: 'wire' });
    const element = renderShape(polyline, 10);
    assert.equal(element.tagName, 'g');
    assert.equal(
        element.children.some(child => child.classList?.contains?.('pin-connection-dot')),
        false,
        'dispatch follows the Polyline class rather than the mutated type string',
    );
    assert.equal(viewOf(polyline).element, element);
    deleteView(polyline);
    assert.equal(viewOf(polyline), undefined);
}

{
    const text = new Text({ x: 2, y: 5, text: 'ABCD', fontSize: 2 });
    assert.deepEqual(text.getBounds(), { minX: 2, minY: 3, maxX: 6.8, maxY: 5 },
        'unrendered text falls back to the model estimate');
    text.invalidate();
    renderShape(text, 10);
    assert.equal(text._dirty, false);
    assert.deepEqual(text.getBounds(), { minX: 2, minY: 2, maxX: 14, maxY: 5 },
        'rendered text bounds use the renderer-registered measurer');
}

console.log('PASS shape/component models are DOM-free and schematic renderers own class dispatch, view state, and text measurement');
