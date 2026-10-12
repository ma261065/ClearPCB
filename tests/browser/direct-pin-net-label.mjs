import assert from 'node:assert/strict';
import { openSchematic, viewCentre, waitForPage } from './helpers/editor-helpers.mjs';

export const scenarios = [{
    name: 'schematic-direct-pin-net-label-reaches-pcb-net-menus',
    async run(page, url) {
        await openSchematic(page, url);
        const pin = await page.evaluate(async centre => {
            const app = window.bootstrap.schematicApp;
            const { Component } = await import('/src/components/Component.js');
            const { BuiltInComponents } = await import('/src/components/BuiltInComponents.js');
            const { mountComponent } = await import('/src/schematic/modules/schematic-view.js');
            const { Net } = await import('/src/shapes/net.js');
            const component = new Component(BuiltInComponents[0], { ...centre, reference: 'R1', rotation: 90, mirror: true });
            app.components.push(component);
            mountComponent(app, component);
            app.updateSelectableItems();
            const point = component.getPinPosition('1');
            app.addShape(new Net({ ...point, net: 'Gnd', style: 'gnd' }));
            return { componentId: component.id, pinNumber: '1' };
        }, await viewCentre(page));
        const netlist = await page.evaluate(() => window.bootstrap.project.getNetlist());
        assert.deepEqual(netlist.find(net => net.net === 'Gnd')?.pins, [pin]);
        await waitForPage(page, () => document.querySelectorAll('.direct-pin-junction-dot').length === 1);
        assert.equal(await page.locator('.direct-pin-junction-dot').evaluate(dot =>
            getComputedStyle(dot).fill), 'rgb(0, 204, 102)');
        assert.equal(await page.evaluate(() => window.bootstrap.schematicApp.shapes.some(shape => shape.type === 'wire')), false,
            'A direct pin label must not require an invented wire');
        await page.locator('.mode-tab[data-mode="pcb"]').click();
        await waitForPage(page, () => window.bootstrap.pcbApp.netlist.some(net => net.net === 'Gnd'));
        const ok = page.locator('.app-modal-overlay button', { hasText: 'OK' });
        if (await ok.count()) await ok.first().click();
        await waitForPage(page, async () => {
            const { isEditorActive } = await import('/src/pcb/modules/pcb-editor-api.js');
            return isEditorActive(window.bootstrap.pcbApp);
        });
        const pcbNet = await page.evaluate(async () => {
            const { resolveCopperPads } = await import('/src/pcb/modules/copper-model.js');
            const app = window.bootstrap.pcbApp;
            return { names: app.netNames(), pad: resolveCopperPads(app).find(pad => pad.number === '1')?.net };
        });
        assert.ok(pcbNet.names.includes('Gnd'), 'PCB net source retains the label spelling');
        assert.equal(pcbNet.pad, 'Gnd', 'The footprint pad inherits the direct label net');
        for (const tool of ['#pcbToolTrack', '#pcbToolVia', '#pcbToolPad', '#pcbToolFill']) {
            await page.locator('#ribbonPCB [data-tab="pcb-home"]').click();
            await page.locator(tool).click();
            const menu = page.locator('#pcbPropsItems .prop-net-menu');
            await menu.waitFor();
            await menu.locator('summary').click();
            assert.equal(await menu.locator('button[data-net="Gnd"]').count(), 1,
                `${tool} offers Gnd from the synchronized schematic`);
        }
        await page.keyboard.press('Escape');
        await page.locator('.mode-tab[data-mode="schematic"]').click();
        await page.evaluate(() => window.bootstrap.schematicApp.history.undo());
        assert.equal(await page.locator('.direct-pin-junction-dot').count(), 0,
            'Undoing the direct NetLabel removes its derived connection dot');
        await page.locator('.mode-tab[data-mode="pcb"]').click();
        await waitForPage(page, () => !window.bootstrap.pcbApp.netNames().includes('Gnd'));
        await page.locator('.mode-tab[data-mode="schematic"]').click();
        await page.evaluate(() => window.bootstrap.schematicApp.history.redo());
        await waitForPage(page, () => document.querySelectorAll('.direct-pin-junction-dot').length === 1);
        await page.locator('.mode-tab[data-mode="pcb"]').click();
        await waitForPage(page, () => window.bootstrap.pcbApp.netNames().includes('Gnd'));
    },
}];
