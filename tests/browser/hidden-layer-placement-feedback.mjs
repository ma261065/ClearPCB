import assert from 'node:assert/strict';
import { openPcb } from './helpers/editor-helpers.mjs';

export const scenarios = [{
    name: 'drawing-on-hidden-layers-shows-cursor-feedback-without-placing',
    async run(page, url) {
        await openPcb(page, url);
        for (const [tool, hiddenLayer, fillRow, message] of [
            ['track', 'bottom-copper', false, 'Bottom Copper layer hidden'],
            ['text', 'top-silk', false, 'Top Silk layer hidden'],
            ['rect', 'hole', false, 'Hole layer hidden'],
            ['via', 'vias', false, 'Via layer hidden'],
            ['pad', 'top-copper', false, 'Top Copper layer hidden'],
            ['fill', 'top-copper', true, 'Top Copper Fill layer hidden'],
        ]) {
            const position = await page.evaluate(async ({ tool, hiddenLayer, fillRow }) => {
                const app = window.bootstrap.pcbApp;
                const { PCB_LAYERS, PCB_COPPER_FILLS } = await import('/src/pcb/modules/layers.js');
                const { selectPcbTool } = await import('/src/pcb/modules/tool-lifecycle.js');
                for (const layer of [...PCB_LAYERS, ...PCB_COPPER_FILLS]) {
                    layer.locked = false;
                    layer.visible = true;
                }
                (fillRow ? PCB_COPPER_FILLS : PCB_LAYERS).find(layer => layer.id === hiddenLayer).visible = false;
                app.activeLayer = hiddenLayer;
                selectPcbTool(app, tool);
                document.getElementById('pcbLockedLayerBubble')?.remove();
                const rect = app.viewport.svg.getBoundingClientRect();
                return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
            }, { tool, hiddenLayer, fillRow });
            const state = () => page.evaluate(async () => {
                const app = window.bootstrap.pcbApp;
                const { isPcbDrawing } = await import('/src/pcb/modules/pcb-interactions.js');
                return { tracks: app.tracks.length, vias: app.vias.length, pads: app.pads.length,
                    shapes: app.boardShapes.length, texts: app.texts.size, drawing: isPcbDrawing(app),
                    undo: app.history.undoStack.length, redo: app.history.redoStack.length };
            });
            const before = await state();
            await page.mouse.move(position.x, position.y);
            assert.equal(await page.locator('#pcbLockedLayerBubble').count(), 0,
                'Moving the cursor alone does not create a popup');
            await page.mouse.click(position.x, position.y);
            assert.deepEqual(await state(), before, `${tool}: refused placement leaves model, drawing and history untouched`);
            const bubble = page.locator('#pcbLockedLayerBubble');
            assert.equal(await bubble.isVisible(), true);
            assert.equal(await bubble.locator('.pcb-locked-bubble-text').textContent(), message);
            assert.equal(await bubble.locator('button').count(), 0);
            const anchor = await bubble.evaluate(element => ({ top: parseFloat(element.style.top), left: parseFloat(element.style.left) }));
            assert.ok(Math.abs(anchor.top - position.y) < 1, `${tool}: popup is at the clicked cursor position`);
            assert.ok(Math.abs(anchor.left - position.x) <= 11);
        }
        await page.waitForFunction(() => document.getElementById('pcbLockedLayerBubble').style.display === 'none',
            null, { timeout: 5000 });
    },
}];
