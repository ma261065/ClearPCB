import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { installFakeDom } from './helpers/fake-dom.mjs';

installFakeDom();
const { pcbEditorFixture } = await import('./pcb-editor-fixture.mjs');
const { beginDragSession, copperNets, refreshDragRatlines, releaseDragSession } = await import('../../src/pcb/modules/drag-session.js');
const { areDragOverlaysDeferred, isBoardViewRefreshSuspended, setDragOverlaysDeferred } = await import('../../src/pcb/modules/refresh-state.js');
const { beginComponentDrag, endComponentDrag } = await import('../../src/pcb/modules/component-selection.js');

// A drag defers derived overlays while it runs, keeps the ratlines of the nets it moves
// live, and on release restores exactly what it found.

const ratlineUpdates = [];
const app = pcbEditorFixture({ updateRatsnest: options => ratlineUpdates.push(options) });

assert.deepEqual(copperNets([{ net: 'GND' }, { net: '' }, null, { net: 'VCC' }, { net: 'GND' }]), new Set(['GND', 'VCC']),
    'copper without a net draws no ratlines');

{
    const session = beginDragSession(app, { nets: ['GND', ''] });
    assert.equal(areDragOverlaysDeferred(app), true, 'a drag defers overlays');
    assert.equal(isBoardViewRefreshSuspended(app), false, 'and leaves the board view live unless asked');
    refreshDragRatlines(app, session);
    assert.deepEqual(ratlineUpdates.splice(0), [{ nets: new Set(['GND']) }], 'a move redraws only the moved nets');
    assert.equal(releaseDragSession(app, session), true);
    assert.equal(areDragOverlaysDeferred(app), false, 'release restores what begin found');
    refreshDragRatlines(app, session);
    assert.deepEqual(ratlineUpdates, [], 'a released drag redraws nothing');
    assert.equal(releaseDragSession(app, session), false, 'releasing twice is harmless');
}
{
    const session = beginDragSession(app, { nets: [] });
    refreshDragRatlines(app, session);
    assert.deepEqual(ratlineUpdates, [], 'a drag of netless copper (or a pour) redraws no ratlines');
    releaseDragSession(app, session);
}
{
    // Nested inside another preview: the inner drag hands back the outer deferral.
    const outer = beginDragSession(app, { suspendBoardView: true });
    assert.equal(isBoardViewRefreshSuspended(app), true);
    const inner = beginDragSession(app);
    releaseDragSession(app, inner);
    assert.equal(areDragOverlaysDeferred(app), true, 'an inner drag keeps the outer deferral');
    assert.equal(isBoardViewRefreshSuspended(app), true);
    releaseDragSession(app, outer);
    assert.equal(areDragOverlaysDeferred(app), false);
    assert.equal(isBoardViewRefreshSuspended(app), false);
}
{
    // A component drag used to force overlays back on at its end, even inside a preview
    // that had deferred them.
    const editor = pcbEditorFixture({
        placements: new Map([['U1', { x: 0, y: 0, rotation: 0, bounds: { x: -1, y: -1, width: 2, height: 2 }, padOffsets: [], pads: new Map() }]]),
        netlist: [{ net: 'N1', pins: [{ componentId: 'U1' }] }],
        refreshClearanceHalos() {}, updateRatsnest() {},
        viewport: { svg: { style: {} }, scale: 10, hideCrosshair() {}, setCrosshair() {} },
    });
    setDragOverlaysDeferred(editor, true);
    assert.ok(beginComponentDrag(editor, 'U1', { x: 0, y: 0 }));
    endComponentDrag(editor, false);
    assert.equal(areDragOverlaysDeferred(editor), true, 'a component drag hands back the deferral it found');
    setDragOverlaysDeferred(editor, false);
    assert.ok(beginComponentDrag(editor, 'U1', { x: 0, y: 0 }));
    endComponentDrag(editor, false);
    assert.equal(areDragOverlaysDeferred(editor), false);
}

// Every drag and preview defers overlays through a session, never by setting the flag.
const modules = new URL('../../src/pcb/modules/', import.meta.url);
const setters = readdirSync(modules).filter(name => name.endsWith('.js') && !['drag-session.js', 'refresh-state.js'].includes(name))
    .filter(name => /\bsetDragOverlaysDeferred\s*\(/.test(readFileSync(new URL(name, modules), 'utf8')));
assert.deepEqual(setters, [], 'only drag-session.js sets overlay deferral');

console.log('PASS drag sessions: deferral saved and restored once, ratlines only for moved nets, one way to defer');
