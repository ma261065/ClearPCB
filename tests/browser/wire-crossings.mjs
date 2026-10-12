import assert from 'node:assert/strict';
import { openSchematic, viewCentre, waitForPage } from './helpers/editor-helpers.mjs';

export const scenarios = [{
    name: 'unconnected-wire-crossing-has-local-one-pixel-border',
    async run(page, url) {
        await openSchematic(page, url);
        await page.evaluate(async centre => {
            const app = window.bootstrap.schematicApp;
            const { Wire } = await import('/src/shapes/wire.js');
            const underpass = new Wire({ id: 'cross-underpass', lineWidth: 1,
                points: [{ x: centre.x - 20, y: centre.y - 20 }, { x: centre.x + 20, y: centre.y + 20 }] });
            const overpass = new Wire({ id: 'cross-overpass', lineWidth: 1,
                points: [{ x: centre.x - 20, y: centre.y }, { x: centre.x + 20, y: centre.y }] });
            app.shapes.push(underpass, overpass);
            app.updateSelectableItems();
            app.renderShapes(true);
        }, await viewCentre(page));
        const measure = () => page.evaluate(() => {
            const app = window.bootstrap.schematicApp;
            const group = document.querySelector('.wire-crossing-cues');
            const borders = [...group.querySelectorAll('.wire-crossing-border')];
            const probe = document.createElement('span');
            probe.style.color = 'var(--sch-background)';
            document.body.appendChild(probe);
            const attrs = line => ({
                x1: Number(line.getAttribute('x1')), y1: Number(line.getAttribute('y1')),
                x2: Number(line.getAttribute('x2')), y2: Number(line.getAttribute('y2')),
                width: Number(line.getAttribute('stroke-width')),
            });
            const result = { count: group.children.length, scale: app.viewport.scale,
                borders: borders.map(attrs),
                bottomWidth: app.shapes.find(shape => shape.id === 'cross-underpass').lineWidth,
                topWidth: app.shapes.find(shape => shape.id === 'cross-overpass').lineWidth,
                borderStroke: getComputedStyle(borders[0]).stroke,
                background: getComputedStyle(probe).color,
                pointerEvents: getComputedStyle(group).pointerEvents,
                selectionTolerancePx: app.selection._effectiveTolerance() * app.viewport.scale,
                topWire: borders[0].dataset.wireId };
            probe.remove();
            return result;
        });
        for (const theme of ['dark', 'light']) for (const zoom of [100, 5000, 10000]) {
            await page.evaluate(({ theme, zoom }) => {
                document.documentElement.setAttribute('data-theme', theme);
                const app = window.bootstrap.schematicApp;
                app.viewport.zoomToLevel(app.viewport.zoomPercents.indexOf(zoom), app.viewport.offset);
                app.renderShapes(true);
            }, { theme, zoom });
            await waitForPage(page, () => document.querySelectorAll('.wire-crossing-cues > line').length === 2);
            const result = await measure();
            assert.equal(result.count, 2);
            assert.equal(result.borders.length, 2);
            assert.ok(result.borders.every(border => Math.abs(border.width * result.scale - 1) < 1e-9),
                `${zoom}%: each side border is exactly one screen pixel`);
            assert.equal(result.borderStroke, result.background);
            assert.equal(result.pointerEvents, 'none');
            assert.ok(Math.abs(result.selectionTolerancePx - 6) < 1e-9,
                `${zoom}%: schematic hover margin remains six screen pixels`);
            assert.equal(result.topWire, 'cross-overpass',
                'The later-rendered wire receives the border because it is visually on top');
            const borderLengthPx = Math.hypot(result.borders[0].x2 - result.borders[0].x1,
                result.borders[0].y2 - result.borders[0].y1) * result.scale;
            assert.ok(borderLengthPx * Math.SQRT1_2 >= result.bottomWidth * result.scale + 2 - 1e-9,
                `${zoom}%: side borders span the full crossed-wire width`);
            const separationPx = Math.abs(result.borders[0].y1 - result.borders[1].y1) * result.scale;
            assert.ok(Math.abs(separationPx - (result.topWidth * result.scale + 1)) < 1e-9,
                `${zoom}%: borders remain parallel to the wire instead of forming crosswise dashes`);
            const borderMidpoints = result.borders.map(border => ({
                x: (border.x1 + border.x2) / 2,
                y: (border.y1 + border.y2) / 2,
            }));
            assert.ok(Math.abs(borderMidpoints[0].x - borderMidpoints[1].x) * result.scale > 1,
                `${zoom}%: angled crossing borders follow their distinct edge intersections`);
        }
        const hoverCue = await page.evaluate(() => {
            const app = window.bootstrap.schematicApp;
            const underpass = app.shapes.find(shape => shape.id === 'cross-underpass');
            app.selection.setHovered(underpass);
            app.renderShapes();
            return {
                borderCount: document.querySelectorAll('.wire-crossing-cues > .wire-crossing-border').length,
                foregroundCount: document.querySelectorAll('.wire-crossing-foreground').length,
                borderWire: document.querySelector('.wire-crossing-border').dataset.wireId,
            };
        });
        assert.deepEqual(hoverCue, {
            borderCount: 2,
            foregroundCount: 0,
            borderWire: 'cross-overpass',
        }, 'Hovering the lower wire neither adds a foreground box nor moves the border off the upper wire');
        await page.evaluate(() => {
            const app = window.bootstrap.schematicApp;
            const overpass = app.shapes.find(shape => shape.id === 'cross-overpass');
            const underpass = app.shapes.find(shape => shape.id === 'cross-underpass');
            app.selection.setHovered(null);
            const [first] = overpass.nodes.values();
            const [underStart, underEnd] = underpass.nodes.values();
            first.x = (underStart.x + underEnd.x) / 2;
            first.y = (underStart.y + underEnd.y) / 2;
            overpass.invalidate();
            app.renderShapes(true);
        });
        assert.equal(await page.locator('.wire-crossing-cues > line').count(), 0,
            'Crossing at an authored node has no nonconnection border');
    },
}];
