// Run the autorouter on a test board and verify no clearance violations.
// Usage: node tools/check-clearance.mjs [boardFile] [traceWidth] [clearance] [viaDia]

import { readFileSync } from 'fs';
import { routeAll } from '../src/pcb/modules/autorouter.js';

const boardFile = process.argv[2] || 'test-board.json';
const traceWidth = parseFloat(process.argv[3] ?? '0.2');
const clearance  = parseFloat(process.argv[4] ?? '0.1');
const viaDiameter = parseFloat(process.argv[5] ?? '0.4');

const board = JSON.parse(readFileSync(boardFile, 'utf8'));
board.traceWidth = traceWidth;
board.clearance = clearance;
board.viaDiameter = viaDiameter;
if (!board.gridStep) board.gridStep = 0.5;

console.log(`board=${boardFile} traceWidth=${traceWidth} clearance=${clearance} viaDia=${viaDiameter}`);
console.log(`connections=${board.connections.length} pads=${board.allObstaclePads.length}`);

const result = await routeAll(board);
const routed = result.totalConnectionCount - result.failedConnectionCount;
console.log(`\nRouted ${routed}/${result.totalConnectionCount} connections, ${result.traces.length} traces, ${result.vias?.length || 0} vias`);

// ---- clearance check ----------------------------------------------------
// Build pad index.
const pads = board.allObstaclePads;
const halfTrace = traceWidth / 2;

// For each pad, find the set of nets it belongs to (from connections).
const padNets = new Map();   // "x,y" → Set<net>
const keyOf = (x, y) => `${x.toFixed(4)},${y.toFixed(4)}`;
for (const c of board.connections) {
    for (const p of c.pads) {
        const k = keyOf(p.x, p.y);
        if (!padNets.has(k)) padNets.set(k, new Set());
        padNets.get(k).add(c.net);
    }
}

// Distance from point to padpoint blocked  (using rect for now; simple).
function padPointDist(x, y, pad) {
    if (pad.shape === 'ellipse') {
        const hw = pad.width / 2, hh = pad.height / 2;
        if (Math.abs(hw - hh) < 1e-9) {
            const d = Math.hypot(x - pad.x, y - pad.y);
            return d - hw;
        }
        // anisotropic ellipse: approximate via normalized form
        const nx = (x - pad.x) / hw;
        const ny = (y - pad.y) / hh;
        const r = Math.hypot(nx, ny);
        // signed distance approx
        return (r - 1) * Math.min(hw, hh);
    }
    // rect / oval / unknown → AABB distance + corner rounding for oval
    const hw = pad.width / 2, hh = pad.height / 2;
    const dx = Math.max(0, Math.abs(x - pad.x) - hw);
    const dy = Math.max(0, Math.abs(y - pad.y) - hh);
    const dout = Math.hypot(dx, dy);
    if (dout > 0) return dout;
    // inside bbox
    return -Math.min(hw - Math.abs(x - pad.x), hh - Math.abs(y - pad.y));
}

function segDistToPad(ax, ay, bx, by, pad) {
    // Sample the segment and return min distance.
    const segLen = Math.hypot(bx - ax, by - ay);
    const steps = Math.max(2, Math.ceil(segLen / 0.05));
    let minD = Infinity;
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = ax + (bx - ax) * t;
        const y = ay + (by - ay) * t;
        const d = padPointDist(x, y, pad);
        if (d < minD) minD = d;
    }
    return minD;
}

let violations = 0;
const vioList = [];
for (const trace of result.traces) {
    const pts = trace.points;
    for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        for (const pad of pads) {
            // Only check pads on the same layer.
            const padLayer = pad.layer || 'both';
            if (padLayer !== 'both' && padLayer !== trace.layer) continue;
            const k = keyOf(pad.x, pad.y);
            const padNetSet = padNets.get(k);
            // If the pad belongs to the same net as the trace, skip — same-net contact is allowed at endpoints.
            if (padNetSet && padNetSet.has(trace.net)) continue;
            const d = segDistToPad(a.x, a.y, b.x, b.y, pad);
            const required = halfTrace + clearance;
            if (d < required - 1e-6) {
                violations++;
                if (vioList.length < 10) {
                    vioList.push({
                        net: trace.net,
                        layer: trace.layer,
                        seg: [a, b],
                        pad: { x: pad.x, y: pad.y, w: pad.width, h: pad.height, shape: pad.shape, layer: padLayer, net: padNetSet ? [...padNetSet].join(',') : '<obstacle>' },
                        dist: d,
                        required,
                    });
                }
            }
        }
    }
}

console.log(`\n=== CLEARANCE CHECK ===`);
console.log(`Violations: ${violations}`);
for (const v of vioList) {
    console.log(`  net=${v.net} layer=${v.layer} d=${v.dist.toFixed(4)} required=${v.required.toFixed(4)}`);
    console.log(`    seg=(${v.seg[0].x.toFixed(2)},${v.seg[0].y.toFixed(2)})→(${v.seg[1].x.toFixed(2)},${v.seg[1].y.toFixed(2)})`);
    console.log(`    pad=(${v.pad.x.toFixed(2)},${v.pad.y.toFixed(2)}) ${v.pad.w}x${v.pad.h} ${v.pad.shape} layer=${v.pad.layer} net=${v.pad.net}`);
}

process.exit(violations > 0 ? 1 : 0);
