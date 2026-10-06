import assert from 'node:assert/strict';

export async function openPcb(page, url) {
    await page.goto(`${url}index.html`);
    await page.waitForFunction(() => window.bootstrap?.pcbApp && window.bootstrap?.schematicApp);
    if (await page.locator('#startupSplash').isVisible()) await page.locator('#startupContinue').click();
    await page.locator('.mode-tab[data-mode="pcb"]').click();
    const ok = page.locator('.app-modal-overlay button', { hasText: 'OK' });
    if (await ok.count()) {
        await ok.first().waitFor();
        await ok.first().click();
    }
    await page.waitForFunction(() => window.bootstrap.pcbApp.isBoardOutlineDrawn());
    await viewportSettled(page, 'pcb');
}

export async function openSchematic(page, url) {
    await page.goto(`${url}index.html`);
    await page.waitForFunction(() => window.bootstrap?.pcbApp && window.bootstrap?.schematicApp);
    if (await page.locator('#startupSplash').isVisible()) await page.locator('#startupContinue').click();
    await page.locator('.mode-tab[data-mode="schematic"]').click();
    await page.waitForFunction(() => window.bootstrap.schematicApp.viewport?.svg);
    await viewportSettled(page, 'schematic');
}

/**
 * Forget the open project and saved app state, so the next open starts fresh rather
 * than offering to recover an autosave. For scenarios that reload the page.
 */
export async function clearSavedState(page) {
    await page.evaluate(() => {
        try { window.bootstrap?.project?.fileManager?.setDirty?.(false); } catch { /* not loaded yet */ }
        for (const key of Object.keys(localStorage)) if (key.startsWith('clearpcb_')) localStorage.removeItem(key);
    }).catch(() => {});
}

/** World point at the middle of an editor's view, rounded to whole millimetres, once the view has settled. */
export async function viewCentre(page, editor = 'schematic') {
    await viewportSettled(page, editor);
    return page.evaluate(editor => {
        const viewport = (editor === 'schematic' ? window.bootstrap.schematicApp : window.bootstrap.pcbApp).viewport;
        const rect = viewport.svg.getBoundingClientRect();
        const world = viewport.screenToWorld({ x: rect.width / 2, y: rect.height / 2 });
        return { x: Math.round(world.x), y: Math.round(world.y) };
    }, editor);
}

export async function viewportSettled(page, editor = 'pcb') {
    let previous = '';
    for (let attempt = 0; attempt < 50; attempt++) {
        const current = JSON.stringify(await screenPoint(page, editor, 0, 0))
            + JSON.stringify(await screenPoint(page, editor, 10, -10));
        if (current === previous) return;
        previous = current;
        await page.waitForTimeout(100);
    }
    throw new Error(`${editor} viewport did not settle`);
}

export function screenPoint(page, editor, x, y) {
    return page.evaluate(([editor, x, y]) => {
        const app = editor === 'schematic' ? window.bootstrap.schematicApp : window.bootstrap.pcbApp;
        const viewport = app.viewport;
        const screen = viewport.worldToScreen({ x, y });
        const rect = viewport.svg.getBoundingClientRect();
        return { x: rect.left + screen.x, y: rect.top + screen.y };
    }, [editor, x, y]);
}

export async function clickWorld(page, editor, x, y, options = {}) {
    const point = await screenPoint(page, editor, x, y);
    await page.mouse.move(point.x, point.y, { steps: options.steps ?? 2 });
    await page.mouse.click(point.x, point.y, { button: options.button || 'left', clickCount: options.clickCount || 1 });
}

export async function dragWorld(page, editor, from, to, steps = 8) {
    const start = await screenPoint(page, editor, from.x, from.y);
    const end = await screenPoint(page, editor, to.x, to.y);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps });
    await page.mouse.up();
}

export async function choosePcbTool(page, id) {
    await page.locator('[data-tab="pcb-home"]').click();
    await page.locator(id).click();
}

export async function choosePcbShape(page, kind) {
    await page.locator('[data-tab="pcb-home"]').click();
    await page.locator('#pcbToolShapesArrow').click();
    await page.locator(`#pcbToolShapesMenu [data-shape="${kind}"]`).click();
}

export async function chooseSchematicTool(page, tool) {
    const home = page.locator('#ribbonSchematic .ribbon-tab[data-tab="home"]');
    if (await home.count()) await home.click();
    await page.locator(`#ribbonSchematic [data-tool="${tool}"]`).click();
}

export const pcbTitle = page => page.locator('#pcbPropsContent .ribbon-group-title').textContent();
export const pcbRows = page => page.locator('#pcbPropsItems > .prop-row').evaluateAll(rows => rows.map(row => row.dataset.prop));
export const schematicTitle = page => page.locator('#ribbonSchematic .ribbon-panel[data-panel="properties"] .ribbon-group-title').first().textContent();
export const schematicRows = page => page.locator('#propertiesPanel .prop-row').evaluateAll(rows => rows.map(row => row.dataset.prop));

export function propertyField(page, idOrProp) {
    if (idOrProp.startsWith('#')) return page.locator(idOrProp);
    return page.locator(`#${idOrProp}, [data-prop="${idOrProp}"] input, [data-prop="${idOrProp}"] select, [data-prop="${idOrProp}"] textarea`).first();
}

export async function stepSpinner(page, selector, times = 1) {
    const box = await page.locator(selector).boundingBox();
    assert.ok(box, `Spinner ${selector} has a bounding box`);
    for (let index = 0; index < times; index++) {
        await page.mouse.click(box.x + box.width - 6, box.y + box.height / 4);
        await page.waitForTimeout(60);
    }
}

export const pcbSnapshot = page => page.evaluate(() => JSON.stringify(window.bootstrap.project.serialize().pcb));
export const schematicSnapshot = page => page.evaluate(() => JSON.stringify(window.bootstrap.project.serialize().schematic));
export const pcbUndoDepth = page => page.evaluate(() => window.bootstrap.pcbApp.history.undoStack.length);
export const schematicUndoDepth = page => page.evaluate(() => window.bootstrap.schematicApp.history.undoStack.length);

export async function undoPcb(page, expected) {
    await page.locator('[data-tab="pcb-home"]').click();
    await page.locator('#pcbUndoBtn').click();
    if (expected) await page.waitForFunction(text => JSON.stringify(window.bootstrap.project.serialize().pcb) === text, expected);
}

export async function redoPcb(page, expected) {
    await page.locator('[data-tab="pcb-home"]').click();
    await page.locator('#pcbRedoBtn').click();
    if (expected) await page.waitForFunction(text => JSON.stringify(window.bootstrap.project.serialize().pcb) === text, expected);
}

export async function undoSchematic(page, expected) {
    const home = page.locator('#ribbonSchematic .ribbon-tab[data-tab="home"]');
    if (await home.count()) await home.click();
    await page.locator('#undoBtn').click();
    if (expected) await page.waitForFunction(text => JSON.stringify(window.bootstrap.project.serialize().schematic) === text, expected);
}

export async function redoSchematic(page, expected) {
    const home = page.locator('#ribbonSchematic .ribbon-tab[data-tab="home"]');
    if (await home.count()) await home.click();
    await page.locator('#redoBtn').click();
    if (expected) await page.waitForFunction(text => JSON.stringify(window.bootstrap.project.serialize().schematic) === text, expected);
}

export async function saveAndReopen(page, editor) {
    const expected = await page.evaluate(editor => JSON.stringify(window.bootstrap.project.serialize()[editor]), editor);
    await page.waitForFunction(([editor, expected]) => {
        const saved = localStorage.getItem('clearpcb_autosave_untitled.cpcb');
        return saved && JSON.stringify(JSON.parse(saved).data?.[editor]) === expected;
    }, [editor, expected], { timeout: 30000 });
    await page.reload();
    const recover = page.locator('.app-modal-overlay button', { hasText: 'Yes' });
    try {
        await recover.waitFor({ timeout: 3000 });
        await recover.click();
    } catch {
        // Some reload paths restore the autosave without prompting.
    }
    await page.waitForFunction(() => window.bootstrap?.pcbApp && window.bootstrap?.schematicApp
        && !window.bootstrap.project.fileManager.loading);
    await page.locator(`.mode-tab[data-mode="${editor === 'pcb' ? 'pcb' : 'schematic'}"]`).click();
    if (editor === 'pcb') {
        await page.waitForFunction(() => window.bootstrap.pcbApp._active && window.bootstrap.pcbApp.isBoardOutlineDrawn());
        await viewportSettled(page, 'pcb');
    } else {
        await page.waitForFunction(() => window.bootstrap.schematicApp.viewport?.svg);
    }
    assert.equal(await page.evaluate(editor => JSON.stringify(window.bootstrap.project.serialize()[editor]), editor), expected,
        `${editor} model survives autosave recovery`);
    return expected;
}

export async function exercisePcbNumberField(page, selector, readValue, selectedVisual, { steps = 2, waitMs = 700 } = {}) {
    const startValue = await readValue();
    const startVisual = await selectedVisual();
    const startUndo = await pcbUndoDepth(page);
    await stepSpinner(page, selector, steps);
    assert.equal(await readValue(), startValue, `${selector} does not mutate the model during the spinner run`);
    assert.equal(await pcbUndoDepth(page), startUndo, `${selector} adds no undo step during the spinner run`);
    assert.notEqual(await selectedVisual(), startVisual, `${selector} updates the visible selected outline during the spinner run`);
    await page.waitForFunction(([startUndo]) => window.bootstrap.pcbApp.history.undoStack.length === startUndo + 1, [startUndo],
        { timeout: waitMs + 1500 });
    assert.notEqual(await readValue(), startValue, `${selector} commits after the spinner run settles`);
}

export async function exerciseSchematicNumberField(page, selector, readValue, selectedVisual, { steps = 2, waitMs = 700 } = {}) {
    // Choosing a tool shows the Home tab; a user opens Properties to edit the selection.
    const properties = page.locator('#ribbonSchematic .ribbon-tab[data-tab="properties"]');
    if (await properties.count() && !await page.locator(selector).isVisible()) await properties.click();
    const startValue = await readValue();
    const input = page.locator(selector);
    const current = Number(await input.inputValue());
    const step = Number(await input.getAttribute('step')) || 0.5;
    await input.fill(String(current + step * steps));
    await input.press('Enter');
    await input.blur();
    await page.waitForFunction(([selector, startValue]) => {
        const input = document.querySelector(selector);
        return input && Number(input.value) !== startValue;
    }, [selector, startValue], { timeout: waitMs + 1500 }).catch(() => {});
    // The run commits once it settles (Enter commits at once); wait for the model, not a fixed delay.
    const deadline = Date.now() + waitMs + 1500;
    while (await readValue() === startValue && Date.now() < deadline) await page.waitForTimeout(50);
    assert.notEqual(await readValue(), startValue, `${selector} commits after the spinner run settles`);
}
