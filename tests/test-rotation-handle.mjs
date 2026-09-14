import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rotationHandleAnchor, pointerRotation, rotatedImagePoints, ROTATION_CURSOR } from '../src/pcb/modules/rotation-handle.js';

const bounds = { minX: -4, minY: -2, maxX: 4, maxY: 2 };
for (const scale of [0.1, 1, 20]) {
    const anchor = rotationHandleAnchor(bounds, scale);
    assert.equal(anchor.x, 0);
    assert.ok(Math.abs((bounds.minY - anchor.y) * scale - 28) < 1e-9);
}
const center = { x: 0, y: 0 };
const start = { x: 0, y: -5 };
assert.equal(pointerRotation(center, start, { x: -5, y: 0 }, 0), 90);
assert.equal(pointerRotation(center, start, { x: 5, y: 0 }, 0), 270);
assert.equal(pointerRotation(center, start, { x: -5, y: 0 }, 300), 30);
assert.equal(pointerRotation(center, start, center, 25), 25);
for (const [degrees, expected] of [[0.4, 0], [0.6, 1], [37.4, 37], [37.6, 38], [-0.6, 359], [359.6, 0]]) {
    const radians = degrees * Math.PI / 180;
    const current = { x: -5 * Math.sin(radians), y: -5 * Math.cos(radians) };
    assert.equal(pointerRotation(center, start, current, 0), expected, 'Rotation dragging snaps to whole degrees and wraps');
}
assert.equal(pointerRotation(center, start, start, 12.7), 13, 'Fractional starting rotations snap to whole degrees');
const points = [{ x: -4, y: -2 }, { x: 4, y: -2 }, { x: 4, y: 2 }, { x: -4, y: 2 }];
const rotated = rotatedImagePoints(points, center, 90);
assert.ok(Math.abs(rotated[0].x + 2) < 1e-9 && Math.abs(rotated[0].y - 4) < 1e-9);
assert.deepEqual(points[0], { x: -4, y: -2 });
console.log('PASS rotation handle position, angle direction, wrapping and image geometry');

globalThis.window = { addEventListener() {} };
const inputs = new Map([['pcbPropTextRot', { value: '' }], ['pcbPropImageRot', { value: '' }]]);
function element(tag) {
    return {
        tag, children: [], attributes: new Map(), style: {},
        setAttribute(name, value) { this.attributes.set(name, String(value)); },
        getAttribute(name) { return this.attributes.get(name); },
        appendChild(child) { this.children.push(child); child.parentNode = this; },
        remove() { this.parentNode?.children.splice(this.parentNode.children.indexOf(this), 1); },
        querySelectorAll(selector) {
            return this.children.filter(child => selector === '.pcb-selection-anchors'
                && child.attributes.get('class') === 'pcb-selection-anchors');
        },
    };
}
globalThis.document = { getElementById: id => inputs.get(id) || null, createElementNS: (namespace, tag) => element(tag) };
const { CommandHistory } = await import('../src/core/CommandHistory.js');
const { pictureShape } = await import('../src/pcb/modules/picture-raster.js');
const { createBoardShapeSelectionAdapter } = await import('../src/pcb/modules/board-shapes.js');
const { createPcbTextSelectionAdapter } = await import('../src/pcb/modules/pcb-text-selection.js');
const { setPcbSelection, getPcbSelection, isPcbSelected } = await import('../src/pcb/modules/selection-registry.js');
const { MoveTextCommand } = await import('../src/pcb/modules/text-commands.js');
const { pcbTextBounds } = await import('../src/pcb/modules/pcb-text.js');
const { renderPcbSelectionAnchors, hitTestPcbSelectionAnchor } = await import('../src/pcb/modules/selection-anchors.js');
const { cancelPictureCopperRefresh } = await import('../src/pcb/modules/picture-refresh.js');
const { beginSelectionInteraction, updateSelectionInteraction, finishSelectionInteraction, selectionInteractionCursor } = await import('../src/pcb/modules/selection-interaction.js');
const originalTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const originalRaf = globalThis.requestAnimationFrame;
const originalCancelRaf = globalThis.cancelAnimationFrame;
const frames = new Map();
let frameId = 0;
globalThis.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId; };
globalThis.cancelAnimationFrame = id => frames.delete(id);
const timers = new Map();
let timerId = 0;
globalThis.setTimeout = callback => { timers.set(++timerId, callback); return timerId; };
globalThis.clearTimeout = id => timers.delete(id);
try {
    for (const kind of ['image', 'text']) {
        for (const layer of ['top-silk', 'bottom-copper']) {
            const object = kind === 'image'
                ? pictureShape({ width: 4, height: 2, rectangles: [{ x: 0, y: 0, width: 4, height: 2 }] }, { widthMm: 8, layer })
                : { id: 'text_1', content: 'Rotate', x: 3, y: 5, size: 1.5, strokeWidth: 0.2, rotation: 30, layer };
            if (kind === 'image') {
                object.id = 'pshape_1';
                object.points = rotatedImagePoints(object.points, center, 30);
            }
            const app = { boardShapes: kind === 'image' ? [object] : [], texts: new Map(kind === 'text' ? [[object.id, object]] : []),
                tracks: [], vias: [], placements: new Map(), _shapeElements: new Map(),
                viewport: { scale: 10, svg: element('svg') }, history: new CommandHistory(), _getLayerGroup() { return null; },
                _pcbPropsItems() { return null; }, _refreshText() {},
                _showTextProperties(text) { inputs.get('pcbPropTextRot').value = String(text.rotation); } };
            setPcbSelection(app, [{ kind: kind === 'image' ? 'shape' : 'text', object }]);
            const adapter = kind === 'image' ? createBoardShapeSelectionAdapter(app, object, `shape:${object.id}`)
                : createPcbTextSelectionAdapter(app, object, `text:${object.id}`);
            const pivot = kind === 'image' ? center : { x: object.x, y: object.y };
            const anchor = adapter.getAnchors().find(handle => handle.id === 'rotate');
            assert.ok(anchor);
            const before = JSON.stringify(kind === 'image' ? object.points : object.rotation);
            const target = { x: pivot.x + anchor.y - pivot.y, y: pivot.y - (anchor.x - pivot.x) };
            assert.equal(adapter.beginAnchorDrag('rotate', anchor), true);
            adapter.updateAnchorDrag(target);
            assert.equal(timers.size, 0, 'No deferred clearance timer runs while holding the rotation handle');
            const input = inputs.get(kind === 'image' ? 'pcbPropImageRot' : 'pcbPropTextRot');
            assert.ok(Math.abs(Number(input.value) - 120) < 0.01, `${kind}: spinner follows live rotation`);
            assert.equal(app.history.undoStack.length, 0);
            adapter.endAnchorDrag(true, { moved: true });
            assert.equal(app.history.undoStack.length, 1, 'One undo entry per rotation drag');
            assert.equal(app._rotationHandleDrag, false);
            assert.equal(timers.size, 1, 'Release schedules clearance restoration');
            app.history.undo();
            assert.equal(JSON.stringify(kind === 'image' ? object.points : object.rotation), before);
            if (kind === 'text') assert.equal(Number(input.value), 30, 'Text undo restores spinner');
            app.history.redo();
            if (kind === 'text') assert.equal(Number(input.value), 120, 'Text redo restores spinner');
            const committed = JSON.stringify(kind === 'image' ? object.points : object.rotation);
            adapter.beginAnchorDrag('rotate', anchor);
            adapter.updateAnchorDrag(target);
            adapter.endAnchorDrag(false);
            assert.equal(JSON.stringify(kind === 'image' ? object.points : object.rotation), committed, 'Cancel restores geometry');
            assert.equal(app.history.undoStack.length, 1, 'Cancellation adds no undo entry');
            const releaseAnchor = adapter.getAnchors().find(handle => handle.id === 'rotate');
            assert.equal(beginSelectionInteraction(app, releaseAnchor, false), true);
            assert.equal(app._pcbSelectionInteraction.mode, 'anchor');
            const releasePoint = { x: pivot.x + releaseAnchor.y - pivot.y, y: pivot.y - (releaseAnchor.x - pivot.x) };
            finishSelectionInteraction(app, true, releasePoint);
            assert.equal(app.history.undoStack.length, 2, 'Mouse-up applies final rotation without needing another move event');
            assert.equal(app._pcbSelectionInteraction, null, 'Rotation release never becomes a floating resize');
            if (kind === 'text') assert.equal(Number(input.value), 210);
            cancelPictureCopperRefresh(app);

            const overlay = element('g');
            app._getLayerGroup = id => id === 'selection-overlay' ? overlay : null;
            renderPcbSelectionAnchors(app);
            const handles = overlay.children.flatMap(group => group.children);
            assert.equal(handles.filter(handle => handle.tag === 'line').length, 0, 'Rotation control has no connector');
            const rotateHandle = handles.find(handle => handle.attributes.get('data-anchor-id') === 'rotate');
            assert.equal(rotateHandle.tag, 'circle');
            assert.equal(rotateHandle.children[0].textContent, 'Rotate', 'Rotation handle has a tooltip');
            const rotateIcon = handles.find(handle => handle.tag === 'image');
            assert.equal(rotateIcon?.getAttribute('href'), new URL('../assets/icons/RotateIcon.svg', import.meta.url).href);
            assert.equal(Number(rotateIcon.getAttribute('width')), 18);
            assert.equal(rotateIcon.getAttribute('pointer-events'), 'none');
            for (const zoom of [0.1, 1, 10, 100, 1000]) {
                app.viewport.scale = zoom;
                renderPcbSelectionAnchors(app);
                const zoomIcon = overlay.children.flatMap(group => group.children).find(handle => handle.tag === 'image');
                const zoomAnchor = adapter.getAnchors().find(handle => handle.id === 'rotate');
                assert.equal(zoomIcon.getAttribute('width'), '18', 'Image viewport stays large enough to rasterize');
                assert.equal(zoomIcon.getAttribute('height'), '18');
                assert.equal(zoomIcon.getAttribute('x'), '-9');
                assert.equal(zoomIcon.getAttribute('y'), '-9');
                assert.equal(zoomIcon.getAttribute('transform'),
                    `translate(${zoomAnchor.x} ${zoomAnchor.y}) scale(${1 / zoom})`,
                    'Inverse zoom keeps the icon centered and 18 screen pixels wide');
            }
            app.viewport.scale = 10;
            renderPcbSelectionAnchors(app);
            const nextAnchor = adapter.getAnchors().find(handle => handle.id === 'rotate');
            assert.equal(hitTestPcbSelectionAnchor(app, { x: nextAnchor.x + 1, y: nextAnchor.y })?.anchorId, 'rotate',
                'The edge of the visible rotation control is clickable');
            const visibleRotationParts = () => overlay.children.flatMap(group => group.children).filter(handle =>
                handle.attributes.get('data-anchor-id') === 'rotate' || handle.tag === 'image' || handle.tag === 'line');
            for (const commit of [true, false]) {
                const press = adapter.getAnchors().find(handle => handle.id === 'rotate');
                assert.equal(beginSelectionInteraction(app, press, false), true);
                assert.equal(visibleRotationParts().length, 0, 'Press immediately hides button and icon');
                assert.equal(app.viewport.svg.style.cursor, ROTATION_CURSOR, 'Press switches to rotation cursor');
                assert.equal(hitTestPcbSelectionAnchor(app, press), null, 'Hidden rotate control cannot be hit');
                updateSelectionInteraction(app, { x: press.x - 1, y: press.y });
                renderPcbSelectionAnchors(app);
                assert.equal(visibleRotationParts().length, 0, 'Redraws during movement keep the control hidden');
                assert.equal(selectionInteractionCursor(app), ROTATION_CURSOR, 'Mousemove preserves the rotation cursor');
                finishSelectionInteraction(app, commit);
                assert.equal(visibleRotationParts().length, 2, 'Release/cancel restores button and icon');
                assert.equal(app.viewport.svg.style.cursor, 'default', 'Release/cancel restores the normal cursor');
                cancelPictureCopperRefresh(app);
            }
        }
    }
    const source = readFileSync(new URL('../src/ui/PCBApp.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const imageSource = readFileSync(new URL('../src/pcb/modules/board-shapes.js', import.meta.url), 'utf8');
    for (const [inputId, modelName, panelSource] of [
        ['pcbPropTextRot', 'text', source], ['pcbPropTextToolRot', 'd', source],
        ['pcbPropImageRot', 'rotation', imageSource],
    ]) {
        const template = panelSource.match(new RegExp(`<input[^>]*id="${inputId}"[^>]*>`))[0];
        assert.match(template, /step="1"/, `${inputId} increments by one degree`);
        const expression = template.match(/value="\$\{([^}]+)\}"/)[1];
        const displayRotation = new Function(modelName, `return ${expression};`);
        for (const [rotation, expected] of [[12.34567, 12], [12.6, 13], [42, 42], [359.99999, 0]]) {
            assert.equal(displayRotation(modelName === 'rotation' ? rotation : { rotation }), expected,
                `${inputId} displays whole degrees`);
        }
    }
    const methodsStart = source.indexOf('    _selectText(text) {');
    const methodsEnd = source.indexOf('\n    //', source.indexOf('    _endTextDrag(commit = true) {', methodsStart));
    assert.ok(methodsStart >= 0 && methodsEnd > methodsStart);
    const textPrototype = new Function('getPcbSelection', 'setPcbSelection', 'MoveTextCommand',
        `return (class { ${source.slice(methodsStart, methodsEnd)} }).prototype;`)(getPcbSelection, setPcbSelection, MoveTextCommand);
    const textMethods = Object.fromEntries(Object.getOwnPropertyNames(textPrototype)
        .filter(name => name !== 'constructor').map(name => [name, textPrototype[name]]));
    const movingText = { id: 'moving-text', content: 'Move', x: 0, y: 0, size: 2, strokeWidth: 0.2,
        rotation: 0, layer: 'top-copper' };
    const movingOverlay = element('g');
    const movingApp = { ...textMethods, boardShapes: [], texts: new Map([[movingText.id, movingText]]),
        placements: new Map(), tracks: [], vias: [], history: new CommandHistory(),
        viewport: { scale: 10, svg: element('svg'), setCrosshair() {}, hideCrosshair() {} },
        _getLayerGroup(id) { return id === 'selection-overlay' ? movingOverlay : null; },
        _snapToGrid(point) { return point; },
        _refreshText() { if (isPcbSelected(this, 'text', movingText)) renderPcbSelectionAnchors(this); },
    };
    movingApp._selectText(movingText);
    const assertMovingHandle = () => {
        assert.equal(getPcbSelection(movingApp, 'text')[0], movingText, 'Dragged text remains selected');
        const handles = movingOverlay.children.flatMap(group => group.children)
            .filter(handle => handle.attributes.get('data-anchor-id') === 'rotate');
        assert.equal(handles.length, 1, 'Exactly one rotate handle remains attached');
        const expected = rotationHandleAnchor(pcbTextBounds(movingText), movingApp.viewport.scale);
        assert.equal(Number(handles[0].attributes.get('cx')), expected.x);
        assert.equal(Number(handles[0].attributes.get('cy')), expected.y);
    };
    for (let dragIndex = 0; dragIndex < 4; dragIndex++) {
        const bounds = pcbTextBounds(movingText);
        const press = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
        assert.equal(beginSelectionInteraction(movingApp, press, false), true);
        assert.equal(movingApp._pcbSelectionInteraction.mode, 'move-adapter');
        assertMovingHandle();
        updateSelectionInteraction(movingApp, { x: press.x + 8, y: press.y + 3 });
        assertMovingHandle();
        finishSelectionInteraction(movingApp, true);
        assertMovingHandle();
        assert.equal(movingApp.history.undoStack.length, dragIndex + 1);
        cancelPictureCopperRefresh(movingApp);
    }
    console.log('PASS repeated text drags retain selection and keep the rotation handle at the moving text');
} finally {
    globalThis.setTimeout = originalTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCancelRaf;
}
console.log('PASS image/text rotation gestures, live spinners, undo/redo, cancellation, clearance deferral and icon hit targets');