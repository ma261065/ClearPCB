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
            const hitArea = await page.evaluate(async () => {
                const { viewOf } = await import('/src/schematic/render/shape-view-state.js');
                const app = window.bootstrap.schematicApp;
                const text = app.shapes[0];
                const glyphs = viewOf(text).element.querySelector('text');
                const box = glyphs.getBBox();
                const rad = text.rotation * Math.PI / 180;
                const local = (x, y) => ({ x: text.x + (x - text.x) * Math.cos(rad) - (y - text.y) * Math.sin(rad),
                    y: text.y + (x - text.x) * Math.sin(rad) + (y - text.y) * Math.cos(rad) });
                return {
                    inside: app.selection.hitTest(local(box.x + box.width / 2, box.y + box.height / 2)) === text,
                    outside: app.selection.hitTest(local(box.x + box.width + text.fontSize * 0.2,
                        box.y + box.height / 2)) === text,
                };
            });
            assert.equal(hitArea.inside, true);
            assert.equal(hitArea.outside, false, 'text hit area does not inherit oversized thin-line padding');
        }
        await page.locator('#propTextOrientation').selectOption('90');
        assert.equal(await page.evaluate(() => window.bootstrap.schematicApp.shapes[0].rotation), 90);
        await page.keyboard.press('Control+z');
        assert.equal(await page.evaluate(() => window.bootstrap.schematicApp.shapes[0].rotation), 180);
        await page.keyboard.press('Control+y');
        assert.equal(await page.evaluate(() => window.bootstrap.schematicApp.shapes[0].rotation), 90);
        await page.locator('#propTextOrientation').selectOption('0');
        assert.equal(await page.evaluate(() => window.bootstrap.schematicApp.shapes[0].rotation), 0);
        await page.evaluate(() => {
            const app = window.bootstrap.schematicApp;
            app.shapes[0].border = true;
            app.shapes[0].invalidate();
            app.renderShapes(true);
        });
        for (const side of ['left', 'bottom']) {
            const pointer = await page.evaluate(async side => {
                const { viewOf } = await import('/src/schematic/render/shape-view-state.js');
                const app = window.bootstrap.schematicApp;
                const text = app.shapes[0];
                const border = viewOf(text).element.children[0];
                const x = Number(border.getAttribute('x')), y = Number(border.getAttribute('y'));
                const w = Number(border.getAttribute('width')), h = Number(border.getAttribute('height'));
                const point = side === 'left' ? { x: x - text.fontSize * 0.2, y: y + h / 2 }
                    : { x: x + w / 2, y: y + h + text.fontSize * 0.2 };
                const screen = app.viewport.worldToScreen(point);
                const rect = app.viewport.svg.getBoundingClientRect();
                return { x: rect.left + screen.x, y: rect.top + screen.y };
            }, side);
            await page.mouse.move(pointer.x, pointer.y);
            await page.waitForFunction(() => window.bootstrap.schematicApp.selection.hovered === null);
            await page.mouse.click(pointer.x, pointer.y);
            assert.equal(await page.evaluate(() => window.bootstrap.schematicApp.selection.getSelection().length), 0,
                `${side} of the drawn border is not a text target`);
        }
        await saveAndReopen(page, 'schematic');
        assert.equal(await page.evaluate(() => window.bootstrap.schematicApp.shapes[0].rotation), 0);
    },
}];
