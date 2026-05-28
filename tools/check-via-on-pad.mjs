// Find vias geometrically overlapping pad copper (ignoring clearance).
// Usage: node tools/check-via-on-pad.mjs [board] [tw] [cl] [vd]
import { readFileSync } from 'fs';
import { routeAll } from '../src/pcb/modules/autorouter-maze.js';

const file = process.argv[2] || 'test-board.json';
const tw = parseFloat(process.argv[3] ?? '0.2');
const cl = parseFloat(process.argv[4] ?? '0.1');
const vd = parseFloat(process.argv[5] ?? '0.4');

const board = JSON.parse(readFileSync(file, 'utf8'));
board.traceWidth = tw; board.clearance = cl; board.viaDiameter = vd;
if (!board.gridStep) board.gridStep = 0.5;

const r = await routeAll(board);
const vr = vd / 2;

function padDistFromPoint(x, y, p) {
    const hw = p.width / 2, hh = p.height / 2;
    if (p.shape === 'ellipse' && Math.abs(hw - hh) < 1e-9) {
        return Math.hypot(x - p.x, y - p.y) - hw;
    }
    const dx = Math.max(0, Math.abs(x - p.x) - hw);
    const dy = Math.max(0, Math.abs(y - p.y) - hh);
    if (dx > 0 || dy > 0) return Math.hypot(dx, dy);
    return -Math.min(hw - Math.abs(x - p.x), hh - Math.abs(y - p.y));
}

const overlaps = [];
for (const v of r.vias || []) {
    for (const p of board.allObstaclePads) {
        const d = padDistFromPoint(v.x, v.y, p);  // negative if via center inside pad
        // "Via on pad" = via copper geometrically overlaps pad copper.
        // d is the distance from via CENTER to pad EDGE (negative inside).
        // Overlap when d < vr (i.e. via copper extends past pad edge into pad copper).
        if (d < vr) {
            overlaps.push({ v, p, d });
        }
    }
}
console.log(`Board=${file}  Vias=${(r.vias || []).length}  Visual via-on-pad overlaps: ${overlaps.length}`);
for (const o of overlaps.slice(0, 20)) {
    const inside = o.d < 0 ? '  *INSIDE PAD*' : '';
    console.log(`  via.net=${o.v.net} via=(${o.v.x.toFixed(2)},${o.v.y.toFixed(2)}) pad=(${o.p.x.toFixed(2)},${o.p.y.toFixed(2)}) ${o.p.width}x${o.p.height} ${o.p.shape} layer=${o.p.layer} d=${o.d.toFixed(3)}${inside}`);
}
process.exit(overlaps.length > 0 ? 1 : 0);
