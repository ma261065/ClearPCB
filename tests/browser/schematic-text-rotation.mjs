import assert from 'node:assert/strict';
import { openSchematic, clickWorld, viewCentre, saveAndReopen } from './helpers/editor-helpers.mjs';

export const scenarios = [{
    name: 'schematic-text-quarter-turn-controls-and-name',
    async run(page, url) {
        await openSchematic(page, url);
        const centre = await viewCentre(page);
        const tool = page.locator('#ribbonSchematic [data-tool="text"]');
        assert.ok((await tool.textContent()).includes('Text'));
        await tool.click();
        const orientation = page.locator('#prop_newTextOrientation');
        assert.deepEqual(await orientation.locator('option').evaluateAll(options =>
            options.map(option => option.value)), ['0', '90', '180', '270']);
        await orientation.selectOption('180');
        await clickWorld(page, 'schematic', centre.x, centre.y);
        await page.keyboard.type('Quarter turns');
        await page.keyboard.press('Enter');
        assert.equal(await page.evaluate(() => window.bootstrap.schematicApp.shapes[0].rotation), 180,
            'new text uses the selected default orientation');
        await page.keyboard.press('v');
        await page.evaluate(() => {
            const app = window.bootstrap.schematicApp;
            app.selection.select(app.shapes.find(shape => shape.type === 'text'));
            app.updatePropertiesPanel(app.selection.getSelection());
        });
        assert.equal(await page.locator('#propTextHorizontal, #propTextVertical, #propTextRotateLeft, #propTextRotateRight').count(), 0);
        for (const expected of [270, 0, 90, 180]) {
            await page.locator('#propTextOrientation').selectOption(String(expected));
            assert.equal(await page.evaluate(() => window.bootstrap.schematicApp.shapes[0].rotation), expected);
        }
        await page.locator('#propTextOrientation').selectOption('90');
        assert.equal(await page.evaluate(() => window.bootstrap.schematicApp.shapes[0].rotation), 90);
        await page.keyboard.press('Control+z');
        assert.equal(await page.evaluate(() => window.bootstrap.schematicApp.shapes[0].rotation), 180);
        await page.keyboard.press('Control+y');
        assert.equal(await page.evaluate(() => window.bootstrap.schematicApp.shapes[0].rotation), 90);
        await page.locator('#propTextOrientation').selectOption('0');
        assert.equal(await page.evaluate(() => window.bootstrap.schematicApp.shapes[0].rotation), 0);
        await saveAndReopen(page, 'schematic');
        assert.equal(await page.evaluate(() => window.bootstrap.schematicApp.shapes[0].rotation), 0);
    },
}];
