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

/** Add a text "ABC" and start editing it with the caret at the end. */
async function startEditing(page, url) {
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
}

const undoDepth = page => page.evaluate(() => window.bootstrap.pcbApp.history.undoStack.length);

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
}, {
    name: 'text-edit-keyboard-editing-and-selection',
    async run(page, url) {
        await startEditing(page, url);
        await page.keyboard.press('Home');
        await page.keyboard.type('1');
        await page.keyboard.press('End');
        await page.keyboard.press('Backspace');
        await page.keyboard.press('ArrowLeft');
        await page.keyboard.press('Delete');
        assert.equal((await editState(page)).shown, '1A', 'Home, End, Backspace, Delete and arrows edit at the caret');
        await page.keyboard.type('BC');
        await page.keyboard.press('Shift+ArrowLeft');
        await page.keyboard.press('Shift+ArrowLeft');
        await page.keyboard.type('x');
        assert.equal((await editState(page)).shown, '1Ax', 'typing replaces a Shift+Arrow selection');
        await page.keyboard.press('Control+a');
        await page.keyboard.type('New');
        const state = await editState(page);
        assert.equal(state.shown, 'New', 'Ctrl+A selects all the text, not the board');
        assert.equal(state.caret, 3);
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => window.bootstrap.pcbApp.pcbDocument.texts.get('probe').content === 'New');
    },
}, {
    name: 'text-edit-clipboard-stays-in-the-text',
    async run(page, url) {
        await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
        await startEditing(page, url);
        // Saving is refused mid-edit, so compare what is on the board rather than a snapshot.
        const board = () => page.evaluate(async () => {
            const { isPcbPasteActive } = await import('/src/pcb/modules/pcb-paste.js');
            const doc = window.bootstrap.pcbApp.pcbDocument;
            return JSON.stringify({ texts: doc.texts.size, tracks: doc.tracks.length, vias: doc.vias.length,
                shapes: doc.boardShapes.length, pasting: isPcbPasteActive(window.bootstrap.pcbApp) });
        });
        const boardBefore = await board();
        await page.keyboard.press('Shift+ArrowLeft');
        await page.keyboard.press('Shift+ArrowLeft');
        await page.keyboard.press('Control+c');
        await page.keyboard.press('End');
        await page.keyboard.press('Control+v');
        assert.equal((await editState(page)).shown, 'ABCBC', 'Ctrl+C / Ctrl+V copy and paste the selected characters');
        await page.keyboard.press('Shift+Home');
        await page.keyboard.press('Control+x');
        assert.equal((await editState(page)).shown, '', 'Ctrl+X cuts from the text');
        await page.keyboard.press('Control+v');
        assert.equal((await editState(page)).shown, 'ABCBC');
        assert.equal(await board(), boardBefore, 'nothing is cut from or pasted onto the board');
        assert.equal((await editState(page)).editing, true);
    },
}, {
    name: 'text-edit-ctrl-z-undoes-typing-not-history',
    async run(page, url) {
        await startEditing(page, url);
        const depth = await undoDepth(page);
        await page.keyboard.type('XY');
        await page.keyboard.press('Control+z');
        const state = await editState(page);
        assert.equal(state.editing, true, 'Ctrl+Z while typing keeps the edit');
        assert.notEqual(state.shown, 'ABCXY', 'Ctrl+Z undoes typing');
        assert.ok(state.shown.startsWith('ABC'), 'and only the typing');
        assert.equal(await undoDepth(page), depth, 'it does not step the editor history');
        assert.equal(await page.evaluate(() => window.bootstrap.pcbApp.pcbDocument.texts.has('probe')), true,
            'the text is not un-added');
        await page.keyboard.press('Escape');
        await page.keyboard.press('End');
    },
}, {
    name: 'text-edit-autoreplace-can-be-undone',
    async run(page, url) {
        await startEditing(page, url);
        await page.keyboard.type(' (c)');
        assert.equal((await editState(page)).shown, 'ABC \u00A9', '(c) becomes the copyright sign');
        await page.keyboard.press('Control+z');
        assert.equal((await editState(page)).shown, 'ABC (c)', 'Ctrl+Z right after restores the literal (c)');
    },
}, {
    name: 'text-edit-properties-change-keeps-the-typing',
    async run(page, url) {
        await startEditing(page, url);
        await page.keyboard.type('XY');
        const size = page.locator('#pcbPropTextSize');
        await size.fill('4');
        await size.press('Tab');
        await page.waitForFunction(() => window.bootstrap.pcbApp.pcbDocument.texts.get('probe').size === 4);
        const state = await editState(page);
        assert.equal(state.editing, true, 'a Properties change keeps the edit');
        assert.equal(state.shown, 'ABCXY', 'the typed text stays on screen after a Properties change');
        assert.equal(state.authored, 'ABC');
        await page.keyboard.type('Z');
        assert.equal((await editState(page)).shown, 'ABCXYZ', 'typing resumes in the text');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => window.bootstrap.pcbApp.pcbDocument.texts.get('probe').content === 'ABCXYZ');
        assert.equal(await page.evaluate(() => window.bootstrap.pcbApp.pcbDocument.texts.get('probe').size), 4);
    },
}, {
    name: 'text-edit-leaving-commits-the-typing',
    async run(page, url) {
        await startEditing(page, url);
        const depth = await undoDepth(page);
        await page.keyboard.type('XY');
        await page.locator('.mode-tab[data-mode="schematic"]').click();
        await page.waitForFunction(async () => !(await import('/src/pcb/modules/pcb-editor-api.js')).isEditorActive(window.bootstrap.pcbApp));
        let state = await editState(page);
        assert.equal(state.editing, false, 'switching to the schematic ends the edit');
        assert.equal(state.authored, 'ABCXY', 'and keeps what was typed');
        assert.equal(await undoDepth(page), depth + 1, 'as one undo step');
        await page.keyboard.type('q');
        assert.equal((await editState(page)).authored, 'ABCXY', 'typing in the schematic does not reach the PCB text');

        // Going to another ribbon tab (to pick a tool) also commits.
        await page.locator('.mode-tab[data-mode="pcb"]').click();
        await page.waitForFunction(async () => (await import('/src/pcb/modules/pcb-editor-api.js')).isEditorActive(window.bootstrap.pcbApp));
        const centre = await textPoint(page, 'centre');
        const at = await screenPoint(page, 'pcb', centre.x, centre.y);
        await page.mouse.dblclick(at.x, at.y);
        await page.waitForFunction(async () => !!(await import('/src/pcb/modules/text-inline-edit.js'))
            .activeTextInlineEdit(window.bootstrap.pcbApp));
        await page.keyboard.press('End');
        await page.keyboard.type('Z');
        await page.locator('#ribbonPCB .ribbon-tab[data-tab="pcb-home"]').click();
        state = await editState(page);
        assert.equal(state.editing, false, 'going to another ribbon tab ends the edit');
        assert.equal(state.authored, 'ABCXYZ', 'and keeps what was typed');
    },
}, {
    name: 'text-edit-escape-cancels-and-enter-commits-one-step',
    async run(page, url) {
        await startEditing(page, url);
        const depth = await undoDepth(page);
        await page.keyboard.type('XY');
        await page.keyboard.press('Escape');
        let state = await editState(page);
        assert.equal(state.editing, false);
        assert.equal(state.authored, 'ABC', 'Escape discards the typing');
        assert.equal(state.shown, 'ABC');
        assert.equal(await undoDepth(page), depth, 'and records nothing');

        const centre = await textPoint(page, 'centre');
        const at = await screenPoint(page, 'pcb', centre.x, centre.y);
        await page.mouse.dblclick(at.x, at.y);
        await page.waitForFunction(async () => !!(await import('/src/pcb/modules/text-inline-edit.js'))
            .activeTextInlineEdit(window.bootstrap.pcbApp));
        await page.keyboard.press('End');
        await page.keyboard.type('Z');
        await page.keyboard.press('Enter');
        state = await editState(page);
        assert.equal(state.editing, false);
        assert.equal(state.authored, 'ABCZ');
        assert.equal(await undoDepth(page), depth + 1, 'Enter records one undo step');
        await page.keyboard.press('Control+z');
        await page.waitForFunction(() => window.bootstrap.pcbApp.pcbDocument.texts.get('probe').content === 'ABC');
        await page.keyboard.press('Control+y');
        await page.waitForFunction(() => window.bootstrap.pcbApp.pcbDocument.texts.get('probe').content === 'ABCZ');
    },
}];
