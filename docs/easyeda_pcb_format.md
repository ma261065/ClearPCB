# EasyEDA PCB Format Reference

Reference for parsing EasyEDA footprint shape data in ClearPCB's PCB editor.

## Sources

- **Official EasyEDA docs:** https://docs.easyeda.com/en/DocumentFormat/3-EasyEDA-PCB-File-Format/
- **KiCad import docs:** https://dev-docs.kicad.org/en/import-formats/easyeda/
- **Third-party parser:** https://github.com/jvanderberg/kicad_jlcimport/blob/main/src/kicad_jlcimport/easyeda/parser.py

## Coordinate System

All coordinates are in **10-mil units** (1 unit = 10 mils = 0.254 mm).

To convert to mm: `value * 0.254` or equivalently `value / 3.937`.

Coordinates are **absolute board positions** (e.g. ~3900–4100 range is typical), not relative to the footprint origin. The parser must center them by computing the centroid and offsetting to (0,0).

## Layer IDs (EasyEDA Standard)

From the official EasyEDA PCB format docs:

| ID | Name | KiCad Equivalent | ClearPCB Layer |
|----|------|-------------------|----------------|
| 1 | TopLayer | F.Cu | `top-copper` |
| 2 | BottomLayer | B.Cu | `bottom-copper` |
| 3 | TopSilkLayer | F.SilkS | `top-silk` |
| 4 | BottomSilkLayer | B.SilkS | `bottom-silk` |
| 5 | TopPasterLayer | F.Paste | `top-paste` |
| 6 | BottomPasterLayer | B.Paste | `bottom-paste` |
| 7 | TopSolderLayer | F.Mask | `top-mask` |
| 8 | BottomSolderLayer | B.Mask | `bottom-mask` |
| 9 | Ratlines | — | `ratlines` |
| 10 | BoardOutline | Edge.Cuts | `board-outline` |
| 11 | Multi-Layer | Eco1.User | `hole` (for shapes) / `both` (for PADs) |
| 12 | Document | Dwgs.User | `document` |
| 13 | — | F.Fab | `document` (fabrication) |
| 14 | — | B.Fab | `document` (fabrication) |
| 21–24 | Inner1–Inner4 | In1.Cu–In4.Cu | (not mapped) |

### EasyEDA Pro Extended Layers

These are **not in the official EasyEDA Standard spec** but appear in EasyEDA Pro / LCSC data:

| ID | Name | ClearPCB Layer |
|----|------|----------------|
| 99 | ComponentShapeLayer | `document` |
| 100 | LeadShapeLayer | `document` |
| 101 | ComponentMarkingLayer | `document` |

> **Note:** The KiCad importer maps 99/100/101 to F.SilkS, but this is a KiCad-specific decision (KiCad doesn't have equivalent layers). We map them to `document` and let the user toggle visibility.

### EasyEDA Pro Layer Differences

EasyEDA Pro uses a **different numbering** for paste/mask:
- Standard: 5/6 = paste, 7/8 = mask
- Pro: 5/6 = mask, 7/8 = paste

## Shape Formats

All shapes are tilde-delimited (`~`) strings. The first field is the type prefix.

### PAD

```
PAD~shape~cx~cy~width~height~layer~net~number~holeDia~polyPoints~rotation~id~holeLength~holePts~plated~pasteExp~maskExp
```

| Index | Field | Description |
|-------|-------|-------------|
| 0 | `PAD` | Type prefix |
| 1 | shape | `ELLIPSE`, `RECT`, `OVAL`, `POLYGON` |
| 2 | cx | Center X (10-mil units) |
| 3 | cy | Center Y (10-mil units) |
| 4 | width | Pad width (10-mil units) |
| 5 | height | Pad height (10-mil units) |
| 6 | layer | Layer ID (1=front SMD, 2=back SMD, 11=through-hole) |
| 7 | net | Net name (empty in footprint defs) |
| 8 | number | **Pad number** (e.g. "1", "2", "A", "K") |
| 9 | holeDia | Hole diameter (10-mil units). 0 for SMD pads |
| 10 | polyPoints | Polygon outline points (space-separated, for POLYGON shape) |
| 11 | rotation | Rotation in degrees (0–360) |
| 12 | id | Shape ID (e.g. "gge409") |
| 13 | holeLength | Slot hole length (10-mil, for oval drill slots) |
| 14 | holePts | Slot hole from/to points |
| 15 | plated | `Y` (plated) / `N` (non-plated) |

> **Drill field:** The EasyEDA official docs say field [9] is "hole radius" but the KiCad import docs call it "holeDia" (diameter). In practice, the values match diameter. Our parser uses the value directly after scaling.

### TRACK

```
TRACK~strokeWidth~layer~net~points~id~locked
```

| Index | Field | Description |
|-------|-------|-------------|
| 0 | `TRACK` | Type prefix |
| 1 | strokeWidth | Stroke width (10-mil units) |
| 2 | layer | Layer ID |
| 3 | net | Net name |
| 4 | points | Space-separated coordinate pairs: `x1 y1 x2 y2 ...` |
| 5 | id | Shape ID |
| 6 | locked | Lock flag |

### CIRCLE

```
CIRCLE~cx~cy~radius~strokeWidth~layer~id~locked
```

| Index | Field | Description |
|-------|-------|-------------|
| 0 | `CIRCLE` | Type prefix |
| 1 | cx | Center X (10-mil units) |
| 2 | cy | Center Y (10-mil units) |
| 3 | radius | Radius (10-mil units) |
| 4 | strokeWidth | Stroke width (10-mil units) |
| 5 | layer | Layer ID |
| 6 | id | Shape ID |
| 7 | locked | Lock flag |

**Filled detection:** When `strokeWidth >= 2 * radius`, the circle is filled (stroke covers entire area).

### ARC

```
ARC~strokeWidth~layer~net~pathData~helperDots~id~locked
```

| Index | Field | Description |
|-------|-------|-------------|
| 0 | `ARC` | Type prefix |
| 1 | strokeWidth | Stroke width (10-mil units) |
| 2 | layer | Layer ID |
| 3 | net | Net name |
| 4 | pathData | SVG path: `M sx,sy A rx,ry rotation large-arc sweep ex,ey` |
| 5 | helperDots | Editor helper dots (ignored) |
| 6 | id | Shape ID |
| 7 | locked | Lock flag |

### RECT

```
RECT~x~y~width~height~layer~id~locked
```

| Index | Field | Description |
|-------|-------|-------------|
| 0 | `RECT` | Type prefix |
| 1 | x | Top-left X (10-mil units) |
| 2 | y | Top-left Y (10-mil units) |
| 3 | width | Width (10-mil units) |
| 4 | height | Height (10-mil units) |
| 5 | layer | Layer ID |
| 6 | id | Shape ID |
| 7 | locked | Lock flag |

> **Note:** The KiCad import docs show additional fields: `RECT~x~y~width~height~layer~strokeWidth~fillColor~~netname`. Some footprints may have the extended format.

### SOLIDREGION

```
SOLIDREGION~layer~net~pathData~type~id~locked
```

| Index | Field | Description |
|-------|-------|-------------|
| 0 | `SOLIDREGION` | Type prefix |
| 1 | layer | Layer ID |
| 2 | net | Net name |
| 3 | pathData | SVG-style path: `M x y L x y ... Z` (may contain A arcs) |
| 4 | type | `solid` (filled), `cutout` (zone cutout), `npth` (board cutout) |
| 5 | id | Shape ID |
| 6 | locked | Lock flag |

**Filled detection:** `type === "solid"` means the region is filled.

### HOLE

```
HOLE~cx~cy~radius~id~locked
```

| Index | Field | Description |
|-------|-------|-------------|
| 0 | `HOLE` | Type prefix |
| 1 | cx | Center X (10-mil units) |
| 2 | cy | Center Y (10-mil units) |
| 3 | radius | Hole **radius** (10-mil units) — NOT diameter |
| 4 | id | Shape ID |
| 5 | locked | Lock flag |

Creates a non-plated through-hole (NPTH). Note field [3] is a radius, matching
the PAD hole-radius convention (`EeFootprintHole.radius` in easyeda2kicad).

### TEXT

```
TEXT~type~x~y~strokeWidth~rotation~mirror~layer~net~fontSize~text~svgPath~display~id~locked
```

| Index | Field | Description |
|-------|-------|-------------|
| 0 | `TEXT` | Type prefix |
| 1 | type | `L` (label) / `P` (prefix/reference) |
| 2 | x | Position X |
| 3 | y | Position Y |
| 4 | strokeWidth | Stroke width |
| 5 | rotation | Rotation degrees |
| 6 | mirror | Mirror flag (`none` = no mirror) |
| 7 | layer | Layer ID |
| 8 | net | Net name |
| 9 | fontSize | Font size (10-mil units, height) |
| 10 | text | Display text string |
| 11 | svgPath | SVG stroke path (M/L commands for text outlines) |
| 12 | display | Visibility (`none` = hidden) |
| 13 | id | Shape ID |
| 14 | locked | Lock flag |

> **Not currently rendered** in ClearPCB (would need stroke path rendering).

### SVGNODE

```
SVGNODE~{jsonData}
```

Contains 3D model references on layer 19. The JSON payload has `attrs.uuid` for fetching the 3D model from `https://modules.easyeda.com/3dmodel/{uuid}`.

**Not rendered** on the PCB canvas.

## Paste & Solder Mask

EasyEDA **does not store** paste mask and solder mask openings as explicit shapes. They are auto-generated from pad geometry:

- **Paste mask:** Same size as the pad
- **Solder mask:** Pad size + expansion (typically 0.1mm)

The PAD format has optional `pasteExpansion` and `maskExpansion` fields at positions [16] and [17], but these are rarely populated. ClearPCB generates these shapes automatically from pad data.

## Implementation Notes

### Data Flow

1. LCSC fetcher stores `detail.packageDetail.dataStr.shape` array as `footprintShapes` on the component definition
2. KiCad fetcher generates `PAD~` and `SILK~` strings via `_parseFootprintPreview`
3. `footprint.js` `generateFromShapes()` parses both formats
4. `renderFootprint()` returns a `Map<layerId, SVGGElement>` for per-layer rendering
5. `PCBApp._placeFootprints()` distributes layer groups to the correct SVG layer

### Centering

EasyEDA uses absolute board coordinates (~3900–4100 range). After parsing all shapes, the parser computes the centroid of all coordinates and offsets everything to (0,0) for footprint-local positioning.

### Scaling Detection

If any pad coordinate or dimension exceeds 50, the data is assumed to be in 10-mil units and scaled by 0.254 to convert to mm. Built-in component data (which is already in mm) has small values and skips scaling.

### SVG Path Handling

EasyEDA arc paths use standard SVG arc commands (`A rx ry rotation large-arc sweep x y`). The parser uses `_tokenisePath()` and `_scalePath()` to properly scale coordinates without corrupting arc flags (which must remain 0 or 1).
