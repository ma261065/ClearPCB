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
            return { centre, id: component.id };
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
        const after = await page.evaluate(id => window.bootstrap.schematicApp.components
            .find(component => component.id === id).captureState(), setup.id);
        await page.keyboard.press('Control+z');
        assert.ok(Math.abs(await page.evaluate(id => window.bootstrap.schematicApp.components
            .find(component => component.id === id).x, setup.id) - setup.centre.x) < 1e-9);
        await page.keyboard.press('Control+y');
        assert.deepEqual(await page.evaluate(id => window.bootstrap.schematicApp.components
            .find(component => component.id === id).captureState(), setup.id), after);
    },
}];
