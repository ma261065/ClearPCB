# Shape joining & curved (arc) edges

This feature lets drawing shapes be **fused into a single shape** by dragging
one shape's endpoint onto another's, and lets individual segments of that shape
be **curved into arcs**. The data model and geometry live in the shared shape
layer; the endpoint-join gesture is wired in the schematic editor.

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
  side; magnitude the curvature (clamped to a semicircle, `|bulge| <= 1`).

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

`PolylineGraph` and the schematic renderer use these for arc-aware path
construction, bounds (`_calculateBounds`), and hit-testing
(`distanceTo`/`closestEdge`). When any edge is curved, the fill is drawn as an
arc-aware outline path (`_buildOutlinePathD`) instead of a polygon.

## Joining — [`src/shapes/shape-join.js`](../src/shapes/shape-join.js)

Pure functions (take the shapes array directly, no editor state):

- `isJoinable(shape)` / `joinableAnchors(shape)` — which shapes/endpoints can join.
- `findJoinTarget(shapes, worldPos, tol, dragShape, dragAnchorId)` — nearest joinable endpoint
  on another shape; drives the snap highlight and the drop merge.
- `joinShapes(shapeA, anchorA, shapeB, anchorB)` — fuse into a new `Polyline`
  (via `absorb` + `mergeNodes`); auto-fuses any further coincident open ends and
  marks the result `closed` if it becomes a cycle. Self-join (same shape) closes
  a loop via `joinShapeEndpoints`.

## Editing curvature — bulge apex handle

`PolylineGraph.getAnchors()` emits a `bulge_<edgeId>` handle (rendered as a green
circular handle, see `core/ui-helpers.js`) at each **curved** edge's apex, for non-wire
shapes. `moveAnchor('bulge_…')` recomputes the edge bulge from the drag point.
`getAnchorSnapMode` returns `'none'` for these so they move freely.
`cleanGraph` and `isAxisAlignedRect` skip curved edges so arcs are never
flattened or mis-promoted to rectangles.

## Schematic wiring

- `schematic/modules/draw-states.js` `anchorDragState.mousemove`: for joinable
  shapes, calls `findJoinTarget` and shows the snap dot (`updateSnapHighlight`).
- `handleDragEnd` → `commitShapeJoin` in `schematic/modules/drag.js`: builds the merged
  `Polyline` and replaces the two originals in one undoable `BatchCommand`
  (`DeleteShapesCommand` + `AddShapeCommand`).

## PCB reuse status

The data model, geometry, join logic, and bulge handle live in the shared
`src/shapes/` layer and `core/`. PCB `Track` already extends `PolylineGraph` and
declares the same `bulge` edge attribute for curved track segments. Free-standing
PCB board shapes have their own arc/segment editing path in
`src/pcb/modules/board-shapes.js` and `board-shape-properties.js`.

The endpoint-to-endpoint shape-join gesture is available in the schematic
editor. The PCB editor does not call it. To add it, a PCB drag adapter would call
`findJoinTarget(app.shapes, pos, tol, dragShape, dragAnchorId)` and commit the
result of `joinShapes()` through PCB commands. No schematic types are referenced
by the shared modules.

## Tests

[`tests/unit/test-shape-join.mjs`](../tests/unit/test-shape-join.mjs) validates the geometry, bulge
serialisation round-trip, clone, join (incl. loop closing), the bulge handle,
and `cleanGraph` arc preservation headlessly: `node tests/unit/test-shape-join.mjs`.
