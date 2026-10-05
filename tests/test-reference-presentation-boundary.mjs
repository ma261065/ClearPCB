import assert from 'node:assert/strict';
import { beginRefTextDrag, endRefDrag, updateRefTextDrag } from '../src/pcb/modules/ref-text-selection.js';
import { setPcbInteraction } from '../src/pcb/modules/pcb-interactions.js';
import { PcbDocument } from '../src/core/PcbDocument.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { MoveRefTextCommand, RotateRefTextCommand, SetRefStyleCommand } from '../src/pcb/modules/track-commands.js';
import { applyRefGeometry } from '../src/shared/pcb/footprint.js';

class Element {
    attributes = new Map();
    children = [];
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    hasAttribute(name) { return this.attributes.has(name); }
    removeAttribute(name) { this.attributes.delete(name); }
    appendChild(child) { this.children.push(child); }
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); }
    get firstChild() { return this.children[0] || null; }
    querySelectorAll() { return this.children; }
}
globalThis.document = { createElementNS: () => new Element() };
globalThis.window = { addEventListener() {} };
const { default: PCBApp } = await import('../src/ui/PCBApp.js');

for (const side of ['top', 'bottom']) for (const mirror of [false, true]) {
    const reference = new Element(), padNumber = new Element(), group = new Element();
    reference.setAttribute('data-fp-ref', '');
    padNumber.setAttribute('data-mx-center', '2');
    group.appendChild(reference);
    group.appendChild(padNumber);
    applyRefGeometry(reference, 'R12', 3, -2.8, 1.2, 0.15);
    const placement = { x: 10, y: -20, rotation: 37, side, mirror,
        refDx: 1.234567, refDy: -2.345678, refRot: 23.456789,
        refSize: 1.2, refStrokeWidth: 0.15, reference: 'R12', elements: [group],
        _refEl: reference, lodEl: new Element() };
    Object.defineProperty(placement, 'padOffsets', {
        get() { assert.fail('Reference presentation must not recalculate physical pads'); },
    });
    const pcbDocument = new PcbDocument();
    pcbDocument.placementState.record('part', placement);
    let dirty = 0, overlays = 0, boardRefreshes = 0, highlights = 0, caretUpdates = 0;
    const app = {
        pcbDocument, placementState: pcbDocument.placementState,
        placements: new Map([['part', placement]]),
        get tracks() { assert.fail('Reference presentation must not scan track bonds'); },
        refreshClearanceHalos() { assert.fail('Reference presentation must not refresh physical clearance'); },
        viewport: { svg: { style: {} }, snapToGrid: false, gridVisible: true },
        _markDirty: () => dirty++, _drawRefOverlay: () => overlays++,
        _board3d: { refresh: () => boardRefreshes++ },
        _refBox: () => ({}), _refreshRefHighlight: () => highlights++,
        history: new CommandHistory(),
    };
    setPcbInteraction(app, '_textEdit', { options: { componentId: 'part' }, updateCaret: () => caretUpdates++ });
    for (const method of ['_worldToPlacementLocal',
        'snapToGrid', '_rerenderRef']) app[method] = PCBApp.prototype[method];
    const verifyTransform = () => {
        const parts = [];
        if (placement.refDx || placement.refDy) parts.push(`translate(${placement.refDx}, ${placement.refDy})`);
        if (mirror) parts.push('translate(6, 0) scale(-1, 1)');
        if (placement.refRot) parts.push(`rotate(${placement.refRot}, 3, ${reference.getAttribute('data-ref-cy')})`);
        assert.equal(reference.getAttribute('transform'), parts.length ? parts.join(' ') : null);
        const flipped = mirror !== (side === 'bottom');
        assert.equal(padNumber.getAttribute('transform'), flipped ? 'translate(4, 0) scale(-1, 1)' : null,
            'Pad-number counter-mirroring is preserved as presentation only');
        assert.equal(group.getAttribute('transform'), `translate(10, -20) rotate(37)${flipped ? ' scale(-1, 1)' : ''}`);
        assert.equal(placement.lodEl.getAttribute('transform'), group.getAttribute('transform'));
    };
    const original = structuredClone(app.placementState.overrides.get('part'));
    beginRefTextDrag(app, 'part', { x: 10, y: -20 });
    updateRefTextDrag(app, { x: 14, y: -15 });
    verifyTransform();
    assert.deepEqual(app.placementState.overrides.get('part'), original, 'Preview does not write authored overrides');
    endRefDrag(app, false);
    verifyTransform();
    assert.equal(dirty, 0);
    assert.equal(boardRefreshes, 0);

    app.history.execute(new MoveRefTextCommand(app, 'part', placement.refDx, placement.refDy, 4.567891, -5.678912));
    verifyTransform();
    app.history.execute(new RotateRefTextCommand(app, 'part', placement.refRot, 90));
    verifyTransform();
    const oldGlyphs = [...reference.children];
    app.history.execute(new SetRefStyleCommand(app, 'part',
        { refSize: placement.refSize, refStrokeWidth: placement.refStrokeWidth },
        { refSize: 2.345678, refStrokeWidth: 0.234567 }));
    verifyTransform();
    assert.equal(reference.getAttribute('stroke-width'), '0.234567');
    assert.equal(reference.getAttribute('data-ref-size'), '2.345678');
    assert.ok(reference.children.length > 0 && reference.children.every(child => !oldGlyphs.includes(child)));
    assert.equal(placement._refBox, null);
    assert.equal(highlights, 1);
    assert.equal(caretUpdates, 1);
    for (let index = 0; index < 3; index++) { app.history.undo(); verifyTransform(); }
    assert.deepEqual(app.placementState.overrides.get('part'), original);
    for (let index = 0; index < 3; index++) { app.history.redo(); verifyTransform(); }
    assert.equal(dirty, 9, 'Every executed/undone/redone command retains its dirty notification');
    assert.equal(boardRefreshes, 9);
    assert.ok(overlays >= 9);
    const rotatedGlyphs = [...reference.children];
    const cachedBox = { cy: Number(reference.getAttribute('data-ref-cy')) };
    placement._refBox = cachedBox;
    const beforeHighlights = highlights, beforeCarets = caretUpdates;
    app.history.execute(new SetRefStyleCommand(app, 'part', { refRot: placement.refRot }, { refRot: 123 }));
    verifyTransform();
    assert.equal(placement._refBox, cachedBox, 'Rotation-only style edits preserve the local layout box');
    assert.equal(reference.children.length, rotatedGlyphs.length);
    assert.ok(reference.children.every((child, index) => child === rotatedGlyphs[index]),
        'Rotation-only style edits preserve glyph node identity');
    app.history.undo();
    verifyTransform();
    assert.equal(placement._refBox, cachedBox);
    assert.equal(reference.children.length, rotatedGlyphs.length);
    assert.ok(reference.children.every((child, index) => child === rotatedGlyphs[index]));
    assert.equal(highlights, beforeHighlights + 2, 'Reusing glyphs still refreshes highlight presentation');
    assert.equal(caretUpdates, beforeCarets + 2, 'Reusing glyphs still repositions the inline-edit caret');
    app.placements.clear();
    app.history.undo();
    app.history.undo();
    app.history.undo();
    assert.deepEqual(app.placementState.overrides.get('part'), original,
        'Metadata undo still works when the rendered placement is unavailable');
}

delete globalThis.document;
delete globalThis.window;
console.log('PASS reference-only SVG updates avoid physical pads, track scans and clearance work');
