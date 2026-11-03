import assert from 'node:assert/strict';
import { fakeElement, installFakeDom } from './helpers/fake-dom.mjs';

const appended = [];
const document = installFakeDom();
document.createElement = tag => Object.defineProperties(fakeElement(tag), {
    offsetWidth: { value: 80 },
    offsetHeight: { value: 20 },
});
const appendChild = document.body.appendChild.bind(document.body);
document.body.appendChild = element => {
    appended.push(element);
    return appendChild(element);
};
globalThis.window.innerWidth = 1000;
globalThis.window.innerHeight = 800;

const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
globalThis.setTimeout = (callback) => {
    callback();
    return 1;
};
globalThis.clearTimeout = () => {};

try {
    const {
        getSchematicNetTooltipElement,
        schematicNetNameForHover,
        updateSchematicNetTooltip,
    } = await import('../../src/schematic/modules/net-tooltip.js');
    const app = {};
    const wire = { type: 'wire', net: 'POWER_IN' };

    assert.equal(schematicNetNameForHover(wire), 'POWER_IN');
    assert.equal(schematicNetNameForHover({ type: 'text', net: 'POWER_IN' }), null);

    updateSchematicNetTooltip(app, { clientX: 20, clientY: 30 }, wire);
    assert.equal(appended.length, 1, 'hovering a wire creates the net tooltip');
    assert.equal(getSchematicNetTooltipElement(app).textContent, 'POWER_IN');
    assert.equal(getSchematicNetTooltipElement(app).style.display, 'block');

    updateSchematicNetTooltip(app, { clientX: 25, clientY: 35 }, { type: 'wire', net: '' });
    assert.equal(getSchematicNetTooltipElement(app).textContent, '(no net)');

    updateSchematicNetTooltip(app, { clientX: 25, clientY: 35 }, null);
    assert.equal(getSchematicNetTooltipElement(app).style.display, 'none');
    console.log('PASS: schematic wire hover shows and hides its net tooltip');
} finally {
    globalThis.setTimeout = nativeSetTimeout;
    globalThis.clearTimeout = nativeClearTimeout;
}
