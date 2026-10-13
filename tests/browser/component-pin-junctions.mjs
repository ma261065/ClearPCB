import assert from 'node:assert/strict';
import { openSchematic, viewCentre, waitForPage } from './helpers/editor-helpers.mjs';

export const scenarios = [{
    name: 'direct-component-pin-contact-shows-junction-dot',
    async run(page, url) {
        await openSchematic(page, url);
        const setup = await page.evaluate(async centre => {
            const app = window.bootstrap.schematicApp;
            const { Component } = await import('/src/components/Component.js');
            const { BuiltInComponents } = await import('/src/components/BuiltInComponents.js');
            const { mountComponent } = await import('/src/schematic/modules/schematic-view.js');
            const definition = BuiltInComponents.find(component => component.name === 'Resistor');
            const first = new Component(definition, { id: 'pin-join-first', reference: 'R1', ...centre });
            const second = new Component(definition, { id: 'pin-join-second', reference: 'R2', ...centre });
            const target = first.getPinPosition('2');
            const moving = second.getPinPosition('1');
            second.x += target.x - moving.x;
            second.y += target.y - moving.y;
            app.components.push(first, second);
            mountComponent(app, first);
            mountComponent(app, second);
            app.updateSelectableItems();
            app.renderShapes(true);
            return { target, secondId: second.id };
        }, await viewCentre(page));
        await waitForPage(page, () => document.querySelectorAll('.direct-pin-junction-dot').length === 1);
        const result = await page.evaluate(async target => {
            const app = window.bootstrap.schematicApp;
            const dot = document.querySelector('.direct-pin-junction-dot');
            const net = window.bootstrap.project.getNetlist().find(net =>
                net.pins.some(pin => pin.componentId === 'pin-join-first' && pin.pinNumber === '2'));
            return {
                dot: {
                    x: Number(dot.getAttribute('cx')),
                    y: Number(dot.getAttribute('cy')),
                    fill: getComputedStyle(dot).fill,
                    pointerEvents: getComputedStyle(dot).pointerEvents,
                    radiusPx: Number(dot.getAttribute('r')) * app.viewport.scale,
                },
                target,
                pins: net?.pins,
            };
        }, setup.target);
        assert.deepEqual({ x: result.dot.x, y: result.dot.y }, result.target);
        assert.equal(result.dot.fill, 'rgb(0, 204, 102)');
        assert.equal(result.dot.pointerEvents, 'none');
        assert.ok(result.dot.radiusPx >= 2.5 && result.dot.radiusPx <= 8);
        assert.deepEqual(result.pins, [
            { componentId: 'pin-join-first', pinNumber: '2' },
            { componentId: 'pin-join-second', pinNumber: '1' },
        ]);

        for (const zoom of [5000, 10000]) {
            const radiusPx = await page.evaluate(zoom => {
                const app = window.bootstrap.schematicApp;
                app.viewport.zoomToLevel(app.viewport.zoomPercents.indexOf(zoom), app.viewport.offset);
                app.renderShapes(true);
                const dot = document.querySelector('.direct-pin-junction-dot');
                return Number(dot.getAttribute('r')) * app.viewport.scale;
            }, zoom);
            assert.ok(Math.abs(radiusPx - 8) < 1e-9,
                `${zoom}% direct-pin junction dot remains capped at eight screen pixels`);
        }

        await page.evaluate(id => {
            const app = window.bootstrap.schematicApp;
            const component = app.components.find(item => item.id === id);
            component.x += 2;
            component.invalidate();
            app.renderShapes(true);
        }, setup.secondId);
        assert.equal(await page.locator('.direct-pin-junction-dot').count(), 0);
    },
}];
