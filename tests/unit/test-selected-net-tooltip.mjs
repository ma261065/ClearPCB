import assert from 'node:assert/strict';
import { PcbDocument } from '../../src/core/PcbDocument.js';
import { getNetTooltipElement, updateNetTooltip } from '../../src/pcb/modules/net-tooltip.js';

const appended = [];
globalThis.document = {
    createElement() {
        return {
            style: {},
            textContent: '',
            offsetWidth: 80,
            offsetHeight: 20,
        };
    },
    body: {
        appendChild(element) {
            appended.push(element);
        },
    },
};
globalThis.window = {
    innerWidth: 1000,
    innerHeight: 800,
    addEventListener() {},
};

const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
globalThis.setTimeout = (callback) => {
    callback();
    return 1;
};
globalThis.clearTimeout = () => {};

try {
    const [{ default: PCBApp }, { setPcbSelection }] = await Promise.all([
        import('../../src/ui/PCBApp.js'),
        import('../../src/pcb/modules/selection-registry.js'),
    ]);
    const via = { id: 'via-a', net: 'N1' };
    const app = Object.create(PCBApp.prototype);
    app.pcbDocument = new PcbDocument();
    app.netlist = [];
    app.setPcbStatus = () => {};

    setPcbSelection(app, [{ kind: 'via', object: via }]);
    updateNetTooltip(app, { clientX: 20, clientY: 30 }, { type: 'via', via });

    assert.equal(appended.length, 1, 'selected-object hover creates the net tooltip');
    assert.equal(getNetTooltipElement(app).textContent, 'N1');
    assert.equal(getNetTooltipElement(app).style.display, 'block');
    console.log('PASS: selected PCB objects still show their net tooltip on hover');
} finally {
    globalThis.setTimeout = nativeSetTimeout;
    globalThis.clearTimeout = nativeClearTimeout;
}
