import assert from 'node:assert/strict';
import { openPcb } from './helpers/editor-helpers.mjs';

export const scenarios = [{
    name: 'drc-result-survives-ribbon-refresh',
    async run(page, url) {
        await openPcb(page, url);
        await page.locator('#ribbonPCB [data-tab="pcb-design"]').click();
        await page.waitForFunction(() => {
            const label = document.getElementById('pcbDrcLabel');
            return label && !label.textContent.includes('Checking');
        });
        const completed = await page.locator('#pcbDrcLabel').textContent();
        await page.evaluate(() => window.bootstrap.pcbApp.refreshPcbRibbon());
        assert.equal(await page.locator('#pcbDrcLabel').textContent(), completed,
            'refreshing unrelated ribbon controls must not restore the initial Checking label');
        await page.locator('#pcbDrcStatus').click();
        await page.waitForFunction(() => document.getElementById('pcbDrcStatus').getAttribute('aria-expanded') === 'true');
        await page.evaluate(() => window.bootstrap.pcbApp.refreshPcbRibbon());
        assert.equal(await page.locator('#pcbDrcStatus').getAttribute('aria-expanded'), 'true',
            'ribbon refresh preserves the panel owner accessibility state');
        await page.waitForFunction(() => !document.getElementById('pcbDrcLabel').textContent.includes('Checking'));
        const result = await page.locator('#pcbDrcLabel').textContent();
        for (let i = 0; i < 3; i++) await page.evaluate(() => window.bootstrap.pcbApp.refreshPcbRibbon());
        assert.equal(await page.locator('#pcbDrcLabel').textContent(), result);
    },
}];
