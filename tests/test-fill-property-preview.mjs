import assert from 'node:assert/strict';
import { installFakeDom } from './helpers/fake-dom.mjs';

// A pour's outline follows its Properties number fields live; its copper waits for the
// spinner run to settle into one command (like a drag), and nothing is left deferred.
installFakeDom();
const { pcbEditorFixture } = await import('./pcb-editor-fixture.mjs');
const { showFillProperties } = await import('../src/pcb/modules/copper-fill-edit.js');
const { CopperFill } = await import('../src/shapes/copper-fill.js');
const { areDragOverlaysDeferred } = await import('../src/pcb/modules/refresh-state.js');
const { setPcbSelection } = await import('../src/pcb/modules/selection-registry.js');
const { getPropertyEditor } = await import('../src/pcb/modules/property-editors.js');
const { disposePcbPropertyEditors, hasPcbEditInProgress } = await import('../src/pcb/modules/edit-lifecycle.js');
const { createCopperFillSelectionAdapter } = await import('../src/pcb/modules/copper-fill-selection.js');

const groups = new Map(['top-fill', 'bottom-fill', 'selection-overlay']
    .map(id => [id, document.createElementNS('http://www.w3.org/2000/svg', 'g')]));
const panels = [];
let refreshes = 0;
const app = pcbEditorFixture({
    getLayerGroup: id => groups.get(id) || null,
    openPropertyPanel(panel) { panels.push(panel); return true; },
    refreshPropertyPanel(panel) { panels.push(panel); },
    netNames: () => [],
    refreshFills() { refreshes++; }, _recomputeFillsNow() { refreshes++; },
});
const fill = new CopperFill({ layer: 'top-copper', outline: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 0, y: 10 }] });
app.pcbDocument.boardShapes.push(fill);
setPcbSelection(app, [{ kind: 'fill', object: fill }]);
const field = key => panels.at(-1).fields.find(item => item.key === key);
const outlinePoints = () => groups.get('top-fill').querySelectorAll('polygon').at(-1)?.getAttribute('points').split(' ').length;

showFillProperties(app, fill);
const before = fill.captureState();
assert.equal(outlinePoints(), 4, 'a square-cornered outline before the edit');

refreshes = 0;
for (const radius of [1, 2, 3]) field('cornerRadius').preview(radius);
assert.equal(refreshes, 0, 'spinner steps do not recompute the pour');
assert.deepEqual(fill.captureState(), before, 'the pour itself is unchanged during the run');
assert.equal(areDragOverlaysDeferred(app), true, 'its copper waits for the run to settle');
assert.ok(outlinePoints() > 4, 'the dashed outline already shows the rounded corners');
assert.equal(groups.get('top-fill').querySelectorAll('.pcb-fill-copper').length, 0, 'no stale copper beside the live outline');
assert.equal(getPropertyEditor(app, 'fill').active, true);
assert.equal(hasPcbEditInProgress(app), true, 'saving waits for (or flushes) the run');
field('cornerRadius').commit(3);
assert.equal(fill.cornerRadius, 3, 'the settled run commits');
assert.equal(app.history.undoStack.length, 1, 'as one undo step');
assert.equal(areDragOverlaysDeferred(app), false);
assert.equal(getPropertyEditor(app, 'fill').active, false);
assert.ok(refreshes > 0, 'and the pour is recomputed once it settles');

field('cornerRadius').preview(5);
assert.equal(field('cornerRadius').cancel(), true, 'Escape cancels the live outline');
assert.equal(fill.cornerRadius, 3);
assert.equal(areDragOverlaysDeferred(app), false);
assert.equal(app.history.undoStack.length, 1);

field('cornerRadius').preview(4);
disposePcbPropertyEditors(app);
assert.equal(areDragOverlaysDeferred(app), false, 'replacing the panel never leaves copper deferred');
assert.equal(fill.cornerRadius, 3);

showFillProperties(app, fill);
assert.ok(Number.isNaN(field('cornerRadius').normalize(-1)), 'a negative radius is rejected');

fill.kind = 'circle';
fill.x = 5; fill.y = 5; fill.radius = 4;
showFillProperties(app, fill);
const adapter = createCopperFillSelectionAdapter(app, fill, fill.id);
const pathBefore = adapter.getEditPath();
field('diameter').preview(12);
assert.equal(fill.radius, 4);
const bounds = adapter.getBounds();
assert.equal(Math.round(bounds.maxX - bounds.minX), 12, 'the selection follows the live outline, not the old pour');
assert.notEqual(adapter.getEditPath(), pathBefore, 'so does the selected path');
assert.equal(adapter.object.radius, 6);
assert.equal(areDragOverlaysDeferred(app), true, 'a circle diameter previews the same way');
field('diameter').commit(12);
assert.equal(fill.radius, 6);
assert.equal(adapter.object, fill, 'after the commit the selection is the pour again');
assert.equal(areDragOverlaysDeferred(app), false);

console.log('PASS live pour outline from Properties numbers; copper settles once; cancel and panel replacement restore');
