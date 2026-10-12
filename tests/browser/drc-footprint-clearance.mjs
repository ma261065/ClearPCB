import assert from 'node:assert/strict';
import { openPcb, waitForPage } from './helpers/editor-helpers.mjs';

export const scenarios = [{
    name: 'drc-same-footprint-exclusion-is-explicit-and-keeps-shorts',
    async run(page, url) {
        await openPcb(page, url);
        await page.evaluate(() => {
            const app = window.bootstrap.pcbApp;
            app.designSettings.update({ clearance: 0.3 });
            app.placements.set('drc-footprint', { x: 30, y: -20, reference: 'U1', side: 'top', padOffsets: [
                { padId: '1', number: '1', dx: 0, dy: 0, width: 1, height: 1, shape: 'rect', layer: 'top' },
                { padId: '2', number: '2', dx: 1.2, dy: 0, width: 1, height: 1, shape: 'rect', layer: 'top' },
            ] });
            app.netlist = [
                { net: 'A', pins: [{ componentId: 'drc-footprint', pinNumber: '1' }] },
                { net: 'B', pins: [{ componentId: 'drc-footprint', pinNumber: '2' }] },
            ];
            app.setActiveRibbonTab('pcb-design');
        });
        const waitForRule = async rule => waitForPage(page, async rule => {
            const { getDrcPresentation } = await import('/src/pcb/modules/drc-state.js');
            const drc = getDrcPresentation(window.bootstrap.pcbApp);
            return !drc.pending && (rule === null ? drc.violations.length === 0
                : drc.violations.length === 1 && drc.violations[0].rule === rule);
        }, rule);
        const panel = page.locator('#pcbDrcSlidePanel');
        const checkbox = panel.getByLabel('Exclude clearance between pads in the same footprint', { exact: true });
        const notice = page.locator('#pcbDrcExclusionNotice');
        assert.equal(await checkbox.isChecked(), false);
        await waitForRule('clearance');
        await page.locator('#pcbDrcStatus').click();
        await panel.locator('.drc-item').waitFor();
        assert.equal(await page.locator('#ribbonPCB #pcbExcludeSameFootprintPadClearance').count(), 0);
        const position = await checkbox.evaluate(input => {
            const panel = input.closest('#pcbDrcSlidePanel');
            return { optionsBottom: panel.querySelector('.drc-panel-options').getBoundingClientRect().bottom,
                resultsTop: panel.querySelector('.drc-slide-body').getBoundingClientRect().top };
        });
        assert.ok(position.optionsBottom <= position.resultsTop, 'Checkbox is above the scrolling results');
        assert.equal(await notice.isVisible(), false);
        assert.match(await panel.locator('.drc-item-text').textContent(), /Clearance 0.200 mm/);
        await panel.locator('.drc-item').click();
        await waitForPage(page, () => window.bootstrap.pcbApp.getLayerGroup('drc-overlay')?.childElementCount > 0);
        await checkbox.check();
        await waitForRule(null);
        assert.equal(await notice.textContent(), 'Same-footprint pad clearance excluded');
        assert.equal(await notice.isVisible(), true, 'Exclusion is disclosed even when DRC is clear');
        assert.equal(await panel.locator('.drc-item').count(), 0);
        assert.equal(await page.locator('#pcbDrcLabel').textContent(), 'No DRC errors');
        assert.equal(await page.evaluate(() => window.bootstrap.pcbApp.getLayerGroup('drc-overlay').childElementCount), 0);
        await page.evaluate(() => window.bootstrap.pcbApp.refreshPcbRibbon());
        assert.equal(await checkbox.isChecked(), true, 'Ribbon refresh retains the model preference');
        const persisted = await page.evaluate(async () => {
            const { normalizePcbSection } = await import('/src/core/project-field-aliases.js');
            const app = window.bootstrap.pcbApp;
            return {
                saved: normalizePcbSection(app.pcbDocument.serialize()).design.excludeSameFootprintPadClearance,
                defaults: JSON.parse(localStorage.getItem('clearpcb_pcb_design_params')).excludeSameFootprintPadClearance,
            };
        });
        assert.deepEqual(persisted, { saved: true, defaults: true });
        await checkbox.uncheck();
        await waitForRule('clearance');
        assert.equal(await notice.isVisible(), false);
        await checkbox.check();
        await waitForRule(null);
        await page.evaluate(async () => {
            const app = window.bootstrap.pcbApp;
            app.placements.get('drc-footprint').padOffsets[1].dx = 0.8;
            const { scheduleDrc } = await import('/src/pcb/modules/drc-state.js');
            scheduleDrc(app);
        });
        await waitForRule('short');
        assert.equal(await notice.isVisible(), true);
        assert.match(await panel.locator('.drc-item-text').textContent(), /Shorted nets: A and B/);
    },
}];
