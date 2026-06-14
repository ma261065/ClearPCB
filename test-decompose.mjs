/**
 * Headless test for shape-decompose: a rounded-corner rectangle decomposes
 * into a Polyline of 4 straight + 4 arc edges, each corner bulge ≈ √2−1.
 * Run with:  node test-decompose.mjs
 */

globalThis.document = {
    createElementNS: () => {
        const el = {
            _text: '', attrs: {}, children: [],
            setAttribute(k, v) { this.attrs[k] = v; },
            appendChild(c) { this.children.push(c); return c; },
            classList: { add() {} },
        };
        Object.defineProperty(el, 'textContent', {
            get() { return el._text; },
            set(v) { el._text = v; el.children.length = 0; },
        });
        return el;
    },
};

const { Polyline } = await import('./src/shapes/polyline.js');
const { decomposeRoundedCorners, canDecomposeRoundedCorners } = await import('./src/shapes/shape-decompose.js');

let pass = 0, fail = 0;
const approx = (a, b, eps = 1e-4) => Math.abs(a - b) <= eps;
function ok(name, cond) {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name}`); }
}

// Build a rounded rect 100×60 at origin, r=15.
const rect = new Polyline({
    closed: true, isRect: true, cornerRadius: 15,
    graphNodes: { a: { x: 0, y: 0 }, b: { x: 100, y: 0 }, c: { x: 100, y: 60 }, d: { x: 0, y: 60 } },
    graphEdges: { e0: { from: 'a', to: 'b' }, e1: { from: 'b', to: 'c' }, e2: { from: 'c', to: 'd' }, e3: { from: 'd', to: 'a' } },
});

ok('canDecomposeRoundedCorners true for rounded rect', canDecomposeRoundedCorners(rect));

const out = decomposeRoundedCorners(rect);
ok('decompose returns a Polyline', out && out.type === 'polyline');
ok('result has cornerRadius 0', out.cornerRadius === 0);
ok('result is not a rect', out.isRect === false);
ok('result closed', out.closed === true);
ok('result has 8 nodes', out.nodes.size === 8);
ok('result has 8 edges', out.edges.size === 8);

// 4 arc edges with |bulge| ≈ √2 − 1.
const target = Math.SQRT2 - 1;
let arcCount = 0;
for (const [id] of out.edges) {
    const bulge = out.getEdgeAttr(id, 'bulge') || 0;
    if (Math.abs(bulge) > 1e-6) {
        arcCount++;
        ok(`arc edge ${id} bulge ≈ ±${target.toFixed(4)} (got ${bulge.toFixed(4)})`, approx(Math.abs(bulge), target));
    }
}
ok('exactly 4 arc edges', arcCount === 4);

// Not decomposable after decompose (has bulged edges now).
ok('decomposed result is not re-decomposable', !canDecomposeRoundedCorners(out));

// Sharp polygon (cornerRadius 0) is not decomposable.
const sharp = new Polyline({
    closed: true, cornerRadius: 0,
    graphNodes: { a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, c: { x: 10, y: 10 } },
    graphEdges: { e0: { from: 'a', to: 'b' }, e1: { from: 'b', to: 'c' }, e2: { from: 'c', to: 'a' } },
});
ok('sharp polygon not decomposable', !canDecomposeRoundedCorners(sharp));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
