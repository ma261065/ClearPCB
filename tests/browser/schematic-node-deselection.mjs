import assert from 'node:assert/strict';
import { openSchematic } from './helpers/editor-helpers.mjs';

export const scenarios = [{
    name: 'schematic-node-refinement-deselects-with-one-blank-click',
    async run(page, url) {
        await openSchematic(page, url);
        const points = await page.evaluate(async () => {
            const app = window.bootstrap.schematicApp;
            const { createRect } = await import('/src/shapes/polyline.js');
            const view = app.viewport;
            const rect = view.svg.getBoundingClientRect();
            const centre = view.screenToWorld({ x: rect.width / 2, y: rect.height / 2 });
            const size = 100 / view.scale;
            const shape = createRect({ x: centre.x - size / 2, y: centre.y - size / 2,
                width: size, height: size });
            app.shapes.push(shape);
            app.updateSelectableItems();
            app.renderShapes(true);
            const screen = point => {
                const pos = view.worldToScreen(point);
                return { x: rect.left + pos.x, y: rect.top + pos.y };
            };
            return { edge: screen({ x: centre.x, y: centre.y - size / 2 }),
                node: screen({ x: centre.x - size / 2, y: centre.y - size / 2 }),
                blank: screen({ x: centre.x + size * 2, y: centre.y + size * 2 }) };
        });
        await page.mouse.click(points.edge.x, points.edge.y);
        await page.mouse.click(points.node.x, points.node.y);
        const focus = await page.evaluate(async () => {
            const { getShapeNodeFocus } = await import('/src/schematic/modules/shape-focus.js');
            return getShapeNodeFocus(window.bootstrap.schematicApp);
        });
        assert.ok(focus?.nodeId, 'second click selects a node');
        await page.mouse.click(points.blank.x, points.blank.y);
        assert.equal(await page.evaluate(() => window.bootstrap.schematicApp.selection.getSelection().length), 0,
            'one blank-canvas click clears the refined shape selection');
    },
}];
