# ClearPCB Project File Format

ClearPCB saves one JSON document containing both the schematic and PCB. This
document describes the canonical format emitted by the current application
(`version: "2.0"`).

The format is JSON, not JSON5: comments, trailing commas, `NaN`, and `Infinity`
are not valid. Unknown fields should be ignored by readers where practical.
Writers should emit the canonical keys documented here.

## Document Envelope

```json
{
  "version": "2.0",
  "type": "clearpcb-project",
  "created": "2026-08-16T12:00:00.000Z",
  "schematic": {
    "settings": {},
    "shapes": [],
    "components": [],
    "defs": {}
  },
  "pcb": {}
}
```

| Field | Type | Description |
| --- | --- | --- |
| `version` | string | Current format version, `"2.0"`. |
| `type` | string | Document discriminator, `"clearpcb-project"`. |
| `created` | string | ISO 8601 timestamp generated each time the document is serialized. |
| `schematic` | object | Schematic settings, primitives, and component instances. |
| `pcb` | object | Optional PCB section. Omitted when the PCB has no persisted content. |

A project always has a schematic envelope. `ProjectDocument` adds the optional
`pcb` section after the schematic has serialized.

## General Conventions

- PCB distances and coordinates are millimetres.
- Coordinates use SVG screen orientation: positive X is right and positive Y
  is down. Gerber/Excellon export performs the Y-axis conversion.
- Rotations are degrees. Individual object sections below note visual direction
  where it matters.
- Many schematic objects use compact keys. Defaults are usually omitted.
- Shape and component coordinates are generally rounded to four decimal places.
  PCB via positions and diameters, fill outlines, and board-shape
  coordinates, radii and stroke widths follow this convention on save, including
  image placement points. Free-standing text, footprint placement and reference-text
  geometry, board dimensions, and routing design dimensions also use four decimals.
  Image source artwork remains lossless. Save-time rounding does not
  mutate live geometry or apply to detached fabrication snapshots.
- IDs are opaque strings. Readers must not infer object type solely from an ID
  prefix.
- Boolean fields omitted from compact objects take their documented default.

## Schematic Section

```json
{
  "schematic": {
    "settings": {
      "gridSize": 2.54,
      "units": "mm",
      "paperSize": "A4",
      "paperOrientation": "landscape",
      "titleBlock": true,
      "titleBlockInfo": false,
      "titleBlockData": {}
    },
    "shapes": [],
    "components": [],
    "defs": {}
  }
}
```

### Schematic Settings

| Field | Type | Description |
| --- | --- | --- |
| `gridSize` | number | Grid spacing in model units. Must be positive. |
| `gridStyle` | string | `"lines"` or `"dots"`. |
| `gridVisible` | boolean | Whether the grid is shown. |
| `snapToGrid` | boolean | Whether snapping is enabled; disabled when the grid is hidden. |
| `units` | string | Display units: `"mm"`, `"inch"`, or legacy `"mil"`. |
| `paperSize` | string or null | Paper preset key, such as `"A4"`; `null` means no paper. |
| `paperOrientation` | string or null | `"landscape"` or `"portrait"`. |
| `titleBlock` | boolean | Whether the title block is shown. Default `false`. |
| `titleBlockInfo` | boolean | Whether title-block information is shown. Default `false`. |
| `titleBlockData` | object | User-entered title-block values. |

### Common Schematic Shape Keys

The PCB section also stores `settings` with `gridSize`, `gridStyle`,
`gridVisible`, `snapToGrid`, and `units`, independently of the schematic.
These settings are included in project saves and autorecovery, even for an
empty PCB whose viewport has been initialized. Older files without these
fields retain the editor's current defaults.

Every entry in `schematic.shapes` has `id` and `type`. Shape subclasses extend
this compact base:

| Key | Long name | Type | Default when omitted |
| --- | --- | --- | --- |
| `id` | ID | string | Required. |
| `type` | shape type | string | Required. |
| `c` | color | string or number | Type constructor default. |
| `l` | layer | string | `"top"`. |
| `lw` | line width | number | `0.2`. |
| `v` | visible | boolean | `true`. |
| `lk` | locked | boolean | `false`. |

Canonical schematic shape types are `polyline`, `wire`, `circle`, `arc`,
`text`, `net`, and `noconnect`. The loader also recognizes `line`, `polygon`,
`rect`, `track`, and `Net` where applicable.

### Graph Shapes

Polylines and wires use graph storage rather than a single point array:

```json
{
  "id": "shape_1",
  "type": "polyline",
  "c": "#00b894",
  "nd": {
    "n0": [10, 10],
    "n1": [20, 10]
  },
  "ed": {
    "e0": ["n0", "n1"]
  },
  "cl": false,
  "f": false
}
```

| Key | Meaning |
| --- | --- |
| `nd` | Node map. Each value is `[x, y]`. |
| `ed` | Edge map. Each value is `[fromNodeId, toNodeId]`. |
| `cl` | Closed graph. Omitted/false means open. |
| `f` | Filled. Graph serializers emit this explicitly. |
| `fa` | Fill alpha. Omitted when `0.3`. |
| `cr` | Corner radius. Omitted when zero. |
| `bg` | Per-edge bulge map for curved edges. |
| `ir` | Polyline represents a rectangle. Omitted/false otherwise. |

The graph base can also emit subclass-defined per-edge maps. Tracks use `el`
and `ew` for edge-specific layers and widths.

#### Wire Additions

| Key | Meaning |
| --- | --- |
| `wl` | Wire label string. Emitted for every wire. |
| `pc` | Pin-connection map keyed by node ID. |
| `n` | Net name; omitted when empty. |
| `lo` | Non-default wire-label offset `[x, y]`. |

### Circle

```json
{
  "id": "shape_2",
  "type": "circle",
  "c": "#00b894",
  "x": 20,
  "y": 15,
  "r": 5,
  "f": true
}
```

`x` and `y` are the centre, `r` is the centreline radius, `f` enables fill, and
`fa` overrides the default fill alpha of `0.3`.

### Arc

```json
{
  "id": "shape_3",
  "type": "arc",
  "c": "#00b894",
  "sp": { "x": 10, "y": 20 },
  "ep": { "x": 30, "y": 20 },
  "bp": { "x": 20, "y": 12 },
  "f": true
}
```

The three control points are the source of truth:

- `sp`: start point.
- `ep`: end point.
- `bp`: bulge point on the arc.
- `f`: fill the area between the arc and its chord; omitted when false.

### Rect

A schematic rectangle is canonically a graph-based `polyline` with `ir: true`.
Its corners are stored in `nd`/`ed`; `cr` is the optional corner radius.
Fill-related fields use `f`, `fc`, and `fa`. The loader accepts `type: "rect"`
as a compatibility alias, but the current writer emits `type: "polyline"`.

### Text

| Key | Meaning | Default when omitted |
| --- | --- | --- |
| `x`, `y` | Text anchor position. | Required. |
| `t` | Display text. | Required. |
| `fs` | Font size. | `2.0`. |
| `ff` | Font family. | `"Arial"`. |
| `ta` | Text anchor. | `"start"`. |
| `rot` | Rotation in degrees. | `0`. |
| `cid` | Parent component/shape ID for linked fields. | None. |
| `fk` | Linked field key. | None. |
| `att` | Generic label attachment descriptor. | None. |

Derived text for a `net` shape is not persisted. It is recreated from the net
shape when the document loads.

### Net and No-Connect

A `net` stores `x`, `y`, and its name in `n`. Optional fields are:

- `fs`: non-default font size.
- `nst`: style; default `"t"`.
- `no`: orientation; default `"N"`.
- `nto`: non-zero text offset `[x, y]`.

A `noconnect` stores `x`, `y`, plus optional `pn` pin-connection metadata.

## Components and Definitions

Component instances are stored in `schematic.components`:

```json
{
  "type": "component",
  "id": "comp_1",
  "dn": "Device:R",
  "x": 40,
  "y": 25,
  "rot": 90,
  "mir": true,
  "ref": "R1",
  "val": "10k",
  "sr": false,
  "props": { "Tolerance": "1%" }
}
```

| Key | Meaning | Default when omitted |
| --- | --- | --- |
| `type` | Always `"component"`. | Required. |
| `id` | Component instance ID. | Required. |
| `dn` | Definition name. | Required. |
| `x`, `y` | Instance origin. | Required. |
| `rot` | Rotation in degrees. | `0`. |
| `mir` | Mirrored horizontally. | `false`. |
| `ref` | Reference designator. | Emitted. |
| `val` | Component value. | Emitted. |
| `sr` | Show reference. | `true`. |
| `sv` | Show value. | `true`. |
| `props` | Instance property map. | Empty object. |
| `v` | Visible. | `true`. |
| `lk` | Locked. | `false`. |

Non-built-in component definitions are embedded while serializing, then moved
to `schematic.defs` and deduplicated by definition name. Each component keeps
only `dn`. A definition commonly contains:

```json
{
  "name": "Vendor:Part",
  "category": "...",
  "description": "...",
  "symbol": {
    "width": 10,
    "height": 10,
    "origin": { "x": 5, "y": 5 },
    "graphics": [],
    "pins": []
  },
  "defaultReference": "U",
  "defaultValue": "Part",
  "defaultProperties": {},
  "_source": "KiCad",
  "footprintShapes": []
}
```

Definitions are intentionally extensible because imported providers carry
provider-specific symbol, footprint, supplier, and 3D-model metadata.

## PCB Section

```json
{
  "pcb": {
    "board": { "width": 100, "height": 80, "radius": 3 },
    "design": {
      "trackWidth": 0.25,
      "clearance": 0.2,
      "viaDiameter": 0.8,
      "viaDrill": 0.4,
      "units": "mm",
      "router": "pathfinder"
    },
    "tracks": [],
    "vias": [],
    "boardShapes": [],
    "texts": [],
    "placements": {}
  }
}
```

### Board and Design

| Field | Type | Description |
| --- | --- | --- |
| `board.width` | number | Board width in mm. |
| `board.height` | number | Board height in mm. |
| `board.radius` | number | Board corner radius in mm. |
| `design.trackWidth` | number | Default track width in mm. |
| `design.clearance` | number | Copper clearance in mm. |
| `design.viaDiameter` | number | Default via outside diameter in mm. |
| `design.viaDrill` | number | Default via drill diameter in mm. |
| `design.units` | string | PCB UI display units, normally `"mm"` or `"inch"`. |
| `design.router` | string | Router mode, currently `"maze"` or `"pathfinder"`. |

Older documents without `design` retain the user's current working defaults.
A board outline is stored as the single shape with `layer: "board-outline"` in
`pcb.boardShapes`. Its kind must be `rect`, `polygon`, or `circle`; it uses the
same geometry, corner radii, and segment bulges as other board shapes. The
outline must remain closed and nondegenerate. It cannot be split, removed,
or duplicated through the clipboard. Deleting a polygon segment removes its
following vertex and reconnects the remaining boundary, with at least three
vertices retained.

`board.width` and `board.height` retain the outline's bounding-box dimensions
for compatibility. The shape geometry is authoritative, including its position.
Older documents containing only `board` dimensions are migrated to a rectangular
outline on activation. A missing/invalid board without an outline resets to the
default undrawn `100 x 80` board state.

### Tracks

Tracks use the schematic graph base plus track fields:

```json
{
  "id": "track_1",
  "type": "track",
  "c": "#d4a72c",
  "l": "top-copper",
  "nd": {
    "n0": [10, 10],
    "n1": [30, 10]
  },
  "ed": {
    "e0": ["n0", "n1"]
  },
  "f": false,
  "n": "GND",
  "w": 0.25,
  "el": { "e0": "bottom-copper" },
  "ew": { "e0": 0.4 },
  "pdc": {}
}
```

| Key | Meaning |
| --- | --- |
| `n` | Net name; omitted when empty. |
| `w` | Shape-wide width; omitted when `0.2`. |
| `l` | Shape-wide layer. |
| `el` | Edge-layer overrides keyed by edge ID. |
| `ew` | Edge-width overrides keyed by edge ID. |
| `cr` | Overall corner radius in mm; omitted when zero. |
| `ncr` | Per-node corner-radius overrides keyed by node ID, including zero to retain a sharp corner. |
| `bg` | Edge bulges keyed by edge ID. |
| `pdc` | Pad connections keyed by node ID. |
| `sbs` | Original board-shape snapshot when a named copper line was converted to a track. |

Per-edge maps contain only values that differ from the shape-wide default.

Track node radii override the overall `cr` value. Setting the overall radius in
the editor clears all node overrides; a subsequent node edit overrides only that
node (last set wins). Rounding applies to degree-two
corners with matching incident layers and two straight edges; endpoints, junctions,
arc-adjacent nodes and pad-connected nodes retain their original geometry. Rendering and fabrication
use the same sampled corner geometry without changing the editable graph.

Track `bg` values use the signed DXF bulge ratio, from -1 to 1, measured in the
edge's `from`-to-`to` direction. Zero is straight; magnitude 1 is a semicircle.
Splitting an arc retains its circle with a separate bulge for each new edge.
Line-to-track conversion and restoration retain segment widths, bulges and node
radii. The `sbs` snapshot retains source identity; live track geometry takes
precedence when restoring a line.

### Vias

```json
{
  "type": "via",
  "id": "via_1",
  "x": 20,
  "y": 10,
  "d": 0.8,
  "dr": 0.4,
  "n": "GND"
}
```

| Key | Meaning | Default when omitted |
| --- | --- | --- |
| `d` | Outside diameter in mm. | Constructor default. |
| `dr` | Drill diameter in mm. | Constructor default, clamped to `d`. |
| `n` | Net name. | Empty. |
| `lk` | Locked. | `false`. |
| `v` | Visible. | `true`. |

All vias, including track layer-change vias, are standalone entries in
`pcb.vias`. Tracks do not contain implicit vias.

### Generic Board Shapes

Board shapes use readable keys rather than the compact schematic shape keys.
Every entry contains:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Shape ID. |
| `kind` | string | `line`, `rect`, `polygon`, `arc`, `circle`, or `image`. |
| `layer` | string | PCB layer ID. |
| `geometryVersion` | number | `1` for centreline paths; circles use `2` to store the outer radius. |
| `lineWidth` | number | Stroke width in mm; centred on lines, arcs, rectangles and polygons, inward for circles. |
| `filled` | boolean | Whether the enclosed area is active. |
| `copperMode` | string | Copper/mask operation; see below. |
| `plated` | boolean | Plating flag for hole-layer shapes. |
| `net` | string | Net name; empty when unassigned. |
| `cornerRadius` | number | Default corner radius in mm for line, rectangle and polygon nodes. |
| `nodeCornerRadii` | object | Optional node-index to corner-radius overrides, including zero to retain a sharp corner. |
| `segmentBulges` | object | Optional segment-index to signed arc bulge ratio for line and polygon segments. Missing entries are straight. |

Geometry depends on `kind`:

```json
[
  { "kind": "line", "points": [{ "x": 0, "y": 0 }, { "x": 10, "y": 0 }], "segmentBulges": { "0": 0.25 } },
  { "kind": "polygon", "points": [{ "x": 0, "y": 0 }, { "x": 10, "y": 0 }, { "x": 5, "y": 5 }], "segmentBulges": { "1": -0.5 } },
  { "kind": "rect", "points": [{ "x": 0, "y": 0 }, { "x": 10, "y": 0 }, { "x": 10, "y": 5 }, { "x": 0, "y": 5 }], "cornerRadius": 1 },
  { "kind": "arc", "start": { "x": 0, "y": 0 }, "end": { "x": 10, "y": 0 }, "bulge": { "x": 5, "y": -2 } },
  { "kind": "circle", "x": 5, "y": 5, "radius": 3 }
]
```

Image records are single objects with `kind: "image"`, an optional `name`, and
four rectangular `points` in source-corner order (top-left, top-right,
bottom-right, bottom-left before rotation). The bounding box is selectable,
including transparent areas. Only top/bottom silk and copper layers are supported.
Images are always filled; `lineWidth` does not expand their artwork.

New saves and autosaves encode `artwork` losslessly using the smaller of:

- `{ "encoding": "tuples-v1", "data": [...] }` for small payloads.
- `{ "encoding": "deflate-tuples-v1", "bytes": N, "data": "..." }` for
  raw-DEFLATE compressed UTF-8 tuple JSON, stored as base64. `bytes` is the
  uncompressed byte length, limited to 8 MiB during decoding.
- `{ "encoding": "reference-v1", "index": N }` for identical artwork already
  stored by an earlier image in the same `boardShapes` array. The index is
  zero-based and must refer to a successfully decoded earlier image. References
  are rebuilt on every serialization, so deletion and reordering remain safe.

The tuple payload is `[width, height, kind, flags, geometry]`. `kind` is `0`
for rectangles, `1` for contours, or `2` for circles. Rectangle geometry is a
flat sequence of `x,y,width,height`; circles use `x,y,radius`; contours are an
array of flat `x,y` sequences, one per ring. Each of `invert`, `flipHorizontal`,
and `flipVertical` occupies two bits of `flags`, starting at the low bits:
`0` means absent, `1` means false, `3` means true; `2` is invalid.
Coordinates are not rounded or quantized. Full JSON numeric precision survives
save/load, including fractional source-pixel positions and radii. Each image's
four board-space points are saved to four decimal places independently of its artwork.
On load, rectangle validation allows the bounded error from rounding each coordinate
by at most 0.00005 mm. This preserves rounded rotated images without accepting
empty bounds or distortion beyond the rounding allowance and numeric tolerance.
Loaded duplicates are independently editable. Only persistence uses this encoding;
renderers and fabrication snapshots consume the decoded geometry described below.
Legacy uncompressed artwork is not supported and is rejected when loading a
project. Older app versions without these encoding tags cannot read compacted
image records.

Decoded rectangle artwork is `{ width, height, rectangles }`: integer raster
dimensions (1 to 512 pixels each), and 1 to 2,000 nonoverlapping pixel-space runs
`{ x, y, width, height }` wholly inside that raster. These runs are internal data,
not independently editable board shapes. Pixel coordinates map to world space
using points 0, 1 and 3 as the origin and horizontal/vertical axes. Moving or
resizing changes only `points`; artwork is unchanged. Original PNG/JPEG bytes
are not stored. The processed artwork is sufficient for rendering and Gerber export.
Artwork also accepts optional boolean `invert`, `flipHorizontal`, and
`flipVertical` settings, all defaulting to false. Flips reflect the source runs
within the raster bounds along the image's local axes, before rotation into world
space. Inversion complements the filled artwork within the full raster rectangle.
The source runs remain unchanged, so each setting is reversible. An inverted
solid image may have no visible artwork while retaining its selectable bounds.
On first polygon-geometry use, runs are unioned into continuous outer
and hole outlines. Triangulation is deferred until triangles are requested. Both are cached
in memory, not serialized. Moving and resizing only transform the cached geometry;
zooming does not repeat the union. This avoids internal run-edge rendering seams.

Traced images instead store `{ width, height, contours }`, with 1..2048
source dimensions (rectangle artwork remains limited to 1..512).
Each contour is a closed ring (closure implicit) of at least
three finite `{ x, y }` points within the source bounds; coordinates may be
fractional. The limit is 2,000 rings and 50,000 points in total. Rings use even-odd
fill, independent of winding, so nested rings preserve holes and islands.
`rectangles` and `contours` are mutually exclusive. The same optional invert/flip
flags apply to either representation. ImageTracerJS and VTracer fitted curves are flattened
with a maximum 0.125-source-pixel chord deviation and stored as contours; no library
objects, SVG markup, or original image bytes are persisted. Older ClearPCB versions
without contour-image support cannot load these new traced image records.

Halftone images store `{ width, height, circles }`, with 1..2048 source dimensions
and 1..20,000 circles. Each circle is `{ x, y, radius }` in source-pixel coordinates;
all values must be finite, radius must be positive, and the entire circle must lie
within the source bounds. `rectangles`, `contours` and `circles` are mutually exclusive.
The contour point budget does not apply to circles. Circle areas are unioned, not
even-odd XORed; optional invert/flip flags have the same meaning as for rectangle
and contour images. Circles are drawn natively in the import preview, SVG editor and
2D viewer; native paths are cached by artwork identity. Detailed 2D halftones also
use a resolution-aware bitmap cache (at most 2048 pixels per side), with native
curves at higher zoom. The 3D viewer builds separated, non-inverted circles directly
as meshes. Inverted overlapping circles retain a polygon fallback. Polygon outlines
(0.125-source-pixel chord tolerance, at least 12 sides) are generated only for
consumers that need them. Triangulation is separately lazy. These caches and world
transforms are never stored in the project. Pour obstacles and DRC clearance use
the image's four `points` as one rotated rectangular boundary, independent of the
internal artwork representation. Actual copper output and contact geometry retain
the artwork, including holes and gaps. Dot size is computed from grayscale
cell averages at import; the source photo, dot-size setting and sampling grid are
not persisted. Contour-based halftones use the same compact storage encodings. Older versions
without circle-artwork support cannot load the new records. This representation
is internal to an image and is distinct from standalone board circle objects.

Lines, arcs, rectangles and polygons store centreline coordinates. Their strokes
extend half the width on each side of the path. Nodes and midpoint handles sit
on the editing path, independent of thickness; corner radii remain independent
of thickness too. Crossings are allowed and centred strokes are unioned. Filled
polygons use the even-odd fill rule in addition to the centred stroke.

Line and polygon entries can mix straight and circular segments using
`segmentBulges`. Segment index `i` runs from `points[i]` to `points[i + 1]`;
for polygons, the final index runs from the last point back to point `0`.
The value is the signed DXF-style ratio of arc sagitta to half-chord, clamped to
`[-1, 1]`. Its sign selects the side of the chord, and reversing a segment
negates its value. Missing, zero, non-finite and negligible values are treated
as straight segments. Rectangle records do not use per-segment bulges; adding
one converts the editable shape to a polygon.

Circles continue to store the outer radius, with thickness extending inward.
Circle records without `geometryVersion: 2` have half the old stroke width added
to their radius on load; new saves use version 2 to avoid repeating conversion.
Rectangle and polygon coordinates are loaded unchanged, including interim
version 2 records; their paths now receive centred strokes and `strokeSide` is
ignored. New saves use version 1 for non-circle shapes.
Rectangles and polygons always use round stroke joins and round segment caps,
including when their corner radius is zero. Set `cornerRadius` or
`nodeCornerRadii` to round the centreline corners independently of stroke width.
Each entry in `nodeCornerRadii` overrides `cornerRadius` for that indexed point.
Setting the overall corner radius in the editor clears all node overrides;
a subsequent node edit overrides only that node (last set wins).
Open lines support the same overall and per-node radii; their endpoints remain
unrounded. Corners adjacent to explicit arc segments retain the arc geometry.
Dragging nodes does not change the join style. Round stroke joins remain through
release, undo/redo and save/load; no per-node join-style flags are stored.

#### Copper Modes

| Value | Meaning |
| --- | --- |
| `add` | Add copper on a copper layer. Default. |
| `remove-copper` | Remove copper on the shape's copper side. |
| `remove-solder-mask` | Open solder mask without removing copper. |
| `remove-copper-mask` | Remove copper and open solder mask. |

Legacy values accepted on load are `remove` (mapped to
`remove-copper-mask`) and `remove-mask` (mapped to
`remove-solder-mask`).

### Copper Fills

Copper fills are stored inside `pcb.boardShapes` with `type: "fill"`:

```json
{
  "type": "fill",
  "id": "fill_1",
  "l": "top-copper",
  "pts": [[5, 5], [40, 5], [40, 30], [5, 30]],
  "n": "GND"
}
```

| Key | Meaning | Default when omitted |
| --- | --- | --- |
| `l` | `top-copper` or `bottom-copper`. | Required. |
| `pts` | Control vertices as `[x,y]` pairs, without a repeated closing point. | Required for polygon/rectangle. |
| `kind` | Closed outline geometry: `polygon`, `rect`, or `circle`. | `polygon`. |
| `cornerRadius` | Default corner radius in mm. | `0`. |
| `nodeCornerRadii` | Per-vertex corner radius overrides, keyed by vertex index. | `{}`. |
| `segmentBulges` | Signed arc bulges in `[-1,1]`, keyed by starting vertex index. | `{}` (straight edges). |
| `x`, `y`, `radius` | Circle center and radius in mm. | Required for circle. |
| `n` | Net name. | Empty. |
| `lk` | Locked. | `false`. |
| `v` | Visible. | `true`. |

Computed pour polygons are not persisted. They are regenerated from the
boundary, net, board, and obstacles after loading. The loader also accepts the
legacy top-level `pcb.fills` array.

The editing boundary and copper computation use the same sampled closed
contour. Control vertices and curve metadata remain editable after loading;
they are not replaced with the sampled contour. Fill edits preserve closure
and reject self-intersecting or degenerate outlines.

### PCB Text

```json
{
  "id": "text-abc123",
  "content": "REV A",
  "x": 10,
  "y": 20,
  "size": 1,
  "rotation": 0,
  "layer": "top-silk",
  "strokeWidth": 0.15
}
```

PCB text uses Hershey stroke geometry. Positive rotation is visually
counter-clockwise even though model Y points down. Valid text layers are
`top-silk`, `bottom-silk`, `top-copper`, and `bottom-copper`.

### Placement Overrides

Only manually overridden footprint positions are persisted. The map key is the
schematic component ID:

```json
{
  "placements": {
    "comp_1": {
      "x": 35,
      "y": 20,
      "rotation": 90,
      "mirror": true,
      "side": "bottom",
      "refVisible": false,
      "refDx": 1,
      "refDy": -2,
      "refRot": 90,
      "refSize": 1.2,
      "refStrokeWidth": 0.18
    }
  }
}
```

Only non-default optional values are emitted. Defaults on load are top side,
not mirrored, visible reference, zero offsets/rotation, and application default
reference size/stroke width.

## PCB Layer IDs

Common persisted layer IDs are:

- `top-copper`, `bottom-copper`
- `top-silk`, `bottom-silk`
- `top-mask`, `bottom-mask`
- `top-paste`, `bottom-paste`
- `hole`
- `top-document`, `bottom-document`
- `board-outline`

Document layers contain design/reference graphics. They are available in the PCB
editor and PDF/print exports, but do not alter copper, solder mask, or the board
substrate and are excluded from fabricated-board previews and Gerbers.

Pad side values are shorter: `top`, `bottom`, or `both`.

## Compatibility and Long-Key Aliases

The schematic shape loader expands these compact keys to constructor fields:

| Compact | Long field | Compact | Long field |
| --- | --- | --- | --- |
| `c` | `color` | `l` | `layer` |
| `lw` | `lineWidth` | `v` | `visible` |
| `lk` | `locked` | `pts` | `points` |
| `n` | `net` | `nd` | `graphNodes` |
| `ed` | `graphEdges` | `pc` | `pinConnections` |
| `wl` | `wireLabel` | `el` | `edgeLayers` |
| `ew` | `edgeWidths` | `bg` | `edgeBulges` |
| `pdc` | `padConnections` | `sbs` | `sourceBoardShape` |
| `r` | `radius` | `w` | `width` |
| `h` | `height` | `cr` | `cornerRadius` |
| `ncr` | `nodeCornerRadii` |  |  |
| `f` | `fill` | `fc` | `fillColor` |
| `fa` | `fillAlpha` | `cl` | `closed` |
| `ir` | `isRect` | `sp` | `startPoint` |
| `ep` | `endPoint` | `bp` | `bulgePoint` |
| `t` | `text` | `fs` | `fontSize` |
| `ff` | `fontFamily` | `ta` | `textAnchor` |
| `cid` | `componentId` | `fk` | `fieldKey` |
| `rot` | `rotation` | `att` | `attachment` |
| `pn` | `pinConnection` | `lo` | `labelOffset` |
| `nst` | `style` | `no` | `orientation` |
| `nto` | `textOffset` |  |  |

The via and copper-fill loaders separately accept both compact and long names:
`d`/`diameter`, `dr`/`drill`, `n`/`net`, `l`/`layer`, `lk`/`locked`,
`v`/`visible`, and `pts`/`outline`.

Component loading accepts `dn`/`definitionName`, `def`/`definition`, and the
instance compact keys emitted by `Component.toJSON()`.

## Data Not Stored in Project Files

The following data is derived or belongs to application storage rather than the
project document:

- Rendered SVG/Canvas/Three.js objects.
- Selection, hover, drag, undo, and redo state.
- Ratsnest lines and DRC results.
- Computed copper-pour polygons.
- Derived net-label text.
- Automatically generated footprint placements that the user did not move.
- Component-library HTTP caches and TTL metadata from `StorageManager`.
- Local UI preferences that are not listed under schematic settings or
  `pcb.design`.

## Minimal Valid Project

```json
{
  "version": "2.0",
  "type": "clearpcb-project",
  "created": "2026-08-16T12:00:00.000Z",
  "schematic": {
    "settings": {
      "gridSize": 2.54,
      "units": "mm",
      "paperSize": null,
      "paperOrientation": null,
      "titleBlock": false,
      "titleBlockInfo": false,
      "titleBlockData": {}
    },
    "shapes": [],
    "components": []
  }
}
```

## Implementation Sources

The format is currently defined by serializers and loaders rather than a JSON
Schema file. The authoritative implementation points are:

- `src/core/ProjectDocument.js`: document assembly and section ownership.
- `src/schematic/modules/files.js`: schematic envelope save/load.
- `src/shapes/shape.js` and concrete classes in `src/shapes/`: compact shape
  serialization.
- `src/components/Component.js`: component instance and embedded-definition
  serialization.
- `src/ui/PCBApp.js`: PCB section save/load.
- `src/pcb/modules/board-shapes.js`: generic board shapes.
- `src/shapes/track.js`, `src/shapes/via.js`, and
  `src/shapes/copper-fill.js`: routed PCB entities.
- `src/pcb/modules/pcb-text.js`: PCB text.

When changing a serializer, update this document in the same change.
