import assert from 'node:assert/strict';
import { openPcb, saveAndReopen } from './helpers/editor-helpers.mjs';

async function openPanel(page) {
    await page.locator('#ribbonPCB [data-tab="pcb-home"]').click();
    await page.locator('#pcbPanelize').click();
    await page.locator('.panelize-overlay').waitFor();
}

async function applyPanel(page, columns) {
    await openPanel(page);
    const contextMenuPrevented = await page.locator('.panelize input[name="columns"]').evaluate(input => {
        const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
        return !input.dispatchEvent(event) && event.defaultPrevented;
    });
    assert.equal(contextMenuPrevented, true, 'right-clicking dialog controls suppresses the browser menu');
    if (columns !== undefined) await page.locator('.panelize input[name="columns"]').fill(String(columns));
    await page.locator('.panelize button[type="submit"]').click();
    await page.waitForFunction(() => !document.querySelector('.panelize-overlay'));
}

export const scenarios = [{
    name: 'panel-notes-update-in-place-and-remain-user-editable',
    async run(page, url) {
        await openPcb(page, url);
        await openPanel(page);
        assert.equal(await page.locator('.pcb-panel-note-preview').count(), 4,
            'generated notes are visible before Apply');
        assert.equal(await page.evaluate(() => window.bootstrap.pcbApp.texts.size), 0,
            'dialog preview does not author note objects');
        await page.waitForFunction(() => document.querySelector('.pcb-panel-preview image')?.getAttribute('href'));
        const imageId = await page.locator('.pcb-panel-preview image').getAttribute('id');
        const imageUrl = await page.locator('.pcb-panel-preview image').getAttribute('href');
        await page.locator('.panelize input[name="horizontalFiducials"]').check();
        assert.equal(await page.locator('.pcb-panel-preview image').getAttribute('id'), imageId);
        assert.equal(await page.locator('.pcb-panel-preview image').getAttribute('href'), imageUrl,
            'fiducial changes preserve the loaded source bitmap');
        await page.evaluate(async () => {
            const app = window.bootstrap.pcbApp;
            const { Track } = await import('/src/shapes/track.js');
            const { AddTrackCommand } = await import('/src/pcb/modules/track-commands.js');
            app.history.execute(new AddTrackCommand(app, new Track({
                points: [{ x: 10, y: -10 }, { x: 20, y: -10 }] })));
        });
        assert.equal(await page.locator('.pcb-panel-preview use').count(), 3,
            'board edits retain the uncommitted panel draft');
        assert.equal(await page.locator('.pcb-panel-note-preview').count(), 4);
        await page.waitForFunction(oldUrl =>
            document.querySelector('.pcb-panel-preview image')?.getAttribute('href') !== oldUrl, imageUrl);
        assert.equal(await page.locator('.panelize-overlay').count(), 1);
        await page.locator('.panelize input[name="columns"]').fill('3');
        await page.waitForFunction(() => [...document.querySelectorAll('.pcb-panel-note-preview')]
            .some(element => element.getAttribute('aria-label')?.includes('2 rows x 3 columns')));
        await page.locator('.panelize [data-cancel]').click();
        assert.equal(await page.locator('.pcb-panel-note-preview').count(), 0);
        assert.equal(await page.evaluate(() => window.bootstrap.pcbApp.texts.size), 0);
        await applyPanel(page);
        const ids = await page.evaluate(() => window.bootstrap.pcbApp.panelization.noteTexts.map(note => note.id));
        assert.equal(ids.length, 4);
        const beforeDialog = await page.evaluate(id => window.bootstrap.pcbApp.texts.get(id).content, ids[0]);
        await openPanel(page);
        await page.locator('.panelize input[name="columns"]').fill('3');
        await page.waitForFunction(() => [...document.querySelectorAll('.pcb-panel-note-preview')]
            .some(element => element.getAttribute('aria-label')?.includes('2 rows x 3 columns')));
        assert.equal(await page.evaluate(id => window.bootstrap.pcbApp.texts.get(id).content, ids[0]), beforeDialog);
        await page.locator('.panelize [data-cancel]').click();
        assert.equal(await page.locator('.pcb-panel-note-preview').count(), 0);
        assert.equal(await page.evaluate(id => window.bootstrap.pcbApp.texts.get(id).content, ids[0]), beforeDialog);
        await applyPanel(page, 3);
        assert.deepEqual(await page.evaluate(() =>
            window.bootstrap.pcbApp.panelization.noteTexts.map(note => note.id)), ids);
        assert.match(await page.evaluate(id => window.bootstrap.pcbApp.texts.get(id).content, ids[0]), /2 rows x 3 columns/);

        await page.evaluate(async id => {
            const app = window.bootstrap.pcbApp;
            const { startTextInlineEdit } = await import('/src/pcb/modules/text-inline-edit.js');
            const text = app.texts.get(id);
            startTextInlineEdit(app, text, { x: text.x, y: text.y });
        }, ids[0]);
        await page.waitForFunction(() => document.activeElement?.tagName === 'INPUT'
            && document.activeElement.style.left === '-1000px');
        await page.keyboard.press('Control+a');
        await page.keyboard.type('My panel note');
        await page.keyboard.press('Enter');
        await page.evaluate(id => window.bootstrap.pcbApp.selectText(window.bootstrap.pcbApp.texts.get(id)), ids[1]);
        await page.keyboard.press('Delete');
        await page.waitForFunction(id => !window.bootstrap.pcbApp.texts.has(id), ids[1]);
        await applyPanel(page, 2);
        assert.equal(await page.evaluate(id => window.bootstrap.pcbApp.texts.get(id).content, ids[0]), 'My panel note');
        assert.equal(await page.evaluate(id => window.bootstrap.pcbApp.texts.has(id), ids[1]), false);
        await saveAndReopen(page, 'pcb');
        assert.deepEqual(await page.evaluate(() =>
            window.bootstrap.pcbApp.panelization.noteTexts.map(note => note.id)), ids);
        await openPanel(page);
        await page.locator('.panelize [data-remove]').click();
        await page.waitForFunction(() => window.bootstrap.pcbApp.panelization === null);
        assert.deepEqual(await page.evaluate(ids => ids.filter(id => window.bootstrap.pcbApp.texts.has(id)), ids), [ids[0]],
            'edited note is independent and survives panel removal');
        await page.keyboard.press('Control+z');
        await page.waitForFunction(() => window.bootstrap.pcbApp.panelization !== null);
        assert.equal(await page.evaluate(id => window.bootstrap.pcbApp.texts.get(id).content, ids[0]), 'My panel note');
        assert.equal(await page.evaluate(id => window.bootstrap.pcbApp.texts.has(id), ids[1]), false);
        await page.keyboard.press('Control+y');
        await page.waitForFunction(() => window.bootstrap.pcbApp.panelization === null);
        assert.deepEqual(await page.evaluate(ids => ids.filter(id => window.bootstrap.pcbApp.texts.has(id)), ids), [ids[0]]);
    },
}];
