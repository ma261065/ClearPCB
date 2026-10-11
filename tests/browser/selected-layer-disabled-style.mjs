import assert from 'node:assert/strict';
import { openPcb } from './helpers/editor-helpers.mjs';

export const scenarios = [{
    name: 'locked-selected-layer-values-are-grey-across-drawing-properties',
    async run(page, url) {
        await openPcb(page, url);
        for (const theme of ['dark', 'light']) {
            for (const [tool, selector, lockedLayer, nextLayer, fillLock] of [
                ['hole', '#pcbToolShapeLayer', 'hole', 'top-silk', false],
                ['rect', '#pcbToolShapeLayer', 'top-copper', 'bottom-copper', false],
                ['track', '#pcbPropTrackToolLayer', 'top-copper', 'bottom-copper', false],
                ['text', '#pcbPropTextToolLayer', 'top-silk', 'bottom-silk', false],
                ['pad', '#pcbPropPadLayers', 'top-copper', 'bottom-copper', false],
                ['pad-both', '#pcbPropPadLayers', 'top-copper', 'bottom-copper', false],
                ['fill', '#pcbPropFillToolLayer', 'top-copper', 'bottom-copper', false],
                ['fill', '#pcbPropFillToolLayer', 'top-copper', 'bottom-copper', true],
            ]) {
                await page.evaluate(async ({ tool, theme, lockedLayer }) => {
                    const { applyTheme } = await import('/src/shared/ui/theme.js');
                    const { PCB_LAYERS, PCB_COPPER_FILLS } = await import('/src/pcb/modules/layers.js');
                    const { selectPcbTool } = await import('/src/pcb/modules/tool-lifecycle.js');
                    const { setPcbSelection } = await import('/src/pcb/modules/selection-registry.js');
                    const app = window.bootstrap.pcbApp;
                    applyTheme(theme);
                    for (const layer of [...PCB_LAYERS, ...PCB_COPPER_FILLS]) { layer.locked = false; layer.visible = true; }
                    setPcbSelection(app, []);
                    app.activeLayer = lockedLayer;
                    selectPcbTool(app, tool === 'pad-both' ? 'pad' : tool);
                }, { tool, theme, lockedLayer });
                const control = page.locator(selector);
                if (tool === 'pad-both') await control.selectOption('both');
                await page.evaluate(async ({ lockedLayer, fillLock }) => {
                    const { setPcbLayerLocked, setPcbCopperFillLocked } = await import('/src/pcb/modules/layers.js');
                    const app = window.bootstrap.pcbApp;
                    if (fillLock) setPcbCopperFillLocked(app, lockedLayer, true);
                    else setPcbLayerLocked(app, lockedLayer, true);
                }, { lockedLayer, fillLock });
                const value = await control.evaluate(select => {
                    const probe = document.createElement('span');
                    probe.style.color = 'var(--text-muted)';
                    document.body.appendChild(probe);
                    const grey = getComputedStyle(probe).color;
                    probe.remove();
                    return { disabled: select.disabled, value: select.value, optionDisabled: select.selectedOptions[0].disabled,
                        color: getComputedStyle(select).color, textColor: getComputedStyle(select).webkitTextFillColor, grey };
                });
                assert.equal(value.value, tool === 'pad-both' ? 'both' : lockedLayer, 'Current assignment is retained');
                assert.equal(value.optionDisabled, true, `${tool}: selected destination is disabled`);
                assert.equal(value.disabled, false, `${tool}: another layer can still be chosen`);
                assert.equal(value.color, value.grey, `${theme}/${tool}: selected locked value is grey`);
                assert.equal(value.textColor, value.grey);
                const available = await control.locator(`option[value="${nextLayer}"]`).evaluate(option => ({
                    disabled: option.disabled, color: getComputedStyle(option).color,
                    textColor: getComputedStyle(option).webkitTextFillColor,
                }));
                assert.equal(available.disabled, false);
                assert.notEqual(available.color, value.grey, 'Unlocked list choices retain their normal colour');
                assert.equal(available.textColor, available.color);
                await control.selectOption(nextLayer);
                assert.notEqual(await control.evaluate(select => getComputedStyle(select).color), value.grey,
                    'Choosing an unlocked layer clears the grey selected-value styling');
            }
        }
    },
}];
