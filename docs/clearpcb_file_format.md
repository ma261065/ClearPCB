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
| `units` | string | Display units: `"mm"`, `"inch"`, or legacy `"mil"`. |
| `paperSize` | string or null | Paper preset key, such as `"A4"`; `null` means no paper. |
| `paperOrientation` | string or null | `"landscape"` or `"portrait"`. |
| `titleBlock` | boolean | Whether the title block is shown. Default `false`. |
| `titleBlockInfo` | boolean | Whether title-block information is shown. Default `false`. |
| `titleBlockData` | object | User-entered title-block values. |

### Common Schematic Shape Keys

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
A missing/invalid board resets to the default undrawn `100 x 80` board state.

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
| `bg` | Edge bulges keyed by edge ID. |
| `pdc` | Pad connections keyed by node ID. |
| `sbs` | Original board-shape snapshot when a named copper line was converted to a track. |

Per-edge maps contain only values that differ from the shape-wide default.

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
| `kind` | string | `line`, `rect`, `polygon`, `arc`, or `circle`. |
| `layer` | string | PCB layer ID. |
| `lineWidth` | number | Centreline stroke width in mm. |
| `filled` | boolean | Whether the enclosed area is active. |
| `copperMode` | string | Copper/mask operation; see below. |
| `plated` | boolean | Plating flag for hole-layer shapes. |
| `net` | string | Net name; empty when unassigned. |

Geometry depends on `kind`:

```json
[
  { "kind": "line", "points": [{ "x": 0, "y": 0 }, { "x": 10, "y": 0 }] },
  { "kind": "polygon", "points": [{ "x": 0, "y": 0 }, { "x": 10, "y": 0 }, { "x": 5, "y": 5 }] },
  { "kind": "rect", "points": [{ "x": 0, "y": 0 }, { "x": 10, "y": 0 }, { "x": 10, "y": 5 }, { "x": 0, "y": 5 }], "cornerRadius": 1 },
  { "kind": "arc", "start": { "x": 0, "y": 0 }, "end": { "x": 10, "y": 0 }, "bulge": { "x": 5, "y": -2 } },
  { "kind": "circle", "x": 5, "y": 5, "radius": 3 }
]
```

For a filled shape, the active area includes the outer half of `lineWidth`.
For an unfilled shape, only the centred stroke is active.

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
| `pts` | User-authored boundary as `[x,y]` pairs. | Required. |
| `n` | Net name. | Empty. |
| `lk` | Locked. | `false`. |
| `v` | Visible. | `true`. |

Computed pour polygons are not persisted. They are regenerated from the
boundary, net, board, and obstacles after loading. The loader also accepts the
legacy top-level `pcb.fills` array.

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
- `document`, `top-document`, `bottom-document`
- `board-outline`

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
