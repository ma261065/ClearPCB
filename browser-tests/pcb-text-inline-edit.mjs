import assert from 'node:assert/strict';
import { openPcb, screenPoint } from './helpers/editor-helpers.mjs';

/** The hidden input that captures keystrokes for the text being edited on the canvas. */
const editState = page => page.evaluate(async () => {
    const { activeTextInlineEdit } = await import('/src/pcb/modules/text-inline-edit.js');
    const app = window.bootstrap.pcbApp;
    const edit = activeTextInlineEdit(app);
    return {
        editing: !!edit,
        caret: edit?.input.selectionStart ?? null,
        focused: !!edit && document.activeElement === edit.input,
        shown: app.texts.get('probe')?.content,
        authored: app.pcbDocument.texts.get('probe')?.content,
        rotation: app.pcbDocument.texts.get('probe')?.rotation,
    };
});

/** World position of a point on the text: its centre, or its rotation handle. */
const textPoint = (page, which) => page.evaluate(async which => {
    const { pcbTextBounds } = await import('/src/pcb/modules/pcb-text.js');
    const { rotationHandleAnchor } = await import('/src/pcb/modules/rotation-handle.js');
    const app = window.bootstrap.pcbApp;
    const bounds = pcbTextBounds(app.texts.get('probe'));
    if (which === 'rotate') {
        const anchor = rotationHandleAnchor(bounds, app.viewport.scale);
        return { x: anchor.x, y: anchor.y };
    }
    return { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
}, which);

export const scenarios = [{
    name: 'rotating-text-while-editing-keeps-the-typing-and-caret',
    async run(page, url) {
        await openPcb(page, url);
        await page.evaluate(async () => {
            const app = window.bootstrap.pcbApp;
            const { AddTextCommand } = await import('/src/pcb/modules/text-commands.js');
            const { createPcbText } = await import('/src/core/pcb-text.js');
            app.history.execute(new AddTextCommand(app, createPcbText({
                id: 'probe', content: 'ABC', x: 20, y: -20, size: 3, layer: 'top-silk',
            })));
        });
        const centre = await textPoint(page, 'centre');
        const at = await screenPoint(page, 'pcb', centre.x, centre.y);
        await page.mouse.dblclick(at.x, at.y);
        await page.waitForFunction(async () => !!(await import('/src/pcb/modules/text-inline-edit.js'))
            .activeTextInlineEdit(window.bootstrap.pcbApp));
        await page.keyboard.press('End');
        await page.keyboard.type('XYZ');
        for (let step = 0; step < 3; step++) await page.keyboard.press('ArrowLeft');
        const before = await editState(page);
        assert.equal(before.shown, 'ABCXYZ');
        assert.equal(before.caret, 3, 'the caret sits after ABC');

        const handle = await textPoint(page, 'rotate');
        const start = await screenPoint(page, 'pcb', handle.x, handle.y);
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await page.mouse.move(start.x + 60, start.y + 60, { steps: 8 });
        const during = await editState(page);
        assert.equal(during.shown, 'ABCXYZ', 'rotating shows the typed text');
        assert.equal(during.caret, 3, 'rotating leaves the caret where it was');
        await page.mouse.up();

        const after = await editState(page);
        assert.equal(after.editing, true, 'the edit continues after the rotation');
        assert.equal(after.focused, true, 'typing still goes to the text');
        assert.equal(after.shown, 'ABCXYZ', 'the typed text stays on screen after the rotation');
        assert.equal(after.authored, 'ABC', 'the typing is not authored until the edit finishes');
        assert.equal(after.caret, 3, 'the caret stays where it was');
        assert.notEqual(after.rotation, 0, 'the rotation is committed');

        await page.keyboard.type('-');
        assert.equal((await editState(page)).shown, 'ABC-XYZ', 'typing continues at the caret');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => window.bootstrap.pcbApp.pcbDocument.texts.get('probe').content === 'ABC-XYZ');
        assert.equal((await editState(page)).rotation, after.rotation, 'finishing keeps the rotation');
    },
}];
