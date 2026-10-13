import assert from 'node:assert/strict';
import { openSchematic, screenPoint, viewCentre, waitForPage } from './helpers/editor-helpers.mjs';

export const scenarios = [{
    name: 'pasted-component-placement-supports-space-x-y',
    async run(page, url) {
        await openSchematic(page, url);
        const centre = await viewCentre(page);
        await page.evaluate(async position => {
            const app = window.bootstrap.schematicApp;
            const { Component } = await import('/src/components/Component.js');
            const { BuiltInComponents } = await import('/src/components/BuiltInComponents.js');
            const { mountComponent } = await import('/src/schematic/modules/schematic-view.js');
            const component = new Component(BuiltInComponents[0], { ...position, reference: 'R1' });
            app.components.push(component);
            mountComponent(app, component);
            app.updateSelectableItems();
            app.selection.select(component);
            app.renderShapes(true);
        }, centre);
        await page.keyboard.press('Control+c');

        const cases = [
            { key: 'Space', offset: { x: 20, y: 0 }, matrix: [0, 1, -1, 0], rotation: 90, mirror: false },
            { key: 'x', offset: { x: 40, y: 0 }, matrix: [-1, 0, 0, 1], rotation: 0, mirror: true },
            { key: 'y', offset: { x: 60, y: 0 }, matrix: [1, 0, 0, -1], rotation: 180, mirror: true },
        ];
        for (const testCase of cases) {
            const target = { x: centre.x + testCase.offset.x, y: centre.y + testCase.offset.y };
            const targetScreen = await screenPoint(page, 'schematic', target.x, target.y);
            await page.mouse.move(targetScreen.x, targetScreen.y);
            const before = await page.evaluate(() => window.bootstrap.schematicApp.components.length);
            await page.keyboard.press('Control+v');
            await page.keyboard.press(testCase.key);
            const preview = await page.evaluate(() => {
                const app = window.bootstrap.schematicApp;
                const values = app.pastePreviewGroup.getAttribute('transform')
                    .match(/matrix\(([^)]+)\)/)?.[1].trim().split(/\s+/).map(Number);
                return {
                    active: app.interactionState,
                    tool: app.currentTool,
                    matrix: values?.slice(0, 4),
                };
            });
            assert.equal(preview.active, 'placing');
            assert.equal(preview.tool, 'select', `${testCase.key} does not switch tools during paste placement`);
            assert.deepEqual(preview.matrix, testCase.matrix, `${testCase.key} transforms the paste ghost`);
            await page.mouse.click(targetScreen.x, targetScreen.y);
            await waitForPage(page, count => window.bootstrap.schematicApp.components.length === count, before + 1);
            const pasted = await page.evaluate(() => {
                const component = window.bootstrap.schematicApp.components.at(-1);
                return { rotation: component.rotation, mirror: component.mirror };
            });
            assert.deepEqual(pasted, { rotation: testCase.rotation, mirror: testCase.mirror },
                `${testCase.key} applies the preview orientation to the pasted component`);
        }
    },
}];
