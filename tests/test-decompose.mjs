/**
 * Headless test for shape-decompose: a rounded-corner rectangle decomposes
 * into a Polyline of 4 straight + 4 arc edges, each corner bulge ≈ √2−1.
 * Run with:  node tests/test-decompose.mjs
 */

globalThis.document = {
    createElementNS: () => {
        const el = {
            _text: '', attrs: {}, children: [],
            setAttribute(k, v) { this.attrs[k] = v; },
            appendChild(c) { this.children.push(c); return c; },
            get firstChild() { return this.children[0] || null; },
            insertBefore(child, before) {
                const index = this.children.indexOf(before);
                this.children.splice(index < 0 ? this.children.length : index, 0, child);
                return child;
            },
            remove() { this.removed = true; },
            classList: { add() {} },
        };
        Object.defineProperty(el, 'textContent', {
            get() { return el._text; },
            set(v) { el._text = v; el.children.length = 0; },
        });
        return el;
    },
};

const { Polyline } = await import('../src/shapes/polyline.js');
const { decomposeRoundedCorners, canDecomposeRoundedCorners } = await import('../src/shapes/shape-decompose.js');

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

const geometryBefore = JSON.stringify(rect.toJSON());
for (const scale of [0.5, 10]) {
    rect._updateAnchors(scale, true);
    const guide = rect.anchorsGroup.children[0];
    ok(`guide is behind handles at scale ${scale}`, guide.attrs.class === 'shape-edit-guide');
    ok('guide reaches the original rectangle corners',
        guide.attrs.d === 'M 0 0 L 100 0 L 100 60 L 0 60 L 0 0 Z');
    ok('guide stays one screen pixel wide', guide.attrs['stroke-width'] === '1'
        && guide.attrs['vector-effect'] === 'non-scaling-stroke');
    ok('guide has no fill or pointer interaction', guide.attrs.fill === 'none'
        && guide.attrs['pointer-events'] === 'none');
}
ok('guides leave saved geometry unchanged', JSON.stringify(rect.toJSON()) === geometryBefore);
const anchorsBeforeDeselect = rect.anchorsGroup;
rect._updateAnchors(1, false);
ok('deselect removes the guide with its handles', rect.anchorsGroup === null && anchorsBeforeDeselect.removed);
out._updateAnchors(1, true);
ok('guide retains explicit arc edges', out.anchorsGroup.children[0].attrs.d.includes('A '));

for (const scale of [0.5, 10]) {
    rect._updateAnchors(scale, true, 'b');
    const ring = rect.anchorsGroup.children.find(child => child.attrs.class === 'schematic-node-selection-ring');
    ok('refined node has a ring at its actual position', ring?.attrs.cx === '100' && ring?.attrs.cy === '0');
    ok('node ring retains screen size across zoom', Number(ring?.attrs.r) * scale === 8
        && ring?.attrs['vector-effect'] === 'non-scaling-stroke');
    ok('node refinement hides the full editing guide',
        !rect.anchorsGroup.children.some(child => child.attrs.class === 'shape-edit-guide'));
}
rect._updateAnchors(1, true);
ok('whole-shape selection restores guide and clears node ring',
    rect.anchorsGroup.children[0].attrs.class === 'shape-edit-guide'
    && !rect.anchorsGroup.children.some(child => child.attrs.class === 'schematic-node-selection-ring'));

const mixedWidth = new Polyline({
    closed: true, fill: true, lineWidth: 0.2,
    graphNodes: { a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, c: { x: 10, y: 10 }, d: { x: 0, y: 10 } },
    graphEdges: { e0: { from: 'a', to: 'b' }, e1: { from: 'b', to: 'c' },
        e2: { from: 'c', to: 'd' }, e3: { from: 'd', to: 'a' } },
});
mixedWidth.setNodeCornerRadius('b', 2);
const renderMixed = () => {
    const element = document.createElementNS('', 'g');
    mixedWidth._updateElement(element, '#fff', '#fff', 100);
    return element.children;
};
const beforeWidth = mixedWidth.captureState();
const fillBefore = renderMixed()[0].attrs.d;
mixedWidth.setEdgeAttr('e0', 'width', 0.8);
const mixedChildren = renderMixed();
ok('segment width does not change rounded fill geometry', mixedChildren[0].attrs.d === fillBefore);
ok('mixed-width rounded polygon has separate corner and edge strokes', mixedChildren.length === 6);
ok('separate corner and edge strokes have round caps at shared nodes',
    mixedChildren.slice(1).every(child => child.attrs['stroke-linecap'] === 'round'));
ok('only the selected segment uses the new width', mixedChildren[2].attrs['stroke-width'] === '0.8'
    && mixedChildren[1].attrs['stroke-width'] === '0.2'
    && mixedChildren.slice(3).every(child => child.attrs['stroke-width'] === '0.2'));
ok('rounded corner retains the PCB shape-wide width',
    mixedChildren[1].attrs.d === 'M 8 0 Q 10 0 10 2');
ok('incoming and outgoing edges stop at the corner tangencies',
    mixedChildren[2].attrs.d === 'M 0 0 L 8 0'
    && mixedChildren[3].attrs.d === 'M 10 2 L 10 10');
ok('single-node rounding survives segment width edits', mixedWidth.nodeCornerRadius('b') === 2
    && mixedWidth.nodeCornerRadius('a') === 0 && mixedWidth.nodeCornerRadius('c') === 0);
ok('selected straight portion still stops at the rounded corner', mixedWidth.getStraightEdgePortion('e0').second.x === 8);
mixedWidth.applyState(beforeWidth);
const restored = renderMixed();
ok('undo snapshot restores uniform width without losing the corner', restored.length === 2
    && restored[0].attrs.d === fillBefore && restored[1].attrs['stroke-width'] === '0.2');

const openRoundedLine = new Polyline({
    points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
    cornerRadius: 2, lineWidth: 0.8,
});
const openElement = document.createElementNS('', 'g');
openRoundedLine._updateElement(openElement, '#fff', '#fff', 100);
ok('uniform-width open rounded line has round endpoint caps', openElement.children.length === 1
    && openElement.children[0].attrs['stroke-linecap'] === 'round');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
