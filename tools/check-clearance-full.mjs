// Comprehensive clearance check for autorouter results.
// Verifies trace-pad, trace-trace, and via clearances.
// Usage: node tools/check-clearance-full.mjs [boardFile] [traceWidth] [clearance] [viaDia]

import { readFileSync } from 'fs';
import { routeAll } from '../src/pcb/modules/autorouter-maze.js';

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

const result = await routeAll(board);
const routed = result.totalConnectionCount - result.failedConnectionCount;
console.log(`Routed ${routed}/${result.totalConnectionCount} connections, ${result.traces.length} traces, ${result.vias?.length || 0} vias`);

const halfTrace = traceWidth / 2;
const viaRadius = viaDiameter / 2;
const EPS = 1e-4;

// ─── Geometry helpers ──────────────────────────────────────────────────
function padPointDist(x, y, pad) {
    if (pad.shape === 'ellipse') {
        const hw = pad.width / 2, hh = pad.height / 2;
        if (Math.abs(hw - hh) < 1e-9) return Math.hypot(x - pad.x, y - pad.y) - hw;
        const nx = (x - pad.x) / hw, ny = (y - pad.y) / hh;
        return (Math.hypot(nx, ny) - 1) * Math.min(hw, hh);
    }
    if (pad.shape === 'oval') {
        const hw = pad.width / 2, hh = pad.height / 2;
        const r = Math.min(hw, hh);
        const dx = Math.max(0, Math.abs(x - pad.x) - (hw - r));
        const dy = Math.max(0, Math.abs(y - pad.y) - (hh - r));
        return Math.hypot(dx, dy) - r;
    }
    const hw = pad.width / 2, hh = pad.height / 2;
    const dx = Math.max(0, Math.abs(x - pad.x) - hw);
    const dy = Math.max(0, Math.abs(y - pad.y) - hh);
    if (dx > 0 || dy > 0) return Math.hypot(dx, dy);
    return -Math.min(hw - Math.abs(x - pad.x), hh - Math.abs(y - pad.y));
}

function segPointMin(ax, ay, bx, by, fn) {
    const segLen = Math.hypot(bx - ax, by - ay);
    const steps = Math.max(2, Math.ceil(segLen / 0.05));
    let minD = Infinity;
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = ax + (bx - ax) * t;
        const y = ay + (by - ay) * t;
        const d = fn(x, y);
        if (d < minD) minD = d;
    }
    return minD;
}

function segToSegDist(ax, ay, bx, by, cx, cy, dx, dy) {
    return segPointMin(ax, ay, bx, by, (x, y) => pointToSegDist(x, y, cx, cy, dx, dy));
}

function pointToSegDist(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-12) return Math.hypot(px - ax, py - ay);
    let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// ─── Build pad-net membership ──────────────────────────────────────────
const padNets = new Map();
const keyOf = (x, y) => `${x.toFixed(4)},${y.toFixed(4)}`;
for (const c of board.connections) {
    for (const p of c.pads) {
        const k = keyOf(p.x, p.y);
        if (!padNets.has(k)) padNets.set(k, new Set());
        padNets.get(k).add(c.net);
    }
}

const violations = [];
function addVio(category, msg) {
    violations.push({ category, msg });
}

// ─── 1. Trace ↔ Pad ────────────────────────────────────────────────────
for (const trace of result.traces) {
    const pts = trace.points;
    for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        for (const pad of board.allObstaclePads) {
            const padLayer = pad.layer || 'both';
            if (padLayer !== 'both' && padLayer !== trace.layer) continue;
            const padNetSet = padNets.get(keyOf(pad.x, pad.y));
            if (padNetSet && padNetSet.has(trace.net)) continue;
            const d = segPointMin(a.x, a.y, b.x, b.y, (x, y) => padPointDist(x, y, pad));
            const required = halfTrace + clearance;
            if (d < required - EPS) {
                addVio('trace↔pad', `net=${trace.net} layer=${trace.layer} d=${d.toFixed(4)} < ${required.toFixed(4)} pad@(${pad.x.toFixed(2)},${pad.y.toFixed(2)})`);
            }
        }
    }
}

// ─── 2. Trace ↔ Trace (different nets, same layer) ──────────────────────
for (let i = 0; i < result.traces.length; i++) {
    const t1 = result.traces[i];
    for (let j = i + 1; j < result.traces.length; j++) {
        const t2 = result.traces[j];
        if (t1.net === t2.net) continue;
        if (t1.layer !== t2.layer) continue;
        for (let k = 0; k < t1.points.length - 1; k++) {
            const a = t1.points[k], b = t1.points[k + 1];
            for (let l = 0; l < t2.points.length - 1; l++) {
                const c = t2.points[l], d = t2.points[l + 1];
                const dist = segToSegDist(a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y);
                const required = traceWidth + clearance;
                if (dist < required - EPS) {
                    addVio('trace↔trace', `${t1.net}↔${t2.net} layer=${t1.layer} d=${dist.toFixed(4)} < ${required.toFixed(4)} t1=(${a.x.toFixed(2)},${a.y.toFixed(2)})→(${b.x.toFixed(2)},${b.y.toFixed(2)}) t2=(${c.x.toFixed(2)},${c.y.toFixed(2)})→(${d.x.toFixed(2)},${d.y.toFixed(2)})`);
                }
            }
        }
    }
}

// ─── 3. Via ↔ Pad (ANY pad, any net) ──────────────────────────────────
// Vias must never be placed on or near any pad. Via-in-pad is disallowed
// regardless of net (would short pad copper to wrong layer for SMD; is
// redundant for through-hole). The router must escape the pad first.
const vias = result.vias || [];
for (const via of vias) {
    for (const pad of board.allObstaclePads) {
        const d = padPointDist(via.x, via.y, pad);  // distance from via center to pad edge
        const required = viaRadius + clearance;
        if (d < required - EPS) {
            const padNetSet = padNets.get(keyOf(pad.x, pad.y));
            const padNet = padNetSet ? [...padNetSet].join(',') : '<obstacle>';
            addVio('via↔pad', `via.net=${via.net} pad.net=${padNet} d=${d.toFixed(4)} < ${required.toFixed(4)} via@(${via.x.toFixed(2)},${via.y.toFixed(2)}) pad@(${pad.x.toFixed(2)},${pad.y.toFixed(2)})`);
        }
    }
}

// ─── 4. Via ↔ Via (different nets) ─────────────────────────────────────
for (let i = 0; i < vias.length; i++) {
    for (let j = i + 1; j < vias.length; j++) {
        if (vias[i].net === vias[j].net) continue;
        const d = Math.hypot(vias[i].x - vias[j].x, vias[i].y - vias[j].y);
        const required = viaDiameter + clearance;
        if (d < required - EPS) {
            addVio('via↔via', `${vias[i].net}↔${vias[j].net} d=${d.toFixed(4)} < ${required.toFixed(4)}`);
        }
    }
}

// ─── 5. Via ↔ Trace (different net, on either layer since via spans both) ─
for (const via of vias) {
    for (const trace of result.traces) {
        if (trace.net === via.net) continue;
        const pts = trace.points;
        for (let k = 0; k < pts.length - 1; k++) {
            const a = pts[k], b = pts[k + 1];
            const d = pointToSegDist(via.x, via.y, a.x, a.y, b.x, b.y);
            const required = viaRadius + halfTrace + clearance;
            if (d < required - EPS) {
                addVio('via↔trace', `via.net=${via.net} trace.net=${trace.net} layer=${trace.layer} d=${d.toFixed(4)} < ${required.toFixed(4)}`);
            }
        }
    }
}

// ─── Report ────────────────────────────────────────────────────────────
const byCat = new Map();
for (const v of violations) {
    if (!byCat.has(v.category)) byCat.set(v.category, []);
    byCat.get(v.category).push(v.msg);
}
console.log(`\n=== CLEARANCE REPORT ===`);
console.log(`Total violations: ${violations.length}`);
for (const [cat, list] of byCat) {
    console.log(`\n  [${cat}] ${list.length} violations`);
    for (const m of list.slice(0, 5)) console.log(`    ${m}`);
    if (list.length > 5) console.log(`    ... and ${list.length - 5} more`);
}

process.exit(violations.length > 0 ? 1 : 0);
