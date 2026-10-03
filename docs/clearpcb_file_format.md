# ClearPCB Project File Format

ClearPCB stores one logical JSON document containing both the schematic and PCB.
This document describes the canonical format (`version: "1.0"`). Files saved
with the pre-release `"2.0"` label are deliberately rejected, including old
autorecovery snapshots. There is no automatic migration.

On disk, `.cpcb` is a ZIP container: `options.json` holds the envelope,
`schematic.json` and optional `pcb.json` hold the sections, and `models/` holds
deduplicated meshes. The ZIP manifest uses `format: "clearpcb-zip", version: 1`;
that container version is independent of the project version and app release.
Plain JSON input is also supported, subject to the same project validation.

The format is JSON, not JSON5: comments, trailing commas, `NaN`, and `Infinity`
are not valid. ClearPCB-owned records are strict: unknown fields, obsolete
fields, and legacy representations make the file invalid. Record fields may
use either the compact persisted key or its documented long-form alias. If
both aliases occur with different values, the file is rejected as ambiguous;
equal duplicates are accepted and normalized. ClearPCB never mutates the
supplied object while normalizing it. Loading stops at the first error and
reports its property path plus a line-numbered JSON snippet of
the faulty value. Invalid JSON is reported with the ZIP member name, exact
source line and column, a bounded source excerpt, and a caret at the offending
character, including for minified one-line members. Provider-defined values nested inside supported component
metadata retain their provider-specific structure.

## Document Envelope

```json
{
  "version": "1.0",
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
| `version` | string | Current format version, `"1.0"`; independent of the app version. |
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
- ClearPCB saves all schematic and PCB record fields with compact keys.
  Structural section names such as `schematic`, `pcb`, `boardShapes`, and
  `placements` remain readable. Long-form record aliases are input-only.
- Defaults are usually omitted.
- Shape and component coordinates are generally rounded to four decimal places.
  PCB via positions and diameters, fill outlines, and board-shape
  coordinates, radii and stroke widths follow this convention on save. Images
  and rectangles save centre/size/rotation parameters instead of independently
  rounded corners. Free-standing text, footprint placement and reference-text
  geometry, board dimensions, and routing design dimensions also use four decimals.
  Image source artwork remains lossless. Save-time rounding does not
  mutate live geometry or apply to detached fabrication snapshots.
- For PCB polygons (including board outlines), polygon copper fills and simple
  closed schematic polygons, adjacent vertices that round to identical
  coordinates are merged on the save copy. Runs and the closing edge are
  included. Surviving edge/corner metadata is remapped; schematic edge IDs,
  directions and surviving node IDs are preserved. Cleanup must leave a valid
  closed outline; ordinary artwork retains even-odd crossings, while board
  outlines must remain simple. Collapsed curved edges, conflicting widths/radii and merged
  rounded corners fail explicitly rather than lose properties or enlarge a
  radius previously constrained by the tiny edge. Open lines, electrical graphs
  and parametric rectangles/images are not subject to this polygon cleanup.
- IDs are opaque strings. Readers must not infer object type solely from an ID
  prefix.
- Boolean fields omitted from compact objects take their documented default.

## Schematic Section

```json
{
  "schematic": {
    "settings": {
      "gs": 2.54,
      "u": "mm",
      "ps": "A4",
      "po": "landscape",
      "tb": true,
      "ti": false,
      "td": {}
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
| `gs` (`gridSize`) | number | Grid spacing in model units. Must be positive. |
| `gt` (`gridStyle`) | string | `"lines"` or `"dots"`. |
| `gv` (`gridVisible`) | boolean | Whether the grid is shown. |
| `sg` (`snapToGrid`) | boolean | Whether snapping is enabled; disabled when the grid is hidden. |
| `u` (`units`) | string | Display units: `"mm"` or `"inch"`. |
| `ps` (`paperSize`) | string or null | Paper preset key, such as `"A4"`; `null` means no paper. |
| `po` (`paperOrientation`) | string or null | `"landscape"` or `"portrait"`. |
| `tb` (`titleBlock`) | boolean | Whether the title block is shown. Default `false`. |
| `ti` (`titleBlockInfo`) | boolean | Whether title-block information is shown. Default `false`. |
| `td` (`titleBlockData`) | object | User-entered title-block values. |

### Common Schematic Shape Keys

The PCB section also stores `settings` with `gridSize`, `gridStyle`,
`gridVisible`, `snapToGrid`, and `units`, independently of the schematic.
These settings are included in project saves and autorecovery, even for an
empty PCB whose viewport has been initialized.

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
`text`, `net`, and `noconnect`. Type names are case-sensitive. In particular,
`net` is valid and `Net` is not.

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
| `nd` | Node map. Each value is `[x, y]`. New rectangle records use a frame and `cn` instead. |
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

A schematic rectangle remains a graph-based `polyline` with `ir: true` and
`cl: true`. New records store the rectangle frame described below
(`x`, `y`, `w`, `h`, `rot`, optional `rev`) and `cn` (`cornerNodeIds`):
an ordered array of four distinct node IDs. `nd` is omitted. The unchanged
`ed` map connects those four corners cyclically, preserving edge IDs and their
width/bulge metadata. `ncr` remains keyed by node ID. Coordinates are derived
from the frame when loading.

`cr` is the optional corner radius. Fill-related fields use `f`, `fc`, and `fa`.
Legacy rectangle records with `nd`/`ed` remain readable temporarily; saving them
emits the frame representation. Supplying both a frame and `nd` is invalid.
A persisted `points` array or `type: "rect"` is still invalid.

### Text

| Key | Meaning | Default when omitted |
| --- | --- | --- |
| `x`, `y` | Text anchor position. | Required. |
| `t` | Display text. | Required. |
| `fs` | Font size. | `2.0`. |
| `ff` | Font family. | `"Arial"`. |
| `ta` | Text anchor. | `"start"`. |
| `rot` | Rotation in degrees. | `0`. |
| `bd` | Rectangular border matching the schematic inline-editing box, in the text color. | `false`. |
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
- `bd`: rectangular border around the net name; default `false`.

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
| `pkg` (`packageId`) | Built-in package ID, selecting both footprint and offline 3D model. | `"default"`; normally omitted. |

Package selection is per instance and only applies to built-in library
definitions. Built-in geometry is regenerated from the bundled catalogue, not
embedded in the project. Older projects without `pkg` use the original package
with its bundled 3D model. An unknown package ID, a package not offered for that
component type, or `pkg` on an embedded/custom definition is rejected.

Non-built-in component definitions are embedded while serializing, then moved
to `schematic.defs` and deduplicated by definition name. Each component keeps
only `dn`. A definition commonly contains:

```json
{
  "n": "Vendor:Part",
  "cat": "...",
  "desc": "...",
  "sym": {
    "w": 10,
    "h": 10,
    "o": { "x": 5, "y": 5 },
    "g": [],
    "p": [
      {
        "i": "gge6",
        "k": "gge6",
        "pd": "M 0 2.54 h 2.54",
        "num": "2",
        "n": "3V3",
        "x": 0,
        "y": 2.54,
        "o": "right",
        "len": 2.54,
        "t": "passive",
        "np": { "x": 3.4798, "y": 2.8448, "rot": 0, "a": "start", "ff": null, "fs": 1.778 }
      }
    ]
  },
  "dr": "U",
  "dv": "Part",
  "dp": {},
  "src": "KiCad",
  "fsh": []
}
```

Known definition, symbol, graphic, pin, text-position, and footprint-bound
fields use the compact aliases listed below. Definitions remain extensible
because imported providers may also carry opaque provider-specific metadata;
unrecognized provider-owned keys are preserved unchanged.

## PCB Section

```json
{
  "pcb": {
    "stackup": { "cl": ["top-copper", "bottom-copper"] },
    "board": { "w": 100, "h": 80, "r": 3 },
    "design": {
      "tw": 0.25,
      "cl": 0.2,
      "vd": 0.8,
      "dr": 0.4,
      "u": "mm",
      "rt": "pathfinder"
    },
    "tracks": [],
    "vias": [],
    "pads": [],
    "boardShapes": [],
    "texts": [],
    "placements": {}
  }
}
```

### Board and Design

| Field | Type | Description |
| --- | --- | --- |
| `stackup.cl` (`copperLayers`) | string[] | Unique copper-layer IDs in physical top-to-bottom order. `stackup` is required when `pcb` exists. |
| `board.w` (`width`) | number | Board width in mm. |
| `board.h` (`height`) | number | Board height in mm. |
| `board.r` (`radius`) | number | Board corner radius in mm. |
| `design.tw` (`trackWidth`) | number | Default track width in mm; positive, at most 25. |
| `design.cl` (`clearance`) | number | Copper clearance in mm; positive, at most 10. |
| `design.vd` (`viaDiameter`) | number | Default via outside diameter in mm; positive, at most 25. |
| `design.dr` (`viaDrill`) | number | Default via drill diameter in mm; positive, at most 25. Larger saved routing values are clamped to these maximums on load. |
| `design.u` (`units`) | string | PCB UI display units, normally `"mm"` or `"inch"`. |
| `design.rt` (`router`) | string | Router mode, currently `"maze"` or `"pathfinder"`. |

`design` and all fields listed above are required when `pcb` exists.
A board outline is stored as the single shape with `layer: "board-outline"` in
`pcb.boardShapes`. Its kind must be `rect`, `polygon`, or `circle`; it uses the
same geometry, corner radii, and segment bulges as other board shapes. The
outline must remain closed and nondegenerate. It cannot be split, removed,
or duplicated through the clipboard. Deleting a polygon segment removes its
following vertex and reconnects the remaining boundary, with at least three
vertices retained.

`board.w` and `board.h` retain the outline's bounding-box dimensions.
The shape geometry is authoritative, including its position. A valid document
containing only board dimensions is repaired to a rectangular outline on
activation. A missing/invalid board without an outline resets to the default
undrawn `100 x 80` board state.

### Panelization

The optional `pcb.panelization` object stores a manufacturing layout, separate
from the single editable source PCB. Home > Fabrication > Panelize reopens these
settings. Applying changes or removing a panel supports undo/redo. Missing or
null settings mean no panel.

```json
{
  "r": 2,
  "c": 2,
  "rs": 2,
  "cs": 2,
  "sp": "tabs",
  "rt": 5,
  "rb": 5,
  "rl": 0,
  "rr": 0,
  "vt": 2,
  "ht": 2,
  "vo": 0,
  "ho": 0,
  "hph": false,
  "hf": false,
  "vph": false,
  "vf": false,
  "tw": 3,
  "hd": 0.5,
  "hp": 0.8
}
```

Dimensions are millimetres. Spacing is edge-to-edge between source outline
bounding boxes. Zero rail width disables that rail. Rows extend downwards and
columns rightwards from the source board. Counts are integers from 1 to 20,
with at most 100 boards and a maximum panel extent of 1000 mm per axis.

`tabs` creates routed gaps with `verticalTabsPerEdge` and `horizontalTabsPerEdge`
mouse-bite tabs per connected vertical and horizontal board edge respectively,
including connections to rails. Each count is an integer from 1 to 20,
defaulting to 2.
Tab centers divide the edge into equal cells, with a tab
at each cell's midpoint; the default retains quarter and three-quarter positions.
`verticalTabOffset` and `horizontalTabOffset` independently shift these centers
along vertical and horizontal edges in millimetres (-100 to 100, default 0).
Positive offsets move down on vertical edges and right on horizontal edges in
the editor; negative offsets move up/left. The same offsets apply to rail
connections. Holes move with their tabs,
not inward into the board. Independently, mouse-bite hole centers sit half a
hole diameter into the connecting tab from each board/rail boundary, so holes
are tangent to straight edges rather than centered on them. The gap at each
hole pair must exceed twice the hole diameter to keep opposing rows apart.
Tabs must remain strictly inside the edge ends
and must not touch each other. These controls do not affect V-cuts.
Rails use the corresponding board spacing
(at least 1 mm) as a routing gap. Hole pitch must exceed hole diameter.
`vcut` requires a square-cornered, axis-aligned rectangular source outline;
scores extend across the panel. Nonzero spacing leaves sacrificial strips
between V-scored boards. Cutter access, copper clearances, and tab/scoring
dimensions must be checked against the manufacturer's capabilities.

The Horizontal/Vertical edges groups independently enable positioning holes
and fiducial marks on their nonzero rails (top/bottom and left/right respectively).
All four boolean settings default to false and work with tabs or V-cuts.
Each enabled rail gets two 3 mm NPTH positioning holes and/or two 1 mm copper
fiducials with 3 mm mask openings on both sides, with no paste. Dimensions
are currently fixed. Features sit on the rail centerline, 2.5 mm in from each
end of the board-array span; when both options are on, fiducials move to
6.5 mm in from each end. Rails must be at least 5 mm wide and long enough
for the selected features. Validation enforces 1 mm clearance from rail edges,
other features, mouse-bite holes, and V-score lines. Confirm dimensions and
alignment-pattern requirements with the assembly provider.

The editor derives non-selectable, dimmed ghost copies from one shared PNG
snapshot, refreshed after source SVG changes pause for 120 ms. Panning and
zooming reuse the bitmap; once zoom settles, its resolution is refreshed in
power-of-two steps, capped at 2048 pixels per side. Rails and separation marks
remain vector geometry, and fabrication output is unaffected. Ghosts are not
stored as duplicate authored objects. Applying a panel initially creates its
note lines as ordinary `pcb.texts` objects on `top-document`, with normal
selection, editing, movement, deletion and undo. Existing panels from older
files get these texts on their next Apply. The optional `noteCreated: true`
panel setting records this conversion, so subsequent panel edits and redraws
do not overwrite edits or regenerate deleted notes. Removing panel settings
leaves these independent text objects untouched. The note is a snapshot at
creation; export instructions are always derived from current panel settings.
Panel Gerber export follows the inspected EasyEDA approach: copper, mask,
paste, silk, component drills, vias and source-board NPTH holes describe ONE
source board, without aperture blocks or step-and-repeat. Enabled rail fiducials
are an exception: copper and mask files also contain their full-panel positions.
Rail positioning holes are likewise already at full-panel positions in NPTH.
Neither rail feature should be repeated by the manufacturer. Gerber headers
describe the panel method, counts and dimensions. The manufacturer must repeat
the source artwork and component drills using the offsets in `panel-notes.txt`.
`board.gko` already contains the full panel substrate profile and repeated
cutouts. Source hole-layer cutouts are clipped to the source board outline
before repetition, so they do not remove material from tabs or rails. Crossing
hole-layer circles and slots, including those marked plated, are supplied as
clipped routed profiles rather than full Excellon drills or slots. A routed
profile does not specify edge plating; confirm that separately with the
manufacturer when the clipped opening is marked plated. Routing contours
are simplified to avoid retraced edges at cutout/gap junctions.
Edge-crossing footprint holes also become clipped routed openings in the
single-board or repeated panel profile, rather than disappearing from both
drill and outline output. They are not duplicated in Excellon.
`fabrication-notes.txt` identifies these openings by position, dimensions and
plating requirement; confirm routed-edge plating with the manufacturer.
For both single-board and panel exports, a hole-layer circle exactly tangent
to the source boundary (within 0.000001 mm of the sampled outline) receives
an automatic 0.01 mm radial routing relief. This converts the zero-width
contact into an open notch that CAM tools can interpret. It is omitted from
Excellon to avoid a duplicate drill. The saved geometry is unchanged; internal
holes with positive clearance outside that tolerance retain their drill size
and position. The same routed-edge plating caveat applies.
The source hole layer and ghost copies are
also clipped to the source outline in the panel preview. Mouse-bite holes
are already supplied at every panel tab and must NOT
be repeated. Confirm this workflow with the manufacturer before ordering:
the panel headers are comments, not executable repetition. V-scores are separate in
`board-vscore.gbr`, never through routes. The ZIP also includes
`panel-settings.json` and manufacturing notes. BOM, pick-and-place, and the
2D/3D board viewers continue to describe the source board.
Pick-and-place export rejects mirrored component placements with an
actionable, component-specific error: side and rotation alone cannot encode
that reflected geometry. Ordinary bottom-side placement remains supported.

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
| `sbs` | Original board-shape snapshot when a copper line, or an unfilled copper polygon/rectangle (closed loop), became a track. |

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
Copper lines, and unfilled copper polygons and rectangles, are tracks: drawing
one creates a track whether or not it has a net, and files that saved them as
board shapes load them as tracks (with `sbs` recording the source shape). The
conversion retains segment widths, bulges and both radius levels. A rectangular
loop (four axis-aligned straight edges on one layer, without node overrides)
rounds with circular quarter-arcs like a board rectangle; other tracks use
quadratic corners. Filling a closed loop turns it into a filled board shape that
keeps the `sbs` identity, net, width and radii.

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
| `sp` (`span`) | `{ "f": layerId, "t": layerId }` (or long `from`/`to` aliases), inclusive copper-layer endpoints in stack order. | Through via spanning the entire copper stack. |
| `n` | Net name. | Empty. |
| `lk` | Locked. | `false`. |
| `v` | Visible. | `true`. |

All vias, including track layer-change vias, are standalone entries in
`pcb.vias`. Tracks do not contain implicit vias.

Both span endpoints must be declared copper layers, with `from` before `to`.
A top-to-inner or inner-to-bottom span is blind; an inner-to-inner span is
buried. Every copper layer between the endpoints participates in the via.
The current editor can only load through vias on two-layer boards, and may
omit an explicit top-to-bottom span when saving because it equals the default.

### Standalone Pads

```json
{
  "type": "pad",
  "id": "pad_1",
  "x": 20,
  "y": 10,
  "sh": "stadium",
  "s": 1.5,
  "dr": 0.8,
  "ra": 2,
  "rot": 90,
  "ls": "both",
  "n": "GND"
}
```

| Key | Long input alias | Meaning | Default when omitted |
| --- | --- | --- | --- |
| `sh` | `shape` | `round`, `stadium`, `square`, `rectangle`, or `oval`. | `round` |
| `s` | `size` | Diameter for round pads; width and height for square pads; minor dimension for elongated pads. | 1.5 mm |
| `dr` | `drill` | Circular plated drill diameter, no larger than `s`. | 0.8 mm |
| `ra` | `ratio` | Major/minor dimension ratio for stadium, rectangle, and oval pads; at least 1. | 2 |
| `rot` | `rotation` | Clockwise rotation in degrees. | 0 |
| `ls` | `layers` | Copper coverage: `top-copper`, `bottom-copper`, or `both`. | `both` |
| `n` | `net` | Net name. | Empty |
| `lk` | `locked` | Locked. | `false` |
| `v` | `visible` | Visible. | `true` |

Standalone pads are plated through-hole features. Copper and solder-mask
openings are emitted on the selected side or sides, while the circular drill is
always emitted in the plated drill file. Pads may cross the outer board outline
or an internal routed cutout/slot edge; copper, mask, and edge plating follow
the routed boundary to support castellations.

### Generic Board Shapes

Board shapes are saved with compact keys. The long aliases in parentheses are
accepted on input.
Every entry contains:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Shape ID. |
| `k` (`kind`) | string | `line`, `rect`, `polygon`, `arc`, `circle`, or `image`. |
| `l` (`layer`) | string | PCB layer ID. |
| `lw` (`lineWidth`) | number | Stroke width in mm; centred on lines, arcs, rectangles and polygons, inward for circles. |
| `f` (`filled`) | boolean | Whether the enclosed area is active. |
| `cm` (`copperMode`) | string | Copper/mask operation; see below. |
| `p` (`plated`) | boolean | Plating flag for hole-layer shapes. |
| `n` (`net`) | string | Net name; empty when unassigned. |
| `cr` (`cornerRadius`) | number | Default corner radius in mm for line, rectangle and polygon nodes. |
| `ncr` (`nodeCornerRadii`) | object | Optional node-index to corner-radius overrides, including zero to retain a sharp corner. |
| `sb` (`segmentBulges`) | object | Optional segment-index to signed arc bulge ratio for line and polygon segments. Missing entries are straight. |

Geometry depends on `k` (`kind`):

```json
[
  { "k": "line", "pts": [{ "x": 0, "y": 0 }, { "x": 10, "y": 0 }], "sb": { "0": 0.25 } },
  { "k": "polygon", "pts": [{ "x": 0, "y": 0 }, { "x": 10, "y": 0 }, { "x": 5, "y": 5 }], "sb": { "1": -0.5 } },
  { "k": "rect", "x": 5, "y": 2.5, "w": 10, "h": 5, "rot": 0, "cr": 1 },
  { "k": "arc", "sp": { "x": 0, "y": 0 }, "ep": { "x": 10, "y": 0 }, "bp": { "x": 5, "y": -2 } },
  { "k": "circle", "x": 5, "y": 5, "r": 3 }
]
```

#### Rectangle frames

Images, PCB rectangles (including rectangular board outlines), schematic
rectangles, and rectangular copper fills use this common saved geometry:

| Key (long alias) | Meaning |
| --- | --- |
| `x`, `y` | Rectangle centre in board/schematic coordinates, mm. |
| `w` (`width`), `h` (`height`) | Positive width and height in mm. |
| `rot` (`rotation`) | Rotation in degrees, positive visually counterclockwise; saves normalize to `[0,360)`. |
| `rev` (`reversed`) | Optional reversed corner winding; default `false`. Preserves existing source-corner and indexed-metadata order. |

Centre, dimensions and rotation are rounded to four decimal places on save.
The corners are reconstructed from perpendicular axes, so independent corner
rounding cannot distort the rectangle. With `a = (cos(-rot), sin(-rot))` and
`b = (-a.y, a.x)` (angles converted to radians), the ordered corners are
`centre - w*a/2 - h*b/2`, `centre + w*a/2 - h*b/2`,
`centre + w*a/2 + h*b/2`, `centre - w*a/2 + h*b/2`.
When `rev` is true, negate `b`. This flag preserves winding; it does not toggle
the artwork's horizontal/vertical flip settings.

Frames must have all five finite numeric parameters and nonempty dimensions.
Dimensions that round to zero are rejected rather than saved as degenerate frames.
Partial frames or simultaneous frame and corner-coordinate representations
are rejected. Legacy corner-based images and rectangles remain readable for
migration, but new saves/autosaves use frames only. Older application versions
without frame support cannot read these new records.

#### Images

Image records are single objects with `k: "image"`, an optional `nm`, and a
rectangle frame. The derived corners retain source-corner order (top-left,
top-right, bottom-right, bottom-left before rotation). The bounding box is
selectable, including transparent areas. Top/bottom silk, copper and document
layers are supported.
Images are always filled; `lw` does not expand their artwork.

New saves and autosaves encode `aw` losslessly using the smaller of:

- `{ "e": "tuples-v1", "d": [...] }` for small payloads.
- `{ "e": "deflate-tuples-v1", "b": N, "d": "..." }` for
  raw-DEFLATE compressed UTF-8 tuple JSON, stored as base64. `b` is the
  uncompressed byte length, limited to 8 MiB during decoding.
- `{ "e": "reference-v1", "i": N }` for identical artwork already
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
save/load, including fractional source-pixel positions and radii. Placement is
stored separately as the rectangle frame above, not as rounded corner points.
For older rounded image records that fail strict rectangle validation, loading
uses a bounded coordinate tolerance of 0.0001 mm and normalizes the points to a
rectangle. Subsequent saves encode that rectangle as a frame.
Empty bounds and distortion beyond that allowance remain invalid; strict
runtime rectangle validation is unchanged.
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
transforms are never stored in the project. For all additive copper pictures,
clearance, DRC, ratlines, and routing contact checks treat the image's four `points`
as one solid rotated rectangle, independent of the internal artwork representation.
Separate dots do not require connections to each other; contacts anywhere inside
the rectangle belong to the same logical copper object. This also applies when
inversion leaves no visible artwork. It is an intentional logical approximation:
rendering and manufactured copper retain the actual artwork, including holes and
gaps, so logical connectivity does not guarantee connectivity between printed
islands. Copper-removal pictures remain non-conductive and cut their actual artwork.
Dot size is computed from grayscale
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

Circles store the outer radius, with thickness extending inward. All other shape
coordinates are loaded unchanged and their paths receive centred strokes.
`strokeSide` is not a format field and makes a file invalid.
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

The legacy aliases `remove` and `remove-mask` are invalid.

### Copper Fills

Copper fills are stored inside `pcb.boardShapes` with `type: "fill"`:

```json
{
  "type": "fill",
  "id": "fill_1",
  "l": "top-copper",
  "x": 22.5,
  "y": 17.5,
  "w": 35,
  "h": 25,
  "rot": 0,
  "k": "rect",
  "n": "GND"
}
```

| Key | Meaning | Default when omitted |
| --- | --- | --- |
| `l` | `top-copper` or `bottom-copper`. | Required. |
| `pts` | Control vertices as `[x,y]` pairs, without a repeated closing point. | Polygon/circle outline; legacy rectangles only. |
| `x`, `y`, `w`, `h`, `rot`, `rev` | Rectangle frame described above; preserves vertex-indexed metadata. | Required for rectangle except optional `rev`. |
| `k` (`kind`) | Closed outline geometry: `polygon`, `rect`, or `circle`. | Required. |
| `cr` (`cornerRadius`) | Default corner radius in mm. | `0`. |
| `ncr` (`nodeCornerRadii`) | Per-vertex corner radius overrides, keyed by vertex index. | `{}`. |
| `sb` (`segmentBulges`) | Signed arc bulges in `[-1,1]`, keyed by starting vertex index. | `{}` (straight edges). |
| `x`, `y`, `r` (`radius`) | Circle center and radius in mm. | Required for circle. |
| `n` | Net name. | Empty. |
| `lk` | Locked. | `false`. |
| `v` | Visible. | `true`. |

Computed pour polygons are not persisted. They are regenerated from the
boundary, net, board, and obstacles after loading. Copper fills are valid only
inside `pcb.boardShapes`; `pcb.fills` is invalid.

The editing boundary and copper computation use the same sampled closed
contour. Control vertices and curve metadata remain editable after loading;
they are not replaced with the sampled contour. Fill edits preserve closure
and reject self-intersecting or degenerate outlines.

### PCB Text

```json
{
  "id": "text-abc123",
  "t": "REV A",
  "x": 10,
  "y": 20,
  "s": 1,
  "rot": 0,
  "l": "top-silk",
  "lw": 0.15,
  "bd": true
}
```

| Field | Meaning | Default when omitted |
| --- | --- | --- |
| `id` | Unique PCB text ID. | Required. |
| `t` (`content`) | Display text. | Required. |
| `x`, `y` | Baseline-left anchor position in mm. | Required. |
| `s` (`size`) | Cap height in mm. | Required. |
| `rot` (`rotation`) | Visual counter-clockwise rotation in degrees. | Required. |
| `l` (`layer`) | PCB layer containing the text. | Required. |
| `lw` (`strokeWidth`) | Glyph and border line width in mm. | Required. |
| `bd` (`border`) | Rectangular border matching the PCB inline-editing box, in the text color. | `false`. |

PCB text uses Hershey stroke geometry. Positive rotation is visually
counter-clockwise even though model Y points down. Valid text layers are
`top-silk`, `bottom-silk`, `top-copper`, and `bottom-copper`. `bd` uses the
same geometry as the inline-editing box, including its cursor and descender
room, so entering and leaving edit mode does not show two almost-matching boxes.

### Placements

Resolved automatic footprint positions and explicit position, pose, reference
style or lock overrides are persisted. Automatic positions become stable saved
baselines on reload, preserving pad locations and track bonds after other
components are deleted or reordered. The map key is the schematic component ID:

```json
{
  "placements": {
    "comp_1": {
      "x": 35,
      "y": 20,
      "rot": 90,
      "lk": true,
      "mir": true,
      "sd": "bottom",
      "rv": false,
      "rdx": 1,
      "rdy": -2,
      "rr": 90,
      "rs": 1.2,
      "rw": 0.18
    }
  }
}
```

Only non-default optional values are emitted. Defaults on load are top side,
unlocked, not mirrored, visible reference, zero offsets/rotation, and
application default reference size/stroke width.

## PCB Layer IDs

Common persisted layer IDs are:

- `top-copper`, `bottom-copper`
- `inner-copper-1`, `inner-copper-2`, ... (format support; not yet editable)
- `top-silk`, `bottom-silk`
- `top-mask`, `bottom-mask`
- `top-paste`, `bottom-paste`
- `hole`
- `top-document`, `bottom-document`
- `board-outline`

Document layers contain design/reference graphics. They are available in the PCB
editor and PDF/print exports, but do not alter copper, solder mask, or the board
substrate and are excluded from fabricated-board previews and Gerbers.

Pad side values are shorter: `top`, `bottom`, or `both`. These are surface/through
pad classifications, not copper-layer indexes. A plated through pad marked
`both` spans every copper layer, including inner layers, rather than only the
two surfaces. Surface pads remain on the corresponding outer copper layer.

### Multilayer Contract

Format `1.0` supports any number of copper layers greater than or equal to two.
A four-layer example is:

```json
{
  "stackup": {
    "copperLayers": ["top-copper", "inner-copper-1", "inner-copper-2", "bottom-copper"]
  }
}
```

This object belongs in `pcb`. The first layer must be `top-copper`, the last
`bottom-copper`, and intermediate IDs must match `inner-copper-N`, where N is
a positive integer without leading zeros. IDs must be unique. Array order,
not the number in an ID, determines physical order. `stackup` and its
`copperLayers` list are required whenever `pcb` exists.

Tracks (`l` and `el`), fills and board shapes (`layer`), and PCB text reference
these same IDs. Copper references must be declared in the stackup. Mask,
paste, silk, and component side remain outer-surface concepts. No fixed-size
two-layer arrays or bit masks define connectivity in the persisted format.

Format validity and editor support are separate: `validateProject` accepts
well-formed multilayer data, but the two-layer editor rejects it before
preparing or replacing either view. It must not flatten, silently drop, render
as a two-layer board, or manufacture unsupported layers. Future multilayer
editing can use these fields without changing `version: "1.0"`.

This defines connectivity and ordering, not a physical laminate specification:
dielectric materials, copper weights, and impedance-controlled stackup details
are not presently represented. Any future extension affecting manufacturing
must be capability-checked before older editors may edit or export it.

### Version Policy

App releases such as `v1.0.0` and `v1.1.0` do not change the project version.
Adding inner layers using the contract above does not change it either.
Additive optional metadata requires updating the strict validator while this
format is under development. Breaking interpretation changes still require a
new format version once the format is finalized.

## Compact-Key and Long-Alias Dictionary

The compact key is canonical output. The corresponding long field is accepted
on input. Aliases are scoped to the record type, so a key such as `r` can mean
`radius`, `rows`, or `rotation` in different records. Fields not listed here
keep the same name in both forms, including `type`, `id`, `x`, and `y`.

| Record | Compact key | Accepted long alias |
| --- | --- | --- |
| Grid/settings | `gs`, `gt`, `u`, `gv`, `sg` | `gridSize`, `gridStyle`, `units`, `gridVisible`, `snapToGrid` |
| Schematic settings | `ps`, `po`, `tb`, `ti`, `td` | `paperSize`, `paperOrientation`, `titleBlock`, `titleBlockInfo`, `titleBlockData` |
| Schematic shape | `c`, `l`, `lw`, `v`, `lk` | `color`, `layer`, `lineWidth`, `visible`, `locked` |
| Schematic graph/geometry | `nd`, `ed`, `cl`, `f`, `fa`, `cr`, `ncr`, `bg`, `ew`, `ir`, `fc`, `cn`, `w`, `h`, `rev` | `graphNodes`, `graphEdges`, `closed`, `fill`, `fillAlpha`, `cornerRadius`, `nodeCornerRadii`, `edgeBulges`, `edgeWidths`, `isRect`, `fillColor`, `cornerNodeIds`, `width`, `height`, `reversed` |
| Schematic wire/net | `pc`, `wl`, `n`, `lo`, `nst`, `no`, `nto`, `pn` | `pinConnections`, `wireLabel`, `net`, `labelOffset`, `style`, `orientation`, `textOffset`, `pinConnection` |
| Pin/pad connection entry | `cid`, `pn` | `componentId`, `pinNumber` |
| Schematic arc/text | `sp`, `ep`, `bp`, `t`, `fs`, `ff`, `ta`, `rot`, `cid`, `fk`, `att`, `bd` | `startPoint`, `endPoint`, `bulgePoint`, `text`, `fontSize`, `fontFamily`, `textAnchor`, `rotation`, `componentId`, `fieldKey`, `attachment`, `border` |
| Component instance | `dn`, `rot`, `mir`, `ref`, `val`, `sr`, `sv`, `props`, `v`, `lk`, `pkg` | `definitionName`, `rotation`, `mirror`, `reference`, `value`, `showReference`, `showValue`, `properties`, `visible`, `locked`, `packageId` |
| Component definition | `n`, `cat`, `desc`, `sym`, `dr`, `dv`, `dp`, `src`, `spn` | `name`, `category`, `description`, `symbol`, `defaultReference`, `defaultValue`, `defaultProperties`, `_source`, `supplier_part_numbers` |
| Component footprint/3D | `fsh`, `fbb`, `fn`, `m3o`, `m3u`, `m3n`, `h3` | `footprintShapes`, `footprintBBox`, `footprintName`, `model3dObj`, `model3dUrl`, `model3dName`, `has3d` |
| Symbol | `w`, `h`, `o`, `g`, `p` | `width`, `height`, `origin`, `graphics`, `pins` |
| Symbol graphic | `k`, `w`, `h`, `sw`, `s`, `f`, `pts`, `tx`, `fs`, `a`, `bl`, `tr`, `sa`, `ea` | `type`, `width`, `height`, `strokeWidth`, `stroke`, `fill`, `points`, `text`, `fontSize`, `anchor`, `baseline`, `transform`, `startAngle`, `endAngle` |
| Symbol pin | `i`, `k`, `pd`, `num`, `n`, `o`, `len`, `t`, `pt`, `sh`, `np`, `nup`, `sn`, `snu`, `hd`, `b` | `_id`, `_key`, `_pathData`, `number`, `name`, `orientation`, `length`, `type`, `pinType`, `shape`, `namePos`, `numberPos`, `showName`, `showNumber`, `hidden`, `bubble` |
| KiCad pin metadata | `knfs`, `kufs`, `kny` | `kicadNameFontSize`, `kicadNumberFontSize`, `kicadNumberYOffset` |
| Symbol text position | `rot`, `a`, `ff`, `fs` | `rotation`, `anchor`, `fontFamily`, `fontSize` |
| Footprint bounds | `w`, `h` | `width`, `height` |
| PCB stackup/board | `cl`; `w`, `h`, `r` | `copperLayers`; `width`, `height`, `radius` |
| PCB design | `tw`, `cl`, `vd`, `dr`, `u`, `rt` | `trackWidth`, `clearance`, `viaDiameter`, `viaDrill`, `units`, `router` |
| PCB track | `c`, `l`, `lw`, `v`, `lk`, `nd`, `ed`, `cl`, `f`, `fa`, `cr`, `ncr`, `bg`, `el`, `ew`, `n`, `w`, `pdc`, `sbs` | `color`, `layer`, `lineWidth`, `visible`, `locked`, `graphNodes`, `graphEdges`, `closed`, `fill`, `fillAlpha`, `cornerRadius`, `nodeCornerRadii`, `edgeBulges`, `edgeLayers`, `edgeWidths`, `net`, `width`, `padConnections`, `sourceBoardShape` |
| PCB via | `d`, `dr`, `n`, `lk`, `v`, `sp` | `diameter`, `drill`, `net`, `locked`, `visible`, `span` |
| Via span | `f`, `t` | `from`, `to` |
| Board shape | `k`, `l`, `lw`, `f`, `cm`, `p`, `n`, `sw`, `sb`, `ncr`, `cr`, `sp`, `ep`, `bp`, `r`, `nm`, `aw`, `pts`, `w`, `h`, `rot`, `rev` | `kind`, `layer`, `lineWidth`, `filled`, `copperMode`, `plated`, `net`, `segmentWidths`, `segmentBulges`, `nodeCornerRadii`, `cornerRadius`, `start`, `end`, `bulge`, `radius`, `name`, `artwork`, `points`, `width`, `height`, `rotation`, `reversed` |
| Artwork | `e`, `b`, `d`, `i` | `encoding`, `bytes`, `data`, `index` |
| Copper fill | `l`, `pts`, `n`, `lk`, `v`, `k`, `cr`, `ncr`, `sb`, `r`, `w`, `h`, `rot`, `rev` | `layer`, `points`, `net`, `locked`, `visible`, `kind`, `cornerRadius`, `nodeCornerRadii`, `segmentBulges`, `radius`, `width`, `height`, `rotation`, `reversed` |
| PCB text | `t`, `s`, `rot`, `l`, `lw`, `bd` | `content`, `size`, `rotation`, `layer`, `strokeWidth`, `border` |
| Placement | `rot`, `lk`, `mir`, `sd`, `rv`, `rdx`, `rdy`, `rr`, `rs`, `rw` | `rotation`, `locked`, `mirror`, `side`, `refVisible`, `refDx`, `refDy`, `refRot`, `refSize`, `refStrokeWidth` |
| Panelization | `r`, `c`, `rs`, `cs`, `sp`, `rt`, `rb`, `rl`, `rr`, `vt`, `ht`, `vo`, `ho` | `rows`, `columns`, `rowSpacing`, `columnSpacing`, `separation`, `railTop`, `railBottom`, `railLeft`, `railRight`, `verticalTabsPerEdge`, `horizontalTabsPerEdge`, `verticalTabOffset`, `horizontalTabOffset` |
| Panelization features | `vph`, `hf`, `hph`, `vf`, `tw`, `hd`, `hp`, `nc` | `verticalPositioningHoles`, `horizontalFiducials`, `horizontalPositioningHoles`, `verticalFiducials`, `tabWidth`, `holeDiameter`, `holePitch`, `noteCreated` |

Unknown fields remain invalid. A record containing both aliases is accepted
only when their values are structurally equal; otherwise ClearPCB reports the
record path and the conflicting values. File saves, Save As/downloads,
autosaves, and AI Mode project snapshots all emit compact keys.

## Data Not Stored in Project Files

The following data is derived or belongs to application storage rather than the
project document:

- Rendered SVG/Canvas/Three.js objects.
- Selection, hover, drag, undo, and redo state.
- Ratsnest lines and DRC results.
- Computed copper-pour polygons.
- Derived net-label text.
- Generated footprint pads, rendering caches and automatic-slot allocation state
  (resolved positions themselves are stored in `pcb.placements`).
- Component-library HTTP caches and TTL metadata from `StorageManager`.
- Local UI preferences that are not listed under schematic settings or
  `pcb.design`.

## Minimal Valid Project

```json
{
  "version": "1.0",
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
- `src/core/project-format.js`: format validation, stackup contract, editor capability gate.
- `src/core/FileManager.js`: ZIP container and raw JSON reading.
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
