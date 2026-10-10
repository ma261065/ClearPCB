import assert from 'node:assert/strict';
import { openSchematic, viewCentre, screenPoint, waitForPage } from './helpers/editor-helpers.mjs';

export const scenarios = [{
    name: 'schematic-filled-circle-hover-has-no-overlap-band',
    async run(page, url) {
        await openSchematic(page, url);
        const centre = await viewCentre(page);
        await page.evaluate(async centre => {
            const { Circle } = await import('/src/shapes/circle.js');
            const app = window.bootstrap.schematicApp;
            app.addShape(new Circle({ ...centre, radius: 15, lineWidth: 2, fill: true, fillAlpha: 0.3 }));
            app.renderShapes(true);
        }, centre);
        const point = await screenPoint(page, 'schematic', centre.x, centre.y);
        await page.mouse.move(point.x, point.y);
        await waitForPage(page, async () => {
            const { viewOf } = await import('/src/schematic/render/shape-view-state.js');
            const app = window.bootstrap.schematicApp;
            return viewOf(app.shapes[0]).element.getAttribute('stroke-opacity') === '0.35';
        });
        const geometry = await page.evaluate(async () => {
            const { viewOf } = await import('/src/schematic/render/shape-view-state.js');
            const group = viewOf(window.bootstrap.schematicApp.shapes[0]).element;
            const [fill, stroke] = group.children;
            return { fillRadius: Number(fill.getAttribute('r')), strokeRadius: Number(stroke.getAttribute('r')),
                width: Number(stroke.getAttribute('stroke-width')), strokeFill: stroke.getAttribute('fill'),
                fillStroke: fill.getAttribute('stroke') };
        });
        assert.equal(geometry.fillRadius, geometry.strokeRadius - geometry.width / 2);
        assert.equal(geometry.strokeRadius + geometry.width / 2, 15);
        assert.equal(geometry.strokeFill, 'none');
        assert.equal(geometry.fillStroke, 'none');
    },
}];
