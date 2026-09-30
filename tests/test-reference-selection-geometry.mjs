import assert from 'node:assert/strict';
import { layoutReferenceText, referenceAnchor, resolveReferenceText } from '../src/pcb/modules/reference-text.js';
import { placementPose } from '../src/pcb/modules/board-geometry.js';
import { createRefTextSelectionAdapter } from '../src/pcb/modules/ref-text-selection.js';
import { lockPositionOutsideOutline } from '../src/pcb/modules/selection-anchors.js';
import { PCB_LAYERS } from '../src/pcb/modules/layers.js';
import { getPcbSelectionHits } from '../src/pcb/modules/selection-registry.js';

globalThis.window = { addEventListener() {} };
const { default: PCBApp } = await import('../src/ui/PCBApp.js');
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10,
    `Expected ${actual} to equal ${expected}`);
const nearPoint = (actual, expected) => { near(actual.x, expected.x); near(actual.y, expected.y); };

for (const side of ['top', 'bottom']) for (const mirror of [false, true]) {
    for (const rotation of [0, 37, 90]) for (const refRot of [0, 37, 90, 123, 180]) {
        const placement = { x: 13.123456, y: -20.234567, rotation, side, mirror,
            reference: 'R12345', outline: { x: 2, y: -4, width: 6 },
            refDx: 3.456789, refDy: -5.678912, refRot, refSize: 1.2, refStrokeWidth: 0.15 };
        const anchor = referenceAnchor(placement.outline);
        const box = layoutReferenceText(placement.reference, anchor.cx, anchor.baseY,
            placement.refSize, placement.refStrokeWidth).box;
        let boxReads = 0;
        const app = { placements: new Map([['part', placement]]), _refBox: () => { boxReads++; return box; } };
        for (const name of ['_hitTestRefText', '_worldToPlacementLocal', '_placementLocalToWorld', '_refCenterWorld']) {
            app[name] = PCBApp.prototype[name];
        }
        const adapter = createRefTextSelectionAdapter(app, 'part', 'reftext:part');
        const rendered = resolveReferenceText(placement);
        for (const point of rendered.polylines.flat()) {
            assert.equal(app._hitTestRefText(point), 'part',
                `Rendered glyphs must be hittable: side=${side}, mirror=${mirror}, rotation=${rotation}, refRot=${refRot}`);
            assert.equal(adapter.hitTest(point), true);
        }
        const pose = placementPose(placement);
        const angle = refRot * Math.PI / 180;
        const worldPoint = (x, y) => {
            const dx = x - box.cx, dy = y - box.cy;
            const rx = dx * Math.cos(angle) - dy * Math.sin(angle);
            const ry = dx * Math.sin(angle) + dy * Math.cos(angle);
            return pose.xf(box.cx + (mirror ? -rx : rx) + placement.refDx,
                box.cy + ry + placement.refDy);
        };
        const corners = [
            [box.bx, box.by], [box.bx + box.bw, box.by],
            [box.bx + box.bw, box.by + box.bh], [box.bx, box.by + box.bh],
        ].map(([x, y]) => worldPoint(x, y));
        const expectedBounds = {
            minX: Math.min(...corners.map(p => p.x)), minY: Math.min(...corners.map(p => p.y)),
            maxX: Math.max(...corners.map(p => p.x)), maxY: Math.max(...corners.map(p => p.y)),
        };
        const bounds = adapter.getBounds();
        for (const key of Object.keys(expectedBounds)) near(bounds[key], expectedBounds[key]);
        nearPoint(adapter.getPosition(), worldPoint(box.cx, box.cy));
        for (const point of [
            worldPoint(box.bx - 2, box.cy), worldPoint(box.bx + box.bw + 2, box.cy),
            worldPoint(box.cx, box.by - 2), worldPoint(box.cx, box.by + box.bh + 2),
        ]) {
            assert.equal(adapter.hitTest(point), false, 'Points beyond the rendered box and hit margin must miss');
            nearPoint(adapter.getLockPosition(point, 8), lockPositionOutsideOutline(corners, point, 8));
        }
        placement.refVisible = false;
        assert.equal(adapter.visible, false);
        assert.equal(adapter.hitTest(rendered.polylines[0][0]), false, 'Hidden references remain unselectable');
        placement.refVisible = true;
        const silk = PCB_LAYERS.find(layer => layer.id === `${side}-silk`);
        const otherSilk = PCB_LAYERS.find(layer => layer.id === `${side === 'top' ? 'bottom' : 'top'}-silk`);
        const point = rendered.polylines[0][0];
        const originalVisibility = silk.visible, otherVisibility = otherSilk.visible;
        try {
            otherSilk.visible = false;
            assert.equal(adapter.visible, true, 'Hiding the opposite silk layer must not hide this reference');
            assert.equal(adapter.hitTest(point), true);
            silk.visible = false;
            assert.equal(adapter.visible, false, 'Hidden silk must exclude reference adapters from shared selection');
            boxReads = 0;
            assert.equal(app._hitTestRefText(point), null, 'Legacy picking must ignore hidden silk references');
            assert.equal(boxReads, 0, 'Hidden references must be skipped before resolving their layout boxes');
            assert.deepEqual(getPcbSelectionHits(app, point, ['reftext']), [],
                'Shared picking must not let an invisible label intercept clicks');
            silk.visible = true;
            assert.equal(adapter.visible, true);
            assert.equal(adapter.hitTest(point), true, 'Restoring silk visibility restores picking immediately');
        } finally {
            silk.visible = originalVisibility;
            otherSilk.visible = otherVisibility;
        }
        app.placements.delete('part');
        assert.equal(adapter.visible, false, 'A stale adapter for a removed placement is not visible');
    }
}

{
    const bottomSilk = PCB_LAYERS.find(layer => layer.id === 'bottom-silk');
    const originalVisibility = bottomSilk.visible;
    const app = {
        placements: new Map([
            ['front', { x: 0, y: 0, side: 'top' }],
            ['back', { x: 0, y: 0, side: 'bottom' }],
        ]),
        _refBox: () => ({ bx: -2, by: -1, bw: 4, bh: 2, cx: 0, cy: 0 }),
        _hitTestRefText: PCBApp.prototype._hitTestRefText,
        _worldToPlacementLocal: PCBApp.prototype._worldToPlacementLocal,
        _placementLocalToWorld: PCBApp.prototype._placementLocalToWorld,
    };
    try {
        assert.equal(app._hitTestRefText({ x: 0, y: 0 }), 'back', 'Visible overlapping labels retain topmost ordering');
        bottomSilk.visible = false;
        assert.equal(app._hitTestRefText({ x: 0, y: 0 }), 'front', 'A hidden topmost reference must not obscure a visible hit');
        assert.deepEqual(getPcbSelectionHits(app, { x: 0, y: 0 }, ['reftext']).map(entry => entry.object), ['front']);
    } finally { bottomSilk.visible = originalVisibility; }
}

delete globalThis.window;
console.log('PASS reference rendered glyph hits, selection bounds and lock positions across side/mirror/rotation combinations');
