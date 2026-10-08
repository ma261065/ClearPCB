# Copper Pours, Ratsnest and DRC

Part of the [module contracts](../module-contracts.md). Copper-pour commands and
live computation, ratsnest traversal, DRC checking and the DRC panel.

The authored object is `CopperFill`, and the UI/tool names use **Fill**. This
contract uses **fill** for the authored outline and **pour** for the computed
copper polygons derived from it.

Copper-fill add/remove/modify operations live in `core/pcb-fill-commands.js`.
Collection commands use the model-owned `PcbDocument.boardShapes` array;
modification applies authored state to a `CopperFill`. Undo snapshots deeply copy
outline points, per-node radii and per-segment curvature. These commands do not
calculate pours or update connectivity. The
`pcb/modules/copper-fill-commands.js` adapters synchronously refresh pours,
selection and Properties after accepted fill commands by calling the fill owner
modules directly. `copper-fill-edit.js` owns selected-fill Properties rendering
and refresh, while `fill-refresh.js` owns computed-pour scheduling, terminal
disposal, cached rerenders and clearing the rendered fill layers.

`commitFillEdit` in `pcb/modules/copper-fill-edit.js` is the
command-preparation helper for fill-specific callers. Interactive fill editing
uses the shared board-shape edit profile rather than a separate path editor.
`pcb/modules/board-shapes.js` owns the edit profile and displayed-copy maps;
`board-shape-drag.js` owns vertex, segment, bulge, circle-handle and
whole-object drags; `board-shape-properties.js` owns shared property-preview
transactions; `board-shape-render.js` owns shape rendering; and
`track-shape-conversion.js` owns track/shape conversion. The fill profile supplies
only the `CopperFill` copy/snapshot, fill lock/visibility checks,
`ModifyFillCommand` / `RemoveFillCommand`, copper-layer rendering and fill
validation. Pointer and property previews operate on detached `CopperFill`
copies resolved through the same displayed-copy maps as board shapes, so
`boardShapes` and the computed-pour weak map are canonical. Overlay deferral
suppresses computed-pour rerenders during previews; accepted fill geometry
settles into one `ModifyFillCommand`, and cancellation, no-op, invalid edits,
command rejection, deactivation/load and missing targets restore or remove
preview artwork without authored rollback. Grouped fills use the shared
mixed-group projection described in
[pcb-editing.md](pcb-editing.md#previews-and-projections).

The fill panel's number fields (corner radius, size, diameter, node radius,
bulge and geometry kind) use the shared board-shape property-preview transaction
with fill-specific field IDs/labels. Each spinner step redraws the dashed outline
from a detached copy, while the copper waits under the same overlay deferral.
The settled run commits one `ModifyFillCommand` and the pour is recomputed then.
The panel's `fill` property editor commits or cancels a live outline when the
panel is replaced, the layer is locked or the editor is left, so the deferral is
never left on (`test-fill-property-preview`).

Overlapping pours on the same layer never share copper unless they are on the same
named net, which merges them. Otherwise the earlier pour in document order (the older
one) keeps the overlap, and a later pour flows around the copper the earlier one
actually poured, keeping the clearance. A later pour can therefore still reach its own
net's copper inside an earlier pour's clearance holes. Two pours without a net count
as different nets. `computeFillPolygonsInOrder` (`copper-fill-geom.js`) computes pours
in that order and hands each one its predecessors' results (`ctx.poured`). The live
refresh, the fill worker and fabrication snapshots all use it; a pour computed
alone avoids its predecessors' outlines (`test-copper-review`).

A pour voids other-net pads with their clearance. A pad on the pour's own net gets a
thermal relief: its clearance ring is voided too, except for four spokes along the
pad's own axes. The spokes follow its width, height and rotation, so each one reaches
the pour past the pad's edge whatever its aspect ratio or angle
(`test-thermal-relief-pad-axes`).

Live computed pour polygons belong to `pcb/modules/computed-fill-cache.js`,
an identity-keyed weak map outside authored `CopperFill` entities. SVG, flat 2D,
3D, DRC, routing contacts, net propagation and ratsnest consumers read the same
results. Null means no completed result; an empty array means a successfully
computed empty pour. Previews retain the previous complete result, and so do
outstanding refreshes of a pour whose own geometry has not changed (a neighbour
moved, or the pour changed net or lock). A `ModifyFillCommand` that reshapes or
moves the pour, on its layer, clearance or any other copper-affecting setting, drops
its result instead, so copper computed for the old outline is never drawn at the new
one: until the recompute lands the pour shows its outline
(`test-fill-copper-invalidation`). Failed computations retain settled artwork, leave
refresh debt pending and report the error rather than displaying an empty or partial
pour.

A pour drag moves only the outline: ratlines and connectivity keep reading the
canonical pour's computed copper, which stays put until the drop recomputes it, so
the drag does not rebuild ratlines on each move (the board-shape profile names the
nets a copper shape's drag session redraws; the fill profile names none). The drop's command
recomputes the pour and redraws every net (`test-pour-drag-ratsnest`). Pours loaded
from a file are computed in the fill worker, so the main thread loads its geometry
library lazily; a pour drag starts that load, so the first drop after opening a
board does not wait for it.
Clones and loaded replacements do not inherit results, even with equal IDs.
Detached fabrication snapshots intentionally retain their own `_computed`
transfer field and recompute from captured authored geometry rather than using
the live preview cache. Entity-level presentation methods and other derived
caches stay separate from the computed-pour weak map.

Scheduled live pours use `pcb/modules/fill-worker-client.js` and the module
worker `fill-worker.js`. `fill-worker-geometry.js` captures detached,
full-precision model inputs; image artwork is represented by its physical frame,
matching the computed-pour engine. The service allows one active job and one
replaceable pending job. Generations, document/fill identities and lifecycle
cancellation reject stale results; preview deferral retains settled holes.
`fill-refresh.js` stages complete SVG results off-DOM before handing them over,
owns the terminal disposed state after `PCBApp.dispose()`, and reuses cached
results for selection-only rerenders.
Direct command recomputation is synchronous; missing Worker support and
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
Shared spatial pair sweeps compact expired entries in their active
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
candidate arrays contain the records being swept, and no persistent candidate cache or
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

`pcb/modules/drc-state.js` owns the editor-scoped DRC presentation, ratline
cache and disposal flag. The editor creates the `DrcPresentation` once, in
`initDrc`, and the module supplies its capabilities; refresh, status and
marker paths use it only if it exists (`peekDrcPresentation`), so code that
never set DRC up (fixtures, hidden loads) has no DRC to update. `pcb/modules/drc-presentation.js` owns the DRC panel, grouped
list, selected violation identity, collapsed groups, pending/error display and
viewport markers. It also owns Design-tab activity, DOM listeners and
suspension/disposal. Its capabilities request refreshes, resolve the selected
copper pair, collect neutral ratlines, clear board selection and access layer
groups and the limited viewport
navigation interface.
The owner accepts injected DOM for independent tests and never receives
`PCBApp`. The scheduler/checker publishes through thin editor adapters; it does not own
list selection or marker elements. Calculation and worker generation rules stay
in the DRC modules.

Selected short/clearance markers also have a lightweight live-preview path.
Their reports carry a serializable pair of stable copper-entity references.
`resolveDrcPairMarker` reads the displayed preview collections, resolves only that
pair's copper (plus applicable copper-removal artwork), and reuses the full DRC
distance checker, layers and clearance tolerance. The marker follows the current
contact or insufficient gap, disappears when the pair clears, and reappears if
the conflict returns. A short's marker also stays visible while the pair separates but
still violates clearance. Unsettled selected pours have no live marker until
usable geometry is available; the full result remains pending.
`DrcPresentation` coalesces marker checks to one animation frame and keeps the
preview separate from the authoritative results/list/status. Closing, replacing
results, deactivation and disposal cancel queued marker work. Pan/zoom uses the
same preview marker and cannot resurrect a temporarily resolved conflict.
Normal DRC still rechecks the complete board after commit/cancel and pour
settlement. Incomplete-connection markers retain their ratline-follow
path; this does not perform whole-board DRC on every pointer event.

Published fill-region identities are preserved, so their triangle contacts and
bounds can be reused rather than rebuilt for every candidate pair or unchanged
connectivity pass. A newly computed region has a new identity; replacing a
shape's region also invalidates its resolved contact. Hole geometry and physical
contact tolerances keep the same inclusive comparisons.

`CopperFill.captureCopperGeometry()` captures the model's resolved boundary as
detached, full-precision data. It reuses `getOutline()` for circles, rounded
corners and bulged edges rather than substituting the authored control polygon
or the file serializer's rounded coordinates. Fabrication adds its `_computed`
field after capture; the model neither reads live pour caches nor computes pours.
Boundary snapshots can be edited or transferred without changing the live fill.
