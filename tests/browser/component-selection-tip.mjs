import assert from 'node:assert/strict';
import { openSchematic, openPcb, viewCentre } from './helpers/editor-helpers.mjs';

const TIP = 'Tip: SPACE to rotate, X for horizontal flip, Y for vertical flip';
export const scenarios = [{
    name: 'component-selection-shortcut-tips-match-in-both-editors',
    async run(page, url) {
        await openSchematic(page, url);
        await page.evaluate(async centre => {
            const app = window.bootstrap.schematicApp;
            const { Component } = await import('/src/components/Component.js');
            const { BuiltInComponents } = await import('/src/components/BuiltInComponents.js');
            const { mountComponent } = await import('/src/schematic/modules/schematic-view.js');
            const component = new Component(BuiltInComponents[0], { ...centre });
            app.components.push(component);
            mountComponent(app, component);
            app.updateSelectableItems();
            app.selection.select(component);
            app.renderShapes(true);
        }, await viewCentre(page));
        assert.equal(await page.locator('#schematicStatusTip').textContent(), TIP);
        assert.equal(await page.locator('#schematicStatusTip').isVisible(), true);
        await page.evaluate(() => window.bootstrap.schematicApp.selection.clearSelection());
        assert.notEqual(await page.locator('#schematicStatusTip').textContent(), TIP);
        await openPcb(page, url);
        await page.evaluate(async () => {
            const app = window.bootstrap.pcbApp;
            const { setPcbSelection } = await import('/src/pcb/modules/selection-registry.js');
            app.placements.set('tip-probe', { x: 0, y: 0, pads: new Map(), elements: [],
                bounds: { x: 0, y: 0, width: 1, height: 1 } });
            setPcbSelection(app, [{ kind: 'component', object: 'tip-probe' }]);
            app.setPcbStatus();
        });
        assert.equal(await page.locator('#pcbStatusTip').textContent(), TIP);
        assert.equal(await page.locator('#pcbStatusTip').isVisible(), true);
        await page.evaluate(() => window.bootstrap.pcbApp.selectComponent(null));
        assert.notEqual(await page.locator('#pcbStatusTip').textContent(), TIP);
    },
}];
