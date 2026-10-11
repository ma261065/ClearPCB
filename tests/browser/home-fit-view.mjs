import assert from 'node:assert/strict';
import { openPcb, openSchematic, viewportSettled } from './helpers/editor-helpers.mjs';

export const scenarios = [{
    name: 'home-key-opens-home-and-matches-fit-in-both-editors',
    async run(page, url) {
        for (const editor of ['schematic', 'pcb']) {
            if (editor === 'schematic') await openSchematic(page, url);
            else await openPcb(page, url);
            await page.evaluate(async editor => {
                const app = editor === 'schematic' ? window.bootstrap.schematicApp : window.bootstrap.pcbApp;
                if (editor === 'schematic') {
                    const { createRect } = await import('/src/shapes/polyline.js');
                    app.shapes.push(createRect({ x: 150, y: -100, width: 60, height: 40 }));
                    app.updateSelectableItems();
                    app.renderShapes(true);
                }
                app.setActiveRibbonTab(editor === 'schematic' ? 'home' : 'pcb-home');
            }, editor);
            assert.equal(await page.locator(editor === 'schematic' ? '#resetView' : '#pcbResetView').count(), 0,
                `${editor}: Default view is removed`);
            await page.locator(editor === 'schematic' ? '#zoomFit' : '#pcbZoomFit').click();
            await viewportSettled(page, editor);
            const expected = await page.evaluate(editor => {
                const app = editor === 'schematic' ? window.bootstrap.schematicApp : window.bootstrap.pcbApp;
                return { ...app.viewport.viewBox };
            }, editor);
            const before = await page.evaluate(async editor => {
                const app = editor === 'schematic' ? window.bootstrap.schematicApp : window.bootstrap.pcbApp;
                if (editor === 'schematic') app.selectTool('polygon');
                else (await import('/src/pcb/modules/tool-lifecycle.js')).selectPcbTool(app, 'track');
                app.viewport.zoomIn();
                app.viewport.startPan(200, 200);
                app.viewport.updatePan(320, 260);
                app.viewport.endPan();
                app.setActiveRibbonTab(editor === 'schematic' ? 'help' : 'pcb-design');
                document.activeElement?.blur();
                return { ...app.viewport.viewBox };
            }, editor);
            assert.notDeepEqual(before, expected, 'Fixture starts away from the fitted view');
            await page.keyboard.press('Home');
            await viewportSettled(page, editor);
            const result = await page.evaluate(editor => {
                const app = editor === 'schematic' ? window.bootstrap.schematicApp : window.bootstrap.pcbApp;
                const ribbon = document.getElementById(editor === 'schematic' ? 'ribbonSchematic' : 'ribbonPCB');
                return { viewBox: { ...app.viewport.viewBox }, leftInset: app.viewport.showRulers
                    ? app.viewport.rulerSize / app.viewport.scale : 0, tab: ribbon.querySelector('.ribbon-tab.active').dataset.tab,
                    tool: app.currentTool };
            }, editor);
            assert.deepEqual(result.viewBox, expected, `${editor}: Home uses exactly the Fit operation`);
            assert.equal(result.tab, editor === 'schematic' ? 'home' : 'pcb-home');
            assert.equal(result.tool, 'select', `${editor}: Home activates Select`);
            assert.equal(await page.locator(editor === 'schematic'
                ? '#ribbonSchematic [data-tool="select"]' : '#pcbToolSelect').evaluate(button =>
                button.classList.contains('active')), true, 'Select button reflects the active tool');
            assert.ok(Math.abs(result.viewBox.x + result.leftInset + 10) < 1e-9,
                `${editor}: Fit has a 10 mm left offset inside the ruler`);
            assert.ok(Math.abs(result.viewBox.y + result.viewBox.height - 10) < 1e-9,
                `${editor}: Fit uses the same 10 mm bottom offset`);
            await page.evaluate(editor => {
                const app = editor === 'schematic' ? window.bootstrap.schematicApp : window.bootstrap.pcbApp;
                app.setActiveRibbonTab(editor === 'schematic' ? 'help' : 'pcb-design');
                const input = document.createElement('textarea');
                input.id = 'home-text-probe';
                input.style.cssText = 'position:fixed;left:0;top:0';
                input.value = 'abcdef';
                document.body.appendChild(input);
                input.focus();
                input.setSelectionRange(6, 6);
            }, editor);
            await viewportSettled(page, editor);
            const beforeInput = await page.evaluate(editor => {
                const app = editor === 'schematic' ? window.bootstrap.schematicApp : window.bootstrap.pcbApp;
                return { ...app.viewport.viewBox };
            }, editor);
            await page.keyboard.press('Home');
            assert.equal(await page.locator('#home-text-probe').evaluate(input => input.selectionStart), 0,
                'Home retains native cursor movement while typing');
            const afterInput = await page.evaluate(editor => {
                const app = editor === 'schematic' ? window.bootstrap.schematicApp : window.bootstrap.pcbApp;
                const ribbon = document.getElementById(editor === 'schematic' ? 'ribbonSchematic' : 'ribbonPCB');
                document.getElementById('home-text-probe').remove();
                return { viewBox: { ...app.viewport.viewBox }, tab: ribbon.querySelector('.ribbon-tab.active').dataset.tab };
            }, editor);
            assert.deepEqual(afterInput.viewBox, beforeInput);
            assert.equal(afterInput.tab, editor === 'schematic' ? 'help' : 'pcb-design',
                'Home inside a text input does not navigate ribbon tabs');
            const start = await page.evaluate(async editor => {
                const app = editor === 'schematic' ? window.bootstrap.schematicApp : window.bootstrap.pcbApp;
                if (editor === 'schematic') app.selectTool('polygon');
                else (await import('/src/pcb/modules/tool-lifecycle.js')).selectPcbTool(app, 'track');
                const box = app.viewport.svg.getBoundingClientRect();
                return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
            }, editor);
            await page.mouse.click(start.x, start.y);
            await page.mouse.move(start.x + 30, start.y + 20);
            const drawingState = () => page.evaluate(async editor => {
                const app = editor === 'schematic' ? window.bootstrap.schematicApp : window.bootstrap.pcbApp;
                const drawing = editor === 'schematic'
                    ? (await import('/src/schematic/modules/drawing.js')).isSchematicDrawingActive(app)
                    : !!(await import('/src/pcb/modules/track-draw.js')).getTrackDraw(app);
                return { drawing, count: editor === 'schematic' ? app.shapes.length : app.tracks.length,
                    tool: app.currentTool };
            }, editor);
            const during = await drawingState();
            assert.equal(during.drawing, true, `${editor}: an unfinished drawing is active`);
            await page.keyboard.press('Home');
            assert.deepEqual(await drawingState(), { drawing: false, count: during.count, tool: 'select' },
                `${editor}: Home cancels unfinished drawing through normal tool selection without creating an object`);
            await viewportSettled(page, editor);
            const settledOffsets = await page.evaluate(editor => {
                const viewport = (editor === 'schematic' ? window.bootstrap.schematicApp : window.bootstrap.pcbApp).viewport;
                const rect = viewport.svg.getBoundingClientRect();
                const origin = viewport.svg.createSVGPoint().matrixTransform(viewport.svg.getScreenCTM());
                const inset = viewport.showRulers ? viewport.rulerSize : 0;
                return { left: (origin.x - rect.left - inset) / viewport.scale,
                    bottom: (rect.bottom - origin.y) / viewport.scale, scale: viewport.scale };
            }, editor);
            assert.ok(Math.abs(settledOffsets.left - 10) * settledOffsets.scale < 0.5,
                `${editor}: rendered left offset is 10 mm after layout settles (${JSON.stringify(settledOffsets)})`);
            assert.ok(Math.abs(settledOffsets.bottom - 10) * settledOffsets.scale < 0.5,
                `${editor}: rendered bottom offset is 10 mm after layout settles (${JSON.stringify(settledOffsets)})`);
        }
    },
}, {
    name: 'schematic-home-keeps-fit-margins-for-empty-and-selected-content',
    async run(page, url) {
        await openSchematic(page, url);
        await page.keyboard.press('Home');
        await viewportSettled(page, 'schematic');
        const offsets = () => page.evaluate(() => {
            const viewport = window.bootstrap.schematicApp.viewport;
            const rect = viewport.svg.getBoundingClientRect();
            const point = viewport.svg.createSVGPoint();
            const origin = point.matrixTransform(viewport.svg.getScreenCTM());
            const inset = viewport.showRulers ? viewport.rulerSize : 0;
            return { left: (origin.x - rect.left - inset) / viewport.scale, bottom: (rect.bottom - origin.y) / viewport.scale,
                inset, scale: viewport.scale, width: rect.width, height: rect.height, viewBox: { ...viewport.viewBox } };
        });
        const empty = await offsets();
        assert.ok(Math.abs(empty.viewBox.x + empty.inset / empty.scale + 10) < 1e-9);
        assert.ok(Math.abs(empty.viewBox.y + empty.viewBox.height - 10) < 1e-9);
        assert.ok(Math.abs(empty.left - 10) * empty.scale < 0.5 && Math.abs(empty.bottom - 10) * empty.scale < 0.5,
            `Empty schematic Home has the PCB's exact 10 mm offsets (${JSON.stringify(empty)})`);
        await page.evaluate(async () => {
            const app = window.bootstrap.schematicApp;
            const { createRect } = await import('/src/shapes/polyline.js');
            const shape = createRect({ x: 15, y: -65, width: 70, height: 40 });
            app.shapes.push(shape);
            app.updateSelectableItems();
            app.selection.select(shape);
            app.renderShapes(true);
        });
        await viewportSettled(page, 'schematic');
        await page.keyboard.press('Home');
        await viewportSettled(page, 'schematic');
        const selected = await offsets();
        assert.ok(Math.abs(selected.viewBox.x + selected.inset / selected.scale + 10) < 1e-9);
        assert.ok(Math.abs(selected.viewBox.y + selected.viewBox.height - 10) < 1e-9);
        assert.ok(Math.abs(selected.left - 10) * selected.scale < 0.5 && Math.abs(selected.bottom - 10) * selected.scale < 0.5,
            `Home from selected-object Properties retains Fit offsets (${JSON.stringify(selected)})`);
    },
}, {
    name: 'help-lists-home-and-space-no-longer-fits-either-editor',
    async run(page, url) {
        for (const editor of ['schematic', 'pcb']) {
            if (editor === 'schematic') await openSchematic(page, url);
            else await openPcb(page, url);
            const helpTab = editor === 'schematic' ? 'help' : 'pcb-help';
            const homeTab = editor === 'schematic' ? 'home' : 'pcb-home';
            const ribbon = page.locator(editor === 'schematic' ? '#ribbonSchematic' : '#ribbonPCB');
            await ribbon.locator(`[data-tab="${helpTab}"]`).click();
            const help = ribbon.locator('.ribbon-panel.active');
            assert.equal(await help.locator('.help-row').filter({ has: page.locator('kbd', { hasText: /^Home$/ }) })
                .textContent(), 'Home Select tool, Home tab and fit view');
            assert.equal(await help.locator('.help-row').filter({ hasText: /^Space.*Fit/i }).count(), 0,
                'Help no longer advertises Space-to-Fit');
            await ribbon.locator(`[data-tab="${homeTab}"]`).click();
            await page.evaluate(editor => {
                const app = editor === 'schematic' ? window.bootstrap.schematicApp : window.bootstrap.pcbApp;
                window.__originalFit = app.fitToContent;
                window.__fitCalls = 0;
                app.fitToContent = function() {
                    window.__fitCalls++;
                    return window.__originalFit.call(this);
                };
            }, editor);
            try {
                for (const tool of ['select', editor === 'schematic' ? 'polygon' : 'track']) {
                    await page.evaluate(async ({ editor, tool }) => {
                        const app = editor === 'schematic' ? window.bootstrap.schematicApp : window.bootstrap.pcbApp;
                        if (editor === 'schematic') app.selectTool(tool);
                        else (await import('/src/pcb/modules/tool-lifecycle.js')).selectPcbTool(app, tool);
                        app.viewport.zoomIn();
                        app.viewport.startPan(200, 200);
                        app.viewport.updatePan(310, 250);
                        app.viewport.endPan();
                        document.activeElement?.blur();
                    }, { editor, tool });
                    await viewportSettled(page, editor);
                    const snapshot = () => page.evaluate(editor => {
                        const app = editor === 'schematic' ? window.bootstrap.schematicApp : window.bootstrap.pcbApp;
                        const ribbon = document.getElementById(editor === 'schematic' ? 'ribbonSchematic' : 'ribbonPCB');
                        return { viewBox: { ...app.viewport.viewBox }, tool: app.currentTool,
                            tab: ribbon.querySelector('.ribbon-tab.active').dataset.tab, calls: window.__fitCalls };
                    }, editor);
                    const before = await snapshot();
                    await page.keyboard.press('Space');
                    await viewportSettled(page, editor);
                    assert.deepEqual(await snapshot(), before, `${editor}/${tool}: Space does not fit, navigate or change tools`);
                }
                await page.keyboard.press('Home');
                assert.equal(await page.evaluate(() => window.__fitCalls), 1, 'Home still invokes Fit exactly once');
            } finally {
                await page.evaluate(editor => {
                    const app = editor === 'schematic' ? window.bootstrap.schematicApp : window.bootstrap.pcbApp;
                    app.fitToContent = window.__originalFit;
                    delete window.__originalFit;
                    delete window.__fitCalls;
                }, editor);
            }
        }
    },
}, {
    name: 'home-fit-margins-start-inside-the-rulers-at-different-zoom-levels',
    async run(page, url) {
        for (const editor of ['schematic', 'pcb']) {
            if (editor === 'schematic') await openSchematic(page, url);
            else await openPcb(page, url);
            if (editor === 'schematic') {
                await page.evaluate(async () => {
                    const app = window.bootstrap.schematicApp;
                    const { createRect } = await import('/src/shapes/polyline.js');
                    app.shapes.push(createRect({ x: 10, y: -70, width: 90, height: 60 }));
                    app.updateSelectableItems();
                    app.renderShapes(true);
                });
            }
            const scales = new Set();
            for (const size of [{ width: 800, height: 600 }, { width: 1400, height: 900 }, { width: 1900, height: 1200 }]) {
                await page.setViewportSize(size);
                await viewportSettled(page, editor);
                for (const rulers of [true, false]) {
                    await page.evaluate(({ editor, rulers }) => {
                        const app = editor === 'schematic' ? window.bootstrap.schematicApp : window.bootstrap.pcbApp;
                        app.viewport.showRulers = rulers;
                        app.viewport._createRulers();
                        app.viewport.zoomOut();
                        app.viewport.startPan(200, 200);
                        app.viewport.updatePan(300, 240);
                        app.viewport.endPan();
                        app.setActiveRibbonTab(editor === 'schematic' ? 'help' : 'pcb-design');
                        document.activeElement?.blur();
                    }, { editor, rulers });
                    await page.keyboard.press('Home');
                    await viewportSettled(page, editor);
                    const margins = await page.evaluate(editor => {
                        const viewport = (editor === 'schematic' ? window.bootstrap.schematicApp : window.bootstrap.pcbApp).viewport;
                        const rect = viewport.svg.getBoundingClientRect();
                        const transform = viewport.svg.getScreenCTM();
                        const origin = viewport.svg.createSVGPoint().matrixTransform(transform);
                        const border = viewport.showRulers ? [...viewport.rulerContainer.querySelectorAll('line')]
                            .find(line => Number(line.getAttribute('x1')) === viewport.rulerSize
                                && line.getAttribute('x1') === line.getAttribute('x2')
                                && Number(line.getAttribute('y1')) === 0
                                && Number(line.getAttribute('y2')) > viewport.rulerSize)
                            .getBoundingClientRect().right : rect.left;
                        return { left: (origin.x - border) / transform.a,
                            bottom: (rect.bottom - origin.y) / transform.d,
                            scale: transform.a, expectedInset: viewport.showRulers ? viewport.rulerSize : 0,
                            actualInset: border - rect.left };
                    }, editor);
                    scales.add(margins.scale.toFixed(3));
                    assert.ok(Math.abs(margins.actualInset - margins.expectedInset) < 0.5,
                        'Measurement starts at the rendered ruler border');
                    assert.ok(Math.abs(margins.left - 10) * margins.scale < 0.5,
                        `${editor}/${size.width}/${rulers}: 10 mm from ruler's inner edge (${JSON.stringify(margins)})`);
                    assert.ok(Math.abs(margins.bottom - 10) * margins.scale < 0.5,
                        `${editor}: bottom remains 10 mm from viewport edge (${JSON.stringify(margins)})`);
                }
            }
            assert.ok(scales.size > 1, 'Ruler-aware offsets are verified at multiple actual fit scales');
        }
    },
}];
