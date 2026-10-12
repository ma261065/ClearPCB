import assert from 'node:assert/strict';
import { openPcb, clickWorld, screenPoint, waitForPage } from './helpers/editor-helpers.mjs';

export const scenarios = [{
    name: 'track-cross-layer-node-drop-inserts-via-and-undoes',
    async run(page, url) {
        await openPcb(page, url);
        await page.evaluate(async () => {
            const app = window.bootstrap.pcbApp;
            const { Track } = await import('/src/shapes/track.js');
            const { AddTrackCommand } = await import('/src/pcb/modules/track-commands.js');
            app.designSettings.update({ viaDiameter: 0.8, viaDrill: 0.4 });
            app.history.execute(new AddTrackCommand(app, new Track({ id: 'top-source', net: 'SIGNAL',
                points: [{ x: 40, y: -40 }, { x: 40, y: -50 }], layer: 'top-copper' })));
            app.history.execute(new AddTrackCommand(app, new Track({ id: 'bottom-target', net: 'SIGNAL',
                points: [{ x: 60, y: -20 }, { x: 70, y: -20 }], layer: 'bottom-copper' })));
        });
        const before = await page.evaluate(() => window.bootstrap.pcbApp.pcbDocument.captureGeometry());
        await page.locator('#pcbToolSelect').click();
        await clickWorld(page, 'pcb', 40, -45);
        const start = await screenPoint(page, 'pcb', 40, -40);
        const end = await screenPoint(page, 'pcb', 60, -20);
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await page.mouse.move(end.x + 3, end.y + 2, { steps: 8 });
        await waitForPage(page, async () => {
            const { getVertexDrag } = await import('/src/pcb/modules/track-drag.js');
            return getVertexDrag(window.bootstrap.pcbApp)?.snapTargetNode?.track.id === 'bottom-target';
        });
        assert.equal(await page.locator('.track-snap-highlight').getAttribute('fill'), '#ffff00');
        assert.deepEqual(await page.evaluate(() => window.bootstrap.pcbApp.pcbDocument.captureGeometry()), before,
            'Neither graph nor Via is committed while hovering');
        await page.mouse.up();
        await waitForPage(page, () => window.bootstrap.pcbApp.pcbDocument.vias.length === 1);
        const after = await page.evaluate(() => window.bootstrap.pcbApp.pcbDocument.captureGeometry());
        const data = await page.evaluate(() => {
            const { tracks, vias } = window.bootstrap.pcbApp.pcbDocument;
            return { via: { x: vias[0].x, y: vias[0].y, net: vias[0].net,
                diameter: vias[0].diameter, drill: vias[0].drill },
                tracks: tracks.map(track => ({ id: track.id, nodes: track.nodes.size, layer: track.layer })) };
        });
        assert.deepEqual(data.via, { x: 60, y: -20, net: 'SIGNAL', diameter: 0.8, drill: 0.4 });
        assert.deepEqual(data.tracks, [
            { id: 'top-source', nodes: 2, layer: 'top-copper' },
            { id: 'bottom-target', nodes: 2, layer: 'bottom-copper' },
        ]);
        await page.keyboard.press('Control+z');
        assert.deepEqual(await page.evaluate(() => window.bootstrap.pcbApp.pcbDocument.captureGeometry()), before);
        await page.keyboard.press('Control+y');
        assert.deepEqual(await page.evaluate(() => window.bootstrap.pcbApp.pcbDocument.captureGeometry()), after);
    },
}, {
    name: 'track-draw-from-pin19-to-bottom-node-inserts-via',
    async run(page, url) {
        await openPcb(page, url);
        await page.evaluate(async () => {
            const app = window.bootstrap.pcbApp;
            const { Track } = await import('/src/shapes/track.js');
            const { AddTrackCommand } = await import('/src/pcb/modules/track-commands.js');
            app.designSettings.update({ viaDiameter: 0.8, viaDrill: 0.4 });
            app.placements.set('U1', { x: 30, y: -20, side: 'top', rotation: 0,
                pads: new Map([['19', { x: 30, y: -20, number: '19' }]]),
                padOffsets: [{ padId: '19', number: '19', dx: 0, dy: 0,
                    width: 2, height: 1, shape: 'rect', layer: 'top' }] });
            app.netlist = [{ net: 'Net0002', pins: [{ componentId: 'U1', pinNumber: '19' }] }];
            const pad = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            for (const [key, value] of Object.entries({ x: 29, y: -20.5, width: 2, height: 1,
                fill: '#e74c3c', 'data-pad': '19', 'data-component-id': 'U1' })) pad.setAttribute(key, String(value));
            app.getLayerGroup('top-copper').appendChild(pad);
            app.history.execute(new AddTrackCommand(app, new Track({ id: 'blue-node', net: 'Net0002',
                layer: 'bottom-copper', points: [{ x: 60, y: -20 }, { x: 75, y: -20 }, { x: 75, y: -35 }] })));
        });
        const before = await page.evaluate(() => window.bootstrap.pcbApp.pcbDocument.captureGeometry());
        await page.locator('#pcbToolTrack').click();
        await clickWorld(page, 'pcb', 30, -20);
        await waitForPage(page, async () => {
            const { getTrackDraw } = await import('/src/pcb/modules/track-draw.js');
            return getTrackDraw(window.bootstrap.pcbApp)?.startPad?.pinNumber === '19';
        });
        const target = await screenPoint(page, 'pcb', 60, -20);
        await page.mouse.move(target.x + 2, target.y, { steps: 8 });
        await page.locator('.track-snap-highlight').waitFor();
        const snapshot = await page.evaluate(async () => {
            const { getTrackDraw } = await import('/src/pcb/modules/track-draw.js');
            const app = window.bootstrap.pcbApp;
            return { layer: getTrackDraw(app).currentLayer, viaCount: app.pcbDocument.vias.length,
                target: getTrackDraw(app).snap.trackNode.track.id };
        });
        assert.deepEqual(snapshot, { layer: 'top-copper', viaCount: 0, target: 'blue-node' });
        await page.mouse.click(target.x + 2, target.y);
        await waitForPage(page, async () => {
            const { getTrackDraw } = await import('/src/pcb/modules/track-draw.js');
            const app = window.bootstrap.pcbApp;
            return getTrackDraw(app) === null && app.pcbDocument.vias.length === 1;
        });
        const after = await page.evaluate(() => window.bootstrap.pcbApp.pcbDocument.captureGeometry());
        const connection = await page.evaluate(async () => {
            const { collectBondedCopper } = await import('/src/pcb/modules/track-connections.js');
            const { runDRC } = await import('/src/pcb/modules/drc.js');
            const app = window.bootstrap.pcbApp;
            const drawn = app.pcbDocument.tracks.find(track => track.id !== 'blue-node');
            const via = app.pcbDocument.vias[0];
            return { layers: app.pcbDocument.tracks.map(track => track.layer),
                via: { x: via.x, y: via.y, diameter: via.diameter, drill: via.drill, net: via.net },
                bonded: [...collectBondedCopper(app, { track: drawn }).tracks].some(track => track.id === 'blue-node'),
                violations: runDRC(app, app.getRoutingParams()).violations };
        });
        assert.deepEqual(connection.layers, ['bottom-copper', 'top-copper']);
        assert.deepEqual(connection.via, { x: 60, y: -20, diameter: 0.8, drill: 0.4, net: 'Net0002' });
        assert.equal(connection.bonded, true, 'New red track really connects to the blue track through the Via');
        assert.deepEqual(connection.violations, [], 'Drawn transition Via passes current DRC rules');
        await page.keyboard.press('Control+z');
        assert.deepEqual(await page.evaluate(() => window.bootstrap.pcbApp.pcbDocument.captureGeometry()), before);
        await page.keyboard.press('Control+y');
        assert.deepEqual(await page.evaluate(() => window.bootstrap.pcbApp.pcbDocument.captureGeometry()), after);
    },
}];
