import assert from 'node:assert/strict';
import { openPcb } from './helpers/editor-helpers.mjs';

export const scenarios = [{
    name: '2d-board-pan-translates-cached-artwork',
    async run(page, url) {
        await openPcb(page, url);
        const result = await page.evaluate(async () => {
            const { Board2D } = await import('/src/pcb/modules/board2d.js');
            const canvas = document.createElement('canvas');
            canvas.style.cssText = 'width:600px;height:400px';
            canvas.setPointerCapture = () => {};
            canvas.releasePointerCapture = () => {};
            document.body.appendChild(canvas);
            const viewer = new Board2D(canvas);
            viewer.setData({ boardWidth: 40, boardHeight: 20, placements: new Map(),
                tracks: [], vias: [{ x: 10, y: -10, diameter: 3, drill: 1.5 }],
                pads: [{ x: 20, y: -10, layers: 'both', shape: 'round', size: 4, drill: 2 }],
                boardShapes: [], texts: new Map() });
            // Let the initial ResizeObserver delivery finish before measuring a gesture.
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            let geometryPasses = 0;
            const paint = viewer._paintBoard.bind(viewer);
            viewer._paintBoard = context => { geometryPasses++; paint(context); };
            viewer._onPointerDown({ button: 0, clientX: 0, clientY: 0, pointerId: 0 });
            const captures = geometryPasses;
            const start = performance.now();
            for (let i = 1; i <= 200; i++) viewer._onPointerMove({ clientX: i, clientY: i / 2 });
            await new Promise(resolve => requestAnimationFrame(resolve));
            const elapsed = performance.now() - start;
            const during = geometryPasses;
            const shifted = viewer.ctx.getImageData(0, 0, canvas.width, canvas.height).data;
            viewer._onPointerUp({ pointerId: 0 });
            const final = viewer.ctx.getImageData(0, 0, canvas.width, canvas.height).data;
            let changedPixels = 0, maximumDifference = 0;
            for (let i = 0; i < final.length; i += 4) {
                let difference = 0;
                for (let channel = 0; channel < 4; channel++) difference = Math.max(difference,
                    Math.abs(final[i + channel] - shifted[i + channel]));
                if (difference > 2) changedPixels++;
                maximumDifference = Math.max(maximumDifference, difference);
            }
            const after = geometryPasses;
            viewer.setSide('bottom');
            viewer.scale = 300;
            viewer.render();
            viewer._onPointerDown({ button: 0, clientX: 0, clientY: 0, pointerId: 0 });
            if (!viewer._panRaster.clipped) throw new Error('Extreme zoom did not bound its pan capture');
            const beforeOverscan = geometryPasses;
            viewer._onPointerMove({ clientX: 700, clientY: 0 });
            await new Promise(resolve => requestAnimationFrame(resolve));
            if (geometryPasses !== beforeOverscan + 1) throw new Error('Exhausted overscan was not refreshed');
            if (viewer._panRaster.tx !== viewer.tx) throw new Error('Overscan refresh used a stale pan position');
            viewer._onPointerUp({ pointerId: 0 });
            viewer._onPointerDown({ button: 0, clientX: 0, clientY: 0, pointerId: 0 });
            const oldRaster = viewer._panRaster;
            viewer.setData({ boardWidth: 50, boardHeight: 20, placements: new Map(),
                tracks: [], vias: [], pads: [], boardShapes: [], texts: new Map() });
            if (viewer._panRaster === oldRaster) throw new Error('Board changes did not replace the drag image');
            viewer._onPointerMove({ clientX: 5, clientY: 5 });
            await new Promise(resolve => requestAnimationFrame(resolve));
            if (!viewer._panRaster) throw new Error('Next pan frame did not capture the changed board');
            viewer._onPointerUp({ pointerId: 0 });
            viewer.dispose();
            canvas.remove();
            return { captures, during, after, elapsed, changedPixels, maximumDifference,
                pixels: canvas.width * canvas.height };
        });
        assert.equal(result.captures, 0, 'pointer down reuses artwork already rendered');
        assert.equal(result.during, 0, '200 move events do not recalculate or repaint board layers');
        assert.equal(result.after, 1, 'release redraws once at final pan position');
        assert.ok(result.elapsed < 500, 'cached pan remains responsive');
        assert.ok(result.changedPixels / result.pixels < 0.005,
            `cached image matches fresh rendering apart from edge compositing (${JSON.stringify(result)})`);
    },
}, {
    name: '2d-board-zoom-scales-cached-artwork-and-settles-sharply',
    async run(page, url) {
        await openPcb(page, url);
        const results = await page.evaluate(async () => {
            const { Board2D } = await import('/src/pcb/modules/board2d.js');
            const canvas = document.createElement('canvas');
            canvas.style.cssText = 'width:600px;height:400px';
            document.body.appendChild(canvas);
            const viewer = new Board2D(canvas);
            viewer.setData({ boardWidth: 40, boardHeight: 20, placements: new Map(),
                tracks: [], vias: [{ x: 10, y: -10, diameter: 3, drill: 1.5 }],
                pads: [{ x: 20, y: -10, layers: 'both', shape: 'round', size: 4, drill: 2 }],
                boardShapes: [], texts: new Map() });
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            let geometryPasses = 0, bitmapPasses = 0;
            const paint = viewer._paintBoard.bind(viewer);
            viewer._paintBoard = context => { geometryPasses++; paint(context); };
            const bitmap = viewer._paintPanRaster.bind(viewer);
            viewer._paintPanRaster = () => { bitmapPasses++; bitmap(); };
            const results = [];
            for (const side of ['top', 'bottom']) {
                viewer.setSide(side);
                viewer.fit();
                const rect = canvas.getBoundingClientRect();
                const worldX = (300 - viewer.tx) / (viewer.mirror * viewer.scale);
                const worldY = (200 - viewer.ty) / viewer.scale;
                const dpr = canvas.width / 600;
                const holePixel = () => Array.from(viewer.ctx.getImageData(
                    Math.floor(300 * dpr), Math.floor(200 * dpr), 1, 1).data);
                const background = holePixel();
                geometryPasses = 0;
                bitmapPasses = 0;
                for (let i = 0; i < 100; i++) {
                    canvas.dispatchEvent(new WheelEvent('wheel', {
                        clientX: rect.left + 300, clientY: rect.top + 200,
                        deltaY: -1, cancelable: true,
                    }));
                }
                const immediate = geometryPasses;
                await new Promise(resolve => requestAnimationFrame(resolve));
                const during = geometryPasses;
                const frames = bitmapPasses;
                const cachedHole = holePixel();
                const anchorError = Math.max(
                    Math.abs((300 - viewer.tx) / (viewer.mirror * viewer.scale) - worldX),
                    Math.abs((200 - viewer.ty) / viewer.scale - worldY));
                // Ordinary mouse-wheel notches may be spaced farther apart than
                // a trackpad burst. They should not rebuild between notches.
                await new Promise(resolve => setTimeout(resolve, 200));
                canvas.dispatchEvent(new WheelEvent('wheel', {
                    clientX: rect.left + 300, clientY: rect.top + 200,
                    deltaY: -10, cancelable: true,
                }));
                await new Promise(resolve => requestAnimationFrame(resolve));
                const betweenNotches = geometryPasses;
                await new Promise(resolve => setTimeout(resolve, 400));
                const settled = geometryPasses;
                const sharp = viewer.ctx.getImageData(0, 0, canvas.width, canvas.height).data;
                viewer.render();
                const fresh = viewer.ctx.getImageData(0, 0, canvas.width, canvas.height).data;
                let changed = 0, maxDifference = 0;
                for (let i = 0; i < fresh.length; i++) {
                    const difference = Math.abs(fresh[i] - sharp[i]);
                    if (difference) changed++;
                    maxDifference = Math.max(maxDifference, difference);
                }
                results.push({ side, immediate, during, frames, betweenNotches, settled, anchorError,
                    cachedHole, background, changed, maxDifference,
                    cacheReady: viewer._panRaster !== null && viewer._zoomTimer === null });
            }
            canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -20, cancelable: true }));
            viewer.setSide('top');
            const beforeWait = geometryPasses;
            await new Promise(resolve => setTimeout(resolve, 400));
            if (geometryPasses !== beforeWait) throw new Error('Side change left a stale zoom redraw scheduled');
            viewer.dispose();
            canvas.remove();
            return results;
        });
        for (const result of results) {
            assert.equal(result.immediate, 0, `${result.side}: wheel burst reuses existing artwork immediately`);
            assert.equal(result.during, 0, `${result.side}: frame does not redraw geometry`);
            assert.equal(result.frames, 1, `${result.side}: wheel events coalesce to one bitmap draw`);
            assert.equal(result.betweenNotches, 0, `${result.side}: spaced wheel notches do not rebuild artwork`);
            assert.equal(result.settled, 1, `${result.side}: zoom settles with one sharp redraw`);
            assert.ok(result.anchorError < 1e-10, `${result.side}: cursor world point remains fixed`);
            assert.ok(result.cachedHole.every((channel, i) => Math.abs(channel - result.background[i]) <= 1),
                `${result.side}: background remains fixed through holes (allowing gradient quantization)`);
            assert.ok(result.maxDifference <= 1,
                `${result.side}: settled view matches fresh full-detail rendering (${JSON.stringify(result)})`);
            assert.equal(result.cacheReady, true, 'sharp artwork is retained for the next gesture');
        }
    },
}, {
    name: '2d-board-opening-slides-before-building-artwork',
    async run(page, url) {
        await openPcb(page, url);
        const result = await page.evaluate(async () => {
            const { Board2D } = await import('/src/pcb/modules/board2d.js');
            const { openBoard3DViewer } = await import('/src/pcb/modules/board3d.js');
            const { getBoardViewPanel } = await import('/src/pcb/modules/refresh-state.js');
            const app = window.bootstrap.pcbApp;
            let passes = 0, slidingAtBuild = false, paintedFrames = 0, spinnerVisible = false;
            const original = Board2D.prototype._paintBoard;
            Board2D.prototype._paintBoard = function(context) {
                passes++;
                const host = document.querySelector('.cpcb3d-host');
                slidingAtBuild ||= host.classList.contains('cpcb3d-sliding');
                original.call(this, context);
            };
            try {
                const opening = openBoard3DViewer(app, { view: 'top' });
                let observingLoading = true;
                const observeLoadingFrame = () => {
                    if (!observingLoading || passes > 0) return;
                    paintedFrames++;
                    const host = document.querySelector('.cpcb3d-host');
                    spinnerVisible ||= !!host?.querySelector('.show');
                    requestAnimationFrame(observeLoadingFrame);
                };
                requestAnimationFrame(observeLoadingFrame);
                const immediatePasses = passes;
                const host = document.querySelector('.cpcb3d-host');
                const canvas = host.querySelector('.cpcb3d-cv2d');
                const background = Array.from(canvas.getContext('2d').getImageData(
                    Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data);
                const hostBackground = getComputedStyle(host).backgroundColor;
                await opening;
                observingLoading = false;
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                const initialPasses = passes;
                getBoardViewPanel(app).setView('bottom');
                const sidePasses = passes - initialPasses;
                getBoardViewPanel(app).close();
                return { immediatePasses, initialPasses, sidePasses, slidingAtBuild, paintedFrames,
                    spinnerVisible, background, hostBackground };
            } finally {
                Board2D.prototype._paintBoard = original;
                getBoardViewPanel(app)?.close();
            }
        });
        assert.equal(result.immediatePasses, 0, 'opening the panel does not synchronously build artwork');
        assert.deepEqual(result.background, [17, 28, 63, 255], 'opaque viewer background is painted before loading');
        assert.equal(result.hostBackground, 'rgb(1, 4, 12)', 'panel backdrop hides the editor even before a canvas frame');
        assert.ok(result.paintedFrames >= 2, 'opening animation paints before any board build');
        assert.equal(result.spinnerVisible, true, 'loading feedback is visible while the panel opens');
        assert.equal(result.slidingAtBuild, false, 'the first board build waits until the slide completes');
        assert.equal(result.initialPasses, 1, 'first opening renders artwork once, not once per setup/resize call');
        assert.equal(result.sidePasses, 1, 'side and data update render atomically');
    },
}, {
    name: '2d-board-traced-silk-skips-physical-polygon-merging',
    async run(page, url) {
        await openPcb(page, url);
        const result = await page.evaluate(async () => {
            const { Board2D } = await import('/src/pcb/modules/board2d.js');
            const { default: Clipper } = await import('/assets/vendor/clipper.esm.js');
            const canvas = document.createElement('canvas');
            canvas.style.cssText = 'width:600px;height:400px';
            document.body.appendChild(canvas);
            const viewer = new Board2D(canvas);
            const contours = Array.from({ length: 800 }, (_, index) => {
                const x = index % 40 * 5, y = Math.floor(index / 40) * 5;
                return [{ x, y }, { x: x + 3, y }, { x: x + 3, y: y + 3 }, { x, y: y + 3 }];
            });
            const original = Clipper.Clipper.prototype.Execute;
            let elapsed;
            try {
                Clipper.Clipper.prototype.Execute = () => {
                    throw new Error('Canvas2D silk rendering must not merge traced artwork');
                };
                const start = performance.now();
                viewer.setData({ placements: new Map(), tracks: [], vias: [], pads: [], texts: [],
                    boardWidth: 40, boardHeight: 20, boardShapes: [{
                        id: 'traced-silk', kind: 'image', layer: 'top-silk',
                        points: [{ x: 0, y: -20 }, { x: 40, y: -20 }, { x: 40, y: 0 }, { x: 0, y: 0 }],
                        artwork: { width: 200, height: 100, contours },
                    }] });
                elapsed = performance.now() - start;
                viewer._onWheel({ preventDefault() {}, clientX: 300, clientY: 200, deltaY: -100 });
                await new Promise(resolve => setTimeout(resolve, 400));
                viewer.setSide('bottom');
            } finally {
                Clipper.Clipper.prototype.Execute = original;
                viewer.dispose();
                canvas.remove();
            }
            return { elapsed };
        });
        assert.ok(result.elapsed < 1000, `Dense traced silk first render took ${result.elapsed} ms`);
    },
}, {
    name: '2d-board-pans-with-either-mouse-button',
    async run(page, url) {
        await openPcb(page, url);
        const position = await page.evaluate(async () => {
            const { Board2D } = await import('/src/pcb/modules/board2d.js');
            const canvas = document.createElement('canvas');
            canvas.id = 'pan-button-probe';
            canvas.style.cssText = 'position:fixed;left:100px;top:150px;width:600px;height:400px;z-index:20000';
            canvas.addEventListener('contextmenu', event => event.preventDefault());
            document.body.appendChild(canvas);
            const viewer = new Board2D(canvas);
            viewer.setData({ boardWidth: 40, boardHeight: 20, placements: new Map(),
                tracks: [], vias: [], pads: [], boardShapes: [], texts: [] });
            const startX = viewer.tx, startY = viewer.ty;
            canvas.addEventListener('pointerup', () => {
                canvas.dataset.dx = String(viewer.tx - startX);
                canvas.dataset.dy = String(viewer.ty - startY);
            });
            canvas.addEventListener('probe-cleanup', () => { viewer.dispose(); canvas.remove(); });
            return { x: 250, y: 300 };
        });
        try {
            for (const [index, button] of ['left', 'right'].entries()) {
                await page.mouse.move(position.x, position.y);
                await page.mouse.down({ button });
                await page.mouse.move(position.x + 50, position.y + 30, { steps: 5 });
                await page.mouse.up({ button });
                const delta = await page.locator('#pan-button-probe').evaluate(canvas => ({
                    x: Number(canvas.dataset.dx), y: Number(canvas.dataset.dy),
                }));
                assert.deepEqual(delta, { x: (index + 1) * 50, y: (index + 1) * 30 },
                    `${button}-button drag translates the view`);
            }
        } finally {
            await page.locator('#pan-button-probe').evaluate(canvas => canvas.dispatchEvent(new Event('probe-cleanup')));
        }
    },
}, {
    name: '2d-board-has-no-substrate-band-outside-the-outline',
    async run(page, url) {
        await openPcb(page, url);
        const alpha = await page.evaluate(async () => {
            const { Board2D } = await import('/src/pcb/modules/board2d.js');
            const canvas = document.createElement('canvas');
            canvas.style.cssText = 'width:900px;height:460px';
            document.body.appendChild(canvas);
            const viewer = new Board2D(canvas);
            try {
                viewer.setData({ boardWidth: 40, boardHeight: 20, placements: new Map(),
                    tracks: [], vias: [], pads: [], boardShapes: [], texts: new Map() });
                const art = document.createElement('canvas');
                art.width = 900;
                art.height = 460;
                const ctx = /** @type {CanvasRenderingContext2D} */ (art.getContext('2d'));
                // 20 px/mm: the board spans x 20..820 px and y 20..420 px.
                ctx.setTransform(20, 0, 0, 20, 20, 420);
                viewer._paintBoard(ctx);
                const at = (/** @type {number} */ x, /** @type {number} */ y) => ctx.getImageData(x, y, 1, 1).data[3];
                return { inside: at(818, 200), outside: at(821, 200), outsideTop: at(400, 18) };
            } finally {
                viewer.dispose();
                canvas.remove();
            }
        });
        assert.ok(alpha.inside > 0, 'the board paints up to its outline');
        assert.deepEqual({ outside: alpha.outside, outsideTop: alpha.outsideTop }, { outside: 0, outsideTop: 0 },
            'nothing paints beyond the board outline');
    },
}];
