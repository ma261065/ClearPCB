import assert from 'node:assert/strict';
import { openSchematic, screenPoint, viewCentre, viewportSettled } from './helpers/editor-helpers.mjs';

export const scenarios = [{
    name: 'no-connect-on-pin-shows-connection-dot',
    async run(page, url) {
        await openSchematic(page, url);
        await page.evaluate(async centre => {
            const { Component } = await import('/src/components/Component.js');
            const { BuiltInComponents } = await import('/src/components/BuiltInComponents.js');
            const { NoConnect } = await import('/src/shapes/noconnect.js');
            const { mountComponent } = await import('/src/schematic/modules/schematic-view.js');
            const app = window.bootstrap.schematicApp;
            const component = new Component(BuiltInComponents.find(def => def.name === 'Resistor'),
                { ...centre, reference: 'R1', rotation: 90, mirror: true });
            app.components.push(component);
            mountComponent(app, component);
            const marker = new NoConnect({
                ...component.getPinPosition('1'),
                pinConnection: { componentId: component.id, pinNumber: '1' },
            });
            app.addShape(marker);
            app.renderShapes(true);
        }, await viewCentre(page));
        const dot = page.locator('.direct-pin-junction-dot');
        assert.equal(await dot.count(), 1);
        assert.equal(await dot.evaluate(node => getComputedStyle(node).fill), 'rgb(0, 204, 102)');
        await page.evaluate(() => window.bootstrap.schematicApp.history.undo());
        assert.equal(await dot.count(), 0, 'Undoing No Connect placement removes the dot');
        await page.evaluate(() => window.bootstrap.schematicApp.history.redo());
        assert.equal(await dot.count(), 1, 'Redo restores the dot');
        await page.evaluate(() => {
            const app = window.bootstrap.schematicApp;
            app.shapes.find(shape => shape.type === 'noconnect').move(2, 0);
            app.renderShapes(true);
        });
        assert.equal(await dot.count(), 0, 'An off-pin marker has no connection dot');
        await page.evaluate(() => {
            const app = window.bootstrap.schematicApp;
            const marker = app.shapes.find(shape => shape.type === 'noconnect');
            marker.move(-2, 0);
            app.selection.select(marker);
            app.renderShapes(true);
        });
        assert.equal(await dot.count(), 1);
        await page.keyboard.press('Delete');
        assert.equal(await dot.count(), 0, 'Deleting No Connect removes the dot');
        await page.keyboard.press('Control+z');
        assert.equal(await dot.count(), 1, 'Undoing deletion restores the dot');
        await page.keyboard.press('Control+y');
        assert.equal(await dot.count(), 0, 'Redoing deletion clears the dot');
    },
}, {
    name: 'no-connect-pin-magnetism-matches-wire-pickup',
    async run(page, url) {
        await openSchematic(page, url);
        const setup = await page.evaluate(async centre => {
            const { Component } = await import('/src/components/Component.js');
            const { BuiltInComponents } = await import('/src/components/BuiltInComponents.js');
            const { mountComponent } = await import('/src/schematic/modules/schematic-view.js');
            const app = window.bootstrap.schematicApp;
            const component = new Component(BuiltInComponents.find(def => def.name === 'Resistor'),
                { ...centre, reference: 'R1' });
            app.components.push(component);
            mountComponent(app, component);
            app.updateSelectableItems();
            app.viewport.zoomIn();
            app.viewport.zoomIn();
            return { pin: component.getPinPosition('1'), componentId: component.id };
        }, await viewCentre(page));
        for (const tool of ['wire', 'noconnect']) {
            await page.evaluate(tool => window.bootstrap.schematicApp.selectTool(tool), tool);
            await viewportSettled(page, 'schematic');
            for (const offset of [0.9, 0.51, 0.49, 0.3]) {
                const point = await screenPoint(page, 'schematic', setup.pin.x + offset, setup.pin.y);
                await page.mouse.move(point.x, point.y, { steps: 3 });
                assert.equal(await page.evaluate(() => window.bootstrap.schematicApp.wireSnapPin?.component?.id || null),
                    offset < 0.5 ? setup.componentId : null,
                    `${tool} ${offset < 0.5 ? 'accepts' : 'rejects'} ${offset} mm approach`);
            }
        }
        await page.mouse.down();
        await page.mouse.up();
        const placed = await page.evaluate(() => {
            const marker = window.bootstrap.schematicApp.shapes.find(shape => shape.type === 'noconnect');
            return { x: marker.x, y: marker.y, bond: marker.pinConnection };
        });
        assert.deepEqual({ x: placed.x, y: placed.y }, setup.pin, 'Click agrees with preview');
        assert.deepEqual(placed.bond, { componentId: setup.componentId, pinNumber: '1' });
        await page.keyboard.press('Control+z');
        const outside = await screenPoint(page, 'schematic', setup.pin.x + 0.9, setup.pin.y);
        await page.mouse.click(outside.x, outside.y);
        assert.equal(await page.evaluate(() =>
            window.bootstrap.schematicApp.shapes.find(shape => shape.type === 'noconnect').pinConnection), null,
        'Click outside the wire pickup radius does not bond the marker');
    },
}];
