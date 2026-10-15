import assert from 'node:assert/strict';
import { openSchematic, screenPoint, viewCentre, viewportSettled, saveAndReopen } from './helpers/editor-helpers.mjs';

export const scenarios = [{
    name: 'same-name-component-variants-move-connect-autosave-and-reopen',
    async run(page, url) {
        await openSchematic(page, url);
        const setup = await page.evaluate(async centre => {
            const { Component } = await import('/src/components/Component.js');
            const { Wire } = await import('/src/shapes/wire.js');
            const { AddComponentCommand } = await import('/src/schematic/modules/commands.js');
            const app = window.bootstrap.schematicApp;
            const definition = (pinX, source) => ({
                name: 'LCSC_C7171', category: 'Test', _source: source,
                defaultReference: 'C?', defaultValue: '10uF',
                symbol: { width: 7.62, height: 4.064, origin: { x: 0, y: 0 },
                    pins: [{ number: '1', x: 0, y: 0 }, { number: '2', x: pinX, y: 0 }],
                    graphics: [3.302, 4.318].map(x => ({
                        type: 'polyline', points: [[Math.sign(pinX) * x, -2.032], [Math.sign(pinX) * x, 2.032]],
                    })),
                },
            });
            const old = new Component(definition(7.62, 'EasyEDA-Import'),
                { x: centre.x - 20, y: centre.y, reference: 'C1' });
            app.history.execute(new AddComponentCommand(app, old));
            const component = new Component(definition(-7.62, 'LCSC'),
                { x: centre.x + 11.42, y: centre.y, rotation: 270, reference: 'C6' });
            app.history.execute(new AddComponentCommand(app, component));
            for (const y of [centre.y, centre.y + 7.62]) {
                app.addShape(new Wire({ points: [{ x: centre.x, y }, { x: centre.x - 5, y }] }));
            }
            app.selectTool('select');
            app.selection.select(component);
            app.renderShapes(true);
            app.viewport.snapToGrid = false;
            app.viewport.zoomToLevel(app.viewport.zoomScales.findIndex(scale => scale >= 20));
            return { id: component.id,
                start: { x: component.x, y: component.y + 3.81 },
                end: { x: centre.x, y: component.y + 3.81 },
                pins: { '1': { x: centre.x, y: centre.y }, '2': { x: centre.x, y: centre.y + 7.62 } } };
        }, await viewCentre(page));
        await viewportSettled(page, 'schematic');
        const start = await screenPoint(page, 'schematic', setup.start.x, setup.start.y);
        const end = await screenPoint(page, 'schematic', setup.end.x, setup.end.y);
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await page.mouse.move(end.x, end.y, { steps: 12 });
        await page.mouse.up();
        const check = async () => page.evaluate(async ({ id, pins }) => {
            const { validateProject } = await import('/src/core/project-format.js');
            const { project, schematicApp: app } = window.bootstrap;
            validateProject(project.serialize());
            const component = app.components.find(component => component.id === id);
            const bonds = app.shapes.filter(shape => shape.type === 'wire')
                .flatMap(wire => [...wire.pinConnections.values()].filter(bond => bond.componentId === id));
            return { bonds: bonds.map(bond => String(bond.pinNumber)).sort(),
                positions: Object.fromEntries(Object.keys(pins).map(number => [number, component.getPinPosition(number)])),
                variants: new Set(project.serialize().schematic.components.map(component => component.dn)).size };
        }, setup);
        const connected = await check();
        assert.deepEqual(connected.bonds, ['1', '2'], 'Moving C6 left connects both wire ends');
        for (const number of ['1', '2']) {
            assert.ok(Math.hypot(connected.positions[number].x - setup.pins[number].x,
                connected.positions[number].y - setup.pins[number].y) < 1e-9);
        }
        assert.equal(connected.variants, 2, 'Old and fresh library definitions do not collapse');
        await page.keyboard.press('Control+z');
        assert.deepEqual((await check()).bonds, [], 'Undo restores the unconnected placement');
        await page.keyboard.press('Control+y');
        assert.deepEqual((await check()).bonds, ['1', '2']);
        await saveAndReopen(page, 'schematic');
        assert.deepEqual(await check(), connected, 'Recovery preserves both symbols and their physical pin bonds');
    },
}];
