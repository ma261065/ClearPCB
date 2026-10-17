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
            return viewOf(app.shapes[0]).element.children[1].getAttribute('opacity') === '0.35';
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
}, {
    name: 'schematic-filled-rectangle-hover-has-no-stroke-band-or-corner-spots',
    async run(page, url) {
        await openSchematic(page, url);
        const centre = await viewCentre(page);
        await page.evaluate(async centre => {
            const { Polyline } = await import('/src/shapes/polyline.js');
            const app = window.bootstrap.schematicApp;
            // Translucent strokes reveal the grid; its screen alignment varies by platform.
            app.viewport.setGridVisible(false);
            const points = [{ x: centre.x - 20, y: centre.y - 10 }, { x: centre.x + 20, y: centre.y - 10 },
                { x: centre.x + 20, y: centre.y + 10 }, { x: centre.x - 20, y: centre.y + 10 }];
            app.addShape(new Polyline({ points, closed: true, isRect: true, lineWidth: 4, fill: true, fillAlpha: 0.3 }));
            app.renderShapes(true);
        }, centre);
        const at = (/** @type {number} */ dx, /** @type {number} */ dy) => screenPoint(page, 'schematic', centre.x + dx, centre.y + dy);
        const middle = await at(0, 0);
        await page.mouse.move(middle.x, middle.y);
        await waitForPage(page, async () => {
            const { viewOf } = await import('/src/schematic/render/shape-view-state.js');
            return viewOf(window.bootstrap.schematicApp.shapes[0]).element
                .querySelector('.shape-strokes')?.getAttribute('opacity') === '0.35';
        });
        // Sample inside the fill and strokes, away from antialiased boundaries.
        const samples = { fill: await at(-5.3, 3.3), inner: await at(18.7, 3.3), outer: await at(21.3, 3.3),
            corner: await at(20.3, -9.7), edge: await at(20.3, 3.3) };
        const png = (await page.screenshot()).toString('base64');
        const colours = await page.evaluate(async ({ png, samples }) => {
            const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            const context = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext('2d'));
            context.drawImage(bitmap, 0, 0);
            const scale = bitmap.width / window.innerWidth;
            return Object.fromEntries(Object.entries(samples).map(([name, point]) => [name,
                [...context.getImageData(Math.round(point.x * scale), Math.round(point.y * scale), 1, 1).data].slice(0, 3)]));
        }, { png, samples });
        const difference = (/** @type {number[]} */ a, /** @type {number[]} */ b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
        assert.ok(difference(colours.fill, colours.outer) > 4, `the fill is visible (${JSON.stringify(colours)})`);
        assert.ok(difference(colours.inner, colours.outer) <= 2,
            `the fill stops at the stroke's inside edge (${JSON.stringify(colours)})`);
        assert.ok(difference(colours.corner, colours.edge) <= 2,
            `hovered corners are not darker where stroke caps overlap (${JSON.stringify(colours)})`);
    },
}];
