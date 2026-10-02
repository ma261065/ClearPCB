/** Board-shape editor state: module-owned per editor, import-free, no `app._…` fields. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as state from '../src/pcb/modules/board-shape-state.js';

const source = readFileSync(new URL('../src/pcb/modules/board-shape-state.js', import.meta.url), 'utf8');
assert.doesNotMatch(source, /^\s*import\b/m, 'board-shape-state.js stays import-free');

const first = {}, second = {};
assert.equal(state.getBoardShapeNodeFocus(first), null);
assert.equal(state.getBoardShapeSegmentFocus(first), null);
assert.equal(state.getHoveredBoardShape(first), null);
assert.deepEqual([...state.getNetHoveredShapeIds(first)], []);
assert.deepEqual(state.getShapeDefaults(first), { lineWidth: 0.2 }, 'new editors start with the default line width');

state.setBoardShapeNodeFocus(first, { shapeId: 's1', index: 2 });
state.setBoardShapeSegmentFocus(first, { shapeId: 's1', segment: 0 });
state.setHoveredBoardShape(first, { id: 's1' });
state.setNetHoveredShapeIds(first, new Set(['s1']));
state.getShapeDefaults(first).filled = true;
assert.deepEqual(state.getBoardShapeNodeFocus(first), { shapeId: 's1', index: 2 });
assert.equal(state.getShapeDefaults(first).filled, true, 'defaults are edited in place');
assert.equal(state.getBoardShapeNodeFocus(second), null, 'editors do not share focus');
assert.equal(state.getShapeDefaults(second).filled, undefined, 'or defaults');
assert.equal(Object.keys(first).length, 0, 'nothing is stored on the editor object');

state.setBoardShapeNodeFocus(first, undefined);
state.setBoardShapeSegmentFocus(first, undefined);
state.setHoveredBoardShape(first, undefined);
state.setNetHoveredShapeIds(first, undefined);
assert.equal(state.getBoardShapeNodeFocus(first), null, 'clearing focus normalises to null');
assert.equal(state.getBoardShapeSegmentFocus(first), null);
assert.equal(state.getHoveredBoardShape(first), null);
assert.deepEqual([...state.getNetHoveredShapeIds(first)], [], 'clearing net hover gives an empty set');

console.log('PASS board-shape state: per-editor focus, hover and defaults, import-free, nothing stored on the editor');
