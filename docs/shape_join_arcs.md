# Shape joining & curved (arc) edges

This feature lets drawing shapes be **fused into a single shape** by dragging
one shape's endpoint onto another's, and lets individual segments of that shape
be **curved into arcs**. It is built entirely in the shared shape layer so the
PCB editor's drawing tools can reuse it without any schematic-specific code.

## Data model — the "merged-path" approach

A joined result is always a single [`Polyline`](../src/shapes/polyline.js)
(a [`PolylineGraph`](../src/shapes/polyline-graph.js)). Curvature is stored as a
**per-edge `bulge` attribute** using the existing per-edge attribute system
(the same mechanism `Track` uses for `layer`/`width`):

```js
static edgeAttributes = {
    bulge: { prop: 'edgeBulges', json: 'bg', default: () => 0 },
};
```

- `bulge === 0` → straight segment.
- `bulge !== 0` → circular arc. The value is the DXF-style signed bulge ratio
  (`core/geometry.js` `bulgeRatio`/`bulgePointFromRatio`): signed perpendicular
  distance of the apex from the chord midpoint ÷ half-chord. Sign selects the
  side; magnitude the curvature (clamped to a semicircle, `|bulge| ≤ 1`).

An `Arc` shape (3 control points) becomes **one bulge edge**:
`bulge = bulgeRatio(start, end, bulgePoint)`.

## Pure geometry — [`src/shapes/arc-edge.js`](../src/shapes/arc-edge.js)

No DOM, no shape classes — reusable anywhere:

| Function | Purpose |
| --- | --- |
| `arcFromBulge(a,b,bulge)` | Resolve `{cx,cy,radius,startAngle,endAngle,sweep,...}` (null if straight). |
| `arcEdgePathD(a,b,bulge)` | Full SVG path for one edge (`M…A…` or `M…L…`). |
| `arcEdgeContinuation(a,b,bulge)` | Path command to chain onto a continuous outline (`A…`/`L…`). |
| `distanceToArcEdge(p,a,b,bulge)` | Exact hit-test distance. |
| `arcEdgeBounds(a,b,bulge)` | AABB including the arc bulge. |
| `sampleArcEdge(a,b,bulge,segs)` | Points along the arc. |
| `BULGE_EPS` | Below this magnitude an edge is treated as straight. |

`PolylineGraph` uses these for rendering (`_updateElement`), bounds
(`_calculateBounds`), and hit-testing (`distanceTo`/`closestEdge`). When any
edge is curved, the fill is drawn as an arc-aware outline path
(`_buildOutlinePathD`) instead of a polygon.

## Joining — [`src/shapes/shape-join.js`](../src/shapes/shape-join.js)

Pure functions (take the shapes array directly, no editor state):

- `isJoinable(shape)` / `joinableAnchors(shape)` — which shapes/endpoints can join.
- `findJoinTarget(shapes, worldPos, tol, dragShape)` — nearest joinable endpoint
  on another shape; drives the snap highlight and the drop merge.
- `joinShapes(shapeA, anchorA, shapeB, anchorB)` — fuse into a new `Polyline`
  (via `absorb` + `mergeNodes`); auto-fuses any further coincident open ends and
  marks the result `closed` if it becomes a cycle. Self-join (same shape) closes
  a loop via `joinShapeEndpoints`.

## Editing curvature — bulge apex handle

`PolylineGraph.getAnchors()` emits a `bulge_<edgeId>` handle (rendered as a green
diamond, see `core/ui-helpers.js`) at each **curved** edge's apex, for non-wire
shapes. `moveAnchor('bulge_…')` recomputes the edge bulge from the drag point.
`getAnchorSnapMode` returns `'none'` for these so they move freely.
`cleanGraph` and `isAxisAlignedRect` skip curved edges so arcs are never
flattened or mis-promoted to rectangles.

## Schematic wiring (the only editor-specific glue)

- `schematic/modules/draw-states.js` `anchorDragState.mousemove`: for joinable
  shapes, calls `findJoinTarget` and shows the snap dot (`updateSnapHighlight`).
- `handleDragEnd` → `commitShapeJoin` in `ui/modules/drag.js`: builds the merged
  `Polyline` and replaces the two originals in one undoable `BatchCommand`
  (`DeleteShapesCommand` + `AddShapeCommand`).

## Reusing in the PCB editor

The data model, geometry, join logic, and bulge handle all live in the shared
`src/shapes/` layer and `core/`. To enable it in a PCB drawing tool:

1. Ensure the PCB drawing shape extends `PolylineGraph` (or use `Polyline`) so it
   inherits the `bulge` edge attribute, arc rendering, hit-test, bounds, and the
   apex handle. (`Track` already extends `PolylineGraph`; add a `bulge` entry to
   its `edgeAttributes` if curved tracks are wanted.)
2. In the PCB anchor-drag handler, call `findJoinTarget(app.shapes, pos, tol,
   dragShape)` and `commitShapeJoin`-equivalent logic with the PCB command stack.
   No schematic types are referenced by the shared modules.

## Tests

[`test-shape-join.mjs`](../test-shape-join.mjs) validates the geometry, bulge
serialisation round-trip, clone, join (incl. loop closing), the bulge handle,
and `cleanGraph` arc preservation headlessly: `node test-shape-join.mjs`.
