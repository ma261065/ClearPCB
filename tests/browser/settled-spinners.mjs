import assert from 'node:assert/strict';
import { openPcb, openSchematic, saveAndReopen, stepSpinnerOneRun } from './helpers/editor-helpers.mjs';

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
        name: 'schematic-multi-text-size-spinner-persists',
        async run(page, url) {
            await openSchematic(page, url);
            await page.evaluate(async () => {
                const { Text } = await import('/src/shapes/text.js');
                const { Wire } = await import('/src/shapes/wire.js');
                const { Net } = await import('/src/shapes/net.js');
                const { attachLabelToTarget } = await import('/src/schematic/modules/label-attachment.js');
                const app = window.bootstrap.schematicApp;
                const wire = new Wire({ points: [{ x: 10, y: 8 }, { x: 30, y: 8 }] });
                const texts = Array.from({ length: 9 }, (_, i) => new Text({
                    x: 10 + i * 10, y: 10, text: `Text ${i}`, fontSize: 2,
                }));
                const net = new Net({ x: 30, y: 20, net: 'VCC' });
                texts[1] = net.ensureLabelText(2.5);
                attachLabelToTarget(texts[0], wire, { x: 10, y: 8 });
                app.shapes.push(wire, net, ...texts);
                app.updateSelectableItems();
                for (const text of texts) app.selection.select(text, true);
                app.renderShapes(true);
                app.updatePropertiesPanel(app.selection.getSelection());
            });
            const field = page.locator('#prop_fontSize');
            await field.waitFor({ state: 'visible' });
            const box = await field.boundingBox();
            await page.mouse.click(box.x + box.width - 8, box.y + box.height * 0.25);
            const shown = Number(await field.inputValue());
            assert.ok(shown > 0);
            await page.waitForTimeout(800);
            const sizes = await page.evaluate(() => window.bootstrap.schematicApp.selection.getSelection().map(s => s.fontSize));
            assert.deepEqual(sizes, Array(9).fill(shown), 'all nine text sizes survive the settled commit with an attached label first');
            await saveAndReopen(page, 'schematic');
            const reopened = await page.evaluate(() => {
                const app = window.bootstrap.schematicApp;
                return {
                    sizes: app.shapes.filter(s => s.type === 'text').map(s => s.fontSize),
                    linked: app.shapes.find(s => s.type === 'net').labelText?.parentComponent?.type,
                };
            });
            assert.deepEqual(reopened.sizes, Array(9).fill(shown), 'wire and Net Text sizes survive the editor reload');
            assert.equal(reopened.linked, 'net');
        },
    },
    {
        name: 'schematic-net-text-copy-keeps-size',
        async run(page, url) {
            await openSchematic(page, url);
            const result = await page.evaluate(async () => {
                const { Net } = await import('/src/shapes/net.js');
                const { copySelection, beginPastePreview, confirmPaste } = await import('/src/schematic/modules/clipboard.js');
                const app = window.bootstrap.schematicApp;
                const net = new Net({ x: 10, y: 10, net: 'VCC' });
                net.ensureLabelText(3.5);
                app.addShape(net);
                app.selection.select(net);
                app.selection.select(net.labelText, true);
                copySelection(app);
                beginPastePreview(app);
                confirmPaste(app, { x: 40, y: 40 });
                const pasted = app.shapes.find(s => s.type === 'net' && s !== net);
                const result = {
                    size: pasted.labelText.fontSize,
                    linked: pasted.labelText.parentComponent === pasted,
                    labels: app.shapes.filter(s => s.type === 'text').length,
                };
                app.history.undo();
                result.undoLabels = app.shapes.filter(s => s.type === 'text').length;
                app.history.redo();
                result.redoSize = pasted.labelText.fontSize;
                return result;
            });
            assert.deepEqual(result, { size: 3.5, linked: true, labels: 2, undoLabels: 1, redoSize: 3.5 });
            await saveAndReopen(page, 'schematic');
        },
    },
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
