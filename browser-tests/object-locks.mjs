import assert from 'node:assert/strict';
import { openPcb, viewportSettled, waitForPage } from './helpers/editor-helpers.mjs';

// Individual object locks through the real UI: the Properties "Locked" checkbox,
// the read-only panel, the selection lock icon and its unlock menu, and save + reopen.

const settle = page => viewportSettled(page, 'pcb');

function screenPoint(page, x, y) {
    return page.evaluate(([x, y]) => {
        const viewport = window.bootstrap.pcbApp.viewport;
        const screen = viewport.worldToScreen({ x, y });
        const rect = viewport.svg.getBoundingClientRect();
        return { x: rect.left + screen.x, y: rect.top + screen.y };
    }, [x, y]);
}

async function clickAt(page, x, y) {
    const point = await screenPoint(page, x, y);
    await page.mouse.move(point.x, point.y);
    await page.mouse.click(point.x, point.y);
}

async function drawLine(page, layer, points) {
    await page.locator('[data-tab="pcb-home"]').click();
    await page.locator('#pcbToolShapesArrow').click();
    await page.locator('#pcbToolShapesMenu [data-shape="line"]').click();
    await page.selectOption('#pcbToolShapeLayer', layer);
    for (const [x, y] of points) await clickAt(page, x, y);
    const [x, y] = points.at(-1);
    const point = await screenPoint(page, x, y);
    await page.mouse.dblclick(point.x, point.y);
    await page.keyboard.press('Escape');
    await page.locator('[data-tab="pcb-home"]').click();
    await page.locator('#pcbToolSelect').click();
}

const shape = page => page.evaluate(() => {
    const found = window.bootstrap.pcbApp.boardShapes.find(item => item.layer === 'top-silk');
    return found && { locked: !!found.locked, x: found.points[0].x, y: found.points[0].y };
});

async function lockMenu(page) {
    await page.locator('.pcb-selection-lock-icon').click();
    const menu = page.locator('#pcbUnlockMenu');
    await menu.waitFor();
    return menu.locator('div').allTextContents();
}

export const scenarios = [
    {
        name: 'object-locks-through-properties-and-the-lock-icon',
        async run(page, url) {
            await openPcb(page, url);
            await drawLine(page, 'top-silk', [[20, -20], [30, -20]]);
            await clickAt(page, 25, -20);
            await page.locator('#pcbPropObjectLocked').check();
            assert.equal((await shape(page)).locked, true, 'the Properties checkbox locks the shape');
            assert.equal(await page.locator('#pcbPropShapeLayer').isDisabled(), true, 'a locked shape is read-only');
            assert.equal(await page.locator('#pcbPropObjectLocked').isDisabled(), false);
            assert.equal(await page.locator('.pcb-selection-lock-icon').count(), 1, 'the lock icon shows');

            const before = await shape(page);
            const from = await screenPoint(page, 25, -20);
            const to = await screenPoint(page, 35, -10);
            await page.mouse.move(from.x, from.y);
            await page.mouse.down();
            await page.mouse.move(to.x, to.y, { steps: 5 });
            await page.mouse.up();
            assert.deepEqual(await shape(page), before, 'dragging a locked shape leaves it in place');

            await page.evaluate(() => {
                const layer = document.querySelector('.pcb-layer-row[data-layer-id="top-silk"] .lock-btn');
                layer.click();
            });
            assert.deepEqual(await lockMenu(page), ['Unlock shape', 'Unlock Top Silk layer', 'Unlock both']);
            await page.locator('#pcbUnlockMenu div', { hasText: 'Unlock Top Silk layer' }).click();
            assert.equal((await shape(page)).locked, true, 'unlocking the layer keeps the object lock');

            assert.deepEqual(await lockMenu(page), ['Unlock shape'], 'only the object lock remains');
            await page.locator('#pcbUnlockMenu div', { hasText: 'Unlock shape' }).click();
            assert.equal((await shape(page)).locked, false);
            assert.equal(await page.locator('#pcbPropShapeLayer').isDisabled(), false, 'unlocking refreshes the panel');
            assert.equal(await page.locator('#pcbPropObjectLocked').isChecked(), false);

            await page.keyboard.press('Control+z');
            assert.equal((await shape(page)).locked, true, 'unlocking is undoable');

            const expected = await page.evaluate(() => JSON.stringify(window.bootstrap.project.serialize().pcb));
            assert.match(expected, /"lk":true/, 'the lock is saved as lk');
            await page.waitForFunction(text => {
                const saved = localStorage.getItem('clearpcb_autosave_untitled.cpcb');
                return saved && JSON.stringify(JSON.parse(saved).data?.pcb) === text;
            }, expected, { timeout: 30000 });
            await page.reload();
            const recover = page.locator('.app-modal-overlay button', { hasText: 'Yes' });
            await recover.waitFor();
            await recover.click();
            await page.waitForFunction(() => window.bootstrap?.pcbApp && !window.bootstrap.project.fileManager.loading);
            await page.locator('.mode-tab[data-mode="pcb"]').click();
            await waitForPage(page, () => import('/src/pcb/modules/pcb-editor-api.js')
                .then(api => api.isEditorActive(window.bootstrap.pcbApp)));
            assert.equal((await shape(page)).locked, true, 'the lock survives save and reopen');

            // Bulk selection takes locked objects, edits reach only the unlocked ones, and the
            // Locked row can unlock a whole Select All.
            await settle(page);
            await drawLine(page, 'top-silk', [[20, -30], [30, -30]]);
            const silkLines = () => page.evaluate(() => window.bootstrap.pcbApp.boardShapes
                .filter(item => item.layer === 'top-silk').map(item => ({ locked: !!item.locked, width: item.lineWidth })));
            const start = await screenPoint(page, 15, -12);
            const end = await screenPoint(page, 35, -38);
            await page.mouse.move(start.x, start.y);
            await page.mouse.down();
            await page.mouse.move(end.x, end.y, { steps: 8 });
            await page.mouse.up();
            assert.equal(await page.evaluate(() => window.bootstrap.pcbApp._pcbSelection?.getSelection().length), 2,
                'the marquee takes the locked line too');
            await page.locator('#pcbPropIntersection_lineWidth').fill('0.5');
            await page.locator('#pcbPropIntersection_lineWidth').press('Enter');
            assert.deepEqual(await silkLines(), [{ locked: true, width: 0.2 }, { locked: false, width: 0.5 }],
                'a shared edit reaches only the unlocked line');

            await page.keyboard.press('Control+a');
            const lockedRow = page.locator('#pcbPropIntersection_locked');
            assert.equal(await lockedRow.evaluate(input => input.indeterminate), true, 'Select All shows a mixed Locked row');
            await lockedRow.click();
            assert.ok((await silkLines()).every(item => item.locked), 'the Locked row locks the whole selection');
            await page.locator('#pcbPropIntersection_locked').click();
            assert.ok((await silkLines()).every(item => !item.locked), 'and unlocks it again in one step');
        },
    },
];
