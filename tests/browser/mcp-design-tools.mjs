import assert from 'node:assert/strict';
import { openPcb, viewportSettled } from './helpers/editor-helpers.mjs';

export const scenarios = [{
    name: 'MCP render and DRC describe the whole board regardless of layer visibility',
    async run(page, url) {
        await openPcb(page, url);
        await page.evaluate(async () => {
            const { PcbDocument } = await import('/src/core/PcbDocument.js');
            const { Track } = await import('/src/shapes/track.js');
            const { rectangleBoardOutline } = await import('/src/shared/pcb/board-outline.js');
            const model = new PcbDocument();
            model.setBoardOutline(rectangleBoardOutline(40, 30));
            model.boardShapes.push({ id: 'silk', kind: 'circle', layer: 'top-silk', x: 10, y: -10, radius: 3, filled: true });
            model.tracks.push(new Track({ net: '', layer: 'top-copper', width: 0.4, points: [{ x: 5, y: -20 }, { x: 35, y: -20 }] }));
            const project = window.bootstrap.project;
            const data = project.serialize();
            data.pcb = model.serializeSection();
            await project.load(data);
        });
        await viewportSettled(page, 'pcb');
        const result = await page.evaluate(async () => {
            const app = window.bootstrap.pcbApp;
            const tools = window.bootstrap.mcpBridge.designTools;
            const visible = await tools.render({ view: 'pcb', maxSize: 512 });
            const { notifyLayerVisibilityChanged } = await import('/src/pcb/modules/layers.js');
            notifyLayerVisibilityChanged(app, 'top-silk', false);
            const hidden = await tools.render({ view: 'pcb', maxSize: 512 });
            const silkDisplay = app.existingLayerGroups().get('top-silk').style.display;
            notifyLayerVisibilityChanged(app, 'top-silk', true);
            const drc = await tools.runDrc({ limit: 10 });
            return { same: visible.data === hidden.data, layers: hidden.layers, bounds: hidden.bounds,
                width: hidden.width, mimeType: hidden.mimeType, silkDisplay, drc };
        });
        assert.equal(result.mimeType, 'image/png');
        assert.equal(result.width, 512);
        assert.ok(result.layers.includes('top-silk'), 'Hidden layers with artwork are still rendered');
        assert.ok(result.same, 'Hiding a layer in the editor does not change the MCP render');
        assert.equal(result.silkDisplay, 'none', 'The editor keeps the user\'s layer visibility');
        assert.ok(result.bounds.width >= 40 && result.bounds.height >= 30, 'Bounds cover the board in millimetres');
        assert.equal(result.drc.upToDate, true);
        assert.equal(result.drc.units, 'mm');
        assert.equal(result.drc.counts.total, result.drc.violations.length);
    },
}];
