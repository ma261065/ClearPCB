# Representation Agreement Audit

Date: 2026-09-16. Baseline: `14516d0`.

Scope: PCB geometry from imported/editable objects through SVG, Canvas 2D,
Three.js, connectivity, DRC, pour/routing obstacles, persistence and Gerber/Excellon.
This is a contract audit, not a complete CAD correctness or router-quality certification.
The original audit changed no production code. Implementation follow-up is recorded
below. No browser or fabrication verification was performed.

## Implementation Follow-Up

F1-F8 have targeted fixes and headless regression coverage:

| Finding | Resolution |
| --- | --- |
| F1 | Image regions are separate electrical islands; terminal and pour containment respects holes. Cached region contact geometry and a spatial shape-pair broad phase avoid repeated artwork triangulation and all-pairs contact checks. |
| F2 | Shared `padFlashOutline` supplies posed elliptical and arbitrarily rotated pad regions for copper, mask and paste. Orthogonal rectangles/ovals and circles retain native Gerber apertures. |
| F3 | Track clipping includes each edge's width. Pad/via flashes and reference text no longer disappear because their owning centre is outside the board; the outline defines final board trimming. |
| F4 | Three.js removal consumes resolved physical contours/per-edge strokes. Via surfaces receive the same side-tagged copper removal as pads and tracks; through-hole barrels retain their existing policy. |
| F5 | Both previews consume expanded, mask-enabled pad openings through `resolvePadMaskOpenings`. |
| F6 | Gerber and Three.js use shared even-odd region decomposition for filled silk paths. Three.js filled silk circles include the outer half-stroke. |
| F7 | Export captures detached manufacturing inputs before awaiting Clipper and recomputes snapshot pours. Active edits are rejected; deferred preview caches are neither trusted nor overwritten. Artwork/text/pour-only boards are accepted. |
| F8 | The reusable `buildCopperObstacles` adapter consumes resolved widths and closure, while keeping deliberate conservative filled-shape envelopes. |

New modules remain narrow: [region geometry](../src/pcb/modules/region-geometry.js)
owns contour topology, [fabrication snapshot](../src/pcb/modules/fabrication-snapshot.js)
owns export readiness and isolation, and [copper obstacles](../src/pcb/modules/copper-obstacles.js)
owns routing adaptation. Existing native rendering and geometry authorities are retained.

Large ratsnests use an exact spatial Boruvka MST from
[cluster-mst.js](../src/pcb/modules/cluster-mst.js); small nets retain their existing
deterministic output. The spatial algorithm matched reference MST weights on 125
fixtures. A 20,000-single-point-island grid took 110-163 ms locally. This is an
algorithm check, not a browser benchmark or a guarantee for full dense artwork
processing and SVG rendering.

Verification: **15/15 selected regression files passed**:

```sh
node tools/test.mjs copper-review copper-shape-contact copper-region-connectivity track-copper-contact gerber-shape-parity pad-export-parity material-contracts fabrication-snapshot picture-circles picture-transforms picture-fast-path board3d-copper-side board-view-sync board3d-surface-reuse ratsnest-mst
```

The stale circle-contact expectation was corrected and the actual gap now has a
negative assertion. Snapshot tests exercise real Gerber emission, delayed loading,
mutation isolation, invalid-input rejection and exclusion of DOM/model fields.
The via subtraction wiring is source-checked; no rendered-scene validation is claimed.

A subsequent autosave-recovery failure exposed the incomplete FileManager lifecycle
contract. That contract is now restored: revision-only `touch`, revision-aware save
snapshots, failed-write propagation, deferred adoption of opened files, supported
ZIP manifest checks, and successful-revision autosave deduplication/retries.
`node tools/test.mjs autosave-revision project-lifecycle project-recovery` passes
all three files, including the previously blocked lifecycle gate. No lifecycle
assertions were weakened to obtain that result.

Hidden PCB loads now restore models and settings immediately, but defer object SVG,
clearance halos, ratsnest reconciliation and pours until activation. Viewport setup
still runs to preserve grid settings. Activation renders each image once, including
boards with schematic components; queued syncs do not rebuild hidden boards.
`pcb-deferred-load` covers hidden/active loading, first/repeated activation,
component-less boards, clearing, and saving encoded images before activation.
No browser timing improvement has been measured.

The board-shape group-drag regression now uses body grabs instead of vertex grabs
and controls the intentional refresh debounce. Cancellation also clears pending
refreshes to avoid a second pour refresh; vertex cancellation has explicit coverage.

Existing broad Three.js checkJs diagnostics remain; the newly introduced helper
type errors were corrected. Import/model limits and intentional approximations
listed below are unchanged. These results do not certify complete fabrication
correctness or browser recovery behavior.

### Drag, Selection and Reference Follow-Up

- Wire-segment net-conflict rollback no longer references the whole-selection-only
  `movedNets` variable. A real-wire regression checks restored geometry and
  connectivity, preservation of earlier history, and normal undo for valid moves.
- Hole-shape hits now precede overlapping vias/tracks in PCB selection. The
  existing selection-interaction and hit-query regressions pass.
- [Reference geometry](../src/pcb/modules/reference-text.js) now owns glyph layout,
  bounds, default anchors and world-space reference poses. SVG uses its local
  layout; Canvas, Three.js and Gerber use its posed polylines. The no-outline
  baseline is consistently -2.8 mm, preserving the existing SVG/Gerber position.
  Native-output tests cover outlines, sides, mirroring, rotation, offsets,
  visibility and stroke width without browser execution.

The separate `test-reference-selection-overlay` still fails when component
selection should clear the old reference box. It exercises selection cleanup,
not the reference-layout or output geometry changed here.

## Assessment

The architecture is substantially consolidated. The central geometry contracts are
real and widely consumed, not merely proposed abstractions. Remaining maturity is
uneven: footprint descriptors are well shared, electrical topology still contains
shortcuts, some output backends reinterpret descriptors, and derived-data freshness
is not enforced at every final-output boundary.

Recommendation: complete and test these existing contracts. A new universal geometry
layer or renderer rewrite is not justified by this audit.

## Contract Inventory

| Family | Authority and consumers | Assessment / coverage |
| --- | --- | --- |
| Placement pose, pad positions | `placementPose`, `resolvePadFlashes`; Canvas, Three.js and Gerber use them. Electrical pads use `resolveCopperPads`, sharing the pose. | Strong common foundation; distinct physical/logical pad IDs are preserved. Backend aperture interpretation has gaps (F2). |
| Pad copper / clearance | Native flash descriptors for rendering; posed physical outlines for DRC; conservative outlines for pours. | DRC subtracts removal artwork per layer. `test-copper-review` covers shapes, rotations and clearance; `test-drc-copper-removal` covers physical pad outlines and subtraction. |
| Tracks / vias | Track graph with per-edge layer and width; standalone vias. Shared clusters plus consumer-specific contact logic. | Core graph and attribute ownership are clear. Edge clipping, removal and routing-width consumers diverge (F3, F4, F8). |
| Board lines, circles, arcs, polygons | `resolveBoardShapeGeometry`: fill policy, centreline, physical contours, per-segment widths and copper mode. | Broad SVG/2D/Gerber reuse and boundary tests. Three.js still reconstructs some boundaries independently (F4). Resolver also lives alongside editor/DOM code. |
| Images | Artwork plus affine corner pose; dedicated raster/contour/circle geometry, native drawing and lazy triangulation. | Persistence, transforms, gaps, fast paths and exports have focused tests. Physical islands are not faithfully represented in ratsnest clustering (F1). |
| Copper pours | One `_computed` outer/holes representation feeds previews, Gerber and DRC. | Good single source for material geometry. Ratsnest discards holes, and export assumes the cache is current (F1, F7). |
| Drills / slots | `resolvePlacementDrills` shares posed round/slot descriptors; standalone vias and board cutouts are separate paths. | Placement-derived geometry is centralized. Board cutout/mesh tests exist; no complete Excellon-versus-preview coverage matrix was established in this audit. |
| Mask / paste | Shared mask expansion, pad membership and standalone paste descriptors; Gerber uses them. | Editor footprint layers carry membership; fabricated-board previews do not consume pad mask openings (F5). Paste is not a fabricated-board surface, so its absence there is not itself a bug. |
| Silk | `resolveSilk` shares posed footprint descriptors; board shapes use the board-shape contract. | Shared input, but filled subpath and circle-stroke interpretation differs (F6). |
| Text / references | Free text uses shared stroke-font polylines/segments. Reference layout and transforms are repeated in SVG, Canvas, Three.js and Gerber. | Free text is well factored; references remain a maintenance risk. No general reference-transform defect was established. |
| Routing obstacles | `_buildCopperObstacles` adapts text and shapes; router obstacle infrastructure is shared. | Bounding envelopes can be intentional. Per-edge width is lost for unfilled shapes (F8). Full autorouter algorithms were not audited. |
| Persistence / refresh | Project state serialization/preparation, command snapshots, derived-update batching and view synchronization. | Image/shape round trips and stale-view tests exist. No uniform export freshness barrier; lifecycle regression currently cannot complete (F7, Verification). |

Principal owners: [board geometry](../src/pcb/modules/board-geometry.js),
[board shapes](../src/pcb/modules/board-shapes.js#L1071),
[electrical pads](../src/pcb/modules/copper-model.js),
[electrical clusters](../src/pcb/modules/copper-connectivity.js),
[project state](../src/pcb/modules/project-state.js),
[view synchronization](../src/pcb/modules/board-view-sync.js).

## Findings

Evidence labels: **reproduced** means a read-only Node probe executed the real
function; **source-confirmed** means the controlling paths differ explicitly;
**risk** means reachability/timing has not been reproduced.
P1 prioritizes manufacturing/electrical correctness; P2 covers preview fidelity and
bounded workflow limitations. Priority is not a claim about frequency in real boards.

### F1. Ratsnest can report connections across empty copper (P1, reproduced)

[Shape clustering](../src/pcb/modules/track-draw.js#L803) creates one cluster per
additive shape using `shapeOutline`. The subsequent filled-interior test uses that
outline, which is just the four corners for an image. A via in the empty centre of
an image containing material only in one corner produces **zero ratlines, expected one**.
Separate artwork islands also start as one cluster, regardless of physical connection.
The image-aware shape-contact helper does not repair this later bounding-outline union.

[Pour bonding](../src/pcb/modules/track-draw.js#L872) tests only each polygon's outer
ring. A same-net via isolated inside a pour hole and another via in surrounding
copper likewise produce **zero ratlines, expected one**. Comments assume thermal
connections, but that is not evidence that a particular hole has conductive spokes.

Required contract: electrical clusters represent connected material regions, not
selectable objects or clearance envelopes; holes remain nonconductive unless actual
copper connects them. Preserve picture-wide clearance as a separate policy.

### F2. Gerber pad apertures do not express all accepted pad geometry (P1, reproduced)

[Copper emission](../src/pcb/modules/gerber.js#L219) and
[mask/paste emission](../src/pcb/modules/gerber.js#L503) turn an unequal-axis ellipse
into a circle of the maximum dimension. A 2 x 1 mm ellipse exports as `C,2`, while
[Canvas](../src/pcb/modules/board2d.js#L788) and Three.js use both axes.

Non-orthogonal rectangular/oval placement rotation is also lost: a 37-degree 2 x 1 mm
rectangle exports as an unrotated `R,2X1` aperture. The normal PCB rotation buttons
use 90-degree increments, so that particular discrepancy has restricted interactive
reachability; [project restoration](../src/pcb/modules/project-state.js#L145) accepts
arbitrary rotation and the preview/electrical geometry handles it.

Required contract: either preserve accepted geometry in Gerber, or explicitly reject
unsupported forms at the model boundary. Do not silently substitute another shape.

### F3. Gerber clips some objects by centre rather than material (P1, reproduced for tracks)

[Track export](../src/pcb/modules/gerber.js#L243) clips the centreline without its
stroke width. A 1 mm-wide vertical trace at x=100.1 beside a 100 mm board contributes
0.4 mm of copper inside the board, but emits no draw. Copper text already passes
its width to the same clipping helper.

Pads/vias also use centre-only rejection; reference designators are gated by the
placement centre rather than their own offset geometry. Those related cases are
source-confirmed, not individually reproduced. Shared aperture/curve descriptors
should survive whenever their material overlaps the fabrication domain.

### F4. Three.js removal does not fully consume physical geometry (P2)

[Copper subtraction](../src/pcb/modules/board3d.js#L1590) rebuilds non-circular
removal strokes with the single `geometry.lineWidth`, ignoring `strokeSegments`.
Changing a line's per-edge width from 0.2 to 2 mm leaves its subtraction descriptors
**identical** (reproduced). Canvas and Gerber consume the per-edge widths.

The [surface build](../src/pcb/modules/board3d.js#L3449) applies copper subtraction
to copper and pad surfaces, but gives via surfaces only board-shape hole cutouts.
Thus removal over a via is not represented by the same subtraction pipeline
(source-confirmed; no rendered-scene test).

Required contract: use resolved physical strokes/regions, then apply the same
material-removal policy to every copper-bearing surface, with explicit plating rules.

### F5. Board previews are not authoritative for pad soldermask (P2, source-confirmed)

[Canvas mask openings](../src/pcb/modules/board2d.js#L596) consider board shapes, not
placement pad openings. The [Three.js mask coat](../src/pcb/modules/board3d.js#L3463)
uses drilled holes and board-shape openings, not expanded mask-enabled pad shapes.
Gerber does use pad `mask` membership and `MASK_EXPANSION`.

Consequently, the preview's pad appearance cannot verify fabricated mask geometry
or distinguish mask-enabled from mask-disabled SMD pads. This is a descriptor
coverage gap, not a reason to make all renderers use identical materials or lighting.

### F6. Footprint silk has inconsistent fill topology (P2, source-confirmed)

[Canvas](../src/pcb/modules/board2d.js#L909) fills all subpaths together with even-odd
winding; [Gerber](../src/pcb/modules/gerber.js#L746) and
[Three.js](../src/pcb/modules/board3d.js#L1937) fill each subpath independently.
Nested filled paths therefore produce holes in Canvas but solid interior material
in the other outputs. Actual imported-library prevalence was not measured.

Filled footprint circles also differ: Canvas/Gerber fill and stroke, while Three.js
emits only a disc at the nominal radius. The missing half-stroke is a dimensional
difference separate from normal tessellation error.

Required contract: descriptors must define fill topology and whether stroke is part
of the physical boundary, rather than leaving those choices to each backend.

### F7. Export has no derived-geometry freshness guarantee (P1 risk)

[Export](../src/ui/PCBApp.js#L8516) immediately passes live objects and cached pours
to the exporter. [Pour recomputation](../src/ui/PCBApp.js#L7926) can be deferred or
await Clipper loading; picture-related refresh can be delayed by 100 ms.
The exporter consumes `_computed` without checking a revision or awaiting refresh.
This is a source-confirmed missing guard; an actual user-event race was not reproduced.

Separately, export's empty-board guard counts only placements, tracks and vias,
rejecting a board containing only shapes, images, text or pours (P2, source-confirmed).
Low-level image export tests bypass that UI guard.

Required contract: final output consumes a current, consistent snapshot, or refuses
with an explicit reason. Eligible content must include every exportable family.

### F8. Routing adaptation loses per-edge shape width (P1, source-confirmed)

[_buildCopperObstacles](../src/ui/PCBApp.js#L6552) uses a bounding obstacle for filled
shapes, but converts unfilled outlines into segments using only `shape.lineWidth`.
A widened edge can therefore occupy more copper than its routing obstacle represents.
The same adaptation closes any non-arc outline with more than two points, including
an open polyline; this adds an unnecessary closing obstacle.

Required contract: use resolved segments and closure. A conservative filled-shape
envelope is an intentional routing policy; ignoring a wider edge is not conservative.
No full routing run was performed to measure resulting route violations.

## Intentional Differences and Model Limits

- Conservative pour outlines, picture-wide pour clearance, routing envelopes and
  bounded visual tessellation are valid, provided they do not become connectivity.
- DRC now uses physical pad outlines and image regions, subtracting copper-removal
  artwork per side before clearance and short checks. Surviving islands and holes
  retain their topology; mask-only artwork does not remove copper. Plated barrels
  keep surviving surface copper connected, while nominal drill/ring checks remain
  independent of surface removal. Unaffected features retain analytic distance checks.
  Clipped circles/arcs and round stroke joins use a 0.0001 mm tessellation target
  and 0.000001 mm integer coordinates; other contours use the shared shape resolver.
  This is bounded geometric checking, not exact algebraic geometry. Incomplete
  connection reports still consume the upstream ratsnest supplied to DRC.
  Coverage: `drc-copper-removal`, `drc-analytic-arc`, `drc-boundary-cache`, and
  `spatial-cross-pairs`, and `drc-analytic-circle`. The circle collection fixture
  now uses the stored outer-radius convention; its exact clearance boundary
  and inner/outer radius assertions remain unchanged and pass.
- [Footprint import](../src/pcb/modules/footprint.js#L298) keeps only orthogonal
  per-pad orientation through width/height swapping; polygon pads become rectangles.
  These are import/model fidelity limits: all downstream consumers can agree and still
  differ from the source footprint. They need supported-subset documentation or rejection.
- The original reference-layout duplication and 0.8 mm no-outline baseline mismatch
  were resolved in the reference follow-up above; SVG retains native group transforms.
- Shared geometry living in the large board-shape interaction module complicates
  headless use, but extraction alone would not repair any of the semantic gaps above.

## Verification

Read-only Node probes reproduced F1, F2, the track case in F3, and the width case in F4.
No fixtures were saved and no production files were modified by those probes.

Existing regression command:

```sh
node tools/test.mjs copper-review copper-shape-contact track-copper-contact gerber-shape-parity picture-circles board3d-copper-side board-view-sync board3d-surface-reuse project-lifecycle picture-transforms
```

Result: **8/10 files passed**. Passing suites protect substantial existing behavior,
but do not cover the reproduced counterexamples.

- `test-copper-shape-contact` fails at line 35. Its third fixture expects contact
  between an outer-radius-2 circle and material beginning at x=2.05. A separate
  probe confirms the 0.05 mm gap; this expectation reflects the older radius contract.
- `test-project-lifecycle` stops at `FileManager.clearAutoSave` because `localStorage`
  is undefined in the Node harness. Later lifecycle assertions were not reached;
  no claim of a passing lifecycle gate is made.
- IndexedDB-unavailable warnings are expected in these headless environments.
- This was not the full regression suite, a browser assessment, a complete import
  compatibility audit, or independent Gerber/Excellon viewer verification.

## Recommended Sequence

1. Repair the two existing test gates, then add permanent minimal counterexamples
   for F1-F4 without changing the intended physical contracts to satisfy stale tests.
2. Fix electrical-region clustering (F1), accepted pad export geometry and edge
   coverage (F2/F3), routing-width adaptation (F8), and export freshness (F7).
3. Complete preview consumption of removal, mask and silk contracts (F4-F6).
4. Extend a reusable contract matrix across pose, layer, fill/stroke, holes/islands,
   mutation, undo/redo and save/reload. Use independently specified dimensions and
   connectivity assertions, not only comparisons to the shared implementation.
5. Extract pure geometry from interaction modules only where it simplifies these
   tests or removes actual duplicated policy. Preserve native backend primitives.