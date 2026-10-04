import assert from 'node:assert/strict';

/*
 * Every schematic gesture, cancelled by every route, leaves the authored model and
 * history exactly as they were — the schematic's counterpart of the PCB
 * preview-isolation tests. Gestures edit authored shapes in place while they run, so
 * this is what proves each cancel restores everything it touched.
 */

/** Load the app with no saved state, skip the welcome screen and open the schematic tab. */
async function openSchematic(page, url) {
    await page.evaluate(() => {
        try { window.bootstrap?.project?.fileManager?.setDirty?.(false); } catch { /* not loaded yet */ }
        for (const key of Object.keys(localStorage)) if (key.startsWith('clearpcb_')) localStorage.removeItem(key);
    }).catch(() => {});
    await page.goto(`${url}index.html`);
    await page.waitForFunction(() => window.bootstrap?.pcbApp && window.bootstrap?.schematicApp);
    if (await page.locator('#startupSplash').isVisible()) await page.locator('#startupContinue').click();
    await page.locator('.mode-tab[data-mode="schematic"]').click();
}

function screenPoint(page, x, y) {
    return page.evaluate(([x, y]) => {
        const viewport = window.bootstrap.schematicApp.viewport;
        const screen = viewport.worldToScreen({ x, y });
        const rect = viewport.svg.getBoundingClientRect();
        return { x: rect.left + screen.x, y: rect.top + screen.y };
    }, [x, y]);
}

const viewCentre = page => page.evaluate(() => {
    const viewport = window.bootstrap.schematicApp.viewport;
    const rect = viewport.svg.getBoundingClientRect();
    const world = viewport.screenToWorld({ x: rect.width / 2, y: rect.height / 2 });
    return { x: Math.round(world.x), y: Math.round(world.y) };
});

/** Authored model and history, compared before and after each gesture. */
const fingerprint = page => page.evaluate(() => {
    const app = window.bootstrap.schematicApp;
    return JSON.stringify({
        shapes: app.shapes.map(shape => [shape.type, shape.captureState()]),
        components: app.components.map(component => component.captureState()),
        undo: app.history.undoStack.length, redo: app.history.redoStack.length,
    });
});

/** Nothing may be left in progress after a cancel. */
const inProgress = page => page.evaluate(() => {
    const app = window.bootstrap.schematicApp;
    return { drag: !!app.drag, pending: !!app.pendingAnchorDrag, drawing: !!app.isDrawing,
        pasting: !!app.pastingClipboard, editing: app.isSectionEditing() };
});

async function clickAt(page, point) {
    const screen = await screenPoint(page, point.x, point.y);
    await page.mouse.move(screen.x, screen.y, { steps: 3 });
    await page.mouse.click(screen.x, screen.y);
}

async function pressAndMove(page, from, to) {
    const start = await screenPoint(page, from.x, from.y);
    const end = await screenPoint(page, to.x, to.y);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 6 });
}

/** Draw a 20 x 10 rectangle with its first corner at the view centre, then select it. */
async function setUp(page, url) {
    await openSchematic(page, url);
    const centre = await viewCentre(page);
    await page.locator('#ribbonSchematic [data-tool="rect"]').click();
    await clickAt(page, centre);
    await clickAt(page, { x: centre.x + 20, y: centre.y + 10 });
    await page.keyboard.press('v');
    await clickAt(page, { x: centre.x + 5, y: centre.y });
    await page.waitForTimeout(600); // a later press is not a double click
    return centre;
}

/** Draw an L-shaped wire from 20 mm left of the view centre, then select it. */
async function setUpWire(page, url) {
    await openSchematic(page, url);
    const centre = await viewCentre(page);
    await page.keyboard.press('w');
    await clickAt(page, { x: centre.x - 20, y: centre.y });
    await clickAt(page, centre);
    await clickAt(page, { x: centre.x, y: centre.y + 20 });
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    await page.keyboard.press('v');
    await clickAt(page, { x: centre.x - 15, y: centre.y });
    await page.waitForTimeout(600);
    return centre;
}

/** Gestures, each started and left in progress; `pointer` says whether the mouse is held. */
const GESTURES = {
    'move drag': { pointer: true, kind: 'pointer',
        start: (page, c) => pressAndMove(page, { x: c.x + 5, y: c.y }, { x: c.x + 15, y: c.y + 10 }) },
    'corner drag': { pointer: true, kind: 'pointer',
        start: (page, c) => pressAndMove(page, { x: c.x + 20, y: c.y + 10 }, { x: c.x + 30, y: c.y + 20 }) },
    'wire segment drag': { pointer: true, kind: 'pointer', setUp: setUpWire,
        start: (page, c) => pressAndMove(page, { x: c.x - 15, y: c.y }, { x: c.x - 15, y: c.y - 8 }) },
    'box select': { pointer: true, kind: 'pointer',
        start: (page, c) => pressAndMove(page, { x: c.x - 15, y: c.y - 15 }, { x: c.x + 30, y: c.y + 30 }) },
    'rectangle drawing': { pointer: false, kind: 'drawing', async start(page, c) {
        await page.keyboard.press('r');
        await clickAt(page, { x: c.x - 20, y: c.y - 20 });
        const to = await screenPoint(page, c.x - 5, c.y - 12);
        await page.mouse.move(to.x, to.y, { steps: 3 });
    } },
    'wire drawing': { pointer: false, kind: 'drawing', async start(page, c) {
        await page.keyboard.press('w');
        await clickAt(page, { x: c.x - 20, y: c.y + 20 });
        const to = await screenPoint(page, c.x - 5, c.y + 20);
        await page.mouse.move(to.x, to.y, { steps: 3 });
    } },
    paste: { pointer: false, kind: 'modal', async start(page, c) {
        await page.keyboard.press('Control+c');
        await page.keyboard.press('Control+v');
        const to = await screenPoint(page, c.x + 40, c.y + 30);
        await page.mouse.move(to.x, to.y, { steps: 3 });
    } },
};

async function cancelBy(page, route, gesture) {
    if (route === 'Escape') await page.keyboard.press('Escape');
    else if (route === 'tool switch') await page.keyboard.press(gesture === 'wire drawing' ? 'c' : 'w');
    else await page.keyboard.press('Control+z');
    if (GESTURES[gesture].pointer) await page.mouse.up();
}

export const scenarios = Object.entries(GESTURES).map(([gesture, spec]) => ({
    name: `schematic-cancel-isolation: ${gesture}`,
    async run(page, url) {
        for (const route of ['Escape', 'tool switch', 'Ctrl+Z']) {
            const centre = await (spec.setUp || setUp)(page, url);
            const before = await fingerprint(page);
            await spec.start(page, centre);
            assert.equal((await inProgress(page)).editing, true, `${gesture}: the gesture is in progress`);
            await cancelBy(page, route, gesture);

            if (route === 'Ctrl+Z' && spec.kind === 'drawing') {
                assert.equal((await inProgress(page)).drawing, true, `${gesture}: Ctrl+Z waits for the drawing`);
                await page.keyboard.press('Escape');
            } else if (route === 'Ctrl+Z' && spec.kind === 'pointer') {
                // The preview is cancelled first, then the rectangle's creation is undone.
                assert.notEqual(await fingerprint(page), before, `${gesture}: Ctrl+Z still steps history`);
                await page.keyboard.press('Control+y');
            }
            assert.deepEqual(await inProgress(page),
                { drag: false, pending: false, drawing: false, pasting: false, editing: false },
                `${gesture} / ${route}: nothing is left in progress`);
            assert.equal(await fingerprint(page), before, `${gesture} / ${route}: model and history are unchanged`);
        }
    },
}));

scenarios.push({
    name: 'schematic-cancel-isolation: selection keys wait for a drag',
    async run(page, url) {
        const centre = await setUp(page, url);
        const before = await fingerprint(page);
        await GESTURES['move drag'].start(page, centre);
        for (const key of ['Delete', 'ArrowRight', 'Control+a', 'Control+x', 'Control+v', 'Space']) {
            await page.keyboard.press(key);
        }
        assert.equal((await inProgress(page)).drag, true, 'the drag is still running');
        await page.keyboard.press('Escape');
        await page.mouse.up();
        assert.equal(await fingerprint(page), before, 'keys pressed during the drag changed nothing');
    },
});
