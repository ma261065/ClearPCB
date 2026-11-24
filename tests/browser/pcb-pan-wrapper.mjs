import assert from 'node:assert/strict';
import { openPcb, viewportSettled } from './helpers/editor-helpers.mjs';

export const scenarios = [{
    name: 'PCB wrapper pan moves HTML without touching SVG and preserves input',
    async run(page, url) {
        await openPcb(page, url);
        const start = await page.evaluate(() => {
            const v = window.bootstrap.pcbApp.viewport;
            if (!v.panWrapper) throw new Error('PCB panning requires the wrapper');
            const rect = v.container.getBoundingClientRect();
            window.wrapperPanMutations = [];
            window.wrapperPanObserver = new MutationObserver(records => {
                window.wrapperPanMutations.push(...records.map(record => record.attributeName));
            });
            window.wrapperPanObserver.observe(v.svg, { subtree: true, attributes: true, childList: true });
            return { x: rect.x + rect.width * 0.5, y: rect.y + rect.height * 0.5,
                left: rect.left, top: rect.top, width: rect.width, height: rect.height,
                viewBox: v.svg.getAttribute('viewBox'), viewX: v.viewBox.x, scale: v.scale };
        });
        await page.mouse.move(start.x, start.y);
        await page.mouse.down({ button: 'right' });
        await page.evaluate(() => {
            window.wrapperPanObserver.takeRecords();
            window.wrapperPanMutations.length = 0;
        });
        await page.mouse.move(start.x + 120, start.y + 60, { steps: 10 });
        const during = await page.evaluate(() => {
            const v = window.bootstrap.pcbApp.viewport;
            v.invalidateLayoutCache();
            const rect = v._getCachedRect();
            return {
                wrapper: v.panWrapper.style.transform,
                viewBox: v.svg.getAttribute('viewBox'), content: v.contentLayer.getAttribute('transform'),
                viewX: v.viewBox.x, left: rect.left, top: rect.top,
                mutations: window.wrapperPanMutations,
            };
        });
        assert.match(during.wrapper, /translate3d\(120(?:\.\d+)?px, 60(?:\.\d+)?px, 0px\)/);
        assert.equal(during.viewBox, start.viewBox);
        assert.equal(during.content, null);
        assert.ok(Math.abs(during.viewX - (start.viewX - 120 / start.scale)) < 1e-8);
        assert.equal(during.left, start.left, 'Pointer reference stays fixed even after cache invalidation');
        assert.equal(during.top, start.top);
        assert.deepEqual(during.mutations, [], 'Pan does not mutate live SVG nodes');
        // Move into the area exposed on the left by the translated wrapper.
        await page.mouse.move(start.left + 5, start.y);
        const uncovered = await page.evaluate(() => window.bootstrap.pcbApp.viewport.viewBox.x);
        assert.ok(Math.abs(uncovered - (start.viewX - (start.left + 5 - start.x) / start.scale)) < 1e-8,
            'Panning continues over uncovered viewport edges');
        await page.mouse.up({ button: 'right' });
        await viewportSettled(page, 'pcb');
        const after = await page.evaluate(() => {
            window.wrapperPanObserver.disconnect();
            const v = window.bootstrap.pcbApp.viewport;
            return { transform: v.panWrapper.style.transform, viewBox: v.svg.getAttribute('viewBox'),
                panning: v.isPanning };
        });
        assert.equal(after.transform, 'translate3d(0px, 0px, 0px)');
        assert.notEqual(after.viewBox, start.viewBox);
        assert.equal(after.panning, false);

        const rebased = await page.evaluate(() => {
            const v = window.bootstrap.pcbApp.viewport;
            v.startPan(0, 0);
            v.updatePan(30, 20);
            const first = v.panWrapper.style.transform;
            v.startPan(30, 20);
            v.updatePan(30, 20);
            const restart = v.panWrapper.style.transform;
            v.zoomToLevel(v.zoomIndex + 1);
            const zoom = v.panWrapper.style.transform;
            v.updatePan(40, 30);
            v.endPan();
            return { first, restart, zoom, released: v.panWrapper.style.transform };
        });
        assert.equal(rebased.first, rebased.restart, 'Second pan button does not jump the wrapper');
        assert.equal(rebased.zoom, 'translate3d(0px, 0px, 0px)', 'Zoom rebases onto sharp SVG geometry');
        assert.equal(rebased.released, 'translate3d(0px, 0px, 0px)');
    },
}, {
    name: 'PCB wrapper pan retains grid and offscreen artwork without clipped edges',
    async run(page, url) {
        await openPcb(page, url);
        const area = await page.evaluate(() => {
            const v = window.bootstrap.pcbApp.viewport;
            const vb = v.viewBox;
            const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            rect.setAttribute('x', vb.x - vb.width * 0.1);
            rect.setAttribute('y', vb.y + vb.height * 0.3);
            rect.setAttribute('width', vb.width * 0.15);
            rect.setAttribute('height', vb.height * 0.4);
            rect.setAttribute('fill', '#ff0000');
            v.contentLayer.appendChild(rect);
            const bounds = v.container.getBoundingClientRect();
            return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
        });
        const clip = { x: area.x + 30, y: area.y + 30, width: area.width - 35, height: area.height - 35 };
        for (const fraction of [0.15, 0.8, -0.8]) {
            await page.evaluate(fraction => {
                const v = window.bootstrap.pcbApp.viewport;
                v.startPan(0, 0);
                v.updatePan(v.width * fraction, v.height * fraction);
            }, fraction);
            const during = await page.screenshot({ clip });
            await page.evaluate(() => window.bootstrap.pcbApp.viewport.endPan());
            await viewportSettled(page, 'pcb');
            const after = await page.screenshot({ clip });
            const difference = await page.evaluate(async ([before, after]) => {
                const images = await Promise.all([before, after].map(bytes =>
                    createImageBitmap(new Blob([Uint8Array.from(bytes)], { type: 'image/png' }))));
                const arrays = images.map(image => {
                    const canvas = new OffscreenCanvas(image.width, image.height);
                    const context = canvas.getContext('2d');
                    context.drawImage(image, 0, 0);
                    return context.getImageData(0, 0, image.width, image.height).data;
                });
                let changed = 0;
                for (let index = 0; index < arrays[0].length; index += 4) {
                    if ([0, 1, 2].some(channel =>
                        Math.abs(arrays[0][index + channel] - arrays[1][index + channel]) > 12)) changed++;
                }
                images.forEach(image => image.close());
                return changed / (arrays[0].length / 4);
            }, [[...during], [...after]]);
            assert.ok(difference < 0.01,
                `Artwork and grid must already be visible before release (${fraction}: ${difference})`);
        }
    },
}];
