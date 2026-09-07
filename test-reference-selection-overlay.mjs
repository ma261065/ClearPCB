import assert from 'node:assert/strict';
import { clearPcbSelection, setPcbSelection, togglePcbSelection }
    from './src/pcb/modules/selection-registry.js';
import './src/pcb/modules/component-selection.js';
import './src/pcb/modules/ref-text-selection.js';

const placement = { x: 10, y: 20, refDx: 0, refDy: 0 };
const overlay = { children: [] };
const app = {
    placements: new Map([['U1', placement], ['U2', { x: 30, y: 40, refDx: 2, refDy: 3 }]]),
    viewport: { scale: 10 },
    _refOverlay: null,
    _drawRefOverlay(componentId, withTether) {
        this._refOverlay = overlay;
        overlay.children = [];
        const current = this.placements.get(componentId);
        if (current) overlay.children.push({ componentId, x: current.x + current.refDx,
            y: current.y + current.refDy, withTether });
    },
};
const select = (kind, object) => setPcbSelection(app, [{ kind, object }]);

select('component', 'U1');
assert.equal(app._refOverlay, null, 'Component selection must not create a reference overlay');
select('reftext', 'U1');
placement.refDx = 5;
placement.refDy = -3;
app._drawRefOverlay('U1', false);
assert.deepEqual(overlay.children, [{ componentId: 'U1', x: 15, y: 17, withTether: false }]);
select('component', 'U1');
assert.deepEqual(overlay.children, [], 'Selecting the component must remove its old reference box');
placement.x += 10;
placement.y += 5;
assert.deepEqual(overlay.children, [], 'No stale reference box should remain during component movement');

select('reftext', 'U1');
assert.deepEqual(overlay.children, [{ componentId: 'U1', x: 25, y: 22, withTether: false }]);
select('reftext', 'U2');
assert.deepEqual(overlay.children, [{ componentId: 'U2', x: 32, y: 43, withTether: false }]);
togglePcbSelection(app, 'reftext', 'U2');
assert.deepEqual(overlay.children, [], 'Ctrl deselection must clear the reference overlay');

select('reftext', 'U1');
togglePcbSelection(app, 'component', 'U2');
assert.equal(overlay.children[0]?.componentId, 'U1', 'An additively selected reference keeps its overlay');
clearPcbSelection(app);
assert.deepEqual(overlay.children, [], 'Clearing multi-selection must clear the reference overlay');
console.log('PASS: moved reference box clears on component selection, retargets across references, and respects additive selection');