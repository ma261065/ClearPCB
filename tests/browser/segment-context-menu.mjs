import assert from 'node:assert/strict';
import { openSchematic, screenPoint, viewCentre, viewportSettled } from './helpers/editor-helpers.mjs';

export const scenarios = [{
    name: 'short-segment-context-menu-and-delete-preview',
    async run(page, url) {
        await openSchematic(page, url);
        await page.evaluate(() => {
            const app = window.bootstrap.schematicApp;
            app.viewport.zoomToLevel(app.viewport.zoomPercents.indexOf(5000), app.viewport.offset);
        });
        await viewportSettled(page, 'schematic');
        const setup = await page.evaluate(async centre => {
            const app = window.bootstrap.schematicApp;
            const { Wire } = await import('/src/shapes/wire.js');
            const wire = new Wire({ id: 'short-segment-menu', points: [
                { x: centre.x - 1, y: centre.y },
                { x: centre.x, y: centre.y },
                { x: centre.x, y: centre.y + 10 },
            ] });
            const junctionPoint = { x: centre.x + 2, y: centre.y + 2 };
            const junction = new Wire({ id: 'junction-menu', points: [
                { x: junctionPoint.x - 5, y: junctionPoint.y },
                junctionPoint,
                { x: junctionPoint.x + 5, y: junctionPoint.y },
            ] });
            const centerId = junction.nodeAt(junctionPoint, 1e-9);
            const branchId = junction.addNode(junctionPoint.x, junctionPoint.y - 5);
            junction.addEdge(centerId, branchId);
            app.addShape(wire);
            app.addShape(junction);
            app.selection.select(wire, false);
            app.renderShapes(true);
            const dot = document.querySelector('.junction-dot');
            const dotRadiusPx = Number(dot?.getAttribute('r')) * app.viewport.scale;
            return {
                midpoint: { x: centre.x - 0.5, y: centre.y },
                node: { x: centre.x, y: centre.y },
                junctionDotRadiusPx: dotRadiusPx,
            };
        }, await viewCentre(page));

        const midpoint = await screenPoint(page, 'schematic', setup.midpoint.x, setup.midpoint.y);
        await page.mouse.click(midpoint.x, midpoint.y, { button: 'right' });
        const menu = page.locator('.anchor-context-menu');
        await menu.waitFor();
        const selectedState = () => page.evaluate(async () => {
            const app = window.bootstrap.schematicApp;
            const { viewOf } = await import('/src/schematic/render/shape-view-state.js');
            const wire = app.shapes.find(shape => shape.id === 'short-segment-menu');
            const line = [...viewOf(wire).element.children].find(element =>
                String(element.tagName).toLowerCase() === 'line');
            return {
                selected: app.selection.getSelection().map(shape => shape.id),
                stroke: line?.getAttribute('stroke'),
            };
        });
        assert.deepEqual(await selectedState(), {
            selected: ['short-segment-menu'],
            stroke: '#e94560',
        }, 'Right-click selects the whole wire in red');
        const deleteSegment = menu.getByText('Delete Segment', { exact: true });
        assert.equal(await deleteSegment.count(), 1,
            'A segment shorter than the anchor handle still exposes Delete Segment');
        await deleteSegment.hover();
        const highlight = page.locator('.schematic-context-segment-highlight');
        assert.equal(await highlight.count(), 1);
        assert.deepEqual(await highlight.locator('.schematic-context-segment-foreground').evaluate(element => ({
            x1: Number(element.getAttribute('x1')),
            y1: Number(element.getAttribute('y1')),
            x2: Number(element.getAttribute('x2')),
            y2: Number(element.getAttribute('y2')),
        })), {
            x1: setup.midpoint.x - 0.5,
            y1: setup.midpoint.y,
            x2: setup.midpoint.x + 0.5,
            y2: setup.midpoint.y,
        }, 'Delete Segment border covers the exact short edge');
        const segmentBorder = await highlight.evaluate(element => ({
            borders: element.querySelectorAll('.schematic-context-segment-border').length,
            foregrounds: element.querySelectorAll('.schematic-context-segment-foreground').length,
            borderWidth: Number(element.querySelector('.schematic-context-segment-border').getAttribute('stroke-width')),
            foregroundWidth: Number(element.querySelector('.schematic-context-segment-foreground').getAttribute('stroke-width')),
        }));
        assert.equal(segmentBorder.borders, 1);
        assert.equal(segmentBorder.foregrounds, 1);
        assert.ok(segmentBorder.borderWidth > segmentBorder.foregroundWidth,
            'Targeted segment has a visible border around the red foreground');
        await page.mouse.move(midpoint.x + 80, midpoint.y + 80);
        assert.deepEqual(await selectedState(), {
            selected: ['short-segment-menu'],
            stroke: '#e94560',
        }, 'Moving off the context menu keeps the wire selected in red');
        await page.keyboard.press('Escape');
        assert.equal(await highlight.count(), 0, 'Dismissing the menu clears the edge preview');

        const node = await screenPoint(page, 'schematic', setup.node.x, setup.node.y);
        await page.mouse.click(node.x - 5, node.y, { button: 'right' });
        await menu.waitFor();
        assert.equal(await menu.getByText('Delete point', { exact: true }).count(), 1,
            'The ordinary node target remains comfortably larger than an exact pixel');
        await page.keyboard.press('Escape');

        assert.ok(Math.abs(setup.junctionDotRadiusPx - 100) < 1e-9,
            '5000% junction dot retains its physical 0.4 mm radius');
        const junctionDot = page.locator('.junction-dot');
        assert.equal(await junctionDot.count(), 1);

        await page.mouse.click(midpoint.x, midpoint.y, { button: 'right' });
        await menu.waitFor();
        const deleteWire = menu.getByText('Delete Wire', { exact: true });
        await deleteWire.hover();
        assert.deepEqual(await highlight.evaluate(element => ({
            borders: element.querySelectorAll('.schematic-context-segment-border').length,
            foregrounds: element.querySelectorAll('.schematic-context-segment-foreground').length,
        })), { borders: 2, foregrounds: 2 }, 'Delete Wire borders every edge in the selected wire');
        await deleteSegment.click();
        assert.equal(await menu.count(), 0, 'Deleting a segment closes the context menu');
        assert.deepEqual(await page.evaluate(() => {
            const app = window.bootstrap.schematicApp;
            const selection = app.selection.getSelection();
            return {
                selected: selection.map(shape => shape.id),
                edgeCount: selection[0]?.edges?.size,
            };
        }), { selected: ['short-segment-menu'], edgeCount: 1 },
        'Deleting the segment leaves the surviving wire selected');
    },
}];
