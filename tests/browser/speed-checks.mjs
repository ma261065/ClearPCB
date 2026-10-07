import assert from 'node:assert/strict';
import { openPcb, screenPoint, viewportSettled, waitForPage } from './helpers/editor-helpers.mjs';

// Speed checks on a large board: pointer moves, Properties panel rebuilds, pour refresh
// and picture import. Each measures main-thread task time with Chrome's own metrics, so
// harness round trips and frame waits do not count, and fails only past a budget about
// three times what a run with the CPU throttled 4x (as on CI) takes. They catch
// order-of-magnitude regressions such as an accidentally quadratic walk, not noise.
// Every run prints its measurements, so CI logs show the trend.

/** Budgets in milliseconds of main-thread time. */
const BUDGET = {
    load: 2500, hoverMove: 400, dragMove: 600, panelRebuild: 300,
    pourRefresh: 3000, picturePreview: 1000, picturePlace: 3000,
};
const BOARD = { width: 160, height: 110 };

/** A main-thread meter on one DevTools session (detaching a session can reset CPU throttling). */
async function mainThreadMeter(page) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    const taskSeconds = async () => (await cdp.send('Performance.getMetrics')).metrics
        .find(metric => metric.name === 'TaskDuration').value;
    const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    /** Main-thread task time (ms) that `action` causes, including the frames it schedules. */
    return async action => {
        await frames();
        const before = await taskSeconds();
        await action();
        await frames();
        return (await taskSeconds() - before) * 1000;
    };
}

function check(name, measured, budget) {
    console.log(`  speed: ${name} ${measured.toFixed(1)} ms (budget ${budget} ms)`);
    assert.ok(measured <= budget, `${name} took ${measured.toFixed(1)} ms; the budget is ${budget} ms`);
}

const fillsSettled = page => waitForPage(page, () => import('/src/pcb/modules/refresh-state.js')
    .then(state => !state.isFillRefreshPending(window.bootstrap.pcbApp)), undefined, { timeout: 60000 });

/** Load a large board through the real project load: tracks, vias, pads and two pours. */
async function loadLargeBoard(page) {
    const loadMs = await page.evaluate(async board => {
        const [{ PcbDocument }, { Track }, { Via }, { Pad }, { CopperFill }, { rectangleBoardOutline }] = await Promise.all([
            import('/src/core/PcbDocument.js'), import('/src/shapes/track.js'), import('/src/shapes/via.js'),
            import('/src/shapes/pad.js'), import('/src/shapes/copper-fill.js'), import('/src/shared/pcb/board-outline.js'),
        ]);
        const model = new PcbDocument();
        model.setBoardOutline(rectangleBoardOutline(board.width, board.height));
        for (let index = 0; index < 600; index++) {
            const x = 4 + (index % 30) * 5, y = -4 - Math.floor(index / 30) * 5;
            model.tracks.push(new Track({ net: `N${index % 50}`, layer: index % 2 ? 'bottom-copper' : 'top-copper', width: 0.25,
                points: [{ x, y }, { x: x + 2, y }, { x: x + 2, y: y - 2 }, { x: x + 3.5, y: y - 3 }] }));
        }
        for (let index = 0; index < 200; index++) {
            const x = 6 + (index % 20) * 7.5, y = -6 - Math.floor(index / 20) * 10;
            model.vias.push(new Via({ x, y, diameter: 0.6, drill: 0.3, net: `N${index % 50}` }));
            model.pads.push(new Pad({ x: x + 3, y: y - 4, shape: index % 2 ? 'stadium' : 'round', size: 1.4, drill: 0.7,
                rotation: index % 90, net: `N${(index + 7) % 50}` }));
        }
        const outline = [{ x: 1, y: -1 }, { x: board.width - 1, y: -1 },
            { x: board.width - 1, y: 1 - board.height }, { x: 1, y: 1 - board.height }];
        model.boardShapes.push(new CopperFill({ outline, net: 'GND', layer: 'top-copper' }));
        model.boardShapes.push(new CopperFill({ outline, net: 'GND', layer: 'bottom-copper' }));
        const project = window.bootstrap.project;
        const data = project.serialize();
        data.pcb = model.serializeSection();
        const started = performance.now();
        await project.load(data);
        return performance.now() - started;
    }, BOARD);
    await fillsSettled(page);
    await page.evaluate(() => window.bootstrap.pcbApp.fitToContent());
    await viewportSettled(page, 'pcb');
    return loadMs;
}

/** Choose a 1200x900 black-on-white PNG of discs and text in the open import dialog. */
const choosePictureFile = page => page.evaluate(async () => {
    const canvas = new OffscreenCanvas(1200, 900);
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, 1200, 900);
    context.fillStyle = '#000';
    for (let index = 0; index < 60; index++) {
        context.beginPath();
        context.arc(60 + (index % 10) * 110, 80 + Math.floor(index / 10) * 140, 20 + (index % 7) * 6, 0, Math.PI * 2);
        context.fill();
    }
    context.font = 'bold 120px sans-serif';
    context.fillText('ClearPCB', 220, 560);
    const file = new File([await canvas.convertToBlob({ type: 'image/png' })], 'speed.png', { type: 'image/png' });
    const input = /** @type {HTMLInputElement} */ (document.querySelector('#pcb-picture-import [name="file"]'));
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change'));
});

export const scenarios = [
    {
        name: 'speed: pointer moves, panels, pours and pictures on a large board',
        async run(page, url) {
            await openPcb(page, url);
            check('load (wall)', await loadLargeBoard(page), BUDGET.load);
            const mainThreadMs = await mainThreadMeter(page);

            // Hovering with the Select tool diagonally across the whole board.
            const from = await screenPoint(page, 'pcb', 3, -3);
            const to = await screenPoint(page, 'pcb', BOARD.width - 3, 3 - BOARD.height);
            await page.mouse.move(from.x, from.y);
            const hoverMoves = 60;
            const hover = await mainThreadMs(async () => {
                for (let index = 1; index <= hoverMoves; index++) {
                    const t = index / hoverMoves;
                    await page.mouse.move(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
                }
            });
            check('hover move', hover / hoverMoves, BUDGET.hoverMove);

            // Dragging a via across the board, with its tracks and ratsnest following.
            const via = await page.evaluate(() => { const v = window.bootstrap.pcbApp.vias[45]; return { x: v.x, y: v.y }; });
            const start = await screenPoint(page, 'pcb', via.x, via.y);
            await page.mouse.move(start.x, start.y);
            await page.mouse.down();
            const dragMoves = 40;
            const drag = await mainThreadMs(async () => {
                for (let index = 1; index <= dragMoves; index++) await page.mouse.move(start.x + index * 6, start.y + index * 3);
            });
            await page.mouse.up();
            check('drag move', drag / dragMoves, BUDGET.dragMove);
            await fillsSettled(page);

            // Rebuilding the Properties panel as the selection changes kind (median of 40).
            const rebuild = await page.evaluate(async () => {
                const { setPcbSelection } = await import('/src/pcb/modules/selection-registry.js');
                const { showPcbSelectionProperties } = await import('/src/pcb/modules/selection-interaction.js');
                const app = window.bootstrap.pcbApp;
                const entries = [{ kind: 'via', object: app.vias[3] }, { kind: 'track', object: app.tracks[10] },
                    { kind: 'pad', object: app.pads[5] }, { kind: 'fill', object: app.copperFills[0] }];
                const times = [];
                for (let index = 0; index < 40; index++) {
                    const started = performance.now();
                    setPcbSelection(app, [entries[index % entries.length]]);
                    showPcbSelectionProperties(app);
                    void document.getElementById('pcbPropsItems')?.offsetHeight;
                    times.push(performance.now() - started);
                }
                setPcbSelection(app, []);
                times.sort((a, b) => a - b);
                return times[Math.floor(times.length / 2)];
            });
            check('panel rebuild', rebuild, BUDGET.panelRebuild);

            // Recomputing both board-sized pours.
            const pour = await mainThreadMs(async () => {
                await page.evaluate(() => window.bootstrap.pcbApp.refreshFills());
                await fillsSettled(page);
            });
            check('pour refresh', pour, BUDGET.pourRefresh);

            // Importing a picture onto copper through the real dialog, then placing it.
            await page.evaluate(async () => {
                const { showPictureImport } = await import('/src/pcb/modules/picture-import.js');
                showPictureImport(window.bootstrap.pcbApp);
            });
            const dialog = page.locator('#pcb-picture-import');
            await dialog.locator('[name="layer"]').selectOption('top-copper');
            await dialog.locator('[name="resolution"]').selectOption('256');
            const preview = await mainThreadMs(async () => {
                await choosePictureFile(page);
                await dialog.locator('[type="submit"]:not([disabled])').waitFor({ timeout: 30000 });
            });
            check('picture preview', preview, BUDGET.picturePreview);
            await dialog.locator('[type="submit"]').click();
            const place = await screenPoint(page, 'pcb', BOARD.width / 2, -BOARD.height / 2);
            const placed = await mainThreadMs(async () => {
                await page.mouse.move(place.x, place.y);
                await page.mouse.click(place.x, place.y);
                await waitForPage(page, () => import('/src/pcb/modules/refresh-state.js').then(state => {
                    const app = window.bootstrap.pcbApp;
                    return app.boardShapes.some(shape => shape.kind === 'image')
                        && !state.isPictureCopperRefreshPending(app) && !state.isFillRefreshPending(app);
                }), undefined, { timeout: 60000 });
            });
            check('picture place', placed, BUDGET.picturePlace);
        },
    },
];
