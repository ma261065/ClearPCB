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
}, {
    name: 'wire-node-keeps-axis-guide-when-hard-snapped-to-segment',
    async run(page, url) {
        await openSchematic(page, url);
        const locations = await page.evaluate(async () => {
            const app = window.bootstrap.schematicApp;
            const view = app.viewport, rect = view.svg.getBoundingClientRect();
            const centre = view.screenToWorld({ x: rect.width / 2, y: rect.height / 2 });
            const { Wire } = await import('/src/shapes/wire.js');
            const dragged = new Wire({ points: [
                { x: centre.x, y: centre.y + 15 }, { x: centre.x, y: centre.y },
            ] });
            const target = new Wire({ points: [
                { x: centre.x - 15, y: centre.y - 15 }, { x: centre.x + 15, y: centre.y - 15 },
            ] });
            app.shapes.push(dragged, target);
            app.updateSelectableItems();
            app.selection.select(dragged);
            app.renderShapes(true);
            app.viewport.snapToGrid = false;
            app.viewport.zoomIn();
            app.viewport.zoomIn();
            const screen = point => {
                const pos = view.worldToScreen(point);
                return { x: rect.left + pos.x, y: rect.top + pos.y };
            };
            return { start: screen({ x: centre.x, y: centre.y }),
                axisOnly: screen({ x: centre.x + 0.1, y: centre.y - 10 }),
                hardTarget: screen({ x: centre.x + 0.1, y: centre.y - 15 }),
                expected: { x: centre.x, y: centre.y - 15 } };
        });
        await page.mouse.move(locations.start.x, locations.start.y);
        await page.mouse.down();
        await page.mouse.move(locations.start.x + 20, locations.start.y - 20);
        await page.mouse.move(locations.axisOnly.x, locations.axisOnly.y, { steps: 8 });
        const state = async () => page.evaluate(async () => {
            const app = window.bootstrap.schematicApp;
            const { getAxisGlowState } = await import('/src/shapes/axis-glow.js');
            const { getSchematicDrag } = await import('/src/schematic/modules/drag.js');
            const drag = getSchematicDrag(app);
            const point = drag.shape.nodes.get(drag.anchorId);
            return { point: { x: point.x, y: point.y }, guides: (getAxisGlowState(app).resolved || [])
                .map(({ segment }) => segment.axisKind), yellow: !!document.querySelector('.wire-junction-highlight') };
        });
        assert.deepEqual((await state()).guides, ['v']);
        await page.mouse.move(locations.hardTarget.x, locations.hardTarget.y, { steps: 8 });
        const snapped = await state();
        assert.ok(Math.hypot(snapped.point.x - locations.expected.x, snapped.point.y - locations.expected.y) < 1e-9,
            'Horizontal segment target combines with the vertical constraint at their intersection');
        assert.deepEqual(snapped.guides, ['v'], 'Compatible vertical guide remains visible at hard target');
        assert.equal(snapped.yellow, true, 'Hard target retains its yellow target indicator');
        await page.mouse.up();
    },
}, {
    name: 'wire-segment-drag-shows-collinearity-guide',
    async run(page, url) {
        await openSchematic(page, url);
        const locations = await page.evaluate(async () => {
            const app = window.bootstrap.schematicApp;
            const view = app.viewport, rect = view.svg.getBoundingClientRect();
            const centre = view.screenToWorld({ x: rect.width / 2, y: rect.height / 2 });
            const { Wire } = await import('/src/shapes/wire.js');
            const wire = new Wire({ id: 'segment-collinear-browser', points: [
                { x: centre.x, y: centre.y - 10 },
                { x: centre.x, y: centre.y },
                { x: centre.x + 10, y: centre.y },
                { x: centre.x + 10, y: centre.y + 10 },
            ] });
            app.shapes.push(wire);
            app.updateSelectableItems();
            app.selection.select(wire);
            app.renderShapes(true);
            app.viewport.snapToGrid = false;
            app.viewport.zoomIn();
            app.viewport.zoomIn();
            const screen = point => {
                const pos = view.worldToScreen(point);
                return { x: rect.left + pos.x, y: rect.top + pos.y };
            };
            return {
                start: screen({ x: centre.x + 10, y: centre.y + 4 }),
                away: screen({ x: centre.x + 13, y: centre.y + 4 }),
                aligned: screen({ x: centre.x + 0.1, y: centre.y + 4 }),
                expectedX: centre.x,
                expectedTop: centre.y - 10,
                expectedBottom: centre.y + 10,
            };
        });
        await page.mouse.move(locations.start.x, locations.start.y);
        await page.mouse.down();
        await page.mouse.move(locations.away.x, locations.away.y, { steps: 8 });
        await page.mouse.move(locations.aligned.x, locations.aligned.y, { steps: 8 });
        const result = await page.evaluate(async () => {
            const app = window.bootstrap.schematicApp;
            const { getAxisGlowState } = await import('/src/shapes/axis-glow.js');
            const wire = app.shapes.find(shape => shape.id === 'segment-collinear-browser');
            return {
                points: [...wire.nodes.values()].map(point => ({ x: point.x, y: point.y })),
                guides: (getAxisGlowState(app).resolved || []).map(({ segment, dashKind }) => ({
                    a: segment.a,
                    b: { x: segment.b.x, y: segment.b.y },
                    collinear: !!segment.collinear,
                    dashKind,
                })),
            };
        });
        await page.mouse.up();
        assert.ok(Math.abs(result.points[2].x - locations.expectedX) < 1e-9
            && Math.abs(result.points[3].x - locations.expectedX) < 1e-9,
        `Both endpoints of the dragged segment snap onto the stationary continuation: ${JSON.stringify(result)}`);
        assert.equal(result.guides.length, 1);
        assert.equal(result.guides[0].collinear, true);
        assert.equal(result.guides[0].dashKind, 'dotted');
        assert.ok(Math.abs(result.guides[0].a.x - locations.expectedX) < 1e-9
            && Math.abs(result.guides[0].b.x - locations.expectedX) < 1e-9
            && Math.min(result.guides[0].a.y, result.guides[0].b.y) === locations.expectedTop
            && Math.max(result.guides[0].a.y, result.guides[0].b.y) === locations.expectedBottom,
        'Blue dotted guide follows the complete collinear result');
    },
}];
