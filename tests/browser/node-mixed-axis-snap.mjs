import assert from 'node:assert/strict';
import { openSchematic, openPcb } from './helpers/editor-helpers.mjs';

export const scenarios = [{
    name: 'node-drag-highlights-axis-and-45-together-in-both-editors',
    async run(page, url) {
        for (const editor of ['schematic', 'pcb']) {
            if (editor === 'schematic') await openSchematic(page, url);
            else await openPcb(page, url);
            const locations = await page.evaluate(async editor => {
                const app = editor === 'schematic' ? window.bootstrap.schematicApp : window.bootstrap.pcbApp;
                const view = app.viewport;
                const rect = view.svg.getBoundingClientRect();
                const centre = view.screenToWorld({ x: rect.width / 2, y: rect.height / 2 });
                const unit = 10 / view.scale;
                const points = [
                    { x: centre.x - 4 * unit, y: centre.y },
                    { x: centre.x + 4.3 * unit, y: centre.y + 0.3 * unit },
                    { x: centre.x, y: centre.y + 4 * unit },
                ];
                if (editor === 'schematic') {
                    const { createLine } = await import('/src/shapes/polyline.js');
                    const line = createLine({ points });
                    app.shapes.push(line);
                    app.updateSelectableItems();
                    app.selection.select(line);
                    app.renderShapes(true);
                } else {
                    const { selectBoardShape } = await import('/src/pcb/modules/board-shapes.js');
                    const line = { id: 'mixed-axis-browser', kind: 'line', layer: 'top-silk', points, lineWidth: 0.2 };
                    app.boardShapes.push(line);
                    selectBoardShape(app, line);
                }
                const screen = point => {
                    const pos = view.worldToScreen(point);
                    return { x: rect.left + pos.x, y: rect.top + pos.y };
                };
                return { start: screen(points[1]),
                    near: screen({ x: centre.x + 4.1 * unit, y: centre.y + 0.1 * unit }) };
            }, editor);
            await page.mouse.move(locations.start.x, locations.start.y);
            await page.mouse.down();
            // Move far enough to start dragging, then approach the mixed intersection.
            await page.mouse.move(locations.start.x + 20, locations.start.y + 20);
            await page.mouse.move(locations.near.x, locations.near.y);
            const axes = await page.evaluate(async editor => {
                const app = editor === 'schematic' ? window.bootstrap.schematicApp : window.bootstrap.pcbApp;
                const { getAxisGlowState } = await import('/src/shapes/axis-glow.js');
                return getAxisGlowState(app).resolved?.map(({ segment }) => segment.axisKind).sort();
            }, editor);
            await page.mouse.up();
            assert.deepEqual(axes, ['d', 'h'], `${editor}: adjoining H and 45 segments highlight simultaneously`);
        }
    },
}];
