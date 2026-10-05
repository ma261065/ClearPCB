# ClearPCB

A browser-based schematic + PCB editor built with vanilla JavaScript and SVG.  No build step, no framework — open `index.html` and start drawing.  A project is a single document holding both the schematic and the PCB.

## Features

- **Schematic drawing** — Line, Rectangle, Circle, Arc, Polygon, Text, Net Label, No Connect
- **Wire tool** — Graph-based wiring with automatic junctions, T-junction splitting, sticky wires that follow moved components, pin-snap lines, and horizontal, vertical and 45° alignment guides
- **Components** — Built-in library of common symbols with selectable SMT/through-hole packages and matching offline 3D models, plus live fetching from the KiCad symbol library on GitLab
- **PCB layout** — Tracks, vias, pads, holes, text, copper pours, board shapes and imported picture artwork on a two-layer board; live design-rule check (DRC); maze and pathfinder autorouters; 3D board view
- **Manufacturing output** — Gerber and Excellon drill files, BOM, pick-and-place, panelization, Specctra DSN export / SES import
- **Selection** — Click, Shift+click cycle, Ctrl+click toggle, box select, selection lock
- **Undo / redo** — Full command history for all operations
- **File I/O** — Save/open `.cpcb` project files (a ZIP container of JSON), EasyEDA schematic import, autosave and recovery, PDF and print export
- **Theming** — Light and dark modes
- **PWA** — Installable as a standalone app via `manifest.json`
- **MCP** — Optional pairing with AI clients to inspect or edit the open project

## Getting started

Serve the project root with any static HTTP server:

```bash
# Node, no dependencies
node tools/serve.mjs 8000

# Python
python -m http.server 8000
```

Then open `http://localhost:8000` in a browser.

### Initial board outline

On first opening **PCB Layout**, choose **Rectangle** or **Circle** in the
**Board Dimensions** dialog. Rectangles use width, height and corner radius;
circles use diameter. All sizes are in millimetres.

Tip: Edit the board outline after creation for more complex shapes.

### Moving nodes

In both editors, hold the mouse button while dragging a node or handle, then
release to place it. Clicking and releasing selects the node; subsequent mouse
movement does not move it. Clicking a **(+) midpoint insertion handle** picks up
the new node: move the pointer, then click to place it. Midpoints also support
holding the button to drag and releasing to place.
Context-menu **Split** and **Convert to Arc** actions also follow the pointer
until the next click places the result.

### Built-in packages and 3D models

Choose a built-in component in the **Local** library, then use **Package / model**
to preview and choose its footprint and matching 3D body before placing it.
For an existing component, change **Package** in the schematic **Properties**
panel. Each instance keeps its own package; changing one does not change the
library or other instances. Package changes support Undo/Redo, copy/paste,
save/reopen and autorecovery. The PCB uses the selected package when it next
synchronizes with the schematic, preserving the component's placement.

All built-in types have SMT and through-hole choices. Passive SMT options include
common imperial sizes such as 0402, 0603, 0805 and 1206 (the selector also shows
metric body dimensions). Other choices include SOT-23, SOIC-8, TSSOP-8, SMT LEDs,
diodes, electrolytic capacitors, headers and switches. Through-hole pads include
plated drills; SMT pads have solder-paste openings and no drills.

The bundled models are lightweight, original generic package approximations,
available offline in the picker, component 3D preview and board 3D view. They are
not manufacturer-specific mechanical drawings. Verify the selected footprint,
pin assignment, polarity and dimensions against the actual part's datasheet
before manufacturing. After changing a routed component's package, inspect its
connections and run DRC; existing tracks are not automatically rerouted.

## Releases

Development happens on `dev` and is tested locally. Versioned `release_*`
branches maintain stable release lines; published `vMAJOR.MINOR.PATCH` GitHub
Releases deploy the stable site at [clearpcb.org](https://clearpcb.org).
See [the release workflow](docs/releases.md) for patch releases, new release lines
and the CI gates.
The experimental hosted MCP endpoint has a separate
[deployment and security guide](docs/mcp.md).

New projects use [file format 1.0](docs/clearpcb_file_format.md). Pre-release
2.0 files are intentionally rejected. The format defines multilayer copper,
but the editor currently supports only two-layer boards.

## Project structure

```
clearpcb/
├── index.html            # Entry point: page layout and empty ribbon/panel hosts
├── sw.js, manifest.json  # PWA service worker and manifest
├── src/
│   ├── core/             # Project model and editor-neutral services: ProjectDocument,
│   │                     # SchematicDocument, PcbDocument and its model commands,
│   │                     # FileManager, CommandHistory, Viewport, geometry
│   ├── shapes/           # Shape and copper primitives (wire, polyline, track, via, pad, …)
│   │                     # and shared path editing, snapping and alignment guides
│   ├── components/       # Component library and picker, KiCad/LCSC fetchers, packages,
│   │                     # 3D model previews
│   ├── shared/           # Code both editors use: 3d/, pcb/ (board and footprint geometry,
│   │                     # stroke font, pictures) and ui/ (modal, viewport, export, theme, …)
│   ├── schematic/        # Schematic editor: modules/ (interaction, wiring, files, …), render/
│   ├── pcb/modules/      # PCB editor: tools, rendering, routing, DRC, pours, fabrication
│   ├── easyeda/          # EasyEDA schematic importer
│   └── ui/               # AppBootstrap (startup, mode switching), SchematicApp and PCBApp
│                         # (editor facades), MCP session dialog, styles
├── assets/               # Icons, version.json and vendored libraries (vendor/)
├── workers/              # CORS proxy worker
├── mcp-worker/           # Cloudflare Worker relay for the hosted MCP endpoint
├── tests/                # Headless regression scripts (test-*.mjs)
├── browser-tests/        # Playwright scenarios
├── tools/                # Regression gate, checks, benchmarks, release packaging
└── docs/                 # Architecture, module contracts, file format, release process
```

New to the code? Start with the [developer guide](docs/developer-guide.md): the
mental model, one edit traced end to end, and recipes for common changes.
The module-level layout, the enforced import rules and the owner of each piece of
shared state are in [docs/project_structure.md](docs/project_structure.md); how
each module behaves is in [docs/module-contracts.md](docs/module-contracts.md).

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
   │ schematic/,      │               │ pcb/modules,     │
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
  `FileManager`, `SchematicDocument` and `PcbDocument`. The models own
  authored entities, settings, geometry capture and serialization; editor
  collection accessors refer to those models rather than duplicate stores.
  Views contribute current view settings, editing readiness and presentation
  lifecycle hooks. The project assembles the combined file and aggregates
  dirty state for auto-save. The file
  lifecycle (New/Open/Save/Import) is *injected* into the project by the
  schematic view, so `core/` never imports a view module. Both editors'
  File menus drive the same `bootstrap.project.*` operations.
- **Facade** — `SchematicApp` and `PCBApp` own interaction and presentation
  state and delegate feature behavior to `schematic/modules/` and `pcb/modules/`.
  Model commands own authored changes; rendering and manufacturing output
  conversion remain consumers of model geometry.
- **Command** — Every edit (move, add, delete, modify) is a command object
  executed through `CommandHistory`, giving full undo/redo. PCB model commands
  (`core/pcb-*-commands.js`) change only `PcbDocument`; the PCB editor's commands
  subclass them to re-render and refresh derived views such as the ratsnest and
  clearance halos.
- **Graph-based wires** — Wires use a node+edge graph model
  (`shapes/wire.js`) rather than simple point arrays, enabling
  T-junctions, segment dragging, and merge/split operations.
- **Function modules** — `schematic/modules/` and `pcb/modules/` mostly export
  plain functions that receive the editor as their first argument. Classes are
  used for commands and a few long-lived helpers (for example `DrcPresentation`,
  `AutorouterSession`). State a module owns lives in that module, usually in a
  `WeakMap` keyed by the editor.
- **Editor services** — Modules reach what the editor owns through its public
  services (`pcb/modules/pcb-editor-api.js`, `schematic/modules/schematic-editor-api.js`)
  rather than its `_`-prefixed members. The regression gate enforces the import
  directions between editors and ratchets the remaining private accesses down.

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

Both editors:

| Key | Action |
|-----|--------|
| `Ctrl+Z` / `Ctrl+Y` (or `Ctrl+Shift+Z`) | Undo / Redo |
| `Ctrl+C` / `Ctrl+X` / `Ctrl+V` | Copy / Cut / Paste |
| `Ctrl+A` | Select all |
| `Ctrl+S` / `Ctrl+Alt+S` | Save / Save As |
| `Ctrl+Tab` | Switch between schematic and PCB |
| `Delete` / `Backspace` | Delete selected |
| `Escape` | Cancel the current operation |
| `Space` | Rotate the selected component; fit to content when nothing is selected |
| `X` / `Y` | Flip the selected component horizontally / vertically |
| Arrow keys | Nudge the selection |
| `+` / `-` | Zoom in / out |

Schematic editor only:

| Key | Action |
|-----|--------|
| `Ctrl+N` / `Ctrl+O` | New / Open |
| `Ctrl+P` / `Ctrl+Shift+P` | Print / Export PDF |
| `Enter` | Finish the shape or wire being drawn |
| `F` / `Home` | Fit to content / reset the view |
| `V` `W` `O` `N` `I` `R` `C` `A` `P` `L` | Tools: Select, Wire, Component, Net Label, Line, Rectangle, Circle, Arc, Polygon, Text |
| `X` (nothing selected) | No Connect tool |

While drawing a PCB track, `Enter` finishes it and `Space` inserts a via.

## Testing

The repo has a single regression gate; run it before committing:

```
node tools/regression.mjs
```

It checks the import directions between editors (`tools/check-imports.mjs`) and
both editors' remaining private-member accesses (`tools/check-pcb-editor-access.mjs`,
`tools/check-schematic-editor-access.mjs`), runs every `tests/test-*.mjs` in its own
process, then routes `test-board.json` and checks the result
(`tools/check-clearance-full.mjs`). Routing must complete at least 65 of the 76
connections with no clearance violations; differing track and via counts are
reported as soft warnings for review. See `tools/regression.mjs` for the exact hard
and soft checks. The run takes a few minutes, most of it routing.

For a faster loop while editing, `node tools/test.mjs [filter…]` runs only the
regression tests, optionally filtered by name.

CI also runs `node tools/typecheck.mjs` (a `checkJs` type check against
`jsconfig.json`, with an empty error baseline) and `node tools/browser-test.mjs`,
which drives the real app in headless Chromium; see
[releases](docs/releases.md#automated-regression-gate). Both need tools that are not
vendored. Install them into the repo's git-ignored `node_modules`, as CI does:

```
npm install --no-save --no-package-lock --ignore-scripts typescript@5.9.3 playwright@1.55.0
npx playwright install chromium
```

Alternatively, set `TSC` to a `tsc.js` or `PLAYWRIGHT` to a Playwright package folder.

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
