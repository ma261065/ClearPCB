import assert from 'node:assert/strict';

// Schematic object locks, through the real UI, matching the PCB editor: the Properties
// Locked checkbox, a lock icon beside the object (no edit handles), an unlock menu,
// locked members staying put while the rest of a selection moves or is edited, and
// pasted copies arriving unlocked.

import { openSchematic, screenPoint as editorScreenPoint, viewCentre } from './helpers/editor-helpers.mjs';

/** Screen position of a schematic world point. */
const screenPoint = (page, x, y) => editorScreenPoint(page, 'schematic', x, y);

async function clickAt(page, x, y) {
    const point = await screenPoint(page, x, y);
    await page.mouse.move(point.x, point.y, { steps: 2 });
    await page.mouse.click(point.x, point.y);
}

async function drawRect(page, from, to) {
    await page.locator('#ribbonSchematic [data-tool="rect"]').click();
    await clickAt(page, from.x, from.y);
    await clickAt(page, to.x, to.y);
    await page.keyboard.press('Escape');
}

async function dragFrom(page, from, to) {
    const start = await screenPoint(page, from.x, from.y);
    const end = await screenPoint(page, to.x, to.y);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 6 });
    await page.mouse.up();
}

/** Each shape's lock, line width and first corner. */
const shapes = page => page.evaluate(() => window.bootstrap.schematicApp.shapes.map(shape => ({
    id: shape.id, locked: !!shape.locked, lineWidth: shape.lineWidth, corner: { ...shape.nodes.get('n0') },
})));

const lockedCheckbox = page => page.locator('[data-prop="locked"] input[type="checkbox"]').first();

export const scenarios = [
    {
        name: 'schematic-object-locks-match-the-pcb-editor',
        async run(page, url) {
            await openSchematic(page, url);
            const c = await viewCentre(page);
            await drawRect(page, c, { x: c.x + 20, y: c.y + 10 });
            await drawRect(page, { x: c.x + 40, y: c.y }, { x: c.x + 60, y: c.y + 10 });
            const [first, second] = await shapes(page);

            // Lock the first rectangle from Properties.
            await clickAt(page, c.x + 10, c.y);
            await lockedCheckbox(page).check();
            assert.equal((await shapes(page))[0].locked, true, 'the Locked checkbox locks the shape');

            // A locked shape shows a lock beside the clicked edge, outside the shape, and no edit handles.
            const icon = await page.evaluate(() => {
                const app = window.bootstrap.schematicApp;
                const lock = app.viewport.contentLayer.querySelector('.lock-icon');
                const box = lock?.getBBox();
                return {
                    count: app.viewport.contentLayer.querySelectorAll('.lock-icon').length,
                    handles: app.viewport.contentLayer.querySelectorAll('.shape-anchors [data-anchor-id]').length,
                    box: box && { minY: box.y, maxY: box.y + box.height, minX: box.x, maxX: box.x + box.width },
                };
            });
            assert.equal(icon.count, 1, 'one lock icon');
            assert.equal(icon.handles, 0, 'a locked shape shows no edit handles');
            // Grid snapping can leave the click just inside the drawn edge; the lock still goes outside.
            const top = await page.evaluate(() =>
                Math.min(...[...window.bootstrap.schematicApp.shapes[0].nodes.values()].map(node => node.y)));
            assert.ok(icon.box.maxY <= top, 'the lock sits outside the shape, beside the clicked top edge');
            assert.ok(icon.box.minY > top - 6 && icon.box.minX > c.x - 1 && icon.box.maxX < c.x + 21,
                'and close to where the shape was clicked');

            // Dragging a locked shape leaves it in place.
            await dragFrom(page, { x: c.x + 10, y: c.y }, { x: c.x + 10, y: c.y + 30 });
            assert.deepEqual((await shapes(page))[0].corner, first.corner, 'a locked shape does not move');

            // Select All takes the locked shape; a drag moves only the unlocked one.
            await page.keyboard.press('Escape');
            await page.keyboard.press('Control+a');
            assert.equal(await page.evaluate(() => window.bootstrap.schematicApp.selection.count), 2);
            // Grab the unlocked rectangle away from its edge midpoint, which is an insert-node handle.
            await dragFrom(page, { x: c.x + 44, y: c.y }, { x: c.x + 44, y: c.y + 5 });
            let now = await shapes(page);
            assert.deepEqual(now[0].corner, first.corner, 'the locked member stays put');
            assert.notDeepEqual(now[1].corner, second.corner, 'the unlocked member moves');

            // A shared edit reaches only the unlocked shape.
            await page.locator('#prop_lineWidth').fill('0.6');
            await page.locator('#prop_lineWidth').press('Enter');
            now = await shapes(page);
            assert.equal(now[0].lineWidth, first.lineWidth, 'the locked shape keeps its line width');
            assert.equal(now[1].lineWidth, 0.6, 'the unlocked shape takes the edit');

            // The lock icon offers to unlock that object, as one undo step.
            // Escape after committing a Properties field belongs to that field;
            // explicitly reset selection before copying a single locked object.
            await clickAt(page, c.x + 100, c.y + 40);
            assert.equal(await page.evaluate(() => window.bootstrap.schematicApp.selection.count), 0,
                'clicking empty canvas clears the prior multi-selection');
            await clickAt(page, c.x + 10, c.y);
            assert.equal(await page.evaluate(() => window.bootstrap.schematicApp.selection.count), 1,
                'the locked rectangle alone is selected for the copy check');
            await page.locator('.lock-icon').first().click();
            const menu = page.locator('.anchor-context-menu');
            await menu.waitFor();
            assert.deepEqual(await menu.locator('div').allTextContents(), ['Unlock rectangle']);
            await menu.locator('div', { hasText: 'Unlock rectangle' }).click();
            assert.equal((await shapes(page))[0].locked, false, 'the menu unlocks the shape');
            await page.keyboard.press('Control+z');
            assert.equal((await shapes(page))[0].locked, true, 'unlocking is undoable');

            // A pasted copy of a locked shape is unlocked.
            await page.keyboard.press('Control+c');
            await page.keyboard.press('Control+v');
            await clickAt(page, c.x + 10, c.y + 40);
            now = await shapes(page);
            assert.equal(now.length, 3);
            assert.equal(now[2].locked, false, 'the pasted copy starts unlocked');
        },
    },
];
