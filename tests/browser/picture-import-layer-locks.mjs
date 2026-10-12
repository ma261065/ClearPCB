import assert from 'node:assert/strict';
import { openPcb } from './helpers/editor-helpers.mjs';

export const scenarios = [{
    name: 'picture-import-layers-show-grey-lock-markers',
    async run(page, url) {
        await openPcb(page, url);
        await page.evaluate(async () => {
            const { PCB_LAYERS } = await import('/src/pcb/modules/layers.js');
            const { showPictureImport } = await import('/src/pcb/modules/picture-import.js');
            for (const layer of PCB_LAYERS) { layer.locked = false; layer.visible = true; }
            PCB_LAYERS.find(layer => layer.id === 'top-silk').locked = true;
            PCB_LAYERS.find(layer => layer.id === 'bottom-copper').locked = true;
            PCB_LAYERS.find(layer => layer.id === 'bottom-silk').visible = false;
            showPictureImport(window.bootstrap.pcbApp);
        });
        const image = await page.evaluate(() => {
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 4;
            const context = canvas.getContext('2d');
            context.fillStyle = '#ffffff';
            context.fillRect(0, 0, 4, 4);
            return canvas.toDataURL().split(',')[1];
        });
        await page.locator('#pcb-picture-import input[name="file"]').setInputFiles({
            name: 'layer-colour-probe.png', mimeType: 'image/png', buffer: Buffer.from(image, 'base64'),
        });
        await page.waitForFunction(() => document.querySelector('#pcb-picture-import .picture-error')
            .textContent.includes('Choose an unlocked, visible layer.'));
        const select = page.locator('#pcb-picture-import select[name="layer"]');
        const locked = select.locator('option[value="bottom-copper"]');
        assert.equal(await locked.textContent(), 'Bottom Copper \u{1F512}\uFE0E');
        assert.equal(await locked.evaluate(option => option.disabled), true, 'Locked destination is disabled');
        const hidden = select.locator('option[value="bottom-silk"]');
        assert.equal(await hidden.evaluate(option => option.disabled), true, 'Hidden destinations remain unavailable');
        assert.equal(await hidden.textContent(), 'Bottom Silk', 'Hidden-only layers are not marked as locked');
        assert.equal(await select.locator('option[value="top-silk"]').evaluate(option => option.disabled), true);
        assert.equal(await select.inputValue(), 'top-silk', 'The existing import default is unchanged');
        for (const theme of ['dark', 'light']) {
            await page.evaluate(async theme => (await import('/src/shared/ui/theme.js')).applyTheme(theme), theme);
            const colors = await locked.evaluate(option => {
                const probe = document.createElement('span');
                probe.style.color = 'var(--text-muted)';
                document.body.appendChild(probe);
                const expected = getComputedStyle(probe).color;
                probe.remove();
                return { actual: getComputedStyle(option).color, expected };
            });
            assert.equal(colors.actual, colors.expected, `${theme}: locked option uses the grey disabled color`);
            const selected = await select.evaluate(control => {
                const option = control.selectedOptions[0];
                return { color: getComputedStyle(control).color, textColor: getComputedStyle(control).webkitTextFillColor,
                    enabled: !control.disabled, disabledOption: option.disabled };
            });
            assert.equal(selected.color, colors.expected, `${theme}: closed dropdown shows the locked selection in grey`);
            assert.equal(selected.textColor, colors.expected);
            assert.equal(selected.enabled, true, 'Dropdown stays usable to choose an unlocked layer');
            assert.equal(selected.disabledOption, true);
        }
        await select.selectOption('top-document');
        await page.waitForFunction(() => !document.querySelector('#pcb-picture-import .app-modal-ok').disabled);
        const available = await select.evaluate(control => ({
            color: getComputedStyle(control).color,
            optionColor: getComputedStyle(control.selectedOptions[0]).color,
            textColor: getComputedStyle(control.selectedOptions[0]).webkitTextFillColor,
        }));
        assert.equal(available.color, available.optionColor, 'Choosing an unlocked layer restores normal display colour');
        assert.equal(available.textColor, available.optionColor, 'Available list entries do not inherit grey selected text');
        await page.evaluate(async () => {
            const { setPcbLayerLocked } = await import('/src/pcb/modules/layers.js');
            setPcbLayerLocked(window.bootstrap.pcbApp, 'top-document', true);
        });
        assert.match(await select.locator('option[value="top-document"]').textContent(), /🔒/);
        assert.equal(await select.locator('option[value="top-document"]').evaluate(option => option.disabled), true,
            'Live layer locks update the image dialog');
        await page.evaluate(async () => {
            const { setPcbLayerLocked } = await import('/src/pcb/modules/layers.js');
            const app = window.bootstrap.pcbApp;
            setPcbLayerLocked(app, 'top-document', false);
            setPcbLayerLocked(app, 'bottom-silk', true);
            setPcbLayerLocked(app, 'bottom-silk', false);
        });
        assert.equal(await select.locator('option[value="bottom-silk"]').evaluate(option => option.disabled), true,
            'Unlocking a hidden image destination does not make it selectable');
        await page.evaluate(async () => {
            const { setPcbLayerVisible } = await import('/src/pcb/modules/layers.js');
            setPcbLayerVisible(window.bootstrap.pcbApp, 'bottom-silk', true);
        });
        assert.equal(await select.locator('option[value="bottom-silk"]').evaluate(option => option.disabled), false,
            'Showing a now-unlocked image destination makes it selectable');
        await page.locator('#pcb-picture-import [data-cancel]').click();
        assert.equal(await page.locator('#pcb-picture-import').count(), 0);
    },
}];
