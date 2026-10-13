import assert from 'node:assert/strict';
import { openPcb, viewCentre } from './helpers/editor-helpers.mjs';

export const scenarios = [{
    name: 'pcb-track-delete-actions-preview-target-geometry',
    async run(page, url) {
        await openPcb(page, url);
        const setup = await page.evaluate(async centre => {
            const app = window.bootstrap.pcbApp;
            const { Track } = await import('/src/shapes/track.js');
            const { renderTrack } = await import('/src/pcb/modules/track-render.js');
            const { showTrackContextMenu } = await import('/src/pcb/modules/track-select.js');
            const track = new Track({ id: 'context-preview-track', width: 0.4,
                points: [
                    { x: centre.x - 10, y: centre.y },
                    { x: centre.x, y: centre.y },
                    { x: centre.x, y: centre.y + 10 },
                ],
                layer: 'top-copper',
            });
            const edgeIds = [...track.edges.keys()];
            track.edges.get(edgeIds[1]).layer = 'bottom-copper';
            app.pcbDocument.tracks.push(track);
            renderTrack(track, layer => app.getLayerGroup(layer));
            showTrackContextMenu(app, { type: 'track', track }, 150, 150,
                { x: centre.x - 5, y: centre.y });
            return { edgeIds };
        }, await viewCentre(page, 'pcb'));

        const menu = page.locator('#pcbTrackContextMenu');
        await menu.waitFor();
        const preview = page.locator('.pcb-track-context-preview');
        await menu.getByText('Delete segment', { exact: true }).hover();
        assert.equal(await preview.count(), 1);
        assert.deepEqual(await preview.evaluate(element => ({
            borders: element.querySelectorAll('.pcb-track-context-border').length,
            foregrounds: element.querySelectorAll('.pcb-track-context-foreground').length,
            colors: [...element.querySelectorAll('.pcb-track-context-foreground')]
                .map(line => line.getAttribute('stroke')),
        })), {
            borders: 1,
            foregrounds: 1,
            colors: ['#e74c3c'],
        }, 'Delete segment borders only the targeted top-copper edge');

        await menu.getByText('Delete track', { exact: true }).hover();
        assert.deepEqual(await preview.evaluate(element => ({
            borders: element.querySelectorAll('.pcb-track-context-border').length,
            foregrounds: element.querySelectorAll('.pcb-track-context-foreground').length,
            colors: [...element.querySelectorAll('.pcb-track-context-foreground')]
                .map(line => line.getAttribute('stroke')).sort(),
        })), {
            borders: 2,
            foregrounds: 2,
            colors: ['#2479b5', '#e74c3c'],
        }, 'Delete track borders every edge using its copper-layer foreground');
        await page.keyboard.press('Escape');
        assert.equal(await preview.count(), 0, 'Dismissing the PCB menu clears its delete preview');
        assert.equal(setup.edgeIds.length, 2);

        await page.evaluate(async centre => {
            const app = window.bootstrap.pcbApp;
            const { Track } = await import('/src/shapes/track.js');
            const { renderTrack } = await import('/src/pcb/modules/track-render.js');
            const { showTrackContextMenu } = await import('/src/pcb/modules/track-select.js');
            const track = new Track({ id: 'single-segment-context-track', width: 0.4,
                points: [
                    { x: centre.x + 10, y: centre.y },
                    { x: centre.x + 20, y: centre.y },
                ],
                layer: 'top-copper',
            });
            app.pcbDocument.tracks.push(track);
            renderTrack(track, layer => app.getLayerGroup(layer));
            showTrackContextMenu(app, { type: 'track', track }, 150, 150,
                { x: centre.x + 15, y: centre.y });
        }, await viewCentre(page, 'pcb'));
        await menu.waitFor();
        assert.equal(await menu.getByText('Delete segment', { exact: true }).count(), 0,
            'A single-segment track does not offer the equivalent Delete segment action');
        assert.equal(await menu.getByText('Delete track', { exact: true }).count(), 1,
            'A single-segment track offers Delete track');
    },
}];
