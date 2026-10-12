import assert from 'node:assert/strict';
import { openPcb } from './helpers/editor-helpers.mjs';

async function clickControl(page, selector) {
    const box = await page.locator(selector).boundingBox();
    assert.ok(box, `${selector} is visible`);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

export const scenarios = [{
    name: 'locked-properties-look-disabled-and-explain-their-layer',
    async run(page, url) {
        await openPcb(page, url);
        await page.evaluate(async () => {
            const app = window.bootstrap.pcbApp;
            const { selectBoardShape } = await import('/src/pcb/modules/board-shapes.js');
            const { showBoardShapeProperties } = await import('/src/pcb/modules/board-shape-properties.js');
            const { PCB_LAYERS } = await import('/src/pcb/modules/layers.js');
            const shape = { id: 'locked-properties', kind: 'rect', layer: 'top-silk',
                points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
                lineWidth: 0.2, filled: false, cornerRadius: 1 };
            app.boardShapes.push(shape);
            PCB_LAYERS.find(layer => layer.id === 'top-silk').locked = true;
            selectBoardShape(app, shape);
            showBoardShapeProperties(app, shape);
        });
        const selectors = ['#pcbPropShapeLayer', '#pcbPropShapeCornerRadius', '#pcbPropShapeFilled'];
        for (const theme of ['dark', 'light']) {
            await page.evaluate(async theme => (await import('/src/shared/ui/theme.js')).applyTheme(theme), theme);
            for (const selector of selectors) {
                const style = await page.locator(selector).evaluate(control => ({
                    disabled: control.disabled,
                    opacity: Number(getComputedStyle(control).opacity),
                    rowDisabled: control.closest('.prop-row').classList.contains('prop-row-disabled'),
                    cursor: getComputedStyle(control.closest('.prop-row')).cursor,
                    color: getComputedStyle(control).color,
                    textColor: getComputedStyle(control).webkitTextFillColor,
                }));
                assert.equal(style.disabled, true, `${theme}: ${selector} remains natively disabled`);
                assert.equal(style.rowDisabled, true);
                assert.ok(style.opacity <= 0.65, `${theme}: unavailable fields are visibly dimmed`);
                assert.equal(style.cursor, 'not-allowed');
                if (selector === '#pcbPropShapeLayer') {
                    const expected = await page.evaluate(() => {
                        const probe = document.createElement('span');
                        probe.style.color = 'var(--text-muted)';
                        document.body.appendChild(probe);
                        const color = getComputedStyle(probe).color;
                        probe.remove();
                        return color;
                    });
                    assert.equal(style.color, expected, 'Locked object layer value is grey');
                    assert.equal(style.textColor, expected);
                }
                await clickControl(page, selector);
                assert.equal(await page.locator('#pcbLockedLayerBubble .pcb-locked-bubble-text').textContent(),
                    'Top Silk layer locked', `${theme}: clicking an unavailable control explains its layer`);
                assert.equal(await page.locator('#pcbLockedLayerBubble').isVisible(), true);
            }
        }
        assert.equal(await page.locator('#pcbPropObjectLocked').isDisabled(), false,
            'Object lock toggle remains available, independent of layer locking');
        assert.equal(await page.locator('#pcbCutProps').isDisabled(), true, 'Locked shape cannot be cut');
        assert.equal(await page.locator('#pcbCutHome').isDisabled(), true, 'Home uses the same Cut lock eligibility');
        assert.equal(await page.locator('#pcbCopyProps').isDisabled(), false, 'Locked shape can still be copied');
        await clickControl(page, '#pcbCutProps');
        assert.equal(await page.locator('#pcbLockedLayerBubble .pcb-locked-bubble-text').textContent(), 'Top Silk layer locked');
        const shape = await page.evaluate(() => window.bootstrap.pcbApp.boardShapes.find(shape => shape.id === 'locked-properties'));
        assert.equal(shape.cornerRadius, 1);
        assert.equal(shape.filled, false, 'Disabled property clicks do not edit the model');
        await page.waitForFunction(() => document.getElementById('pcbLockedLayerBubble').style.display === 'none',
            null, { timeout: 5000 });
        await page.evaluate(async () => {
            const app = window.bootstrap.pcbApp;
            const { PCB_LAYERS } = await import('/src/pcb/modules/layers.js');
            const { showBoardShapeProperties } = await import('/src/pcb/modules/board-shape-properties.js');
            PCB_LAYERS.find(layer => layer.id === 'top-silk').locked = false;
            showBoardShapeProperties(app, app.boardShapes.find(shape => shape.id === 'locked-properties'));
        });
        assert.equal(await page.locator('#pcbPropShapeFilled').isDisabled(), false);
        await page.locator('#pcbPropShapeFilled').check();
        assert.equal(await page.evaluate(() =>
            window.bootstrap.pcbApp.boardShapes.find(shape => shape.id === 'locked-properties').filled), true);
        assert.equal(await page.locator('#pcbLockedLayerBubble').isVisible(), false, 'Enabled edits do not show a lock bubble');
    },
}, {
    name: 'locked-properties-net-fill-via-and-refined-segments-explain-the-correct-layer',
    async run(page, url) {
        await openPcb(page, url);
        const show = kind => page.evaluate(async kind => {
            const app = window.bootstrap.pcbApp;
            const { PCB_LAYERS, PCB_COPPER_FILLS } = await import('/src/pcb/modules/layers.js');
            const { Track } = await import('/src/shapes/track.js');
            const { CopperFill } = await import('/src/shapes/copper-fill.js');
            const { Via } = await import('/src/shapes/via.js');
            const { selectTrackOrVia, selectTrackSegment } = await import('/src/pcb/modules/track-select.js');
            const { setPcbSelection } = await import('/src/pcb/modules/selection-registry.js');
            const { showFillProperties } = await import('/src/pcb/modules/copper-fill-edit.js');
            const { selectBoardShape } = await import('/src/pcb/modules/board-shapes.js');
            const { showBoardShapeProperties } = await import('/src/pcb/modules/board-shape-properties.js');
            const { setBoardShapeNodeFocus, setBoardShapeSegmentFocus } = await import('/src/pcb/modules/board-shape-state.js');
            for (const layer of [...PCB_LAYERS, ...PCB_COPPER_FILLS]) layer.locked = false;
            if (kind === 'net' || kind === 'segment') {
                const track = new Track({ layer: 'top-copper', width: 0.2, net: 'SIGNAL' });
                const a = track.addNode(0, 0), b = track.addNode(10, 0), c = track.addNode(10, 10);
                track.addEdge(a, b);
                const bottom = track.addEdge(b, c, { layer: 'bottom-copper' });
                app.tracks.push(track);
                PCB_LAYERS.find(layer => layer.id === 'bottom-copper').locked = true;
                if (kind === 'net') PCB_LAYERS.find(layer => layer.id === 'top-copper').locked = true;
                selectTrackOrVia(app, { type: 'track', track });
                if (kind === 'segment') selectTrackSegment(app, track, bottom);
            } else if (kind === 'fill') {
                const fill = new CopperFill({ id: 'property-fill', net: 'GND', layer: 'top-copper',
                    outline: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: -10 }] });
                app.boardShapes.push(fill);
                PCB_COPPER_FILLS.find(layer => layer.id === 'top-copper').locked = true;
                setPcbSelection(app, [{ kind: 'fill', object: fill }]);
                showFillProperties(app, fill);
            } else if (kind === 'via') {
                const via = new Via({ x: 20, y: 20, diameter: 0.6, drill: 0.3 });
                app.vias.push(via);
                PCB_LAYERS.find(layer => layer.id === 'vias').locked = true;
                selectTrackOrVia(app, { type: 'via', via });
            } else if (kind === 'reference') {
                app.placements.set('reference-probe', { x: 0, y: 0, side: 'top', reference: 'R1',
                    pads: new Map(), elements: [], bounds: { x: 0, y: 0, width: 10, height: 10 },
                    refSize: 1, refStrokeWidth: 0.15, refRot: 0 });
                PCB_LAYERS.find(layer => layer.id === 'top-silk').locked = true;
                setPcbSelection(app, [{ kind: 'reftext', object: 'reference-probe' }]);
                app.showRefProperties('reference-probe');
            } else if (kind === 'multi') {
                const shapes = [0, 20].map((x, index) => ({ id: `property-multi-${index}`, kind: 'line',
                    layer: 'top-silk', lineWidth: 0.2, points: [{ x, y: 0 }, { x: x + 10, y: 0 }] }));
                app.boardShapes.push(...shapes);
                PCB_LAYERS.find(layer => layer.id === 'top-silk').locked = true;
                const entries = shapes.map(object => ({ kind: 'shape', object }));
                setPcbSelection(app, entries);
                app.showMultiSelectionProperties(entries);
            } else {
                const shape = { id: `property-${kind}`, kind: 'line', layer: 'top-silk', lineWidth: 0.2,
                    points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] };
                app.boardShapes.push(shape);
                PCB_LAYERS.find(layer => layer.id === 'top-silk').locked = true;
                selectBoardShape(app, shape);
                setBoardShapeNodeFocus(app, kind === 'node' ? { shapeId: shape.id, index: 1 } : null);
                setBoardShapeSegmentFocus(app, kind === 'shape-segment' ? { shapeId: shape.id, segment: 0 } : null);
                showBoardShapeProperties(app, shape);
            }
        }, kind);
        for (const [kind, selector, message] of [
            ['net', '#pcbPropTrackNet', 'Top Copper layer locked'],
            ['segment', '#pcbPropSegLayer', 'Bottom Copper layer locked'],
            ['fill', '#pcbPropFillNet', 'Top Copper Fill layer locked'],
            ['via', '#pcbViaDelete', 'Via layer locked'],
            ['reference', '#pcbPropRefSize', 'Top Silk layer locked'],
            ['multi', '#pcbPropIntersection_lineWidth', 'Top Silk layer locked'],
            ['node', '#pcbPropShapeNodeCornerRadius', 'Top Silk layer locked'],
            ['shape-segment', '#pcbPropShapeLineWidth', 'Top Silk layer locked'],
        ]) {
            await show(kind);
            assert.equal(await page.locator(selector).isDisabled(), true, kind);
            if (kind === 'net') {
                const caret = await page.locator(selector).evaluate(input =>
                    getComputedStyle(input.closest('.prop-net-control'), '::after').content);
                assert.ok(caret !== 'none' && caret !== 'normal', 'Disabled net fields retain a dropdown indicator');
                assert.equal(await page.locator(`${selector} + details`).count(), 0, 'Disabled net menu cannot open');
            }
            await clickControl(page, selector);
            assert.equal(await page.locator('#pcbLockedLayerBubble .pcb-locked-bubble-text').textContent(), message);
        }
    },
}];
