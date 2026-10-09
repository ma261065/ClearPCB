import assert from 'node:assert/strict';
import { openSchematic, openPcb, clickWorld, viewCentre } from './helpers/editor-helpers.mjs';

const schematicState = page => page.evaluate(async () => {
    const { getSchematicTextEdit } = await import('/src/schematic/modules/text-edit.js');
    const edit = getSchematicTextEdit(window.bootstrap.schematicApp);
    return { text: edit.shape.text, caret: edit.caretIndex, anchor: edit.selectionAnchor };
});

export const scenarios = [{
    name: 'schematic-inline-text-selection-shortcuts',
    async run(page, url) {
        await openSchematic(page, url);
        const centre = await viewCentre(page);
        await page.locator('#ribbonSchematic [data-tool="text"]').click();
        await clickWorld(page, 'schematic', centre.x, centre.y);
        await page.keyboard.type('hello world');
        await page.keyboard.press('Control+a');
        assert.deepEqual(await schematicState(page), { text: 'hello world', caret: 11, anchor: 0 });
        assert.ok(await page.locator('.text-edit-selection').evaluate(el =>
            el.style.display !== 'none' && Number(el.getAttribute('width')) > 0));
        await page.keyboard.type('ABC');
        assert.equal((await schematicState(page)).text, 'ABC', 'typing replaces the selection');
        await page.keyboard.press('Shift+ArrowLeft');
        await page.keyboard.press('Shift+ArrowLeft');
        assert.deepEqual(await schematicState(page), { text: 'ABC', caret: 1, anchor: 3 });
        await page.keyboard.press('Shift+ArrowRight');
        assert.deepEqual(await schematicState(page), { text: 'ABC', caret: 2, anchor: 3 });
        await page.keyboard.press('Backspace');
        assert.equal((await schematicState(page)).text, 'AB');
        await page.keyboard.press('Home');
        await page.keyboard.press('Shift+End');
        await page.keyboard.press('Delete');
        assert.equal((await schematicState(page)).text, '');
        await page.keyboard.type('hello world');
        await page.keyboard.press('Control+Shift+ArrowLeft');
        assert.equal((await schematicState(page)).caret, 6);
        await page.keyboard.type('PCB');
        assert.equal((await schematicState(page)).text, 'hello PCB');
        await page.keyboard.press('Meta+a');
        await page.keyboard.press('ArrowLeft');
        assert.equal((await schematicState(page)).caret, 0, 'unshifted arrow collapses to selection start');
        await page.keyboard.press('Shift+ArrowRight');
        await page.keyboard.press('ArrowRight');
        assert.equal((await schematicState(page)).caret, 1, 'unshifted arrow collapses to selection end');
        await page.keyboard.press('End');
        await page.keyboard.press('Shift+Home');
        await page.keyboard.press('Enter');
        assert.equal(await page.evaluate(() => window.bootstrap.schematicApp.shapes[0].text), 'hello PCB');
        await page.keyboard.press('Control+z');
        assert.equal(await page.evaluate(() => window.bootstrap.schematicApp.shapes[0].text), '',
            'the whole inline edit remains a single undo step');
        await page.keyboard.press('Control+y');
        assert.equal(await page.evaluate(() => window.bootstrap.schematicApp.shapes[0].text), 'hello PCB');
        await page.evaluate(() => window.bootstrap.schematicApp.startTextEdit(
            window.bootstrap.schematicApp.shapes[0]));
        await page.keyboard.press('Control+a');
        await page.keyboard.type('discard');
        await page.keyboard.press('Escape');
        assert.equal(await page.evaluate(() => window.bootstrap.schematicApp.shapes[0].text), 'hello PCB');
    },
}, {
    name: 'pcb-inline-text-selection-highlight-and-replacement',
    async run(page, url) {
        await openPcb(page, url);
        await page.evaluate(async () => {
            const app = window.bootstrap.pcbApp;
            const { createPcbText } = await import('/src/core/pcb-text.js');
            const { AddTextCommand } = await import('/src/pcb/modules/text-commands.js');
            const { startTextInlineEdit } = await import('/src/pcb/modules/text-inline-edit.js');
            const text = createPcbText({ id: 'selection-probe', content: 'ABC',
                x: 20, y: -20, size: 3, layer: 'top-silk' });
            app.history.execute(new AddTextCommand(app, text));
            startTextInlineEdit(app, text, { x: 20, y: -20 });
        });
        await page.waitForFunction(() => document.activeElement?.tagName === 'INPUT'
            && document.activeElement.style.left === '-1000px');
        await page.keyboard.press('Control+a');
        assert.ok(await page.locator('.text-edit-selection').evaluate(el =>
            el.style.display !== 'none' && Number(el.getAttribute('width')) > 0));
        await page.keyboard.type('DEF');
        await page.keyboard.press('Shift+ArrowLeft');
        await page.keyboard.press('Backspace');
        await page.keyboard.press('Enter');
        assert.equal(await page.evaluate(() =>
            window.bootstrap.pcbApp.pcbDocument.texts.get('selection-probe').content), 'DE');
        await page.keyboard.press('Control+z');
        await page.waitForFunction(() =>
            window.bootstrap.pcbApp.pcbDocument.texts.get('selection-probe').content === 'ABC');
    },
}];
