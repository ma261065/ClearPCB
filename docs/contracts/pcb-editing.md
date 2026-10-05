# PCB Editing: Lifecycle, Actions and Previews

Part of the [module contracts](../module-contracts.md). How PCB edits start,
preview, commit and cancel: the edit lifecycle, property-editor ownership,
derived-refresh state, keyboard/ribbon actions, selection, and the detached
preview projections used by pointer and Properties edits.

## Edit Lifecycle and Editor State

`pcb/modules/edit-lifecycle.js` owns cross-family preview cancellation,
property-editor disposal and the PCB snapshot-readiness query. The facade
delegates these decisions rather than maintaining its own adapter-kind list.
Cancellation stops derived workers, cancels property previews, then asks the
selection interaction and pointer-gesture router to end active gestures in their
own order. Direct pointer paths keep their own cancellation helpers. View exit
and document replacement therefore also end reference-label drags and pending
overlap-selection gestures without committing or consuming undo/redo. Property
panel rebuilding and document replacement share the same disposal routine;
deactivation retains reusable property controls after cancellation. Cleanup
errors propagate, and unresolved editors continue to block snapshots.

`pcb/modules/property-editors.js` owns each editor's Properties-panel bindings
(`text`, `component`, `pad`, `via`, `track`, `boardShape`, `boardDimension`) in
a WeakMap. The module that creates a binding claims its slot with
`setPropertyEditor` and releases it with `releasePropertyEditor`, which cannot
clear a newer owner; others read it with `getPropertyEditor`. Panel bindings
declare `affectsLayer(layerId)`, so hiding or locking a layer releases affected
panel editors through one ordered `eachPropertyEditorOnLayer`. The board-size
binding has no `affectsLayer`; `layer-changes.js` disposes it when the
board-outline layer is hidden and cancels it when that layer is locked. Group
commits and activity checks name the kinds they cover. The
module has no imports because the fabrication-snapshot guard, which the Gerber
worker loads, queries it.

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
`pcb/modules/pcb-interaction-routing.js` holds each field's pointer-move,
primary-release and pose-cancel handler. Its mousemove dispatcher is straight
line for speed (`node tools/bench-pointer-dispatch.mjs`);
`test-pcb-interaction-registry` proves it follows the table's priority, and
fails if a new `_…Drag`, `_…Draw`, `_…Drop`, `_…Resize`, `_…Edit` or
`_…Interaction` field is assigned without being registered. At most one pointer
drag is active at a time; the selection gesture may wrap one, inline/rotation
gestures are export-blocking, and drawing sessions persist across other
gestures. `releasePcbPointerGestures` finishes active gestures in table order on
a primary release anywhere in the window; once the selection gesture finishes,
the drags it can wrap (`wrapped`) are left to it, and a pending marquee finishes
last.

The PCB canvas mouse listeners are in `pcb/modules/mouse.js` (`bindPcbMouseEvents`,
bound through `PCBApp._bindMouseEvents`). The mousedown listener handles only
cross-tool concerns (paste drop, floating previews, ribbon tab, inline text
commit, double-click edit, right-button bookkeeping, pan). It then hands a
primary press to the active tool's `_press…Tool` method through
`PCB_TOOL_PRESS_HANDLERS`; `test-pcb-pointer-press` checks that routing and the
release paths.
`_pressSelectTool` is a priority chain of phase methods, each returning whether
it handled the press: the shared selection interaction, Ctrl/Cmd shape toggling,
an active box selection, continuing the current selection, then selecting a new
target. Component presses use `_beginComponentDrag`, the same start as the
selection adapter, so locked placements never enter drag state
(`test-pcb-select-press`).

Layer visibility and lock changes are handled in `pcb/modules/layer-changes.js`,
called through the editor's thin `_on…Changed` seams. The module cancels
gestures and property editors stranded by the change, updates render-group
visibility or opacity, prunes hidden selections and hover state, keeps the
clearance overlay aligned with visible copper layers, refreshes the Properties
panel when a selected object lives on the changed layer, and saves the
layer-panel preferences.

### Object Locks

Every PCB object also has its own lock, saved as `lk`: tracks, vias, standalone
pads, board shapes, pours and free text use their `locked` flag; components and
their reference text share the placement lock. `pcb/modules/object-locks.js` owns
the rule. `pcbLockState(app, kind, object)` reports the object lock and the layer
locks holding the object (a track only when none of its edges is on an unlocked,
visible layer; a pour also by its copper-fill lock), and `isPcbObjectLocked`
combines them. Adapters' `locked` getters, group moves, delete and Cut, hit
testing for legacy track/via presses and track joins, property-editor `editable`
checks, the board-shape and text edit paths, and copper-region rebuilds after a
track layer change all use these predicates, so a locked object can be selected
but not moved, edited or deleted. Pasted copies start unlocked.

Select All and the marquee take individually locked objects but skip objects on
a locked layer (`isPcbObjectLayerLocked`), so a whole selection that was locked
from Properties can be unlocked the same way. Bulk actions then work on the
unlocked members only: group drags and arrow nudges leave locked members in
place, delete skips them, Cut copies only what it removes (Copy still copies
everything), and the shared multi-selection panel applies an edit to the members
that accept it. A same-kind selection that holds a locked member uses that shared
panel instead of its specialised batch panel. Its Locked row appears whenever any
member has its own lock (the board outline has none) and shows a mixed state.
Every selected locked object shows its lock icon.

The selection lock icon dispatches `unlock-shape` with the click position; the
editor answers with a menu of the applicable choices: unlock the object (an
undoable `SetObjectLockedCommand`, or `SetPlacementLockedCommand` for
components), unlock the holding layers (layer-panel preferences, outside
history), or both. Properties panels put a Locked row first
(`lockedPropertyHtml`/`bindLockedProperty`); it sets the object lock and stays
enabled under a layer lock, while the panel's other controls become read-only.
The board outline keeps its existing layer-lock checkbox
(`test-pcb-object-locks`, `browser-tests/object-locks.mjs`).

## PCB Derived Refreshes

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

## Keyboard and Ribbon Actions

`pcb/modules/editor-actions.js` is the common keyboard/ribbon entry point for
Undo, Redo, Save and Save As. Keyboard focus guards and shortcut matching live
in `pcb/modules/keyboard.js`; DOM bindings only dispatch actions. Drawing tools
handle their own keys through `handleTrackDrawKey`, `handleFillDrawKey` and
`handleShapeDrawKey` before the shared actions run. History requests use the
keyboard policy: floating paste, dimension previews and group drags
consume the request by cancelling, while unfinished track/fill/shape drawing
does not traverse history. Individual-pointer Undo and image-rotation Redo run
their cleanup before traversing history. Cleanup errors propagate without
advancing the stacks. The handler's boolean reports
request consumption, not whether an undo/redo entry existed.
Save requests resolve `app.project` at invocation, never a global bootstrap.
The project still owns snapshot readiness, I/O and ordinary failure reporting;
the shared action shows the saved toast only after a successful result.

The same action boundary owns staged Escape after drawing-mode keys have been
handled. It cancels an active property preview or pointer gesture before
leaving a tool, clearing selection or returning Home. The lifecycle module's
property-editor catalog supplies preview cancellation for text, pad and via
editors as well as track and shape editors; cancellation retains the controls
and does not commit or traverse history. Shape/track priority and
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
Group movement commits pending numeric-property edits before movement, records
the nudge separately in history and refreshes Properties after completion. Step
sizes remain one quarter of the configured grid with snapping enabled, or 1 mm
with snapping disabled. Drawing, marquee, pan, hidden/locked selections and
reference-label selections retain their guards; input-focus and DRC-list
navigation stay with the keyboard UI.

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
preserving shape-draw cancellation on an actual tab change.
Cleanup failures propagate before adopting the destination tool or tab.
This boundary does not change per-tool Enter/Escape completion or property
commit behavior, and does not make all interactions follow one cancellation
policy.

## Selection

`syncPcbSelection()` runs on every hover and click query, so it reuses one
adapter per model object (adapters read live state lazily). It rebuilds the
entry list and selection flags only when the set of entities changes;
otherwise it just resets the hit caches. Pad bounds and copper-fill outlines
are memoised on their geometry fields, because the bounds pre-filter reads them
for every entity on every query. `test-pcb-selection-sync-reuse` guards the
work counts and correctness; `node tools/bench-pcb-hit-test.mjs` is the
selection-sync and pointer-hit benchmark.
Hiding a layer deselects only the entries whose adapter reports
`visible === false` (`deselectHiddenPcbSelection()` in `box-select.js`); objects
on other layers, and pours that stay visible, remain selected and the
Properties panel follows what is left (`test-pcb-selection-layer-locks`).
Bounds remain entity-owned derived data, not authored state.
Schematic `Text` remains a measured-layout exception: drawing clears its bounds
so the next query uses the updated SVG font metrics rather than an earlier
headless estimate or stale text measurement.

Overlap selection includes every eligible component, not just the topmost
footprint. PCB hit queries cache all component hits for the current pointer
query; both editors expose the Shift+click cycling tip. A selected obscured
component remains eligible for drag pickup, including mixed groups, without
bypassing layer visibility, locks or selection-anchor precedence.

The editor adapter removes SVG and selection before replacing entities,
renders only when active, and refreshes derived geometry after loading.
Its design-settings refresh only updates controls and local defaults from adopted
model data; it neither adopts data nor marks the document dirty.
Drawing and Net-edit contexts explicitly retain the inherited collections when
spreading the editor into a temporary object; otherwise copper could silently
disappear from connectivity checks.

## Previews and Projections

Image rotation and dimension number controls retain their DOM nodes during
focused native `input`/`change` steps. Commits update the displayed numeric
values in place rather than rebuilding the panel and losing keyboard focus;
no-op/invalid values and paired dimensions use current geometry. Undo/redo and
owner changes retain the normal panel refresh path.
The same commit policy covers shape width, circle diameter, global/node corner
radius and bulge previews. Their focused controls synchronize current values,
mixed-state placeholders and coupled dimensions in place. Structural changes
still rebuild the panel: straightening an arc removes its obsolete Bulge field.

An image Properties refresh supplies its canonical target identity. Rebuilding
controls for that same image does not cancel its pointer rotation; changing to
another target (even one with the same ID), clearing the panel or replacing the
document still ends that gesture. Numeric-preview acceptance on rotation
pickup remains owned by the image adapter. Drawing-mode completion remains
with its existing callers; this is not a new
general-purpose interaction framework.

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

Copper-cut geometry lives in `pcb/modules/copper-cuts.js` as per-side SVG
clip paths in the editor's `<defs data-pcb-defs>`. During image rotation,
explicit refreshes and viewport updates keep using the settled cut cache, so
settled pour holes remain until drop. Discarded rotations do not repour
unchanged copper.

Copper-removal hatching is drawn by `pcb/modules/removal-hatch.js` as an SVG
`<pattern>` fill in the same editor-owned `<defs data-pcb-defs>`. It is not a
canvas overlay, so holes, copper cuts and higher SVG layers cover it in normal
z-order. Export and panelization strip the hatch fill because it is an on-screen
editing aid.

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
and disposes detached controls on panel replacement, layer hiding
or a document is loaded. Pending render frames are cancelled on every exit.
Save and fabrication-export guards include active numeric pad edits. Pad
collection precedence is terminal movement, rotation handle, numeric properties,
then canonical state; starting a pad move or rotation commits pending numeric
properties first.

Via diameter/drill properties use the corresponding fixed-selection projection
in `track-commands.js`, exposed through `PCBApp.vias` after movement previews.
First-change snapshots use current authored values, so edits after undo/redo do
not depend on values from panel opening. Copies and collection identity are reused,
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

Direct track numeric properties use a single-track projection in
`track-commands.js`: whole-track/selected-edge width, whole-track/node corner
radius and the existing arc bulge field. The first changed value captures exact
graph state and creates one track copy/collection; subsequent values reuse both,
including graph-map identity. Canonical geometry, metadata, serialization and
bounds caches remain untouched. The track collection getter prefers component
and terminal-movement previews before numeric properties. Selection adapters
retain canonical identity while resolving displayed bounds, hits, lock outlines,
anchors and hover geometry. Repeated values skip SVG and derived refresh work;
changed values render immediately.
Existing width/radius/bulge normalization and derived refresh policies remain.

The disposable track panel binding clears the projection before the existing
graph command, using first-change rather than panel-open snapshots. Exact
attribute fallbacks survive a return to the original value without consuming
redo. Numeric-to-net/layer, node/midpoint/split/arc pickup and terminal pickup
finish pending properties before using canonical targets. Cancellation,
panel replacement, deactivation, loading, relevant layer locks/visibility, missing
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
Mixed-object group movement in `box-select.js` reuses detached copies of
directly selected tracks, vias, pads, board shapes and fills alongside the
component/text projections. `PCBApp` collection getters give the group
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
bundle rather than undoing authored content.

Imported images use the same placement path. Their properties open after the
placement is accepted, not while the image is floating; selection and anchors
remain visible during placement. Schematic paste and shared clipboard contents
retain their existing semantics.

Mixed-selection attribute preparation in `multiPropertyCapabilities`
(`pcb/modules/multi-selection-properties.js`)
uses detached shape/image/fill candidates and track-width snapshots rather than
mutating canonical objects and restoring them. Mutation callbacks receive the
candidate, while the resulting commands retain canonical targets. Image bounds
are measured on the candidate, immutable artwork remains shared read-only, and
unchanged dimensions/rotation skip transforms to avoid precision drift.
Failed preparation leaves canonical geometry, nested references and fill caches
untouched; accepted batches retain their existing compound history behavior.

## Command Adapters

The Design ribbon and New Track/Via property editors share the same commit path.
Valid edits mark the PCB dirty and retain the geometry refresh requests;
unit/router preferences are also saved project edits. Temporarily blank or invalid
dimensions retain the last valid model value and show native field validation.
Project preparation rejects nonpositive/nonfinite dimensions before replacing
live content. These numeric fields opt out of shared two-decimal formatting.
Project serialization still rounds dimensions to four decimals at the file
boundary. Local defaults store canonical millimetre values and read stored
display-unit strings under the same storage key.

`pcb/modules/board-outline-resize.js` owns board-outline handles, board-size
property previews and the Board Dimensions dialog. `PCBApp` exposes only seam
methods such as `_showBoardDimensionsDialog`, `_closeBoardDimensionsDialog` and
the board-outline selection/drawing hooks that tests and project-state code call.

`pcb/modules/route-input.js` owns autorouter `RouteInput` construction from the
editor's public board state: placements, netlist, filled copper terminals,
obstacle pads, fixed copper obstacles, design rules and routing bounds. The
editor seam `_buildRouteInput()` delegates to it; stored test inputs are consumed
before a fresh board input is built.

Editor command adapters coordinate model commands with rendering and derived
refreshes; some entity types retain inherited presentation methods and caches.
SVG preparation/attachment, derived Net
text, label layout and current viewport settings remain editor responsibilities.
Headless serialization preserves loaded settings; registered editors supply
current viewport settings to model-owned project serialization. Schematic editing callbacks explicitly notify the
project; the model itself does not introduce an automatic change-observer system.
