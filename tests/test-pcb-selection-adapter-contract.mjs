/**
 * Selection adapter contract: SelectionManager skips an entry whose hit bounds
 * (getHitBounds, else getBounds) cannot contain the pointer, so hitTest must never
 * succeed outside them. Every PCB adapter kind is sampled around representative
 * awkward geometry at several zooms, unselected and selected.
 */
import assert from 'node:assert/strict';
import { PcbDocument } from '../src/core/PcbDocument.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { createPcbText } from '../src/core/pcb-text.js';

function element() {
    const attributes = new Map();
    return {
        style: {}, dataset: {}, children: [], classList: { add() {}, remove() {}, toggle() {} },
        setAttribute(name, value) { attributes.set(name, String(value)); },
        getAttribute(name) { return attributes.get(name) ?? null; },
        removeAttribute(name) { attributes.delete(name); },
        appendChild(child) { this.children.push(child); return child; },
        insertBefore(child) { this.children.push(child); return child; },
        remove() {}, querySelector: () => null, querySelectorAll: () => [],
        addEventListener() {}, removeEventListener() {},
    };
}
globalThis.window = { addEventListener() {}, removeEventListener() {} };
globalThis.HTMLElement = class {};
globalThis.document = {
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    createElement: element, createElementNS: element,
};
globalThis.requestAnimationFrame = callback => { callback(); return 1; };

const { default: PCBApp } = await import('../src/ui/PCBApp.js');
const { syncPcbSelection, setPcbSelection } = await import('../src/pcb/modules/selection-registry.js');
const { Track } = await import('../src/shapes/track.js');
const { Via } = await import('../src/shapes/via.js');
const { Pad } = await import('../src/shapes/pad.js');
const { CopperFill } = await import('../src/shapes/copper-fill.js');
const { layoutReferenceText, referenceAnchor } = await import('../src/shared/pcb/reference-text.js');

const triangle = [{ x: 0, y: 0 }, { x: 17, y: 29 }, { x: 28, y: 20 }];
const quad = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 12 }, { x: 0, y: 12 }];
const at = (points, dx, dy) => points.map(p => ({ x: p.x + dx, y: p.y + dy }));

function boardFixture() {
    const pcbDocument = new PcbDocument();
    const shapes = [
        { id: 's-node-radius', kind: 'polygon', layer: 'top-copper', lineWidth: 0.2, filled: false,
            points: at(triangle, 0, 0), nodeCornerRadii: { 1: 9.5 } },
        { id: 's-filled-radius', kind: 'polygon', layer: 'top-silk', lineWidth: 0.4, filled: true,
            points: at(triangle, 40, 0), cornerRadius: 12 },
        { id: 's-hole', kind: 'polygon', layer: 'hole', lineWidth: 0.2, filled: true,
            points: at(triangle, 80, 0), nodeCornerRadii: { 0: 6, 2: 4 } },
        { id: 's-rect', kind: 'rect', layer: 'top-copper', lineWidth: 1.5, filled: false,
            points: at(quad, 0, 40), cornerRadius: 50 },
        { id: 's-bulged', kind: 'polygon', layer: 'top-silk', lineWidth: 0.6, filled: false,
            points: at(quad, 40, 40), segmentBulges: { 0: 0.8, 2: -0.6 }, segmentWidths: { 1: 2 } },
        { id: 's-line', kind: 'line', layer: 'top-copper', lineWidth: 2.5,
            points: at(triangle, 80, 40), nodeCornerRadii: { 1: 8 } },
        { id: 's-arc', kind: 'arc', layer: 'top-silk', lineWidth: 1.2,
            start: { x: 0, y: 80 }, end: { x: 20, y: 80 }, bulge: { x: 10, y: 72 } },
        { id: 's-circle', kind: 'circle', layer: 'top-copper', lineWidth: 1, filled: false, x: 50, y: 85, radius: 6 },
    ];
    pcbDocument.boardShapes.push(...shapes,
        new CopperFill({ id: 'fill-rounded', layer: 'top-copper', kind: 'polygon',
            outline: at(triangle, 0, 110), nodeCornerRadii: { 1: 9.5 } }),
        new CopperFill({ id: 'fill-rect', layer: 'bottom-copper', kind: 'rect', outline: at(quad, 40, 110), cornerRadius: 30 }));
    pcbDocument.tracks.push(
        new Track({ id: 't-rounded', net: 'N', layer: 'top-copper', width: 0.3,
            points: at(triangle, 120, 0), nodeCornerRadii: { n1: 9.5 } }),
        new Track({ id: 't-wide-arc', net: 'N', layer: 'top-copper', width: 3,
            points: at(triangle, 120, 40), edgeBulges: { e0: 0.9 } }),
    );
    pcbDocument.vias.push(new Via({ id: 'via', x: 130, y: 90, diameter: 1.2, drill: 0.6 }));
    pcbDocument.pads.push(new Pad({ id: 'pad-stadium', x: 140, y: 90, shape: 'stadium', size: 1.5, ratio: 3, rotation: 30 }),
        new Pad({ id: 'pad-rect', x: 150, y: 90, shape: 'rectangle', size: 2, ratio: 2, rotation: 45 }));
    const text = createPcbText({ id: 'label', content: 'Contract', layer: 'top-silk', x: 160, y: 10, rotation: 37 });
    pcbDocument.texts.set(text.id, text);

    const outline = { x: -3, y: -2, width: 6, height: 4 };
    const anchor = referenceAnchor(outline);
    const refBox = layoutReferenceText('R12', anchor.cx, anchor.baseY, 1.2, 0.15).box;
    const placement = { x: 170, y: 60, rotation: 30, side: 'top', mirror: false, reference: 'R12', outline,
        bounds: { x: -3, y: -2, width: 6, height: 4 }, refDx: 1, refDy: -4, refRot: 20, refSize: 1.2,
        refStrokeWidth: 0.15, refVisible: true, padOffsets: [], pads: new Map(), elements: [] };

    const app = {
        pcbDocument, history: new CommandHistory(), _active: true, currentTool: 'select',
        placements: new Map([['R12', placement]]),
        viewport: { scale: 10, svg: { style: {} }, setCrosshair() {}, hideCrosshair() {} },
        getLayerGroup: () => element(), _shapeElements: new Map(), _layerGroups: new Map(),
        _refBox: () => refBox, refreshText() {}, _drawRefOverlay() {}, _refreshPcbSelectionHighlights() {},
    };
    for (const name of ['texts', 'tracks', 'vias', 'pads', 'boardShapes']) {
        const descriptor = Object.getOwnPropertyDescriptor(PCBApp.prototype, name);
        if (descriptor) Object.defineProperty(app, name, descriptor);
        else app[name] = pcbDocument[name];
    }
    app.copperFills = pcbDocument.boardShapes.filter(shape => shape.type === 'fill');
    for (const name of ['_worldToPlacementLocal', '_placementLocalToWorld',
        '_hitTestRefText', '_refCenterWorld']) app[name] = PCBApp.prototype[name];
    return app;
}

const app = boardFixture();
syncPcbSelection(app);
const manager = app._pcbSelection;
const kinds = new Set(manager.shapes.map(adapter => adapter.kind));
for (const kind of ['shape', 'fill', 'track', 'via', 'pad', 'text', 'component', 'reftext']) {
    assert.ok(kinds.has(kind), `fixture covers ${kind} adapters`);
}

const violations = [];
let hits = 0;
for (const scale of [2, 10, 60]) {
    app.viewport.scale = scale;
    const tolerance = manager._effectiveTolerance();
    for (const selected of [false, true]) {
        for (const adapter of [...manager.shapes]) {
            setPcbSelection(app, selected ? [{ kind: adapter.kind, object: adapter.object }] : []);
            syncPcbSelection(app);
            const entry = manager.shapes.find(item => item.id === adapter.id);
            if (!entry?.visible) continue;
            const visual = entry.getBounds();
            // Sample well beyond the visual bounds: escaping them is exactly the failure mode.
            const margin = 12 + 4 * tolerance;
            const minX = visual.minX - margin, maxX = visual.maxX + margin;
            const minY = visual.minY - margin, maxY = visual.maxY + margin;
            const steps = 70;
            for (let i = 0; i <= steps; i++) for (let j = 0; j <= steps; j++) {
                const point = { x: minX + (maxX - minX) * i / steps, y: minY + (maxY - minY) * j / steps };
                if (!entry.hitTest(point, tolerance)) continue;
                hits++;
                if (!manager._boundsMayHit(entry, point, tolerance)) {
                    violations.push(`${entry.id} (scale ${scale}, ${selected ? 'selected' : 'unselected'}) hit at `
                        + `(${point.x.toFixed(2)}, ${point.y.toFixed(2)}) outside its hit bounds`);
                }
            }
        }
    }
}
setPcbSelection(app, []);
assert.ok(hits > 1000, `contract sampling exercised real hits (${hits})`);
const byEntry = new Map();
for (const violation of violations) {
    const key = violation.split(' hit at')[0];
    if (!byEntry.has(key)) byEntry.set(key, violation);
}
assert.deepEqual([...byEntry.values()], [], 'hitTest succeeded where SelectionManager would never call it');

console.log(`PASS selection adapter contract: ${manager.shapes.length} entries, ${kinds.size} kinds, 3 zooms, `
    + `selected and unselected, ${hits} hits inside hit bounds`);
