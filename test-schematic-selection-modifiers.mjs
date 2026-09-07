import assert from 'node:assert/strict';
import { SelectionManager } from './src/core/SelectionManager.js';

globalThis.window = { addEventListener() {} };
globalThis.HTMLElement = class {};
globalThis.document = { getElementById() { return null; }, querySelector() { return null; } };
const { idleState, overlapCycleState, STATE_TABLE } = await import('./src/schematic/modules/draw-states.js');
const { handleEscape } = await import('./src/ui/modules/keyboard.js');
const shape = (id, hit = true) => ({ id, visible: true, selected: false,
    hitTest: () => hit, hitTestAnchor: () => 'anchor', invalidate() {} });
const below = shape('below'), top = shape('top'), unrelated = shape('unrelated', false);
const selection = new SelectionManager();
selection.setShapes([below, top, unrelated]);
const app = { selection, renderShapes() {}, viewport: { scale: 10, shiftHeld: true }, interactionState: 'idle' };
const positions = { screenPos: { x: 10, y: 10 }, worldPos: { x: 1, y: 1 }, snapped: { x: 1, y: 1 } };
const event = (modifiers = {}) => ({ button: 0, preventDefault() {}, ...modifiers });
const ids = () => selection.getSelection().map((item) => item.id).sort();
selection.select(top, false);
selection.select(unrelated, true);
idleState.mousedown(app, event({ ctrlKey: true }), positions);
assert.deepEqual(ids(), ['unrelated'], 'Ctrl removes a selected item even on its anchor');
idleState.mousedown(app, event({ metaKey: true }), positions);
assert.deepEqual(ids(), ['top', 'unrelated'], 'Cmd adds without replacing the other selection');
app.skipClickSelection = false;
idleState.mousedown(app, event({ shiftKey: true }), positions);
assert.deepEqual(ids(), ['top', 'unrelated']);
assert.equal(app.interactionState, 'overlapCycle');
overlapCycleState.mouseup(app, event({ shiftKey: true }), positions);
assert.deepEqual(ids(), ['below']);
idleState.click(app, event({ shiftKey: true }), positions);
assert.deepEqual(ids(), ['below'], 'The subsequent click must not overwrite the cycle');
idleState.mousedown(app, event({ shiftKey: true }), positions);
overlapCycleState.mouseup(app, event(), positions);
assert.deepEqual(ids(), ['top'], 'The cycle wraps and uses the modifier captured on press');
selection.select(unrelated, true);
idleState.mousedown(app, event({ shiftKey: true, ctrlKey: true }), positions);
overlapCycleState.mouseup(app, event(), positions);
assert.deepEqual(ids(), ['below', 'unrelated']);
idleState.mousedown(app, event({ shiftKey: true }), positions);
handleEscape(app);
assert.equal(app.interactionState, 'idle');
assert.equal(app._overlapCyclePress, null);
assert.deepEqual(ids(), ['below', 'unrelated']);

idleState.mousedown(app, event({ shiftKey: true }), positions);
const originalDown = idleState.mousedown;
const originalMove = STATE_TABLE.moveDrag.mousemove;
let moves = 0;
try {
    idleState.mousedown = (target, replay, start) => {
        assert.equal(replay.shiftKey, false, 'Drag replay must bypass cycling');
        assert.equal(target.viewport.shiftHeld, true, 'Viewport snap reversal must remain active');
        assert.equal(start.worldPos, positions.worldPos);
        target.interactionState = 'moveDrag';
    };
    STATE_TABLE.moveDrag.mousemove = () => { moves++; };
    overlapCycleState.mousemove(app, event({ shiftKey: true }), {
        ...positions, screenPos: { x: 12, y: 10 },
    });
    assert.equal(moves, 0);
    overlapCycleState.mousemove(app, event({ shiftKey: true }), {
        ...positions, screenPos: { x: 15, y: 10 },
    });
    assert.equal(moves, 1);
    assert.equal(app._overlapCyclePress, null);
    assert.deepEqual(ids(), ['below', 'unrelated'], 'Dragging must not cycle');
} finally {
    idleState.mousedown = originalDown;
    STATE_TABLE.moveDrag.mousemove = originalMove;
}
console.log('PASS: schematic Ctrl/Cmd toggle, Shift cycle, modifier priority, additive cycle, Escape, and Shift-drag dispatch');