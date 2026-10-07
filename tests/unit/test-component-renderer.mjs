import assert from 'node:assert/strict';
import { Component } from '../../src/components/Component.js';
import {
    buildComponentSymbol,
    componentPinElement,
    discardComponent,
    rebuildComponentSymbol,
    renderComponent,
} from '../../src/schematic/render/component-renderer.js';
import { componentViewOf } from '../../src/schematic/render/shape-view-state.js';

class Element {
    constructor(tagName) {
        this.tagName = tagName;
        this.children = [];
        this.parentNode = null;
        this.attributes = new Map();
        this.style = {};
        this.dataset = {};
        this.classList = {
            classes: new Set(),
            add: name => this.classList.classes.add(name),
            remove: name => this.classList.classes.delete(name),
            toggle: (name, force) => {
                const next = force === undefined ? !this.classList.classes.has(name) : !!force;
                if (next) this.classList.classes.add(name);
                else this.classList.classes.delete(name);
                return next;
            },
            contains: name => this.classList.classes.has(name),
        };
        this.listeners = new Map();
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
    setAttribute(name, value) {
        this.attributes.set(name, String(value));
        if (name === 'class') this.classList.add(String(value));
    }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    dispatchEvent(event) { this.listeners.get(event.type)?.(event); return true; }
    querySelector(selector) {
        const wanted = selector.toLowerCase();
        const stack = [...this.children];
        while (stack.length) {
            const child = stack.shift();
            if (child.tagName === wanted) return child;
            stack.unshift(...child.children);
        }
        return null;
    }
    get firstChild() { return this.children[0] || null; }
    get nextSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] || null; }
    set textContent(value) {
        for (const child of [...this.children]) child.remove();
        this._text = String(value);
    }
    get textContent() {
        return this._text + this.children.map(child => child.textContent).join('');
    }
}

let created = 0;
globalThis.document = {
    createElementNS(_namespace, tagName) {
        created++;
        return new Element(tagName);
    },
};

function component(id = 'U1') {
    return new Component({
        name: 'RendererTest',
        symbol: {
            width: 4,
            height: 2,
            origin: { x: 0, y: 0 },
            graphics: [
                { type: 'rect', x: -1, y: -1, width: 2, height: 2 },
                { type: 'line', x1: -1, y1: 0, x2: 1, y2: 0 },
            ],
            pins: [
                { number: '1', name: 'IN', x: -2, y: 0, length: 2, orientation: 'right', _key: 'pin-1' },
                { number: '2', name: 'OUT', x: 2, y: 0, length: 2, orientation: 'left', _key: 'pin-2' },
            ],
        },
    }, { id, x: 5, y: 6, locked: true });
}

function tags(element) {
    return [element.tagName, ...element.children.flatMap(tags)];
}

{
    const comp = component('state');
    assert.equal(componentViewOf(comp), undefined);
    const element = buildComponentSymbol(comp);
    assert.equal(componentViewOf(comp).element, element);
    assert.equal(componentPinElement(comp, 'pin-1')?.tagName, 'g');

    const parent = new Element('svg');
    parent.appendChild(element);
    discardComponent(comp);
    assert.equal(componentViewOf(comp), undefined);
    assert.equal(element.parentNode, null);
}

{
    const comp = component('pose');
    const parent = new Element('svg');
    const before = parent.appendChild(buildComponentSymbol(comp));
    const beforeTags = tags(before);

    created = 0;
    comp.rotate(90);
    comp.flipHorizontal();
    assert.equal(created, 0, 'model pose changes do not create SVG');
    assert.equal(componentViewOf(comp).element, before, 'model pose changes do not replace SVG');

    const after = rebuildComponentSymbol(comp);
    assert.notEqual(after, before);
    assert.equal(after.parentNode, parent);
    assert.deepEqual(tags(after), beforeTags, 'rebuild preserves symbol DOM structure');
    assert.match(after.getAttribute('transform'), /^translate\(.+\) rotate\(/);
}

{
    const comp = component('selected');
    const element = buildComponentSymbol(comp);
    const selectedView = { isSelected: item => item === comp, isHovered: () => false };
    renderComponent(comp, 10, { selection: selectedView });

    assert.equal(element.firstChild.getAttribute('class'), 'component-highlight');
    assert.equal(componentPinElement(comp, 'pin-1').querySelector('circle').getAttribute('display'), '');
    assert.equal(componentViewOf(comp).lockIconEl?.getAttribute('class'), 'component-lock-icon');
    assert.equal(comp._dirty, false);

    const emptyView = { isSelected: () => false, isHovered: () => false };
    renderComponent(comp, 10, { selection: emptyView });
    assert.notEqual(element.firstChild.getAttribute('class'), 'component-highlight');
    assert.equal(componentPinElement(comp, 'pin-1').querySelector('circle').getAttribute('display'), 'none');
    assert.equal(componentViewOf(comp).lockIconEl, null);
}

console.log('PASS component renderer owns view state, rebuilds symbols, and renders selection visuals');
