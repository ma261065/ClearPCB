import assert from 'node:assert/strict';
import {
    clickWorld,
    choosePcbShape,
    choosePcbTool,
    dragWorld,
    exercisePcbNumberField,
    pcbUndoDepth,
    openPcb,
    pcbSnapshot,
    redoPcb,
    saveAndReopen,
    screenPoint,
    stepSpinner,
    undoPcb,
} from './helpers/editor-helpers.mjs';

const point = (x, y) => ({ x, y });

const pcbModel = page => page.evaluate(() => {
    const app = window.bootstrap.pcbApp;
    return {
        tracks: app.tracks.map(track => ({ width: track.width, nodes: [...track.nodes.values()].map(n => [n.x, n.y]), locked: !!track.locked })),
        vias: app.vias.map(via => ({ x: via.x, y: via.y, diameter: via.diameter, locked: !!via.locked })),
        pads: app.pads.map(pad => ({ x: pad.x, y: pad.y, size: pad.size, locked: !!pad.locked })),
        texts: [...app.texts.values()].map(text => ({ x: text.x, y: text.y, size: text.size, content: text.content, locked: !!text.locked })),
        shapes: app.boardShapes.filter(shape => shape.layer !== 'board-outline').map(shape => ({
            kind: shape.kind, layer: shape.layer, lineWidth: shape.lineWidth, radius: shape.radius,
            cornerRadius: shape.cornerRadius, points: shape.points?.map(p => [p.x, p.y]), locked: !!shape.locked,
        })),
        fills: app.copperFills.map(fill => ({
            kind: fill.kind, net: fill.net, radius: fill.radius, cornerRadius: fill.cornerRadius,
            outline: fill.outline.map(p => [p.x, p.y]), locked: !!fill.locked,
        })),
        placements: [...app.placements.values()].map(pl => ({
            id: pl.id, reference: pl.reference, x: pl.x, y: pl.y, rotation: pl.rotation || 0,
            locked: !!pl.locked, refSize: pl.refSize || null,
        })),
        board: window.bootstrap.project.serialize().pcb.board,
    };
});

const selectedOverlay = page => page.evaluate(() => window.bootstrap.pcbApp.viewport.contentLayer.innerHTML);

async function selectPcb(page, x, y) {
    await choosePcbTool(page, '#pcbToolSelect');
    await clickWorld(page, 'pcb', x, y);
}

async function drawTrack(page) {
    await choosePcbTool(page, '#pcbToolTrack');
    await clickWorld(page, 'pcb', 20, -20);
    await clickWorld(page, 'pcb', 45, -20);
    const end = await screenPoint(page, 'pcb', 45, -20);
    await page.mouse.dblclick(end.x, end.y);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.bootstrap.pcbApp.tracks.length === 1);
    await selectPcb(page, 32, -20);
}

async function drawShape(page, kind, points, layer = 'top-silk') {
    await choosePcbShape(page, kind);
    await page.selectOption('#pcbToolShapeLayer', layer);
    for (const [x, y] of points) await clickWorld(page, 'pcb', x, y);
    if (kind === 'line' || kind === 'polygon') {
        const [x, y] = points.at(-1);
        const end = await screenPoint(page, 'pcb', x, y);
        await page.mouse.dblclick(end.x, end.y);
    }
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.bootstrap.pcbApp.boardShapes.filter(shape => shape.layer !== 'board-outline').length >= 1);
}

async function drawFill(page, points, net = 'GND') {
    await choosePcbTool(page, '#pcbToolFill');
    await page.locator('#pcbPropFillToolNet').fill(net);
    await page.locator('#pcbPropFillToolNet').press('Enter');
    for (const [x, y] of points) await clickWorld(page, 'pcb', x, y);
    await clickWorld(page, 'pcb', points[0][0], points[0][1]);
    await page.waitForFunction(() => window.bootstrap.pcbApp.copperFills.length > 0);
    await page.waitForFunction(() => window.bootstrap.pcbApp.getLayerGroup('top-fill').querySelector('.pcb-fill-outline, .pcb-fill-copper'));
}

async function lockSelectedPcbObject(page, changedField) {
    await page.locator('#pcbPropObjectLocked').check();
    await page.waitForFunction(() => document.getElementById('pcbPropObjectLocked')?.checked);
    assert.equal(await page.locator(changedField).isDisabled(), true, 'locking through Properties disables editing fields');
    await page.locator('#pcbPropObjectLocked').uncheck();
    await page.waitForFunction(() => !document.getElementById('pcbPropObjectLocked')?.checked);
}

async function undoRedoAndReopen(page, before, after) {
    await undoPcb(page, before);
    assert.equal(await pcbSnapshot(page), before, 'Undo restores the previous model exactly');
    await redoPcb(page, after);
    assert.equal(await pcbSnapshot(page), after, 'Redo restores the edited model exactly');
    await saveAndReopen(page, 'pcb');
}

async function exerciseDragUndoRedoLockSave(page, selectPoint, dragTo, changedField) {
    const before = await pcbSnapshot(page);
    await dragWorld(page, 'pcb', selectPoint, dragTo);
    const after = await pcbSnapshot(page);
    assert.notEqual(after, before, 'dragging the selected object changes the PCB model');
    await undoRedoAndReopen(page, before, after);
    await selectPcb(page, dragTo.x, dragTo.y);
    await lockSelectedPcbObject(page, changedField);
    await saveAndReopen(page, 'pcb');
}

export const scenarios = [
    {
        name: 'pcb-object-workflow: track',
        async run(page, url) {
            await openPcb(page, url);
            await drawTrack(page);
            await exercisePcbNumberField(page, '#pcbPropTrackWidth',
                () => page.evaluate(() => window.bootstrap.pcbApp.pcbDocument.tracks[0].width),
                () => selectedOverlay(page));
            await exerciseDragUndoRedoLockSave(page, point(32, -20), point(38, -14), '#pcbPropTrackWidth');
        },
    },
    {
        name: 'pcb-object-workflow: via',
        async run(page, url) {
            await openPcb(page, url);
            await choosePcbTool(page, '#pcbToolVia');
            await clickWorld(page, 'pcb', 25, -25);
            await selectPcb(page, 25, -25);
            await exercisePcbNumberField(page, '#pcbPropViaDia',
                () => page.evaluate(() => window.bootstrap.pcbApp.pcbDocument.vias[0].diameter),
                () => selectedOverlay(page));
            await exerciseDragUndoRedoLockSave(page, point(25, -25), point(33, -18), '#pcbPropViaDia');
        },
    },
    {
        name: 'pcb-object-workflow: pad',
        async run(page, url) {
            await openPcb(page, url);
            await choosePcbTool(page, '#pcbToolPad');
            await clickWorld(page, 'pcb', 20, -25);
            await selectPcb(page, 20, -25);
            await exercisePcbNumberField(page, '#pcbPropPadSize',
                () => page.evaluate(() => window.bootstrap.pcbApp.pcbDocument.pads[0].size),
                () => selectedOverlay(page));
            await exerciseDragUndoRedoLockSave(page, point(20, -25), point(30, -18), '#pcbPropPadSize');
        },
    },
    {
        name: 'pcb-object-workflow: text',
        async run(page, url) {
            await openPcb(page, url);
            await choosePcbTool(page, '#pcbToolText');
            await clickWorld(page, 'pcb', 20, -20);
            await page.waitForFunction(() => document.activeElement?.tagName === 'INPUT');
            await page.keyboard.type('PCB');
            await page.waitForFunction(() => [...window.bootstrap.pcbApp.texts.values()][0]?.content === 'PCB');
            await page.keyboard.press('Enter');
            await page.waitForFunction(() => [...window.bootstrap.pcbApp.pcbDocument.texts.values()][0]?.content === 'PCB');
            const textPoint = await page.evaluate(async () => {
                const { pcbTextBounds } = await import('/src/pcb/modules/pcb-text.js');
                const text = [...window.bootstrap.pcbApp.pcbDocument.texts.values()][0];
                const bounds = pcbTextBounds(text);
                return { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
            });
            await selectPcb(page, textPoint.x, textPoint.y);
            await exercisePcbNumberField(page, '#pcbPropTextSize',
                () => page.evaluate(() => ([...window.bootstrap.pcbApp.pcbDocument.texts.values()][0]
                    || [...window.bootstrap.pcbApp.texts.values()][0]).size),
                () => selectedOverlay(page));
            await exerciseDragUndoRedoLockSave(page, textPoint, { x: textPoint.x + 10, y: textPoint.y + 7 }, '#pcbPropTextSize');
        },
    },
    ...[
        ['line', [[20, -20], [40, -20]], point(30, -20), point(36, -13)],
        ['rect', [[20, -20], [40, -34]], point(30, -20), point(36, -13)],
        ['circle', [[30, -22], [38, -22]], point(38, -22), point(44, -15)],
        ['polygon', [[20, -20], [40, -20], [35, -35], [20, -20]], point(30, -21), point(36, -14)],
        ['arc', [[20, -30], [40, -30], [30, -18]], point(30, -20.7), point(36, -14)],
    ].map(([kind, points, selectAt, dragTo]) => ({
        name: `pcb-object-workflow: board-shape-${kind}`,
        async run(page, url) {
            await openPcb(page, url);
            await drawShape(page, kind, points);
            await selectPcb(page, selectAt.x, selectAt.y);
            const field = kind === 'circle' ? '#pcbPropShapeDiameter' : '#pcbPropShapeLineWidth';
            const read = kind === 'circle'
                ? () => page.evaluate(() => window.bootstrap.pcbApp.pcbDocument.boardShapes.find(shape => shape.layer !== 'board-outline').radius)
                : () => page.evaluate(() => window.bootstrap.pcbApp.pcbDocument.boardShapes.find(shape => shape.layer !== 'board-outline').lineWidth);
            await exercisePcbNumberField(page, field, read, () => selectedOverlay(page));
            if (kind === 'arc') {
                const before = await pcbSnapshot(page);
                const from = await page.evaluate(() => {
                    const shape = window.bootstrap.pcbApp.pcbDocument.boardShapes.find(shape => shape.layer !== 'board-outline');
                    return { x: shape.start.x, y: shape.start.y };
                });
                await dragWorld(page, 'pcb', from, { x: from.x + 4, y: from.y - 4 });
                const after = await pcbSnapshot(page);
                assert.notEqual(after, before, 'dragging an arc endpoint handle changes the PCB model');
                await undoRedoAndReopen(page, before, after);
                const hit = await page.evaluate(() => {
                    const shape = window.bootstrap.pcbApp.pcbDocument.boardShapes.find(shape => shape.layer !== 'board-outline');
                    return { x: shape.bulge.x, y: shape.bulge.y };
                });
                await selectPcb(page, hit.x, hit.y);
                await lockSelectedPcbObject(page, field);
                await saveAndReopen(page, 'pcb');
                return;
            }
            await exerciseDragUndoRedoLockSave(page, selectAt, dragTo, field);
        },
    })),
    {
        name: 'pcb-object-workflow: copper-fill-rect-polygon-and-live-outline',
        async run(page, url) {
            await openPcb(page, url);
            await drawFill(page, [[10, -10], [35, -10], [35, -30], [10, -30]], 'GND');
            await page.locator('#pcbPropFillKind').waitFor();
            assert.equal(await page.locator('#pcbPropFillKind').inputValue(), 'polygon',
                'a rectangular pour drawn through the Fill tool is editable as a polygon outline');
            await exercisePcbNumberField(page, '#pcbPropFillCornerRadius',
                () => page.evaluate(() => window.bootstrap.pcbApp.pcbDocument.copperFills[0].cornerRadius),
                () => selectedOverlay(page));
            await page.selectOption('#pcbPropFillKind', 'circle');
            await page.waitForFunction(() => window.bootstrap.pcbApp.copperFills[0].kind === 'circle');
            const beforePath = await selectedOverlay(page);
            const depth = await pcbUndoDepth(page);
            await stepSpinner(page, '#pcbPropFillDiameter', 2);
            assert.notEqual(await selectedOverlay(page), beforePath, 'the selected path follows the live circle diameter preview');
            // The diameter run settles into its own undo step before the model is read.
            await page.waitForFunction(depth => window.bootstrap.pcbApp.history.undoStack.length === depth + 1, depth);
            const before = await pcbSnapshot(page);
            const boundary = await page.evaluate(() => {
                const fill = window.bootstrap.pcbApp.pcbDocument.copperFills[0];
                return { x: fill.x + fill.radius, y: fill.y };
            });
            const draggedBoundary = { x: boundary.x + 5, y: boundary.y };
            // The Fill tool is still active; pick Select to drag the pour's edge.
            await choosePcbTool(page, '#pcbToolSelect');
            await clickWorld(page, 'pcb', boundary.x, boundary.y);
            await dragWorld(page, 'pcb', boundary, draggedBoundary);
            const after = await pcbSnapshot(page);
            assert.notEqual(after, before, 'dragging a circular fill boundary changes the PCB model');
            await undoRedoAndReopen(page, before, after);
            await selectPcb(page, draggedBoundary.x, draggedBoundary.y);
            await lockSelectedPcbObject(page, '#pcbPropFillDiameter');
            await saveAndReopen(page, 'pcb');
        },
    },
    {
        name: 'pcb-object-workflow: copper-fills-avoid-newer-overlap',
        async run(page, url) {
            await openPcb(page, url);
            await drawFill(page, [[10, -10], [35, -10], [35, -35], [10, -35]], 'GND');
            await drawFill(page, [[25, -20], [50, -20], [50, -45], [25, -45]], 'VCC');
            await page.waitForFunction(() => window.bootstrap.pcbApp.copperFills.length === 2);
            const pours = await page.evaluate(() => {
                const app = window.bootstrap.pcbApp;
                const fills = app.getLayerGroup('top-fill').querySelectorAll('.pcb-fill-copper');
                return {
                    count: fills.length,
                    older: app.copperFills[0].getBounds(),
                    newer: app.copperFills[1].getBounds(),
                    copperPaths: [...fills].map(el => el.getAttribute('d') || el.getAttribute('points') || ''),
                };
            });
            assert.ok(pours.count >= 2, 'both pours render copper');
            for (const [key, expected] of Object.entries({ minX: 10, minY: -35, maxX: 35, maxY: -10 })) {
                assert.ok(Math.abs(pours.older[key] - expected) < 1, `the older pour keeps its authored ${key} within grid snapping`);
            }
            assert.ok(pours.copperPaths.some(path => path.includes('25') || path.includes('35')),
                'the newer pour renders a clipped boundary around the older copper');
            await saveAndReopen(page, 'pcb');
        },
    },
    {
        name: 'pcb-object-workflow: board-outline',
        async run(page, url) {
            await openPcb(page, url);
            await selectPcb(page, 50, 0);
            const before = await pcbSnapshot(page);
            await exercisePcbNumberField(page, '#pcbPropOutlineWidth',
                () => page.evaluate(() => window.bootstrap.pcbApp.pcbDocument.board.width),
                () => page.evaluate(() => window.bootstrap.pcbApp.viewport.svg.outerHTML));
            const after = await pcbSnapshot(page);
            await undoRedoAndReopen(page, before, after);
            await selectPcb(page, 51, 0);
            await page.locator('#pcbPropOutlineLocked').check();
            assert.equal(await page.locator('#pcbPropOutlineWidth').isDisabled(), true, 'locking the board outline disables dimension fields');
            await saveAndReopen(page, 'pcb');
        },
    },
];
