import assert from 'node:assert/strict';
import { openPcb, clickWorld, dragWorld, waitForPage } from './helpers/editor-helpers.mjs';

export const scenarios = [{
    name: 'track-node-edit-ignores-existing-short-but-rejects-new-contact',
    async run(page, url) {
        await openPcb(page, url);
        await page.evaluate(async () => {
            const app = window.bootstrap.pcbApp;
            const { Track } = await import('/src/shapes/track.js');
            const { Pad } = await import('/src/shapes/pad.js');
            const { AddTrackCommand } = await import('/src/pcb/modules/track-commands.js');
            const { renderPad } = await import('/src/pcb/modules/pad.js');
            app.history.execute(new AddTrackCommand(app, new Track({ id: 'short-source', net: 'A', width: 0.4,
                points: [{ x: 20, y: -20 }, { x: 40, y: -20 }, { x: 60, y: -20 }] })));
            app.history.execute(new AddTrackCommand(app, new Track({ id: 'existing-short', net: 'B', width: 0.4,
                points: [{ x: 20, y: -20 }, { x: 20, y: -10 }] })));
            const pad = new Pad({ id: 'new-short-pad', x: 75, y: -35, shape: 'square',
                size: 2, drill: 0, net: 'B', layers: 'top-copper' });
            app.pcbDocument.pads.push(pad);
            renderPad(pad, layer => app.getLayerGroup(layer));
        });
        const before = await page.evaluate(() => window.bootstrap.pcbApp.pcbDocument.captureGeometry());
        await page.locator('#pcbToolSelect').click();
        await clickWorld(page, 'pcb', 50, -20);
        await page.keyboard.down('Shift');
        await dragWorld(page, 'pcb', { x: 60, y: -20 }, { x: 60, y: -30 });
        await page.keyboard.up('Shift');
        await waitForPage(page, () => {
            const track = window.bootstrap.pcbApp.pcbDocument.tracks.find(track => track.id === 'short-source');
            return Math.abs(track.nodes.get('n2').y + 30) < 0.2;
        });
        assert.equal(await page.locator('.app-modal-overlay').count(), 0, 'Existing endpoint short does not show Net Conflict');
        const after = await page.evaluate(() => window.bootstrap.pcbApp.pcbDocument.captureGeometry());
        const hasShort = await page.evaluate(async () => {
            const { runDRC } = await import('/src/pcb/modules/drc.js');
            return runDRC(window.bootstrap.pcbApp, { clearance: 0.2 }).violations.some(item => item.rule === 'short');
        });
        assert.equal(hasShort, true, 'Allowed edit does not hide the old physical short from DRC');
        await page.keyboard.press('Control+z');
        assert.deepEqual(await page.evaluate(() => window.bootstrap.pcbApp.pcbDocument.captureGeometry()), before);
        await page.keyboard.press('Control+y');
        assert.deepEqual(await page.evaluate(() => window.bootstrap.pcbApp.pcbDocument.captureGeometry()), after);
        await clickWorld(page, 'pcb', 55, -27.5);
        await page.keyboard.down('Shift');
        await dragWorld(page, 'pcb', { x: 60, y: -30 }, { x: 75, y: -35 });
        await page.keyboard.up('Shift');
        const modal = page.locator('.app-modal-overlay');
        await modal.waitFor();
        assert.match(await modal.textContent(), /Cannot connect different nets/);
        assert.deepEqual(await page.evaluate(() => window.bootstrap.pcbApp.pcbDocument.captureGeometry()), after,
            'Rejected new short leaves the previously committed geometry intact');
        await modal.getByRole('button', { name: 'OK', exact: true }).click();
    },
}];
