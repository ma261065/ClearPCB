import assert from 'node:assert/strict';
import { openPcb } from './helpers/editor-helpers.mjs';

export const scenarios = [{
    name: 'drawing-dropdown-return-to-canvas-restores-escape',
    async run(page, url) {
        await openPcb(page, url);
        const canvasPoint = await page.evaluate(() => {
            const box = window.bootstrap.pcbApp.viewport.svg.getBoundingClientRect();
            return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
        });
        for (const [button, dropdown, layer, tool] of [
            ['#pcbToolTrack', '#pcbPropTrackToolLayer', 'bottom-copper', 'track'],
            ['#pcbToolFill', '#pcbPropFillToolLayer', 'bottom-copper', 'fill'],
            ['#pcbToolText', '#pcbPropTextToolLayer', 'bottom-silk', 'text'],
            ['#pcbToolPad', '#pcbPropPadLayers', 'bottom-copper', 'pad'],
            ['#pcbToolShapes', '#pcbToolShapeLayer', 'bottom-silk', 'circle'],
        ]) {
            await page.locator('[data-tab="pcb-home"]').click();
            await page.locator(button).click();
            const select = page.locator(dropdown);
            await select.focus();
            await select.selectOption(layer);
            assert.equal(await select.evaluate(input => document.activeElement === input), true,
                `${tool}: dropdown retains focus while editing Properties`);
            await select.press('Escape');
            assert.equal(await page.evaluate(() => window.bootstrap.pcbApp.currentTool), tool,
                `${tool}: Escape stays native while the dropdown owns focus`);
            await page.mouse.move(canvasPoint.x - 1, canvasPoint.y);
            await page.mouse.move(canvasPoint.x, canvasPoint.y);
            assert.equal(await select.evaluate(input => document.activeElement === input), false,
                `${tool}: returning to canvas releases dropdown focus`);
            await page.keyboard.press('Escape');
            assert.equal(await page.evaluate(() => window.bootstrap.pcbApp.currentTool), 'select',
                `${tool}: one canvas Escape cancels the drawing tool`);
        }

        await page.locator('[data-tab="pcb-home"]').click();
        await page.locator('#pcbToolTrack').click();
        await page.locator('#pcbPropTrackToolLayer').focus();
        await page.locator('#pcbPropTrackToolLayer').selectOption('bottom-copper');
        await page.mouse.move(canvasPoint.x, canvasPoint.y);
        await page.mouse.click(canvasPoint.x, canvasPoint.y);
        const drawing = await page.evaluate(async () => {
            const { getTrackDraw } = await import('/src/pcb/modules/track-draw.js');
            const draw = getTrackDraw(window.bootstrap.pcbApp);
            return { active: !!draw, layer: draw?.currentLayer };
        });
        assert.deepEqual(drawing, { active: true, layer: 'bottom-copper' });
        await page.locator('#pcbPropTrackToolLayer').focus();
        await page.locator('#pcbPropTrackToolLayer').selectOption('top-copper');
        await page.mouse.move(canvasPoint.x + 20, canvasPoint.y);
        await page.keyboard.press('Escape');
        assert.equal(await page.evaluate(async () =>
            !!(await import('/src/pcb/modules/track-draw.js')).getTrackDraw(window.bootstrap.pcbApp)), false,
        'Escape also cancels an in-progress drawing after changing its layer');
        assert.equal(await page.evaluate(() => window.bootstrap.pcbApp.tracks.length), 0,
            'Cancelled drawing creates no track');

        await page.locator('[data-tab="pcb-home"]').click();
        await page.locator('#pcbToolTrack').click();
        const number = page.locator('#pcbPropTrackToolWidth');
        await number.focus();
        await page.mouse.move(canvasPoint.x, canvasPoint.y);
        assert.equal(await number.evaluate(input => document.activeElement === input), true,
            'Canvas hover does not steal number-field editing focus');
        await number.press('Escape');
        assert.equal(await page.evaluate(() => window.bootstrap.pcbApp.currentTool), 'track',
            'Number field Escape is not repurposed as a canvas command');
    },
}];
