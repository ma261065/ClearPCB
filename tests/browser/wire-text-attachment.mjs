import assert from 'node:assert/strict';
import { openSchematic, viewCentre, clickWorld, screenPoint } from './helpers/editor-helpers.mjs';

export const scenarios = [{
    name: 'text-tool-attaches-to-wire-without-net-symbol',
    async run(page, url) {
        await openSchematic(page, url);
        const centre = await viewCentre(page);
        await page.evaluate(async centre => {
            const { Wire } = await import('/src/shapes/wire.js');
            window.bootstrap.schematicApp.addShape(new Wire({ points: [
                { x: centre.x - 20, y: centre.y }, { x: centre.x + 20, y: centre.y },
            ] }));
        }, centre);
        await page.locator('#ribbonSchematic [data-tool="text"]').click();
        const at = await screenPoint(page, 'schematic', centre.x, centre.y);
        await page.mouse.move(at.x, at.y);
        await page.waitForFunction(() => document.querySelector('.wire-junction-highlight'));
        assert.equal(await page.locator('.wire-junction-highlight').getAttribute('fill'), '#ffff00');
        await clickWorld(page, 'schematic', centre.x, centre.y);
        await page.keyboard.type('Signal annotation');
        await page.keyboard.press('Enter');
        const state = await page.evaluate(() => {
            const app = window.bootstrap.schematicApp;
            const wire = app.shapes.find(shape => shape.type === 'wire');
            const text = app.shapes.find(shape => shape.type === 'text' && shape.parentComponent === wire);
            return { text: text?.text, attached: !!text?.attachment, net: wire.net, name: wire.wireLabel,
                textCount: app.shapes.filter(shape => shape.type === 'text').length };
        });
        assert.equal(state.attached, true);
        assert.equal(state.text, 'Signal annotation');
        assert.equal(state.textCount, 1);
    },
}, {
    name: 'existing-text-snaps-and-detaches-from-wire',
    async run(page, url) {
        await openSchematic(page, url);
        const centre = await viewCentre(page);
        await page.evaluate(async centre => {
            const { Wire } = await import('/src/shapes/wire.js');
            const { Text } = await import('/src/shapes/text.js');
            const app = window.bootstrap.schematicApp;
            app.addShape(new Wire({ points: [
                { x: centre.x - 20, y: centre.y }, { x: centre.x + 20, y: centre.y },
            ] }));
            const text = new Text({ x: centre.x, y: centre.y + 15, text: 'Attached note', fontSize: 3 });
            app.addShape(text);
            app.selection.select(text);
            app.renderShapes(true);
            app.updatePropertiesPanel(app.selection.getSelection());
        }, centre);
        assert.equal(await page.locator('#schematicStatusTip').textContent(),
            'Tip: Attach text to a shape or wire by hovering over it');
        const start = await screenPoint(page, 'schematic', centre.x + 4, centre.y + 14);
        const end = await screenPoint(page, 'schematic', centre.x + 4, centre.y);
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await page.mouse.move(end.x, end.y, { steps: 8 });
        await page.waitForFunction(() => document.querySelector('.wire-junction-highlight'));
        await page.mouse.up();
        const attached = () => page.evaluate(() => {
            const app = window.bootstrap.schematicApp;
            const text = app.shapes.find(shape => shape.type === 'text');
            return text.parentComponent === app.shapes.find(shape => shape.type === 'wire');
        });
        assert.equal(await attached(), true);
        assert.notEqual(await page.locator('#schematicStatusTip').textContent(),
            'Tip: Attach text to a shape or wire by hovering over it',
            'already attached text does not show the attachment tip');
        const followed = await page.evaluate(() => {
            const app = window.bootstrap.schematicApp;
            const wire = app.shapes.find(shape => shape.type === 'wire');
            const text = app.shapes.find(shape => shape.type === 'text');
            const before = { x: text.x, y: text.y };
            wire.move(5, 3);
            app.renderShapes(true);
            const delta = { x: text.x - before.x, y: text.y - before.y };
            wire.move(-5, -3);
            app.renderShapes(true);
            return delta;
        });
        assert.deepEqual(followed, { x: 5, y: 3 }, 'attached text follows its wire');
        await page.keyboard.press('Control+z');
        assert.equal(await attached(), false, 'one undo reverses movement and attachment');
        await page.keyboard.press('Control+y');
        assert.equal(await attached(), true);
        assert.ok((await page.locator('#propDetachText').getAttribute('title')).includes('Detach'));
        await page.locator('#propDetachText').click();
        assert.equal(await attached(), false);
        assert.equal(await page.locator('#schematicStatusTip').textContent(),
            'Tip: Attach text to a shape or wire by hovering over it',
            'detaching restores the relevant attachment tip');
        await page.keyboard.press('Control+z');
        assert.equal(await attached(), true, 'detaching is undoable');
        await page.keyboard.press('Control+y');
        assert.equal(await attached(), false);
        await page.keyboard.press('t');
        assert.equal(await page.evaluate(() => window.bootstrap.schematicApp.currentTool), 'text');
    },
}, {
    name: 'shape-attached-text-offers-detachment',
    async run(page, url) {
        await openSchematic(page, url);
        const centre = await viewCentre(page);
        const textPosition = { x: centre.x + 15, y: centre.y + 15 };
        await page.evaluate(async ({ centre, textPosition }) => {
            const { Circle } = await import('/src/shapes/circle.js');
            const { Text } = await import('/src/shapes/text.js');
            const { attachLabelToTarget } = await import('/src/schematic/modules/label-attachment.js');
            const app = window.bootstrap.schematicApp;
            const shape = new Circle({ ...centre, radius: 10 });
            const text = new Text({ ...textPosition, text: 'Shape annotation', fontSize: 3 });
            app.addShape(shape);
            attachLabelToTarget(text, shape);
            app.addShape(text);
            app.selection.select(text);
            app.renderShapes(true);
            app.updatePropertiesPanel(app.selection.getSelection());
        }, { centre, textPosition });
        assert.equal(await page.locator('#propDetachText').textContent(), 'Detach from shape');
        assert.notEqual(await page.locator('#schematicStatusTip').textContent(),
            'Tip: Attach text to a shape or wire by hovering over it');
        await page.evaluate(async textPosition => {
            const { Wire } = await import('/src/shapes/wire.js');
            const app = window.bootstrap.schematicApp;
            app.addShape(new Wire({ points: [
                { x: textPosition.x - 10, y: textPosition.y + 15 },
                { x: textPosition.x + 30, y: textPosition.y + 15 },
            ] }));
        }, textPosition);
        const start = await screenPoint(page, 'schematic', textPosition.x + 3, textPosition.y - 1);
        const end = await screenPoint(page, 'schematic', textPosition.x + 3, textPosition.y + 15);
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await page.mouse.move(end.x, end.y, { steps: 8 });
        assert.equal(await page.locator('.wire-junction-highlight').count(), 0,
            'already attached text does not offer another attachment target');
        assert.notEqual(await page.locator('#schematicStatusTip').textContent(),
            'Tip: Attach text to a shape or wire by hovering over it');
        await page.mouse.up();
        assert.equal(await page.evaluate(() => window.bootstrap.schematicApp.shapes
            .find(shape => shape.type === 'text').parentComponent?.type), 'circle',
        'dropping over another wire preserves the original shape owner');
        await page.keyboard.press('Control+z');
        const currentText = await page.evaluate(() => {
            const text = window.bootstrap.schematicApp.shapes.find(shape => shape.type === 'text');
            return { x: text.x, y: text.y };
        });
        await clickWorld(page, 'schematic', currentText.x + 3, currentText.y - 1, { button: 'right' });
        const detach = page.locator('.anchor-context-menu', { hasText: 'Detach from shape' });
        await detach.waitFor();
        assert.equal(await detach.getByText('Detach from wire', { exact: true }).count(), 0);
        await detach.getByText('Detach from shape', { exact: true }).click();
        assert.equal(await page.evaluate(() => window.bootstrap.schematicApp.shapes
            .find(shape => shape.type === 'text').parentComponent), null);
        assert.equal(await page.locator('#schematicStatusTip').textContent(),
            'Tip: Attach text to a shape or wire by hovering over it');
        await page.keyboard.press('Control+z');
        assert.equal(await page.evaluate(() => window.bootstrap.schematicApp.shapes
            .find(shape => shape.type === 'text').parentComponent?.type), 'circle');
        assert.equal(await page.locator('#propDetachText').textContent(), 'Detach from shape');
    },
}];
