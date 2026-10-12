import assert from 'node:assert/strict';
import { openPcb, stepSpinnerOneRun } from './helpers/editor-helpers.mjs';

// Properties number fields commit once a run of spinner clicks settles: one undo
// step, with the live preview showing each step meanwhile. Pressing Undo during a run
// commits the run first (leaving the field flushes it), so it undoes the whole run.
// (Keyboard shortcuts belong to the focused field, so Ctrl+Z there is text undo.)

async function screenPoint(page, x, y) {
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

async function drawSilkLine(page) {
    await page.locator('[data-tab="pcb-home"]').click();
    await page.locator('#pcbToolShapesArrow').click();
    await page.locator('#pcbToolShapesMenu [data-shape="line"]').click();
    await page.selectOption('#pcbToolShapeLayer', 'top-silk');
    await clickAt(page, 20, -20);
    await clickAt(page, 30, -20);
    const end = await screenPoint(page, 30, -20);
    await page.mouse.dblclick(end.x, end.y);
    await page.keyboard.press('Escape');
    await page.locator('[data-tab="pcb-home"]').click();
    await page.locator('#pcbToolSelect').click();
}

const state = page => page.evaluate(() => {
    const app = window.bootstrap.pcbApp;
    const shape = app.boardShapes.find(item => item.layer === 'top-silk');
    return { width: shape.lineWidth, undo: app.history.undoStack.length, redo: app.history.redoStack.length };
});

export const scenarios = [
    {
        name: 'spinner-runs-commit-once-settled',
        async run(page, url) {
            await openPcb(page, url);
            await drawSilkLine(page);
            await clickAt(page, 25, -20);
            const field = '#pcbPropShapeLineWidth';
            await page.locator(field).waitFor();

            const { start, during } = await stepSpinnerOneRun(page, field, 3, () => state(page));
            assert.equal(during.undo, start.undo, 'no undo step while the run is settling');
            const shown = Number(await page.locator(field).inputValue());
            assert.ok(shown > start.width, 'the field shows the stepped value');
            await page.waitForTimeout(700);
            const settled = await state(page);
            assert.equal(settled.undo, start.undo + 1, 'the run commits as one undo step');
            assert.ok(Math.abs(settled.width - shown) < 1e-9, 'the committed width is the last step');

            const { start: beforeRun } = await stepSpinnerOneRun(page, field, 2, () => state(page));
            await page.locator('[data-tab="pcb-home"]').click();
            await page.locator('#pcbUndoBtn').click();
            await page.waitForTimeout(100);
            const undone = await state(page);
            assert.ok(Math.abs(undone.width - beforeRun.width) < 1e-9, 'undo during a run undoes the whole run');
            assert.equal(undone.undo, beforeRun.undo, 'the flushed run was its own undo step');
            assert.equal(undone.redo, 1, 'and it can be redone');
            await page.waitForTimeout(600);
            assert.deepEqual(await state(page), undone, 'nothing commits after the flushed run');
        },
    },
];
