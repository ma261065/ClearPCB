# PCB Model and Geometry

Part of the [module contracts](../module-contracts.md). The PCB document model
and its commands, copper geometry, board shapes and outline, board/panel/design
settings, fabrication capture, 3D data and the track/via model.

## PcbDocument and Commands

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
A pad's drill may be 0, meaning no hole (test pads): it has no bore in 2D, no
drill-file entry and flat copper on its assigned face(s) in 3D. Any negative or
missing drill still falls back to the 0.8 mm default.

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

`core/pcb-lock-commands.js` sets one object's own `locked` flag (tracks, vias,
pads, board shapes, fills, text). Free text resolves by id, like the text
commands, because deletion undo recreates its record; other kinds keep their
instance. Placement locks stay in `core/pcb-placement-commands.js`. Layer locks
are editor preferences and never reach the model.

Track drawing and single-node drops distinguish edit-time connections from
physical copper contact. The connection policy follows explicitly placed nodes
on compatible copper layers (including nodes placed onto segment/arc interiors,
pads, vias and copper shapes), preserving schematic-pad Net authority. It rejects
incompatible named connections before committing. A segment merely crossing
other copper does not trigger a Net-conflict popup or label that copper; physical
short/clearance checking remains DRC's job. Drawing and dragging share the
node-to-copper target query in `collectNodeConnections`; the existing graph and
Net commands apply the validated connection. `collectBondedCopper` has no
edit-specific crossing filter; physical-contact consumers, including
ratsnest/DRC geometry, retain their existing rules. Post-drop adoption
uses the validated contacts rebound to the final graph, so node merges and
collinear cleanup neither lose intended adoption nor rediscover remote crossings.

A copper shape and the Track it converts to are the same copper, so they follow
one set of rules. `test-copper-path-parity` converts rounded, bulged,
mixed-width, open and closed shapes and checks that selection hits, pad/via
connectivity and ratline endpoints agree between the two models:
- Ratline endpoints sit on drawn copper: nodes the copper passes through, plus
  at most `RATLINE_CURVE_POINTS` on-curve points per rounded corner or arc
  (`curveRatlineTargets()`), which bounds the cost of the spanning tree. Shapes
  use `boardShapeRatlineTargets()`; curved Tracks use their rendered centreline
  from `resolveTrackEdgePaths()`, never a rounded corner's off-copper node.
  Junction bonding still uses exact node positions (`test-track-ratline-rounded`).
- Strokes hit within half their width plus the pick tolerance
  (`hitTestStrokeSegments()`), for Track edges, Line/arc shapes, closed-shape
  contours and schematic polylines, arcs and wires alike.
- Each half of a rounded corner takes the width of the segment it joins.

Assigning a net to an unfilled copper polygon or rectangle converts it to a
closed-loop Track, as for open copper Lines (`e<i>` is segment `i`, the last
edge closes the loop). A rectangle's circular corners become explicit arc
edges, because Track corner rounding is quadratic. Clearing the net restores a
polygon, or a rectangle when it is still an axis-aligned four-node loop.
Filled copper shapes are areas and keep the net as a shape
(`test-track-restoration`).

## Geometry Authorities

Each kind of PCB geometry has one function that resolves it, and every output reads
that result rather than re-deriving it. When a representation looks wrong in one view,
fix the authority, not the consumer.

| Geometry | Authority | Consumers |
| --- | --- | --- |
| Placement pose | `placementPose` (`shared/pcb/board-geometry.js`) | resolved placements (`core/pcb-placement-geometry.js`), electrical pads, reference text, track drawing |
| Pad copper flashes | `resolvePadFlashes` (`board-geometry.js`); posed outlines from `padFlashOutline` (`shapes/pad-geometry.js`) | 2D board view (`board2d.js`), 3D view (`board3d.js`), Gerber |
| Electrical pads | `resolveCopperPads` (`pcb/modules/copper-model.js`) | copper clusters and ratsnest, DRC, pour context, track drawing |
| Pad mask openings | `resolvePadMaskOpenings` (`board-geometry.js`); Gerber builds mask layers with the same `MASK_EXPANSION` | 2D and 3D board views |
| Drills and slots | `resolvePlacementDrills` (`board-geometry.js`) | 2D and 3D views, Gerber/Excellon, pour context |
| Footprint silk | `resolveSilk` (`board-geometry.js`) | 2D and 3D views, Gerber |
| Reference text | `resolveReferenceText` (`shared/pcb/reference-text.js`); the SVG footprint uses `layoutReferenceText` from the same module | 2D and 3D views, Gerber |
| Board shapes | `resolveBoardShapeGeometry` (`shared/pcb/board-shape-geometry.js`) — see [Board-Shape Geometry Contract](#board-shape-geometry-contract) | SVG rendering, 2D and 3D views, Gerber, pours, DRC artwork, copper removal, routing obstacles, track contacts |
| Copper pours | the computed fill (`getComputedFill`, `pcb/modules/computed-fill-cache.js`) | pour SVG, 2D and 3D views, DRC; fabrication export recomputes pours in its snapshot (`fabrication-snapshot.js`) |
| Routing obstacles | `buildCopperObstacles` (`pcb/modules/copper-obstacles.js`) | router input (`route-input.js`) |

### Intentional differences and model limits

- Conservative pour outlines, picture-wide pour clearance, routing envelopes and
  bounded visual tessellation are deliberate approximations. They must not become
  connectivity: electrical contact uses the actual geometry.
- DRC uses physical pad outlines and picture regions, and subtracts copper-removal
  artwork per side before clearance and short checks; mask-only artwork does not
  remove copper. Plated barrels keep surviving surface copper connected, while
  nominal drill and ring checks ignore surface removal. Clipped circles, arcs and
  round stroke joins are tessellated to 0.0001 mm on 0.000001 mm integer
  coordinates (`copper-removal.js`); unaffected features keep analytic distance
  checks. This is bounded geometric checking, not exact geometry.
- Footprint import (`shared/pcb/footprint.js`) supports only orthogonal pad rotation
  (width and height swap for 90° and 270°), and polygon pads become rectangles. These
  are import fidelity limits: every consumer agrees with the imported model, which
  can still differ from the source footprint.

## Copper Geometry

Track bounds, hit tests and centreline distances use the shared copper paths in
`shapes/track-geometry.js`, including per-edge widths, bulged edges and rounded
corners. `shared/pcb/board-geometry.js` re-exports the same resolvers, so existing
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
`shared/pcb/board-geometry.js` remain available.

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

## Board Shapes and Outline

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
3D refresh and immediate versus deferred copper updates. Accepted commands and
loading synchronize outline dimensions through `PcbDocument` before rendering.
Pointer, property, group and generic-dimension previews use detached copies;
canonical outline geometry and dimensions remain unchanged until acceptance.
Generic shape rendering, hover, selection and dedicated outline redraw do not
write dimension metadata.
Copper-fill region editing uses the same board-shape selection, focus, drag,
topology and property-preview implementation through a fill edit profile. Fills
remain `CopperFill` entities stored in `boardShapes` with `type: "fill"` and keep
their own commands, copper-layer/net fields, file format and computed-pour
pipeline; only the interactive outline-editing mechanics are shared.

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
dimensions rather than removing the board. Preparing a PCB section with
explicit dimensions but no outline creates and validates a rectangle in the
model, reserving a unique ID if needed. Existing explicit outlines take precedence.
Normalization leaves caller data untouched and works before editor activation.
New/clear leaves the outline absent and retains the dimensions prompt;
accepting defaults explicitly initializes the model before drawing.
The editor command retains draw/input/pour refresh ordering and first-draw
viewport fitting. Drawing alone neither creates geometry nor synchronizes model
dimensions.

Board-shape decoding and serialization live in `core/pcb-board-shapes.js`,
reusing pure geometry and artwork-codec helpers. The model owns the
shape ID counter; the editor's `_shapeIdCounter` is an accessor, not a second
counter. Rectangle frames, corner-point compatibility readers, image artwork encoding
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

## Board, Panel and Design Settings

Saved board dimensions live in `PcbDocument.board`. Shared board-outline helpers
own the detached dimension projection during generic numeric/resize previews and
expose projected or canonical dimensions through `boardDimensions(app)`. The lazy
projection holds reusable board/outline copies; rendering and property fields
follow it without changing authored dimensions, outline geometry, serialization
or settled-fill caches. Acceptance clears the projection before the existing
board command. Cancellation, panel replacement,
locks/hiding, loading/deactivation, replaced targets and failures clean up
artwork without authored rollback. Repeated values and stationary pickup skip
redraw/projection work. The dimensions dialog remains command-only. Loading
restores dimension-only boards, while an
existing outline's bounds and corner radius override saved dimension metadata.
Clearing restores the existing 100 x 80 mm, zero-radius defaults without replacing
the dimension object. `serializeBoardDimensions()` rounds only the saved copy to
four decimals. `boardBoundary()` also accepts the neutral model directly.
Outline drawing, viewport fitting and property-panel presentation remain in the
editor. `pcb/modules/board-outline-resize.js` owns the editor-side drawn and
selected flags in a WeakMap, exports the draw/select/sync helpers used by load,
commands and layer changes, and exposes the read-only `isBoardOutlineDrawn()`
service for page/test readiness. Constructing a view does not reset loaded
dimensions.

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
Panel positioning holes use the shared hole geometry and ordinary hole border
style, with even-odd vector cutouts through the support artwork so the actual
grid remains visible in either theme.

PCB design settings live in `ProjectDocument.pcbDocument.designSettings`
(`core/PcbDesignSettings.js`). Track width, clearance, via diameter and drill
are canonical millimetres; routing and serialization never read rounded ribbon
values. The adapter in `pcb/modules/design-settings.js` handles display units,
local defaults, validation and refresh/dirty notifications. Unit changes convert
the display from the model, not from rounded controls.

## Fabrication

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
precedence, origin handling and Gerber coordinate conversion are unchanged.
Fabrication capture and its content check also read tracks, vias, pads, text,
board shapes and fills directly from the attached model, without consulting
editor collection getters. Entity assembly delegates once to `captureGeometry()`;
the adapter adds detached track queries and export-only pour results. Model-less
callers use the same neutral collection-capture helper. Document-only artwork retains its existing exclusion
from the content check. Entity geometry is detached before asynchronous work;
resolved component placements and netlist inputs still come from the caller.
Headless callers can supply the model and `ProjectDocument.resolvePcbLayout()`
result without constructing an editor.

## PCB Data Model

### 3D Outline Clipping

`src/pcb/modules/board3d-mesh-ops.js` triangulates concave board outlines and
clips each surface against those convex regions. A bounded spatial grid over
region bounds assigns only overlapping source faces to each region, in original
face order. Bounds are inclusive, and candidate faces still use the unchanged
per-triangle bounds check and exact clipping calculations. Vertices, face
winding/order, interpolated heights and material colors match the exhaustive
path; convex outlines retain their existing direct path.

The index is local to one clipping call and owns no mutable model/cache state.
The worker still completes the full surface batch before the viewer updates
surfaces and component bodies together. Camera depth handling, artwork detail
and hole subtraction are unchanged.

The viewer closure only wires the scene to these module-level pieces, which run
headless: `boardSurfaceFrame(app)` (outline, drills, inside/edge-crossing
bores), `buildBoardSurfaceInputs(app, frame, silkArtworkMesh)` (per-layer worker
inputs), `createSurfacePublisher()` (keeps a surface's GPU mesh while its
finished buffers are the same object) and `createBoard3DSyncScheduler()` (one
animation frame per burst of edits, with visibility and refresh guards
rechecked when the frame runs; closing the viewer cancels it).

### Stationary 3D Silkscreen Caching

`board3d.js` builds component silk and authored board artwork as separate
surfaces, using the same silk material, opacity, depth bias and layer order.
`createSilkArtworkMeshCache()` belongs to one viewer and snapshots authored
board shapes and silk color. Equal inputs reuse the expanded source mesh;
component movement does not rebuild or compare hundreds of thousands of
generated artwork triangles. Each generated silk mesh owns its color snapshot,
so palette changes cannot mutate cached inputs.

The existing surface builder compares the artwork mesh together with current
drills and outline. Unchanged artwork reuses completed worker buffers and its
GPU mesh. Hole/outline changes reclip it; artwork/layer/color changes regenerate
the source as required. Deletion yields an empty surface, and reopening creates
a fresh viewer cache. Both silk surfaces and component bodies still publish in
the same completed update, never as separate asynchronous visual steps.

### Independent 3D Solder-Mask Faces

The viewer submits `maskCoatTop` and `maskCoatBottom` separately to the existing
surface cache. Each input contains the same board outline and shared drills,
but only that side's mask openings. Moving a top-side SMD component therefore
reuses the bottom face's worker buffers and GPU mesh, and vice versa. Shared
drill/cutout or outline changes still invalidate both faces. Generated face
meshes own detached solder-mask color snapshots so palette edits also invalidate
both faces without mutating retained cache inputs.

Both faces share the existing mask material, opacity, depth bias and render
order. Hole subtraction and concave clipping are unchanged; completed surfaces
and component bodies still publish together. Side changes update the affected
openings on both sides rather than moving a stale cached surface.

### Built-In Component 3D Models

`BuiltInModels3D.js` authors package bodies relative to the mounting plane
Z = 0. Through-hole pins extend to Z = -2.1 mm: through the viewer's 1.6 mm
board and 0.5 mm beyond its opposite face. Surface-mount models, lead XY
positions, footprints and drill dimensions are unchanged.
The OBJ parser identifies the procedural-package header as source `builtin`;
the board viewer preserves that authored mounting plane rather than raising
the model by its lowest pin tip. Top/bottom placement, mirroring, rotation and
explicit model height offsets retain their normal behavior. Imported EasyEDA
models retain their minimum-Z seating.

### KiCad Footprints and 3D Models

KiCad `.kicad_mod` footprints are Y-down like ClearPCB, so
`KiCadFetcher._parseFootprintPreview()` uses their coordinates as written (only
`.kicad_sym` symbols, which are Y-up, are negated). Pad rotation is
counter-clockwise on screen, so a slot's axis angle is `base − rotation` in
Y-down coordinates. KiCad 3D models share the footprint's origin (often pin 1,
not the body centre) and put Z = 0 on the board surface; `objModelToMesh()`
therefore seats them by their raw origin at the footprint's `model3d` offset
(no bounding-box centring, no lift to the lowest lead tip), reflecting only the
model's Y-up axis. VRML models are in KiCad's 0.1-inch units and are scaled to
millimetres when converted; STEP models are already in millimetres.
`test-kicad-footprint-model-alignment` checks orientation, lead-to-pad seating
at 0°/90° and VRML units.

### Board-Shape Geometry Contract

`resolveBoardShapeGeometry()` in `src/shared/pcb/board-shape-geometry.js` is the
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

Rectangle and polygon `physicalContours` (Clipper offsets that cost
milliseconds) are memoised per shape object, keeping the last two results
(stroke and filled-removal variants). Each read rebuilds a key from every
geometry input (kind, layer, points, corner and node radii, segment bulges and
widths, line width, fill), so in-place edits need no explicit invalidation.
`boardShapeBounds()` caches its bounds with the contours, and
`boardShapeHitTest()` reads the contours directly. The shared contours are
frozen, so consumers must copy before changing them
(`test-board-shape-contour-cache`).

Open hole and copper-removal SVG outlines union round-ended segment capsules
with Clipper before emitting compound paths. This bounds acute joins, keeps
retraced/crossing strokes solid, and preserves genuine interior islands.
Hole paths use even-odd filling, like copper-removal paths. Per-segment widths,
curves and authored corner rounding come from the shared geometry descriptor;
native round-stroke 2D/3D and manufacturing output remain unchanged.
Hole borders are clipped inside the physical path with a user-space SVG clip;
they do not enlarge the cutout when switching from copper or silk. The shared
`insideStrokeGroup()` renderer keeps the clip and artwork in one disposable
subtree and preserves the visible border width. Panel positioning holes use
the same treatment; geometry, hit tests and exports are not inset.

`board-shapes.js` owns interaction, mutation, commands, SVG rendering, the
selection adapter and Track conversion; `board-shape-properties.js` owns the
Properties panel (its description, and committing edits through previews and
commands; `shared/ui/property-fields.js` renders it). Neither re-exports geometry functions. All geometry
consumers, including editor adapters and tests, import directly from
`board-shape-geometry.js`. Consumers that also need editor operations use
separate imports for the two responsibilities.

For headless tools and board-design agents:

```js
import { resolveBoardShapeGeometry, boardShapeBounds } from './src/shared/pcb/board-shape-geometry.js';

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
Enabled track clearance outlines likewise stay visible during whole-track,
segment, node, split/midpoint and curvature drags. The live path replaces only
the edited track's ID-keyed halo elements, using its detached preview runs and
the same offset calculation as a full overlay rebuild. Per-run widths and
layer visibility are preserved; unrelated halos and copper SVG are not scanned
or rebuilt. Toggle-off remains off during movement, and cancellation restores
the canonical outline even inside an outer overlay deferral. Full-board fill
and DRC work remains deferred independently of this visible outline update.
Simple board-shape edits also refresh their own clearance during node, segment,
midpoint and bulge drags; the copper-refresh debounce no longer hides those
outlines. Expensive picture/text geometry retains its existing deferred policy.
Via drags update the moved via's ring and each attached track's preview halo.
The via cache tracks contributors by ID and centre, preserving the largest
ring for coincident vias while refreshing only affected centres. Cancellation
and rejected drops restore canonical halos, including under nested deferral.
Terminal previews are removed before command-driven overlay refreshes so a
drop cannot leave duplicate preview/committed track outlines.
Like component, board-shape and group drags, each move of a track, via or
standalone pad redraws only the ratlines of the nets it moves: the dragged
track's net, or the via's or pad's net plus those of the tracks attached to it.
Ratlines join copper of one net only, and copper without a net draws none, so
other nets cannot change; the drop and cancellation redo every net.
`test-drag-ratsnest-nets` checks each kind of drag against a full rebuild after
every move.

### Tracks and Vias

- `PCBApp.tracks` — array of `Track` polyline-graphs. A Track may change
  layer mid-run via per-edge `edgeLayers`.
- Copper paths are Tracks. A Line, or an unfilled Polygon/Rectangle, in
  additive top/bottom copper is a Track whether or not it has a net
  (`isCopperPathShape()` and `trackFromBoardShape()` in
  `shared/pcb/copper-path-tracks.js`). Drawing, joins, splits, paste, file
  loading and any property edit that makes a board shape a copper path
  (unfilling, switching to additive copper, moving to a copper layer) create
  the Track instead, in the same undo step; clearing a Track's net keeps it a
  Track. Filled areas, copper cut-outs, copper pours and other layers stay board
  shapes. Line/polygon/rectangle are editing modes read from the track's
  topology: a rectangular loop (`isTrackRectangleLoop()`) resizes with the
  opposite corner fixed and rounds with circular corners, and Fill turns a
  closed loop into a filled board shape that keeps its net
  (`fillTrackLoop()`; `test-copper-path-tracks`, `test-track-rectangle-editing`).
  The track Layer menu also lists non-copper layers: choosing one turns a
  single-layer line or loop back into an unfilled board shape, dropping its net
  and pad links and keeping a hole's plating (`moveTrackToBoardLayer()`). Its
  Copper Mode menu does the same for the removal modes, which add no copper:
  the track becomes an unfilled shape on its own layer (`setTrackCopperMode()`),
  and switching that shape back to Add Copper makes it a track again. For
  branched or two-layer tracks those layers and modes are disabled with a tooltip.
  Panel edits first drop any in-progress pickup of the same track (a midpoint
  "+" click), so they always act on the real track. The browser scenarios in
  `tests/browser/track-shape-conversions.mjs` drive these conversions through
  the real Properties panel, then undo, redo, save and reopen.
- `PCBApp.vias` — array of standalone `Via` objects. **All** vias are
  represented here, including those sitting at a Track's layer-change
  node. Tracks never carry implicit vias.
- Decoupling: dragging a Track vertex moves only the vertex; any
  colocated Via stays put. Dragging a Via also moves its attached Track nodes.
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
  New shape tools keep their chosen layer even when it is locked or hidden: they
  never draw on another layer instead. The tool refuses to start a shape there and
  says why, and its Properties flags the layer with an Unlock or Show action (see
  [placing on a locked or hidden layer](pcb-editing.md)). Lock and visibility
  changes refresh an idle drawing tool's layer-dependent controls; unlocking the
  layer makes drawing available immediately. Existing shape assignments and
  in-progress drawing layers are not reassigned.
- Render (`track-render.js`) and Gerber/Excellon output (`gerber.js`)
  read vias exclusively from `PCBApp.vias`.
