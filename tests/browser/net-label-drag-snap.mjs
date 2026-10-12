import assert from 'node:assert/strict';
import { openSchematic, screenPoint, viewCentre, viewportSettled, waitForPage } from './helpers/editor-helpers.mjs';

export const scenarios = [{
    name: 'net-label-drag-snaps-from-near-pin-like-placement',
    async run(page, url) {
        await openSchematic(page, url);
        const setup = await page.evaluate(async centre => {
            const app = window.bootstrap.schematicApp;
            const { Component } = await import('/src/components/Component.js');
            const { BuiltInComponents } = await import('/src/components/BuiltInComponents.js');
            const { mountComponent } = await import('/src/schematic/modules/schematic-view.js');
            const { Net } = await import('/src/shapes/net.js');
            const component = new Component(BuiltInComponents[0], { ...centre, reference: 'R1' });
            app.components.push(component);
            mountComponent(app, component);
            app.updateSelectableItems();
            const pin = component.getPinPosition('1');
            const label = new Net({ x: pin.x - 10, y: pin.y + 5, net: 'Gnd', style: 'gnd', orientation: 'E' });
            app.addShape(label);
            app.selectTool('select');
            app.selection.select(label);
            app.renderShapes(true);
            app.viewport.zoomIn();
            app.viewport.zoomIn();
            return { pin, labelId: label.id, componentId: component.id, from: { x: label.x, y: label.y } };
        }, await viewCentre(page));
        for (const tool of ['wire', 'net']) {
            await page.evaluate(tool => window.bootstrap.schematicApp.selectTool(tool), tool);
            await viewportSettled(page, 'schematic');
            for (const offset of [0.9, 0.3]) {
                const point = await screenPoint(page, 'schematic', setup.pin.x + offset, setup.pin.y);
                await page.mouse.move(point.x, point.y, { steps: 3 });
                assert.equal(await page.evaluate(() => window.bootstrap.schematicApp.wireSnapPin?.component?.id || null),
                    offset < 0.5 ? setup.componentId : null, `${tool} uses the same 0.5 mm pin pickup range`);
            }
        }
        await page.evaluate(() => window.bootstrap.schematicApp.selectTool('select'));
        for (const pickup of [0, 1.4]) {
            await page.evaluate(id => {
                const app = window.bootstrap.schematicApp;
                app.selection.select(app.shapes.find(shape => shape.id === id));
                app.renderShapes(true);
            }, setup.labelId);
            await viewportSettled(page, 'schematic');
            const start = await screenPoint(page, 'schematic', setup.from.x + pickup, setup.from.y);
            const outside = await screenPoint(page, 'schematic', setup.pin.x + pickup + 0.9, setup.pin.y);
            const end = await screenPoint(page, 'schematic', setup.pin.x + pickup + 0.3, setup.pin.y + 0.1);
            await page.mouse.move(start.x, start.y);
            await page.mouse.down();
            await page.mouse.move(outside.x, outside.y, { steps: 8 });
            assert.equal(await page.evaluate(() => window.bootstrap.schematicApp.wireSnapPin?.component?.id || null),
                null, 'NetLabel does not pull onto a pin from 0.9 mm away');
            await page.mouse.move(end.x, end.y, { steps: 10 });
            const dragResult = await page.evaluate(async id => {
                const app = window.bootstrap.schematicApp;
                const { getSchematicDrag } = await import('/src/schematic/modules/drag.js');
                const label = app.shapes.find(shape => shape.id === id);
                return { label: { x: label.x, y: label.y }, state: app.interactionState,
                    drag: { mode: getSchematicDrag(app)?.mode, shape: getSchematicDrag(app)?.shape?.type },
                    snap: app.wireSnapPin?.component?.id };
            }, setup.labelId);
            assert.ok(Math.hypot(dragResult.label.x - setup.pin.x, dragResult.label.y - setup.pin.y) < 1e-9,
                `Pickup ${pickup}: ${JSON.stringify(dragResult)}`);
            assert.equal(dragResult.drag.mode, pickup === 0 ? 'anchor' : 'move',
                'Browser exercises both the connection anchor and whole-symbol drag paths');
            await waitForPage(page, async ({ id, componentId }) => {
                const app = window.bootstrap.schematicApp;
                const label = app.shapes.find(shape => shape.id === id);
                const component = app.components.find(component => component.id === componentId);
                const pin = component.getPinPosition('1');
                return app.wireSnapPin?.component.id === componentId
                    && Math.hypot(label.x - pin.x, label.y - pin.y) < 1e-9;
            }, { id: setup.labelId, componentId: setup.componentId });
            const stationary = await page.evaluate(id => {
                const label = window.bootstrap.schematicApp.shapes.find(shape => shape.id === id);
                return { x: label.x, y: label.y };
            }, setup.labelId);
            assert.ok(Math.hypot(stationary.x - setup.pin.x, stationary.y - setup.pin.y) < 1e-9,
                'Near-pin pointer pulls the label exactly onto the pin');
            await page.mouse.move(end.x + 0.5, end.y);
            await page.mouse.up();
            assert.deepEqual(await page.evaluate(() => window.bootstrap.project.getNetlist()
                .find(net => net.net === 'Gnd')?.pins), [{ componentId: setup.componentId, pinNumber: '1' }],
            'Drop creates the intended direct-pin net connection');
            await page.keyboard.press('Control+z');
            const restored = await page.evaluate(id => {
                const label = window.bootstrap.schematicApp.shapes.find(shape => shape.id === id);
                return { x: label.x, y: label.y };
            }, setup.labelId);
            assert.deepEqual(restored, setup.from, 'Undo restores the label position');
            await page.keyboard.press('Control+y');
            await waitForPage(page, ({ id, pin }) => {
                const label = window.bootstrap.schematicApp.shapes.find(shape => shape.id === id);
                return Math.hypot(label.x - pin.x, label.y - pin.y) < 1e-9;
            }, { id: setup.labelId, pin: setup.pin });
            await page.keyboard.press('Control+z');
        }
    },
}];
