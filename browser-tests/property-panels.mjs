import assert from 'node:assert/strict';

// Properties panels are descriptions rendered by shared/ui/property-fields.js. These
// scenarios drive real panels: rows, mixed/locked states, live preview and settled commit.

async function openPcb(page, url) {
    await page.goto(`${url}index.html`);
    await page.waitForFunction(() => window.bootstrap?.pcbApp && window.bootstrap?.schematicApp);
    if (await page.locator('#startupSplash').isVisible()) await page.locator('#startupContinue').click();
    await page.locator('.mode-tab[data-mode="pcb"]').click();
    const ok = page.locator('.app-modal-overlay button', { hasText: 'OK' });
    await ok.waitFor();
    await ok.click();
    await page.waitForFunction(() => window.bootstrap.pcbApp._boardOutlineDrawn);
    await page.waitForTimeout(300);
}

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

async function stepUp(page, selector, times) {
    const box = await page.locator(selector).boundingBox();
    for (let index = 0; index < times; index++) {
        await page.mouse.click(box.x + box.width - 6, box.y + box.height / 4);
        await page.waitForTimeout(60);
    }
}

const rows = page => page.locator('#pcbPropsItems > .prop-row').evaluateAll(list => list.map(row => row.dataset.prop));
const title = page => page.locator('#pcbPropsContent .ribbon-group-title').textContent();
const pads = page => page.evaluate(() => {
    const app = window.bootstrap.pcbApp;
    return { sizes: app.pads.map(pad => pad.size), undo: app.history.undoStack.length };
});

export const scenarios = [
    {
        name: 'pad-properties-panel-from-a-description',
        async run(page, url) {
            await openPcb(page, url);
            await page.locator('[data-tab="pcb-home"]').click();
            await page.locator('#pcbToolPad').click();
            assert.equal(await title(page), 'New Pad');
            assert.deepEqual(await rows(page), ['padShape', 'layer', 'net', 'size', 'drill'], 'tool defaults: round pads have no ratio or rotation');
            await clickAt(page, 20, -20);
            await clickAt(page, 30, -20);
            await page.keyboard.press('Escape');
            await page.locator('[data-tab="pcb-home"]').click();
            await page.locator('#pcbToolSelect').click();
            await clickAt(page, 20, -20);
            assert.equal(await title(page), 'Pad');
            assert.deepEqual(await rows(page), ['locked', 'padShape', 'layer', 'net', 'size', 'drill']);
            const start = await pads(page);
            const size = Number(await page.locator('#pcbPropPadSize').inputValue());

            await stepUp(page, '#pcbPropPadSize', 3);
            assert.equal((await pads(page)).undo, start.undo, 'no undo step while the run settles');
            assert.equal(await page.locator('#pcbPropPadSize').evaluate(input => input === document.activeElement), true,
                'the stepped field keeps focus through the live preview');
            await page.waitForTimeout(700);
            const after = await pads(page);
            assert.equal(after.undo, start.undo + 1, 'one undo step');
            assert.ok(after.sizes[0] > size, 'the pad grew');
            assert.equal(after.sizes[1], start.sizes[1], 'the other pad is untouched');
            assert.equal(await page.locator('#pcbPropPadDrill').getAttribute('max'), String(after.sizes[0]),
                'the drill limit follows the size');

            await page.selectOption('#pcbPropPadShape', 'rectangle');
            assert.deepEqual(await rows(page), ['locked', 'padShape', 'layer', 'net', 'size', 'ratio', 'drill', 'rotation'],
                'an elongated pad shows ratio and rotation');
            await page.locator('#pcbPropObjectLocked').check();
            assert.equal(await page.locator('#pcbPropPadSize').isDisabled(), true, 'a locked pad is read-only');
            assert.equal(await page.locator('#pcbPropPadNet + details').count(), 0, 'and offers no net menu');
            await page.locator('#pcbPropObjectLocked').uncheck();
            assert.equal(await page.locator('#pcbPropPadSize').isDisabled(), false);

            await clickAt(page, 25, -10);
            await page.keyboard.press('Control+a');
            assert.match(await title(page), /^\d+ Selected$/, 'Select All shows the multi-selection panel');
            assert.equal((await rows(page))[0], 'locked', 'whose shared Locked row comes first');
            assert.equal(await page.locator('#pcbPropIntersection_locked').isChecked(), false);
        },
    },
];
