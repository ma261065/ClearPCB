import assert from 'node:assert/strict';
import { openPcb, viewCentre } from './helpers/editor-helpers.mjs';

export const scenarios = [{
    name: 'component-highlights-ignore-hidden-first-artwork-layer',
    async run(page, url) {
        await openPcb(page, url);
        await page.evaluate(async centre => {
            const app = window.bootstrap.pcbApp;
            const { placeFootprints } = await import('/src/pcb/modules/schematic-sync.js');
            const { REF_DEFAULT_SIZE, REF_DEFAULT_STROKE } = await import('/src/shared/pcb/footprint.js');
            const { hoverComponent } = await import('/src/pcb/modules/component-selection.js');
            const { clearBoxSelection } = await import('/src/pcb/modules/box-select.js');
            clearBoxSelection(app);
            const bounds = { x: -5, y: -4, width: 10, height: 8 };
            // POWER_IN starts with paste artwork, not silk. Paste is normally hidden.
            const geometry = { pads: [], outline: bounds, courtyard: bounds, silks: [
                { type: 'line', layer: 'top-paste', x1: -3, y1: -2, x2: 3, y2: -2, strokeWidth: 0.2 },
                { type: 'line', layer: 'top-silk', x1: -4, y1: 3, x2: 4, y2: 3, strokeWidth: 0.2 },
            ] };
            placeFootprints(app, new Map([['power-in', {
                ...centre, reference: 'POWER_IN', rotation: 0, side: 'top', mirror: false,
                locked: true, pads: new Map(), padOffsets: [], geometry,
                refSize: REF_DEFAULT_SIZE, refStrokeWidth: REF_DEFAULT_STROKE,
            }]]));
            app.getLayerGroup('top-paste').style.display = 'none';
            app.getLayerGroup('bottom-paste').style.display = 'none';
            hoverComponent(app, 'power-in');
        }, await viewCentre(page, 'pcb'));

        const hover = page.locator('.pcb-hover-highlight');
        await hover.waitFor({ state: 'visible' });
        assert.equal(await hover.evaluate(el => el.closest('[data-layer]').getAttribute('data-layer')),
            'selection-overlay', 'Hover does not belong to the hidden paste layer');
        await page.evaluate(async () => {
            const app = window.bootstrap.pcbApp;
            const { hoverComponent } = await import('/src/pcb/modules/component-selection.js');
            hoverComponent(app, null);
            app.selectComponent('power-in');
        });
        await page.locator('.pcb-selection-highlight').waitFor({ state: 'visible' });
        assert.equal(await hover.count(), 0);

        await page.evaluate(async () => {
            const app = window.bootstrap.pcbApp;
            const { setPcbSelection } = await import('/src/pcb/modules/selection-registry.js');
            const { refreshBoxSelectionHighlights } = await import('/src/pcb/modules/box-select.js');
            app.selectComponent(null);
            setPcbSelection(app, [{ kind: 'component', object: 'power-in' }]);
            refreshBoxSelectionHighlights(app);
        });
        const selected = page.locator('.pcb-box-comp-sel');
        await selected.waitFor({ state: 'visible' });
        const pose = await page.evaluate(async () => {
            const app = window.bootstrap.pcbApp;
            const { renderPlacementPose, renderPlacementSide, placementTransform } =
                await import('/src/pcb/modules/track-commands.js');
            const pl = app.placements.get('power-in');
            pl.rotation = 90;
            pl.side = 'bottom';
            renderPlacementSide(app, 'power-in', 'bottom');
            renderPlacementPose(app, 'power-in');
            return { expected: placementTransform(pl), actual: pl.elements[0].getAttribute('transform') };
        });
        assert.equal(pose.actual, pose.expected, 'Highlights follow rotation and side changes');
        assert.equal(await selected.evaluate(el => el.closest('[data-layer]').getAttribute('data-layer')),
            'selection-overlay', 'Changing board side does not reparent highlights to a fabrication layer');
        await selected.waitFor({ state: 'visible' });

        await page.evaluate(async () => {
            const { clearBoxSelection } = await import('/src/pcb/modules/box-select.js');
            clearBoxSelection(window.bootstrap.pcbApp);
        });
        assert.equal(await selected.count(), 0, 'Deselecting removes the border');
    },
}];
