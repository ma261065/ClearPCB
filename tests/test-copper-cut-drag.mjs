import assert from 'node:assert/strict';
import { PcbDocument } from '../src/core/PcbDocument.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { CopperFill } from '../src/shapes/copper-fill.js';
import { setComputedFill } from '../src/pcb/modules/computed-fill-cache.js';
import { renderCopperFill } from '../src/pcb/modules/copper-fill-render.js';
import { setPcbSelection } from '../src/pcb/modules/selection-registry.js';

class Element {
    constructor(tag = 'g') { this.tag = tag; this.attributes = new Map(); this.children = []; this.style = {}; this.dataset = {}; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    hasAttribute(name) { return this.attributes.has(name); }
    appendChild(child) { child.remove(); this.children.push(child); child.parentNode = this; }
    insertBefore(child, next) {
        child.remove();
        const index = this.children.indexOf(next);
        this.children.splice(index < 0 ? this.children.length : index, 0, child);
        child.parentNode = this;
    }
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; }
    remove() { this.parentNode?.removeChild(this); }
    get firstChild() { return this.children[0] || null; }
    querySelectorAll(selector) {
        const attr = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector);
        const matches = element => selector[0] === '#' ? element.getAttribute('id') === selector.slice(1)
            : selector[0] === '.' ? (element.getAttribute('class') || '').split(' ').includes(selector.slice(1))
            : attr ? element.hasAttribute(attr[1]) && (attr[2] === undefined || element.getAttribute(attr[1]) === attr[2])
            : element.tag === selector;
        return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
globalThis.window = { addEventListener() {} };
globalThis.document = { createElementNS: (_, tag) => new Element(tag), getElementById: () => null };
const { default: PCBApp } = await import('../src/ui/PCBApp.js');
const { renderBoardShape, boardShapeCopperCuts, startBoardShapeDrag, handleBoardShapeDrag, endBoardShapeDrag,
    createBoardShapeSelectionAdapter, getBoardShapeRotationPreview } =
    await import('../src/pcb/modules/board-shapes.js');
const { beginGroupDrag, updateGroupDrag, endGroupDrag, cancelGroupDrag } =
    await import('../src/pcb/modules/box-select.js');
const timers = new Map();
const originalSetTimeout = globalThis.setTimeout, originalClearTimeout = globalThis.clearTimeout;
let nextTimer = 0;
globalThis.setTimeout = callback => { timers.set(++nextTimer, callback); return nextTimer; };
globalThis.clearTimeout = id => timers.delete(id);
const flush = () => {
    const callbacks = [...timers.values()];
    timers.clear();
    for (const callback of callbacks) callback();
};

try {
    for (const layer of ['top-copper', 'bottom-copper', 'hole']) for (const copperMode of ['remove-copper', 'remove-copper-mask']) {
        for (const group of [false, true]) for (const commit of [false, true]) {
            const pcbDocument = new PcbDocument();
            const shape = { id: 'cut', kind: 'rect', layer, copperMode, filled: true, lineWidth: 0.2,
                points: [{ x: 5, y: 5 }, { x: 9, y: 5 }, { x: 9, y: 9 }, { x: 5, y: 9 }] };
            pcbDocument.boardShapes.push(shape);
            const defs = new Element('defs');
            const groups = new Map(['top-copper', 'bottom-copper', 'top-fill', 'bottom-fill', 'hole']
                .map(id => [id, new Element()]));
            const app = {
                pcbDocument, get boardShapes() { return Object.getOwnPropertyDescriptor(PCBApp.prototype, 'boardShapes').get.call(this); },
                placements: new Map(), texts: new Map(),
                tracks: [], vias: [], pads: [], _shapeElements: new Map(), _layerGroups: groups,
                history: new CommandHistory(), _ensureSvgDefs: () => defs, getLayerGroup: id => groups.get(id),
                viewport: { scale: 10, gridVisible: false, svg: new Element('svg'),
                    setCrosshair() {}, hideCrosshair() {},
                    getVisibleBounds: () => ({ minX: 0, minY: 0, maxX: 40, maxY: 40 }) },
                updateCopperCuts: PCBApp.prototype.updateCopperCuts,
            };
            for (const side of ['top', 'bottom']) {
                const fill = new CopperFill({ layer: `${side}-copper`, outline: [
                    { x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 },
                ] });
                setComputedFill(fill, [{ outer: fill.outline, holes: [] }]);
                renderCopperFill(fill, app.getLayerGroup);
            }
            renderBoardShape(app, shape);
            const sides = layer === 'hole' ? ['top', 'bottom'] : [layer.split('-')[0]];
            const initialCuts = Object.fromEntries(sides.map(side => [side, boardShapeCopperCuts(app, `${side}-copper`).d]));
            const initialPaths = Object.fromEntries(sides.map(side => [side, defs.querySelector(`#pcb-copper-cut-${side}`).firstChild]));
            const assertCuts = expected => {
                for (const side of sides) {
                    const clipId = `pcb-copper-cut-${side}`;
                    assert.ok(defs.querySelector(`#${clipId}`).firstChild.getAttribute('d').endsWith(` ${expected[side]}`),
                        `${layer}/${copperMode}: the visible fill must retain the expected cutout`);
                    assert.equal(groups.get(`${side}-fill`).querySelector('.pcb-fill-copper').getAttribute('clip-path'), `url(#${clipId})`);
                }
            };
            setPcbSelection(app, [{ kind: 'shape', object: shape }]);
            if (group) beginGroupDrag(app, { x: 0, y: 0 });
            else assert.equal(startBoardShapeDrag(app, shape, { x: 0, y: 0 }, null, { whole: true }), true);
            for (let step = 1; step <= 20; step++) {
                if (group) updateGroupDrag(app, { x: step, y: 0 }, { snap: false });
                else handleBoardShapeDrag(app, { x: step, y: 0 });
                assertCuts(initialCuts);
                for (const side of sides) assert.equal(defs.querySelector(`#pcb-copper-cut-${side}`).firstChild, initialPaths[side],
                    'Pointer movement must not rebuild the committed copper clip');
            }
            flush();
            assertCuts(initialCuts);
            const movedCuts = Object.fromEntries(sides.map(side => [side, boardShapeCopperCuts(app, `${side}-copper`).d]));
            assert.notDeepEqual(movedCuts, initialCuts);
            app.viewport.getVisibleBounds = () => ({ minX: 4, minY: 4, maxX: 30, maxY: 30 });
            app.updateCopperCuts({ geometryChanged: false });
            assertCuts(initialCuts);
            app.updateCopperCuts();
            assertCuts(initialCuts);
            if (group) {
                if (commit) endGroupDrag(app);
                else cancelGroupDrag(app);
            } else endBoardShapeDrag(app, commit);
            assertCuts(initialCuts);
            flush();
            assertCuts(commit ? movedCuts : initialCuts);
            assert.equal(app.history.undoStack.length, commit ? 1 : 0);
            if (commit) {
                app.history.undo();
                flush();
                assertCuts(initialCuts);
                app.history.redo();
                flush();
                assertCuts(movedCuts);
            }
            assert.equal(timers.size, 0);
        }
    }
    for (const side of ['top', 'bottom']) for (const copperMode of ['remove-copper', 'remove-copper-mask']) {
        for (const commit of [false, true]) {
            const pcbDocument = new PcbDocument();
            const shape = {
                id: 'image-cut', kind: 'image', layer: `${side}-copper`, copperMode, filled: true, lineWidth: 0.05,
                points: [{ x: 5, y: 5 }, { x: 9, y: 5 }, { x: 9, y: 7 }, { x: 5, y: 7 }],
                artwork: { width: 4, height: 2, rectangles: [{ x: 0, y: 0, width: 4, height: 2 }] },
            };
            pcbDocument.boardShapes.push(shape);
            const before = pcbDocument.serialize();
            const defs = new Element('defs');
            const groups = new Map([`${side}-copper`, `${side}-fill`, `${side}-copper-knockout`]
                .map(id => [id, new Element()]));
            const app = {
                pcbDocument, get boardShapes() { return getBoardShapeRotationPreview(this)?.boardShapes || pcbDocument.boardShapes; },
                history: new CommandHistory(), _shapeElements: new Map(), _layerGroups: groups,
                _ensureSvgDefs: () => defs, getLayerGroup: id => groups.get(id),
                updateCopperCuts: PCBApp.prototype.updateCopperCuts,
                viewport: { scale: 10, getVisibleBounds: () => ({ minX: 0, minY: 0, maxX: 40, maxY: 40 }) },
            };
            const fill = new CopperFill({ layer: `${side}-copper`, outline: [
                { x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 },
            ] });
            setComputedFill(fill, [{ outer: fill.outline, holes: [] }]);
            renderCopperFill(fill, app.getLayerGroup);
            renderBoardShape(app, shape);
            const initial = boardShapeCopperCuts(app, shape.layer).d;
            const clipId = `pcb-copper-cut-${side}`;
            const path = defs.querySelector(`#${clipId}`).firstChild;
            const assertCut = expected => {
                assert.ok(defs.querySelector(`#${clipId}`).firstChild.getAttribute('d').endsWith(` ${expected}`));
                assert.equal(groups.get(`${side}-fill`).querySelector('.pcb-fill-copper').getAttribute('clip-path'), `url(#${clipId})`);
            };
            const adapter = createBoardShapeSelectionAdapter(app, shape, `shape:${shape.id}`);
            adapter.beginAnchorDrag('rotate', { x: 12, y: 6 });
            for (let angle = 5; angle <= 90; angle += 5) {
                const radians = -angle * Math.PI / 180;
                adapter.updateAnchorDrag({ x: 7 + 5 * Math.cos(radians), y: 6 + 5 * Math.sin(radians) });
                assertCut(initial);
                assert.equal(defs.querySelector(`#${clipId}`).firstChild, path, 'Rotation retains the settled copper clip');
                assert.deepEqual(pcbDocument.serialize(), before);
            }
            const rotated = boardShapeCopperCuts(app, shape.layer).d;
            assert.notEqual(rotated, initial);
            flush();
            app.updateCopperCuts({ geometryChanged: false });
            app.updateCopperCuts();
            assertCut(initial);
            adapter.endAnchorDrag(commit);
            assertCut(initial);
            flush();
            assertCut(commit ? rotated : initial);
            if (commit) {
                app.history.undo();
                flush();
                assertCut(initial);
                app.history.redo();
                flush();
                assertCut(rotated);
            }
            assert.equal(timers.size, 0);
        }
    }
} finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
}
console.log('PASS stable copper cutouts during single/group drags and image rotation, viewport changes, drop, cancellation and history');
