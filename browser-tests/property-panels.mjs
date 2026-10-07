import assert from 'node:assert/strict';
import { openPcb } from './helpers/editor-helpers.mjs';

// Properties panels are descriptions rendered by shared/ui/property-fields.js. These
// scenarios drive real panels: rows, mixed/locked states, live preview and settled commit.

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
const activeTab = page => page.locator('#ribbonPCB .ribbon-tab.active').getAttribute('data-tab');
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
    {
        name: 'fill-tool-properties-like-the-other-drawing-tools',
        async run(page, url) {
            await openPcb(page, url);
            await page.locator('[data-tab="pcb-home"]').click();
            await page.locator('#pcbToolFill').click();
            assert.equal(await title(page), 'New Fill', 'the Fill tool shows its Properties');
            assert.deepEqual(await rows(page), ['layer', 'net', 'cornerRadius']);
            await page.locator('#pcbPropFillToolNet').fill('GND');
            await page.locator('#pcbPropFillToolNet').press('Enter');
            await page.locator('#pcbPropFillToolCornerRadius').fill('1.5');
            await page.locator('#pcbPropFillToolCornerRadius').press('Enter');
            for (const [x, y] of [[10, -10], [30, -10], [30, -30], [10, -30]]) {
                await clickAt(page, x, y);
                assert.equal(await activeTab(page), 'pcb-properties', `placing corner (${x}, ${y}) keeps the Properties tab`);
            }
            await clickAt(page, 10, -10);
            const fill = await page.evaluate(() => {
                const [item] = window.bootstrap.pcbApp.pcbDocument.copperFills;
                return item && { net: item.net, cornerRadius: item.cornerRadius, layer: item.layer };
            });
            assert.deepEqual(fill, { net: 'GND', cornerRadius: 1.5, layer: 'top-copper' }, 'the pour takes the tool settings');
            assert.equal(await title(page), 'Copper Fill', 'a finished pour shows its own Properties');
            await clickAt(page, 40, -10);
            assert.equal(await title(page), 'New Fill', 'starting the next pour shows the tool Properties again');
            assert.equal(await page.locator('#pcbPropFillToolCornerRadius').inputValue(), '1.50', 'the corner radius shows two decimals');
            await page.keyboard.press('Escape');
        },
    },
    {
        name: 'right-click finishes a fill at the cursor like a polygon',
        async run(page, url) {
            await openPcb(page, url);
            const corners = [[10, -10], [30, -10], [30, -30]], cursor = [10, -30];
            for (const tool of ['fill', 'polygon']) {
                await page.evaluate(async tool => {
                    const { selectPcbTool } = await import('/src/pcb/modules/tool-lifecycle.js');
                    selectPcbTool(window.bootstrap.pcbApp, tool);
                }, tool);
                for (const [x, y] of corners) await clickAt(page, x, y);
                const at = await screenPoint(page, ...cursor);
                await page.mouse.move(at.x, at.y);
                await page.mouse.click(at.x, at.y, { button: 'right' });
                const outline = await page.evaluate(tool => {
                    const app = window.bootstrap.pcbApp;
                    const made = tool === 'fill' ? app.copperFills.at(-1)
                        : app.boardShapes.filter(shape => shape.kind === 'polygon').at(-1);
                    return (made?.outline || made?.points || []).map(({ x, y }) => [Math.round(x), Math.round(y)]);
                }, tool);
                assert.deepEqual(outline, [...corners, cursor], `${tool}: a right-click adds the cursor as the last corner`);
            }
        },
    },
    {
        name: 'pour-outline-follows-number-fields-live',
        async run(page, url) {
            await openPcb(page, url);
            await page.locator('[data-tab="pcb-home"]').click();
            await page.locator('#pcbToolFill').click();
            for (const [x, y] of [[10, -10], [40, -10], [40, -30], [10, -30], [10, -10]]) await clickAt(page, x, y);
            assert.equal(await title(page), 'Copper Fill');
            const pour = () => page.evaluate(() => {
                const app = window.bootstrap.pcbApp, fill = app.copperFills[0];
                const group = app.getLayerGroup(fill.layer === 'bottom-copper' ? 'bottom-fill' : 'top-fill');
                return { radius: fill.cornerRadius, undo: app.history.undoStack.length,
                    outline: group.querySelector('.pcb-fill-outline')?.getAttribute('points').split(' ').length,
                    copper: group.querySelectorAll('.pcb-fill-copper').length };
            });
            await page.waitForTimeout(500);
            const start = await pour();
            assert.equal(start.outline, 4);
            await stepUp(page, '#pcbPropFillCornerRadius', 4);
            const during = await pour();
            assert.equal(during.radius, start.radius, 'the pour itself waits for the run to settle');
            assert.ok(during.outline > 4, 'its dashed outline already shows the rounded corners');
            assert.equal(during.copper, 0, 'and its copper waits too');
            await page.waitForTimeout(1200);
            const after = await pour();
            assert.ok(after.radius > 0, 'the settled run commits');
            assert.equal(after.undo, start.undo + 1, 'as one undo step');
            assert.ok(after.copper > 0, 'and the copper is poured again');
            await page.selectOption('#pcbPropFillKind', 'circle');
            assert.match(await page.locator('#pcbPropFillDiameter').inputValue(), /^\d+\.\d{2}$/,
                'a circle diameter shows two decimals when first shown');
            const selectedPath = () => page.evaluate(() => {
                const overlay = window.bootstrap.pcbApp.getLayerGroup('selection-overlay');
                return overlay.querySelector('[data-selection-id] path')?.getAttribute('d') || '';
            });
            const pathBefore = await selectedPath();
            await stepUp(page, '#pcbPropFillDiameter', 3);
            const pathDuring = await selectedPath();
            assert.notEqual(pathDuring, pathBefore, 'the selected path follows the live circle outline');
            await page.waitForTimeout(1200);
            assert.equal(await selectedPath(), pathDuring, 'and stays with the committed pour');
        },
    },
    {
        name: 'dragging-a-pour-keeps-its-own-panel-live',
        async run(page, url) {
            await openPcb(page, url);
            await page.evaluate(async () => {
                const app = window.bootstrap.pcbApp;
                const { CopperFill } = await import('/src/shapes/copper-fill.js');
                const { AddFillCommand } = await import('/src/pcb/modules/copper-fill-commands.js');
                app.history.execute(new AddFillCommand(app, new CopperFill({ kind: 'circle', x: 30, y: -30, radius: 8, net: 'GND' })));
                window.__panelsOpened = 0;
                const open = app.openPropertyPanel.bind(app);
                app.openPropertyPanel = (...args) => { window.__panelsOpened++; return open(...args); };
            });
            await clickAt(page, 38, -30);
            await page.waitForFunction(() => document.querySelector('#pcbPropsContent .ribbon-group-title')?.textContent === 'Copper Fill',
                null, { timeout: 5000 }).catch(() => {});
            assert.equal(await title(page), 'Copper Fill', 'clicking the pour edge selects it');
            const start = await screenPoint(page, 38, -30), end = await screenPoint(page, 44, -30);
            await page.evaluate(() => { window.__panelsOpened = 0; });
            await page.mouse.move(start.x, start.y);
            await page.mouse.down();
            await page.mouse.move(end.x, end.y, { steps: 10 });
            assert.equal(await title(page), 'Copper Fill', 'the pour keeps its own panel during a drag');
            const live = Number(await page.locator('#pcbPropFillDiameter').inputValue());
            assert.ok(live > 16.5, 'and its Diameter follows the drag');
            assert.ok(await page.evaluate(() => window.__panelsOpened) <= 1, 'updated in place, not reopened on every move');
            await page.mouse.up();
            const radius = await page.evaluate(() => window.bootstrap.pcbApp.pcbDocument.copperFills[0].radius);
            assert.ok(Math.abs(radius * 2 - live) < 0.6, 'the committed pour matches what the panel showed');
        },
    },
];
