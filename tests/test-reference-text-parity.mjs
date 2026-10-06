import assert from 'node:assert/strict';
import { layoutReferenceText, referenceAnchor, resolveReferenceText } from '../src/shared/pcb/reference-text.js';
import { applyRefGeometry } from '../src/shared/pcb/footprint.js';
import { PcbPlacementState } from '../src/core/PcbPlacementState.js';
import { setBoardViewPanel } from '../src/pcb/modules/refresh-state.js';

const element = () => ({ attributes: {}, children: [],
    setAttribute(name, value) { this.attributes[name] = value; },
    appendChild(child) { this.children.push(child); } });
globalThis.document = { createElementNS: element };
assert.deepEqual(referenceAnchor(null), { cx: 0, baseY: -2.8 });
assert.deepEqual(referenceAnchor({ x: 2, y: -4, width: 6 }), { cx: 5, baseY: -4.8 });
for (const outline of [null, { x: 2, y: -4, width: 6 }]) {
    const { cx, baseY } = referenceAnchor(outline);
    const local = layoutReferenceText('R12', cx, baseY, 1.2, 0.2);
    const group = element();
    applyRefGeometry(group, 'R12', cx, baseY, 1.2, 0.2);
    assert.deepEqual(group.children.map(child => child.attributes.points),
        local.polylines.map(poly => poly.map(point => `${point.x},${point.y}`).join(' ')));
    for (const side of ['top', 'bottom']) for (const mirror of [false, true]) {
        const placement = { reference: 'R12', outline, x: 20, y: -20, side, mirror,
            refSize: 1.2, refStrokeWidth: 0.2, refRot: 90, rotation: 90, refDx: 3, refDy: -2 };
        const resolved = resolveReferenceText(placement);
        const expected = local.polylines.map(poly => poly.map(point => {
            let x = cx - (point.y - local.box.cy);
            const y = local.box.cy + (point.x - cx) - 2;
            if (mirror) x = 2 * cx - x;
            x += 3;
            if (mirror !== (side === 'bottom')) x = -x;
            return { x: 20 - y, y: -20 + x };
        }));
        resolved.polylines.forEach((poly, polyIndex) => poly.forEach((point, pointIndex) => {
            assert.ok(Math.hypot(point.x - expected[polyIndex][pointIndex].x,
                point.y - expected[polyIndex][pointIndex].y) < 1e-10);
        }));
        assert.equal(resolved.layer, `${side}-silk`);
        assert.equal(resolved.strokeWidth, 0.2);
    }
}
assert.equal(resolveReferenceText({ reference: 'R1', refVisible: false }), null);
assert.equal(resolveReferenceText({ reference: '' }), null);
console.log('PASS reference baseline, SVG glyphs and independent side/mirror/rotation transforms');

globalThis.window = { addEventListener() {} };
const { Board2D } = await import('../src/pcb/modules/board2d.js');
const { buildTextMesh } = await import('../src/pcb/modules/board3d.js');
const { exportGerbers } = await import('../src/pcb/modules/gerber.js');
const near = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) < tolerance,
    `Expected ${actual} to equal ${expected}`);
function canvasStrokes(placement, side) {
    const paths = [];
    let path = [];
    const context = { save() {}, restore() {}, beginPath() { path = []; },
        moveTo(x, y) { path.push({ x, y }); }, lineTo(x, y) { path.push({ x, y }); },
        stroke() { paths.push({ points: path, width: this.lineWidth }); } };
    Board2D.prototype._drawSilk.call({ data: { placements: new Map([['ref', placement]]) }, side }, context);
    return paths;
}
for (const outline of [null, { x: 2, y: -4, width: 6 }]) {
    for (const side of ['top', 'bottom']) for (const mirror of [false, true]) for (const rotation of [0, 37, 90]) {
        const placement = { reference: 'R12', outline, x: 30, y: -30, side, mirror, rotation,
            refRot: rotation, refSize: 1.2, refStrokeWidth: 0.2, refDx: 3, refDy: -2 };
        const reference = resolveReferenceText(placement);
        const state = new PcbPlacementState();
        state.record('ref', placement);
        state.load(state.serialize());
        assert.deepEqual(resolveReferenceText({ ...placement, ...state.overrides.get('ref') }), reference,
            'Saved placement/reference settings preserve rendering and export geometry');
        const endpoints = reference.polylines.flatMap(poly => poly.slice(1).flatMap((point, index) => [poly[index], point]));
        const paths = canvasStrokes(placement, side);
        assert.equal(paths.length, 1);
        assert.deepEqual(paths[0].points, endpoints);
        assert.equal(paths[0].width, 0.2);
        assert.deepEqual(canvasStrokes(placement, side === 'top' ? 'bottom' : 'top'), []);

        const app = { placements: new Map([['ref', placement]]), boardWidth: 100, boardHeight: 80 };
        const silk = exportGerbers(app).get(side === 'top' ? 'board.gto' : 'board.gbo');
        const coordinates = [...silk.matchAll(/X(-?\d+)Y(-?\d+)D0[12]\*/g)]
            .map(match => ({ x: Number(match[1]) / 1e6, y: -Number(match[2]) / 1e6 }));
        assert.equal(coordinates.length, endpoints.length);
        coordinates.forEach((point, index) => {
            near(point.x, endpoints[index].x, 1e-6);
            near(point.y, endpoints[index].y, 1e-6);
        });
        assert.ok([...silk.matchAll(/%ADD\d+C,([\d.]+)\*/g)].some(match => Number(match[1]) === 0.2));

        const mesh = buildTextMesh(app);
        const vertices = mesh.verts;
        assert.ok(vertices.length > 0);
        for (const [axis, meshAxis] of [['x', 'x'], ['y', 'z']]) {
            near(Math.min(...vertices.map(point => point[meshAxis])), Math.min(...endpoints.map(point => point[axis])) - 0.1);
            near(Math.max(...vertices.map(point => point[meshAxis])), Math.max(...endpoints.map(point => point[axis])) + 0.1);
        }
        assert.ok(vertices.every(point => side === 'top' ? point.y > 1 : point.y <= 0));
        placement.refVisible = false;
        assert.deepEqual(canvasStrokes(placement, side), []);
        assert.equal(buildTextMesh(app).verts.length, 0);
        assert.doesNotMatch(exportGerbers(app).get(side === 'top' ? 'board.gto' : 'board.gbo'), /D01\*/);
    }
}
console.log('PASS Canvas, 3D and Gerber reference positions, sides, visibility and stroke extents');

const { default: PCBApp } = await import('../src/ui/PCBApp.js');
const { ProjectDocument } = await import('../src/core/ProjectDocument.js');
const { CommandHistory } = await import('../src/core/CommandHistory.js');
const { MovePlacementCommand } = await import('../src/pcb/modules/track-commands.js');
const owner = new ProjectDocument();
const { Component } = await import('../src/components/Component.js');
owner.schematicDocument.components.push(new Component({ name: 'EmptyFootprint', symbol: { pins: [] } }, { id: 'part' }));
document.getElementById = () => null;
const constructed = new PCBApp(owner);
assert.equal(constructed._placementOverrides, owner.pcbDocument.placementState.overrides,
    'PCB construction aliases the project-owned map');
assert.notEqual(new PCBApp()._placementOverrides, constructed._placementOverrides,
    'Standalone editors retain an independent placement model');
const moved = { x: 1, y: 2, rotation: 37, refDx: 3, refDy: -2, refRot: 90, refVisible: false };
let dirtyNotifications = 0;
const editor = {
    project: owner,
    placementState: owner.pcbDocument.placementState, _placementOverrides: owner.pcbDocument.placementState.overrides,
    placements: new Map([['part', moved]]),
    _recordPlacementOverride: PCBApp.prototype._recordPlacementOverride,
    _markDirty() { dirtyNotifications++; },
};
const history = new CommandHistory();
history.execute(new MovePlacementCommand(editor, 'part', 1, 2, 10, 20));
assert.equal(owner.pcbDocument.placementState.overrides.get('part').x, 10);
history.undo();
assert.equal(owner.pcbDocument.placementState.overrides.get('part').x, 1);
history.redo();
assert.equal(owner.pcbDocument.placementState.overrides.get('part').x, 10);
assert.equal(owner.pcbDocument.placementState.overrides.get('part').refRot, 90);
assert.equal(owner.pcbDocument.placementState.overrides.get('part').refVisible, false);
assert.equal(editor.placements.get('part'), moved, 'Undo/redo preserves the generated placement identity');
assert.equal(dirtyNotifications, 3, 'The editor still marks each execute/undo/redo dirty');
console.log('PASS placement commands persist into project state through execute/undo/redo');

{
    const { SetPlacementLockedCommand, SetPlacementRefVisibleCommand, MoveRefTextCommand,
        RotateRefTextCommand, SetRefStyleCommand, applyPlacementPose } = await import('../src/pcb/modules/track-commands.js');
    const { setPcbSelection } = await import('../src/pcb/modules/selection-registry.js');
    const stages = [];
    const refAttributes = new Map([['data-mx-center', '0'], ['data-ref-cy', '0']]);
    const ref = {
        style: {},
        hasAttribute: name => name === 'data-fp-ref',
        getAttribute: name => refAttributes.get(name),
        setAttribute(name, value) { refAttributes.set(name, value); },
        removeAttribute(name) { refAttributes.delete(name); },
    };
    moved.elements = [{
        setAttribute() { stages.push('pose'); },
        querySelector() { return ref; },
        querySelectorAll() { return [ref]; },
    }];
    editor.viewport = { svg: { style: {} } };
    editor.getLayerGroup = () => null;
    editor._recordPlacementOverride = () => assert.fail('Metadata adapters must not persist generated artwork back into the model');
    editor._markDirty = () => { dirtyNotifications++; stages.push('dirty'); };
    editor._refreshPcbSelectionHighlights = () => stages.push('highlights');
    editor.showComponentProperties = () => stages.push('properties');
    editor._drawRefOverlay = () => stages.push('overlay');
    setBoardViewPanel(editor, { refresh() { stages.push('3d'); } });
    editor._rerenderRef = id => {
        stages.push('glyphs');
        const placement = editor.placements.get(id);
        if (placement) {
            assert.equal(owner.pcbDocument.placementState.overrides.get(id).refSize, placement.refSize,
                'Canonical style is committed before glyph rendering');
        }
        applyPlacementPose(editor, id);
    };
    setPcbSelection(editor, [{ kind: 'component', object: 'part' }]);
    const entry = () => owner.pcbDocument.placementState.overrides.get('part');
    const commands = [
        [new SetPlacementLockedCommand(editor, 'part', true), ['locked'], ['dirty', 'highlights', 'properties']],
        [new SetPlacementRefVisibleCommand(editor, 'part', true), ['refVisible'], ['dirty', '3d']],
        [new MoveRefTextCommand(editor, 'part', 3, -2, 5.123456, -6.234567),
            ['refDx', 'refDy'], ['pose', 'dirty', 'overlay', '3d']],
        [new RotateRefTextCommand(editor, 'part', 90, 450.123456),
            ['refRot'], ['pose', 'dirty', 'overlay', '3d']],
        [new SetRefStyleCommand(editor, 'part', { refSize: 0.9, refStrokeWidth: 0.15 },
            { refSize: 2.345678, refStrokeWidth: 0.234567 }),
            ['refSize', 'refStrokeWidth'], ['glyphs', 'pose', 'dirty', 'overlay', '3d']],
    ];
    for (const [command, fields, expectedStages] of commands) {
        for (const action of ['execute', 'undo', 'execute']) {
            stages.length = 0;
            const count = dirtyNotifications;
            command[action]();
            assert.equal(dirtyNotifications, count + 1);
            assert.deepEqual(stages, expectedStages);
            for (const key of fields) assert.equal(moved[key], entry()[key], `${key}: projection reflects canonical metadata`);
            assert.equal(editor.placements.get('part'), moved);
        }
    }
    assert.equal(editor.viewport.svg.style.cursor, 'default');
    assert.equal(ref.style.display, '');
    assert.match(refAttributes.get('transform'), /translate\(5.123456, -6.234567\)/);
    assert.match(refAttributes.get('transform'), /rotate\(/);
    const pending = new SetPlacementLockedCommand(editor, 'part', false);
    const replacement = { ...moved, x: 999 };
    editor.placements.set('part', replacement);
    pending.execute();
    assert.equal(replacement.locked, false, 'Commands resolve the current generated placement, not a stale object');
    assert.equal(entry().x, 10, 'Metadata edits do not overwrite canonical coordinates with stale projected values');
    editor.placements.delete('part');
    pending.undo();
    assert.equal(entry().locked, true, 'Authored undo still works when the placement is not currently rendered');
    const hiddenReference = new SetPlacementRefVisibleCommand(editor, 'part', false);
    hiddenReference.execute();
    assert.equal(entry().refVisible, false);
    hiddenReference.undo();
    assert.equal(entry().refVisible, true, 'Reference metadata can also be restored without a generated placement');
}
console.log('PASS canonical placement metadata projection, dirty/refresh ordering and reference transforms');