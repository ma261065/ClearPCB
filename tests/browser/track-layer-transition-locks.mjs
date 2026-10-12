import assert from 'node:assert/strict';
import { openPcb } from './helpers/editor-helpers.mjs';

export const scenarios = [{
    name: 'track-space-layer-switch-obeys-via-and-copper-locks',
    async run(page, url) {
        await openPcb(page, url);
        const controls = async (topLocked, viaLocked) => page.evaluate(async ({ topLocked, viaLocked }) => {
            const { setPcbLayerLocked } = await import('/src/pcb/modules/layers.js');
            const app = window.bootstrap.pcbApp;
            setPcbLayerLocked(app, 'top-copper', topLocked);
            setPcbLayerLocked(app, 'vias', viaLocked);
        }, { topLocked, viaLocked });
        const screen = (x, y) => page.evaluate(({ x, y }) => {
            const viewport = window.bootstrap.pcbApp.viewport;
            const point = viewport.worldToScreen({ x, y });
            const rect = viewport.svg.getBoundingClientRect();
            return { x: rect.left + point.x, y: rect.top + point.y };
        }, { x, y });
        const snapshot = () => page.evaluate(async () => {
            const { getTrackDraw } = await import('/src/pcb/modules/track-draw.js');
            const app = window.bootstrap.pcbApp, draw = getTrackDraw(app);
            return { points: draw.points, edgeLayers: draw.edgeLayers, layer: draw.currentLayer,
                snap: { x: draw.snap.x, y: draw.snap.y }, tracks: app.tracks.length, vias: app.vias.length,
                history: app.history.undoStack.length, redo: app.history.redoStack.length,
                preview: draw.previewElements.map(element => element.outerHTML) };
        });
        await controls(true, true);
        await page.evaluate(() => { window.bootstrap.pcbApp.activeLayer = 'bottom-copper'; });
        await page.locator('[data-tab="pcb-home"]').click();
        await page.locator('#pcbToolTrack').click();
        const start = await screen(20, -20);
        const cursor = await screen(40.13, -30.17);
        await page.mouse.click(start.x, start.y);
        await page.mouse.move(cursor.x, cursor.y);
        for (const [top, via, message] of [
            [true, true, 'Via, Top Copper layers locked'],
            [true, false, 'Top Copper layer locked'],
            [false, true, 'Via layer locked'],
        ]) {
            await controls(top, via);
            const before = await snapshot();
            await page.keyboard.press('Space');
            assert.deepEqual(await snapshot(), before, 'Blocked Space cannot modify the drawing or history');
            assert.equal(await page.locator('#pcbLockedLayerBubble .pcb-locked-bubble-text').textContent(), message);
            assert.equal(await page.locator('#pcbLockedLayerBubble').isVisible(), true);
            const position = await page.locator('#pcbLockedLayerBubble').evaluate(bubble => ({
                top: parseFloat(bubble.style.top), left: parseFloat(bubble.style.left),
            }));
            assert.ok(Math.abs(position.top - cursor.y) < 1, 'Transition popup is anchored at the cursor');
            assert.equal(await page.locator('#pcbLockedLayerBubble button').count(), 0);
        }
        // The in-progress layer dropdown creates the same transition and must not bypass the Via lock.
        const beforeDropdown = await snapshot();
        await page.locator('#pcbPropTrackToolLayer').selectOption('top-copper');
        assert.equal(await page.locator('#pcbPropTrackToolLayer').inputValue(), 'bottom-copper');
        assert.deepEqual(await snapshot(), beforeDropdown);
        await page.mouse.move(cursor.x + 1, cursor.y);
        await controls(false, false);
        await page.keyboard.press('Space');
        const switched = await snapshot();
        assert.equal(switched.layer, 'top-copper', 'Unblocking both layers allows the transition');
        assert.equal(switched.points.length, beforeDropdown.points.length + 1);
        assert.equal(await page.evaluate(async () => {
            const { getTrackDraw } = await import('/src/pcb/modules/track-draw.js');
            const draw = getTrackDraw(window.bootstrap.pcbApp);
            return [...draw.previewCache.keys()].filter(key => key.startsWith('via:')).length;
        }), 1, 'The allowed switch creates exactly one Via preview');
        const finish = await screen(60, -40);
        await page.mouse.move(finish.x, finish.y);
        await page.mouse.click(finish.x, finish.y);
        await page.keyboard.press('Enter');
        const committed = await page.evaluate(() => {
            const app = window.bootstrap.pcbApp;
            return { layers: app.tracks.map(track => track.layer).sort(), vias: app.vias.length,
                history: app.history.undoStack.length };
        });
        assert.deepEqual(committed.layers, ['bottom-copper', 'top-copper']);
        assert.equal(committed.vias, 1, 'The allowed transition commits exactly one Via');
        assert.equal(committed.history, beforeDropdown.history + 1, 'The whole route is one undo step');
        await page.keyboard.press('Escape');
        await page.keyboard.press('Control+z');
        assert.deepEqual(await page.evaluate(() => {
            const app = window.bootstrap.pcbApp;
            return { tracks: app.tracks.length, vias: app.vias.length };
        }), { tracks: 0, vias: 0 }, 'Undo removes both runs and the Via atomically');
        await controls(true, true);
        await page.locator('[data-tab="pcb-home"]').click();
        await page.locator('#pcbToolTrack').click();
        await page.mouse.click(start.x, start.y);
        await page.mouse.move(cursor.x, cursor.y);
        await page.keyboard.press('Space');
        await page.mouse.click(finish.x, finish.y);
        await page.keyboard.press('Enter');
        assert.deepEqual(await page.evaluate(() => {
            const app = window.bootstrap.pcbApp;
            return { layers: app.tracks.map(track => track.layer), vias: app.vias.length };
        }), { layers: ['bottom-copper'], vias: 0 },
        'After a refused switch the route can still finish on its original unlocked layer');
    },
}];
