import assert from 'node:assert/strict';

import { openSchematic, screenPoint as editorScreenPoint, viewCentre } from './helpers/editor-helpers.mjs';

/** Screen position of a schematic world point. */
const screenPoint = (page, x, y) => editorScreenPoint(page, 'schematic', x, y);

/** Logical (SelectionManager) selection of every shape and whether its anchor handles are drawn. */
const selectionState = page => page.evaluate(async () => {
    const { viewOf } = await import('/src/schematic/render/shape-view-state.js');
    const app = window.bootstrap.schematicApp;
    app.renderShapes(); // what the next frame draws
    return {
        count: app.selection.count,
        hovered: app.selection.hovered,
        interaction: app.interactionState,
        shapes: app.shapes.map(shape => ({
            id: shape.id, logical: app.selection.isSelected(shape), handles: !!viewOf(shape)?.anchorsGroup?.isConnected,
        })),
        corner: app.shapes[0]?.nodes?.get('n2') || null,
    };
});

/** What is drawn matches the selection: exactly the selected shapes show anchor handles, and hover names a live shape. */
function assertConsistent(state, label) {
    for (const shape of state.shapes) {
        assert.equal(shape.handles, shape.logical, `${label}: ${shape.id} handles match the selection`);
    }
    if (state.hovered !== null) {
        assert.ok(state.shapes.some(shape => shape.id === state.hovered), `${label}: hover names a live shape`);
    }
}

/** Click the middle of the rectangle's first edge. */
async function clickFirstEdge(page) {
    const edge = await page.evaluate(() => {
        const nodes = window.bootstrap.schematicApp.shapes[0].nodes;
        const first = nodes.get('n0'), second = nodes.get('n1');
        return { x: (first.x + second.x) / 2, y: first.y };
    });
    const screen = await screenPoint(page, edge.x, edge.y);
    await page.mouse.move(screen.x, screen.y);
    await page.mouse.click(screen.x, screen.y);
}

async function dragFrom(page, from, to, { release = true } = {}) {
    const start = await screenPoint(page, from.x, from.y);
    const end = await screenPoint(page, to.x, to.y);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 6 });
    if (release) await page.mouse.up();
}

export const scenarios = [
    {
        name: 'schematic-selection-survives-anchor-edits-and-history',
        async run(page, url) {
            await openSchematic(page, url);
            const centre = await viewCentre(page);
            await page.locator('#ribbonSchematic [data-tool="rect"]').click();
            for (const point of [centre, { x: centre.x + 20, y: centre.y + 10 }]) {
                const screen = await screenPoint(page, point.x, point.y);
                await page.mouse.move(screen.x, screen.y, { steps: 3 });
                await page.mouse.click(screen.x, screen.y);
            }
            const handlesAfterDraw = await page.evaluate(() =>
                window.bootstrap.schematicApp.viewport.contentLayer.querySelectorAll('.shape-anchors').length);
            assert.equal(handlesAfterDraw, 0, 'drawing a shape shows no selection handles');
            await page.keyboard.press('v');
            let state = await selectionState(page);
            assert.equal(state.shapes.length, 1);
            assert.equal(state.count, 0, 'a newly drawn rectangle is not selected');
            assertConsistent(state, 'after drawing');

            await clickFirstEdge(page);
            state = await selectionState(page);
            assert.equal(state.count, 1, 'clicking the rectangle selects it');
            assertConsistent(state, 'after selecting');

            const corner = state.corner;
            await dragFrom(page, corner, { x: corner.x + 10, y: corner.y + 5 });
            state = await selectionState(page);
            assert.notDeepEqual(state.corner, corner, 'the corner moved');
            assert.equal(state.count, 1, 'a committed anchor drag keeps the shape selected');
            assertConsistent(state, 'after anchor commit');

            const moved = state.corner;
            await dragFrom(page, moved, { x: moved.x + 8, y: moved.y + 8 }, { release: false });
            assert.equal((await selectionState(page)).interaction, 'anchorDrag');
            await page.keyboard.press('Escape');
            await page.mouse.up();
            state = await selectionState(page);
            assert.deepEqual(state.corner, moved, 'Escape restores the corner');
            assert.equal(state.count, 1, 'a cancelled anchor drag keeps the shape selected');
            assertConsistent(state, 'after anchor cancel');

            await page.keyboard.press('w');
            const wireStart = await screenPoint(page, centre.x - 20, centre.y - 15);
            await page.mouse.click(wireStart.x, wireStart.y);
            state = await selectionState(page);
            assert.equal(state.count, 0, 'starting a wire clears the selection');
            assertConsistent(state, 'after wire start');
            await page.keyboard.press('Escape');
            await page.keyboard.press('Escape');

            await page.keyboard.press('v');
            await clickFirstEdge(page);
            assert.equal((await selectionState(page)).count, 1, 'clicking the edge selects the rectangle');

            await page.keyboard.press('Delete');
            state = await selectionState(page);
            assert.deepEqual([state.shapes.length, state.count, state.hovered], [0, 0, null],
                'deleting forgets the selection and hover');
            await page.keyboard.press('Control+z');
            state = await selectionState(page);
            assert.equal(state.shapes.length, 1);
            assertConsistent(state, 'after undo');
            await page.keyboard.press('Control+y');
            state = await selectionState(page);
            assert.deepEqual([state.shapes.length, state.count, state.hovered], [0, 0, null], 'redo deletes again');
        },
    },
    {
        name: 'opening-a-project-restores-its-title-block',
        async run(page, url) {
            await openSchematic(page, url);
            const titleBlock = { title: 'From the file', rev: 'C', company: 'Saved Co', date: '01/02/2003',
                drawnBy: 'Saved author', sheet: '2/3' };
            const shown = await page.evaluate(async titleBlock => {
                const { project, schematicApp } = window.bootstrap;
                // The browser remembers another project's title block.
                schematicApp.viewport.setTitleBlockData({ title: 'Previous project', date: '31/12/1999' });
                const data = project.serialize();
                data.schematic.settings = { ...data.schematic.settings, ps: null, td: titleBlock };
                await project.load(data);
                return { ...schematicApp.viewport.titleBlockData };
            }, titleBlock);
            assert.deepEqual(shown, titleBlock, 'a project without a paper size still opens with its own title block');
        },
    },
];
