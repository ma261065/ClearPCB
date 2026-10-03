import assert from 'node:assert/strict';
import { propertyRank, PROPERTY_ORDER } from '../src/shared/ui/property-order.js';
import { collectPropertyPanels } from './property-order-panels.js';

/** Load the app, skip the welcome screen, open the PCB tab and accept the default board size. */
async function openPcb(page, url) {
    await page.goto(`${url}index.html`);
    await page.waitForFunction(() => window.bootstrap?.pcbApp && window.bootstrap?.schematicApp);
    if (await page.locator('#startupSplash').isVisible()) await page.locator('#startupContinue').click();
    await page.locator('.mode-tab[data-mode="pcb"]').click();
    const ok = page.locator('.app-modal-overlay button', { hasText: 'OK' });
    await ok.waitFor();
    await ok.click();
    await page.waitForFunction(() => window.bootstrap.pcbApp._boardOutlineDrawn);
}

export const scenarios = [
    {
        name: 'properties-panels-share-one-control-order',
        async run(page, url) {
            await openPcb(page, url);
            const panels = await page.evaluate(collectPropertyPanels);
            assert.ok(Object.keys(panels).length >= 35, 'every kind of panel was shown');
            for (const [panel, keys] of Object.entries(panels)) {
                assert.ok(keys.length, `${panel} shows properties`);
                for (const [index, key] of keys.entries()) {
                    assert.ok(key && PROPERTY_ORDER.includes(key), `${panel} row ${index} has a ranked key (${key})`);
                    if (index) {
                        assert.ok(propertyRank(keys[index - 1]) <= propertyRank(key),
                            `${panel}: ${keys[index - 1]} must not come after ${key} (${keys.join(', ')})`);
                    }
                }
            }
            // Spot-check the rule that motivated the order: Net follows Layer wherever both exist.
            for (const panel of ['pcb track', 'pcb pad', 'pcb copper pour', 'pcb filled copper polygon', 'pcb copper image', 'pcb new track']) {
                const keys = panels[panel];
                assert.ok(keys.indexOf('layer') < keys.indexOf('net'), `${panel} shows Layer before Net`);
            }
        },
    },
];
