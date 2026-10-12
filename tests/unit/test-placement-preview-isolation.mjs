import assert from 'node:assert/strict';
import { ProjectDocument } from '../../src/core/ProjectDocument.js';
import { Component } from '../../src/components/Component.js';
import { Track } from '../../src/shapes/track.js';
import { CommandHistory } from '../../src/core/CommandHistory.js';
import { previewPlacementPose, finishPlacementPreview, getPlacementPreviewTracks, MovePlacementCommand } from '../../src/pcb/modules/track-commands.js';
import { renderTrack, hasTrackElements } from '../../src/pcb/modules/track-render.js';
import { fakeElement, installFakeDom } from './helpers/fake-dom.mjs';
import { pcbEditorStubs } from './helpers/pcb-editor-stubs.mjs';

installFakeDom();
function fixture() {
    const project = new ProjectDocument();
    project.schematicDocument.components.push(new Component({
        name: 'PreviewFixture', _source: 'KiCad', symbol: { pins: [{ number: '1' }] },
        footprintShapes: ['PAD~RECT~2~0~1~1~1~both~1~0~0.5', 'PAD~RECT~-2~0~1~1~1~both~1~0~0.5'],
    }, { id: 'part' }));
    project.pcbDocument.placementState.record('part', { x: 10, y: 20 });
    const first = new Track({ net: 'N', width: 0.23456789, cornerRadius: 0.12345678,
        points: [{ x: 12, y: 20 }, { x: 30, y: 40 }, { x: 40, y: 45 }],
        edgeBulges: { e0: 0.25 }, edgeLayers: { e1: 'bottom-copper' }, edgeWidths: { e1: 0.3456789 },
        padConnections: { n0: { componentId: 'part', pinNumber: '1' } } });
    // This endpoint already matches the final destination; the command need not redraw it.
    const second = new Track({ net: 'N', points: [{ x: 18, y: 20 }, { x: 40, y: 50 }],
        padConnections: { n0: { componentId: 'part', pinNumber: '1#2' } } });
    const unrelated = new Track({ points: [{ x: 80, y: 80 }, { x: 90, y: 90 }] });
    project.pcbDocument.tracks.push(first, second, unrelated);
    const groups = new Map();
    let dirty = 0;
    const app = { ...pcbEditorStubs(),
        project, pcbDocument: project.pcbDocument, placementState: project.pcbDocument.placementState,
        placements: project.resolvePcbLayout().placements, history: new CommandHistory(),
        get tracks() { return getPlacementPreviewTracks(this) || this.pcbDocument.tracks; },
        getLayerGroup(id) {
            if (!groups.has(id)) groups.set(id, fakeElement('g'));
            return groups.get(id);
        },
        markDirty: () => dirty++,
    };
    for (const track of app.tracks) renderTrack(track, id => app.getLayerGroup(id));
    const lines = () => [...groups.values()].flatMap(group => group.children)
        .filter(element => element.tagName === 'polyline');
    return { app, project, first, second, unrelated, lines, dirty: () => dirty };
}

for (const action of ['cancel', 'commit', 'failure']) {
    const f = fixture(), { app, project, first, second, unrelated } = f;
    const canonical = project.pcbDocument.tracks;
    const geometry = project.pcbDocument.captureGeometry();
    const serialized = project.pcbDocument.serialize();
    const states = canonical.map(track => track.captureState());
    const bounds = canonical.map(track => track.getBounds());
    const lineCount = f.lines().length;
    previewPlacementPose(app, 'part', { x: 15, y: 20 });
    const projected = app.tracks;
    assert.notEqual(projected[0], first);
    assert.notEqual(projected[1], second);
    assert.equal(projected[2], unrelated, 'Only bonded tracks need a projection');
    assert.deepEqual(projected.map(track => track.id), canonical.map(track => track.id));
    for (let index = 0; index < 2; index++) {
        assert.notEqual(projected[index].nodes, canonical[index].nodes);
        assert.notEqual(projected[index].edges, canonical[index].edges);
        assert.notEqual(projected[index].padConnections, canonical[index].padConnections);
        assert.deepEqual([...projected[index].edges], [...canonical[index].edges]);
        assert.deepEqual(projected[index].padConnections, canonical[index].padConnections);
    }
    assert.equal(f.lines().length, lineCount, 'Preview artwork replaces, rather than duplicates, canonical artwork');
    for (let index = 0; index < 100; index++) {
        previewPlacementPose(app, 'part', { x: 16 + index / 100, y: 20 });
        assert.equal(app.tracks, projected, 'Pointer updates reuse the projection array and track identities');
        assert.equal(f.lines().length, lineCount);
    }
    assert.deepEqual(project.pcbDocument.captureGeometry(), geometry, 'Model geometry snapshots exclude live previews');
    assert.deepEqual(project.pcbDocument.serialize(), serialized, 'Model persistence excludes live previews');
    assert.deepEqual(canonical.map(track => track.captureState()), states);
    canonical.forEach((track, index) => assert.equal(track._bounds, bounds[index]));
    assert.equal(f.dirty(), 0);
    assert.equal(app.history.canUndo(), false);
    app.placements.set('other', { ...app.placements.get('part') });
    assert.throws(() => previewPlacementPose(app, 'other', { x: 1 }),
        /Finish the current placement preview/, 'A concurrent component preview cannot overwrite the current one');
    previewPlacementPose(app, 'part', { x: 20, y: 20 });
    if (action === 'commit') {
        finishPlacementPreview(app, () => app.history.execute(new MovePlacementCommand(app, 'part', 10, 20, 20, 20)));
        assert.equal(first.nodes.get('n0').x, 22);
        assert.equal(second.nodes.get('n0').x, 18);
        assert.equal(app.history.undoStack.length, 1);
        assert.equal(f.dirty(), 1);
        assert.ok(hasTrackElements(second), 'A final endpoint needing no model movement still regains canonical artwork');
        app.history.undo();
        assert.equal(first.nodes.get('n0').x, 12);
        app.history.redo();
        assert.equal(first.nodes.get('n0').x, 22);
    } else {
        if (action === 'failure') {
            project.schematicDocument.components.length = 0;
            assert.throws(() => finishPlacementPreview(app,
                () => app.history.execute(new MovePlacementCommand(app, 'part', 10, 20, 20, 20))),
            /PCB footprint is no longer available/);
        } else finishPlacementPreview(app);
        assert.deepEqual(canonical.map(track => track.captureState()), states);
        assert.equal(app.placements.get('part').x, 10);
        assert.equal(app.placements.get('part').pads.get('1').x, 12);
        assert.equal(app.history.canUndo(), false);
        assert.equal(f.dirty(), 0);
    }
    assert.equal(getPlacementPreviewTracks(app), undefined);
    assert.equal(app.tracks, canonical);
    assert.equal(f.lines().length, lineCount);
    assert.ok(canonical.every(hasTrackElements));
    assert.equal(hasTrackElements(projected[0]), false);
    assert.equal(hasTrackElements(projected[1]), false);
}
console.log('PASS isolated placement copper previews, stable projection reuse, SVG handoff and commit failure cleanup');
