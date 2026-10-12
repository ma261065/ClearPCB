import assert from 'node:assert/strict';
import { openPcb } from './helpers/editor-helpers.mjs';

export const scenarios = [{
    name: 'track-clearance-outline-with-thermal-pad-connection',
    async run(page, url) {
        await openPcb(page, url);
        const result = await page.evaluate(async () => {
            const app = window.bootstrap.pcbApp;
            const { Track } = await import('/src/shapes/track.js');
            const { renderTrack, buildTrackLayerRuns } = await import('/src/pcb/modules/track-render.js');
            const { clearanceOverlayState, showClearances } = await import('/src/pcb/modules/clearance-overlay.js');
            app.designSettings.update({ trackWidth: 0.4, clearance: 0.2 });
            app.placements.set('thermal-component', { x: 60, y: -40, rotation: 0, side: 'top', padOffsets: [
                { number: 'thermal', padId: 'thermal', dx: 0, dy: 0, width: 3, height: 3, shape: 'rect', layer: 'top' },
            ] });
            const track = new Track({ id: 'thermal-track', net: 'GND', width: 0.4, points: [
                { x: 60, y: -40 }, { x: 60, y: -20 }, { x: 20, y: -20 },
                { x: 21, y: -20 }, { x: 21, y: -25 },
            ] });
            track.padConnections.set('n0', { componentId: 'thermal-component', pinNumber: 'thermal' });
            app.pcbDocument.tracks.push(track);
            renderTrack(track, layer => app.getLayerGroup(layer));
            showClearances(app, true);
            const before = JSON.stringify(track.captureState());
            const capture = () => {
                const elements = clearanceOverlayState(app).trackElements.get(track.id);
                const polygons = elements.map(element => element.getAttribute('points'));
                const segments = buildTrackLayerRuns(track).flatMap(run =>
                    run.points.slice(1).map((end, index) => [run.points[index], end]));
                const distances = [];
                for (const polygon of polygons) {
                    const points = polygon.split(' ').map(pair => {
                        const [x, y] = pair.split(',').map(Number);
                        return { x, y };
                    });
                    for (let index = 0; index < points.length; index++) {
                        const start = points[index], end = points[(index + 1) % points.length];
                        for (const t of [0, 0.25, 0.5, 0.75]) {
                            const point = { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t };
                            distances.push(Math.min(...segments.map(([a, b]) => {
                                const dx = b.x - a.x, dy = b.y - a.y;
                                const length = dx * dx + dy * dy;
                                const ratio = length ? Math.max(0, Math.min(1,
                                    ((point.x - a.x) * dx + (point.y - a.y) * dy) / length)) : 0;
                                return Math.hypot(point.x - a.x - ratio * dx, point.y - a.y - ratio * dy);
                            })));
                        }
                    }
                }
                return { polygons, worstError: Math.max(...distances.map(distance => Math.abs(distance - 0.4))) };
            };
            const full = capture();
            showClearances(app, true, track);
            const live = capture();
            const unchanged = before === JSON.stringify(track.captureState());
            track.padConnections.delete('n0');
            track.nodes.get('n0').x += 1;
            renderTrack(track, layer => app.getLayerGroup(layer));
            showClearances(app, true, track);
            const detached = capture();
            showClearances(app, true);
            const settled = capture();
            return { full, live, detached, settled, unchanged };
        });
        assert.ok(result.full.polygons.length > 0);
        assert.deepEqual(result.full.polygons, result.live.polygons, 'Connected full and live outlines match');
        assert.deepEqual(result.detached.polygons, result.settled.polygons, 'Moving the end retains full/live parity');
        assert.equal(result.unchanged, true, 'Showing clearance never edits authored copper or its connection');
        for (const [phase, measurement] of Object.entries(result)) {
            if (phase !== 'unchanged') assert.ok(measurement.worstError < 0.005,
                `${phase} clearance boundary stays 0.400 mm from the track centreline`);
        }
    },
}];
