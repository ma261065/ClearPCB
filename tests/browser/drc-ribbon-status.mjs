import assert from 'node:assert/strict';
import { openPcb, waitForPage } from './helpers/editor-helpers.mjs';

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
}, {
    name: 'drc-status-button-keeps-fixed-width',
    async run(page, url) {
        await openPcb(page, url);
        await page.locator('#ribbonPCB [data-tab="pcb-design"]').click();
        await waitForPage(page, async () => {
            const { getDrcPresentation } = await import('/src/pcb/modules/drc-state.js');
            return !getDrcPresentation(window.bootstrap.pcbApp).pending;
        });
        const measurements = await page.evaluate(async () => {
            await document.fonts.ready;
            const { getDrcPresentation } = await import('/src/pcb/modules/drc-state.js');
            const drc = getDrcPresentation(window.bootstrap.pcbApp);
            const button = document.getElementById('pcbDrcStatus');
            const label = document.getElementById('pcbDrcLabel');
            const icon = document.getElementById('pcbDrcIcon');
            const measure = () => {
                const rect = button.getBoundingClientRect();
                return { width: rect.width, height: rect.height, label: label.textContent,
                    iconWidth: icon.getBoundingClientRect().width,
                    fits: button.scrollWidth <= button.clientWidth,
                    labelClipped: label.scrollWidth > label.clientWidth };
            };
            const measurements = [];
            for (const state of [
                { pending: false, errors: 0, warnings: 0 },
                { pending: true, errors: 0, warnings: 0 },
                { pending: false, errors: 1, warnings: 0 },
                { pending: false, errors: 0, warnings: 1 },
                { pending: false, errors: 999999, warnings: 999999 },
                { pending: true, errors: 0, warnings: 0, error: new Error('Test failure') },
            ]) {
                drc.error = state.error || null;
                drc.updateStatus({ ok: !state.errors && !state.warnings, violations: [],
                    counts: { errors: state.errors, warnings: state.warnings } }, state.pending);
                measurements.push(measure());
            }
            drc.error = null;
            drc.updateStatus({ ok: true, violations: [], counts: { errors: 0, warnings: 0 } });
            window.bootstrap.pcbApp.refreshPcbRibbon();
            measurements.push(measure());
            return measurements;
        });
        assert.deepEqual(measurements.map(item => item.label), [
            'No DRC errors', 'Checking…', '1 error', '1 warning',
            '999999 errors, 999999 warnings', 'DRC check failed', 'No DRC errors',
        ]);
        for (const item of measurements) {
            assert.equal(item.width, 160, `Fixed rendered width for ${item.label}`);
            assert.equal(item.height, measurements[0].height, `Stable height for ${item.label}`);
            assert.equal(item.iconWidth, 16, `Status icon does not shrink for ${item.label}`);
            assert.ok(item.fits, `Status stays inside button for ${item.label}`);
        }
        assert.equal(measurements[0].labelClipped, false, 'Clear-state label fits in full');
        assert.equal(measurements[1].labelClipped, false, 'Checking label fits in full');
        assert.equal(measurements[4].labelClipped, true, 'Long counts ellipsize inside the fixed width');
        assert.equal(measurements[5].labelClipped, false, 'Failure label fits in full');
    },
}];
