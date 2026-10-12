import assert from 'node:assert/strict';
import { openPcb, waitForPage } from './helpers/editor-helpers.mjs';

export const scenarios = [{
    name: 'board-view-loading-spinners-are-independent',
    async run(page, url) {
        await openPcb(page, url);
        let releaseWorker;
        const heldWorker = new Promise(resolve => { releaseWorker = resolve; });
        await page.route('**/board3d-surface-worker.js*', async route => {
            await heldWorker;
            await route.continue();
        });
        const setView = view => page.evaluate(async view => {
            const { getBoardViewPanel } = await import('/src/pcb/modules/refresh-state.js');
            getBoardViewPanel(window.bootstrap.pcbApp).setView(view);
        }, view);
        try {
            await page.evaluate(async () => {
                const { openBoard3DViewer } = await import('/src/pcb/modules/board3d.js');
                await openBoard3DViewer(window.bootstrap.pcbApp, { view: 'top' });
            });
            const flat = page.locator('.cpcb3d-spinner2d');
            const model = page.locator('.cpcb3d-spinner3d');
            assert.equal(await flat.isVisible(), false, '2D loading has completed');
            await setView('3d');
            assert.equal(await model.isVisible(), true, 'first 3D build shows its own spinner after 2D');
            assert.equal(await flat.isVisible(), false);
            await setView('top');
            assert.equal(await model.isVisible(), false, 'pending 3D overlay is hidden in 2D');
            assert.equal(await model.evaluate(element => element.classList.contains('show')), true,
                'switching to 2D retains the pending 3D loading state');
            await setView('3d');
            assert.equal(await model.isVisible(), true, 'returning to pending 3D restores loading feedback');
            releaseWorker();
            await waitForPage(page, () => !document.querySelector('.cpcb3d-spinner3d').classList.contains('show'));
            assert.equal(await model.isVisible(), false, 'completed 3D build clears only its overlay');
            await setView('bottom');
            await setView('3d');
            assert.equal(await model.isVisible(), false, 'completed 3D view does not restart its spinner');
        } finally {
            releaseWorker();
            await page.evaluate(async () => {
                const { getBoardViewPanel } = await import('/src/pcb/modules/refresh-state.js');
                getBoardViewPanel(window.bootstrap.pcbApp)?.close();
            });
        }
    },
}, {
    name: 'board-view-first-2d-switch-paints-loading-before-artwork',
    async run(page, url) {
        await openPcb(page, url);
        await page.evaluate(async () => {
            const { openBoard3DViewer } = await import('/src/pcb/modules/board3d.js');
            await openBoard3DViewer(window.bootstrap.pcbApp, { view: '3d' });
        });
        await waitForPage(page, () => !document.querySelector('.cpcb3d-spinner3d').classList.contains('show'));
        const result = await page.evaluate(async () => {
            const { getBoardViewPanel } = await import('/src/pcb/modules/refresh-state.js');
            const { Board2D } = await import('/src/pcb/modules/board2d.js');
            const panel = getBoardViewPanel(window.bootstrap.pcbApp);
            const host = document.querySelector('.cpcb3d-host');
            const spinner = host.querySelector('.cpcb3d-spinner2d');
            const original = Board2D.prototype._paintBoard;
            let paints = 0;
            Board2D.prototype._paintBoard = function(context) { paints++; original.call(this, context); };
            try {
                const loading = panel.setView('top');
                const immediate = { paints, mode2d: host.classList.contains('cpcb3d-mode2d'),
                    spinner: getComputedStyle(spinner).display !== 'none' };
                await new Promise(resolve => requestAnimationFrame(resolve));
                const beforeBuild = { paints, spinner: getComputedStyle(spinner).display !== 'none' };
                panel.setView('3d');
                await loading;
                const cancelledPaints = paints;
                await panel.setView('bottom');
                return { immediate, beforeBuild, cancelledPaints, paints,
                    spinnerCleared: !spinner.classList.contains('show') };
            } finally {
                Board2D.prototype._paintBoard = original;
                panel.close();
            }
        });
        assert.deepEqual(result.immediate, { paints: 0, mode2d: true, spinner: true },
            'switching to 2D updates mode and loading feedback before rendering');
        assert.deepEqual(result.beforeBuild, { paints: 0, spinner: true },
            'loading feedback gets a paint opportunity before artwork is built');
        assert.equal(result.cancelledPaints, 0, 'switching away cancels the pending first 2D build');
        assert.equal(result.paints, 1, 'returning to 2D builds the requested side once');
        assert.equal(result.spinnerCleared, true);
    },
}];
