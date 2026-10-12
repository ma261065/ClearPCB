import assert from 'node:assert/strict';
import { openPcb, clickWorld, screenPoint, viewportSettled } from './helpers/editor-helpers.mjs';

export const scenarios = [{
    name: 'track-segment-joins-show-yellow-targets-and-undo',
    async run(page, url) {
        await openPcb(page, url);
        await page.evaluate(async () => {
            const app = window.bootstrap.pcbApp;
            const { Track } = await import('/src/shapes/track.js');
            const { AddTrackCommand } = await import('/src/pcb/modules/track-commands.js');
            const track = new Track({ net: 'SIGNAL', width: 0.4,
                points: [{ x: 20, y: -20 }, { x: 60, y: -20 }] });
            app.history.execute(new AddTrackCommand(app, track));
        });
        await viewportSettled(page);
        await page.locator('#pcbToolTrack').click();
        await clickWorld(page, 'pcb', 40, -40);
        const end = await screenPoint(page, 'pcb', 40, -20);
        await page.mouse.move(end.x, end.y, { steps: 6 });
        await page.waitForFunction(() => document.querySelector('.track-snap-highlight'));
        assert.equal(await page.locator('.track-snap-highlight').getAttribute('fill'), '#ffff00');
        await page.mouse.click(end.x, end.y);
        await page.waitForFunction(() => {
            const tracks = window.bootstrap.pcbApp.tracks;
            return tracks.length === 1 && [...tracks[0].nodes.keys()].some(id => tracks[0].degree(id) === 3);
        });
        assert.equal(await page.evaluate(() => window.bootstrap.pcbApp.tracks[0].net), 'SIGNAL');
        await page.keyboard.press('Escape');
        await page.keyboard.press('Control+z');
        await page.waitForFunction(() => window.bootstrap.pcbApp.tracks[0].nodes.size === 2);

        await page.evaluate(async () => {
            const app = window.bootstrap.pcbApp;
            const { Track } = await import('/src/shapes/track.js');
            const { AddTrackCommand } = await import('/src/pcb/modules/track-commands.js');
            app.history.execute(new AddTrackCommand(app, new Track({
                points: [{ x: 40, y: -40 }, { x: 40, y: -50 }] })));
        });
        await page.locator('#pcbToolSelect').click();
        await clickWorld(page, 'pcb', 40, -45);
        const start = await screenPoint(page, 'pcb', 40, -40);
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await page.mouse.move(end.x, end.y, { steps: 8 });
        await page.waitForFunction(() => document.querySelector('.track-snap-highlight'));
        assert.equal(await page.evaluate(() => window.bootstrap.pcbApp.pcbDocument.tracks.length), 2,
            'the target remains canonical until release');
        await page.mouse.up();
        await page.waitForFunction(() => window.bootstrap.pcbApp.tracks.length === 1);
        assert.equal(await page.evaluate(() => window.bootstrap.pcbApp.tracks[0].net), 'SIGNAL');
        await page.keyboard.press('Control+z');
        await page.waitForFunction(() => window.bootstrap.pcbApp.tracks.length === 2);
        assert.deepEqual(await page.evaluate(() => window.bootstrap.pcbApp.tracks.map(track => track.nodes.size)), [2, 2]);
        await page.keyboard.press('Control+y');
        await page.waitForFunction(() => window.bootstrap.pcbApp.tracks.length === 1);
    },
}];
