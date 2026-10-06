import assert from 'node:assert/strict';
import { openPcb } from './helpers/editor-helpers.mjs';

/** Screen position of a PCB world point. */
function screenPoint(page, x, y) {
    return page.evaluate(([x, y]) => {
        const viewport = window.bootstrap.pcbApp.viewport;
        const screen = viewport.worldToScreen({ x, y });
        const rect = viewport.svg.getBoundingClientRect();
        return { x: rect.left + screen.x, y: rect.top + screen.y };
    }, [x, y]);
}

/** Draw a two-point track with the Track tool, finishing with a double-click. */
async function drawTrack(page, from, to) {
    await page.locator('#pcbToolTrack').click();
    for (const [x, y] of [from, to]) {
        const point = await screenPoint(page, x, y);
        await page.mouse.move(point.x, point.y);
        await page.mouse.click(point.x, point.y);
    }
    const end = await screenPoint(page, ...to);
    await page.mouse.dblclick(end.x, end.y);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.bootstrap.pcbApp.tracks.length === 1 && !window.bootstrap.pcbApp._trackDraw);
}

/** Select the drawn track by clicking its middle with the Select tool. */
async function selectTrack(page) {
    await page.locator('#pcbToolSelect').click();
    const [[x1, y1], [x2, y2]] = await trackNodes(page);
    const middle = await screenPoint(page, (x1 + x2) / 2, (y1 + y2) / 2);
    await page.mouse.click(middle.x, middle.y);
    await page.locator('#pcbPropTrackWidth').waitFor();
}

const trackNodes = page => page.evaluate(() => [...window.bootstrap.pcbApp.tracks[0].nodes.values()].map(node => [node.x, node.y]));

/** Total vertex count of the meshes in the open 3D scene (runs in the page). */
const sceneVertices = () => {
    let vertices = 0;
    window.__clearpcbBoardViewPanel?.()?.scene?.scene?.traverse(object => {
        if (object.isMesh && object.geometry?.attributes?.position) vertices += object.geometry.attributes.position.count;
    });
    return vertices;
};

export const scenarios = [
    {
        name: 'app-loads-and-switches-modes',
        async run(page, url) {
            await openPcb(page, url);
            assert.equal(await page.evaluate(() => window.bootstrap.pcbApp._active), true);
            await page.locator('.mode-tab[data-mode="schematic"]').click();
            await page.waitForFunction(() => window.bootstrap.pcbApp._active === false);
            await page.locator('.mode-tab[data-mode="pcb"]').click();
            await page.waitForFunction(() => window.bootstrap.pcbApp._active === true);
        },
    },
    {
        name: 'pcb-track-drawing-and-undo',
        async run(page, url) {
            await openPcb(page, url);
            await drawTrack(page, [20, -20], [50, -20]);
            const expected = [[20, -20], [50, -20]];
            for (const [index, [x, y]] of (await trackNodes(page)).entries()) {
                assert.ok(Math.hypot(x - expected[index][0], y - expected[index][1]) < 1.3,
                    `Track node ${x},${y} lands on the clicked grid point`);
            }
            assert.equal(await page.locator('.pcb-track').count(), 1, 'The track is rendered');
            await page.keyboard.press('Control+z');
            await page.waitForFunction(() => window.bootstrap.pcbApp.tracks.length === 0);
            assert.equal(await page.locator('.pcb-track').count(), 0, 'Undo removes the rendered track');
            await page.keyboard.press('Control+y');
            await page.waitForFunction(() => window.bootstrap.pcbApp.tracks.length === 1);
        },
    },
    {
        name: '3d-view-follows-edits-and-closes',
        async run(page, url) {
            await openPcb(page, url);
            await drawTrack(page, [20, -20], [50, -20]);
            await page.locator('#pcb3dView').click();
            await page.evaluate(async () => {
                const { getBoardViewPanel } = await import('/src/pcb/modules/refresh-state.js');
                window.__clearpcbBoardViewPanel = () => getBoardViewPanel(window.bootstrap.pcbApp);
            });
            await page.waitForFunction(() => {
                let meshes = 0;
                window.__clearpcbBoardViewPanel?.()?.scene?.scene?.traverse(object => { if (object.isMesh) meshes++; });
                return meshes >= 4;
            }, null, { timeout: 30000 });
            assert.ok(await page.evaluate(() => window.__clearpcbBoardViewPanel().scene.scene.background?.isTexture),
                'The 3D scene paints the shared gradient background texture');
            const withTrack = await page.evaluate(sceneVertices);
            await page.keyboard.press('Control+z');
            await page.waitForFunction(`(${sceneVertices})() < ${withTrack}`, null, { timeout: 30000 });
            await page.keyboard.press('Control+y');
            await page.waitForFunction(`(${sceneVertices})() === ${withTrack}`, null, { timeout: 30000 });
            await page.evaluate(() => window.__clearpcbBoardViewPanel().close());
            assert.equal(await page.evaluate(() => window.__clearpcbBoardViewPanel()), null, 'Closing releases the viewer');
            assert.equal(await page.locator('.cpcb3d-cv').count(), 0, 'Closing removes the viewer canvas');
            // A committed edit after closing must not touch the disposed viewer.
            await page.keyboard.press('Control+z');
            await page.waitForFunction(() => window.bootstrap.pcbApp.tracks.length === 0);
        },
    },
    {
        name: 'properties-panel-edits-a-track',
        async run(page, url) {
            await openPcb(page, url);
            await drawTrack(page, [20, -20], [50, -20]);
            await selectTrack(page);
            assert.equal(await page.locator('.prop-net-menu').count(), 1, 'The Net field offers the shared net menu');
            await page.locator('#pcbPropTrackWidth').fill('0.5');
            await page.locator('#pcbPropTrackWidth').press('Enter');
            await page.waitForFunction(() => window.bootstrap.pcbApp.tracks[0].width === 0.5);
            await page.locator('#pcbPropTrackWidth').blur();
            await page.keyboard.press('Control+z');
            await page.waitForFunction(() => window.bootstrap.pcbApp.tracks[0].width !== 0.5);
        },
    },
    {
        name: 'save-and-reopen-through-autosave-recovery',
        async run(page, url) {
            await openPcb(page, url);
            await drawTrack(page, [20, -20], [50, -20]);
            await selectTrack(page);
            await page.locator('#pcbPropTrackWidth').fill('0.5');
            await page.locator('#pcbPropTrackWidth').press('Enter');
            await page.waitForFunction(() => {
                const saved = localStorage.getItem('clearpcb_autosave_untitled.cpcb');
                return saved && JSON.parse(saved).data?.pcb?.tracks?.[0]?.w === 0.5;
            }, null, { timeout: 30000 });
            await page.reload();
            const recover = page.locator('.app-modal-overlay button', { hasText: 'Yes' });
            await recover.waitFor();
            await recover.click();
            await page.waitForFunction(() => window.bootstrap?.pcbApp?.tracks?.length === 1);
            assert.equal(await page.evaluate(() => window.bootstrap.pcbApp.tracks[0].width), 0.5, 'The reopened track keeps its width');
            assert.equal(await page.evaluate(() => window.bootstrap.pcbApp.isBoardOutlineDrawn()), true, 'The board outline is restored');
        },
    },
];
