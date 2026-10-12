import assert from 'node:assert/strict';
import { openSchematic, clickWorld, screenPoint, viewCentre, viewportSettled, waitForPage } from './helpers/editor-helpers.mjs';

export const scenarios = [{
    name: 'pin-net-label-follows-component-drag-and-transform',
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
            const label = new Net({ ...component.getPinPosition('1'), net: 'Gnd', style: 'gnd' });
            app.addShape(label);
            app.selectTool('select');
            app.selection.select(component);
            app.renderShapes(true);
            return { componentId: component.id, labelId: label.id, centre };
        }, await viewCentre(page));
        const capture = () => page.evaluate(({ componentId, labelId }) => {
            const app = window.bootstrap.schematicApp;
            const component = app.components.find(item => item.id === componentId);
            const label = app.shapes.find(item => item.id === labelId);
            const text = label.labelText;
            return { component: component.captureState(), label: label.captureState(), text: text.captureState(),
                pin: component.getPinPosition('1'), textPosition: label.getTextPosition(),
                nets: window.bootstrap.project.getNetlist() };
        }, setup);
        const assertAttached = state => {
            assert.ok(Math.hypot(state.label.x - state.pin.x, state.label.y - state.pin.y) < 1e-9);
            assert.ok(Math.hypot(state.text.x - state.textPosition.x, state.text.y - state.textPosition.y) < 1e-9);
            assert.deepEqual(state.nets.find(net => net.net === 'Gnd')?.pins,
                [{ componentId: setup.componentId, pinNumber: '1' }]);
        };
        await viewportSettled(page, 'schematic');
        const before = await capture();
        const start = await screenPoint(page, 'schematic', setup.centre.x, setup.centre.y);
        const end = await screenPoint(page, 'schematic', setup.centre.x + 10, setup.centre.y + 10);
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await page.mouse.move(end.x, end.y, { steps: 12 });
        const preview = await capture();
        assertAttached(preview);
        assert.ok(Math.hypot(preview.component.x - before.component.x, preview.component.y - before.component.y) > 5,
            'Carried label does not magnetically prevent component movement');
        await page.keyboard.press('Escape');
        await page.mouse.up();
        assert.deepEqual(await capture(), before, 'Escape restores component, label and visible text');
        await clickWorld(page, 'schematic', setup.centre.x, setup.centre.y);
        await viewportSettled(page, 'schematic');
        const startAgain = await screenPoint(page, 'schematic', setup.centre.x, setup.centre.y);
        const endAgain = await screenPoint(page, 'schematic', setup.centre.x + 10, setup.centre.y + 10);
        await page.mouse.move(startAgain.x, startAgain.y);
        await page.mouse.down();
        await page.mouse.move(endAgain.x, endAgain.y, { steps: 12 });
        await page.mouse.up();
        const after = await capture();
        assertAttached(after);
        await page.keyboard.press('Control+z');
        assert.deepEqual(await capture(), before);
        await page.keyboard.press('Control+y');
        assert.deepEqual(await capture(), after);
        await page.keyboard.press('Space');
        const rotated = await capture();
        assertAttached(rotated);
        assert.notEqual(rotated.component.rotation, after.component.rotation);
        await page.keyboard.press('Control+z');
        assert.deepEqual(await capture(), after);
        await page.keyboard.press('Control+y');
        assertAttached(await capture());
        await page.locator('.mode-tab[data-mode="pcb"]').click();
        await waitForPage(page, () => window.bootstrap.pcbApp.netNames().includes('Gnd'));
    },
}];
