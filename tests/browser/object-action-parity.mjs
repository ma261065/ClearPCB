import assert from 'node:assert/strict';
import { openSchematic, openPcb } from './helpers/editor-helpers.mjs';

export const scenarios = [{
    name: 'schematic-properties-offer-context-node-segment-and-text-actions',
    async run(page, url) {
        await openSchematic(page, url);
        const results = await page.evaluate(async () => {
            const app = window.bootstrap.schematicApp;
            const { createLine } = await import('/src/shapes/polyline.js');
            const { Text } = await import('/src/shapes/text.js');
            const { Wire } = await import('/src/shapes/wire.js');
            const { describePropertiesPanel } = await import('/src/schematic/modules/properties.js');
            const { setShapeNodeFocus, setShapeSegmentFocus } = await import('/src/schematic/modules/shape-focus.js');
            const shape = createLine({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] });
            app.shapes.push(shape);
            app.updateSelectableItems();
            app.selection.select(shape);
            const actions = () => describePropertiesPanel(app, app.selection.getSelection()).actions
                .flatMap(group => group.actions);
            const labels = () => actions().map(action => action.label);
            setShapeNodeFocus(app, { shapeId: shape.id, nodeId: 'n1' });
            const node = labels();
            setShapeNodeFocus(app, null);
            setShapeSegmentFocus(app, { shapeId: shape.id, edgeId: 'e0' });
            const segment = labels();
            actions().find(action => action.label === 'Convert to Arc Segment').run();
            const curved = !!shape.edges.get('e0').bulge;
            app.history.undo();
            const undo = !shape.edges.get('e0').bulge;
            shape.locked = true;
            const lockedActions = labels().filter(label => label.startsWith('Delete') || label.startsWith('Convert'));
            shape.locked = false;
            const text = new Text({ x: 0, y: 0, text: 'annotation' });
            app.shapes.push(text);
            app.updateSelectableItems();
            app.selection.select(text);
            const textActions = labels();
            const wire = new Wire();
            const a = wire.addNode(30, 0), b = wire.addNode(40, 0), c = wire.addNode(50, 0);
            const edge = wire.addEdge(a, b);
            wire.addEdge(b, c);
            wire.pinConnections.set(b, { componentId: 'parity-pin', pinNumber: '1' });
            app.shapes.push(wire);
            app.updateSelectableItems();
            app.selection.select(wire);
            setShapeNodeFocus(app, { shapeId: wire.id, nodeId: b });
            setShapeSegmentFocus(app, null);
            const wireNode = labels();
            setShapeNodeFocus(app, null);
            setShapeSegmentFocus(app, { shapeId: wire.id, edgeId: edge });
            const wireSegment = labels();
            return { node, segment, textActions, wireNode, wireSegment, lockedActions, curved, undo };
        });
        for (const label of ['Split', 'Delete node']) assert.ok(results.node.includes(label), label);
        for (const label of ['Convert to Arc Segment', 'Delete Segment', 'Delete shape']) {
            assert.ok(results.segment.includes(label), label);
        }
        assert.ok(results.textActions.includes('Delete Text'));
        for (const label of ['Split', 'Delete point', 'Disconnect pin']) assert.ok(results.wireNode.includes(label), label);
        for (const label of ['Delete Segment', 'Delete Wire']) assert.ok(results.wireSegment.includes(label), label);
        assert.equal(results.curved, true, 'Properties conversion executes the shared command');
        assert.equal(results.undo, true, 'Properties conversion remains undoable');
        assert.deepEqual(results.lockedActions, [], 'Locked shapes do not offer context mutations in Properties');
    },
}, {
    name: 'pcb-properties-offer-context-path-fill-and-via-actions',
    async run(page, url) {
        await openPcb(page, url);
        const results = await page.evaluate(async () => {
            const app = window.bootstrap.pcbApp;
            const { Track } = await import('/src/shapes/track.js');
            const { Via } = await import('/src/shapes/via.js');
            const { CopperFill } = await import('/src/shapes/copper-fill.js');
            const { selectBoardShape } = await import('/src/pcb/modules/board-shapes.js');
            const { showBoardShapeProperties } = await import('/src/pcb/modules/board-shape-properties.js');
            const { setBoardShapeNodeFocus, setBoardShapeSegmentFocus } = await import('/src/pcb/modules/board-shape-state.js');
            const { selectTrackOrVia, selectTrackNode, selectTrackSegment } = await import('/src/pcb/modules/track-select.js');
            const { showFillProperties } = await import('/src/pcb/modules/copper-fill-edit.js');
            const { setPcbSelection } = await import('/src/pcb/modules/selection-registry.js');
            let panel;
            const original = app.refreshPropertyPanel.bind(app);
            app.refreshPropertyPanel = description => { panel = description; original(description); };
            const actions = () => panel.actions?.flatMap(group => group.actions) || [];
            const labels = () => actions().map(action => action.label);
            const shape = { id: 'parity-shape', kind: 'line', layer: 'top-silk', lineWidth: 0.2,
                points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] };
            app.boardShapes.push(shape);
            selectBoardShape(app, shape);
            setBoardShapeNodeFocus(app, { shapeId: shape.id, index: 1 });
            showBoardShapeProperties(app, shape);
            const shapeNode = labels();
            setBoardShapeNodeFocus(app, null);
            setBoardShapeSegmentFocus(app, { shapeId: shape.id, segment: 0 });
            showBoardShapeProperties(app, shape);
            const shapeSegment = labels();
            actions().find(action => action.label === 'Convert to Arc Segment').run();
            const curved = !!shape.segmentBulges?.[0];
            app.history.undo();
            const undo = !shape.segmentBulges?.[0];
            shape.locked = true;
            showBoardShapeProperties(app, shape);
            const lockedActions = labels();
            shape.locked = false;
            const track = new Track({ layer: 'top-copper', width: 0.2, net: 'SIGNAL' });
            const a = track.addNode(20, 0), b = track.addNode(30, 0), c = track.addNode(30, 10);
            const edge = track.addEdge(a, b);
            track.addEdge(b, c);
            app.tracks.push(track);
            selectTrackOrVia(app, { type: 'track', track });
            selectTrackNode(app, track, b);
            const trackNode = labels();
            selectTrackSegment(app, track, edge);
            const trackSegment = labels();
            const fill = new CopperFill({ id: 'parity-fill', layer: 'top-copper',
                outline: [{ x: 0, y: -10 }, { x: 10, y: -10 }, { x: 10, y: -20 }, { x: 0, y: -20 }] });
            app.boardShapes.push(fill);
            setPcbSelection(app, [{ kind: 'fill', object: fill }]);
            setBoardShapeNodeFocus(app, { shapeId: fill.id, index: 0 });
            setBoardShapeSegmentFocus(app, null);
            showFillProperties(app, fill);
            const fillNode = labels();
            setBoardShapeNodeFocus(app, null);
            setBoardShapeSegmentFocus(app, { shapeId: fill.id, segment: 0 });
            showFillProperties(app, fill);
            const fillSegment = labels();
            const via = new Via({ x: 20, y: -10, diameter: 0.6, drill: 0.3 });
            app.vias.push(via);
            selectTrackOrVia(app, { type: 'via', via });
            const viaActions = labels();
            actions().find(action => action.label === 'Delete via').run();
            const viaDeleted = !app.vias.includes(via);
            app.history.undo();
            const viaRestored = app.vias.includes(via);
            return { shapeNode, shapeSegment, trackNode, trackSegment, fillNode, fillSegment, viaActions,
                lockedActions, curved, undo, viaDeleted, viaRestored };
        });
        for (const key of ['shapeNode', 'trackNode']) {
            for (const label of ['Split', 'Delete node']) assert.ok(results[key].includes(label), `${key}: ${label}`);
        }
        for (const key of ['shapeSegment', 'trackSegment', 'fillSegment']) {
            for (const label of ['Convert to Arc Segment', 'Delete segment']) {
                assert.ok(results[key].includes(label), `${key}: ${label}`);
            }
        }
        assert.ok(results.shapeSegment.includes('Delete line'));
        assert.ok(results.trackSegment.includes('Delete track'));
        assert.ok(results.fillSegment.includes('Delete copper fill'));
        assert.ok(results.fillNode.includes('Delete node'));
        assert.ok(results.viaActions.includes('Delete via'));
        assert.equal(results.curved, true);
        assert.equal(results.undo, true);
        assert.deepEqual(results.lockedActions, []);
        assert.equal(results.viaDeleted, true, 'Properties via deletion uses the real delete command');
        assert.equal(results.viaRestored, true, 'Properties via deletion remains undoable');
    },
}];
