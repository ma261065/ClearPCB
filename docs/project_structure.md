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

Browser idle time is not an edit-completion signal. Registered views may report
`isSectionEditing()`; `ProjectDocument.canSerialize()` uses that neutral readiness
contract without inspecting editor fields. PCB pointer/inline previews block
project snapshots because some still mutate live model geometry before command
commit. Autosave retains its existing idle scheduling and rechecks readiness
both before scheduling and at idle execution, leaving the pending revision
unsaved until commit/cancel makes it safe. Timer-only browsers use the same guard.
Manual Save/Save As report a snapshot failure through the existing failure UI
without opening or writing a file. Headless serialization remains available.
This protects those preview windows; it does not migrate preview geometry out
of the authored models or claim that all property-preview paths are isolated.

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
The model's `copperFills` getter derives the fill list from `boardShapes`; the
editor delegates to that query. Results contain canonical fill references in a
fresh array, so replacing or clearing board shapes cannot leave a stale fill list.
`prepare()` normalizes a PCB section and checks its required stackup, validates
board outlines, panelization and design settings, and constructs all entities
without a DOM. The adapter's `preparePcb()` delegates to this model operation.
`load()` restores authored PCB data without an editor, DOM or local storage.
It uses two shared phases: `loadContent()` adopts prepared entities, restores
dimensions and ID counters, merges design settings and loads saved placements;
`loadPanelization()` installs the prepared panel settings. The editor uses these
same phases around rendering rather than implementing its own data adoption.
`serializeEntities()` returns the entity collections using the existing
entity serializers, preserving topology, metadata and save-boundary precision.
`captureGeometry()` is a separate full-precision, detached snapshot of tracks,
vias, pads, text, board artwork and resolved fill boundaries. It works without
an editor or DOM and contains data only, not track-query functions or computed
pours. The lightweight `core/pcb-geometry-snapshot.js` helper also supports
explicit-collection consumers without constructing a document or duplicating
the entity-copying contract. File serialization and its rounding remain unchanged.
`clear()` empties entity collections and placement overrides in place, resets
dimensions and panelization, discards loaded viewport preferences, and retains
the last-used design settings, matching
existing New behavior. Missing design sections also retain those settings; partial
sections merge without rounding. Collection and submodel identities are preserved.

Standalone pad add/remove/move/modify operations live in
`core/pcb-pad-commands.js`. Collection commands take `PcbDocument`; movement and
property commands operate directly on its `Pad` entities, without an editor or
DOM. Pad removal changes the collection in place, and undo retains the same pad
objects. Movement coordinates and flat property snapshots are copied at command
creation, preserving full precision and insulating history from caller edits.
The existing `pcb/modules/pad-commands.js` classes are presentation adapters that
retain SVG updates, selection cleanup and the existing deferred refresh cadence.

Standalone via add/remove/move/modify and batch-modify operations live in
`core/pcb-via-commands.js`. Collection commands take `PcbDocument`; property and
movement commands operate on its `Via` entities without rendering or changing
track geometry. Scalar property snapshots and batch membership are copied at
construction, preserving IDs, full precision and the existing diameter/drill
normalization. The existing exports in `pcb/modules/track-commands.js` remain
editor adapters. Batch edits apply every via's state before rendering any of them,
then refresh derived state once; compound batching and drag-time overlay deferral
are preserved. Via moves retain caller-owned connectivity and pour refresh timing.
Track coupling during compound gestures remains caller-owned.

Track add/remove/scalar-edit/node-move/graph-edit operations live in
`core/pcb-track-commands.js`. Collection commands take `PcbDocument`; edits
operate on its `Track` entities. Route creation owns a copy of its associated-via
list and installs the complete route before the editor renders it. Undo removes
the listed vias; removing an existing track alone leaves standalone vias intact.
Graph commands deeply own full-precision snapshots, including topology, edge
attributes, node radii, pad connections and source-shape metadata. Node moves
resolve the current node by ID on every operation, so they survive graph undo
recreating node objects. Missing targets throw explicitly rather than recording
a successful no-op. Geometry edits invalidate existing entity bounds without
rendering; connectivity, clearance, selection and SVG work remain in the
`pcb/modules/track-commands.js` adapters.

Shared `Shape.getBounds()` caches geometry independently of the SVG `_dirty`
flag. Repeated headless queries reuse bounds until `invalidate()` clears them;
reading bounds does not acknowledge a pending render. Arc control-point setters
invalidate both arc geometry and bounds. Track node/segment/whole drags,
attached-via/pad movement, cancellation, conflict rollback, group translation
and floating paste explicitly invalidate geometry before it is presented.
Bounds remain entity-owned derived data, not authored state.
Schematic `Text` remains a measured-layout exception: drawing clears its bounds
so the next query uses the updated SVG font metrics rather than an earlier
headless estimate or stale text measurement.

Track bounds, hit tests and centreline distances use the shared copper paths in
`shapes/track-geometry.js`, including per-edge widths, bulged edges and rounded
corners. `pcb/modules/board-geometry.js` re-exports the same resolvers, so existing
rendering, connectivity and export consumers retain their geometry and sampling
tolerance. Model queries do not consult layer visibility; the editor's hit tests
still filter hidden copper. Selection pruning reuses model bounds including
stroke extents rather than a separate centreline-only box. Whole-track radius
previews and pad-bond removal/restoration explicitly invalidate bounds: a bond
change can enable or suppress rounding without moving any node.

`Track.captureCopperGeometry()` owns detached, full-precision copper graph
capture, including resolved per-edge widths/layers, bulges, corner radii and
pad-bond records. Its result is transferable data without SVG state or methods;
it neither rounds for file storage nor triangulates/formats for a consumer.
Fabrication capture delegates to this model operation, then adds its existing
edge-query methods over the detached graph. Gerber formatting, worker transfer
and asynchronous pour preparation remain consumer responsibilities.

Standalone `Pad` exposes `getOutline()`, `getBounds()` and `hitTest()` through
the pure helpers in `shapes/pad-geometry.js`. These helpers accept both model
instances and detached plain pad data, do not mutate entities or cache geometry,
and retain the existing rotation, sampling and drill-centre selection behavior.
The pad selection adapter delegates geometric queries to the model while keeping
layer visibility, locks, handles and drag interactions in the editor.
Existing helper exports from `pcb/modules/pad.js` and
`pcb/modules/board-geometry.js` remain available.

Shared physical geometry is not shared output conversion. The model owns
authored data; neutral helpers calculate physical outlines and bounds.
SVG paths and drill cutouts remain in the SVG renderer, Canvas drawing remains
in the 2D viewer, mesh construction remains in the 3D viewer, and aperture/region
encoding and manufacturing coordinates remain in the Gerber exporter.
The geometry helper's existing `padFlash` name denotes only a geometric aperture
descriptor in millimetres, not a Gerber instruction. Consumer-specific sampling
tolerances, mask expansion and drill treatment are unchanged.

`Via.getBounds()` and `Via.hitTest()` share the small pure `viaBounds` and
`viaHitTest` helpers in `shapes/via.js`, also accepting detached plain via data.
Queries do not cache or mutate state; hit tests include the drill centre and
default to zero extra tolerance. Selection, group pickup and drag pickup supply
their existing six-pixel tolerance converted to world millimetres, while marquee
containment uses the full physical bounds without extra tolerance. Layer policy,
lock-icon sampling, drawing and manufacturing conversion remain in consumers.

The PCB track, via and standalone-pad renderers keep their SVG references in
module-private weak maps keyed by entity identity, not in `_svgElements` fields
on model objects. Rendering, redraw and removal work with frozen entities.
Track selection asks the renderer to toggle existing net labels and still
rebuilds labels omitted by a selected redraw. Cleanup retains the existing
single-rendering-per-entity behavior, including detached/missing layers and
repeated removal; equal IDs on different instances do not share SVG ownership.
Inherited shape presentation methods and entity-level derived caches remain
separate boundaries; this does not make every entity type presentation-free.

Copper-fill add/remove/modify operations live in `core/pcb-fill-commands.js`.
Collection commands use the model's existing `boardShapes` array; modification
applies authored state to a `CopperFill`. Undo snapshots deeply copy outline
points, per-node radii and per-segment curvature. These commands do not calculate
pours or update connectivity. The `pcb/modules/copper-fill-commands.js` adapters
retain synchronous pour refresh, drag deferral, property controls and selection
anchors.

`commitFillEdit` in `pcb/modules/copper-fill-edit.js` stages geometry changes on
a detached `CopperFill` supplied to each mutation callback. It constructs and
validates the command snapshot without replacing canonical geometry references
or changing the authored fill/cache; throwing callbacks cannot leave partial
authored edits behind. Only the existing command applies accepted changes.
This is command preparation isolation, not fill pointer/group preview isolation.

Live computed pour polygons belong to `pcb/modules/computed-fill-cache.js`,
an identity-keyed weak map outside authored `CopperFill` entities. SVG, flat 2D,
3D, DRC, routing contacts, net propagation and ratsnest consumers read the same
results. Null means pending/failed; an empty array means a successfully computed
empty pour. Existing deferred-refresh timing is unchanged: previews can retain
the previous result until their scheduled recomputation. Failed computations
clear that result and log the error, while DRC retains its pending-pour report.
Clones and loaded replacements do not inherit results, even with equal IDs.
Detached fabrication snapshots intentionally retain their own `_computed`
transfer field and recompute from captured authored geometry rather than using
the live preview cache. This does not remove the remaining inherited shape
presentation methods or other entity-level derived caches.

`CopperFill.captureCopperGeometry()` captures the model's resolved boundary as
detached, full-precision data. It reuses `getOutline()` for circles, rounded
corners and bulged edges rather than substituting the authored control polygon
or the file serializer's rounded coordinates. Fabrication adds its `_computed`
field after capture; the model neither reads live pour caches nor computes pours.
Boundary snapshots can be edited or transferred without changing the live fill.

Generic board-shape add/remove/move/modify operations live in
`core/pcb-shape-commands.js` and take `PcbDocument`, retaining its collection and
shape identities. Geometry and property snapshot/apply helpers live alongside
persistence in `core/pcb-board-shapes.js`; the rendering module re-exports them
for existing callers. Commands own their full-precision geometry and nested
property snapshots, while imported image artwork remains shared read-only.
Generic add/remove commands retain the protected-outline no-op behavior.
Move/modify validate existing outline edits before mutation and return `false`
for rejected edits, leaving no partial geometry behind. Accepted outline edits
synchronize model-owned dimension metadata without rendering, including undo.
The editor adapters preserve selection cleanup, rendering, property controls,
3D refresh and immediate versus deferred copper updates. Live geometry edits and
their rollback paths explicitly synchronize outline dimensions through
`PcbDocument` before rendering. This includes property previews, anchor/vertex/
segment/whole-shape drags, floating arc conversion, group moves and shape loading.
Generic shape rendering, hover, selection and dedicated outline redraw no longer
write dimension metadata. Preview geometry still lives in the editable model
during a gesture; this change separates mutation from rendering rather than
introducing a detached preview model.

Copper-removal clipping retains its last settled cutout geometry while drag
overlays and pours are deferred. Moving removal artwork therefore leaves the old
holes visible until the drop's existing deferred copper refresh applies the new
position. Cancellation keeps the original cuts. Pan/zoom may resize the outer
clip rectangle during the gesture without moving those holes. This shared clip
policy covers single and grouped moves, both copper sides and Hole-layer cutouts,
without recomputing pours or rebuilding clip paths on each pointer movement.

Board-outline setup lives in `core/pcb-outline-commands.js`.
`PcbDocument.setBoardOutline()` validates and detaches incoming geometry before
adoption, retains an existing outline object and the model's collection/dimension
objects, and synchronizes dimension metadata from the actual boundary.
`ensureBoardOutline()` creates a missing rectangle from current model dimensions
without replacing an existing outline. Setup and undo therefore work without a
renderer, including restoration of offset circles and curved polygons. As in the
existing editor, undoing initial setup retains a rectangle at the previous
dimensions rather than removing the board. Preparing a legacy PCB section with
explicit dimensions but no outline now creates and validates a rectangle in the
model, reserving a unique ID if needed. Existing explicit outlines take precedence.
Normalization leaves caller data untouched and works before editor activation.
New/clear still leaves the outline absent and retains the dimensions prompt;
accepting defaults explicitly initializes the model before drawing.
The editor command retains draw/input/pour refresh ordering and first-draw
viewport fitting. Drawing alone neither creates geometry nor synchronizes model
dimensions.

`serialize(settings)` assembles the complete authored PCB section: stackup,
dimensions, design settings, optional panelization, entities and saved placements.
It applies the existing compact aliases and save-boundary precision, returning a
detached snapshot without rounding live data. Viewport preferences are an explicit
optional argument; the adapter's `serializePcb()` supplies them from the viewport,
but no editor-owned authored aliases are read. With no explicit preferences it
uses a detached snapshot retained during loading, preserving absent settings
without inventing defaults. Live viewport edits still belong to the view; the
loaded snapshot is a persistence fallback, not a second live viewport.

`ProjectDocument` always serializes schematic entities from `SchematicDocument`
and authored PCB state from `PcbDocument`. Registered views contribute only
`getViewSettings()`: current persisted view settings, or undefined before viewport
creation so loaded settings remain the fallback. A view cannot suppress or replace
model content by returning its own serialized section. The direct editor
serialization APIs remain available and delegate to their models.

The schematic model assembles shapes, components and deduplicated embedded
definitions. Its view-settings adapter captures grid, paper size/orientation and
title-block settings, including detached title-block data. Current settings
override the loaded fallback only for the saved snapshot; saving does not mutate
either the fallback or live entities. Direct schematic serialization and combined
project serialization use the same model codec.

For preparation, load and reset, `ProjectDocument` uses the PCB model directly
when no PCB view is registered; registered adapters retain their existing
model-adoption and presentation dispatch without double loading/clearing.
This works both with neither editor and with only the schematic editor.
`PcbDocument.serializeSection()` omits a genuinely absent/cleared PCB, but
preserves an explicitly loaded section even if it only contains metadata.
Fresh authored entities, placements, panelization or nondefault dimensions also
make a section persistable; retained design defaults alone do not. Supplying
current view preferences retains the existing settings-only section behavior
for an empty board whose viewport has been created, including after New.
Saving neither creates a viewport nor writes current preferences back into the
loaded fallback. The project saves current model state rather than caching a
serialized PCB. Existing best-effort serialized recovery uses the same
model-owned snapshot and captured view preferences; it remains serialized
recovery, not exact rollback.

Attaching a PCB editor preserves already supplied design settings rather than
replacing them with local defaults. `PcbDesignSettings.hasAppliedSettings` records
successful updates; rejected updates do not suppress default restoration, and
New retains the marker with the last-used values. A fresh model still accepts
local defaults, including the legacy display-unit format. Binding always displays
the model's values without reading rounded controls back.
The first viewport restores the model's loaded grid preferences. Controls bound
before or after viewport creation synchronize from the live viewport, selecting
the nearest fixed grid preset. Later viewport checks do not
reapply the loaded snapshot. Initial control edits capture the requested value
before viewport creation can refresh the controls. A metadata-only loaded PCB
also remains serializable through an attached editor before a viewport exists.

Both editors use fixed grid dropdowns. The metric list starts with 0.1, 0.25,
0.5 and 1 mm, followed by a nonselectable separator bar, then 0.0254, 0.127,
0.254, 0.635, 1.27 and 2.54 mm. There are no group headings; inch-derived
sizes show their inch and mil values in parentheses, for example `0.127 mm (0.005" / 5 mil)`.
The inch list remains 0.001, 0.005, 0.01, 0.025, 0.05 and 0.1 inch.
All inch presets therefore survive a switch to metric and back exactly.
Per the chosen fixed-list policy, a non-preset saved grid selects the nearest
preset when restored into an editor, even before controls exist; no custom option
is added. Unit changes also select the nearest available preset, so metric-only
sizes can still change when switching to inches. Saving from the editor records
the selected preset. Refreshing an already matching preset does not redraw the grid.

Viewport display conversions and inch ruler spacing use `1 / 25.4` rather than a
rounded reciprocal. Ruler label precision follows the selected tick spacing,
including all digits in 1/8-inch (`0.125"`) and 1/16-inch (`0.0625"`) ticks.
With a visible grid, ruler labels use 1-2-5 multiples of the grid spacing to
maintain at least 80 screen pixels between major labels. Thus a 0.1-inch grid
labels 0.1-inch intervals when zoom permits, rather than unrelated fractional
intervals. Both ruler axes remain aligned to displayed grid lines, including when
the tick limit requires skipping more lines. With the grid hidden, the existing
unit-based spacing is retained. Changing grid size or visibility refreshes the
rulers; ordinary panning still translates cached ticks without rebuilding them.
Metric labels omit trailing zeros, and extreme-zoom output stays bounded.
These presentation changes do not alter
authored geometry, grid presets or file-save precision.

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
`noteCreated`. Clearing resets panelization, but `loadContent()` does not
install prepared panel settings: the adapter installs them after artwork and
pours are restored, before the final active preview. Hidden loads install the
settings without rendering; a headless `load()` performs both phases without
rendering. Existing panel commands still create ordinary
authored note texts and retain their undo/redo behavior; model operations do not
generate notes. Preview SVG and its lifecycle remain editor-owned.

The editor adapter still removes old SVG and selection before replacing entities,
renders only when active, and refreshes derived geometry after loading.
Its design-settings refresh only updates controls and local defaults from adopted
model data; it neither adopts data nor marks the document dirty.
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
An editor attached after headless loading recognizes that outline at construction,
so direct activation and hidden preload restore it without prompting for new board
dimensions. Fresh and metadata-only models without an outline still prompt.
Active loads and schematic-driven rebuilds draw the outline once through its
dedicated path; general artwork batches skip that already-rendered outline.
Other board artwork still renders after footprints, and an outline not yet drawn
through the dedicated path remains eligible for normal shape rendering.

Manufacturing capture rejects active inline text edits and board-outline resizes,
as well as deferred geometry drags, rather than exporting cancellable previews.
Track-to-pad connection records are copied along with their maps before any
asynchronous pour preparation; snapshot and live metadata cannot mutate each other.
Standalone text capture reuses the neutral `serializePcbText()` snapshot rather
than cloning the entire live object. Authored text fields retain full precision;
editor metadata is neither copied nor traversed. The model's omitted false-border
default retains the same fabrication geometry. Worker transfer and Gerber output
remain consumer-owned.

When a PCB model is attached, fabrication reads routing dimensions, board
dimensions and panel settings directly from `PcbDocument`, rather than through
editor projections. These inputs are captured at full precision before any
asynchronous pour work. Model-less callers retain the existing explicit-input
contract; an attached model's errors do not fall back to editor values. Outline
precedence, legacy origin handling and Gerber coordinate conversion are unchanged.
Fabrication capture and its content check also read tracks, vias, pads, text,
board shapes and fills directly from the attached model, without consulting
editor collection getters. Entity assembly delegates once to `captureGeometry()`;
the adapter adds detached track queries and export-only pour results. Model-less
callers use the same neutral collection-capture helper. Document-only artwork retains its existing exclusion
from the content check. Entity geometry is detached before asynchronous work;
resolved component placements and netlist inputs still come from the caller.
This does not yet make the complete fabrication pipeline editor-independent.

`core/pcb-placement-geometry.js` owns the detached resolved-placement contract
through `captureResolvedPlacement()`. It preserves the full-precision pose,
physical pad identifiers and positions, local pad/paste/artwork geometry, outline
and reference settings, without traversing SVG elements, hit-test bounds, lock
flags or 3D presentation state. Capture does not normalize poses or introduce
defaults. The fabrication adapter delegates this copying before asynchronous
work, keeping automatic placement positions paired with the caller's resolved
netlist. Moving automatic placement resolution itself remains separate work;
Gerber coordinate conversion, drill formatting and pour computation stay in consumers.

Component selection exposes the shared rotation handle only for a single
selected component. Its gesture uses one-degree, clockwise-positive footprint
angles around the placement origin; text/image rotation keeps its existing
opposite sign convention. Preview updates use editor-owned placement projections,
keeping pad positions, projected bonded track nodes and their SVG geometry attached on either
board side and under mirroring. Unchanged rounded angles skip all preview work.
Live ratsnest updates are limited to the component's nets and skip pour rebuilds
until completion. The component rotation spinner follows previews and history;
typed values and spinner steps commit through the existing rotation command
without replacing the input. Pose commands also refresh selection anchors.
Release records one `RotatePlacementCommand`, seeding automatic placements from
the original pose. Escape, undo during a gesture and protected drops restore
the original pose and track bonds without saving the preview. Locking through
the properties panel cancels the active gesture before recording the lock.

Free-standing text creation, defaults/layer rules and full-precision snapshots
live in `core/pcb-text.js`. Undo and clipboard use these snapshots without file
rounding; `PcbDocument.serializeEntities()` rounds text position, size, rotation
and stroke width to four decimals only at the save boundary. The rendering
module re-exports the data helpers for existing imports but retains only glyph
geometry, hit-testing, SVG and layer-color responsibilities.

`core/pcb-text-commands.js` owns add/remove/move/edit text mutations, undo state
and descriptions, operating directly on `PcbDocument` without an editor or DOM.
The existing `pcb/modules/text-commands.js` imports remain editor adapters: they
delegate mutations to the model commands and retain SVG, selection, property
control and derived-refresh updates. Deleted text is restored from an unrounded
snapshot with its original ID. Add undo retains the current model object, which
may have been recreated by a later deletion undo, so a complete undo/redo chain
cannot resurrect a stale text instance. Missing move/edit targets fail explicitly.

Single-text movement/rotation, text-only groups and mixed component/text groups
use an editor-owned text-map projection. The first changed pose copies each
participating text once; further updates reuse those objects and map, while
unrelated text objects retain their identity. The complete participant set is
validated before publishing a projection. The editor's `texts`
getter and selection adapters resolve the displayed projection for SVG, bounds,
hit testing and selection anchors. `PcbDocument.texts`, serialization and geometry
capture remain unchanged until commit. The projection is removed before the
existing move/edit command runs, so undo captures the original canonical values
without a temporary model rollback. Cancel and failed commits discard the
projection and restore canonical artwork; deleted targets are not resurrected.
Tab deactivation and document loading cancel active component and text pose
gestures through the shared pose-preview lifecycle hook. Terminal selection
interactions clear their state even if completion throws, while intentional
floating-anchor interactions remain active. Errors still propagate.
Groups containing directly selected tracks, vias, pads, shapes or fills, along
with other entity/property previews, are not yet generally isolated,
so existing save/export readiness guards remain.

Text property inputs now edit the same reusable editor projection, never the
canonical text. A property preview owns only layer, size, rotation, stroke width
and layer-dependent anchor coordinates. It can coexist with independently owned
inline content; other committed fields synchronize without overwriting either
pending edit. Commit ends property ownership before executing the existing model
command, with no temporary authored rollback. Cancellation restores current model
values and controls. Panel replacement disposes old field bindings so late events
cannot restart an edit on the previous text. Layer locking, tab deactivation and
loading cancel pending property edits. Save/export readiness includes pending
text properties rather than silently capturing older values than those displayed.
Unchanged input/change values skip both redraw and clearance scheduling; changed
values update immediately. Content and border commands remain independent.

Standalone inline text uses one reusable editor-owned text copy and map from
entry to completion. Typing changes only that copy's content; canonical content,
geometry snapshots and serialization remain unchanged. No map or text copy is
created per keystroke. Changed input renders once; repeated unchanged input
updates caret/selection geometry without rebuilding glyph SVG.

Property edits made during inline typing use their existing independent model
commands. Their style/pose changes synchronize into
the same content projection without overwriting pending input, including
undo/redo. Layer-side compensation uses the displayed content width.
Completion removes the projection before a content edit or deletion command;
there is no temporary authored-content rollback. Cancel restores presentation
from the current model, preserving independently committed property changes.
Blank-content deletion and cancelled new-placement cleanup retain their prior
history behavior. Failed completion restores canonical artwork and tears down
the input, caret, keyboard listener and properties state before propagating.
Reference inline editing retains its existing separate model-command path.
Native property-field blur still commits a field before focus returns to the
hidden inline input; Enter/Escape retain that browser event ordering. Programmatic
cancellation discards any still-uncommitted field first. Text deselection also
clears its rotation anchors, including after inline completion.

Standalone text property panels, including the multi-selection intersection and
inline symbol insertion, are read-only on locked layers. Drag/rotation handlers
recheck layer locks and visibility before preview updates and commit; a protected
drop restores the original pose. Locking a layer cancels active text movement,
rotation and inline-content previews and refreshes selected property controls.
Direct inline-edit and deletion entry points also reject locked/hidden text.
Model history commands remain independent of these editor interaction guards.
When a text command changes its layer, the editor adapter refreshes the current
selected-text property panel on execute/undo/redo, including mixed selections.
This keeps the displayed layer, mixed-value state and lock-disabled controls in
sync. Non-layer patches do not rebuild the form, and commands for unselected
text do not replace the current properties panel.
Layer-property projection uses the existing `DerivedUpdates` batch scope: nested
compound edits coalesce it until the outer command completes or rolls back.
The refresh resolves the selection at that point, so the form does not display
intermediate layer states or resurrect a selection cleared during the command.

Standalone text, pad and image rotation previews resolve every pointer event using the
existing whole-degree angle policy, but skip presentation and input writes when
the resulting angle equals the current angle. Images retain the last rendered
angle only for the active gesture, preserving geometry and SVG node identity
for unchanged previews. Returning to the original image angle copies the original
points exactly rather than applying a zero-degree transform, avoiding numerical
drift and spurious history entries. Changed angles still render
synchronously; text clearance invalidation and pad highlight geometry update
only for changed previews. Commit/cancel refreshes and exact fractional-angle
history restoration retain their existing behavior.
Individual commands remain synchronous; no additional timer is introduced.

Single-text dragging skips projection writes, SVG rebuilds and crosshair updates when
the snapped position has not changed. Changed positions still render immediately;
there is no new frame scheduler or throttling. Drop passes the explicit original
and final coordinates to `MoveTextCommand` without first moving/rendering the text
back at its starting position. The command retains the final presentation and
deferred copper refresh; cancel still restores the starting position without a
history entry. Existing translated clearance geometry and selection anchors are
preserved.

Text placement and drag crosshairs mark the authored `(x, y)` placement origin,
which is also the point attracted to the grid. They do not add a font-size or
stroke-width offset, so rotation, layer mirroring and borders cannot displace the
crosshair from the snapped point. The text tool uses its grid snap for both the
crosshair and placement, rather than using track-target snapping only for the
crosshair.

Saved PCB placement/reference settings live in
`ProjectDocument.pcbDocument.placementState` (`core/PcbPlacementState.js`). The PCB editor's
`_placementOverrides` aliases its map. Recording copies only the persisted pose,
side, lock and reference-style fields, never generated pads/SVG/caches.
Loading and clearing preserve map identity; serialization retains the existing
four-decimal precision and default-field omission. These operations work without
an editor or DOM.

`ProjectDocument.resolvePcbLayout()` resolves physical placements and their matching
netlist from the schematic and PCB models, without a registered view. Placement
state owns the stable automatic grid slots and neutral footprint generation,
including full-precision world-pad positions, duplicate physical pad IDs and
bottom-side/mirror/rotation handling. Existing automatic slots survive ordinary
component deletion/reordering; New/load/reset clear them in place. Slots are
derived, never serialized or marked dirty, and failed resolution does not retain
partially allocated slots.

`ProjectDocument.synchronizePcbLayout()` is the explicit mutating counterpart:
it resolves all placements and connectivity first, then updates track endpoints
and incompatible bottom-side pad bonds using the existing rebuild eligibility
rules. Resolution failures leave tracks untouched. It preserves track/map
identity, invalidates changed track bounds and does no redundant physical work
when repeated. It does not create placement overrides or notify dirty hooks;
the existing schematic-change lifecycle retains that responsibility.

Schematic-driven PCB rebuilds synchronize the models before clearing SVG or
rendering persistent tracks. The editor then consumes the resolved placements,
adding SVG, LOD bounds and 3D presentation metadata. Footprint rendering uses
presentation-only side/pose helpers: it neither reads track models nor repeats
pad calculations or bonded-track rendering. Clearances and ratsnest refresh
after the complete rebuild. Headless consumers
can pass `{ pcbDocument: project.pcbDocument, ...project.resolvePcbLayout() }`
to fabrication snapshot preparation. The layout query itself does not move
track nodes or change bonds; consumers needing rebuild-time track updates call
the explicit synchronization operation first. General live-preview isolation
remains a separate migration boundary.
Fabrication does not automatically replace a live
editor's supplied placements/netlist: general preview isolation remains open,
and mixing committed poses with preview-mutated tracks would be inconsistent.

`ProjectDocument.restorePcbPlacementOverrides()` handles saved-pose restoration
independently of an editor. It resolves current physical footprints for saved
overrides, optionally restricted to supplied component IDs, before changing any
track. Unlike the legacy rebuild eligibility rules, restoration always repositions
compatible endpoints and disconnects incompatible SMD bonds on either side.
Missing/non-physical components and automatic placements are not restored; saved
records are retained unchanged and no automatic grid slots are allocated.
The load adapter requests only currently rendered IDs, replaces their footprint
artwork and LOD nodes with model-resolved geometry, and leaves unrelated layers
and placements intact. It never reads cached rendered pad geometry. Fresh artwork
also restores default reference styling after a custom style. Persistent tracks
are rendered afterward by the existing load sequence; hidden loading remains
deferred until activation.

The metadata commands in `core/pcb-placement-commands.js` own lock and reference visibility, offset,
rotation and style edits directly against `PcbPlacementState`. Commands patch
the latest canonical record without replacing unrelated pose fields. All placement
commands take their initial baseline from a saved override, otherwise the
model-owned automatic slot. After layout resolution, headless commands need no
editor-supplied seed; automatic poses receive the same defaults as resolved
placements. An explicit baseline remains supported when neither model record
exists, but never overrides model-owned data. This also prevents unrelated live
preview fields from becoming authored state during the first edit.
`capturePlacementOverride()` detaches only persisted fields; construction does not
create overrides, allocate slots or edit tracks. First-edit undo retains the
baseline override, matching existing persistence behavior. Missing placements
without a saved record, resolved automatic slot or explicit baseline fail immediately.

The existing metadata editor command names remain adapters. They project only edited
fields into the current generated placement, then retain transform/glyph,
selection, overlay and 3D updates and notify the dirty hook. They no longer
re-record the whole generated placement to persist metadata edits. Authored
undo/redo works without a currently rendered placement.

Reference-label drag completion uses explicit original/final local offsets.
Commit passes them directly to `MoveRefTextCommand`, without repainting a
temporary rollback or repeating the command's final overlay refresh.
Cancellation restores only the live reference offsets, without recording
history, dirtying the project or creating a saved placement override. Shared
selection and legacy Escape/Undo paths both finish the drag; physical pad and
bonded-track positions are unchanged. Local-frame magnetic snapping and
placement rotation/mirroring remain the same.

Both reference-drag paths re-evaluate magnetic snapping on every pointer event,
but skip SVG transforms and selection/tether overlay rebuilding when the resulting
local offsets are exactly unchanged. Distinct free positions still render
immediately; there is no rounding, movement threshold or new scheduler.

Reference property commits restore the pre-preview style only in memory before
constructing `SetRefStyleCommand`, so automatic placements retain their original
canonical baseline for undo. They do not regenerate glyphs or redraw overlays at
that temporary rollback value. No-op commits do not perform an additional redraw;
the shared input handler still presents valid edits immediately.
Reference rotation spinners use one-degree increments in both single-reference
and multi-selection properties.
During inline label editing, focused numeric properties retain their native
typing, selection, clipboard and navigation keys; Enter/Escape still finish the
inline edit. Rotation fields normalize their displayed angle on commit, not
while a signed value is being typed.

Inline reference-name commits likewise let the project-owned rename command
present the final label without a temporary rollback repaint. Its editor wrapper
owns the single properties refresh plus netlist, ratsnest and 3D updates on
execute/undo/redo. Cancel and whitespace-only no-op commits restore the original
preview without adding history or refreshing nets; validation still happens before
the inline editor is torn down.

Reference previews, cancellation, offset/rotation history and glyph regeneration
use the existing `renderPlacementPose()` helper for SVG transforms only. They no
longer call the physical `applyPlacementPose()` path: reference-only changes do
not recalculate world pads, scan track bonds or rebuild physical clearance.
The shared renderer retains placement/reference transforms, pad-number
counter-mirroring, LOD and halo transforms. Dirty, reference-overlay, inline-caret
and 3D notifications remain with their existing editor callers. Physical movement,
rotation, side changes and initial placement setup keep their geometry updates.

`applyRefGeometry()` retains the last successful layout inputs in a renderer-local
WeakMap keyed by the reference SVG group. Unchanged text, anchor, size and stroke
width reuse existing glyph nodes, including rotation-only property edits and the
commit following a matching live preview. Changed layout inputs rebuild immediately;
replacement groups build independently. The cached inputs are invalidated before
DOM mutation so failed updates cannot masquerade as reusable geometry.
`_rerenderRef()` invalidates the local reference-box cache only when glyph geometry
changes, but always refreshes pose, highlight and inline-edit caret presentation.
This reuse state is not authored model data and does not affect Canvas, 3D or Gerber
geometry generation.

Reference selection outlines include the user counter-mirror after reference
rotation and before offset/placement transforms, matching SVG and export geometry.
Hit-testing reverses that order, undoing the counter-mirror before reference
rotation. Selection bounds and pointer-relative lock positions use this corrected
outline; neither authored geometry nor reference handedness is changed.
Reference picking also respects the visibility of its side's silkscreen layer:
legacy hit-testing skips hidden labels before resolving layout boxes, and shared
selection adapters report them as invisible. Missing placements are invisible to
stale adapters. Hiding one side does not suppress visible references on the other.

Reference interaction locking combines the placement lock and its side's silk
layer lock. Locked labels remain selectable for inspection/unlocking, but shared
and legacy dragging, keyboard rotation and single/multi-selection properties
respect that combined policy. Locking silk cancels active reference drag and
inline-name previews; a drag also rechecks the lock before committing. Layer
lock changes refresh the selected reference's property controls. Reference lock
icons retain both their component owner and layer-unlock callback, keeping
authored placement-lock history separate from layer-panel preferences.

The same core module now owns `MovePlacementCommand`, `RotatePlacementCommand`,
`FlipPlacementCommand` and `SetPlacementSideCommand`. These take the project document, resolve its current
footprint on every execute/undo, patch only the requested canonical pose fields,
and reposition bonded track nodes by physical pad ID. History captures authored
pose values, not footprint geometry or rendered placements. Automatic placements
use the same detached, lazy baseline mechanism as metadata commands.
Their editor subclasses project the resulting pose and world pads into the
current placement and render touched tracks; they do not repeat model movement
using potentially stale view offsets or re-record the generated placement.
Dirty, clearance, ratsnest, fill and 3D notifications remain editor-owned.
Model undo and track updates also work when there is no rendered placement.
An unavailable model footprint fails before pose or graph mutation.
`CommandHistory` transfers an undo/redo entry only after that operation succeeds,
so such failures retain the entry for retry; this is not general mutation rollback.

Single-component movement/rotation and component/text group movement use
editor-owned track projections. The first changed pointer position copies only
tracks bonded to participating components, preserving their IDs, full-precision
topology and physical pad connections. Further movement reuses those objects.
Tracks shared by moving components are copied once and rendered once per update,
after all their endpoints have moved. During the gesture, the editor's `tracks`
getter exposes the projected list for rendering, clearance and ratsnest queries;
`PcbDocument.tracks`, its bounds caches, serialization and geometry capture remain
unchanged. Unrelated tracks retain their original identity.

Commit ends the projection before the existing model command runs. Preview SVG
is replaced by canonical SVG without duplicate tracks, including endpoints that
already match the final target and need no command-side movement. Cancellation
discards the projection and restores the starting placement/pads and canonical
track artwork without rewriting authored copper or recording history. Command
failure also removes preview state and restores presentation before propagating
the error. Tab deactivation and document loading cancel these component gestures.
Groups containing only components and/or texts compose the track and text
projections. Both projections end before the existing compound command runs.
Group commits preflight every participating footprint and text before authoring
any member, so a missing later target cannot leave earlier members authored.
This is not general transaction rollback. Texts render once per changed group
position through the selection refresh, without a duplicate per-text redraw.
Pending frame movement is discarded on cancel but flushed on commit. Ctrl+Z
cancels the live preview before undoing the previous committed command.
Group movement retains shared-delta snapping and outer overlay deferral; no-op
drops and cancellation preserve redo history. Save/export readiness guards
remain in place: other grouped moves and direct
entity/property previews are not yet generally isolated.

Single via and standalone-pad movement uses an editor-owned projection in
`_viaDrag`. Pickup checks node proximity before incident-edge/layer eligibility;
it does not clone geometry. The first changed position copies the terminal and
each attached track once, retaining IDs, precision and topology. The editor
collection getters and terminal selection adapters expose those reusable copies,
while canonical collections, bounds caches and manufacturing/serialization
snapshots stay unchanged. Repeated final positions skip geometry redraws.
Commit drops the projection before executing the existing compound model
commands, with terminal, attached-node and snap-target preflight. Segment-contact
snapshots are prepared on a detached track rather than temporarily splitting
authored geometry. Cancellation, no-op drops, command failures, tab deactivation
and loading discard preview SVG and restore canonical presentation. Discarding
unchanged copper does not repour fills; nested overlay deferral is retained.
Standalone-pad rotation handles use a separate editor-owned gesture/projection
in `pcb/modules/pad-commands.js`. Pickup allocates no pad copy or collection;
the first changed angle creates one exact-state pad copy and one array, reused
for subsequent angles. `PCBApp.pads` and rebuilt selection adapters resolve that
copy for rendering, bounds, hit tests and anchors, while authored pad state and
attached tracks remain unchanged. Repeated angles do not redraw geometry.
Completion removes preview SVG and the projection before `ModifyPadCommand`;
Escape, deactivation, loading, missing targets and rejected commands clean up
without canonical rollback. Returning to the exact initial angle preserves redo.
Gesture state is editor-owned too, so rebuilt adapters can finish it and stale
callbacks cannot resume a discarded gesture. Save/export guards remain active.

Live numeric pad properties (size, ratio, drill and rotation) use a separate
fixed-selection projection in `pad-commands.js`. The first changed value copies
the selected pads and their collection once; later inputs reuse those copies
and retain animation-frame-coalesced SVG rendering. Identical values do not
redraw or reschedule copper work. Bounds, hits and selection adapters resolve
the displayed copies, while canonical geometry and serialization stay unchanged.
`change` (including change-only spinner events) clears the projection before
existing single/compound `ModifyPadCommand` execution, with every target checked
before the first mutation. Undo retains full precision, and no-op edits retain
redo. Shape, copper-side and net controls keep their immediate-command semantics,
committing a pending numeric field first; placement defaults remain outside
document history.

The pad property binding cancels on Escape, tab deactivation and layer locks,
and disposes detached controls when the panel is replaced, a layer is hidden
or a document is loaded. Pending render frames are cancelled on every exit.
Save and fabrication-export guards include active numeric pad edits. Pad
collection precedence is terminal movement, rotation handle, numeric properties,
then canonical state; starting a pad move or rotation commits pending numeric
properties first.

Via diameter/drill properties use the corresponding fixed-selection projection
in `track-commands.js`, exposed through `PCBApp.vias` after movement previews.
First-change snapshots replace the old panel-open baseline, so edits after
undo/redo use current authored values. Copies and collection identity are reused,
unchanged values schedule no frames, and live edits preserve the existing policy
of rendering SVG/selection halos without refreshing fills or clearance geometry.
The existing largest-drill/smallest-diameter constraints remain in force.
Completion removes copies before `ModifyViaCommand` or `ModifyViasCommand`,
preflights every target and retains the batch command's single derived refresh.
Net changes stay discrete, commit any pending numeric field first, and retain
bonded-copper propagation and schematic-assigned net rejection. Selection and
hover resolve displayed copies without losing canonical command identity;
starting a via drag commits pending properties before movement pickup.
Panel replacement, Escape, deactivation, loading, locks and visibility changes
clean up previews and queued frames, and save/export readiness includes them.
Groups containing terminals and direct track properties/node/segment/arc previews
retain their existing paths and remain ownership work.

Both component pointer paths use the same live pose updater. If magnetic snapping
produces the current coordinates, it skips footprint transforms, pad/bond updates
and incremental ratsnest work. The comparison is exact: distinct positions in the
free region still update immediately, without rounding or additional throttling.
The legacy event handler updates Shift before delegation and now shares the
adapter's placement-lock guard. Drop/cancel processing still runs even if the
last pointer update did not change the pose.

Side changes retain the established snapshot of all existing track bond records
at each execute/redo. The command owns copies and restores them into the current
connection maps on undo, then checks compatibility against the current footprint.
Incompatible SMD bonds are removed before connected endpoints move; through-hole
and otherwise compatible bonds follow the new pose. Footprint resolution precedes
both restoration and snapshot replacement, so a missing footprint leaves bonds
and the last good snapshot intact. Restored bonds count as touched tracks even
when their endpoints did not move. The editor adapter updates generated pad/paste
layer descriptors and artwork without repeating model bond mutations; the existing
live-sync side helper retains its data-plus-presentation behavior.

`core/pcb-placement-geometry.js` owns renderer-free world-pad updates, bonded
track-node movement, side-dependent pad/paste layers and incompatible-bond
removal. It uses the shared affine transform and mirror predicate in
`pcb/modules/board-geometry.js`; editor wrappers retain SVG updates and redraw
only touched tracks. Moved tracks invalidate their geometry bounds independently
of rendering. Bond compatibility uses physical pad IDs, not potentially repeated
logical pad numbers, so duplicate through-hole pads retain compatible bonds.
These operations consume current geometry rather than capturing footprint
definitions in history: footprint re-sync can replace geometry while retaining
commands.

`ProjectDocument.getPcbFootprint(id)` resolves the current schematic component's
selected package through `core/pcb-footprint.js`, without consulting a view.
The shared factory returns detached footprint artwork data, physical pad
descriptors and separate paste-only apertures; live placement generation uses
the same conversion. Duplicate pad IDs, layers, mask/paste flags, drills, slots
and live precision retain their existing representation. Resolution reads the
current definition on every call, including in-place edits or component
replacement, rather than retaining a geometry snapshot in history or adding
another cache. It does not create placement overrides or a saved PCB section.
Missing/non-physical components return null; physical components with no
footprint data retain the existing empty geometry result. The existing pure
parser remains in `pcb/modules/footprint.js` alongside its rendering exports.
All four physical placement commands use this source. Entity/render and derived
cache coupling, live-preview mutation ownership and the
explicit viewport-preference boundary still need closure review; physical command
separation does not imply that all model boundaries or application decomposition
are complete.

The live `placements` map and automatic layout slots remain editor-owned:
they contain generated footprint geometry, presentation caches and temporary
gesture state, not a second authoritative saved-placement store. PCB presentation
during loading and viewport settings remain in the PCB adapter.
Viewport culling uses constant-time selection membership rather than rebuilding
the selection list for each footprint. Every in-view selected footprint keeps
its detailed artwork at low zoom; unselected footprints retain the 24-pixel
placeholder threshold, and offscreen footprints still cull with 50% overdraw.

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
Headless serialization preserves loaded settings; registered editors supply
current viewport settings to model-owned project serialization. Schematic editing callbacks explicitly notify the
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
- `core/grid-snap.js` owns the shared displayed-grid magnet: each coordinate
  remains free unless it is within eight screen pixels of a grid line, capped
  at 40% of the displayed spacing so there is always a free region between
  lines. `snapToViewportGrid()` adds viewport visibility, adaptive spacing and
  the temporary Shift override; both `Viewport.getSnappedPosition()` and PCB
  text/component/reference movement, paste, group movement and outline resize
  use it. PCB's `_snapToGrid()` is a magnetic adapter, not nearest-grid rounding.
  Existing gesture anchors (including group deltas and local reference offsets)
  and higher-priority pin/pad/alignment constraints are unchanged.
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

The editor's clearance-halo cache includes per-segment curvature alongside
widths, corner radii and other geometry/style fields. Curvature edits invalidate
the cached contours even when endpoints stay fixed; unchanged shapes and pure
translations continue to reuse the existing halo geometry.

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
  cutouts. Via is not an assignable shape layer: creation, single-selection
  and multi-selection properties exclude it. Starting a shape while Via is
  active prefers Top Silk, following the existing non-graphic-layer fallback.
  Locked destinations in shape/image layer dropdowns show a monochrome text lock and
  use native disabled options (greyed out). Layer-panel lock changes update
  these options in place without rebuilding the shape property form.
  New shape tools retain an unlocked valid active layer, otherwise select the
  first valid unlocked entry in layer order. If none is available, the dropdown
  and status show **No unlocked layers** and no new shape preview can begin.
  Lock changes refresh an idle drawing tool's default and layer-dependent
  controls; unlocking a valid layer makes drawing available immediately.
  Existing shape assignments and in-progress drawing layers are not automatically
  reassigned by this default-selection policy.
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
