import assert from 'node:assert/strict';
import { openPcb } from './helpers/editor-helpers.mjs';
import { SETTLE_MS } from '../../src/shared/ui/settled-input.js';

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

/** Click the up arrow of a native number spinner. */
async function stepUp(page, selector, times) {
    const box = await page.locator(selector).boundingBox();
    for (let index = 0; index < times; index++) {
        await page.mouse.click(box.x + box.width - 6, box.y + box.height / 4);
        await page.waitForTimeout(60);
    }
}

/**
 * Step a field up as one run and read the state before it settles. A machine too
 * loaded to click within the settle window splits the run (correctly committing
 * part of it), so such a burst is waited out and retried rather than judged.
 */
async function stepUpOneRun(page, selector, times) {
    for (let attempt = 0; attempt < 3; attempt++) {
        const start = await state(page);
        await page.evaluate(selector => {
            const field = document.querySelector(selector);
            window.__spinnerChanges = [];
            if (field.dataset.spinnerStamped) return;
            field.dataset.spinnerStamped = 'true';
            field.addEventListener('change', () => window.__spinnerChanges.push(performance.now()));
        }, selector);
        await stepUp(page, selector, times);
        const during = await state(page);
        const oneRun = await page.evaluate(({ times, settleMs }) => {
            const stamps = [...window.__spinnerChanges, performance.now()];
            return stamps.length === times + 1
                && stamps.every((stamp, index) => !index || stamp - stamps[index - 1] < settleMs);
        }, { times, settleMs: SETTLE_MS });
        if (oneRun) return { start, during };
        await page.waitForTimeout(SETTLE_MS + 300);
    }
    throw new Error(`spinner clicks never landed within ${SETTLE_MS} ms of each other`);
}

export const scenarios = [
    {
        name: 'spinner-runs-commit-once-settled',
        async run(page, url) {
            await openPcb(page, url);
            await drawSilkLine(page);
            await clickAt(page, 25, -20);
            const field = '#pcbPropShapeLineWidth';
            await page.locator(field).waitFor();

            const { start, during } = await stepUpOneRun(page, field, 3);
            assert.equal(during.undo, start.undo, 'no undo step while the run is settling');
            const shown = Number(await page.locator(field).inputValue());
            assert.ok(shown > start.width, 'the field shows the stepped value');
            await page.waitForTimeout(700);
            const settled = await state(page);
            assert.equal(settled.undo, start.undo + 1, 'the run commits as one undo step');
            assert.ok(Math.abs(settled.width - shown) < 1e-9, 'the committed width is the last step');

            await stepUp(page, field, 2);
            await page.locator('[data-tab="pcb-home"]').click();
            await page.locator('#pcbUndoBtn').click();
            await page.waitForTimeout(100);
            const undone = await state(page);
            assert.ok(Math.abs(undone.width - settled.width) < 1e-9, 'undo during a run undoes the whole run');
            assert.equal(undone.undo, settled.undo, 'the flushed run was its own undo step');
            assert.equal(undone.redo, 1, 'and it can be redone');
            await page.waitForTimeout(600);
            assert.deepEqual(await state(page), undone, 'nothing commits after the flushed run');
        },
    },
];
