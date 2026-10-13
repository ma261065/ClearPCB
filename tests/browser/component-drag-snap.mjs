import assert from 'node:assert/strict';
import { openSchematic, screenPoint, viewCentre, viewportSettled } from './helpers/editor-helpers.mjs';

export const scenarios = [{
    name: 'component-drag-attached-wires-do-not-show-false-snap-dots',
    async run(page, url) {
        await openSchematic(page, url);
        const setup = await page.evaluate(async centre => {
            const app = window.bootstrap.schematicApp;
            const { Component } = await import('/src/components/Component.js');
            const { BuiltInComponents } = await import('/src/components/BuiltInComponents.js');
            const { Wire } = await import('/src/shapes/wire.js');
            const { mountComponent } = await import('/src/schematic/modules/schematic-view.js');
            const component = new Component(BuiltInComponents[0], { ...centre, reference: 'R1' });
            app.components.push(component);
            mountComponent(app, component);
            app.updateSelectableItems();
            for (const number of ['1', '2']) {
                const pin = component.getPinPosition(number);
                const wire = new Wire({ points: [pin, { x: pin.x + (number === '1' ? -15 : 15), y: pin.y }],
                    net: `N${number}` });
                wire.pinConnections.set([...wire.nodes.keys()][0], { componentId: component.id, pinNumber: number });
                app.addShape(wire);
            }
            app.selectTool('select');
            app.selection.select(component);
            app.renderShapes(true);
            app.viewport.snapToGrid = false;
            app.viewport.zoomIn();
            app.viewport.zoomIn();
            return { centre, id: component.id,
                wireStates: app.shapes.filter(shape => shape.type === 'wire').map(wire => wire.captureState()) };
        }, await viewCentre(page));
        await viewportSettled(page, 'schematic');
        const start = await screenPoint(page, 'schematic', setup.centre.x, setup.centre.y);
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        for (const delta of [1, 1.3, 1.6, 2, 2.3, 3, 4]) {
            const end = await screenPoint(page, 'schematic', setup.centre.x + delta, setup.centre.y);
            await page.mouse.move(end.x, end.y, { steps: 4 });
            const state = await page.evaluate(id => {
                const app = window.bootstrap.schematicApp;
                const component = app.components.find(item => item.id === id);
                const connections = app.shapes.filter(shape => shape.type === 'wire').flatMap(wire =>
                    [...wire.pinConnections].filter(([, connection]) => connection.componentId === id)
                        .map(([nodeId, connection]) => {
                            const pin = component.getPinPosition(connection.pinNumber);
                            const node = wire.nodes.get(nodeId);
                            return Math.hypot(pin.x - node.x, pin.y - node.y);
                        }));
                return { state: app.interactionState, x: component.x, distances: connections,
                    highlightedPin: app.wireSnapPin?.component?.id || null };
            }, setup.id);
            assert.equal(state.state, 'moveDrag');
            assert.equal(state.highlightedPin, null);
            assert.equal(await page.locator('.wire-junction-highlight').count(), 0,
                'Yellow connection targets do not flicker on sticky wire/bridge nodes');
            assert.equal(state.distances.length, 2);
            assert.ok(state.distances.every(distance => distance < 1e-9), 'Both attached wires still follow their pins');
            assert.ok(Math.abs(state.x - setup.centre.x - delta) < 0.3,
                'A false pin snap does not pull the component off the pointer');
        }
        await page.mouse.up();
        assert.equal(await page.locator('.wire-junction-highlight').count(), 0);
        const after = await page.evaluate(id => {
            const app = window.bootstrap.schematicApp;
            return {
                component: app.components.find(component => component.id === id).captureState(),
                wires: app.shapes.filter(shape => shape.type === 'wire').map(wire => ({
                    state: wire.captureState(),
                    temporaryNodes: [...wire.nodes.values()].filter(node =>
                        node._stickyBridge || node._stickyBridgeBend || node._pinDetachJunction).length,
                })),
            };
        }, setup.id);
        assert.ok(after.wires.every(wire => Object.keys(wire.state.edges).length === 1
            && wire.temporaryNodes === 0), 'Commit removes temporary bridge topology from both straight wires');
        await page.keyboard.press('Control+z');
        const undone = await page.evaluate(id => {
            const app = window.bootstrap.schematicApp;
            return {
                x: app.components.find(component => component.id === id).x,
                wires: app.shapes.filter(shape => shape.type === 'wire').map(wire => wire.captureState()),
            };
        }, setup.id);
        assert.ok(Math.abs(undone.x - setup.centre.x) < 1e-9);
        assert.deepEqual(undone.wires, setup.wireStates, 'Undo restores exact pre-bridge wire graphs');
        await page.keyboard.press('Control+y');
        assert.deepEqual(await page.evaluate(id => {
            const app = window.bootstrap.schematicApp;
            return {
                component: app.components.find(component => component.id === id).captureState(),
                wires: app.shapes.filter(shape => shape.type === 'wire').map(wire => ({
                    state: wire.captureState(),
                    temporaryNodes: [...wire.nodes.values()].filter(node =>
                        node._stickyBridge || node._stickyBridgeBend || node._pinDetachJunction).length,
                })),
            };
        }, setup.id), after);
    },
}, {
    name: 'component-drag-sticky-bridges-have-no-false-horizontal-guides',
    async run(page, url) {
        await openSchematic(page, url);
        const setup = await page.evaluate(async centre => {
            const app = window.bootstrap.schematicApp;
            const { Component } = await import('/src/components/Component.js');
            const { BuiltInComponents } = await import('/src/components/BuiltInComponents.js');
            const { Wire } = await import('/src/shapes/wire.js');
            const { mountComponent } = await import('/src/schematic/modules/schematic-view.js');
            const component = new Component(BuiltInComponents[0], { ...centre, reference: 'R1' });
            app.components.push(component);
            mountComponent(app, component);
            app.updateSelectableItems();
            for (const number of ['1', '2']) {
                const pin = component.getPinPosition(number);
                const wire = new Wire({ net: `N${number}`,
                    points: [pin, { x: pin.x + (number === '1' ? -20 : 20), y: pin.y }] });
                wire.pinConnections.set([...wire.nodes.keys()][0], { componentId: component.id, pinNumber: number });
                app.addShape(wire);
            }
            app.selectTool('select');
            app.selection.select(component);
            app.renderShapes(true);
            app.viewport.snapToGrid = false;
            app.viewport.zoomIn();
            app.viewport.zoomIn();
            return { centre, id: component.id };
        }, await viewCentre(page));
        await viewportSettled(page, 'schematic');
        const start = await screenPoint(page, 'schematic', setup.centre.x, setup.centre.y);
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        const guideState = () => page.evaluate(async id => {
            const app = window.bootstrap.schematicApp;
            const { getAxisGlowState } = await import('/src/shapes/axis-glow.js');
            const state = getAxisGlowState(app);
            const component = app.components.find(component => component.id === id);
            return { y: component.y, guides: (state.resolved || []).map(({ segment }) => ({
                a: segment.a, b: { x: segment.b.x, y: segment.b.y },
                axis: segment.axisKind ?? null, collinear: !!segment.collinear,
            })), highlights: state.halos?.length || 0,
                styles: (state.resolved || []).map(({ dashKind }) => dashKind),
                colors: (state.halos || []).map(halo => halo.getAttribute('stroke')),
                connections: app.shapes.filter(shape => shape.type === 'wire').flatMap(wire =>
                    [...wire.pinConnections].filter(([, connection]) => connection.componentId === id)
                        .map(([nodeId, connection]) => {
                            const node = wire.nodes.get(nodeId), pin = component.getPinPosition(connection.pinNumber);
                            return Math.hypot(node.x - pin.x, node.y - pin.y);
                        })) };
        }, setup.id);
        for (const offset of [4, 4.03, 4.08, 4.12, 4.2]) {
            const end = await screenPoint(page, 'schematic', setup.centre.x, setup.centre.y + offset);
            await page.mouse.move(end.x, end.y, { steps: 8 });
            const state = await guideState();
            assert.ok(Math.abs(state.y - setup.centre.y - offset) < 0.15, 'Bridge does not magnetize to its previous Y');
            assert.deepEqual(state.guides, [], 'Automatic H stubs do not advertise a horizontal alignment');
            assert.equal(state.highlights, 0);
            assert.equal(state.connections.length, 2);
            assert.ok(state.connections.every(distance => distance < 1e-9));
        }
        const alreadyStraight = await screenPoint(page, 'schematic', setup.centre.x, setup.centre.y + 0.03);
        await page.mouse.move(alreadyStraight.x, alreadyStraight.y, { steps: 8 });
        const state = await guideState();
        assert.ok(Math.abs(state.y - setup.centre.y) < 1e-9);
        assert.deepEqual(state.guides, [], 'Wires that began straight do not gain transition feedback');
        assert.equal(state.highlights, 0);
        await page.keyboard.press('Escape');
        await page.mouse.up();
        assert.equal((await guideState()).highlights, 0, 'Cancelling clears all alignment feedback');
    },
}, {
    name: 'component-drag-collinearity-stops-at-surviving-doglegs',
    async run(page, url) {
        await openSchematic(page, url);
        const setup = await page.evaluate(async centre => {
            const app = window.bootstrap.schematicApp;
            const { Component } = await import('/src/components/Component.js');
            const { Wire } = await import('/src/shapes/wire.js');
            const { mountComponent } = await import('/src/schematic/modules/schematic-view.js');
            const pins = Array.from({ length: 5 }, (_, index) => ({
                number: String(index + 1), x: -8, y: index * 4 - 8, orientation: 'left', length: 0,
            }));
            const component = new Component({ name: 'Five-wire guide probe', symbol: {
                width: 16, height: 24, pins,
                graphics: [{ type: 'rect', x: -6, y: -11, width: 12, height: 22, strokeWidth: 0.25, fill: 'none' }],
            } }, { ...centre, reference: 'U2' });
            app.components.push(component);
            mountComponent(app, component);
            app.updateSelectableItems();
            for (const [index, pin] of pins.entries()) {
                const point = component.getPinPosition(pin.number);
                const corner = { x: point.x - 20, y: point.y };
                const end = { x: corner.x, y: corner.y - 15 };
                const points = index < 2 ? [point, corner, end, { x: end.x - 10, y: end.y }]
                    : [point, corner, end];
                const wire = new Wire({ points, net: `N${pin.number}` });
                wire.pinConnections.set([...wire.nodes.keys()][0], { componentId: component.id, pinNumber: pin.number });
                app.addShape(wire);
            }
            app.selectTool('select');
            app.selection.select(component);
            app.renderShapes(true);
            app.viewport.snapToGrid = false;
            return { centre, id: component.id, ends: pins.map((pin, index) => ({
                from: { x: centre.x + pin.x - 20, y: centre.y + pin.y },
                to: { x: centre.x + pin.x - 20, y: centre.y + pin.y - 15 },
            })) };
        }, await viewCentre(page));
        await viewportSettled(page, 'schematic');
        const start = await screenPoint(page, 'schematic', setup.centre.x, setup.centre.y);
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        const away = await screenPoint(page, 'schematic', setup.centre.x - 30, setup.centre.y);
        await page.mouse.move(away.x, away.y, { steps: 10 });
        const aligned = await screenPoint(page, 'schematic', setup.centre.x - 20, setup.centre.y);
        await page.mouse.move(aligned.x, aligned.y, { steps: 10 });
        const result = await page.evaluate(async () => {
            const app = window.bootstrap.schematicApp;
            const { getAxisGlowState } = await import('/src/shapes/axis-glow.js');
            const { Wire } = await import('/src/shapes/wire.js');
            const feedback = getAxisGlowState(app).resolved || [];
            return { guides: feedback.map(({ segment, dashKind }) => ({
                y: segment.a.y, to: { x: segment.b.x, y: segment.b.y },
                collinear: segment.collinear, dashKind,
            })).sort((a, b) => a.y - b.y), cleanedEdges: app.shapes.filter(shape => shape.type === 'wire').map(wire => {
                const copy = new Wire();
                copy.applyState(wire.captureState());
                copy.cleanGraph();
                return copy.edges.size;
            }) };
        });
        assert.equal(result.guides.length, 5, 'Every disappearing horizontal dogleg receives an indicator');
        assert.deepEqual(result.guides.map(guide => guide.y).sort((a, b) => a - b),
            setup.ends.map(end => end.from.y).sort((a, b) => a - b));
        assert.ok(result.guides.every(guide => guide.collinear && guide.dashKind === 'dotted'));
        for (const [index, end] of setup.ends.entries()) {
            assert.deepEqual(result.guides[index].to, end.to,
                'Each guide covers the straightened prefix but stops at the next retained bend');
        }
        assert.deepEqual(result.cleanedEdges, [2, 2, 1, 1, 1],
            'Top two retain their later bend; bottom three can collapse completely');
        await page.keyboard.press('Escape');
        await page.mouse.up();
    },
}, {
    name: 'component-drag-collinearity-covers-complete-straight-run',
    async run(page, url) {
        await openSchematic(page, url);
        const setup = await page.evaluate(async centre => {
            const app = window.bootstrap.schematicApp;
            const { Component } = await import('/src/components/Component.js');
            const { Wire } = await import('/src/shapes/wire.js');
            const { mountComponent } = await import('/src/schematic/modules/schematic-view.js');
            const pins = Array.from({ length: 5 }, (_, index) => ({
                number: String(index + 1), x: -8, y: index * 4 - 8, orientation: 'left', length: 0,
            }));
            const component = new Component({ name: 'Full-length guide probe', symbol: {
                width: 16, height: 24, pins,
                graphics: [{ type: 'rect', x: -6, y: -11, width: 12, height: 22, strokeWidth: 0.25, fill: 'none' }],
            } }, { ...centre, reference: 'U2' });
            app.components.push(component);
            mountComponent(app, component);
            app.updateSelectableItems();
            const extents = [];
            for (const [index, pin] of pins.entries()) {
                const point = component.getPinPosition(pin.number);
                const x = point.x - 15;
                const end = { x, y: point.y - 30 };
                const points = [point, { x, y: point.y }, { x, y: point.y - 10 },
                    { x, y: point.y - 20 }, end];
                const wire = new Wire({ points, net: `N${pin.number}` });
                wire.pinConnections.set([...wire.nodes.keys()][0], { componentId: component.id, pinNumber: pin.number });
                app.addShape(wire);
                extents.push({ from: point, to: end });
            }
            app.selectTool('select');
            app.selection.select(component);
            app.renderShapes(true);
            app.viewport.snapToGrid = false;
            return { centre, extents, dragX: 15 };
        }, await viewCentre(page));
        await viewportSettled(page, 'schematic');
        const start = await screenPoint(page, 'schematic', setup.centre.x, setup.centre.y);
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        const away = await screenPoint(page, 'schematic', setup.centre.x - 25, setup.centre.y);
        await page.mouse.move(away.x, away.y, { steps: 10 });
        const aligned = await screenPoint(page, 'schematic', setup.centre.x - setup.dragX, setup.centre.y);
        await page.mouse.move(aligned.x, aligned.y, { steps: 10 });
        const result = await page.evaluate(async () => {
            const { getAxisGlowState } = await import('/src/shapes/axis-glow.js');
            const app = window.bootstrap.schematicApp;
            const state = getAxisGlowState(app);
            const endpoints = elements => elements.map(element => ({
                from: { x: Number(element.getAttribute('x1')), y: Number(element.getAttribute('y1')) },
                to: { x: Number(element.getAttribute('x2')), y: Number(element.getAttribute('y2')) },
            })).sort((a, b) => a.from.y - b.from.y);
            return { guides: (state.resolved || []).map(({ segment, dashKind }) => ({
                from: segment.a, to: { x: segment.b.x, y: segment.b.y }, collinear: segment.collinear, dashKind,
            })).sort((a, b) => a.from.y - b.from.y),
                halos: endpoints(state.halos || []), centerlines: endpoints(state.top || []) };
        });
        assert.equal(result.guides.length, 5, 'All five straightened sections receive collinearity feedback');
        for (const [index, extent] of setup.extents.entries()) {
            const guide = result.guides[index];
            assert.equal(guide.collinear, true);
            assert.equal(guide.dashKind, 'dotted');
            assert.ok(Math.hypot(guide.from.x - (extent.from.x - setup.dragX), guide.from.y - extent.from.y) < 1e-9);
            assert.deepEqual(guide.to, extent.to, 'Guide reaches the far end, including both top-wire stationary segments');
            assert.deepEqual(result.halos[index].to, extent.to, 'Rendered halo covers full collinear length');
            assert.deepEqual(result.centerlines[index].to, extent.to, 'Dotted centerline is not truncated halfway');
        }
        await page.keyboard.press('Escape');
        await page.mouse.up();
    },
}];
