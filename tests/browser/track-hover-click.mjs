import assert from 'node:assert/strict';
import { openPcb, viewportSettled } from './helpers/editor-helpers.mjs';

export const scenarios = [{
    name: 'PCB track click selects the hovered net beside a parallel track',
    async run(page, url) {
        await openPcb(page, url);
        await page.evaluate(async () => {
            const { PcbDocument } = await import('/src/core/PcbDocument.js');
            const { Track } = await import('/src/shapes/track.js');
            const { rectangleBoardOutline } = await import('/src/shared/pcb/board-outline.js');
            const model = new PcbDocument();
            model.setBoardOutline(rectangleBoardOutline(20, 20));
            for (const [net, y] of [['TARGET', -10], ['NEIGHBOUR', -9.6]]) {
                model.tracks.push(new Track({ net, width: 0.1, layer: 'top-copper',
                    points: [{ x: 2, y }, { x: 18, y }] }));
            }
            const project = window.bootstrap.project;
            const data = project.serialize();
            data.pcb = model.serializeSection();
            await project.load(data);
            const { syncFromSchematic } = await import('/src/pcb/modules/schematic-sync.js');
            syncFromSchematic(window.bootstrap.pcbApp);
            const v = window.bootstrap.pcbApp.viewport;
            v.zoomToLevel(v.zoomPercents.indexOf(1000));
            v.viewBox.x = 8 - v.viewBox.width / 2;
            v.viewBox.y = -10 - v.viewBox.height / 2;
            v._updateViewBox();
            v._notifyViewChanged();
        });
        await viewportSettled(page, 'pcb');
        for (const [net, y] of [['TARGET', -10], ['NEIGHBOUR', -9.6], ['TARGET', -10]]) {
            const point = await page.evaluate(y => {
                const v = window.bootstrap.pcbApp.viewport;
                const p = v.worldToScreen({ x: 8, y });
                const rect = v._getCachedRect();
                return { x: rect.left + p.x, y: rect.top + p.y };
            }, y);
            await page.mouse.move(point.x, point.y);
            await page.waitForFunction(y => {
                const halos = [...window.bootstrap.pcbApp.viewport.svg.querySelectorAll('.pcb-track-hover')];
                return halos.some(element => (element.getAttribute('points') || '').includes(`,${y}`));
            }, y);
            await page.mouse.click(point.x, point.y);
            const selected = await page.evaluate(async () => {
                const { getPcbSelection } = await import('/src/pcb/modules/selection-registry.js');
                return getPcbSelection(window.bootstrap.pcbApp, 'track').map(track => track.net);
            });
            assert.deepEqual(selected, [net], 'Click selects the highlighted net, not the adjacent track');
        }
    },
}];
