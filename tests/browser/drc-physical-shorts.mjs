import assert from 'node:assert/strict';
import { openPcb, waitForPage } from './helpers/editor-helpers.mjs';

export const scenarios = [{
    name: 'drc-pad-crossing-is-a-short-and-positive-gap-is-clearance',
    async run(page, url) {
        await openPcb(page, url);
        await page.evaluate(async () => {
            const app = window.bootstrap.pcbApp;
            const { Track } = await import('/src/shapes/track.js');
            const { Pad } = await import('/src/shapes/pad.js');
            const { renderTrack } = await import('/src/pcb/modules/track-render.js');
            const { renderPad } = await import('/src/pcb/modules/pad.js');
            const track = new Track({ id: 'drc-crossing', net: 'TRACK_NET', width: 0.2,
                points: [{ x: 20, y: -20 }, { x: 40, y: -20 }], layer: 'top-copper' });
            const pad = new Pad({ id: 'drc-pad', x: 30, y: -20, shape: 'square', size: 2,
                drill: 0, layers: 'top-copper', net: 'PAD_NET' });
            app.pcbDocument.tracks.push(track);
            app.pcbDocument.pads.push(pad);
            renderTrack(track, layer => app.getLayerGroup(layer));
            renderPad(pad, layer => app.getLayerGroup(layer));
            app.setActiveRibbonTab('pcb-design');
        });
        await waitForPage(page, async () => {
            const { getDrcPresentation } = await import('/src/pcb/modules/drc-state.js');
            const result = getDrcPresentation(window.bootstrap.pcbApp).violations;
            return result.length === 1 && result[0].rule === 'short';
        });
        const short = await page.evaluate(async () => {
            const { getDrcPresentation } = await import('/src/pcb/modules/drc-state.js');
            return getDrcPresentation(window.bootstrap.pcbApp).violations[0];
        });
        assert.equal(short.message, 'Shorted nets: PAD_NET and TRACK_NET');
        assert.equal(short.marker.type, 'short');
        assert.deepEqual(new Set(short.marker.pair.map(item => item.key)),
            new Set(['trk:drc-crossing', 'pad:null.drc-pad']));
        assert.ok(short.x >= 29 && short.x <= 31 && Math.abs(short.y + 20) < 1e-9,
            'Short marker is at actual pad copper, not a track endpoint');
        await page.locator('#pcbDrcStatus').click();
        const row = page.locator('#pcbDrcSlidePanel .drc-item');
        await row.waitFor();
        assert.equal(await row.count(), 1, 'UI does not duplicate the short as a clearance issue');
        assert.equal(await row.locator('.drc-item-text').textContent(), short.message);
        await row.click();
        assert.equal(await row.getAttribute('data-drc-id'), short.id);
        await page.evaluate(async () => {
            const app = window.bootstrap.pcbApp;
            const pad = app.pcbDocument.pads.find(pad => pad.id === 'drc-pad');
            const { renderPad } = await import('/src/pcb/modules/pad.js');
            const { scheduleDrc } = await import('/src/pcb/modules/drc-state.js');
            pad.y = -18.85;
            renderPad(pad, layer => app.getLayerGroup(layer));
            scheduleDrc(app);
        });
        await waitForPage(page, async () => {
            const { getDrcPresentation } = await import('/src/pcb/modules/drc-state.js');
            const result = getDrcPresentation(window.bootstrap.pcbApp).violations;
            return result.length === 1 && result[0].rule === 'clearance';
        });
        const gap = await page.evaluate(async () => {
            const { getDrcPresentation } = await import('/src/pcb/modules/drc-state.js');
            return getDrcPresentation(window.bootstrap.pcbApp).violations[0];
        });
        assert.match(gap.message, /Clearance 0.050 mm/);
        assert.equal(gap.marker.type, 'clearance', 'Worker preserves positive-gap classification');
    },
}, {
    name: 'drc-minimum-sizes-use-design-rules-and-refresh-in-inches',
    async run(page, url) {
        await openPcb(page, url);
        await page.evaluate(async () => {
            const app = window.bootstrap.pcbApp;
            const { Track } = await import('/src/shapes/track.js');
            const { Via } = await import('/src/shapes/via.js');
            const { renderTrack, renderVia } = await import('/src/pcb/modules/track-render.js');
            app.designSettings.update({ trackWidth: 0.2, viaDiameter: 0.6, viaDrill: 0.3 });
            const track = new Track({ id: 'narrow', width: 0.15, points: [
                { x: 20, y: -20 }, { x: 30, y: -20 },
            ] });
            const via = new Via({ id: 'small', x: 40, y: -20, diameter: 0.5, drill: 0.25 });
            app.pcbDocument.tracks.push(track);
            app.pcbDocument.vias.push(via);
            renderTrack(track, layer => app.getLayerGroup(layer));
            renderVia(via, layer => app.getLayerGroup(layer));
            app.setActiveRibbonTab('pcb-design');
        });
        await waitForPage(page, async () => {
            const { getDrcPresentation } = await import('/src/pcb/modules/drc-state.js');
            const drc = getDrcPresentation(window.bootstrap.pcbApp);
            return !drc.pending && drc.violations.length === 3;
        });
        const result = await page.evaluate(async () => {
            const { getDrcPresentation } = await import('/src/pcb/modules/drc-state.js');
            return getDrcPresentation(window.bootstrap.pcbApp).violations;
        });
        assert.deepEqual(result.map(item => item.rule), ['track-width', 'via-diameter', 'via-drill']);
        assert.ok(result.every(item => item.severity === 'error'));
        await page.locator('#pcbDrcStatus').click();
        const panel = page.locator('#pcbDrcSlidePanel');
        await panel.locator('.drc-item').first().waitFor();
        assert.equal(await panel.locator('.drc-group-label').textContent(), 'Minimum Sizes (3)');
        assert.deepEqual(await panel.locator('.drc-item-text').allTextContents(), [
            'Track: width 0.150 mm < 0.200 mm',
            'Via: diameter 0.500 mm < 0.600 mm',
            'Via: drill 0.250 mm < 0.300 mm',
        ]);
        await panel.locator('.drc-item').first().click();
        await waitForPage(page, () => window.bootstrap.pcbApp.getLayerGroup('drc-overlay')?.childElementCount === 1);
        const location = await page.evaluate(() => {
            const marker = window.bootstrap.pcbApp.getLayerGroup('drc-overlay').firstElementChild;
            return [Number(marker.getAttribute('cx')), Number(marker.getAttribute('cy'))];
        });
        assert.deepEqual(location, [25, -20], 'Size issue marker is on the narrow track edge');
        await panel.locator('.drc-group-heading').click();
        assert.equal(await page.evaluate(() => window.bootstrap.pcbApp.getLayerGroup('drc-overlay').childElementCount),
            0, 'Collapsing size issues hides the selected marker');
        await panel.locator('.drc-group-heading').click();
        await waitForPage(page, () => window.bootstrap.pcbApp.getLayerGroup('drc-overlay')?.childElementCount === 1);
        await page.evaluate(async () => {
            const app = window.bootstrap.pcbApp;
            const { commitDesignValue } = await import('/src/pcb/modules/design-settings.js');
            app.designSettings.update({ units: 'inch' });
            for (const [key, value] of [['trackWidth', 0.15], ['viaDiameter', 0.5], ['viaDrill', 0.25]]) {
                if (!commitDesignValue(app, key, value / 25.4, 'inch').ok) {
                    throw new Error(`Could not update ${key}`);
                }
            }
        });
        await waitForPage(page, async () => {
            const { getDrcPresentation } = await import('/src/pcb/modules/drc-state.js');
            const drc = getDrcPresentation(window.bootstrap.pcbApp);
            return !drc.pending && drc.violations.length === 0;
        });
        assert.equal(await panel.locator('.drc-item').count(), 0,
            'Changing Design minimums reruns worker checks without resizing authored objects');
        assert.equal(await page.evaluate(() => window.bootstrap.pcbApp.pcbDocument.tracks[0].width), 0.15);
    },
}];
