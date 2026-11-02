import assert from 'node:assert/strict';
import { chooseSchematicTool, openSchematic } from './helpers/editor-helpers.mjs';

export const scenarios = [{
    name: 'component-picker-local-mode-excludes-online-results',
    async run(page, url) {
        await openSchematic(page, url);
        await chooseSchematicTool(page, 'component');
        const online = await page.evaluate(async () => {
            const picker = window.bootstrap.schematicApp.componentPicker;
            picker.library.addDefinition({
                name: 'Browser EasyEDA Online Only',
                category: 'Browser EasyEDA Category',
                symbol: { pins: [], graphics: [] },
            }, 'LCSC');
            picker.library.addDefinition({
                name: 'Browser KiCad Online Only',
                category: 'Browser KiCad Category',
                symbol: { pins: [], graphics: [] },
            }, 'KiCad');
            picker.lcscResults = [{
                mpn: 'ONLINE-EASYEDA',
                lcscPartNumber: 'C999999',
                stock: 1,
                price: 0.1,
            }];
            picker.kicadResults = [{
                name: 'ONLINE-KICAD',
                library: 'Browser',
            }];
            const { populateLCSCResults } = await import('/src/components/picker/results-list.js');
            populateLCSCResults(picker);
            return {
                headings: picker.body.querySelectorAll('.cp-results-header').length,
                rows: picker.listEl.querySelectorAll('.cp-lcsc-item, .cp-kicad-item').length,
            };
        });
        assert.deepEqual(online, { headings: 2, rows: 2 }, 'online mode shows both online result groups');

        await page.locator('.cp-mode-btn[data-mode="local"]').click();
        const local = await page.evaluate(() => {
            const picker = window.bootstrap.schematicApp.componentPicker;
            return {
                headings: picker.body.querySelectorAll('.cp-results-header-row').length,
                onlineRows: picker.listEl.querySelectorAll('.cp-lcsc-item, .cp-kicad-item').length,
                onlineDefinitions: [...picker.componentItems.values()]
                    .filter(definition => ['LCSC', 'KiCad', 'EasyEDA'].includes(definition._source))
                    .map(definition => definition.name),
                onlineCategories: [...picker.categorySelect.options]
                    .filter(option => option.value.startsWith('Browser '))
                    .map(option => option.value),
            };
        });
        assert.deepEqual(local, {
            headings: 0,
            onlineRows: 0,
            onlineDefinitions: [],
            onlineCategories: [],
        }, 'Local mode contains only local headings, rows, definitions and categories');
    },
}];
