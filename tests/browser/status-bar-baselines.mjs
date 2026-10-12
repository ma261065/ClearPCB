import assert from 'node:assert/strict';
import { openPcb } from './helpers/editor-helpers.mjs';

export const scenarios = [{
    name: 'status-bar-labels-and-values-share-baselines-in-both-editors',
    async run(page, url) {
        await openPcb(page, url);
        for (const editor of ['pcb', 'schematic']) {
            await page.locator(`.mode-tab[data-mode="${editor}"]`).click();
            const bar = page.locator(editor === 'pcb' ? '#pcbStatusBar' : '#schematicStatusBar');
            await bar.waitFor();
            for (const theme of ['dark', 'light']) {
                await page.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), theme);
                for (const showTip of [false, true]) {
                    const measured = await bar.evaluate(async (bar, showTip) => {
                        await document.fonts.ready;
                        const tip = bar.querySelector('.pcb-status-tip');
                        tip.textContent = 'Tip: SPACE to rotate';
                        tip.hidden = !showTip;
                        const spans = [...bar.querySelectorAll('.status-item .label, .status-item .value')]
                            .filter(span => !span.hidden);
                        const probes = spans.map(span => {
                            const marker = document.createElement('span');
                            marker.style.cssText = 'display:inline-block;width:0;height:0;padding:0;margin:0;vertical-align:baseline';
                            span.appendChild(marker);
                            return { span, marker };
                        });
                        const rect = bar.getBoundingClientRect();
                        const values = probes.map(({ span, marker }) => ({
                            text: span.textContent, baseline: marker.getBoundingClientRect().bottom,
                            top: span.getBoundingClientRect().top, bottom: span.getBoundingClientRect().bottom,
                        }));
                        probes.forEach(({ marker }) => marker.remove());
                        tip.hidden = true;
                        return { height: rect.height, top: rect.top, bottom: rect.bottom, values };
                    }, showTip);
                    assert.equal(measured.height, 24, 'Status bar retains its existing height');
                    const baseline = measured.values[0].baseline;
                    for (const value of measured.values) {
                        assert.ok(Math.abs(value.baseline - baseline) < 0.1,
                            `${editor}/${theme}/${showTip}: "${value.text}" baseline ${value.baseline} differs from ${baseline}`);
                        assert.ok(value.top >= measured.top && value.bottom <= measured.bottom,
                            'Aligned text stays inside the status bar');
                    }
                }
            }
        }
    },
}];
