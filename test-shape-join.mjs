/**
 * Headless tests for the arc-edge / shape-join foundation.
 * Run with:  node test-shape-join.mjs
 *
 * Validates the pure geometry + data model (no browser) so the join feature
 * can be checked without a DOM. A minimal `document` stub is installed first
 * so the shape modules import and construct cleanly.
 */

// ── Minimal DOM stub (shapes only touch the DOM when rendering) ──
globalThis.document = {
    createElementNS: () => {
        const el = {
            _text: '',
            attrs: {},
            children: [],
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
const { Arc } = await import('./src/shapes/arc.js');
const { findJoinTarget, joinShapes, joinableAnchors, isJoinable } = await import('./src/shapes/shape-join.js');
const { createShape } = await import('./src/shapes/index.js');
const { arcFromBulge, distanceToArcEdge, arcEdgeBounds } = await import('./src/shapes/arc-edge.js');
const { bulgeRatio } = await import('./src/core/geometry.js');

let pass = 0, fail = 0;
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
function ok(name, cond) {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name}`); }
}

// ── 1. Arc geometry from a bulge ──
console.log('arc-edge geometry');
{
    const a = { x: 0, y: 0 }, b = { x: 10, y: 0 };
    const arc = arcFromBulge(a, b, 1); // semicircle, positive = left of a→b (=+y)
    ok('semicircle radius = 5', arc && approx(arc.radius, 5));
    ok('semicircle centre = (5,0)', arc && approx(arc.cx, 5) && approx(arc.cy, 0));

    ok('point on arc top has ~0 distance', approx(distanceToArcEdge({ x: 5, y: 5 }, a, b, 1), 0, 1e-6));
    ok('point 1 above top has distance 1', approx(distanceToArcEdge({ x: 5, y: 6 }, a, b, 1), 1, 1e-6));

    const bnds = arcEdgeBounds(a, b, 1);
    ok('bounds span the bulge', approx(bnds.minX, 0) && approx(bnds.maxX, 10) && approx(bnds.minY, 0) && approx(bnds.maxY, 5));

    ok('straight edge (bulge 0) → null arc', arcFromBulge(a, b, 0) === null);
}

// ── 2. Arc bulge round-trip ──
console.log('Arc → bulge round-trip');
{
    const arc = new Arc({ startPoint: { x: 0, y: 0 }, endPoint: { x: 10, y: 0 }, bulgePoint: { x: 5, y: 5 } });
    const bulge = bulgeRatio(arc.getStartPoint(), arc.getEndPoint(), arc.bulgePoint);
    ok('bulge of a 5-high semicircle chord-10 = 1', approx(bulge, 1));
    const geo = arcFromBulge(arc.getStartPoint(), arc.getEndPoint(), bulge);
    ok('reconstructed radius matches (5)', geo && approx(geo.radius, 5));
}

// ── 3. Bulge serialisation round-trip ──
console.log('Polyline bulge serialisation');
{
    const p = new Polyline({
        graphNodes: { n0: { x: 0, y: 0 }, n1: { x: 10, y: 0 } },
        graphEdges: { e0: { from: 'n0', to: 'n1' } },
        edgeBulges: { e0: 0.6 },
    });
    ok('edge bulge applied from options', approx(p.getEdgeAttr('e0', 'bulge'), 0.6));

    const json = p.toJSON();
    ok('toJSON emits compact bg map', json.bg && approx(json.bg.e0, 0.6));

    const p2 = createShape(json);
    ok('round-trip preserves bulge', approx(p2.getEdgeAttr('e0', 'bulge'), 0.6));

    // Default (0) bulge should NOT be serialised.
    const straight = new Polyline({ points: [{ x: 0, y: 0 }, { x: 5, y: 0 }] });
    ok('straight polyline omits bg', straight.toJSON().bg === undefined);
}

// ── 4. clone() preserves the graph + bulge ──
console.log('Polyline clone');
{
    const p = new Polyline({
        graphNodes: { n0: { x: 0, y: 0 }, n1: { x: 10, y: 0 }, n2: { x: 20, y: 0 } },
        graphEdges: { e0: { from: 'n0', to: 'n1' }, e1: { from: 'n1', to: 'n2' } },
        edgeBulges: { e0: 0.8 },
    });
    const c = p.clone();
    ok('clone keeps node count', c.nodes.size === 3);
    ok('clone keeps edge count', c.edges.size === 2);
    ok('clone keeps bulge', approx(c.getEdgeAttr('e0', 'bulge'), 0.8));
}

// ── 5. joinShapes: Arc + line → single curved Polyline ──
console.log('joinShapes');
{
    const arc = new Arc({ startPoint: { x: 0, y: 0 }, endPoint: { x: 10, y: 0 }, bulgePoint: { x: 5, y: 5 } });
    const line = new Polyline({ points: [{ x: 10, y: 0 }, { x: 20, y: 0 }] });

    ok('arc is joinable', isJoinable(arc));
    ok('line is joinable', isJoinable(line));

    const lineEnd = joinableAnchors(line).find(a => approx(a.x, 10) && approx(a.y, 0));
    ok('found line endpoint at (10,0)', !!lineEnd);

    const merged = joinShapes(arc, 'end', line, lineEnd.id);
    ok('merge produced a polyline', merged && merged.type === 'polyline');
    ok('merged has 3 nodes', merged && merged.nodes.size === 3);
    ok('merged has 2 edges', merged && merged.edges.size === 2);

    // Exactly one edge should be curved (the former arc), bulge magnitude 1.
    const bulges = merged ? [...merged.edges.values()].map(e => e.bulge || 0) : [];
    const curved = bulges.filter(b => Math.abs(b) > 1e-4);
    ok('exactly one curved edge', curved.length === 1);
    ok('curved edge bulge magnitude = 1', curved.length === 1 && approx(Math.abs(curved[0]), 1));
}

// ── 6. joinShapes closing a loop marks it closed ──
console.log('joinShapes closing a loop');
{
    // An open 3-edge chain whose ends meet → closed triangle.
    const a = new Polyline({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 8 }] });
    const b = new Polyline({ points: [{ x: 5, y: 8 }, { x: 0, y: 0 }] });
    const aEnd = joinableAnchors(a).find(an => approx(an.x, 5) && approx(an.y, 8));
    const bEnd = joinableAnchors(b).find(an => approx(an.x, 5) && approx(an.y, 8));
    const merged = joinShapes(a, aEnd.id, b, bEnd.id);
    ok('triangle merged to 3 nodes', merged && merged.nodes.size === 3);
    ok('triangle merged to 3 edges', merged && merged.edges.size === 3);
    ok('loop marked closed', merged && merged.closed === true);
}

console.log('self-join closes a four-edge line');
{
    const line = new Polyline({
        points: [
            { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 },
            { x: 0, y: 10 }, { x: 0, y: 0 },
        ],
    });
    const endpoints = joinableAnchors(line);
    const draggedEndpoint = endpoints[1];
    const target = findJoinTarget([line], draggedEndpoint, 0.01, line, draggedEndpoint.id);
    const merged = target && joinShapes(line, draggedEndpoint.id, target.shape, target.anchorId);
    ok('opposite endpoint is available as a self-join target', target?.anchorId === endpoints[0].id);
    ok('self-join preserves four rectangle nodes', merged?.nodes.size === 4);
    ok('self-join preserves four rectangle edges', merged?.edges.size === 4);
    ok('self-joined rectangle is closed', merged?.closed === true);
    ok('self-joined axis-aligned loop is a rectangle', merged?.isRect === true);
}

// ── 7. Bulge apex handle: drag sets edge curvature ──
console.log('bulge apex handle');
{
    const p = new Polyline({
        graphNodes: { n0: { x: 0, y: 0 }, n1: { x: 10, y: 0 } },
        graphEdges: { e0: { from: 'n0', to: 'n1' } },
        edgeBulges: { e0: 0.5 },
    });
    const handles = p.getAnchors().filter(a => a.bulge);
    ok('curved edge has a bulge handle', handles.length === 1);
    ok('bulge handle id targets the edge', handles.length === 1 && handles[0].id === 'bulge_e0');

    // Dragging the apex to (5,5): chord len 10 → half 5 → bulge ≈ 1.
    p.moveAnchor('bulge_e0', 5, 5);
    ok('drag apex to semicircle → bulge ≈ 1', approx(p.getEdgeAttr('e0', 'bulge'), 0.999, 1e-3));

    // Dragging back onto the chord flattens it (bulge ≈ 0).
    p.moveAnchor('bulge_e0', 5, 0);
    ok('drag apex onto chord → bulge ≈ 0', approx(p.getEdgeAttr('e0', 'bulge'), 0, 1e-3));

    // A straight edge exposes no bulge handle.
    const straight = new Polyline({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] });
    ok('straight edge has no bulge handle', straight.getAnchors().filter(a => a.bulge).length === 0);
}

// ── 8. cleanGraph preserves curved edges ──
console.log('cleanGraph preserves arcs');
{
    // Middle node is degree-2 and collinear → normally simplified away. With a
    // curved incident edge it must be preserved (else the arc is lost).
    const p = new Polyline({
        graphNodes: { n0: { x: 0, y: 0 }, n1: { x: 10, y: 0 }, n2: { x: 20, y: 0 } },
        graphEdges: { e0: { from: 'n0', to: 'n1' }, e1: { from: 'n1', to: 'n2' } },
        edgeBulges: { e0: 0.7 },
    });
    p.cleanGraph();
    ok('curved-edge node not simplified away', p.nodes.size === 3 && p.edges.size === 2);
    ok('bulge survives cleanGraph', approx(p.getEdgeAttr('e0', 'bulge'), 0.7));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
