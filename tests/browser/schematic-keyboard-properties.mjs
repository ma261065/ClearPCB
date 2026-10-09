import assert from 'node:assert/strict';
import { openSchematic, screenPoint as editorScreenPoint, viewCentre } from './helpers/editor-helpers.mjs';

const screenPoint = (page, x, y) => editorScreenPoint(page, 'schematic', x, y);

async function clickAt(page, x, y) {
    const point = await screenPoint(page, x, y);
    await page.mouse.move(point.x, point.y, { steps: 2 });
    await page.mouse.click(point.x, point.y);
}

export const scenarios = [
    {
        name: 'schematic-tool-switch-commits-inline-text',
        async run(page, url) {
            await openSchematic(page, url);
            const centre = await viewCentre(page);
            await page.locator('#ribbonSchematic [data-tool="text"]').click();
            await clickAt(page, centre.x, centre.y);
            await page.keyboard.type('ABC');

            await page.locator('#ribbonSchematic [data-tab="home"]').click();
            await page.locator('#ribbonSchematic [data-tool="rect"]').click();
            const committed = await page.evaluate(async () => {
                const app = window.bootstrap.schematicApp;
                const { getSchematicTextEdit } = await import('/src/schematic/modules/text-edit.js');
                const text = app.shapes.find(shape => shape.type === 'text');
                return {
                    active: !!getSchematicTextEdit(app),
                    value: text?.text,
                    undoCount: app.history.undoStack.length,
                    propertiesConnected: app.ui.propertiesPanel?.isConnected,
                };
            });
            assert.equal(committed.active, false, 'switching tools ends inline editing');
            assert.equal(committed.value, 'ABC', 'the edit is committed rather than discarded');
            assert.equal(committed.propertiesConnected, true, 'the Properties host remains mounted');
            await page.keyboard.press('Control+z');
            assert.equal(await page.evaluate(() =>
                window.bootstrap.schematicApp.shapes.find(shape => shape.type === 'text')?.text), '',
            'undo reverses the committed text edit');
            assert.equal(await page.evaluate(() => window.bootstrap.schematicApp.currentTool), 'rect',
                'undoing the text edit leaves the newly selected tool active');
            assert.ok(committed.undoCount >= 2, 'adding and editing the label each create history');
        },
    },
    {
        name: 'schematic-properties-enter-escape-and-canvas-keys',
        async run(page, url) {
            await openSchematic(page, url);
            const centre = await viewCentre(page);

            await page.locator('#ribbonSchematic [data-tool="rect"]').click();
            await clickAt(page, centre.x, centre.y);
            await clickAt(page, centre.x + 20, centre.y + 10);
            await page.keyboard.press('v');
            await clickAt(page, centre.x + 10, centre.y);

            const lineWidth = page.locator('#prop_lineWidth');
            const originalWidth = Number(await lineWidth.inputValue());
            const beforeUndo = await page.evaluate(() => window.bootstrap.schematicApp.history.undoStack.length);
            await lineWidth.fill('0.8');
            await page.waitForFunction(() => window.bootstrap.schematicApp.shapes[0].lineWidth === 0.8);
            await lineWidth.press('Escape');
            assert.equal(await page.evaluate(() => window.bootstrap.schematicApp.shapes[0].lineWidth),
                originalWidth, 'Properties Escape restores its live preview');
            assert.equal(await page.evaluate(() => window.bootstrap.schematicApp.selection.count), 1,
                'Properties Escape preserves selection');
            assert.equal(await lineWidth.evaluate(input => input === document.activeElement), true,
                'Properties Escape does not blur its control');
            assert.equal(await page.evaluate(() => window.bootstrap.schematicApp.history.undoStack.length),
                beforeUndo, 'cancelling a preview does not create an undo step');

            await page.locator('#canvasContainer').click({ position: { x: 10, y: 10 } });
            await page.keyboard.press('Escape');
            assert.equal(await page.evaluate(() => window.bootstrap.schematicApp.selection.count), 0,
                'canvas Escape still clears selection');

            await page.locator('#ribbonSchematic [data-tool="polygon"]').click();
            await clickAt(page, centre.x - 20, centre.y - 20);
            await clickAt(page, centre.x, centre.y - 20);
            await clickAt(page, centre.x, centre.y);
            const drawingBefore = await page.evaluate(async () => {
                const { isSchematicDrawingActive } = await import('/src/schematic/modules/drawing.js');
                return isSchematicDrawingActive(window.bootstrap.schematicApp);
            });
            assert.equal(drawingBefore, true, 'polygon is active before Properties Enter');
            const shapeCountBefore = await page.evaluate(() => window.bootstrap.schematicApp.shapes.length);
            const defaultWidth = page.locator('#prop_newShapeLineWidth');
            await defaultWidth.fill('0.8');
            await defaultWidth.press('Enter');
            assert.equal(await page.evaluate(async () => {
                const { isSchematicDrawingActive } = await import('/src/schematic/modules/drawing.js');
                return isSchematicDrawingActive(window.bootstrap.schematicApp);
            }), true, 'Properties Enter commits only the field and leaves the polygon active');
            assert.equal(await page.evaluate(() => window.bootstrap.schematicApp.shapes.length),
                shapeCountBefore, 'Properties Enter does not finish the polygon');

            await page.locator('#canvasContainer').click({ position: { x: 10, y: 10 } });
            await page.keyboard.press('Enter');
            assert.equal(await page.evaluate(async () => {
                const { isSchematicDrawingActive } = await import('/src/schematic/modules/drawing.js');
                return isSchematicDrawingActive(window.bootstrap.schematicApp);
            }), false, 'canvas Enter still finishes the polygon');
            assert.equal(await page.evaluate(() => window.bootstrap.schematicApp.shapes.length),
                shapeCountBefore + 1, 'canvas Enter adds the completed polygon');
            await page.keyboard.press('Escape');
            assert.equal(await page.evaluate(() => window.bootstrap.schematicApp.currentTool), 'select',
                'canvas Escape still leaves the drawing tool');
        },
    },
];
