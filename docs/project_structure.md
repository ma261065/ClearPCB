# ClearPCB Project Structure

This document reflects the current repository layout and the ownership
boundaries between schematic, PCB, and shared code.

## Current Structure

```text
clearpcb/
├── index.html
├── sw.js                       # Service worker (PWA)
├── mcp-worker/                 # Cloudflare Worker + Durable Object MCP relay
├── manifest.json
├── jsconfig.json               # checkJs: true, noImplicitAny: false
├── assets/
│   ├── icons/
│   └── vendor/                 # jspdf, svg2pdf (vendored, see docs/vendoring_npm_packages.md)
├── src/
│   ├── core/                   # Mode-agnostic services: Viewport, CommandHistory,
│   │                           # SelectionManager, StorageManager, FileManager,
│   │                           # ModalManager, EventBus, geometry, ShapeValidator,
│   │                           # SearchManager, LazyLoader, ui-helpers
│   ├── shapes/                 # Drawing primitives shared by schematic + pcb
│   │                           # (shape, line, rect, circle, arc, polygon,
│   │                           # polyline, polyline-graph, text, net, wire,
│   │                           # noconnect, track, via)
│   ├── components/             # Component/symbol ingestion (BuiltInComponents,
│   │                           # ComponentLibrary, ComponentPicker, KiCadFetcher,
│   │                           # LCSCFetcher, STEPPreview, VRMLPreview)
│   ├── easyeda/                # EasyEDA importers (schematic-importer.js)
│   ├── shared/
│   │   └── ui/theme.js         # Shared theme tokens
│   ├── schematic/
│   │   └── modules/            # Schematic-only interaction modules
│   │                           # (draw-states, files, shape-management, wire)
│   ├── pcb/
│   │   └── modules/            # PCB-only interaction + I/O modules
│   │                           # (autorouter family, controls, dsn, footprint,
│   │                           # gerber, layers, ratsnest, track-*)
│   └── ui/
│       ├── AppBootstrap.js     # Shared startup + mode switching
│       ├── SchematicApp.js     # Schematic editor facade
│       ├── PCBApp.js           # PCB editor facade
│       ├── schematic.css
│       └── modules/            # Schematic interaction modules
│                               # (mouse, keyboard, drag, drawing, clipboard,
│                               # context-menu, modal, files, export, paper,
│                               # box-selection, label-attachment,
│                               # pin-wire-connect, net-validation, …)
├── workers/
│   └── cors-proxy.js
├── tests/                      # Isolated headless regression scripts (test-*.mjs)
├── tools/                      # Node-side benchmarks + DRC sanity tools
│                               # (autorouter-benchmark, check-clearance-*,
│                               # check-via-on-pad, regression, debug-pf-*)
└── docs/
    ├── project_structure.md
  ├── clearpcb_file_format.md
    ├── autorouter.md
    ├── easyeda_pcb_format.md
    ├── netname_wirelabel_contract.md
    └── vendoring_npm_packages.md
```

## Ownership Rules

- `src/core/*`, `src/shapes/*`, `src/components/*`, `src/shared/*` are
  shared by schematic and pcb.
- `src/schematic/**` and `src/ui/SchematicApp.js` + `src/ui/modules/*`
  are schematic-only. `PCBApp.js` must not import them.
- `src/pcb/**` and `src/ui/PCBApp.js` are pcb-only. Schematic code must
  not import them.
- `src/ui/AppBootstrap.js` is shared orchestration only (startup, mode
  switching, platform launch hooks).
- `src/easyeda/*` is import-only (read EasyEDA files into our model).

`ProjectDocument` dispatches successful file-action completion through registered
views' `onDocumentReplaced(reason)` hooks (`new`, `open`, or `import`). Each editor
owns its own Home-tab navigation; the PCB view also owns new-board setup timing
and disposal of its dimensions dialog. Completion is not emitted for cancelled
or failed file actions. The UI host confirms New; `ProjectDocument.reset()` clears
the schematic and then the PCB through each view's `clearSection()` hook.
`FileManager` adopts the new identity and stores the cleared project's actual
settings for recovery. Reset guards section clearing, not the entire asynchronous
confirmation/picker/adoption lifetime, and does not promise atomic recovery.

Registered editors report changes through `onDocumentChanged()`. The project
advances the revision and calls its UI host's `onProjectChanged()` to refresh
aggregate title/dirty indicators. PCB edits keep their section dirty flag separate
from `FileManager.isDirty`, avoiding schematic-to-PCB refresh notifications.

`AppBootstrap` stores its schematic instance directly; there is no `window.app`
alias. Both editor constructors receive their project owner. PCB file commands
resolve their own `app.project` at invocation time. `window.bootstrap` remains only a console-inspection
handle, not a runtime service lookup.

Storage reports autosave failures through `FileManager.onAutoSaveError`; the UI
host shows the existing alert dialog, visible from either editor. Notifications
are once per storage-failure streak, reset after a successful autosave. Storage
and notification failures are logged; error reporting no longer discovers editors
through globals. Completed document/index writes emit `FileManager.onAutoSaveSuccess`;
the UI host injects `flashAutoSaveIndicator()` from `ui/modules/ui-utils.js`.
The fixed 4px blue dot retains its 250ms retriggerable visibility and existing
styling. Success-indicator failures are logged separately: they cannot turn a
completed autosave into a storage-failure warning or cause it to be retried.
`onAutoSaveChanged` remains the separate size/title update callback.

Schematic history/dirty callbacks update their own UI, then call
`ProjectDocument.notifySchematicChanged()`. The project calls the registered
PCB's `onSchematicChanged()`; PCB never replaces another editor's callbacks.
Active edits retain the 300 ms debounce, while hidden boards defer rebuilds.
Synchronization reads `project.schematicDocument`, not a schematic editor.
A missing project leaves synchronization pending; a project-owned model can
synchronize even without a registered schematic view. PCB-only edits do not
send schematic-change notifications.

PCB reference editing and footprint inspection use the project's narrow component
interface: `getComponentInfo()`, `validateComponentReference()`,
`createReferenceRenameCommand()` and `getNetlist()`. Queries return detached data;
rename commands expose only `execute()`/`undo()`, not an editor or live component.
`core/SchematicDocument.js`, owned by `ProjectDocument.schematicDocument`, now
owns the schematic collections, component lookup/validation/rename, connectivity
queries and data-only loading/serialization. Editor `shapes`/`components`
accessors alias those collections, including replacements during load and clear;
there is no second entity store. Schematic property commands reuse the same
reference/field-text mutation helper.

Project rename commands perform the model operation and then notify the
schematic adapter to invalidate/render. PCB retains its dialogs, preview, history
entry and derived-display updates. The model can load, rename/undo, derive
connectivity and serialize without either editor or a DOM. Pure connectivity
queries remain in `core/netlist.js`.

`ProjectDocument.pcbDocument` (`core/PcbDocument.js`) owns tracks, standalone
vias and pads, free-standing text and board shapes (including copper-fill regions),
together with board dimensions, panelization, placement and design state.
PCB editor collection accessors alias the model, including array/map replacements
by commands; constructing an editor does not clear a preloaded model.
`prepare()` normalizes a PCB section and checks its required stackup, validates
board outlines, panelization and design settings, and constructs all entities
without a DOM. The adapter's `preparePcb()` delegates to this model operation.
`loadEntities()` adopts prepared entities, preserves collection identity and
restores the board-shape, via/pad and fill ID counters.
`serializeEntities()` returns the entity collections using the existing
entity serializers, preserving topology, metadata and save-boundary precision.
`clearEntities()` empties those collections without replacing them. These are
entity operations, not yet full headless PCB persistence.

`serialize(settings)` assembles the complete authored PCB section: stackup,
dimensions, design settings, optional panelization, entities and saved placements.
It applies the existing compact aliases and save-boundary precision, returning a
detached snapshot without rounding live data. Viewport preferences are an explicit
optional argument; the adapter's `serializePcb()` supplies them from the viewport,
but no editor-owned authored aliases are read. Headless callers can supply saved
preferences or omit them without inventing defaults. Loading remains phased in
the adapter; design/placement application and late panel installation are not yet
a single model load operation.

Saved board dimensions live in `PcbDocument.board`. The editor's `_boardWidth`,
`_boardHeight` and `_boardRadius` access that object, including during live resize,
cancel and undo/redo. Loading restores legacy dimension-only boards, while an
existing outline's bounds and corner radius override saved dimension metadata.
Clearing restores the existing 100 x 80 mm, zero-radius defaults without replacing
the dimension object. `serializeBoardDimensions()` rounds only the saved copy to
four decimals. `boardBoundary()` also accepts the neutral model directly.
Outline drawing, viewport fitting and property-panel presentation remain in the
editor; constructing a view does not reset loaded dimensions.

Panel settings live in `PcbDocument.panelization`. Defaults and validation are
data-only helpers in `core/pcb-panelization.js`; the existing geometry module
re-exports them for compatibility. Preparation validates saved settings before
live content is replaced. `loadPanelization()` and `serializePanelization()`
produce detached normalized settings without additional rounding, preserving
`noteCreated`. Entity clearing resets panelization, but entity loading does not
install prepared panel settings: the adapter installs them after artwork and
pours are restored, before the final active preview. Hidden loads install the
settings without rendering. Existing panel commands still create ordinary
authored note texts and retain their undo/redo behavior; model operations do not
generate notes. Preview SVG and its lifecycle remain editor-owned.

The editor adapter still removes old SVG and selection before replacing entities,
renders only when active, and refreshes derived geometry after loading.
Drawing and Net-edit contexts explicitly retain the inherited collections when
spreading the editor into a temporary object; otherwise copper could silently
disappear from connectivity checks.

Board-shape decoding and serialization live in `core/pcb-board-shapes.js`,
reusing existing pure geometry and artwork-codec helpers. The model owns the
shape ID counter; the editor's `_shapeIdCounter` is an accessor, not a second
counter. Rectangle frames, legacy corner-point readers, image artwork encoding
and deduplication, polygon save normalization and outline checks are unchanged.
The compatibility `loadBoardShapes()` adapter stages data before appending and
rendering it; its serializer re-export retains existing import paths.
Manufacturing snapshots use the neutral serializer directly, with their existing
unrounded geometry options. SVG, selection, copper-cut/pour caches and command
presentation stay in the editor. Legacy saved board dimensions still create a
model-owned outline without a later entity adoption clearing it.

Free-standing text creation, defaults/layer rules and full-precision snapshots
live in `core/pcb-text.js`. Undo and clipboard use these snapshots without file
rounding; `PcbDocument.serializeEntities()` rounds text position, size, rotation
and stroke width to four decimals only at the save boundary. The rendering
module re-exports the data helpers for existing imports but retains only glyph
geometry, hit-testing, SVG and layer-color responsibilities. Add/move/edit/delete
commands retain their existing history and presentation behavior, including
restoring deleted text from an unrounded snapshot with its original ID.

Saved PCB placement/reference settings live in
`ProjectDocument.pcbDocument.placementState` (`core/PcbPlacementState.js`). The PCB editor's
`_placementOverrides` aliases its map. Recording copies only the persisted pose,
side, lock and reference-style fields, never generated pads/SVG/caches.
Loading and clearing preserve map identity; serialization retains the existing
four-decimal precision and default-field omission. These operations work without
an editor or DOM. Placement commands still own their existing undo/redo and
presentation updates, and notify the editor's dirty hook after recording.

The live `placements` map and automatic layout slots remain editor-owned:
they contain generated footprint geometry, presentation caches and temporary
gesture state, not a second authoritative saved-placement store. PCB load
orchestration and viewport settings still depend on the PCB adapter.

PCB design settings now live in `ProjectDocument.pcbDocument.designSettings`
(`core/PcbDesignSettings.js`). Track width, clearance, via diameter and drill
are canonical millimetres; routing and serialization never read rounded ribbon
values. The adapter in `pcb/modules/design-settings.js` handles display units,
local defaults, validation and refresh/dirty notifications. Unit changes convert
the display from the model, not from previously rounded controls.

The Design ribbon and New Track/Via property editors share the same commit path.
Valid edits mark the PCB dirty and retain the existing geometry refresh requests;
unit/router preferences are also saved project edits. Temporarily blank or invalid
dimensions retain the last valid model value and show native field validation.
Project preparation rejects nonpositive/nonfinite dimensions before replacing
live content. These numeric fields opt out of shared two-decimal formatting.
Project serialization still rounds dimensions to four decimals at the file
boundary. Local defaults now store canonical mm values and still read the legacy
display-unit strings under the existing storage key.

This is an intermediate migration: existing entities still contain rendering
methods/state, and general commands still mix data and presentation.
SVG preparation/attachment, derived Net
text, label layout and current viewport settings remain editor responsibilities.
Headless serialization preserves loaded settings; editor serialization supplies
current viewport settings. Schematic editing callbacks explicitly notify the
project; the model itself does not introduce an automatic change-observer system.

PDF, Gerber, BOM and pick-and-place naming share
`projectBaseName()` from `pcb/modules/pcb-export.js`, using the owning project's
FileManager. Existing unnamed-export defaults (`pcb` for PDF, `untitled` for
manufacturing exports) are retained.

Open retains the existing best-effort serialized rollback. It can round or
normalize geometry and does not preserve Undo or selection. The experimental
live-session checkpoint system was removed as disproportionate to this failure
mode; it is not a release requirement. Remaining ownership work is tracked in
[review-fixes.md](review-fixes.md#release-readiness-tracker).

## PCB derived refreshes

- `fill-refresh.js` coalesces pour requests; pour completion reconciles the
  ratsnest against the new copper before requesting DRC.
- Fill commands keep synchronous recomputation. `_recomputeFillsNow()` reports
  completed work so commands do not request a second pour or connectivity pass.
  Empty/deferred passes use `skipFillRefresh` for the connectivity fallback.
- `picture-refresh.js` retains the 100 ms geometry-edit debounce. Without pours,
  its completion reconciles connectivity and requests DRC itself. Pad commands
  use this same deferred path without a separate immediate fill request.
- `PCBApp._scheduleDRC()` owns visibility gating and frame coalescing for queued
  checks, including rechecking visibility when the callback runs. Callers only
  request a check; `_runDRCLive()` waits for deferred geometry/pours to settle.

## Extracted Services

- `shapes/arc-edit.js` owns control-arc geometry, sampling, midpoint projection,
  and curvature-preserving endpoint edits. `shapes/arc-edge.js` owns bulged edges.
- `shapes/rounded-path.js` owns corner clamping, entry/exit points, SVG paths,
  and sampling. Uniform rectangles use circular corners; polygon and per-node
  rounding use quadratic corners. `pcb/modules/board-geometry.js` re-exports
  the helpers for existing consumers.
- `shapes/path-geometry.js` owns stroke decomposition, open-stroke hit tests,
  bounds accumulation, circle hit tests, and indexed/graph handle descriptors.
- `shapes/path-operations.js` owns chain extraction, reversal, joining, closure,
  vertex/segment deletion, insertion metadata, collinear cleanup, and rectangle
  resizing, axis-aligned rectangle classification, and line/arc segment
  conversion. Both editors use `setPathSegmentType` for path segments and
  `splitPathAtNode` for splitting. Open-path splits create independent shapes;
  closed-path splits create an open path with distinct endpoint IDs. Their
  context menus and floating-handle history remain editor adapters.
  `Polyline.toEditablePath()` / `applyEditablePath()` adapt stable
  graph IDs to indexed paths without changing the saved file format.
- `shapes/shape-drawing.js` owns point-sequence completion, validation, primitive
  paths, and previews. `shapes/path-interaction.js` owns segment refinement;
  `shapes/path-snap.js` owns connection/collinear/H-V-45/grid snap precedence
  and constrained translation, including continuation constraints for both
  endpoints of a moving segment. Editor adapters supply pins or pads and grids.
  Open line completion retains a returning segment; only closed polygon paths
  discard a repeated closing point. Arc straightening uses `BULGE_EPS`, never
  display formatting; bulge property fields preserve small nonzero values.
- `shapes/axis-glow.js` owns H/V/45 and straight-through collinear indicator
  classification and rendering. Both editors use the same colored halos and
  solid/dashed/dotted centerlines. Schematic wire, T-junction, sticky-wire,
  and square-aspect guides use this renderer too; there is no separate SVG
  guide pool. Wire snap results carry explicit alignment descriptors while
  their electrical snap calculations remain schematic-owned. Square feedback
  is a blue solid outline in both editors, including PCB drawing and dragging.
  Rectangles show only square-aspect feedback, not redundant H/V indicators.
  All indicators refresh on redraw and share
  finish/cancel cleanup.
- `shapes/property-preview.js` owns reversible live-property transactions:
  capture once, mutate and redraw, restore before committing a single history
  edit, skip unchanged commits, and restore/redraw on cancellation. Snapshots
  are detached JSON-compatible values supplied by editor adapters. It also
  enforces the redraw contract: either an explicit full-scene renderer or all
  four incremental stages:
  prepare changed targets, render geometry, refresh selection, then refresh
  derived views. PCB shape and image property inputs use one adapter that
  refreshes segment overlays and anchors together; schematic numeric inputs
  use their full-scene renderer, which already includes selection and guides.
  Commit and cancellation request a final redraw, including any derived work
  deferred during previews. Property validation, snapshot representation,
  history commands, and PCB copper-refresh throttling remain editor-owned.
  Schematic shape properties include precise bulge and circle diameter edits,
  including multi-selection. Geometry snapshots preserve coupled dimensions
  and overrides. Whole-shape width/radius edits clear their segment/node
  overrides; undo restores them. A zero-bulge standalone arc is replaced by a
  line in the same history operation as the property change.
- Schematic focused Delete and shape context menus share node/segment deletion
  actions; without refinement, Delete still removes the entire selection.
  Standalone arc menus support conversion and deletion. Shape splits retain
  one pre-split snapshot and an optional temporary remainder; placement commits
  one batch and Escape restores the original without leaving a remainder.
- Shared shape editing follows PCB behavior where the editors differed:
  repeated segment clicks retain refinement, rounded corners keep the base
  width during segment-width edits, circle radius denotes the outer edge,
  and Shift suppresses shape snapping. Electrical wire/track connectivity,
  layer restrictions, rendering chrome, history, and fabrication contours
  remain editor-specific. Shared geometry must not import either editor.
- `core/CommandHistory.js` contains only the history engine and base command.
  Schematic commands are in `schematic/modules/commands.js`.
- `shared/3d/ArcballController.js` and `shared/3d/model-rendering.js` serve both
  component previews and the board viewer without importing PCB code.
- `pcb/modules/project-state.js` owns PCB serialization, detached preparation,
  restoration and project design parameters.
- `pcb/modules/copper-model.js` resolves physical pad geometry and logical nets;
  `copper-connectivity.js` owns common cluster construction and positional unions.
- `pcb/modules/fill-context.js` supplies reusable collections to copper pours;
  `copper-artwork.js` resolves DRC artwork primitives.
- `core/DerivedUpdates.js` batches derived callbacks; `core/spatial-pairs.js`
  supplies the DRC broad phase.

`node tools/test.mjs` runs every `tests/test-*.mjs` in an isolated process.
`node tools/regression.mjs` also runs the autorouter baseline. See
[review-fixes.md](review-fixes.md) for the review mapping and verification limits.

## Coordinate & Layer Conventions

- All PCB coordinates are stored in **mm** with **SVG-Y-down** semantics.
  Y is flipped only at the Gerber / Excellon emission boundary.
- Pad layer names use the short form: `'top' | 'bottom' | 'both'`.
- Track / SVG-group ids use the long form: `'top-copper' | 'bottom-copper'`.

## PCB Data Model

### Board-Shape Geometry Contract

`resolveBoardShapeGeometry()` in `src/pcb/modules/board-shape-geometry.js` is the
single source of truth for generic PCB shape semantics across lines,
rectangles, polygons, arcs, and circles. It resolves:

- normalized line width and copper mode;
- centerline geometry and whether it is closed;
- filled-area geometry expanded through the outside half of the outline;
- circle centerline and outer radii;
- stroke polygons used by copper-removal clipping;
- layer policies that force fillable mask and hole shapes to areas, while document graphics honor their fill setting
  while lines remain strokes.

The SVG editor, Canvas 2D preview, Three.js board view, and Gerber exporter
consume this descriptor. Backends may choose native output primitives (for
example a Canvas arc, triangulated Three.js mesh, or Gerber circle aperture),
but must not independently reinterpret `filled`, `lineWidth`, shape closure,
radius expansion, or copper-mode aliases.

`board-shape-geometry.js` also owns outline/path generation, physical removal
contours, bounds, hit tests, and effective width/radius queries. It accepts
plain PCB shape data in SVG-Y-down millimetres and has no editor, selection,
history, or DOM dependency. Its calculations reuse shared `src/shapes` helpers
and the existing image-contour utilities; PCB layer and copper-mode rules
remain PCB-owned. `board-geometry.js` continues to own footprint and track
geometry, rather than accumulating unrelated shape editing behavior.

`board-shapes.js` owns interaction, mutation, commands, SVG rendering, and
properties. It does not re-export geometry functions. All geometry consumers,
including editor adapters and tests, import directly from
`board-shape-geometry.js`. Consumers that also need editor operations use
separate imports for the two responsibilities.

For headless tools and board-design agents:

```js
import { resolveBoardShapeGeometry, boardShapeBounds } from './src/pcb/modules/board-shape-geometry.js';

const shape = {
  kind: 'circle', layer: 'top-copper', x: 10, y: 20,
  radius: 2, lineWidth: 0.2, filled: true, copperMode: 'add',
};
const geometry = resolveBoardShapeGeometry(shape);
const bounds = boardShapeBounds(shape);
```

Queries do not mutate their inputs, but returned descriptors are not detached
snapshots: physical contours are evaluated lazily, and image data/contours may
be borrowed or cached. Treat results as read-only, consume them before mutating
the source shape, and resolve again after edits. Replace image artwork rather
than mutating it in place to respect the existing artwork cache. This API
assumes valid shape data; it does not replace project validation, DRC, or the
command layer used to apply a design to the editor.

### Tracks and Vias

- `PCBApp.tracks` — array of `Track` polyline-graphs. A Track may change
  layer mid-run via per-edge `edgeLayers`.
- `PCBApp.vias` — array of standalone `Via` objects. **All** vias are
  represented here, including those sitting at a Track's layer-change
  node. Tracks never carry implicit vias.
- Decoupling: dragging a Track vertex moves only the vertex; any
  colocated Via stays put. Dragging a Via moves only the Via.
- Sources of Vias: interactive draw (`track-draw.js` emits a Via at
  each layer-change node on finish), autorouter
  (`autorouter-adapter.js` emits standalone Vias deduped by position),
  and explicit user placement.
- In the PCB editor, Vias use a dedicated **Via** display layer. Its
  visibility and lock state are session preferences and are not serialized
  into `.cpcb` files; the Hole layer applies only to routed board holes and
  cutouts.
- Render (`track-render.js`) and Gerber/Excellon output (`gerber.js`)
  read vias exclusively from `PCBApp.vias`.

## Undo / Redo

All mutating PCB operations go through `core/CommandHistory` via
command classes in `src/pcb/modules/track-commands.js`
(`AddTrackCommand`, `RemoveTrackCommand`, `ModifyTrackCommand`,
`MoveVertexCommand`, `AddViaCommand`, `RemoveViaCommand`,
`MovePlacementCommand`, `SetBoardOutlineCommand`). `AddTrackCommand`
accepts an optional `vias[]` so a freshly-drawn track and its
layer-change vias land on the stack as a single atomic step.

Shapes implement `captureState()` / `applyState()` for serializable
state snapshots, used by generic modify commands.

## Autorouter Architecture

The router lives under `src/pcb/modules/` and is split into three
modules sharing common infrastructure:

- `autorouter-common.js` — min-heap, `SpatialHash`, geometry,
  `padPointBlocked` / `padSegmentBlocked`, `CongestionGrid`,
  `PathfinderGrid`, `astarRoute`, `astarProbe`, path post-processors
  (`simplifyPath`, `fixAngles`, `optimizePath`, `sanitizeAngles`),
  `buildCandidateRoutes`, `isValidAngle`, `NODE_KEY` constants.
- `autorouter-maze.js` — Maze (rip-up) router. Exports `routeAll`,
  `routeWithMazeRouter`, plus maze-only helpers (`buildMstEdges`,
  `defaultChainEdges`, `netManhattan`). Holds the `RouteInput` /
  `RouteResult` typedefs.
- `autorouter-pathfinder.js` — Negotiated-congestion (McMurchie/Ebeling)
  router. Exports `routeAllPathfinder`, `routeWithPathfinderRouter`,
  plus extraction / re-route / verification helpers (`extractFeasibleSubset`,
  `extractAndReroute`, `geometricVerifyAndDrop`, `smoothPathfinderRoutes`,
  `unionExtend`, `ripUpSwap`, `astarRouteWithRefinement`,
  `astarRouteAnyEndpoint`).

`autorouter-worker.js` (Web Worker) imports `routeWithMazeRouter`
and `routeWithPathfinderRouter`. UI dropdown values are `'maze'`
and `'pathfinder'`.

### Router I/O Contract

`RouteInput` (from `PCBApp._buildRouteInput()`):

```js
{
  connections: [{ net, pads: [{ x, y, width, height, layer, shape, alternates? }] }],
  allObstaclePads,
  traceWidth, clearance, viaDiameter,
  gridStep,
  bounds,
}
```

`RouteResult`:

```js
{
  traces: [{ net, layer: 'top'|'bottom', points: [{x,y}], vias?: [{x,y}] }],
  vias: [{ x, y, net? }],
  failed: [...],
  failedConnectionCount,
  totalConnectionCount,
}
```

### Design-Rule Single Source of Truth

`clearance`, `traceWidth`, `viaDiameter` are **never** hardcoded in
the router or DSN code. They flow from `#pcbClearance`,
`#pcbTrackWidth`, `#pcbViaDiameter` HTML inputs through
`PCBApp._getRoutingParams()`. `routeAll`, `routeAllPathfinder`,
`exportDSN`, and `importDSN` all throw if any of these are missing
or non-positive. DSN round-trips `viaDiameter` via the
`via_default` padstack circle radius.

### Pad Obstacle Model

Pad shape vocabulary `'rect' | 'ellipse' | 'oval' | 'polygon'` flows
through `padPointBlocked` / `padSegmentBlocked` in `autorouter-common.js`:

- `rect` — exact AABB distance with `clearance²` (rounded corners)
- `ellipse` — circle distance when `hw == hh`; anisotropic ellipse otherwise
- `oval` — stadium (segment-to-segment distance + minor radius)
- other — rect bbox fallback (conservative)

Vias are treated as `shape: 'ellipse'` with `hw == hh` so they
behave as exact circles (not over-blocking squares).

Source pipeline for pad shapes: EasyEDA `PAD~ELLIPSE/RECT/OVAL/POLYGON`
in `footprint.js`, KiCad circle/oval split in `KiCadFetcher.js`.

### Connection Topology

- Classic / maze router uses a planar **Euclidean MST** (Prim's,
  `buildMstEdges`) for each net's connection graph. MST in the plane
  is provably non-crossing; previous nearest-neighbour chains caused
  visible self-crossings on high-pin nets.
- Pathfinder still uses the legacy `nncReorderPads` chain — its
  negotiated-congestion loop was tuned against the chain ordering
  and multi-start / MST variants tested neutral-to-negative.

### Multi-Pad Pins (`alternates`)

A connection pad may carry `alternates: [{x,y,width,height,layer,shape}, ...]`
representing other pads sharing the same logical pin (e.g. thermal
pads with via-stitched copies). Router internals:

- `netPadIdList` is `Array<Array<string>>` — one group per pad
  (primary + alts). `skipIdsForPair` flattens groups so all alt pad
  ids are skipped during routing.
- `astarRouteAnyEndpoint` enumerates `(primary+alts) × (primary+alts)`
  endpoint pairs, sorted by Manhattan distance, tries each until one
  succeeds. Used in pathfinder's three A* call sites; classic
  `routeAll` only benefits from skipIds union (single-endpoint A*).

### Same-Net Via-In-Pad

Same-net vias on pads are **allowed** (required for SMD thermal /
centre pads only reachable from the opposite layer). Pad obstacle
records carry both `obj.net = pad.id` (for `skipIds`) and
`obj.netName = conn.net` (for `isOnPad` `skipNet`). Foreign pads
still hard-block. `tools/check-clearance-full.mjs` exempts same-net
via-pad too.

## Coding & Tooling Conventions

- Vanilla JS ES modules; **no bundler**. Browser loads `src/**` directly.
- `// @ts-nocheck` files exist in the autorouter modules; propagate to
  every file when splitting one with the pragma.
- Use `console.info` (not `console.warn`) for diagnostics that must
  survive PowerShell `2>$null` redirection.
- Node-side benchmarks/DRC checkers in `tools/` import the worker
  modules directly. They are the authoritative regression gates:
  - `node tools/regression.mjs` — classic router baseline.
  - `node tools/check-clearance-pathfinder.mjs <board>.json` —
    pathfinder + post-route geometric clearance check.
- Vendored libs go in `assets/vendor/` (see
  [docs/vendoring_npm_packages.md](vendoring_npm_packages.md)).

## Known Environmental Gotcha

Microsoft Edge's "Enhance your security on the web" setting
(`edge://settings/privacy`) disables V8 TurboFan JIT on "unfamiliar"
sites (rarely-visited HTTPS origins). `localhost` is exempt. Symptom:
the autorouter worker can run **~8–10× slower** on the deployed site
than on localhost despite identical bytes. Add the origin to the
setting's exception list before suspecting code/network issues.
