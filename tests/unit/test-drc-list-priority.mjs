import assert from 'node:assert/strict';
import { PcbDocument } from '../../src/core/PcbDocument.js';
import { fakeElement, installFakeDom } from './helpers/fake-dom.mjs';

function element() {
    return Object.assign(fakeElement('div'), { scrollIntoView() {} });
}
const document = installFakeDom();
document.createElement = element;
const list = element(), empty = element(), title = element();
document.getElementById = id => ({ pcbDrcList: list, pcbDrcEmpty: empty, pcbDrcSlideTitle: title })[id];
const { default: PCBApp } = await import('../../src/ui/PCBApp.js');
const { getDrcPresentation } = await import('../../src/pcb/modules/drc-state.js');
const app = Object.create(PCBApp.prototype);
app.pcbDocument = new PcbDocument();
const violation = (id, rule) => ({ id, rule, severity: 'error', message: id, x: 0, y: 0 });
const drc = getDrcPresentation(app);
drc.violations = [
    ...Array.from({ length: 213 }, (_, index) => violation(`airwire-${index}`, 'unrouted')),
    violation('first-short', 'short'), violation('via-shape-short', 'short'),
];
const original = [...drc.violations];
drc.collapsedGroups = new Set();
drc.selectedId = 'via-shape-short';
drc.selectViolation = id => { drc.selectedId = id; };
drc.renderList();
let rows = list.querySelectorAll('.drc-item');
assert.deepEqual(rows.slice(0, 2).map(row => row.dataset.drcId), ['first-short', 'via-shape-short'],
    'shorts must be visible even when the engine returns more than 200 incomplete connections first');
assert.equal(rows.length, 200, 'priority ordering preserves the DOM performance limit');
assert.equal(rows[1].tabIndex, 0, 'selected short remains keyboard accessible');
assert.equal(list.children[0].children[1].textContent, 'Shorted Nets (2)');
assert.match(list.children.at(-1).textContent, /15 more$/);
assert.match(title.textContent, /215 problems$/);
assert.deepEqual(drc.violations, original, 'rendering does not reorder the underlying results');
drc.selectedId = null;
drc.moveSelection(1);
assert.equal(drc.selectedId, 'first-short', 'keyboard navigation starts with the highest priority issue');
rows[1].fire('click');
assert.equal(drc.selectedId, 'via-shape-short', 'the formerly truncated short can be selected');

drc.violations.push(violation('clearance', 'clearance'));
drc.renderList();
rows = list.querySelectorAll('.drc-item');
assert.deepEqual(rows.slice(0, 4).map(row => row.dataset.drcId),
    ['first-short', 'via-shape-short', 'clearance', 'airwire-0'],
    'clearance problems also precede incomplete connections before applying the cap');
assert.equal(rows.length, 200);
assert.match(list.children.at(-1).textContent, /16 more$/);

drc.collapsedGroups.add('Shorted Nets');
drc.renderList();
assert.equal(list.children[0].getAttribute('aria-expanded'), 'false', 'priority respects section collapse state');
assert.equal(list.children[0].children[1].textContent, 'Shorted Nets (2)', 'collapsed shorts still have a visible count');

drc.violations.push(violation('track-width', 'track-width'), violation('via-diameter', 'via-diameter'),
    violation('via-drill', 'via-drill'));
drc.collapsedGroups.clear();
drc.renderList();
rows = list.querySelectorAll('.drc-item');
assert.deepEqual(rows.slice(0, 7).map(row => row.dataset.drcId), [
    'first-short', 'via-shape-short', 'clearance', 'track-width', 'via-diameter', 'via-drill', 'airwire-0',
], 'Minimum sizes have their own prioritized section before incomplete connections');
assert.equal(rows.length, 200);
assert.ok(list.children.some(child => child.children[1]?.textContent === 'Minimum Sizes (3)'));
drc.collapsedGroups.add('Minimum Sizes');
drc.renderList();
assert.equal(list.querySelectorAll('.drc-item').some(row => row.dataset.drcId === 'track-width'), false);
drc.selectedId = 'track-width';
let cleared = 0, drawn = 0, connected = 0;
drc.clearMarker = () => { cleared++; };
drc.drawMarker = () => { drawn++; };
drc.updateConnector = () => { connected++; };
drc.refreshSelectedMarker();
assert.equal(cleared, 1, 'Refreshing a selected size marker respects its collapsed group');
assert.equal(drawn, 0);
drc.collapsedGroups.delete('Minimum Sizes');
drc.refreshSelectedMarker();
assert.equal(drawn, 1, 'Expanding the size group restores its selected marker');
assert.equal(connected, 1);

console.log('PASS DRC priority before row cap, grouped sizes, selection, keyboard navigation and collapsed markers');
