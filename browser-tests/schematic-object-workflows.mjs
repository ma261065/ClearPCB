import assert from 'node:assert/strict';
import {
    viewportSettled,
    chooseSchematicTool,
    clickWorld,
    dragWorld,
    exerciseSchematicNumberField,
    openSchematic,
    redoSchematic,
    saveAndReopen,
    schematicSnapshot,
    screenPoint,
    undoSchematic,
} from './helpers/editor-helpers.mjs';

const p = (x, y) => ({ x, y });
const add = (origin, [x, y]) => [origin.x + x, origin.y + y];
const addPoint = (origin, point) => ({ x: origin.x + point.x, y: origin.y + point.y });

// The view may still be fitting after the editor opens; measure once it has settled.
const viewCentre = async page => {
    await viewportSettled(page, 'schematic');
    return page.evaluate(() => {
        const viewport = window.bootstrap.schematicApp.viewport;
        const rect = viewport.svg.getBoundingClientRect();
        const world = viewport.screenToWorld({ x: rect.width / 2, y: rect.height / 2 });
        return { x: Math.round(world.x), y: Math.round(world.y) };
    });
};

const selectionVisual = page => page.evaluate(() => window.bootstrap.schematicApp.viewport.svg.outerHTML);
const selected = page => page.evaluate(() => window.bootstrap.schematicApp.selection.getSelection().map(item => ({
    type: item.type || 'component', id: item.id, x: item.x, y: item.y,
})));

async function selectAt(page, x, y) {
    await chooseSchematicTool(page, 'select');
    await clickWorld(page, 'schematic', x, y);
}

async function undoRedoReopen(page, before, after) {
    await undoSchematic(page, before);
    assert.equal(await schematicSnapshot(page), before, 'Undo restores the previous schematic model exactly');
    await redoSchematic(page, after);
    assert.equal(await schematicSnapshot(page), after, 'Redo restores the edited schematic model exactly');
    await saveAndReopen(page, 'schematic');
}

async function drawSchematicShape(page, tool, points) {
    await chooseSchematicTool(page, tool);
    for (const [x, y] of points) await clickWorld(page, 'schematic', x, y);
    if (tool === 'line' || tool === 'polygon') {
        const [x, y] = points.at(-1);
        const point = await screenPoint(page, 'schematic', x, y);
        await page.mouse.dblclick(point.x, point.y);
    }
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.bootstrap.schematicApp.shapes.length > 0);
}

async function exerciseMoveLockSave(page, from, to, editField) {
    const before = await schematicSnapshot(page);
    await dragWorld(page, 'schematic', from, to);
    const after = await schematicSnapshot(page);
    assert.notEqual(after, before, 'dragging the selected schematic object changes the model');
    await undoRedoReopen(page, before, after);
    await page.keyboard.press('Control+a');
    const lock = page.locator('[data-prop="locked"] input[type="checkbox"]').first();
    await lock.check();
    assert.equal(await page.locator(editField).isDisabled(), true, 'locked schematic object disables its edit field');
    await saveAndReopen(page, 'schematic');
}

export const scenarios = [
    {
        name: 'schematic-object-workflow: wire',
        async run(page, url) {
            await openSchematic(page, url);
            const c = await viewCentre(page);
            await chooseSchematicTool(page, 'wire');
            await clickWorld(page, 'schematic', c.x - 20, c.y);
            await clickWorld(page, 'schematic', c.x + 10, c.y);
            await page.keyboard.press('Enter');
            await page.keyboard.press('Escape');
            await selectAt(page, c.x - 10, c.y);
            await page.locator('#prop_net').fill('SIG');
            await page.locator('#prop_net').press('Enter');
            await page.waitForFunction(() => window.bootstrap.schematicApp.shapes[0].net === 'SIG');
            const before = await schematicSnapshot(page);
            await dragWorld(page, 'schematic', p(c.x - 10, c.y), p(c.x - 5, c.y + 6));
            const after = await schematicSnapshot(page);
            assert.notEqual(after, before);
            await undoRedoReopen(page, before, after);
            await selectAt(page, c.x - 5, c.y + 6);
            await page.locator('[data-prop="locked"] input[type="checkbox"]').first().check();
            assert.equal(await page.locator('#prop_net').isDisabled(), true);
            await saveAndReopen(page, 'schematic');
        },
    },
    {
        name: 'schematic-object-workflow: net-label',
        async run(page, url) {
            await openSchematic(page, url);
            const c = await viewCentre(page);
            await chooseSchematicTool(page, 'net');
            await clickWorld(page, 'schematic', c.x, c.y);
            await selectAt(page, c.x, c.y);
            await exerciseSchematicNumberField(page, '#prop_fontSize',
                () => page.evaluate(() => window.bootstrap.schematicApp.shapes.find(s => s.type === 'net').fontSize),
                () => selectionVisual(page));
            await page.locator('#prop_net').fill('VCC');
            await page.locator('#prop_net').press('Enter');
            await page.waitForFunction(() => window.bootstrap.schematicApp.shapes.find(s => s.type === 'net').net === 'VCC');
            await exerciseMoveLockSave(page, p(c.x, c.y), p(c.x + 8, c.y + 6), '#prop_fontSize');
        },
    },
    {
        name: 'schematic-object-workflow: text',
        async run(page, url) {
            await openSchematic(page, url);
            const c = await viewCentre(page);
            await chooseSchematicTool(page, 'text');
            await clickWorld(page, 'schematic', c.x, c.y);
            await page.keyboard.type('NOTE');
            await page.keyboard.press('Escape');
            // Text is picked up at its anchor (where it was placed).
            const anchor = () => page.evaluate(() => {
                const text = window.bootstrap.schematicApp.shapes.find(s => s.type === 'text');
                return { x: text.x, y: text.y };
            });
            // Placing text leaves it selected, ready to edit in Properties.
            assert.equal((await selected(page))[0]?.type, 'text');
            await exerciseSchematicNumberField(page, '#prop_fontSize',
                () => page.evaluate(() => window.bootstrap.schematicApp.shapes.find(s => s.type === 'text').fontSize),
                () => selectionVisual(page));
            // The Text tool is still active; pick Select to move the text.
            await chooseSchematicTool(page, 'select');
            const from = await anchor();
            await exerciseMoveLockSave(page, from, p(from.x + 8, from.y + 6), '#prop_fontSize');
        },
    },
    ...[
        ['line', [[10, 10], [35, 10]], p(20, 10), p(26, 16)],
        ['rect', [[10, 10], [35, 24]], p(20, 10), p(26, 16)],
        ['circle', [[20, 20], [30, 20]], p(30, 20), p(36, 26)],
        ['polygon', [[10, 10], [35, 10], [25, 25], [10, 10]], p(22, 11), p(28, 17)],
        ['arc', [[10, 20], [35, 20], [22, 10]], p(22, 16), p(28, 22)],
    ].map(([tool, points, selectPoint, dragTo]) => ({
        name: `schematic-object-workflow: shape-${tool}`,
        async run(page, url) {
            await openSchematic(page, url);
            const c = await viewCentre(page);
            await drawSchematicShape(page, tool, points.map(value => add(c, value)));
            // An arc is selected on its curve: its third (bulge) point lies on it.
            const selectedPoint = tool === 'arc' ? p(...add(c, points[2])) : addPoint(c, selectPoint);
            const dragPoint = tool === 'arc' ? addPoint(selectedPoint, dragTo) : addPoint(c, dragTo);
            await selectAt(page, selectedPoint.x, selectedPoint.y);
            const field = tool === 'circle' ? '#prop_diameter' : '#prop_lineWidth';
            const read = tool === 'circle'
                ? () => page.evaluate(() => window.bootstrap.schematicApp.shapes.find(s => s.type === 'circle').radius)
                : () => page.evaluate(() => window.bootstrap.schematicApp.shapes.find(s => s.type !== 'text' && s.type !== 'net').lineWidth);
            await exerciseSchematicNumberField(page, field, read, () => selectionVisual(page));
            await exerciseMoveLockSave(page, selectedPoint, dragPoint, field);
        },
    })),
    {
        name: 'schematic-object-workflow: component',
        async run(page, url) {
            await openSchematic(page, url);
            await chooseSchematicTool(page, 'component');
            await page.locator('.cp-mode-btn[data-mode="local"]').click();
            await page.locator('.cp-search-input').fill('LED');
            await page.locator('.cp-item').first().click();
            await page.locator('.cp-place-btn').click();
            // The part follows the pointer once the editor is ready to place it.
            await page.waitForFunction(() => !!window.bootstrap.schematicApp.placingComponent);
            // The picker panel resizes the canvas; place once the view has settled.
            await viewportSettled(page, 'schematic');
            // The picker panel stays open over part of the canvas: place on an exposed point.
            const target = await page.evaluate(() => {
                const svg = window.bootstrap.schematicApp.viewport.svg;
                const rect = svg.getBoundingClientRect();
                for (const fx of [0.25, 0.35, 0.5, 0.15]) for (const fy of [0.5, 0.35, 0.65]) {
                    const x = rect.left + rect.width * fx, y = rect.top + rect.height * fy;
                    const hit = document.elementFromPoint(x, y);
                    if (hit && (hit === svg || svg.contains(hit))) return { x, y };
                }
                return null;
            });
            assert.ok(target, 'part of the canvas is exposed beside the picker');
            // The part's ghost follows the pointer; move there, then click to place it.
            await page.mouse.move(target.x - 40, target.y - 40);
            await page.mouse.move(target.x, target.y, { steps: 8 });
            await page.mouse.click(target.x, target.y);
            // Placing may first ask for the part's value: confirm it once it appears.
            const valueOk = page.locator('.value-dialog-btn.primary');
            await page.waitForFunction(() => window.bootstrap.schematicApp.components.length === 1
                || document.querySelector('.value-dialog-btn.primary'));
            if (await valueOk.count()) await valueOk.click();
            await page.waitForFunction(() => window.bootstrap.schematicApp.components.length === 1);
            await page.keyboard.press('Escape');
            // Click the symbol body where no reference/value text covers it.
            const selectPart = async () => {
                const points = await page.evaluate(() => {
                    const part = window.bootstrap.schematicApp.components[0];
                    const b = part._getLocalBounds();
                    return [[0.5, 0.5], [0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75]]
                        .map(([fx, fy]) => part.localToWorld(b.minX + (b.maxX - b.minX) * fx, b.minY + (b.maxY - b.minY) * fy));
                });
                for (const point of points) {
                    await selectAt(page, point.x, point.y);
                    if ((await selected(page))[0]?.type === 'component') return;
                }
                assert.fail('the placed component can be selected by clicking its symbol');
            };
            await selectPart();
            const before = await schematicSnapshot(page);
            // A component rotates with its Transform buttons.
            await page.locator('#propRotateRight').click();
            await page.waitForFunction(() => window.bootstrap.schematicApp.components[0].rotation !== 0);
            const after = await schematicSnapshot(page);
            await undoRedoReopen(page, before, after);
            await selectPart();
            await page.locator('[data-prop="locked"] input[type="checkbox"]').first().check();
            assert.equal(await page.locator('#propRotateRight').isDisabled(), true, 'a locked component offers no transform');
            await saveAndReopen(page, 'schematic');
        },
    },
    {
        name: 'schematic-component-search-keeps-the-editor-in-place',
        async run(page, url) {
            await openSchematic(page, url);
            const layout = () => page.evaluate(() => {
                const slider = document.querySelector('.app-slider').getBoundingClientRect();
                const svg = window.bootstrap.schematicApp.viewport.svg.getBoundingClientRect();
                return { svgLeft: Math.round(svg.left), sliderBottom: Math.round(slider.bottom), scrollY: window.scrollY,
                    windowHeight: window.innerHeight };
            });
            const start = await layout();
            assert.equal(start.sliderBottom, start.windowHeight, 'the editors fill the window exactly (status bar visible)');
            await chooseSchematicTool(page, 'component');
            await page.locator('.cp-mode-btn[data-mode="local"]').click();
            await page.locator('.cp-search-input').fill('LED');
            assert.deepEqual(await layout(), start,
                'typing in the component search scrolls neither the editors sideways nor the page');
        },
    },
];
