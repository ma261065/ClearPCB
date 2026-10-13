import assert from 'node:assert/strict';
import { openPcb, screenPoint, viewCentre } from './helpers/editor-helpers.mjs';

export const scenarios = [{
    name: 'pcb-track-click-over-fill-adds-waypoint',
    async run(page, url) {
        await openPcb(page, url);
        const centre = await viewCentre(page, 'pcb');
        await page.evaluate(async centre => {
            const app = window.bootstrap.pcbApp;
            const { CopperFill } = await import('/src/shapes/copper-fill.js');
            const { setComputedFill } = await import('/src/pcb/modules/computed-fill-cache.js');
            const fill = new CopperFill({ id: 'click-track-fill', layer: 'top-copper', net: '' });
            setComputedFill(fill, [{
                outer: [
                    { x: centre.x - 20, y: centre.y - 20 },
                    { x: centre.x + 20, y: centre.y - 20 },
                    { x: centre.x + 20, y: centre.y + 20 },
                    { x: centre.x - 20, y: centre.y + 20 },
                ],
                holes: [],
            }]);
            app.boardShapes.push(fill);
        }, centre);
        await page.locator('#pcbToolTrack').click();
        for (const point of [
            { x: centre.x - 5, y: centre.y },
            { x: centre.x + 5, y: centre.y },
        ]) {
            const screen = await screenPoint(page, 'pcb', point.x, point.y);
            await page.mouse.move(screen.x, screen.y);
            await page.mouse.click(screen.x, screen.y);
        }
        const active = await page.evaluate(async () => {
            const app = window.bootstrap.pcbApp;
            const { getTrackDraw } = await import('/src/pcb/modules/track-draw.js');
            const draw = getTrackDraw(app);
            return { active: !!draw, points: draw?.points.length, tracks: app.tracks.length };
        });
        assert.deepEqual(active, { active: true, points: 2, tracks: 0 },
            'A single click over fill adds a waypoint and keeps click-to-draw active');
        await page.keyboard.press('Enter');
        assert.equal(await page.evaluate(() => window.bootstrap.pcbApp.tracks.length), 1);
    },
}];
