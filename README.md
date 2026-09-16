# ClearPCB

A browser-based schematic + PCB editor built with vanilla JavaScript and SVG.  No build step, no framework — open `index.html` and start drawing.  A project is a single document holding both the schematic and the PCB.

## Features

- **Drawing tools** — Line, Rectangle, Circle, Arc, Polygon, Text, Net Label, No Connect
- **Wire tool** — Graph-based wiring with automatic junctions, T-junction splitting, sticky wires that follow moved components, pin-snap lines, and orthogonal alignment
- **Components** — Built-in library of common symbols (resistors, capacitors, ICs, connectors, etc.) plus live fetching from the KiCad symbol library via GitLab
- **Selection** — Click, Shift+click cycle, Ctrl+click toggle, box select, selection lock
- **Undo / redo** — Full command history for all operations
- **File I/O** — Save/open JSON documents, auto-save to localStorage, PDF and print export
- **Theming** — Light and dark modes
- **PWA** — Installable as a standalone app via `manifest.json`

## Getting started

Serve the project root with any static HTTP server:

```bash
# Python
python -m http.server 8000

# Node
npx serve .
```

Then open `http://localhost:8000` in a browser.

## Project structure

```
clearpcb/
├── index.html                  # Entry point — all HTML lives here
├── manifest.json               # PWA manifest
│
├── src/
│   ├── core/                   # Framework-agnostic infrastructure
│   │   ├── Viewport.js         # SVG canvas, pan/zoom, grid rendering
│   │   ├── CommandHistory.js   # Undo/redo command stack
│   │   ├── SelectionManager.js # Hit-testing, multi-select, box-select
│   │   ├── EventBus.js         # Global pub/sub
│   │   ├── FileManager.js      # Dirty tracking, auto-save, file naming
│   │   ├── ProjectDocument.js  # Neutral owner of the single project file
│   │   ├── StorageManager.js   # localStorage / IndexedDB abstraction
│   │   ├── geometry.js         # Point/segment math helpers
│   │   ├── ShapeValidator.js   # Validates shape data on load
│   │   ├── ModalManager.js     # Reusable modal dialog helper
│   │   ├── SearchManager.js    # Fuzzy text search for component picker
│   │   ├── LazyLoader.js       # Deferred script/resource loading
│   │   └── ui-helpers.js       # Small shared DOM utilities
│   │
│   ├── shapes/                 # Shape primitives (each extends Shape)
│   │   ├── index.js            # Registry + createShape() factory
│   │   ├── shape.js            # Abstract base: render, hit-test, anchors
│   │   ├── line.js             # Polyline
│   │   ├── wire.js             # Graph-based wire (nodes + edges)
│   │   ├── rect.js             # Rectangle
│   │   ├── circle.js           # Circle
│   │   ├── arc.js              # Three-point arc
│   │   ├── polygon.js          # Closed polygon
│   │   └── text.js             # Text label
│   │
│   ├── components/             # Electronic component system
│   │   ├── index.js            # getComponentLibrary() entry point
│   │   ├── Component.js        # Placed component instance
│   │   ├── ComponentLibrary.js # Manages built-in + KiCad libraries
│   │   ├── ComponentPicker.js  # Search/browse UI panel
│   │   ├── BuiltInComponents.js# Hand-drawn symbol definitions
│   │   ├── KiCadFetcher.js     # Fetches KiCad symbols from GitLab
│   │   ├── LCSCFetcher.js      # LCSC/JLCPCB part lookup
│   │   ├── STEPPreview.js      # 3D model preview (lazy-loaded)
│   │   └── VRMLPreview.js      # VRML model preview (lazy-loaded)
│   │
│   └── ui/                     # Application layer
│       ├── AppBootstrap.js     # Shared startup; owns ProjectDocument + mode switching
│       ├── SchematicApp.js     # Schematic view — delegates to modules
│       ├── PCBApp.js           # PCB view — delegates to pcb modules
│       ├── schematic.css       # All styles
│       └── modules/            # Schematic feature modules (functional, not classes)
│           ├── mouse.js        # Mouse event binding (click, drag, box-select)
│           ├── drag.js         # Drag commit + cleanup helpers
│           ├── context-menu.js # Right-click menus, junction/segment deletion
│           ├── keyboard.js     # Keyboard shortcuts and hotkeys
│           ├── wire.js         # Wire drawing, snapping, reconciliation
│           ├── drawing.js      # Shape drawing (line, rect, circle, arc, polygon)
│           ├── components.js   # Component placement, rotation, mirroring
│           ├── clipboard.js    # Copy, cut, paste with preview
│           ├── selection.js    # Selection helpers, lock toggle
│           ├── box-selection.js# Box-select rectangle management
│           ├── text-edit.js    # Inline text editing overlay
│           ├── value-dialog.js # Component value edit dialog
│           ├── properties.js   # Properties panel binding
│           ├── ribbon.js       # Ribbon toolbar binding
│           ├── cursor.js       # Crosshair and tool cursors
│           ├── theme.js        # Light/dark theme toggle
│           ├── viewport.js     # Viewport UI controls (grid, zoom)
│           ├── shape-management.js # Add/remove/render shapes
│           ├── files.js        # Open, save, serialise documents
│           ├── export.js       # PDF, print, SVG export
│           ├── paper.js        # Paper/title-block events
│           ├── tool.js         # Tool selection, option persistence
│           ├── callbacks.js    # Event-bus wiring
│           └── ui-utils.js     # Small UI helpers (undo buttons, etc.)
│
├── assets/
│   ├── icons/                  # Favicon and PWA icons
│   ├── vendor/                 # Third-party libs (jsPDF, svg2pdf)
│   └── version.json            # App version number
│
└── docs/
  ├── clearpcb_file_format.md # Canonical project JSON format
  └── project_structure.md    # Detailed ownership and architecture notes
```

## Architecture

A ClearPCB project is a **single document** that holds both the schematic
and the PCB. That document is owned by a neutral `ProjectDocument` (in
`core/`), so the schematic and PCB editors are peer *views* rather than one
owning the other.

```
                   ┌────────────────────┐
                   │   AppBootstrap.js  │  creates the project,
                   │  (mode switching)  │  registers both views
                   └─────────┬──────────┘
                             │
                   ┌─────────▼──────────┐
                   │ ProjectDocument.js │  single FileManager,
                   │  (neutral owner)   │  combined serialize/load,
                   └─────────┬──────────┘  aggregate dirty state
               registerView  │  registerView
            ┌────────────────┴────────────────┐
            ▼                                  ▼
   ┌──────────────────┐               ┌──────────────────┐
   │  SchematicApp.js │  UI host      │     PCBApp.js     │
   │  (schematic view)│               │    (pcb view)    │
   └────────┬─────────┘               └────────┬─────────┘
            │                                  │
   ┌────────┴─────────┐               ┌────────┴─────────┐
   │ ui/modules,      │               │ pcb/modules,     │
   │ shapes, components│              │ autorouter, …    │
   └────────┬─────────┘               └────────┬─────────┘
            └────────────────┬────────────────┘
                             ▼
                      ┌─────────────┐
                      │    core/    │
                      │  Viewport   │
                      │  Commands   │
                      │  Selection  │
                      │  EventBus   │
                      └─────────────┘
```

**Key patterns:**

- **Single document, peer views** — `ProjectDocument` owns the one
  `FileManager` and coordinates the editors. Each view contributes one
  section through a small duck-typed interface (`serializeSection`,
  `loadSection`, `clearSection`, `isSectionDirty`); the project assembles
  the combined file and aggregates dirty state for auto-save. The file
  lifecycle (New/Open/Save/Import) is *injected* into the project by the
  schematic view, so `core/` never imports a view module. Both editors'
  File menus drive the same `bootstrap.project.*` operations.
- **Facade** — `SchematicApp` owns all schematic state in its constructor
  and exposes ~110 methods, but most are one-line delegations to module
  functions. The real logic lives in `ui/modules/`.
- **Command** — Every edit (move, add, delete, modify) creates a command
  object pushed onto `CommandHistory`, giving full undo/redo.
- **Graph-based wires** — Wires use a node+edge graph model
  (`shapes/wire.js`) rather than simple point arrays, enabling
  T-junctions, segment dragging, and merge/split operations.
- **Functional modules** — `ui/modules/` files export plain functions that
  receive the app object as their first argument. No classes, no
  singletons.

## Importing PCB pictures

In the PCB editor, choose **Home > Image**. Select a
PNG or JPEG, choose top/bottom silk or copper, then set the width in millimetres,
resolution and threshold. The preview shows the resulting monochrome artwork.
White preview pixels become material; black and fully transparent pixels stay empty.
Invert reverses the light/dark selection.
Mirroring is optional and is not applied automatically for bottom layers.

Import creates one image object centred in the current view. Drag it as a whole;
resize with its four corner handles or the Width/Height fields in Properties.
Resizing preserves aspect ratio. Properties also moves the image between top/bottom
silk and copper layers. The internal pixels are not editable shapes.
One undo removes the entire import. Artwork
is saved with the board and included in Gerber output; copper artwork can be
assigned a net. Copper import adds copper only, not a solder-mask opening.

Images are decoded locally without uploading. Limits are 20 MB, 40 megapixels,
512 pixels on the processed long edge, 0.1 mm minimum output pixel size, and
2,000 internal artwork regions per image. Reduce resolution for complex pictures. The minimum pixel
size is a pixel-mode conversion limit, not a guarantee of manufacturability; check your
fabricator's silk/copper width and clearance requirements.

For vector tracing, choose **Conversion > VTracer (trial)** or **ImageTracerJS (trial)**.
VTracer runs locally using a lazily loaded, vendored WebAssembly engine
(1.0.0-alpha.4). Start with Smoothing **1 px** and Speckle Size **0**.
Smoothing controls curve simplification tolerance; **0** disables that extra pass,
not the initial spline fitting. Speckle Size is a side length: **4** filters regions
smaller than **16 pixels in area**. ImageTracerJS's separate Simplify control uses
line/curve fitting squared-error tolerance in sampled pixels; Despeckle discards
paths shorter than the chosen number of edge nodes; Preserve Corners retains right-angle corners.
The artwork preview shows the resulting geometry, with white representing material.
Tracing defaults to **Resolution > Source (up to 2048 px)**, preserving the original
resolution below that cap without upscaling. Explicit 512, 1024, and 2048-pixel
long-edge limits are also available. Tracing permits finer sampling than the
pixel mode's 0.1 mm limit; pixel mode retains its separate 512-pixel cap.
Fitted quadratic/cubic curves are approximated within 0.125
source pixels before being stored as polygon contours (up to 2,000 contours and
50,000 points). Existing rectangle images remain supported. Trial images support
the same rotation, flips, inversion, undo, save/load, copper clearance, and exports.
Both tracers currently run on the main thread; detailed images at source resolution
can pause the dialog during conversion. The trials are alternatives for comparison,
not a guarantee of identical output to another tool.

For photos, choose **Conversion > Halftone dots**. This produces a regular grid of
round dots with area proportional to each cell's average grayscale value. Start
with **Dot size (mm) > 0.8**. This sets the maximum dot diameter; image tones produce
smaller dots. Increase it for larger, fewer dots, or decrease it for finer detail.
Grid spacing and dot count are calculated from dot size and physical image width.
Changing the import width keeps the chosen dot diameter and recalculates the grid.
Like the other image modes, white in the preview is material: light areas produce
larger white silkscreen/copper dots. Use **Invert** for dark-area dots, as with black
ink on light paper. Transparency reduces dot coverage and fully transparent cells
stay empty in either polarity. Threshold is disabled for this conversion.

Grid spacing keeps the maximum dot diameter at most 90% of the cell's shorter side, keeping neighbouring
dots separate even in solid tones; this is a separated-dot screen, not a calibrated
newspaper press simulation. Halftones remain one image object, storing each dot as
a compact circle (centre and radius) rather than polygon vertices. They have a
separate 20,000-dot guardrail; the tracer's 2,000-contour / 50,000-point limits do
not apply. These are ClearPCB workload safeguards, not library requirements.
Increase dot size or reduce image width if the circle limit is exceeded.
The import preview and editor draw circles directly. The flat 2D viewer caches native
circle paths and, for detailed halftones, a resolution-aware picture bitmap for pan/zoom.
Very high zoom uses native curves instead of enlarging a capped bitmap. The 3D viewer
builds separated, non-inverted dots directly as circle meshes without polygon union.
Other polygon geometry and triangulation are built only when needed. Inverted, overlapping circle artwork uses a polygon
fallback; ordinary separated halftone dots, including inversion, use native curves.
Copper pours and DRC clearance treat each picture as one rotated rectangular boundary,
including the gaps between dots. Other-net pours stay outside that boundary; same-net
solid connections retain their existing behavior. Silkscreen requires no copper-clearance
geometry. Fabrication output and electrical contact checks still use the actual artwork,
not a solid rectangle, and large 3D/export operations can still take time.
Check the smallest dots and gaps
against your fabricator's limits before using the result on silk or copper.

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `Ctrl+Z` / `Ctrl+Y` | Undo / Redo |
| `Ctrl+C` / `Ctrl+X` / `Ctrl+V` | Copy / Cut / Paste |
| `Ctrl+S` / `Ctrl+Shift+S` | Save / Save As |
| `Ctrl+N` / `Ctrl+O` | New / Open |
| `Ctrl+A` | Select all |
| `Delete` | Delete selected |
| `Escape` | Cancel current operation |
| `L` | Lock/unlock selection |
| `R` | Rotate component (while placing) |
| `M` | Mirror component (while placing) |
| `Ctrl+P` | Print |
| `F` | Fit to content |

## Testing

The repo has a single regression gate that should be run before committing
changes to the autorouter:

```
node tools/regression.mjs
```

It runs the geometry primitive smoke test plus a full clearance check on
`test-board.json` (`tools/check-clearance-full.mjs`) and asserts against a
documented baseline (currently: 65/76 connections routed, 0 violations).
The run takes roughly two minutes. See `tools/regression.mjs` for the exact
HARD vs SOFT check criteria.

## Troubleshooting

### Autorouting is unusually slow in Microsoft Edge

If a route that should take ~30s is taking 2–3 minutes on the hosted site
(but is fast when running locally), Microsoft Edge's **"Enhance your
security on the web"** setting is likely the cause. When enabled, Edge
disables V8's optimising JIT compiler for sites it considers "unfamiliar",
forcing hot loops to run in the interpreter only — typically an 8–10×
slowdown for compute-heavy code like the autorouter.

Two fixes:

1. **Add an exception:** `edge://settings/privacy` → "Enhance your
   security on the web" → "Manage exceptions" → add the site.
2. **Wait it out:** Edge graduates frequently-visited sites to its
   trusted list automatically, after which the throttle goes away.

Chrome, Firefox, Safari, Brave and other Chromium-based browsers are
not affected.

## License

MIT
