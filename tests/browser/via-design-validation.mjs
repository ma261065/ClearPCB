import assert from 'node:assert/strict';
import { openPcb } from './helpers/editor-helpers.mjs';

export const scenarios = [{
    name: 'via-design-fields-reject-drills-without-enough-copper-ring',
    async run(page, url) {
        await openPcb(page, url);
        await page.locator('#ribbonPCB [data-tab="pcb-design"]').click();
        await page.evaluate(() => {
            const app = window.bootstrap.pcbApp;
            app.designSettings.update({ viaDiameter: 0.6, viaDrill: 0.3, units: 'mm' });
            app.refreshPcbRibbon();
        });
        const drill = page.locator('#pcbViaDrill'), diameter = page.locator('#pcbViaDiameter');
        await drill.fill('0.7');
        assert.match(await drill.evaluate(input => input.validationMessage), /at least 0.800 mm/);
        assert.equal(await page.evaluate(() => window.bootstrap.pcbApp.getRoutingParams().viaDrill), 0.3);
        await diameter.fill('0.3');
        assert.match(await diameter.evaluate(input => input.validationMessage), /at least 0.400 mm/);
        assert.equal(await page.evaluate(() => window.bootstrap.pcbApp.getRoutingParams().viaDiameter), 0.6);
        await diameter.fill('0.8');
        assert.equal(await diameter.evaluate(input => input.validationMessage), '');
        assert.equal(await diameter.inputValue(), '0.8', 'Valid typing is not interrupted by a ribbon refresh');
        await drill.fill('0.7');
        assert.equal(await drill.evaluate(input => input.validationMessage), '');
        assert.equal(await page.evaluate(() => window.bootstrap.pcbApp.getRoutingParams().viaDrill), 0.7);
        const generated = await page.evaluate(async () => {
            const { tracksFromAutorouterResult } = await import('/src/pcb/modules/autorouter-adapter.js');
            const { runDRC } = await import('/src/pcb/modules/drc.js');
            const rules = window.bootstrap.pcbApp.getRoutingParams();
            const result = tracksFromAutorouterResult({ tracks: [], vias: [{ x: 5, y: -5, net: 'N' }] }, rules);
            return { diameter: result.vias[0].diameter, drill: result.vias[0].drill,
                violations: runDRC({ placements: new Map(), tracks: [], vias: result.vias,
                    boardShapes: [], texts: new Map() }, rules).violations };
        });
        assert.deepEqual(generated, { diameter: 0.8, drill: 0.7, violations: [] });
        await page.locator('#pcbRouteUnits').selectOption('inch');
        await drill.fill(String(0.75 / 25.4));
        assert.match(await drill.evaluate(input => input.validationMessage), /at least 0.850 mm/);
        assert.equal(await page.evaluate(() => window.bootstrap.pcbApp.getRoutingParams().viaDrill), 0.7);
        await drill.fill(String(0.7 / 25.4));
        assert.equal(await drill.evaluate(input => input.validity.customError), false,
            'Exact unit conversion clears the Via dimension validation error');
    },
}];
