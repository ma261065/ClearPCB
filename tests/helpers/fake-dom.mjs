/**
 * A small DOM for Node tests: enough of window, document and elements for editor
 * code that builds SVG/HTML, wires listeners and reads attributes, without a
 * browser. Prefer this over a per-test `globalThis.document = {...}` stub, which
 * drifts as the code grows (test-fixture-ratchet counts those).
 *
 * Install it before importing editor modules, since some read globals at load:
 *   import { installFakeDom } from './helpers/fake-dom.mjs';
 *   installFakeDom();
 *   const { default: PCBApp } = await import('../src/ui/PCBApp.js');
 */

function matches(element, selector) {
    if (selector.startsWith('#')) return element.id === selector.slice(1);
    if (selector.startsWith('.')) return element.classList.contains(selector.slice(1));
    const attribute = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(selector);
    if (attribute) return element.hasAttribute(attribute[1]) && (attribute[2] === undefined
        || element.getAttribute(attribute[1]) === attribute[2]);
    return element.tagName === selector.toLowerCase();
}

/** A fake element: attributes, children, listeners, classes, style and simple selectors. */
export function fakeElement(tagName = 'div') {
    const attributes = new Map();
    const listeners = new Map();
    const classes = new Set();
    const element = {
        tagName: String(tagName).toLowerCase(),
        children: [],
        parentNode: null,
        style: {},
        dataset: {},
        textContent: '',
        innerHTML: '',
        listeners,
        get id() { return attributes.get('id') ?? ''; },
        set id(value) { attributes.set('id', String(value)); },
        get className() { return [...classes].join(' '); },
        set className(value) { classes.clear(); for (const name of String(value).split(/\s+/).filter(Boolean)) classes.add(name); },
        get firstChild() { return element.children[0] || null; },
        get isConnected() {
            let node = element;
            while (node.parentNode) node = node.parentNode;
            return node === globalThis.document?.body || node === globalThis.document?.documentElement;
        },
        classList: {
            add: (...names) => names.forEach(name => classes.add(name)),
            remove: (...names) => names.forEach(name => classes.delete(name)),
            toggle: (name, force = !classes.has(name)) => { if (force) classes.add(name); else classes.delete(name); return force; },
            contains: name => classes.has(name),
        },
        setAttribute(name, value) {
            if (name === 'class') element.className = value;
            else attributes.set(name, String(value));
        },
        getAttribute(name) { return name === 'class' ? element.className || null : attributes.get(name) ?? null; },
        hasAttribute(name) { return name === 'class' ? classes.size > 0 : attributes.has(name); },
        removeAttribute(name) { attributes.delete(name); },
        appendChild(child) {
            child.parentNode?.removeChild?.(child);
            child.parentNode = element;
            element.children.push(child);
            return child;
        },
        insertBefore(child, before) {
            child.parentNode?.removeChild?.(child);
            child.parentNode = element;
            const index = element.children.indexOf(before);
            element.children.splice(index < 0 ? element.children.length : index, 0, child);
            return child;
        },
        removeChild(child) {
            element.children = element.children.filter(item => item !== child);
            child.parentNode = null;
            return child;
        },
        remove() { element.parentNode?.removeChild(element); },
        contains(node) {
            for (let current = node; current; current = current.parentNode) if (current === element) return true;
            return false;
        },
        querySelectorAll(selector) {
            const found = [];
            const walk = node => {
                for (const child of node.children) {
                    if (matches(child, selector)) found.push(child);
                    walk(child);
                }
            };
            walk(element);
            return found;
        },
        querySelector(selector) { return element.querySelectorAll(selector)[0] || null; },
        addEventListener(type, callback) {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(callback);
        },
        removeEventListener(type, callback) {
            listeners.set(type, (listeners.get(type) || []).filter(item => item !== callback));
        },
        dispatchEvent(event) {
            for (const callback of listeners.get(event.type) || []) callback(event);
            return true;
        },
        getBBox() { return { x: 0, y: 0, width: 0, height: 0 }; },
        getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }; },
    };
    return element;
}

/**
 * Install window, document, requestAnimationFrame and localStorage globals.
 * @param {{theme?: 'dark'|'light'}} [options]
 * @returns {any} the fake document
 */
export function installFakeDom({ theme = 'dark' } = {}) {
    const documentElement = fakeElement('html');
    documentElement.setAttribute('data-theme', theme);
    const body = fakeElement('body');
    documentElement.appendChild(body);
    const listeners = fakeElement('#document');
    const document = {
        documentElement,
        body,
        createElement: tag => fakeElement(tag),
        createElementNS: (_namespace, tag) => fakeElement(tag),
        getElementById: id => documentElement.querySelector(`#${id}`),
        querySelector: selector => documentElement.querySelector(selector),
        querySelectorAll: selector => documentElement.querySelectorAll(selector),
        addEventListener: listeners.addEventListener,
        removeEventListener: listeners.removeEventListener,
        dispatchEvent: listeners.dispatchEvent,
    };
    const storage = new Map();
    globalThis.document = document;
    globalThis.window ??= /** @type {any} */ ({});
    Object.assign(globalThis.window, {
        addEventListener() {}, removeEventListener() {},
        requestAnimationFrame: callback => setTimeout(callback, 0),
        cancelAnimationFrame: id => clearTimeout(id),
        getSelection: () => null,
    });
    globalThis.requestAnimationFrame ??= globalThis.window.requestAnimationFrame;
    globalThis.cancelAnimationFrame ??= globalThis.window.cancelAnimationFrame;
    globalThis.localStorage ??= {
        getItem: key => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, String(value)),
        removeItem: key => storage.delete(key),
        key: index => [...storage.keys()][index] ?? null,
        get length() { return storage.size; },
    };
    return document;
}
