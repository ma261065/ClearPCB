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

const dataKey = name => name.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase());

function decodeHtml(value) {
    return String(value).replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function parseAttributes(node, text) {
    for (const [, name, quoted, single, bare] of text.matchAll(/\s([:\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
        const value = decodeHtml(quoted ?? single ?? bare ?? '');
        if (['checked', 'disabled', 'selected', 'hidden'].includes(name)) node[name] = true;
        node.setAttribute(name, value);
    }
}

function populateInnerHtml(element, html) {
    const stack = [element];
    const tokenRe = /<(\/)?([a-z][\w-]*)([^>]*)>|([^<]+)/gi;
    const voidTags = new Set(['input', 'br', 'hr', 'img']);
    let match;
    while ((match = tokenRe.exec(html))) {
        const [, closing, rawTag, attrs = '', rawText] = match;
        if (rawText) {
            const content = decodeHtml(rawText);
            if (content) stack.at(-1).appendChild(Object.assign(fakeElement('#text'), { textContent: content }));
            continue;
        }
        const tag = rawTag.toLowerCase();
        if (closing) {
            while (stack.length > 1 && stack.at(-1).tagName !== tag) stack.pop();
            if (stack.length > 1) stack.pop();
            continue;
        }
        const node = fakeElement(tag);
        parseAttributes(node, attrs);
        if (tag === 'input') {
            node.type ||= node.getAttribute('type') || 'text';
            node.value ??= node.getAttribute('value') || '';
        } else if (tag === 'option') {
            node.value = node.getAttribute('value') || '';
        } else if (tag === 'button') {
            node.type ||= node.getAttribute('type') || 'submit';
        }
        stack.at(-1).appendChild(node);
        if (!voidTags.has(tag)) stack.push(node);
    }
    for (const select of element.querySelectorAll('select')) {
        const selected = select.children.find(child => child.tagName === 'option' && child.selected)
            || select.children.find(child => child.tagName === 'option');
        if (selected) select.value = selected.value;
    }
}

function attributeValue(element, name) {
    if (name === 'class') return element.className || null;
    if (name.startsWith('data-')) return element.dataset[dataKey(name)] ?? null;
    const attribute = element.getAttribute(name);
    if (attribute !== null) return attribute;
    const property = element[name];
    return property === undefined || property === null || typeof property === 'object'
        ? null : String(property);
}

function matches(element, selector) {
    const simple = /^([a-z][\w-]*)?(#[\w-]+)?((?:\.[\w-]+)*)(.*)$/i.exec(selector.trim());
    if (!simple) return false;
    const [, tag, id, classPart, rest] = simple;
    if (tag && element.tagName !== tag.toLowerCase()) return false;
    if (id && element.id !== id.slice(1)) return false;
    for (const name of classPart.match(/\.[\w-]+/g) || []) {
        if (!element.classList.contains(name.slice(1))) return false;
    }
    const attributes = [...rest.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)];
    if (attributes.map(match => match[0]).join('') !== rest) return false;
    for (const [, name, value] of attributes) {
        const actual = attributeValue(element, name);
        if (actual === null || (value !== undefined && actual !== value)) return false;
    }
    return true;
}

/** A fake element: attributes, children, listeners, classes, style and simple selectors. */
export function fakeElement(tagName = 'div') {
    const attributes = new Map();
    const listeners = new Map();
    const classes = new Set();
    let html = '';
    let text = '';
    const element = {
        tagName: String(tagName).toLowerCase(),
        children: [],
        parentNode: null,
        style: {},
        dataset: {},
        validationMessage: '',
        reports: 0,
        listeners,
        get textContent() { return text + element.children.map(child => child.textContent).join(''); },
        set textContent(value) {
            text = String(value);
            html = '';
            for (const child of element.children) child.parentNode = null;
            element.children = [];
        },
        get innerHTML() { return html; },
        set innerHTML(value) {
            html = String(value);
            text = '';
            if (element.contains(globalThis.document?.activeElement)) globalThis.document.activeElement = globalThis.document.body;
            for (const child of element.children) child.parentNode = null;
            element.children = [];
            populateInnerHtml(element, html);
        },
        get id() { return attributes.get('id') ?? ''; },
        set id(value) { attributes.set('id', String(value)); },
        get className() { return [...classes].join(' '); },
        set className(value) { classes.clear(); for (const name of String(value).split(/\s+/).filter(Boolean)) classes.add(name); },
        get firstChild() { return element.children[0] || null; },
        get valueAsNumber() { return element.value?.trim?.() === '' ? NaN : Number(element.value); },
        get nextSibling() {
            const siblings = element.parentNode?.children || [];
            return siblings[siblings.indexOf(element) + 1] || null;
        },
        get offsetWidth() { return 0; },
        get offsetHeight() { return 0; },
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
            else if (name.startsWith('data-')) element.dataset[dataKey(name)] = String(value);
            else attributes.set(name, String(value));
        },
        getAttribute(name) {
            if (name === 'class') return element.className || null;
            if (name.startsWith('data-')) return element.dataset[dataKey(name)] ?? null;
            return attributes.get(name) ?? null;
        },
        hasAttribute(name) {
            if (name === 'class') return classes.size > 0;
            if (name.startsWith('data-')) return element.dataset[dataKey(name)] !== undefined;
            return attributes.has(name);
        },
        removeAttribute(name) {
            if (name === 'class') classes.clear();
            else if (name.startsWith('data-')) delete element.dataset[dataKey(name)];
            else attributes.delete(name);
        },
        toggleAttribute(name, force = !element.hasAttribute(name)) {
            if (force) element.setAttribute(name, '');
            else element.removeAttribute(name);
            return force;
        },
        appendChild(child) {
            child.parentNode?.removeChild?.(child);
            child.parentNode = element;
            element.children.push(child);
            return child;
        },
        append(...nodes) {
            for (const node of nodes) element.appendChild(typeof node === 'object' ? node : Object.assign(fakeElement('#text'), { textContent: String(node) }));
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
        matches(selector) { return matches(element, selector); },
        closest(selector) {
            for (let current = element; current; current = current.parentNode) if (matches(current, selector)) return current;
            return null;
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
            event.target ??= element;
            event.currentTarget = element;
            event.preventDefault ??= () => { event.defaultPrevented = true; };
            event.stopPropagation ??= () => { event.cancelBubble = true; };
            for (const callback of listeners.get(event.type) || []) callback(event);
            if (event.bubbles !== false && !event.cancelBubble) element.parentNode?.dispatchEvent?.(event);
            return !event.defaultPrevented;
        },
        fire(type, details = {}) {
            const event = { type, target: element, defaultPrevented: false, ...details };
            element.dispatchEvent(event);
            return event;
        },
        click() { element.dispatchEvent({ type: 'click' }); },
        focus() { globalThis.document.activeElement = element; },
        blur() {
            if (globalThis.document.activeElement === element) globalThis.document.activeElement = null;
            element.dispatchEvent({ type: 'blur' });
        },
        get valueAsNumber() { return element.value?.trim?.() === '' ? NaN : Number(element.value); },
        set valueAsNumber(value) { element.value = String(value); },
        setCustomValidity(message) { element.validationMessage = String(message || ''); },
        reportValidity() { element.reports++; return !element.validationMessage; },
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
        activeElement: null,
        createElement: tag => fakeElement(tag),
        createElementNS: (_namespace, tag) => fakeElement(tag),
        createTextNode: text => Object.assign(fakeElement('#text'), { textContent: String(text) }),
        getElementById: id => documentElement.querySelector(`#${id}`),
        querySelector: selector => documentElement.querySelector(selector),
        querySelectorAll: selector => documentElement.querySelectorAll(selector),
        addEventListener: listeners.addEventListener,
        removeEventListener: listeners.removeEventListener,
        dispatchEvent: listeners.dispatchEvent,
    };
    const storage = new Map();
    const windowListeners = fakeElement('#window');
    globalThis.document = document;
    globalThis.Element ??= Object;
    globalThis.HTMLElement ??= Object;
    globalThis.window ??= /** @type {any} */ ({});
    Object.assign(globalThis.window, {
        addEventListener: windowListeners.addEventListener,
        removeEventListener: windowListeners.removeEventListener,
        dispatchEvent: windowListeners.dispatchEvent,
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
