import assert from 'node:assert/strict';
import { openPcb } from './helpers/editor-helpers.mjs';

export const scenarios = [{
    name: 'pcb-reference-edit-shows-symbol-picker',
    async run(page, url) {
        await openPcb(page, url);
        const componentId = await page.evaluate(async () => {
            const app = window.bootstrap.pcbApp;
            const { Component } = await import('/src/components/Component.js');
            const { BuiltInComponents } = await import('/src/components/BuiltInComponents.js');
            const { syncFromSchematic } = await import('/src/pcb/modules/schematic-sync.js');
            const { refBox, refCenterWorld } = await import('/src/pcb/modules/ref-text-geometry.js');
            const { tryEditReferenceAt } = await import('/src/pcb/modules/ref-text-selection.js');
            const definition = BuiltInComponents.find(item => item.footprintShapes?.length);
            const component = new Component(definition, { id: 'pcb-ref-symbol', reference: 'R8' });
            app.project.schematicDocument.components.push(component);
            syncFromSchematic(app);
            const placement = app.placements.get(component.id);
            const box = refBox(placement);
            const point = box && refCenterWorld(placement, box);
            if (!point || !tryEditReferenceAt(app, point)) throw new Error('Could not start PCB Reference edit');
            return component.id;
        });
        const picker = page.locator('#pcbPropRefInsert');
        assert.equal(await picker.count(), 1);
        await picker.selectOption('Ω');
        assert.equal(await page.evaluate(async () => {
            const { activeTextInlineEdit } = await import('/src/pcb/modules/text-inline-edit.js');
            return activeTextInlineEdit(window.bootstrap.pcbApp)?.input.value;
        }), 'RΩ8', 'picker inserts at the active PCB Reference caret');
        await page.keyboard.press('Enter');
        assert.equal(await page.evaluate(id =>
            window.bootstrap.project.getComponentInfo(id)?.reference, componentId), 'RΩ8');
    },
}];
