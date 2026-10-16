import assert from 'node:assert/strict';
import { openPcb, viewportSettled } from './helpers/editor-helpers.mjs';

export const scenarios = [{
    name: 'PCB pan reuses copper clips while retaining board holes',
    async run(page, url) {
        await openPcb(page, url);
        await page.evaluate(async () => {
            const { PcbDocument } = await import('/src/core/PcbDocument.js');
            const { Track } = await import('/src/shapes/track.js');
            const { rectangleBoardOutline } = await import('/src/shared/pcb/board-outline.js');
            const model = new PcbDocument();
            model.setBoardOutline(rectangleBoardOutline(100, 80));
            model.boardShapes.push({ id: 'hole', kind: 'circle', layer: 'hole',
                x: 40, y: -40, radius: 3, filled: true });
            for (let i = 0; i < 600; i++) {
                const y = -5 - (i % 60);
                model.tracks.push(new Track({ net: i % 10 === 0 ? 'GND' : '', layer: i % 2 ? 'top-copper' : 'bottom-copper', width: 0.4,
                    points: [{ x: 5, y }, { x: 95, y }] }));
            }
            const project = window.bootstrap.project;
            const data = project.serialize();
            data.pcb = model.serializeSection();
            await project.load(data);
            const { syncFromSchematic } = await import('/src/pcb/modules/schematic-sync.js');
            syncFromSchematic(window.bootstrap.pcbApp);
            window.bootstrap.pcbApp.fitToContent();
        });
        await viewportSettled(page, 'pcb');
        const start = await page.evaluate(() => {
            const app = window.bootstrap.pcbApp;
            const svg = app.viewport.svg;
            const defs = svg.querySelector('[data-pcb-defs]');
            const paths = ['top', 'bottom'].map(side => defs.querySelector(`#pcb-copper-cut-${side} path`));
            if (paths.some(path => !path)) throw new Error('Expected copper hole clips');
            window.pcbPanProbe = { paths, mutations: 0 };
            window.pcbPanObserver = new MutationObserver(records => {
                window.pcbPanProbe.mutations += records.filter(record =>
                    record.target.closest('[id^="pcb-copper-cut-"]')
                    || [...record.addedNodes, ...record.removedNodes].some(node => node.id?.startsWith('pcb-copper-cut-'))).length;
            });
            window.pcbPanObserver.observe(defs, { subtree: true, attributes: true, childList: true });
            const rect = svg.getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, viewBox: svg.getAttribute('viewBox') };
        });
        await page.mouse.move(start.x, start.y);
        await page.mouse.down({ button: 'right' });
        await page.mouse.move(start.x + 160, start.y + 80, { steps: 30 });
        await viewportSettled(page, 'pcb');
        const during = await page.evaluate(() => {
            const v = window.bootstrap.pcbApp.viewport;
            return { viewBox: v.svg.getAttribute('viewBox'), transform: v.contentLayer.getAttribute('transform') };
        });
        assert.equal(during.viewBox, start.viewBox, 'Pan translates artwork without changing the SVG viewBox');
        assert.ok(during.transform, 'Artwork follows the pointer via a temporary translation');
        const beforeRelease = await page.screenshot();
        await page.mouse.up({ button: 'right' });
        await viewportSettled(page, 'pcb');
        const afterRelease = await page.screenshot();
        const pixels = await page.evaluate(async ([before, after]) => {
            const images = await Promise.all([before, after].map(async bytes =>
                createImageBitmap(new Blob([Uint8Array.from(bytes)], { type: 'image/png' }))));
            const arrays = images.map(image => {
                const canvas = new OffscreenCanvas(image.width, image.height);
                const ctx = canvas.getContext('2d');
                ctx.drawImage(image, 0, 0);
                return ctx.getImageData(0, 0, image.width, image.height).data;
            });
            let changed = 0;
            for (let i = 0; i < arrays[0].length; i += 4) {
                if ([0, 1, 2].some(c => Math.abs(arrays[0][i + c] - arrays[1][i + c]) > 8)) changed++;
            }
            images.forEach(image => image.close());
            return { changed, total: arrays[0].length / 4 };
        }, [[...beforeRelease], [...afterRelease]]);
        assert.ok(pixels.changed / pixels.total < 0.005,
            `Translated artwork matches settled rendering, including holes: ${JSON.stringify(pixels)}`);
        const result = await page.evaluate(() => {
            const svg = window.bootstrap.pcbApp.viewport.svg;
            const probe = window.pcbPanProbe;
            window.pcbPanObserver.disconnect();
            return {
                viewBox: svg.getAttribute('viewBox'), mutations: probe.mutations,
                reused: probe.paths.every(path => path.isConnected),
                holes: probe.paths.every(path => (path.getAttribute('d').match(/ M /g) || []).length > 0),
                transform: window.bootstrap.pcbApp.viewport.contentLayer.getAttribute('transform'),
            };
        });
        assert.notEqual(result.viewBox, start.viewBox, 'Real right-button dragging pans the editable board');
        assert.equal(result.mutations, 0, 'Ordinary pan must not rewrite copper clip definitions');
        assert.ok(result.reused && result.holes, 'Both original hole clips remain attached');
        assert.equal(result.transform, null, 'Release restores normal SVG coordinates for editing');
        console.log(`  PCB pan: ${result.mutations} copper-definition mutations over 30 pointer steps`);
        await page.evaluate(() => {
            const app = window.bootstrap.pcbApp;
            app.fitToContent();
            app.viewport.zoomToLevel(app.viewport.zoomPercents.indexOf(500));
        });
        await viewportSettled(page, 'pcb');
        const culled = await page.evaluate(() => ({
            labels: document.querySelectorAll('.pcb-track-label.culled').length,
            runs: document.querySelectorAll('.pcb-track.culled').length,
        }));
        assert.ok(culled.labels > 0 && culled.runs > 0, 'Off-screen labels and track runs are skipped even on boards without placements');
        const withCulling = await page.screenshot();
        await page.evaluate(async () => {
            const { updateTrackViewportCulling } = await import('/src/pcb/modules/track-render.js');
            const app = window.bootstrap.pcbApp;
            updateTrackViewportCulling(app.tracks, app.vias, null);
        });
        assert.deepEqual(await page.screenshot(), withCulling, 'Culling does not change visible artwork at 500%');
        const exported = await page.evaluate(async () => {
            const app = window.bootstrap.pcbApp;
            const { updatePcbCulling } = await import('/src/pcb/modules/component-selection.js');
            const { clonePcbViewportForExport } = await import('/src/pcb/modules/pcb-export.js');
            updatePcbCulling(app);
            const { svgNode } = clonePcbViewportForExport(app);
            return { tracks: svgNode.querySelectorAll('.pcb-track').length,
                culled: svgNode.querySelectorAll('.culled').length,
                hiddenTracks: svgNode.querySelectorAll('.pcb-track[display="none"]').length,
                restored: app.viewport.svg.querySelectorAll('.pcb-track-label.culled').length };
        });
        assert.equal(exported.tracks, 600, 'Export includes every track, including off-screen runs');
        assert.equal(exported.culled, 0, 'Export never carries viewport culling');
        assert.equal(exported.hiddenTracks, 0, 'Computed export styles cannot bake off-screen visibility into tracks');
        assert.ok(exported.restored > 0, 'Live viewport culling is reapplied after export');
        const panel = await page.evaluate(async () => {
            const { createPanelArtworkRaster } = await import('/src/pcb/modules/panelization-raster.js');
            const app = window.bootstrap.pcbApp;
            const target = document.createElementNS('http://www.w3.org/2000/svg', 'image');
            const createUrl = URL.createObjectURL;
            let source;
            URL.createObjectURL = blob => {
                if (blob.type === 'image/svg+xml') source = blob.text();
                return createUrl.call(URL, blob);
            };
            const dispose = createPanelArtworkRaster(app, [['top-copper', app.getLayerGroup('top-copper')]], target,
                { x: 0, y: -80, w: 100, h: 80, points: [{ x: 0, y: 0 }, { x: 100, y: 0 },
                    { x: 100, y: -80 }, { x: 0, y: -80 }] });
            try {
                await new Promise((resolve, reject) => {
                    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Panel raster did not finish')); }, 10000);
                    const observer = new MutationObserver(() => {
                        clearTimeout(timer); observer.disconnect(); resolve();
                    });
                    observer.observe(target, { attributes: true, attributeFilter: ['href'] });
                });
                const svg = new DOMParser().parseFromString(await source, 'image/svg+xml');
                return { tracks: svg.querySelectorAll('.pcb-track').length,
                    hidden: svg.querySelectorAll('.pcb-track[display="none"], .pcb-track.culled').length };
            } finally {
                dispose();
                URL.createObjectURL = createUrl;
            }
        });
        assert.equal(panel.tracks, 300, 'Panel raster includes all top-side runs, not just visible ones');
        assert.equal(panel.hidden, 0, 'Panel artwork does not bake viewport culling into its bitmap');
    },
}];
