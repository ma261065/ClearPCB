import assert from 'node:assert/strict';
import { openPcb } from './helpers/editor-helpers.mjs';

export const scenarios = [{
    name: 'drawing-tools-use-unlocked-layer-defaults-and-disable-only-when-all-locked',
    async run(page, url) {
        await openPcb(page, url);
        const choose = async selector => {
            await page.locator('[data-tab="pcb-home"]').click();
            await page.locator(selector).click();
        };
        const configure = (tool, lockActive = false, lockAll = false) => page.evaluate(async ({ tool, lockActive, lockAll }) => {
            const app = window.bootstrap.pcbApp;
            const { PCB_LAYERS, PCB_COPPER_FILLS } = await import('/src/pcb/modules/layers.js');
            const { pcbToolLayers } = await import('/src/pcb/modules/pcb-tools.js');
            for (const layer of [...PCB_LAYERS, ...PCB_COPPER_FILLS]) { layer.locked = false; layer.visible = true; }
            const layers = pcbToolLayers(tool).filter(id => id !== 'both');
            app.activeLayer = layers.at(-1);
            if (lockActive) PCB_LAYERS.find(layer => layer.id === app.activeLayer).locked = true;
            if (lockAll) for (const id of layers) PCB_LAYERS.find(layer => layer.id === id).locked = true;
            app.refreshPcbRibbon();
            return { active: app.activeLayer, first: layers[0] };
        }, { tool, lockActive, lockAll });
        for (const [tool, button, field] of [
            ['text', '#pcbToolText', '#pcbPropTextToolLayer'],
            ['track', '#pcbToolTrack', '#pcbPropTrackToolLayer'],
            ['fill', '#pcbToolFill', '#pcbPropFillToolLayer'],
            ['pad', '#pcbToolPad', '#pcbPropPadLayers'],
            ['circle', '#pcbToolShapes', '#pcbToolShapeLayer'],
        ]) {
            const initial = await configure(tool);
            assert.equal(await page.locator(button).isDisabled(), false, `${tool}: unlocked choices enable Home`);
            await choose(button);
            assert.equal(await page.locator(field).inputValue(), initial.active, `${tool}: active layer is the default`);
            assert.equal(await page.locator('#pcbToolUnblockLayer').count(), 0, 'No Unlock/Show group is rendered');
            const fallback = await configure(tool, true);
            assert.equal(await page.locator(button).isDisabled(), false, `${tool}: one locked layer does not disable Home`);
            await choose(button);
            assert.equal(await page.locator(field).inputValue(), fallback.first, `${tool}: first unlocked layer is used`);
            const option = page.locator(`${field} option[value="${fallback.active}"]`);
            assert.equal(await option.isDisabled(), true);
            assert.match(await option.textContent(), /🔒\uFE0E/, 'Locked layer includes a monochrome lock');
            const color = await option.evaluate(element => getComputedStyle(element).color);
            const muted = await page.evaluate(() => {
                const probe = document.createElement('span');
                probe.style.color = 'var(--text-muted)';
                document.body.appendChild(probe);
                const color = getComputedStyle(probe).color;
                probe.remove();
                return color;
            });
            assert.equal(color, muted, 'Locked dropdown option uses the grey disabled text color');
            await configure(tool, false, true);
            assert.equal(await page.locator(button).isDisabled(), true, `${tool}: all supported layers disable Home`);
            await page.locator('[data-tab="pcb-home"]').click();
            const box = await page.locator(button).boundingBox();
            assert.ok(box);
            const before = await page.evaluate(() => window.bootstrap.pcbApp.currentTool);
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
            const message = await page.locator('#pcbLockedLayerBubble .pcb-locked-bubble-text').textContent();
            assert.match(message, /layers locked$/, `${tool}: disabled Home click explains all locks`);
            for (const name of tool === 'text'
                ? ['Top Silk', 'Bottom Silk', 'Top Copper', 'Bottom Copper', 'Top Document', 'Bottom Document']
                : tool === 'circle' ? ['Top Copper', 'Bottom Copper', 'Top Silk', 'Bottom Silk', 'Top Document', 'Bottom Document', 'Hole']
                    : ['Top Copper', 'Bottom Copper']) {
                assert.ok(message.includes(name), `${tool}: popup includes ${name}`);
            }
            assert.equal(await page.evaluate(() => window.bootstrap.pcbApp.currentTool), before,
                'Disabled button feedback does not activate the tool');
            assert.equal(await page.locator('#pcbLockedLayerBubble button').count(), 0);
            if (tool === 'circle') {
                await page.locator('#pcbToolShapesArrow').click();
                const item = page.locator('#pcbToolShapesMenu [data-shape="rect"]');
                assert.equal(await item.isDisabled(), true);
                const menuBox = await item.boundingBox();
                await page.mouse.click(menuBox.x + menuBox.width / 2, menuBox.y + menuBox.height / 2);
                assert.match(await page.locator('#pcbLockedLayerBubble .pcb-locked-bubble-text').textContent(), /Hole layers locked$/);
                await page.keyboard.press('Escape');
            }
        }
        await configure('fill');
        await page.evaluate(() => { window.bootstrap.pcbApp.activeLayer = 'top-copper'; });
        await choose('#pcbToolFill');
        await page.evaluate(async () => {
            const app = window.bootstrap.pcbApp;
            const { setPcbCopperFillLocked } = await import('/src/pcb/modules/layers.js');
            setPcbCopperFillLocked(app, 'top-copper', true);
        });
        assert.equal(await page.locator('#pcbPropFillToolLayer option[value="top-copper"]').isDisabled(), true,
            'Copper Fill row locks update the open layer dropdown');
        for (const theme of ['dark', 'light']) {
            const style = await page.locator('#pcbPropFillToolLayer').evaluate(async (select, theme) => {
                (await import('/src/shared/ui/theme.js')).applyTheme(theme);
                select.blur();
                const row = select.closest('.prop-row');
                const label = row.querySelector('label');
                const probe = document.createElement('span');
                probe.style.color = 'var(--text-secondary)';
                document.body.appendChild(probe);
                const expectedLabelColor = getComputedStyle(probe).color;
                probe.remove();
                return { outlineWidth: getComputedStyle(select).outlineWidth,
                    labelColor: getComputedStyle(label).color, expectedLabelColor };
            }, theme);
            assert.equal(style.outlineWidth, '0px', `${theme}: locked layer has no warning outline`);
            assert.equal(style.labelColor, style.expectedLabelColor, `${theme}: layer label has no warning highlight`);
        }
        await choose('#pcbToolFill');
        assert.equal(await page.locator('#pcbPropFillToolLayer').inputValue(), 'bottom-copper');
        await page.evaluate(async () => {
            const { setPcbCopperFillLocked } = await import('/src/pcb/modules/layers.js');
            setPcbCopperFillLocked(window.bootstrap.pcbApp, 'bottom-copper', true);
        });
        assert.equal(await page.locator('#pcbToolFill').isDisabled(), true,
            'All pour rows locked disable Fill even if copper layers are unlocked');
        await page.locator('[data-tab="pcb-home"]').click();
        const fillBox = await page.locator('#pcbToolFill').boundingBox();
        await page.mouse.click(fillBox.x + fillBox.width / 2, fillBox.y + fillBox.height / 2);
        assert.equal(await page.locator('#pcbLockedLayerBubble .pcb-locked-bubble-text').textContent(),
            'Top Copper Fill, Bottom Copper Fill layers locked', 'Popup distinguishes pour locks from unlocked copper layers');
        assert.equal(await page.locator('#pcbToolTrack').isDisabled(), false, 'Pour locks do not disable routing');
        assert.equal(await page.locator('.pcb-tool-blocked-badge').count(), 0);
        assert.equal(await page.locator('.pcb-locked-bubble-action').count(), 0);
        for (const [tool, layer, label] of [['#pcbToolVia', 'vias', 'Via'], ['#pcbToolHole', 'hole', 'Hole']]) {
            await page.evaluate(async layer => {
                const { setPcbLayerLocked } = await import('/src/pcb/modules/layers.js');
                setPcbLayerLocked(window.bootstrap.pcbApp, layer, true);
            }, layer);
            const box = await page.locator(tool).boundingBox();
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
            assert.equal(await page.locator('#pcbLockedLayerBubble .pcb-locked-bubble-text').textContent(), `${label} layer locked`);
        }
    },
}, {
    name: 'layer-lock-popup-fits-its-text-and-stays-onscreen',
    async run(page, url) {
        await openPcb(page, url);
        const messages = [
            'Via layer locked',
            'Top Copper, Bottom Copper layers locked',
            'Top Copper, Bottom Copper, Top Silk, Bottom Silk, Top Document, Bottom Document, Hole layers locked',
        ];
        for (const width of [1400, 420]) {
            await page.setViewportSize({ width, height: 900 });
            const sizes = [];
            for (const message of messages) {
                for (const side of ['left', 'right']) {
                    await page.evaluate(async ({ message, side }) => {
                        const { showLayerBubble } = await import('/src/pcb/modules/layers.js');
                        showLayerBubble(window.bootstrap.pcbApp, { id: 'top-copper', reason: 'locked' },
                            { x: side === 'left' ? 16 : window.innerWidth - 16, y: 30 }, { message });
                    }, { message, side });
                    await page.waitForFunction(() => {
                        const bubble = document.getElementById('pcbLockedLayerBubble');
                        return !bubble.getAnimations().some(animation => animation.playState === 'running');
                    });
                    const bounds = await page.locator('#pcbLockedLayerBubble').evaluate(bubble => {
                        const text = bubble.querySelector('.pcb-locked-bubble-text');
                        const box = bubble.getBoundingClientRect(), textBox = text.getBoundingClientRect();
                        return { left: box.left, right: box.right, width: box.width, height: box.height,
                            textLeft: textBox.left, textRight: textBox.right, textBottom: textBox.bottom,
                            bottom: box.bottom, overflowing: text.scrollWidth > text.clientWidth + 1 };
                    });
                    assert.ok(bounds.left >= 7 && bounds.right <= width - 7, 'Popup stays inside both window edges');
                    assert.equal(bounds.overflowing, false, `Text does not overflow the popup border (${JSON.stringify(bounds)})`);
                    assert.ok(bounds.textLeft > bounds.left && bounds.textRight < bounds.right
                        && bounds.textBottom < bounds.bottom, 'The border encloses the entire message');
                    if (side === 'left') sizes.push(bounds);
                }
            }
            assert.ok(sizes[1].width > sizes[0].width, 'Popup grows for a longer message');
            if (width === 1400) {
                assert.ok(sizes[2].width > sizes[1].width, 'Full layer list grows rather than using a fixed width');
                assert.equal(sizes[2].height, sizes[0].height, 'Messages stay on one line when they fit');
            } else {
                assert.ok(sizes[2].height > sizes[0].height, 'Long messages wrap to fit a narrow window');
            }
        }
    },
}];
