# ClearPCB Module Contracts

Detailed behaviour and ownership contracts for individual modules. The layout,
the enforced import rules and the owner index are in
[project_structure.md](project_structure.md). This text moved here verbatim from
that document on 2026-10-02; only links to the archived review log were updated.

## Editor and Document Contracts

`ProjectDocument` dispatches successful file-action completion through registered
views' `onDocumentReplaced(reason)` hooks (`new`, `open`, or `import`). Each editor
owns its own Home-tab navigation; the PCB view also owns new-board setup timing
and disposal of its dimensions dialog. Completion is not emitted for cancelled
or failed file actions. The UI host confirms New; `ProjectDocument.reset()` clears
the schematic and then the PCB through each view's `clearSection()` hook.
The schematic clear boundary first cancels pending Properties, pointer, drawing,
paste and component-placement work and verifies readiness. Failed cleanup stops
before either model or its history is cleared.
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
Successful Open and Open Recent clean up only the opened file's recovery
snapshot; Import preserves existing recovery entries. Unrelated project backups
are never purged as a side effect of adopting another document.

Browser idle time is not an edit-completion signal. Registered views may report
`isSectionEditing()`; `ProjectDocument.canSerialize()` uses that neutral readiness
contract without inspecting editor fields. Pending PCB and schematic edits block project
snapshots rather than silently saving committed geometry that differs from the
displayed preview. Autosave retains its existing idle scheduling and rechecks readiness
both before scheduling and at idle execution, leaving the pending revision
unsaved until commit/cancel makes it safe. Timer-only browsers use the same guard.
Manual Save/Save As report a snapshot failure through the existing failure UI
without opening or writing a file. Headless serialization remains available.
This readiness policy is independent of the detached per-family preview
ownership described below.

The schematic view includes reversible numeric Properties previews, pointer
edits, pre-threshold splits, drawing, placement and inline text in this readiness
query. Numeric ownership is per editor rather than per DOM root, so replacing
Properties cannot hide an unfinished edit from save or history. Schematic
keyboard and ribbon Undo/Redo share a completion boundary: restore numeric and
pointer previews before advancing history, cancel placement/inline text without
advancing history, and leave in-progress drawing alone. Failed rollback prevents
history traversal. Escape, history and tool switches reuse the same pointer
rollback, including linked-wire snapshots and provisional shape conversions.

`pcb/modules/edit-lifecycle.js` owns cross-family preview cancellation,
property-editor disposal and the PCB snapshot-readiness query. The facade
delegates these decisions rather than maintaining its own adapter-kind list.
Cancellation stops derived workers, settles property previews, then asks the
existing selection state machine to end its active gesture regardless of kind
or mode. Direct pointer paths retain their own cancellation helpers. This also
ends reference-label drags and pending overlap-selection gestures on view exit
or document replacement, without committing or consuming prior undo/redo.
Property-panel rebuilding and document replacement share the same disposal
routine; deactivation retains reusable property controls after cancellation.
Cleanup errors propagate and unresolved editors continue to block snapshots.

`pcb/modules/property-editors.js` owns each editor's Properties-panel bindings
(`text`, `component`, `pad`, `via`, `track`, `boardShape`, `boardDimension`) in
a WeakMap. The module that creates a binding claims its slot with
`setPropertyEditor` and releases it with `releasePropertyEditor`, which cannot
clear a newer owner; others read it with `getPropertyEditor`. Every binding
declares `affectsLayer(layerId)`, so hiding or locking a layer releases editors
through one ordered `eachPropertyEditorOnLayer`. Group commits and activity
checks name the kinds they cover. The module has no imports because the
fabrication-snapshot guard, which the Gerber worker loads, queries it.

`pcb/modules/refresh-state.js` owns each editor's derived-refresh status in a
WeakMap: copper-pour pending, scheduled and last error (written by
`fill-refresh.js`) and the batched picture-copper refresh (written by
`picture-refresh.js`). It also owns the refresh suspensions gestures hold while
previewing: drag-overlay deferral, fill-refresh suspension (paste) and
board-view refresh suspension. Gestures save the current value, set it and
restore the saved value when they finish. Raising overlay deferral or fill
suspension first notifies `onRefreshSuspended` subscribers; `PCBApp.js`
subscribes to invalidate in-flight pour and DRC work on its instances.
`refreshBoardView(app)` is the one place that asks an open 3D/2D board viewer
to resync after a committed edit; callers check `isBoardViewRefreshSuspended`
first where a gesture may hold it. `isEditorActive(app)` in `pcb-editor-api.js`
and `boardDimensions(app)` in `shared/pcb/board-outline.js` likewise give
modules the editor's active flag and board size without reading its private
fields.
Predicates that test several flags read `refreshStatus(app)` once. The module
is import-free because `drc.js` (DRC worker) and the fabrication snapshot
(Gerber worker) read it; detached DRC snapshots pass the editor's pour status
to `collectDrcInputs` explicitly. DRC status itself remains with
`drc-presentation.js` behind the editor's `_drcPending` accessor.

`pcb/modules/pcb-interactions.js` is the one list of in-progress editor fields
(`_drag`, `_trackDraw`, `_pcbSelectionInteraction`, …) in pointer-move priority,
with each field's category (`gesture` or `drawing`) and whether it blocks export.
`hasPcbInteractionInProgress`, `isPcbDrawing` and the fabrication-snapshot guard
derive from it. It has no imports so worker-loaded export code can use it.
`pcb/modules/pcb-interaction-routing.js` holds each field's pointer-move and
pose-cancel handler. Its mousemove dispatcher is deliberately straight-line code
for speed (`node tools/bench-pointer-dispatch.mjs`); `test-pcb-interaction-registry`
proves it follows the table's priority, and fails if a new `_…Drag`, `_…Draw`,
`_…Drop`, `_…Resize`, `_…Edit` or `_…Interaction` field is assigned without
being registered. At most one pointer drag is active at a time; the selection
gesture may wrap one, and drawing sessions persist across other gestures.

The PCB canvas mousedown listener in `PCBApp._bindMouseEvents` handles only
cross-tool concerns (paste drop, floating previews, ribbon tab, inline text
commit, double-click edit, right-button bookkeeping, pan). It then hands a
primary press to the active tool's `_press…Tool` method through
`PCB_TOOL_PRESS_HANDLERS`; `test-pcb-pointer-press` checks that routing.
`_pressSelectTool` is a priority chain of phase methods, each returning whether
it handled the press: the shared selection interaction, Ctrl/Cmd shape toggling,
an active box selection, continuing the current selection, then selecting a new
target. Component presses use `_beginComponentDrag`, the same start as the
selection adapter, so locked placements never enter drag state
(`test-pcb-select-press`).

Image rotation and dimension number controls retain their DOM nodes during
focused native `input`/`change` steps. Commits update the displayed numeric
values in place rather than rebuilding the panel and losing keyboard focus;
no-op/invalid values and paired dimensions use current geometry. Undo/redo and
owner changes retain the normal panel refresh path.
The same commit policy covers shape width, circle diameter, global/node corner
radius and bulge previews. Their focused controls synchronize current values,
mixed-state placeholders and coupled dimensions in place. Structural changes
still rebuild the panel: straightening an arc removes its obsolete Bulge field.

Both editors use `canRoundPathNode` from `shapes/path-geometry.js` to decide
whether Node Properties offers a corner-radius control. Open endpoints,
straight/degenerate joins and nodes adjacent to curved edges do not offer it;
eligible interior and closed-path corners retain the existing numeric editor.
This presentation rule does not change stored radii or rendered geometry.
Deleting either endpoint of a two-node line removes the whole line, clears
refinement/Properties and returns Home. Removing an endpoint from a longer
line retains its surviving geometry and whole-object Properties.

An image Properties refresh supplies its canonical target identity. Rebuilding
controls for that same image does not cancel its pointer rotation; changing to
another target (even one with the same ID), clearing the panel or replacing the
document still ends the old gesture. Numeric-preview acceptance on rotation
pickup remains owned by the image adapter. Drawing-mode completion remains
with its existing callers; this is not a new
general-purpose interaction framework.

`pcb/modules/editor-actions.js` is the common keyboard/ribbon entry point for
Undo, Redo, Save and Save As. Keyboard focus guards and shortcut matching stay
in the editor; DOM bindings only dispatch actions. History requests use the
existing keyboard policy: floating paste, dimension previews and group drags
consume the request by cancelling, while unfinished track/fill/shape drawing
does not traverse history. Individual-pointer Undo and image-rotation Redo
retain their existing cleanup semantics before traversing history. Cleanup
errors propagate without advancing the stacks. The handler's boolean reports
request consumption, not whether an undo/redo entry existed.
Save requests resolve `app.project` at invocation, never a global bootstrap.
The project still owns snapshot readiness, I/O and ordinary failure reporting;
the shared action shows the saved toast only after a successful result.

The same action boundary owns staged Escape after drawing-mode keys have been
handled. It cancels an active property preview or pointer gesture before
leaving a tool, clearing selection or returning Home. The lifecycle module's
property-editor catalog supplies preview cancellation for text, pad and via
editors as well as track and shape editors; cancellation retains the controls
and does not commit or traverse history. Existing shape/track priority and
outline-resize-before-dimension-property ordering are preserved. Keyboard
focus guards still leave native input handling alone. This is deliberately
different from full view-exit cleanup: one Escape unwinds one level, and the
first Escape during drawing still cancels only the drawing, retaining its tool.
Track teardown preserves that tool's crosshair position and visibility without
waiting for another mousemove. Leaving drawing mode (including a second Escape)
still hides it; cancellation does not reveal a crosshair already hidden outside
the canvas.

Arrow-key nudging also dispatches through the action boundary. It reuses the
lifecycle's pointer/inline-interaction guard instead of maintaining another
gesture list in the keyboard handler. Snapshot readiness remains a broader
query that additionally includes property previews and deferred derived work.
The existing group-move path still commits pending numeric-property edits
before movement, records the nudge separately in history and refreshes
Properties after completion. Step sizes remain one quarter of the configured
grid with snapping enabled, or 1 mm with snapping disabled. Drawing, marquee,
pan, hidden/locked selections and reference-label selections retain their
existing guards; input-focus and DRC-list navigation stay with the keyboard UI.

Delete/Backspace also delegates to `editor-actions.js`. The action preserves
paste cancellation, group-preview rollback and property-cancellation ordering
before choosing focused shape/fill/track deletion or whole-selection removal.
Blocked refined edits do not fall through to deleting the whole object.
Component/reference warnings retain the original target after selection
cleanup; components remain schematic-owned. Native field guards stay in the
keyboard handler. Cut and object-specific context menus keep their distinct
whole-object/targeted semantics rather than adopting keyboard refinement.

`pcb/modules/tool-lifecycle.js` owns the tool catalog, tool selection,
drawing-mode cancellation and pre-navigation policy. Controls retain icons,
button highlighting and Shapes-menu memory; the ribbon retains panel switching,
height measurement and DRC visibility. Both call the lifecycle boundary before
adopting a new mode. Escape and cancellation share a single return-to-Select
routine, including cursor, Home highlighting, status and tool-options cleanup.
Reselecting the same tool preserves its drawing. An explicit change of ribbon
tab cancels drawing/inline text; same-tab requests do not. Programmatic
navigation retains track/fill sessions when their Properties UI opens, while
preserving the existing shape-draw cancellation on an actual tab change.
Cleanup failures propagate before adopting the destination tool or tab.
This boundary does not change per-tool Enter/Escape completion or property
commit behavior, and does not make all interactions follow one cancellation
policy.

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

Autorouting retains existing authored copper while its worker produces a preview.
The pending session blocks project snapshots and owns its worker, model, layout,
netlist, routing rules and command-history baseline. Edits, document replacement,
schematic changes, deactivation and disposal invalidate that ownership; stale
progress, errors and results cannot affect a successor session. User Stop remains
distinct: a current worker may return a partial result. Successful routing and
SES imports use `ReplaceRoutesCommand`, an atomic, dirtying replacement with exact
undo/redo; Clear Routes uses the same command. Worker failures preserve the previous
copper and history. The editor adapter rebuilds selection, copper presentation,
ratlines, fills and DRC after command replay.
The temporary active-connection guide uses the normal ratline color, width and
opacity, with rounded 4px dashes and 3px gaps distinguishing it from real ratlines.
It promotes exactly one actual node-based ratline from the active copper,
retaining that edge's exact endpoints; it does not independently target curve
interiors or hide the other edges attached to the source. After every graph
rebuild, the solid lines plus the dashed replacement still represent every
connection exactly once. The dashed edge remains visible with Ratlines disabled.
Track drawing supplies detached preview tracks/vias to the same connectivity
calculation, restricted to the affected nets, without authoring model entities.
Unchanged previews reuse that input. Cancel/commit removes the provisional input
and restores the normal graph. DRC's existing pending-edit guard prevents checking
an unfinished gesture; guide styling itself never removes neutral ratline records.

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

`pcb/modules/autorouter-session.js` owns the routing session, worker, cancellation
polling, result-adoption guard and disposal. It receives explicit capabilities
for board-state capture, route-input capture, router mode, command adoption,
ratsnest reconciliation and status/error reporting, not the editor object.
`pcb/modules/autorouter-presentation.js` owns progress controls, phase delays,
temporary routing artwork, fade frames and ratline visibility, using injected
DOM/layer/rule capabilities and schedulers. `PCBApp` supplies those adapters and
retains the canonical model/command boundary; it no longer owns the worker or
presentation timers. Independent owner tests exercise cancellation, supersession
and cleanup without constructing an editor.

Shared `Shape.getBounds()` caches geometry independently of the SVG `_dirty`
flag. Repeated headless queries reuse bounds until `invalidate()` clears them;
reading bounds does not acknowledge a pending render. Arc control-point setters
invalidate both arc geometry and bounds. Track node/segment/whole drags,
attached-via/pad movement and group translation invalidate their displayed
copies before presentation, without invalidating canonical bounds during preview.
Accepted model commands invalidate the authored entity's bounds.

`SelectionManager` skips an entry whose bounds cannot contain the pointer before
calling `hitTest()`. An entry whose `hitTest()` reaches beyond its visual bounds
supplies `getHitBounds()`; `getBounds()` stays visual for box selection and group
bounds. Selected PCB lines, rectangles, polygons and copper fills use it because
their unrounded edges and nodes stay hittable outside large corner radii
(`boundsWithPathNodes()` in `selection-registry.js`;
`test-board-shape-rounded-node-hit`). `test-pcb-selection-adapter-contract`
enforces the rule for every PCB adapter kind: sampled around awkward geometry
at three zooms, selected and unselected, `hitTest()` may only succeed inside
the bounds `SelectionManager` pre-filters with.

`SelectionManager` is the only writer of entity `selected`/`hovered` flags and
of its own selection, hover and cache fields, so the logical selection and what
is drawn cannot drift apart. Editor code uses its public API: `keepSelected()`
re-asserts a tracked shape after an edit (silently; untracked shapes are
ignored), `dropSelected()`/`dropHover()`/`forget()` release a shape leaving the
document, `clearSelection({ notify: false })` and `notifyChanged()` batch a
change into one notification, and `invalidateHitCache()` discards cached hits.
`test-selection-state-seam` checks the API and fails on any new direct flag
write or private access outside the manager (entity constructors and the PCB
registry's sync are the listed exceptions). `browser-tests/schematic-smoke.mjs`
checks in a real browser that flags and the manager agree through anchor drag
commit/cancel, wire start, delete, undo and redo.

`schematic/modules/schematic-view.js` is the schematic's view lifecycle, the
counterpart of the PCB render modules. It owns `renderShapes()`, viewport
culling and level of detail, refined-segment overlays, and the helpers that
create, attach, redraw, re-pose, detach and discard entity SVG
(`mountShape`, `unmountShape`, `mountComponent`, `refreshComponentPose`,
`withContentDetached`, …). Commands, file loading, clipboard ghosts, theme
changes and inline text editing call these helpers; none of them touch
`element`, `anchorsGroup`, `render()` or the viewport content layers.
Entities still build their own SVG behind this boundary until rendering moves
into renderer modules. `test-schematic-view-boundary` tests the helpers and
fails on new view-lifecycle code elsewhere in the schematic editor.

`syncPcbSelection()` runs on every hover and click query, so it reuses one
adapter per model object (adapters read live state lazily). It rebuilds the
entry list and selection flags only when the set of entities changes;
otherwise it just resets the hit caches. Pad bounds and copper-fill outlines
are memoised on their geometry fields, because the bounds pre-filter reads them
for every entity on every query. `test-pcb-selection-sync-reuse` guards the
work counts and correctness; `node tools/bench-pcb-hit-test.mjs` times a
1,110-entity board (pointer query 8.4 ms → 0.8 ms when introduced).
Hiding a layer deselects only the entries whose adapter now reports
`visible === false` (`deselectHiddenPcbSelection()` in `box-select.js`); objects
on other layers, and pours that stay visible, remain selected and the
Properties panel follows what is left (`test-pcb-selection-layer-locks`).
Bounds remain entity-owned derived data, not authored state.
Schematic `Text` remains a measured-layout exception: drawing clears its bounds
so the next query uses the updated SVG font metrics rather than an earlier
headless estimate or stale text measurement.

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
This helper isolates command preparation independently of pointer previews.

Single-fill pointer gestures now keep the canonical target and a lazy reusable
`CopperFill` copy in `_fillDrag`. Move, segment, vertex, bulge, center and radius
updates change only that copy; midpoint insertion creates it immediately to
stage topology. The selection adapter dynamically resolves displayed identity,
bounds, hits, anchors and paths. `boardShapes` and the computed-pour weak map
remain canonical, and the existing overlay deferral suppresses fill rerenders.
Completion clears gesture ownership before the existing `ModifyFillCommand`;
cancellation, no-op, invalid edits and command rejection restore canonical
artwork without authored rollback. Missing targets remove orphan preview SVG.
Shared lifecycle cancellation handles fill adapters and orphaned `_fillDrag`
state on deactivation/load. Grouped fills use the shared mixed-group projection
described below.

Live computed pour polygons belong to `pcb/modules/computed-fill-cache.js`,
an identity-keyed weak map outside authored `CopperFill` entities. SVG, flat 2D,
3D, DRC, routing contacts, net propagation and ratsnest consumers read the same
results. Null means no completed result; an empty array means a successfully
computed empty pour. Previews and outstanding refreshes retain the previous
complete result. Failed computations retain settled artwork, leave refresh debt
pending and report the error rather than displaying an empty or partial pour.
Clones and loaded replacements do not inherit results, even with equal IDs.
Detached fabrication snapshots intentionally retain their own `_computed`
transfer field and recompute from captured authored geometry rather than using
the live preview cache. This does not remove the remaining inherited shape
presentation methods or other entity-level derived caches.

Scheduled live pours use `pcb/modules/fill-worker-client.js` and the module
worker `fill-worker.js`. `fill-worker-geometry.js` captures detached,
full-precision model inputs; image artwork is represented by its physical frame,
matching the existing pour engine. The service allows one active job and one
replaceable pending job. Generations, document/fill identities and lifecycle
cancellation reject stale results; preview deferral retains settled holes.
`fill-refresh.js` stages complete SVG results off-DOM before handing them over.
Direct command recomputation remains synchronous; missing Worker support and
reported transport failures use the synchronous fallback. Deactivation/load
cancel live work, while terminal disposal prevents restarting the service.
Snapshot capture, rendering and derived connectivity still run on the main
thread; offloading clipping alone is not an end-to-end latency guarantee.
The worker also transfers full-precision region/triangle bounds and earcut
indices. Validated preparations attach only to the exact successfully adopted
region identities; mutable authored shapes retain value validation, and
unprepared synchronous regions retain lazy triangulation. DRC reports pending
or failed refreshes even when settled display geometry is retained, rather than
treating that older cache as a current successful pour.
Shared spatial pair sweeps compact expired entries in their existing active
arrays instead of allocating filtered arrays for every item. Stable pair order,
one bounds lookup per input and inclusive clearance/tolerance comparisons are
preserved for both single-set and cross-set consumers.

Ratsnest and bonded-Net traversal prepare contact geometry once per synchronous
pass and share it between spatial filtering and exact contact tests. Resolved
track segments use pass-local contact descriptors without authored-shape cache
snapshots. Mutable board shapes still use value-validated cached geometry.
Physical pad/via contacts also reuse detached contours and lazy triangulation
across passes after exact posed-outline, position, radius, drill and slot
comparisons. The app-owned weak cache retains only the latest completed pass,
rejects reuse across document identities and drops absent terminals. Net and
layer membership are rebuilt separately; matching terminal IDs alone never
establish geometry validity.
Validated worker regions and internally owned terminal regions additionally
retain weakly cached spatial ordering for their immutable triangle contacts.
Prepared cross-sweeps merge these orders without repeatedly boxing or sorting
the same triangles, while sharing the generic sweep's expiry/overlap logic.
Reinstalling prepared geometry invalidates its ordering; arbitrary mutable
contacts still use the ordinary lazy-capture sweep.
Region/region checks conservatively filter ordered triangles against the other
contact's bounds before sweeping. Fully contained orders bypass filtering;
candidate arrays contain existing records, and no persistent candidate cache or
additional worker payload is introduced.

Each DRC distance checker owns one immutable physical snapshot. It caches hole
bounds to reject unrelated contours and prepared boundary-edge ordering to avoid
Cartesian edge scans. Candidate queries conservatively include outlying bore
edges; equal-distance markers retain the original edge-pair order even though
the sweep visits candidates spatially. Short connectivity is skipped only when
fewer than two named nets exist; clearance, unassigned copper, ring validity and
unrouted checks still run.

Scheduled live DRC uses `drc-refresh.js` and a module worker. The
`drc-worker-inputs.js` capture supplies detached, full-precision physical geometry
and neutral ratline data; the worker imports no editor, storage or network code.
Ratsnest rendering publishes that neutral data instead of making DRC recover
connectivity from SVG attributes. One active and one replaceable pending request
bound queued work. Revision, document/collection, pour-cache and ratline ownership
checks reject obsolete results; previews and unsettled pours defer adoption.
The UI explicitly shows checking or failure while retaining settled results and
selection. Replacement/deactivation cancel work; terminal disposal prevents
restart. Direct checks, missing Worker support and reported worker failures use
the same synchronous calculation. Failed capture/calculation does not replace
previous results with an empty successful report. Capture, transfer and result
rendering remain main-thread work, so offloading is not a zero-latency guarantee.

`pcb/modules/drc-presentation.js` owns the DRC panel, grouped list, selected
violation identity, collapsed groups, pending/error display and viewport markers.
It also owns Design-tab activity, DOM listeners and suspension/disposal. Its
capabilities request refreshes, resolve the selected copper pair, collect neutral
ratlines, clear board selection and access layer groups and the limited viewport
navigation interface.
The owner accepts injected DOM for independent tests and never receives
`PCBApp`. The existing scheduler/checker publishes through thin editor adapters;
it does not own list selection or marker elements. Calculation and worker
generation rules remain in their existing modules.

Selected short/clearance markers also have a lightweight live-preview path.
Their reports carry a serializable pair of stable copper-entity references.
`resolveDrcPairMarker` reads the displayed preview collections, resolves only that
pair's copper (plus applicable copper-removal artwork), and reuses the full DRC
distance checker, layers and clearance tolerance. The marker follows the current
contact or insufficient gap, disappears when the pair clears, and reappears if
the conflict returns. A short's marker also remains while the pair separates but
still violates clearance. Unsettled selected pours have no live marker until
usable geometry is available; the full result remains pending.
`DrcPresentation` coalesces marker checks to one animation frame and keeps the
preview separate from the authoritative results/list/status. Closing, replacing
results, deactivation and disposal cancel queued marker work. Pan/zoom uses the
same preview marker and cannot resurrect a temporarily resolved conflict.
Normal DRC still rechecks the complete board after commit/cancel and pour
settlement. Incomplete-connection markers retain their existing ratline-follow
path; this does not perform whole-board DRC on every pointer event.

Published fill-region identities are preserved, so their triangle contacts and
bounds can be reused rather than rebuilt for every candidate pair or unchanged
connectivity pass. A newly computed region has a new identity; replacing a
shape's region also invalidates its resolved contact. Hole geometry and physical
contact tolerances are unchanged.

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
3D refresh and immediate versus deferred copper updates. Accepted commands and
loading synchronize outline dimensions through `PcbDocument` before rendering.
Pointer, property, group and generic-dimension previews use detached copies;
canonical outline geometry and dimensions remain unchanged until acceptance.
Generic shape rendering, hover, selection and dedicated outline redraw do not
write dimension metadata.

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
The registered schematic view implements `prepareSection()` using the model's
preflight and adopts those prepared entities during loading. Missing component
definitions therefore fail before document adoption, preserving existing
undo/redo instead of reloading an unchanged document through rollback.
EasyEDA import emits native component types and maps part metadata to canonical
`defaultProperties.mpn` and `footprintName`, preserving it through native ZIP
and autosave round trips.

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

Both editors share the viewport's light-mode palette: a white canvas, subtle
gray grid, medium-gray origin axes and pale-gray rulers. The `--bg-ruler` token
separates ruler shading from the rest of the UI; without it, rulers retain the
existing `--bg-primary` background. Dark mode and electrical layer/net colors
are unchanged.

Saved board dimensions live in `PcbDocument.board`. The editor's `_boardWidth`,
`_boardHeight` and `_boardRadius` expose the detached dimension projection during
generic numeric/resize previews and canonical dimensions otherwise. The lazy
projection in `board-outline-resize.js` holds reusable board/outline copies;
rendering and property fields follow it without changing authored dimensions,
outline geometry, serialization or settled-fill caches. Acceptance clears the
projection before the existing board command. Cancellation, panel replacement,
locks/hiding, loading/deactivation, replaced targets and failures clean up
artwork without authored rollback. Repeated values and stationary pickup skip
redraw/projection work. The dimensions dialog remains command-only. Loading
restores legacy dimension-only boards, while an
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
Panel positioning holes use the shared hole geometry and ordinary hole border
style, with even-odd vector cutouts through the support artwork so the actual
grid remains visible in either theme.

Overlap selection includes every eligible component, not just the topmost
footprint. PCB hit queries cache all component hits for the current pointer
query; both editors expose the Shift+click cycling tip. A selected obscured
component remains eligible for drag pickup, including mixed groups, without
bypassing layer visibility, locks or selection-anchor precedence.

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
Headless callers can supply the model and `ProjectDocument.resolvePcbLayout()`
result without constructing an editor.

`core/pcb-placement-geometry.js` owns the detached resolved-placement contract
through `captureResolvedPlacement()`. It preserves the full-precision pose,
physical pad identifiers and positions, local pad/paste/artwork geometry, outline
and reference settings, without traversing SVG elements, hit-test bounds, lock
flags or 3D presentation state. Capture does not normalize poses or introduce
defaults. The fabrication adapter delegates this copying before asynchronous
work, keeping automatic placement positions paired with the caller's resolved
netlist. `ProjectDocument` owns automatic placement resolution as described below;
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
Groups containing directly selected tracks, vias, pads, shapes or fills compose
the mixed-group projection described below. Save/export readiness guards remain
the policy for unfinished edits, even when canonical geometry is unchanged.

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
Blank-content deletion and cancelled new-placement cleanup use the existing
RemoveTextCommand rather than deleting the canonical text map in the editor.
First-click placement still records Add. If Add is the latest command, cleanup
removes the text without adding another history entry, prunes Add and updates
history controls. If commands intervened, cleanup records Remove and preserves
those commands: undo first restores the blank text with its committed styles,
so earlier property commands never target a text deleted outside history.
This conservative rule also applies to unrelated intervening commands.
Failed completion restores canonical artwork and tears down
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

Image rotation handles keep their gesture state in a weak map in
`board-shapes.js`. The first changed angle allocates one shallow image copy
and one `boardShapes` projection; artwork remains shared read-only and only
the copy's points change. Unrelated shapes and fills retain canonical identity.
Selection adapters and rendering resolve displayed geometry, including rebuilt
adapters, bounds, hits, anchors and lock outlines. Completion removes projection
ownership before the existing canonical shape command; cancellation restores
artwork without writing authored points. Missing targets and rejected commands
clean up previews. Panel replacement, deselection, layer locking/hiding,
deactivation/loading and orphan cancellation terminate rotation, while pointer
handoff commits rotation before starting an ordinary shape drag. Save/export
readiness retains the existing rotation guard.

Copper-cut geometry stays on its settled cache during image rotation, including
explicit refresh and viewport updates, so old pour holes remain until drop.
Discarded rotations do not repour unchanged copper.

Ordinary board-shape pointer gestures retain their canonical target in
`_shapeDrag.original` and render a reusable copy through a `boardShapes`
projection. Movement, vertex/segment edits, image resizing and circle/arc
handles allocate on the first movement; midpoint insertion, floating segment
conversion and open/split operations stage topology immediately on copies.
Split remainders remain projected until acceptance, and their IDs are consumed
by the model add command rather than during pickup. Artwork remains shared
read-only. Authored points, indexed metadata, board dimensions and serialization
stay unchanged during previews; bounds, anchors, segment highlights, properties
presentation and ratwires follow displayed geometry.

Completion clears projection ownership before canonical move/modify or compound
commands. Joins and topology changes retain precise undo/redo. Cancellation,
invalid outlines, stationary pickup, locks/hiding, loading/deactivation, missing
targets and rejected commands discard artwork rather than restoring authored
geometry. Discard does not repour unchanged copper; committed clearance refreshes
receive canonical objects instead of stale preview copies. Repeated identical
pointer/modifier states skip SVG work, while grid/scale/Shift changes are
reevaluated. Stationary pickup does not allocate the projected collection.
Numeric board-shape properties use a disposable panel binding with one active
field preview. Widths, segment widths/bulges, node/default corner radii, circle
diameters and image dimensions/rotation mutate reusable copies exposed through
a weak-map collection projection. First-change snapshots preserve full authored
precision, and immutable image artwork remains shared. Repeated values skip SVG
work. Switching fields commits the previous field before capturing the next
baseline; pointer/group pickup also finishes numeric edits before reading
canonical targets. Numeric pickup can accept a pointer edit without overwriting
the in-progress input text.

Numeric completion removes the projection before canonical single/compound
commands. Discrete image/shape attributes and shape-specific outline commands
also prepare detached candidates instead of mutating/rolling back authored state.
Escape, blur/change ordering, disposed controls, no-op redo preservation,
selection/panel/layer/lifecycle cleanup and missing/rejected commands are covered.
Copper pours and cuts retain settled geometry until acceptance; cancellation
restores canonical clearance immediately and preserves refreshes owed by earlier
commits. Non-copper images do not rebuild unrelated copper clipping. Save/export
readiness includes active shape properties.

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
component deletion/reordering; New/load/reset clear the allocation cache in place.
Resolved automatic positions are saved alongside explicit overrides, without
mutating live overrides or marking layout queries dirty. Reload adopts them as
stable canonical placement baselines, so deleting an earlier component cannot
shift remaining pads away from saved track endpoints. Failed resolution does
not retain partially allocated slots.

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
the explicit synchronization operation first. Fabrication retains the caller's
paired resolved placements/netlist rather than independently replacing one of
those inputs. Application capture rejects unfinished previews before combining
them with committed model geometry.

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
Executed placement commands retain resolved footprint geometry for later replay
if their schematic component is deleted. Undo/redo can restore placement metadata
and bonded geometry without resurrecting that component or blocking earlier PCB
history. Never-executed commands still reject missing targets.

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
drops and cancellation preserve redo history. Other entity families compose
the mixed-group projection described below; save/export readiness guards
continue to reject unfinished edits.

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
Via movement resolves snapped track targets to canonical identities while its
preview mapping is still available. Repeated pointer updates over an attached
track node therefore retain the same valid command target when the preview ends.
Panel replacement, Escape, deactivation, loading, locks and visibility changes
clean up previews and queued frames, and save/export readiness includes them.

Direct track numeric properties now have a single-track projection in
`track-commands.js`: whole-track/selected-edge width, whole-track/node corner
radius and the existing arc bulge field. The first changed value captures exact
graph state and creates one track copy/collection; subsequent values reuse both,
including graph-map identity. Canonical geometry, metadata, serialization and
bounds caches remain untouched. The track collection getter prefers component
and terminal-movement previews before numeric properties. Selection adapters
retain canonical identity while resolving displayed bounds, hits, lock outlines,
anchors and hover geometry. Repeated values skip SVG and derived refresh work;
changed values render immediately without the old delayed width-import callback.
Existing width/radius/bulge normalization and derived refresh policies remain.

The disposable track panel binding clears the projection before the existing
graph command, using first-change rather than panel-open snapshots. Exact
attribute fallbacks survive a return to the original value without consuming
redo. Numeric-to-net/layer, node/midpoint/split/arc pickup and terminal pickup
finish pending properties before using canonical targets. Cancellation,
replaced panels, deactivation, loading, relevant layer locks/visibility, missing
targets and command rejection remove preview artwork without authored rollback.
Save/export readiness includes active track properties. Shared pose cancellation also
dispatches fill adapters and orphaned fill drags through `endFillEdit(false)`;
it does not replace the canonical fill collection or pour cache.

Direct track pointer gestures use `_vertexDrag` to retain the canonical target
and a reusable graph copy/collection projection. Whole-track, segment, node and
bulge movement allocate on the first changed geometry; midpoint and split
gestures copy immediately to stage topology. Pinned-via bridge nodes belong to
the copy. Selection and hover resolve displayed geometry, while commands target
the canonical graph after projection removal. Authored graph maps, metadata,
pad attachments, bounds caches and serialization remain unchanged during edits.
Snapping and connection resolution use the projected graph; merge, layer
transition, net propagation and split commands preserve exact undo/redo.

Track selection adapters expose the unrounded edge graph through the shared
one-screen-pixel editing guide used by board Lines. Guides follow the displayed
preview during node/segment dragging, including focused-node drags, without
changing copper geometry or corner radii. Authored arc edges remain arcs;
branches and disconnected edges stay separate and hidden-layer edges are
excluded. Idle node focus hides the whole-path guide, matching Line selection.

On drop, transient crosshair, axis/snap and nearest-net guides are cleared before
connection validation and history execution. Final cleanup repeats this safely
for cancellation/errors; commit ordering and repaint scheduling are unchanged.
Node-drop validation reuses the seed-reachable physical-contact traversal from
`collectBondedCopper`: cheap node/coincidence joins establish seed groups, then
exact stationary terminal/artwork contacts are tested only as those groups are
reached. Transitive contacts, layer bridges, net conflicts and foreign-pour
rules remain intact; unrelated artwork groups do not block the drop's repaint.

Repeated resolved pointer positions skip SVG and derived work. Translation
constraints and starting points are reused within each gesture. Cancel, no-op,
locked/hidden layers, deactivation/loading, missing targets and command failures
clean up artwork without authored rollback, restoring outer overlay/3D deferral
state. Discarded previews do not repour unchanged copper. Property/terminal
handoffs finish pending edits before canonical pickup; save/export guards remain.
Mixed-object group movement in `box-select.js` now reuses detached copies of
directly selected tracks, vias, pads, board shapes and fills alongside the
existing component/text projections. `PCBApp` collection getters give the group
projection precedence. Group-specific selection-registry forwarding resolves
displayed bounds, paths, hits and anchors without retargeting gesture methods
away from canonical objects. Selected tracks also attached to a moving component
are rendered once, not by both preview paths.

Group completion preflights stored originals and clears projections before the
existing compound commands. Cancellation, missing/deleted targets, rejected
commands, locks/hiding and lifecycle cleanup remove preview artwork without
canonical rollback. Board dimensions and fill caches stay authored; settled
copper-removal holes remain through the gesture. Repeated unchanged deltas do
no additional measured SVG/derived/3D work.

Floating PCB paste is owned by `pcb/modules/pcb-paste.js`. Fresh tracks, vias,
pads, shapes, fills and text remain detached until placement acceptance; source
geometry, component pads, attached source tracks, settled copper caches and
canonical serialization do not follow the cursor. Acceptance inserts the bundle
with one atomic history entry, while cancellation preserves prior history and
redo. Shape IDs are consumed only on acceptance. Repeated unchanged positions
skip rendering, crosshair updates and graph-cache invalidation. Lifecycle,
lock/visibility, keyboard/history and failure cleanup discard the floating
bundle rather than undoing previously authored content.

Imported images use the same placement path. Their properties open after the
placement is accepted, not while the image is floating; selection and anchors
remain visible during placement. Schematic paste and shared clipboard contents
retain their existing semantics.

Mixed-selection attribute preparation in `PCBApp._pcbMultiPropertyCapabilities`
uses detached shape/image/fill candidates and track-width snapshots rather than
mutating canonical objects and restoring them. Mutation callbacks receive the
candidate, while the resulting commands retain canonical targets. Image bounds
are measured on the candidate, immutable artwork remains shared read-only, and
unchanged dimensions/rotation skip transforms to avoid precision drift.
Failed preparation leaves canonical geometry, nested references and fill caches
untouched; accepted batches retain their existing compound history behavior.

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
`shared/pcb/board-geometry.js`; editor wrappers retain SVG updates and redraw
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
parser remains in `shared/pcb/footprint.js` alongside its rendering exports.
All four physical placement commands use this source. Entity/render and derived
cache coupling, live-preview mutation ownership and the
explicit viewport-preference boundary still need closure review; physical command
separation does not imply that all model boundaries or application decomposition
are complete.

The live `placements` map remains editor-owned: it contains generated footprint
geometry, presentation caches and temporary gesture state, not a second
authoritative saved-placement store. Model-owned `PcbPlacementState` retains the
derived automatic layout slots separately from saved overrides. PCB presentation
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

Both editors use `shared/ui/ribbon-height.js` to retain the tallest static
ribbon panel. A cached container width and retained style avoid cycling every
tab through forced layout on each activation or tab change. Width changes and
font completion trigger fresh measurements; hidden ribbons retain their last
valid height until shown, and resize requests share one animation-frame callback.
Schematic reactivation also rechecks the cache after resizing while hidden.
Panel classes and height are restored if measurement fails. Existing flex layout,
inactive-panel hiding and maximum-height behavior are unchanged.

Schematic startup immediately starts KiCad index loading in the background,
without awaiting the download, to minimize the wait on first picker use.
Opening the Online picker or starting a search joins the shared in-flight load,
uses its warmed result, or retries a failed load. Switching an open picker from
Local to Online retains that behavior; Local mode does not add a separate request.
The fetcher owns cache hydration and stale-cache refresh as well as shared work.
Progress belongs to the current visible empty-query picker, and searches retain
their generation guard. Exhausting every index ref rejects explicitly without
publishing incomplete data or replacing a usable cached index. First-search
initialization errors use the normal search error/finally path rather than
leaving the loading state active indefinitely.

The component picker header has an accessible 36-by-36-pixel close button with
a 24-pixel X and shared dialog-close hover/focus styling. Button, Escape and programmatic/toggle closure share
cleanup and emit `component:pickerClosed` once per open-to-closed transition.
The existing tool owner returns Component mode to Select and cancels placement;
closing during a switch to another tool does not override that new tool.
Choosing Place Component does not dismiss the picker or switch back to Select.
Returning to Select with no selection also activates Home, so cancelling a
drawing tool with Escape does not leave an empty Properties tab. Existing
selection properties remain visible when switching to Select with a selection.

The Design ribbon and New Track/Via property editors share the same commit path.
Valid edits mark the PCB dirty and retain the existing geometry refresh requests;
unit/router preferences are also saved project edits. Temporarily blank or invalid
dimensions retain the last valid model value and show native field validation.
Project preparation rejects nonpositive/nonfinite dimensions before replacing
live content. These numeric fields opt out of shared two-decimal formatting.
Project serialization still rounds dimensions to four decimals at the file
boundary. Local defaults now store canonical mm values and still read the legacy
display-unit strings under the existing storage key.

Editor command adapters coordinate model commands with rendering and derived
refreshes; some entity types retain inherited presentation methods and caches.
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
[review-fixes.md](release-readiness.md).

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
  rounding use quadratic corners. `shared/pcb/board-geometry.js` re-exports
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
  Vertex deletion completes collinear cleanup in the same path mutation before
  either editor captures its after-state. Redundant equal-width straight nodes
  disappear in the deletion's single undo step; width/curvature boundaries and
  surviving node/edge metadata retain the existing cleanup rules.
  Numeric Bulge straightening in both editors also runs this cleanup at commit,
  not while previewing or passing through zero. Cleanup shares the curvature
  edit's history step and discards obsolete segment refinement; surviving
  schematic edge IDs retain refinement, while merged PCB indices are cleared.
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
- `pcb/modules/path-edit.js` snaps PCB path edits. Track node, segment and
  bulge drags lock onto Pads (`pads` flag); board shapes (including holes) and
  copper-fill outlines use only grid, axis and collinear magnets, so moving one
  across a Pad array never jumps between Pads (`test-board-shape-pad-snap`).
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
  The same module now owns the small shared Properties lifecycle used by
  schematic descriptor-driven numeric controls and PCB shape/image controls:
  one active field, commit-before-handoff, cancellation/disposal, focused
  commit policy, Escape consumption and deferred blur completion. PCB's
  binding supplies pointer/rotation handoff and layer checks; its detached
  copies and schematic's reversible live snapshots remain separate adapters.
  Schematic ownership survives a panel rebuild or root replacement so an already-pending blur can
  finish against its original target without rebuilding the newer panel.
  Starting another numeric field settles that previous edit first, preventing
  overlapping whole-shape snapshots from combining independent field edits.
  Numeric inputs register their completion policy with the shared owner, so
  handoff, action preparation and owner-driven commits validate the current
  field text just like change/blur. An empty or incomplete number cancels its
  pending preview rather than committing the last valid intermediate value.
  Completion preserves the caller's no-rebuild request and cannot disturb a
  newer field; geometry finalization still forces structural rebuilds.
  Specialized track, via, pad, text and board-dimension editors also validate
  their active field inside owner-driven completion, including pointer pickup
  and cross-field handoff. Invalid final text cancels the preceding preview
  without consuming history; deferred callbacks cannot finish a newer field.
  Their electrical constraints and preview representations remain local.
  PCB reference styles retain a registered property binding: pending edits
  block snapshots, cancellation restores only reference-style fields, and
  disposed controls cannot author late changes.
  `pcb/modules/component-properties.js` owns component/reference panel identity,
  Transform controls, the reference binding and teardown. Its explicit
  capabilities expose placement/selection/activity reads, panel access, the
  shared binding service, named domain commands and reference rendering, not the
  editor object. `edit-lifecycle.js` reaches the binding through that owner;
  `PCBApp` retains only the presentation adapters and forwarding entry points.
  Independent owner tests cover retired controls and cleanup, while existing
  reference-history tests retain exact rollback and command-replay coverage.
  Schematic discrete property application also prepares this owner before
  reading selection and recording its command, matching PCB Properties actions.
  Checkbox, text and dropdown changes therefore cannot enter a pending numeric
  snapshot: a valid numeric edit has its own preceding undo step, while an
  invalid numeric edit is cancelled before the discrete change.
  Geometry normalization runs before the command after-state is captured.
  PCB curvature finalization belongs to the preview transaction, not only its
  input's change handler: field handoff, action preparation and direct binding
  commits normalize straight arcs and collinear nodes before outline validation
  and history capture. Structural completion rebuilds even when an ordinary
  value-only handoff requested no rebuild, retiring the obsolete controls.
  Cancellation never runs geometry finalization.
  This is not a universal form framework or a merger of electrical models:
  validation, metadata, structural panel changes and rendering stay local.
  Schematic shape properties include precise bulge and circle diameter edits,
  including multi-selection. Geometry snapshots preserve coupled dimensions
  and overrides. Whole-shape width/radius edits clear their segment/node
  overrides; undo restores them. A zero-bulge standalone arc is replaced by a
  line in the same history operation as the property change.
  Schematic numeric Properties commits retain focused controls instead of
  rebuilding the panel and handing subsequent arrow keys to canvas nudging.
  Current values, mixed placeholders, coupled dimensions and corner-action
  availability refresh in place. The shared focus policy preserves any focused
  control within the editor's Properties container, including a newly focused
  field that has not received input yet. Commits after leaving that container,
  selection changes and structural edits (such as removing Bulge after
  straightening) still rebuild.
  This covers shape/segment/node geometry, text size and reference rotation.
  Numeric input/change/Escape callbacks verify both the displayed control
  identity and current selection. Retired fields cannot restart edits after
  cancellation, a completed commit or panel replacement, or interfere with a
  newer preview. An already-pending blur still finishes against its original
  targets; the guard does not change that completion contract.
  Schematic panel instances have a current-render identity separate from
  numeric transaction ownership. Rebuilding or replacing the panel retires
  its checkbox/text/dropdown callbacks, clipboard/delete/transform actions and
  drawing defaults, even when the same objects remain selected. Pending
  numeric completion retains its existing lifetime. PCB shape controls check
  binding disposal before discrete callbacks can update controls or rebuild
  the panel, not merely before they mutate the model.
- Schematic focused Delete and shape context menus share node/segment deletion
  actions; without refinement, Delete still removes the entire selection.
  Shape removal/replacement finishes selection and refinement cleanup after
  its command, then publishes one final selection notification even when the
  command already removed the selected IDs. Properties and other selection
  subscribers update together, without a second local Properties rebuild.
  The final scene redraw removes the independent segment-selection SVG
  immediately. In-place wire edits retain their selection; split wires publish
  the surviving selection after the whole batch completes.
  Retained-shape node deletion and split cancellation use the same final
  refinement notification, restoring whole-shape Properties and the selection
  tip together. Conversions establish their final refinement and interaction
  state before notifying selection subscribers. Replacement selection,
  in-place conversion and corner decomposition each rebuild Properties through
  that notification, without a second direct panel refresh; floating curvature
  edits retain their existing gesture and history ownership.
  Standalone arc menus support conversion and deletion. Shape splits retain
  one pre-split snapshot and an optional temporary remainder; placement commits
  one batch and Escape restores the original without leaving a remainder.
- Shared shape editing follows PCB behavior where the editors differed:
  repeated segment clicks retain refinement, rounded corners keep the base
  width during segment-width edits, circle radius denotes the outer edge,
  and Shift suppresses shape snapping. Electrical wire/track connectivity,
  layer restrictions, rendering chrome, history, and fabrication contours
  remain editor-specific. Shared geometry must not import either editor.
- `core/id-allocator.js` generates page-wide prefixed IDs (`shape_N`, `via_N`,
  `pad_N`, `fill_N`, `comp_N`): each kind owns one `IdAllocator`, constructors
  observe explicit IDs, and new IDs are one above the highest observed, so IDs
  stay unique across load, New and paste (`test-id-allocation`). Board shapes
  (`pshape_N`) use `PcbDocument.shapeIdCounter` instead.
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
`node tools/regression.mjs` also checks import boundaries and runs the autorouter
baseline. `node tools/typecheck.mjs` summarises `checkJs` errors; CI installs a
pinned TypeScript for it because none is vendored. See
[review-fixes.md](archive/review-fixes.md) for the review mapping and verification limits.

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
at 0°/90° and VRML units. Footprints imported before this fix were mirrored
and need re-importing.

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
frozen, so consumers must copy before changing them. This took a pointer hit
test on a 29-shape board from about 16 ms to 0.2 ms
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
Properties panel (markup, input bindings and committing edits through
previews and commands). Neither re-exports geometry functions. All geometry
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

### Tracks and Vias

- `PCBApp.tracks` — array of `Track` polyline-graphs. A Track may change
  layer mid-run via per-edge `edgeLayers`.
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
  New shape tools retain an unlocked valid active layer, otherwise select the
  first valid unlocked entry in layer order. If none is available, the dropdown
  and status show **No unlocked layers** and no new shape preview can begin.
  Lock changes refresh an idle drawing tool's default and layer-dependent
  controls; unlocking a valid layer makes drawing available immediately.
  Existing shape assignments and in-progress drawing layers are not automatically
  reassigned by this default-selection policy.
- Render (`track-render.js`) and Gerber/Excellon output (`gerber.js`)
  read vias exclusively from `PCBApp.vias`.

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
  trackWidth, clearance, viaDiameter,
  gridStep,
  bounds,
}
```

`RouteResult`:

```js
{
  tracks: [{ net, layer: 'top'|'bottom', points: [{x,y}], vias?: [{x,y}] }],
  vias: [{ x, y, net? }],
  failed: [...],
  failedConnectionCount,
  totalConnectionCount,
}
```

### Design-Rule Single Source of Truth

`clearance`, `trackWidth`, `viaDiameter` are **never** hardcoded in
the router or DSN code. They flow from `#pcbClearance`,
`#pcbTrackWidth`, `#pcbViaDiameter` HTML inputs through
`PCBApp.getRoutingParams()`. `routeAll`, `routeAllPathfinder`,
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
