import assert from 'node:assert/strict';
import { openPcb, viewportSettled, waitForPage } from './helpers/editor-helpers.mjs';

// Board-shape to Track conversion and Track copper-only Properties behavior,
// checked through undo/redo and save + reopen.

/** Wait until the PCB view stops moving (opening zooms to fit with an animation). */
const settle = page => viewportSettled(page, 'pcb');

function screenPoint(page, x, y) {
    return page.evaluate(([x, y]) => {
        const viewport = window.bootstrap.pcbApp.viewport;
        const screen = viewport.worldToScreen({ x, y });
        const rect = viewport.svg.getBoundingClientRect();
        return { x: rect.left + screen.x, y: rect.top + screen.y };
    }, [x, y]);
}

async function clickAt(page, x, y) {
    const point = await screenPoint(page, x, y);
    await page.mouse.move(point.x, point.y);
    await page.mouse.click(point.x, point.y);
}

/** Draw a shape with the Shapes tool on `layer` by clicking `points`. */
async function drawShape(page, kind, layer, points, { plated = false } = {}) {
    await page.locator('[data-tab="pcb-home"]').click();
    await page.locator('#pcbToolShapesArrow').click();
    await page.locator(`#pcbToolShapesMenu [data-shape="${kind}"]`).click();
    await page.selectOption('#pcbToolShapeLayer', layer);
    if (plated) await page.locator('#pcbToolShapePlated').check();
    for (const [x, y] of points) await clickAt(page, x, y);
    if (kind === 'line') {
        const [x, y] = points.at(-1);
        const point = await screenPoint(page, x, y);
        await page.mouse.dblclick(point.x, point.y);
    }
    await page.keyboard.press('Escape');
    await page.locator('[data-tab="pcb-home"]').click();
    await page.locator('#pcbToolSelect').click();
}

/** Pick a value from a Properties menu; the panel is rebuilt when the object changes kind. */
async function choose(page, select, value) {
    await page.selectOption(select, value);
    await page.waitForTimeout(100);
}

/** Which panel is showing: the track's or the shape's. */
const panel = page => page.evaluate(() => document.getElementById('pcbPropTrackLayer') ? 'track'
    : document.getElementById('pcbPropShapeLayer') ? 'shape' : 'none');

/** Comparable model state: tracks and non-outline board shapes. */
const model = page => page.evaluate(() => {
    const app = window.bootstrap.pcbApp;
    return {
        tracks: app.tracks.map(track => ({ layer: track.layer, nodes: track.nodes.size, width: track.width })),
        shapes: app.boardShapes.filter(shape => shape.layer !== 'board-outline').map(shape => ({ id: shape.id, kind: shape.kind,
            layer: shape.layer, copperMode: shape.copperMode, plated: !!shape.plated, filled: !!shape.filled, points: shape.points?.length })),
        uniqueIds: new Set(app.boardShapes.map(shape => shape.id)).size === app.boardShapes.length,
    };
});

/** Wait for the autosave to hold the current document, reload, and accept recovery. */
async function saveAndReopen(page) {
    const expected = await page.evaluate(() => JSON.stringify(window.bootstrap.project.serialize().pcb));
    await page.waitForFunction(text => {
        const saved = localStorage.getItem('clearpcb_autosave_untitled.cpcb');
        return saved && JSON.stringify(JSON.parse(saved).data?.pcb) === text;
    }, expected, { timeout: 30000 });
    await page.reload();
    const recover = page.locator('.app-modal-overlay button', { hasText: 'Yes' });
    await recover.waitFor();
    await recover.click();
    await page.waitForFunction(() => window.bootstrap?.pcbApp && !window.bootstrap.project.fileManager.loading);
    assert.equal(await page.locator('.app-modal-overlay', { hasText: 'Repaired' }).count(), 0,
        'the recovered project needed no id repair');
    await page.locator('.mode-tab[data-mode="pcb"]').click();
    await waitForPage(page, () => import('/src/pcb/modules/pcb-editor-api.js')
        .then(api => api.isEditorActive(window.bootstrap.pcbApp)));
    await settle(page);
}

export const scenarios = [
    {
        name: 'track-properties-stay-copper-only-after-shape-conversion',
        async run(page, url) {
            await openPcb(page, url);
            await drawShape(page, 'rect', 'hole', [[20, -20], [30, -14]], { plated: true });
            const start = await model(page);
            assert.deepEqual(start.shapes.map(shape => [shape.kind, shape.layer, shape.plated]), [['rect', 'hole', true]]);

            await clickAt(page, 25, -20);
            await choose(page, '#pcbPropShapeLayer', 'top-copper');
            assert.equal(await panel(page), 'track', 'moving the hole onto copper shows the new track');
            assert.equal((await model(page)).tracks.length, 1);

            // A second click on the selected track's midpoint picks up a new node; a
            // panel edit made meanwhile must still reach the track.
            await clickAt(page, 25, -20);
            assert.deepEqual(await page.locator('#pcbPropTrackLayer option').evaluateAll(options =>
                options.map(option => ({ value: option.value, disabled: option.disabled }))), [
                { value: 'top-copper', disabled: false },
                { value: 'bottom-copper', disabled: false },
            ], 'Track Layer offers only Top and Bottom Copper');
            assert.equal(await page.locator('#pcbPropTrackCopperMode').count(), 0,
                'Track Properties does not offer Copper Mode');
            await choose(page, '#pcbPropTrackLayer', 'bottom-copper');
            assert.equal(await panel(page), 'track');
            assert.deepEqual((await model(page)).tracks.map(track => [track.layer, track.nodes]),
                [['bottom-copper', 4]], 'the copper-layer edit drops the picked-up midpoint and keeps a Track');
            await choose(page, '#pcbPropTrackLayer', 'top-copper');

            await page.locator('#pcbPropTrackFill').click();
            await page.waitForTimeout(100);
            const end = await model(page);
            assert.deepEqual(end.shapes.map(shape => [shape.kind, shape.layer, shape.filled]), [['rect', 'top-copper', true]]);
            assert.ok(end.uniqueIds);

            await clickAt(page, 80, 30);
            const depth = await page.evaluate(() => window.bootstrap.pcbApp.history.undoStack.length);
            for (let step = 1; step < depth; step++) await page.keyboard.press('Control+z');
            assert.deepEqual(await model(page), start, 'undo walks back to the plated hole rectangle');
            for (let step = 1; step < depth; step++) await page.keyboard.press('Control+y');
            assert.deepEqual(await model(page), end, 'redo walks forward to the filled copper rectangle');

            await saveAndReopen(page);
            assert.deepEqual(await model(page), end, 'the reopened project matches');
        },
    },
    {
        name: 'shape-converted-tracks-keep-unique-ids-across-reopen',
        async run(page, url) {
            await openPcb(page, url);
            await drawShape(page, 'line', 'top-silk', [[20, -20], [40, -20]]);
            await clickAt(page, 30, -20);
            await choose(page, '#pcbPropShapeLayer', 'top-copper');
            assert.equal((await model(page)).tracks.length, 1);

            // After reopening, new shapes are numbered from the board shapes alone.
            await saveAndReopen(page);
            await drawShape(page, 'line', 'top-silk', [[20, -10], [40, -10]]);
            const converted = await model(page);
            assert.equal(converted.tracks.length, 1);
            assert.equal(converted.shapes.length, 1);
            assert.ok(converted.uniqueIds, `shape ids stay unique (${converted.shapes.map(shape => shape.id).join(', ')})`);

            await saveAndReopen(page);
            assert.deepEqual((await model(page)).shapes.map(shape => shape.layer), ['top-silk']);
            assert.equal((await model(page)).tracks.length, 1);
        },
    },
];
