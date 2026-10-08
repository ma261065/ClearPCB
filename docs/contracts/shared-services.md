# Shared Shapes, Selection, and Services

Part of the [module contracts](../module-contracts.md). Services used by both
editors (shape geometry and editing, previews, snapping, IDs, history, 3D) plus
the public editor service seams in `src/schematic/modules/schematic-editor-api.js`
and `src/pcb/modules/pcb-editor-api.js`.

## Shape Bounds and Selection

Node Properties offers the corner-radius control only where the shared geometry
allows it. Both editors use `canRoundPathNode` from `shapes/path-geometry.js` to
decide eligibility. Open endpoints, straight or degenerate joins and nodes
adjacent to curved edges do not offer the control; eligible interior and
closed-path corners keep the numeric editor. This presentation rule does not
change stored radii or rendered geometry.
Deleting either endpoint of a two-node line removes the whole line, clears
refinement/Properties and returns Home. Removing an endpoint from a longer
line retains its surviving geometry and whole-object Properties.

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

Selection and hover live only in `SelectionManager`. Its `selected` id set and
`hovered` id are authoritative; entities carry no `selected` or `hovered`
flags, so logical selection and rendered selection cannot drift apart.
Renderers ask `isSelected()` and `isHovered()` through the `selection` render
option (`shapes/selection-view.js`; previews use `NO_SELECTION`).

Selected-first hit testing visits only the selected entries, then scans the
rest in z-order. When selection, hover or an ownership tint changes, the
manager calls its `invalidateEntity` hook after updating its state. The
schematic hook (`refreshSelectionVisual()`) also redraws component highlights
at once because selection changes are not always followed by a render pass.

Editor code changes selection through the public API:

- `keepSelected()` silently re-asserts a tracked shape after an edit; untracked
  shapes are ignored.
- `dropSelected()`, `dropHover()` and `forget()` release a shape leaving the
  document.
- The optional `isCulled` predicate supplies editor-owned culling state.
- `clearSelection({ notify: false })` and `notifyChanged()` batch a change into
  one notification.
- `invalidateHitCache()` discards cached hits.
- `invalidateSelectionCache()` discards the selected-array cache after external
  registry synchronization.

`test-selection-state-seam` checks the API, the hook ordering and hit
priority, and fails on any entity flag use or private access outside the
manager. `tests/browser/schematic-smoke.mjs` checks in a real browser that
exactly the selected shapes draw anchor handles through anchor drag
commit/cancel, wire start, delete, undo and redo. The schematic keeps passing
its entities to `SelectionManager` directly: they already provide the adapter
contract (`id`, bounds, `hitTest`, `invalidate`), unlike PCB placements, pads
and reference text, which is why only PCB uses a selection registry.

## Extracted Services

- `shapes/arc-edit.js` owns control-arc geometry, sampling, midpoint projection,
  and curvature-preserving endpoint edits. `shapes/arc-edge.js` owns bulged edges.
- `shapes/rounded-path.js` owns corner clamping, entry/exit points, SVG paths,
  and sampling. Uniform rectangles use circular corners; polygon and per-node
  rounding use quadratic corners. `shared/pcb/board-geometry.js` re-exports
  the helpers as PCB board geometry primitives.
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
  disappear in the deletion's single undo step. Width/curvature boundaries and
  surviving node/edge metadata preserve the cleanup rules.
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
- Schematic wire node and segment drags call `computeMovingSegmentSnaps()` with
  `{ diagonal: true }`, so they snap and guide H/V, collinear and 45-degree
  alignments. Sticky wires during component drags call the same helper without
  diagonal snapping and remain H/V-only.
- `core/grid-snap.js` owns the shared displayed-grid magnet: each coordinate
  remains free unless it is within eight screen pixels of a grid line, capped
  at 40% of the displayed spacing so there is always a free region between
  lines. `snapToViewportGrid()` adds viewport visibility, adaptive spacing and
  the temporary Shift override; both `Viewport.getSnappedPosition()` and PCB
  text/component/reference movement, paste, group movement and outline resize
  use it. PCB's `_snapToGrid()` is a magnetic adapter, not nearest-grid rounding.
  Gesture anchors, including group deltas and local reference offsets, keep
  their authored coordinate frame. Higher-priority pin, pad and alignment
  constraints continue to override the displayed-grid magnet.
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
  The same module owns the small shared Properties lifecycle used by
  schematic descriptor-driven numeric controls and PCB shape/image controls:
  one active field, commit-before-handoff, cancellation/disposal, focused
  commit policy, Escape consumption and deferred blur completion. PCB's
  binding supplies pointer/rotation handoff and layer checks; its detached
  copies and schematic's reversible live snapshots remain separate adapters.
  Schematic ownership survives a panel rebuild or root replacement so an
  already-pending blur can finish against its original target without rebuilding
  the newer panel.
  Starting another numeric field settles that previous edit first, preventing
  overlapping whole-shape snapshots from combining independent field edits.
  Numeric inputs register their completion policy with the shared owner, so
  handoff, action preparation and owner-driven commits validate the current
  field text just like change/blur. An empty or incomplete number cancels its
  pending preview rather than committing the last valid intermediate value.
  Completion preserves the caller's no-rebuild request and cannot disturb a
  newer field; geometry finalization forces structural rebuilds.
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
  Independent owner tests cover retired controls and cleanup. Reference-history
  tests retain exact rollback and command-replay coverage.
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
  straightening) rebuild.
  This covers shape/segment/node geometry, text size and reference rotation.
  Numeric input/change/Escape callbacks verify both the displayed control
  identity and current selection. Retired fields cannot restart edits after
  cancellation, a completed commit or panel replacement, or interfere with a
  newer preview. An already-pending blur finishes against its original
  targets; the guard does not change that completion contract.
  Schematic panel instances have a current-render identity separate from
  numeric transaction ownership. Rebuilding or replacing the panel retires
  its checkbox/text/dropdown callbacks, clipboard/delete/transform actions and
  drawing defaults, even when the same objects remain selected. Pending
  numeric completion retains its transaction lifetime. PCB shape controls check
  binding disposal before discrete callbacks can update controls or rebuild the
  panel, not merely before they mutate the model.
- Schematic focused Delete and shape context menus share node/segment deletion
  actions; without refinement, Delete removes the entire selection.
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
  edits retain their gesture and history ownership.
  Standalone arc menus support conversion and deletion. Shape splits retain
  one pre-split snapshot and an optional temporary remainder; placement commits
  one batch and Escape restores the original without leaving a remainder.
- Shared shape editing uses one rule set in both editors: repeated segment
  clicks retain refinement, rounded corners keep the base width during
  segment-width edits, circle radius denotes the outer edge, and Shift
  suppresses shape snapping. Electrical wire/track connectivity, layer
  restrictions, rendering chrome, history, and fabrication contours remain
  editor-specific. Shared geometry must not import either editor.
- `core/id-allocator.js` generates page-wide prefixed IDs (`shape_N`, `via_N`,
  `pad_N`, `fill_N`, `comp_N`): each kind owns one `IdAllocator`, constructors
  observe explicit IDs, and new IDs are one above the highest observed, so IDs
  stay unique across load, New and paste (`test-id-allocation`). Board shapes
  (`pshape_N`) use `PcbDocument.shapeIdCounter` instead.
- `core/CommandHistory.js` contains only the history engine and base command.
  Schematic commands are in `schematic/modules/commands.js`.
- `shared/3d/ArcballController.js` and `shared/3d/model-rendering.js` serve both
  component previews and the board viewer without importing PCB code.
- `core/PcbDocument.js` owns PCB authored state and serialization.
  `pcb/modules/project-state.js` is the PCB view adapter for detached
  preparation, model adoption, presentation reset and grid preference restore.
- `pcb/modules/copper-model.js` resolves physical pad geometry and logical nets;
  `copper-connectivity.js` owns common cluster construction and positional unions.
- `pcb/modules/fill-context.js` supplies reusable collections to copper pours;
  `copper-artwork.js` resolves DRC artwork primitives.
- `core/DerivedUpdates.js` batches derived callbacks; `core/spatial-pairs.js`
  supplies the DRC broad phase.

`node tools/test.mjs` runs every `tests/unit/test-*.mjs` in an isolated process.
`node tools/regression.mjs` also checks import boundaries, the PCB/schematic/shared
editor-access baselines, doc references and the autorouter clearance baseline.
`node tools/typecheck.mjs` runs one strict `checkJs` pass against `jsconfig.json`
and locates TypeScript from `TSC` or the repo's git-ignored `node_modules`.
`node tools/browser-test.mjs` runs `tests/browser/*.mjs` with Playwright from
`PLAYWRIGHT` or the same git-ignored `node_modules`.
