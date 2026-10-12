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

        await page.evaluate(() => window.bootstrap.schematicApp.startTextEdit(
            window.bootstrap.schematicApp.shapes[0]));
        await page.keyboard.press('Control+a');
        const historyBeforeSymbolUndo = await page.evaluate(() =>
            window.bootstrap.schematicApp.history.undoStack.length);
        await page.keyboard.type('(u)');
        assert.equal((await schematicState(page)).text, 'µ');
        await page.keyboard.press('Control+z');
        assert.deepEqual(await schematicState(page), { text: '(u)', caret: 3, anchor: null },
            'schematic inline Undo restores the literal symbol token');
        assert.equal(await page.evaluate(() => window.bootstrap.schematicApp.history.undoStack.length),
            historyBeforeSymbolUndo, 'inline symbol Undo does not step editor history');
        await page.keyboard.press('Control+a');
        await page.keyboard.type('(c) (R) (tm) (u) (O)');
        assert.deepEqual(await schematicState(page), { text: '© ® ™ µ Ω', caret: 9, anchor: null },
            'schematic inline typing uses the same symbol tokens as PCB text');
        await page.keyboard.press('Enter');
        assert.equal(await page.evaluate(() => window.bootstrap.schematicApp.shapes[0].text), '© ® ™ µ Ω');
        await page.keyboard.press('Control+z');
        assert.equal(await page.evaluate(() => window.bootstrap.schematicApp.shapes[0].text), 'hello PCB',
            'symbol insertion remains part of the schematic inline-edit undo step');

        await page.evaluate(() => {
            const app = window.bootstrap.schematicApp;
            app.selectTool('select');
            const text = app.shapes[0];
            app.selection.select(text, false);
            app.startTextEdit(text);
        });
        const picker = page.locator('#propTextInsert');
        assert.equal(await picker.count(), 1, 'schematic text editing exposes the PCB symbol picker');
        await picker.selectOption('µ');
        assert.equal((await schematicState(page)).text, 'hello PCBµ',
            'symbol picker inserts at the active schematic caret');
        await page.keyboard.press('Shift+ArrowLeft');
        await picker.selectOption('Ω');
        assert.equal((await schematicState(page)).text, 'hello PCBΩ',
            'symbol picker replaces the active schematic selection');
        await page.keyboard.press('Escape');
    },
}, {
    name: 'schematic-reference-and-value-edits-show-symbol-picker',
    async run(page, url) {
        await openSchematic(page, url);
        const fields = await page.evaluate(async centre => {
            const app = window.bootstrap.schematicApp;
            const { Component } = await import('/src/components/Component.js');
            const { BuiltInComponents } = await import('/src/components/BuiltInComponents.js');
            const { AddComponentCommand } = await import('/src/schematic/modules/commands.js');
            const component = new Component(BuiltInComponents[0], {
                ...centre,
                reference: 'R9',
                value: '10k',
            });
            app.history.execute(new AddComponentCommand(app, component));
            return {
                reference: component.refText.id,
                value: component.valueText.id,
            };
        }, await viewCentre(page));
        for (const [field, symbol] of [['reference', 'Ω'], ['value', 'µ']]) {
            await page.evaluate(({ id }) => {
                const app = window.bootstrap.schematicApp;
                const text = app.shapes.find(shape => shape.id === id);
                app.selection.select(text, false);
                app.startTextEdit(text);
            }, { id: fields[field] });
            const picker = page.locator('#propTextInsert');
            const pickerCount = await picker.count();
            const diagnostic = pickerCount ? null : await page.evaluate(async () => {
                const app = window.bootstrap.schematicApp;
                const { getSchematicTextEdit } = await import('/src/schematic/modules/text-edit.js');
                return {
                    fields: app.components[0]?.getFieldTexts().map(text => ({
                        id: text.id, key: text.fieldKey, visible: text.visible, text: text.text,
                    })),
                    edit: getSchematicTextEdit(app)?.shape?.id,
                    selected: app.selection.getSelection().map(item => item.id),
                };
            });
            assert.equal(pickerCount, 1,
                `${field} editing shows the shared symbol picker: ${JSON.stringify(diagnostic)}`);
            await picker.selectOption(symbol);
            assert.equal((await schematicState(page)).text.endsWith(symbol), true,
                `${field} picker inserts into the active field text`);
            await page.keyboard.press('Enter');
        }
        const result = await page.evaluate(() => {
            const component = window.bootstrap.schematicApp.components.find(item => item.reference.startsWith('R9'));
            return { reference: component.reference, value: component.value };
        });
        assert.deepEqual(result, { reference: 'R9Ω', value: '10kµ' });
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
