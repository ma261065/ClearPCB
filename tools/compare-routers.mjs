// Quick head-to-head: maze vs pathfinder on a JSON board.
// Usage: node tools/compare-routers.mjs [boardFile]
import { readFileSync } from 'fs';
import { routeAll } from '../src/pcb/modules/autorouter-maze.js';
import { routeAllPathfinder } from '../src/pcb/modules/autorouter-pathfinder.js';

const boardFile = process.argv[2] || 'test-board.json';

function load() {
    return JSON.parse(readFileSync(boardFile, 'utf8'));
}

function summarize(name, result, ms) {
    const routed = result.totalConnectionCount - result.failedConnectionCount;
    let segs = 0, diagSegs = 0, bends = 0;
    for (const tr of result.traces) {
        const p = tr.path || tr.points || [];
        for (let i = 1; i < p.length; i++) {
            segs++;
            const dx = Math.abs(p[i].x - p[i - 1].x);
            const dy = Math.abs(p[i].y - p[i - 1].y);
            if (dx > 1e-6 && dy > 1e-6) diagSegs++;
        }
        // count direction changes
        for (let i = 2; i < p.length; i++) {
            const ax = p[i - 1].x - p[i - 2].x, ay = p[i - 1].y - p[i - 2].y;
            const bx = p[i].x - p[i - 1].x, by = p[i].y - p[i - 1].y;
            const cross = ax * by - ay * bx;
            const dot = ax * bx + ay * by;
            if (Math.abs(cross) > 1e-6 || dot < 0) bends++;
        }
    }
    console.log(
        `${name.padEnd(11)} routed=${routed}/${result.totalConnectionCount} ` +
        `traces=${result.traces.length} vias=${result.vias?.length || 0} ` +
        `segs=${segs} diagSegs=${diagSegs} bends=${bends} time=${(ms / 1000).toFixed(1)}s`
    );
}

console.log(`board=${boardFile}`);

{
    const b = load();
    const t0 = Date.now();
    const r = await routeAll(b);
    summarize('maze', r, Date.now() - t0);
}
{
    const b = load();
    const t0 = Date.now();
    const r = await routeAllPathfinder(b);
    summarize('pathfinder', r, Date.now() - t0);
}
