import assert from 'node:assert/strict';
import { installFakeDom } from './helpers/fake-dom.mjs';
import { renderRibbon } from '../../src/shared/ui/ribbon.js';

installFakeDom();
const createElement = document.createElement.bind(document);
document.createElement = tag => {
    const element = createElement(tag);
    if (tag === 'button') element.disabled = false;
    return element;
};
const container = document.body.appendChild(document.createElement('div'));
let disabled = true, ran = 0;
const clicks = [];
const ribbon = renderRibbon(container, {
    tabs: [{ id: 'properties', label: 'Properties' }],
    panels: [{ id: 'properties', groups: [{ title: 'Clipboard', items: [{
        kind: 'button', id: 'cut-probe', content: 'Cut', disabled: () => disabled,
        run: () => ran++,
        onDisabledClick: event => clicks.push([event.clientX, event.clientY]),
    }] }] }],
});
const control = ribbon.controls.get('cut-probe');
const wrapper = control.parentNode;
assert.equal(control.tagName.toLowerCase(), 'button', 'Control registry still points at the button, not its wrapper');
assert.equal(control.disabled, true);
assert.ok(wrapper.classList.contains('prop-action-disabled'));
wrapper.dispatchEvent({ type: 'pointerdown', button: 0, clientX: 15, clientY: 20 });
assert.deepEqual(clicks, [[15, 20]]);
assert.equal(ran, 0, 'A blocked click supplies feedback without running Cut');
disabled = false;
ribbon.refresh();
assert.equal(ribbon.controls.get('cut-probe'), control);
assert.equal(control.textContent, 'Cut', 'Refresh preserves the wrapped button and label');
assert.equal(wrapper.classList.contains('prop-action-disabled'), false);
wrapper.dispatchEvent({ type: 'pointerdown', button: 0, clientX: 30, clientY: 40 });
assert.deepEqual(clicks, [[15, 20]], 'Enabled clicks no longer show disabled feedback');
control.dispatchEvent({ type: 'click' });
assert.equal(ran, 1);
disabled = true;
ribbon.refresh();
assert.equal(control.disabled, true);
assert.equal(control.textContent, 'Cut');
assert.ok(wrapper.classList.contains('prop-action-disabled'));
console.log('PASS ribbon disabled feedback preserves native buttons, registration and enabled-action refresh');

const splitContainer = document.body.appendChild(document.createElement('div'));
const split = renderRibbon(splitContainer, {
    tabs: [{ id: 'home', label: 'Home' }],
    panels: [{ id: 'home', groups: [{ title: 'Drawing', items: [{
        kind: 'splitTool', id: 'shapes-wrap',
        main: { id: 'draw-shape', content: 'Draw', disabled: () => disabled,
            onDisabledClick: event => clicks.push([event.clientX, event.clientY]) },
        arrow: { id: 'choose-shape', content: 'Choose' }, items: [],
    }] }] }],
});
const draw = split.controls.get('draw-shape');
assert.equal(draw.disabled, true, 'Split-tool main button applies its disabled state');
draw.parentNode.dispatchEvent({ type: 'pointerdown', button: 0, clientX: 50, clientY: 60 });
assert.deepEqual(clicks.at(-1), [50, 60], 'Split-tool disabled main supplies click feedback');
disabled = false;
split.refresh();
assert.equal(split.controls.get('draw-shape'), draw);
assert.equal(draw.disabled, false, 'Split-tool main button refreshes as layers become available');
draw.parentNode.dispatchEvent({ type: 'pointerdown', button: 0, clientX: 70, clientY: 80 });
assert.deepEqual(clicks.at(-1), [50, 60], 'Enabled split tool does not show lock feedback');
disabled = true;
split.refresh();
assert.equal(draw.disabled, true);
console.log('PASS split-tool main button participates in dynamic drawing availability');
