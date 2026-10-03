import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Polyline } from '../src/shapes/polyline.js';
import { Text } from '../src/shapes/text.js';
import { renderShape } from '../src/schematic/render/shape-renderer.js';
import { deleteView, viewOf } from '../src/schematic/render/shape-view-state.js';

class Element {
    constructor(tagName) {
        this.tagName = tagName;
        this.children = [];
        this.parentNode = null;
        this.attributes = new Map();
        this.style = {};
        this.classList = {
            classes: new Set(),
            add: name => this.classList.classes.add(name),
            contains: name => this.classList.classes.has(name),
        };
        this._text = '';
    }
    appendChild(child) {
        child.parentNode?.removeChild(child);
        child.parentNode = this;
        this.children.push(child);
        return child;
    }
    insertBefore(child, before) {
        child.parentNode?.removeChild(child);
        child.parentNode = this;
        const index = before ? this.children.indexOf(before) : -1;
        this.children.splice(index < 0 ? this.children.length : index, 0, child);
        return child;
    }
    removeChild(child) {
        this.children.splice(this.children.indexOf(child), 1);
        child.parentNode = null;
        return child;
    }
    remove() { this.parentNode?.removeChild(this); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    get firstChild() { return this.children[0] || null; }
    get nextSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] || null; }
    set textContent(value) {
        for (const child of [...this.children]) child.remove();
        this._text = String(value);
    }
    get textContent() {
        return this._text + this.children.map(child => child.textContent).join('');
    }
    getBBox() {
        if (this.tagName === 'g') {
            const text = this.children.find(child => child.tagName === 'text');
            if (text) return text.getBBox();
        }
        if (this.tagName === 'text') {
            return {
                x: Number(this.getAttribute('x')) || 0,
                y: (Number(this.getAttribute('y')) || 0) - 3,
                width: 12,
                height: 3,
            };
        }
        return { x: 0, y: 0, width: 0, height: 0 };
    }
}

globalThis.document = {
    createElementNS(_namespace, tagName) { return new Element(tagName); },
};

{
    const shapesDir = fileURLToPath(new URL('../src/shapes/', import.meta.url));
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

console.log('PASS shape models are DOM-free and schematic renderers own class dispatch, view state, and text measurement');
