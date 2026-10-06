# PCB Components, References and Text

Part of the [module contracts](../module-contracts.md). Footprint placements,
their saved overrides and metadata, reference designators and free-standing
text.

## Placement Geometry and Rotation

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
`pcb/modules/component-selection.js` also owns component body hit-testing,
component hover outline state in per-editor WeakMaps and the component 3D
context-menu entry point. PCB input modules import those owner APIs directly
rather than reaching through `PCBApp` private methods.

## Free Text

Free-standing text creation, defaults/layer rules and full-precision snapshots
live in `core/pcb-text.js`. Undo and clipboard use these snapshots without file
rounding; `PcbDocument.serializeEntities()` rounds text position, size, rotation
and stroke width to four decimals only at the save boundary. The geometry helper
`pcb/modules/pcb-text.js` re-exports the data helpers and owns glyph geometry and
layer colours. Editor presentation state lives in `pcb/modules/pcb-text-render.js`:
it keeps each editor's SVG elements and hover target in WeakMaps, and exports
render/remove and hit-test functions for commands, paste/load and mouse paths.
The Text tool's editable placement defaults live in `pcb/modules/text-properties.js`
as per-editor WeakMap state; the module opens the New Text panel directly.
Re-rendering an existing text stays the editor service `refreshText(id)`, which
modules call (and tests stub) rather than the render function.

`core/pcb-text-commands.js` owns add/remove/move/edit text mutations, undo state
and descriptions, operating directly on `PcbDocument` without an editor or DOM.
`pcb/modules/text-commands.js` provides the editor adapters: they delegate
mutations to the model commands and retain SVG, selection, property-control and
derived-refresh updates. Deleted text is restored from an unrounded snapshot
with its original ID. Add undo retains the current model object, which may have
been recreated by a later deletion undo, so a complete undo/redo chain cannot
resurrect a stale text instance. Missing move/edit targets fail explicitly.

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
the mixed-group projection in
[pcb-editing.md](pcb-editing.md#previews-and-projections). Save/export readiness
guards remain the policy for unfinished edits, even when canonical geometry is
unchanged.

Text property inputs edit the same reusable editor projection, never the
canonical text. A property preview owns only layer, size, rotation, stroke width
and layer-dependent anchor coordinates. It can coexist with independently owned
inline content; other committed fields synchronize without overwriting either
pending edit. Commit ends property ownership before executing the model
command, with no temporary authored rollback. Cancellation restores current model
values and controls. Panel replacement disposes prior field bindings so late events
cannot restart an edit on the previous text. Layer locking, tab deactivation and
loading cancel pending property edits. Save/export readiness includes pending
text properties rather than silently capturing older values than those displayed.
Unchanged input/change values skip both redraw and clearance scheduling; changed
values update immediately. Content and border commands remain independent.

Standalone inline text is started and finished by
`pcb/modules/text-inline-edit.js` through the editor's `_startTextInlineEdit`
and `_endTextInlineEdit` seams. It uses one reusable editor-owned text copy and
map from entry to completion. Typing changes only that copy's content; canonical
content, geometry snapshots and serialization remain unchanged. No map or text
copy is created per keystroke. Changed input renders once; repeated unchanged
input updates caret/selection geometry without rebuilding glyph SVG.

Property edits made during inline typing use independent model commands. Their
style/pose changes synchronize into the same content projection without
overwriting pending input, including undo/redo. Layer-side compensation uses the
displayed content width. A pose gesture on the edited text (its rotation handle)
ends with `finishTextPosePreview`, which keeps the content projection and re-syncs
the pose from the model, so the typed text stays displayed whether the rotation
commits or is cancelled.
Completion (`finishTextContentPreview`) removes the projection before a content
edit or deletion command;
there is no temporary authored-content rollback. Cancel restores presentation
from the current model, preserving independently committed property changes.
Blank-content deletion and cancelled new-placement cleanup use
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

## Layout Resolution and Placement Overrides

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
track. Restoration always repositions compatible endpoints and disconnects
incompatible SMD bonds on either side, independent of the schematic-rebuild
eligibility policy.
Missing/non-physical components and automatic placements are not restored; saved
records are retained unchanged and no automatic grid slots are allocated.
The load adapter requests only currently rendered IDs, replaces their footprint
artwork and LOD nodes with model-resolved geometry, and leaves unrelated layers
and placements intact. It never reads cached rendered pad geometry. Fresh artwork
also restores default reference styling after a custom style. Persistent tracks
are rendered afterward by the existing load sequence; hidden loading remains
deferred until activation.

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
footprint data retain the existing empty geometry result. The pure parser
remains in `shared/pcb/footprint.js` alongside its rendering exports. All four
physical placement commands use this source. Entity rendering,
derived caches, live previews and viewport preferences remain editor concerns
unless a model module is named as their owner.

The live `placements` map remains editor-owned: it contains generated footprint
geometry, presentation caches and temporary gesture state, not a second
authoritative saved-placement store. Model-owned `PcbPlacementState` retains the
derived automatic layout slots separately from saved overrides. PCB presentation
during loading and viewport settings remain in the PCB adapter.
Viewport culling uses constant-time selection membership rather than rebuilding
the selection list for each footprint. Every in-view selected footprint keeps
its detailed artwork at low zoom; unselected footprints retain the 24-pixel
placeholder threshold, and offscreen footprints still cull with 50% overdraw.

## Placement Metadata and References

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

The metadata editor command names are adapters. They project only edited fields
into the current generated placement, retain transform/glyph, selection, overlay
and 3D updates, and notify the dirty hook. Metadata persistence is the model
record in `PcbPlacementState`, not a re-recording of the whole generated
placement. Authored undo/redo works without a currently rendered placement.

Reference-label drag completion uses explicit original/final local offsets.
Commit passes them directly to `MoveRefTextCommand`, without repainting a
temporary rollback or repeating the command's final overlay refresh.
Cancellation restores only the live reference offsets, without recording
history, dirtying the project or creating a saved placement override. Shared
selection and direct Escape/Undo paths both finish the drag; physical pad and
bonded-track positions are unchanged. Local-frame magnetic snapping and
placement rotation/mirroring remain the same.

Both reference-drag paths re-evaluate magnetic snapping on every pointer event,
but skip SVG transforms and selection/tether overlay rebuilding when the resulting
local offsets are exactly unchanged. Distinct free positions still render
immediately; there is no rounding, movement threshold or new scheduler.
`pcb/modules/ref-text-selection.js` owns direct reference selection and the
double-click inline-reference edit entry point. Geometry remains in
`ref-text-geometry.js`; editor callers use the selection module's exported
functions instead of private `PCBApp` seams.

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
use `renderPlacementPose()` for SVG transforms only. Reference-only changes do
not call `applyPlacementPose()`, recalculate world pads, scan track bonds or
rebuild physical clearance.
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
direct hit-testing skips hidden labels before resolving layout boxes, and shared
selection adapters report them as invisible. Missing placements are invisible to
stale adapters. Hiding one side does not suppress visible references on the other.

Reference interaction locking combines the placement lock and its side's silk
layer lock. Locked labels remain selectable for inspection/unlocking, but shared
and direct dragging, keyboard rotation and single/multi-selection properties
respect that combined policy. Locking silk cancels active reference drag and
inline-name previews; a drag also rechecks the lock before committing. Layer
lock changes refresh the selected reference's property controls. Reference lock
icons retain both their component owner and layer-unlock callback, keeping
authored placement-lock history separate from layer-panel preferences.

## Placement Movement

`core/pcb-placement-commands.js` owns `MovePlacementCommand`,
`RotatePlacementCommand`, `FlipPlacementCommand` and `SetPlacementSideCommand`.
These take the project document, resolve its current footprint on every
execute/undo, patch only the requested canonical pose fields, and reposition
bonded track nodes by physical pad ID. History captures authored pose values,
not footprint geometry or rendered placements. Automatic placements use the
same detached, lazy baseline mechanism as metadata commands.
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

Commit ends the projection before the existing model command runs. Canonical SVG
takes over without duplicate tracks, including endpoints that
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
the mixed-group projection in [pcb-editing.md](pcb-editing.md#previews-and-projections); save/export readiness guards
continue to reject unfinished edits.

Both component pointer paths use the same live pose updater. If magnetic snapping
produces the current coordinates, it skips footprint transforms, pad/bond updates
and incremental ratsnest work. The comparison is exact: distinct positions in the
free region still update immediately, without rounding or additional throttling.
The event handler updates Shift before delegation and uses the adapter's
placement-lock guard. Drop/cancel processing still runs even if the last pointer
update did not change the pose.

Side changes retain the established snapshot of all existing track bond records
at each execute/redo. The command owns copies and restores them into the current
connection maps on undo, then checks compatibility against the current footprint.
Incompatible SMD bonds are removed before connected endpoints move; through-hole
and otherwise compatible bonds follow the new pose. Footprint resolution precedes
both restoration and snapshot replacement, so a missing footprint leaves bonds
and the last good snapshot intact. Restored bonds count as touched tracks even
when their endpoints did not move. The editor adapter updates generated pad/paste
layer descriptors and artwork without repeating model bond mutations; the
live-sync side helper keeps its data-plus-presentation behavior.

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
