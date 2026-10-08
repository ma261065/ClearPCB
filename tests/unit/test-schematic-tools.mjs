import assert from 'node:assert/strict';
import { fakeElement, installFakeDom } from './helpers/fake-dom.mjs';

installFakeDom();
const {
    SCHEMATIC_TOOLS, SCHEMATIC_TOOL_KEYS, schematicToolTitle, pressSchematicTool, pressSchematicToolDrawing,
    moveSchematicTool, releaseSchematicTool, finishSchematicDrawAtPointer, finishSchematicDrawInPlace,
} = await import('../../src/schematic/modules/schematic-tools.js');
const { isSchematicDrawingActive } = await import('../../src/schematic/modules/drawing.js');

// schematic-tools.js holds one entry per schematic tool; the mouse states, keyboard,
// tool selection and ribbon all read it.

for (const [id, tool] of Object.entries(SCHEMATIC_TOOLS)) {
    assert.equal(tool.id, id, `${id} names itself`);
    assert.ok(tool.name, `${id} has a name`);
    assert.ok(Object.isFrozen(tool), `${id} is read-only`);
}
assert.deepEqual(Object.keys(SCHEMATIC_TOOLS).sort(),
    ['arc', 'circle', 'component', 'line', 'net', 'noconnect', 'polygon', 'rect', 'select', 'text', 'wire']);
assert.deepEqual(SCHEMATIC_TOOL_KEYS, { v: 'select', w: 'wire', r: 'rect', c: 'circle', a: 'arc', i: 'line',
    p: 'polygon', l: 'text', n: 'net', x: 'noconnect', o: 'component' }, 'one shortcut per tool');
assert.equal(schematicToolTitle('wire'), 'Wire (W)', 'the tooltip names the shortcut');
assert.equal(schematicToolTitle('text'), 'Label (L)');
const multiClick = Object.values(SCHEMATIC_TOOLS).filter(tool => tool.multiClick).map(tool => tool.id).sort();
assert.deepEqual(multiClick, ['arc', 'circle', 'line', 'polygon', 'rect', 'wire'], 'releasing the button finishes only single-click draws');
assert.deepEqual(Object.values(SCHEMATIC_TOOLS).filter(tool => tool.placesComponents).map(tool => tool.id), ['component']);

/** A schematic editor with just what drawing a shape uses. */
function editor(tool) {
    const shapes = [];
    const app = {
        currentTool: tool, interactionState: 'toolActive', shapes,
        toolOptions: { color: '#ffffff', lineWidth: 0.25, fill: false, cornerRadius: 0 },
        viewport: { scale: 10, contentLayer: fakeElement('g'), svg: fakeElement('svg') },
        selection: { clearSelection() {}, select() {} },
        addShape(shape) { shapes.push(shape); },
        showCrosshair() {}, hideCrosshair() {}, updateCrosshair() {}, setToolCursor() {},
    };
    return app;
}
const at = (x, y) => ({ screenPos: { x, y }, worldPos: { x, y }, snapped: { x, y } });
const event = { button: 0, preventDefault() {} };

// Rectangle: the first press starts it, the release leaves it open, the second press ends it.
{
    const app = editor('rect');
    pressSchematicTool(app, event, at(0, 0));
    assert.equal(isSchematicDrawingActive(app), true);
    moveSchematicTool(app, event, at(5, 5), true);
    releaseSchematicTool(app, at(5, 5));
    assert.equal(isSchematicDrawingActive(app), true, 'a click-by-click draw survives the release');
    pressSchematicToolDrawing(app, event, at(10, 5));
    assert.equal(isSchematicDrawingActive(app), false);
    assert.equal(app.shapes.length, 1);
    assert.equal(app.shapes[0].closed, true);
}
// Rectangle: a right-click in place ends it at the pointer.
{
    const app = editor('rect');
    pressSchematicTool(app, event, at(0, 0));
    assert.equal(finishSchematicDrawAtPointer(app, at(4, 3)), true);
    assert.equal(app.shapes.length, 1);
}
// Line: Enter or a double-click ends it with the points placed; the pointer adds none.
{
    const app = editor('line');
    pressSchematicTool(app, event, at(0, 0));
    pressSchematicToolDrawing(app, event, at(5, 0));
    moveSchematicTool(app, event, at(9, 9), true);
    assert.equal(finishSchematicDrawInPlace(app), true);
    assert.equal(app.shapes.length, 1);
    assert.deepEqual(app.shapes[0].toEditablePath().points.map(point => [point.x, point.y]), [[0, 0], [5, 0]]);
}
// Polygon: a right-click in place adds the pointer as its last corner.
{
    const app = editor('polygon');
    pressSchematicTool(app, event, at(0, 0));
    pressSchematicToolDrawing(app, event, at(10, 0));
    assert.equal(finishSchematicDrawAtPointer(app, at(10, 10)), true);
    assert.equal(app.shapes.length, 1);
    assert.equal(app.shapes[0].toEditablePath().points.length, 3);
}
// Arc: a right-click before its end point is placed does nothing.
{
    const app = editor('arc');
    pressSchematicTool(app, event, at(0, 0));
    assert.equal(finishSchematicDrawAtPointer(app, at(5, 5)), false);
    assert.equal(isSchematicDrawingActive(app), true);
}
// A tool without its own press (Component, before a placement) starts a draw that the release ends.
{
    const app = editor('component');
    pressSchematicTool(app, event, at(1, 1));
    assert.equal(app.interactionState, 'drawing');
    releaseSchematicTool(app, at(1, 1));
    assert.equal(isSchematicDrawingActive(app), false);
    assert.equal(app.interactionState, 'toolActive');
    assert.equal(app.shapes.length, 0, 'it draws nothing');
}

console.log('PASS schematic tools: one entry per tool, shortcuts, and every way a draw starts and ends');
