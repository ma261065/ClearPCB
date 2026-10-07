import assert from 'node:assert/strict';
import { openPcb } from './helpers/editor-helpers.mjs';
import { propertyRank, PROPERTY_ORDER } from '../../src/shared/ui/property-order.js';
import { collectPropertyPanels } from './property-order-panels.js';

export const scenarios = [
    {
        name: 'properties-panels-share-one-control-order-and-labels',
        async run(page, url) {
            await openPcb(page, url);
            const panels = await page.evaluate(collectPropertyPanels);
            assert.ok(Object.keys(panels).length >= 35, 'every kind of panel was shown');
            const labels = new Map();
            for (const [panel, rows] of Object.entries(panels)) {
                const keys = rows.map(row => row.key);
                assert.ok(keys.length, `${panel} shows properties`);
                for (const [index, key] of keys.entries()) {
                    assert.ok(key && PROPERTY_ORDER.includes(key), `${panel} row ${index} has a ranked key (${key})`);
                    if (index) {
                        assert.ok(propertyRank(keys[index - 1]) <= propertyRank(key),
                            `${panel}: ${keys[index - 1]} must not come after ${key} (${keys.join(', ')})`);
                    }
                }
                for (const { key, label } of rows) {
                    // A track's line is its width; field text is named for its field (Reference, Value, Label).
                    if (key === 'text' || (key === 'lineWidth' && /track/.test(panel) && label === 'Width (mm)')) continue;
                    if (!labels.has(key)) labels.set(key, new Map());
                    labels.get(key).set(label, panel);
                }
            }
            for (const [key, variants] of labels) {
                assert.equal(variants.size, 1, `${key} has one label everywhere: ${[...variants].map(([label, panel]) => `"${label}" (${panel})`).join(', ')}`);
            }
            // Spot-check the rule that motivated the order: Net follows Layer wherever both exist.
            for (const panel of ['pcb track', 'pcb pad', 'pcb copper pour', 'pcb filled copper polygon', 'pcb copper image', 'pcb new track']) {
                const keys = panels[panel].map(row => row.key);
                assert.ok(keys.indexOf('layer') < keys.indexOf('net'), `${panel} shows Layer before Net`);
            }
        },
    },
];
