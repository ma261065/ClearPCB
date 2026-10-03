import assert from 'node:assert/strict';

/** Load the app, skip the welcome screen and open the schematic tab. */
async function openSchematic(page, url) {
    await page.goto(`${url}index.html`);
    await page.waitForFunction(() => window.bootstrap?.pcbApp && window.bootstrap?.schematicApp);
    if (await page.locator('#startupSplash').isVisible()) await page.locator('#startupContinue').click();
    await page.locator('.mode-tab[data-mode="schematic"]').click();
}

/** Screen position of a schematic world point. */
function screenPoint(page, x, y) {
    return page.evaluate(([x, y]) => {
        const viewport = window.bootstrap.schematicApp.viewport;
        const screen = viewport.worldToScreen({ x, y });
        const rect = viewport.svg.getBoundingClientRect();
        return { x: rect.left + screen.x, y: rect.top + screen.y };
    }, [x, y]);
}

/** World point at the middle of the schematic view, rounded to whole millimetres. */
const viewCentre = page => page.evaluate(() => {
    const viewport = window.bootstrap.schematicApp.viewport;
    const rect = viewport.svg.getBoundingClientRect();
    const world = viewport.screenToWorld({ x: rect.width / 2, y: rect.height / 2 });
    return { x: Math.round(world.x), y: Math.round(world.y) };
});

/** Logical (SelectionManager) selection of every shape and whether its anchor handles are drawn. */
const selectionState = page => page.evaluate(() => {
    const app = window.bootstrap.schematicApp;
    app.renderShapes(); // what the next frame draws
    return {
        count: app.selection.count,
        hovered: app.selection.hovered,
        interaction: app.interactionState,
        shapes: app.shapes.map(shape => ({
            id: shape.id, logical: app.selection.isSelected(shape), handles: !!shape.anchorsGroup?.isConnected,
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
            await page.keyboard.press('v');
            let state = await selectionState(page);
            assert.equal(state.shapes.length, 1);
            assert.equal(state.count, 1, 'a new rectangle is selected');
            assertConsistent(state, 'after drawing');

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
            const edge = await page.evaluate(() => {
                const nodes = window.bootstrap.schematicApp.shapes[0].nodes;
                const first = nodes.get('n0'), second = nodes.get('n1');
                return { x: (first.x + second.x) / 2, y: first.y };
            });
            const edgeScreen = await screenPoint(page, edge.x, edge.y);
            await page.mouse.move(edgeScreen.x, edgeScreen.y);
            await page.mouse.click(edgeScreen.x, edgeScreen.y);
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
];
