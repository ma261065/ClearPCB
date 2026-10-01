import assert from 'node:assert/strict';

globalThis.window = { addEventListener() {} };
class Element {
    constructor() {
        this.children = [];
        this.attributes = {};
        this.dataset = {};
        this.style = {};
        this.className = '';
        this.events = new Map();
        this.classList = { add: name => { this.className += ` ${name}`; } };
    }
    set textContent(value) { this.text = value; this.children = []; }
    get textContent() { return this.text || this.children.map(child => child.textContent).join(''); }
    setAttribute(name, value) { this.attributes[name] = value; }
    removeAttribute(name) { delete this.attributes[name]; }
    appendChild(child) { this.children.push(child); }
    addEventListener(name, listener) { this.events.set(name, listener); }
    querySelectorAll(selector) {
        return selector === '.drc-item' ? this.children.filter(child => child.dataset.drcId) : [];
    }
    focus() { this.focused = true; }
    scrollIntoView() {}
}
const list = new Element(), empty = new Element(), title = new Element();
globalThis.document = {
    createElement: () => new Element(),
    getElementById: id => ({ pcbDrcList: list, pcbDrcEmpty: empty, pcbDrcSlideTitle: title })[id],
};
const { default: PCBApp } = await import('../src/ui/PCBApp.js');
const app = Object.create(PCBApp.prototype);
const violation = (id, rule) => ({ id, rule, severity: 'error', message: id, x: 0, y: 0 });
app._drcViolations = [
    ...Array.from({ length: 213 }, (_, index) => violation(`airwire-${index}`, 'unrouted')),
    violation('first-short', 'short'), violation('via-shape-short', 'short'),
];
const original = [...app._drcViolations];
app._drcCollapsedGroups = new Set();
app._drcSelectedId = 'via-shape-short';
app._getDrcPresentation().selectViolation = id => { app._drcSelectedId = id; };
app._renderDRCList();
let rows = list.querySelectorAll('.drc-item');
assert.deepEqual(rows.slice(0, 2).map(row => row.dataset.drcId), ['first-short', 'via-shape-short'],
    'shorts must be visible even when the engine returns more than 200 incomplete connections first');
assert.equal(rows.length, 200, 'priority ordering preserves the DOM performance limit');
assert.equal(rows[1].tabIndex, 0, 'selected short remains keyboard accessible');
assert.equal(list.children[0].children[1].textContent, 'Shorted Nets (2)');
assert.match(list.children.at(-1).textContent, /15 more$/);
assert.match(title.textContent, /215 problems$/);
assert.deepEqual(app._drcViolations, original, 'rendering does not reorder the underlying results');
app._drcSelectedId = null;
app._moveDRCSelection(1);
assert.equal(app._drcSelectedId, 'first-short', 'keyboard navigation starts with the highest priority issue');
rows[1].events.get('click')();
assert.equal(app._drcSelectedId, 'via-shape-short', 'the formerly truncated short can be selected');

app._drcViolations.push(violation('clearance', 'clearance'));
app._renderDRCList();
rows = list.querySelectorAll('.drc-item');
assert.deepEqual(rows.slice(0, 4).map(row => row.dataset.drcId),
    ['first-short', 'via-shape-short', 'clearance', 'airwire-0'],
    'clearance problems also precede incomplete connections before applying the cap');
assert.equal(rows.length, 200);
assert.match(list.children.at(-1).textContent, /16 more$/);

app._drcCollapsedGroups.add('Shorted Nets');
app._renderDRCList();
assert.equal(list.children[0].attributes['aria-expanded'], 'false', 'priority respects section collapse state');
assert.equal(list.children[0].children[1].textContent, 'Shorted Nets (2)', 'collapsed shorts still have a visible count');

console.log('PASS DRC priority before row cap, short selection, keyboard navigation and collapsed-section counts');
