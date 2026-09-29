# Code Review Follow-Up

This maps the 19 review findings to the corresponding implementation changes.
Verification uses the headless Node regressions below; browser verification has
not been performed.

## Release-readiness tracker

Started 2026-09-29. This is the active checklist, not a declaration that the
application is ready to release. Each milestone requires implementation,
regression evidence, and updated documentation. Work proceeds in small,
reviewable changes; no broad rewrite or mechanical file splitting is planned.

| Milestone | Status | Evidence required / remaining work |
| --- | --- | --- |
| Verified checkpoint | Done | Commit `3b5e096`: geometry persistence/resize, document reset, Home navigation and regression-fixture fixes. Full gate: 132/132 files; autorouter 74/76, zero clearance violations. |
| Automated release gate implementation | Committed, locally verified | Commit `7e03035`: push/PR workflow and tag-specific pre-package gate. Both pass actionlint 1.7.7 (workflow/schema/expression checks; external shellcheck/pyflakes disabled). The unchanged gate command passed the full checkpoint above. |
| Hosted checks and merge protection | Pending authorization | After an authorized push, verify the first hosted run and require Regression gate in branch rulesets. No remote settings, push or release have been performed. |
| Document-completion UI ownership | Implemented, locally verified | ProjectDocument notifies registered views after successful New/Open/Recent/import/PWA; each view owns its own Home navigation. New clears its own registered PCB instead of relying on a global bootstrap. Five focused suites pass. |
| New/reset responsibility boundary | Implemented, locally verified | UI confirms/reports; ProjectDocument coordinates section clearing; editors own their content; FileManager adopts identity and stores the cleared project. Six focused suites pass (lifecycle, recovery, autosave, Home navigation, PCB reset and deferred loading). No new rollback framework. |
| Live-session rollback checkpoints | Deferred by user decision | Oversized uncommitted experiment removed. Retain existing serialized Open recovery, including rounding/normalization and loss of Undo/selection on rollback. Exact editing-session recovery is not a release requirement. |
| File > New board-size prompt | Implemented, locally verified | User chose immediate setup in active PCB, deferred until PCB activation after schematic New. Reuses the existing dialog; repeated setup cannot stack dialogs, replacement disposes old dialogs, and stale acceptance cannot mutate the new document. |
| Data model and representation consistency | Pending | Audit identities, geometry/precision invariants and editable/persisted/manufacturing conversions; extend cross-consumer tests. Keep legacy rectangle readers until the user confirms migration. |
| Separation of duties and maintainability | In progress | Completion and New/reset ownership are the first bounded slices. Next review derived-data invalidation ownership, with a concrete small scope agreed before implementation. Avoid generic frameworks and mechanical file splitting. |
| Measured performance | Pending | Define representative boards, latency budgets and repeatable first-interaction/load/switch/dense-board measurements; check visual correctness as well as speed. Browser checks remain user-led unless authorized. |
| Reliability and routing baseline review | Pending | Exercise failure paths and multi-step editing sequences. Review 288 traces/214 vias versus the old 239/174 baseline; the hard routed threshold is still 65 despite current 74/76. Do not merely reset baselines to silence warnings. |
| Current documentation and distribution notices | Pending | Reconcile README, structure, file-format and limitation descriptions; distinguish historical audit results from current guarantees; review licence/notices. |
| Final release acceptance | Pending | Run the full gate on the final revision, complete user-led real-board/browser acceptance and independent manufacturing-output review, record limitations, and obtain release approval. |

### Working agreements

- Keep verified milestones separate and commit when authorized; do not push,
  tag or publish without authorization. Do not modify the user's board files.
- Retain existing minimum behaviour and user contracts while tightening ownership.
  A failing test is investigated, not weakened simply to make a gate pass.
- Report completed work, remaining risks and the next proposed milestone after
  each stage; ask when a behavioural decision is needed.
- Separate locally verified implementation from hosted, browser or manufacturing
  evidence that has not been obtained. No browser testing/debugging by the agent
  without authorization.
- Release acceptance covers architecture, consistency, model, responsibilities,
  performance, reliability, documentation and maintainability. A green test count
  alone is not sufficient, and zero defects cannot be guaranteed.

## Original review findings

| Finding | Implementation |
| --- | --- |
| 1. Save As reports failed writes as success | FileManager propagates write failures and adopts the destination only after success. |
| 2. PCB-only edits can be discarded | New, Open, Recent, Import, and PWA launch use aggregate project dirtiness. |
| 3. Imports retain the previous file handle | Successful imports clear the handle and path. |
| 4. Saves clear newer edits | Saves clone their input, compare revision counters, reject concurrent saves, and retain recovery data for newer edits. |
| 5. Pours omit other pours | Fill contexts include the full pour collection for different-net clearance. |
| 6. Text obstacles are consumed once | Fill contexts materialize reusable text arrays. |
| 7. SMD pads bond across layers | Shared copper clusters use the pad's actual layer; drilled pads and vias bridge layers. |
| 8. DRC omits artwork | Copper text strokes, additive shapes, computed pour regions and holes are checked. Uncomputed pours report an error. |
| 9. Library definitions override embedded definitions | Project definitions take precedence without modifying the shared library, and remain embedded on save. |
| 10. Duplicate physical pads lose their net | Net lookup uses logical pad numbers; connectivity retains distinct physical pad IDs. |
| 11. Unvalidated, destructive loading | Container/project validation and detached model preparation precede clearing; failed application restores document content. File identity is adopted afterward. |
| 12. Group drag cannot fully cancel | Escape and Ctrl+Z cancel direct group drags; cancellation restores components, tracks, vias, shapes, text and pours, then refreshes derived geometry. |
| 13. PDF includes editor chrome or misses culled artwork | Cloning temporarily unculls footprints; non-artwork layers, selection halos and LOD placeholders are removed; pours follow their copper layer's export setting. |
| 14. Empty PCB loads remain dirty | Empty-section loading explicitly marks the PCB clean. |
| 15. Bottom-side culling uses the wrong mirror | Culling uses user-mirror XOR board-side, including it in the cached bounds key. |
| 16. Bulk commands repeatedly rebuild ratsnest | Nested compound commands defer reconciliation until the outer batch completes. |
| 17. DRC exhaustively compares distant features | A sweep broad phase filters candidate pairs before geometric distance checks; copper collection is reused for short detection. |
| 18. Shared code imports editor-specific services | Schematic commands live in schematic/modules/commands.js; neutral 3D services live in shared/3d; pad and cluster construction are shared between connectivity consumers. |
| 19. Large facade and incomplete regression gate | PCB persistence and fill-context construction have explicit owners. The aggregate runner discovers every root test file and runs each in an isolated process. |

## Verification

Run the newly added focused regressions:

```sh
node tools/test.mjs project-lifecycle copper-review
```

Run all regressions in `tests/`, or include the existing heavier autorouter baseline:

```sh
node tools/test.mjs
node tools/regression.mjs
```

Regression fixtures must reflect the current contracts: declared PCB stackups,
on-board artwork placement, selection-overlay layers and complete DOM/timer
mocks. Gerber checks compare numeric dimensions and physical coverage rather
than incidental decimal formatting. Copper-image connectivity uses the solid
image frame, while manufacturing checks retain transparent artwork holes.

After the fixture/expectation cleanup, geometry persistence, rotated rectangle
resize, document reset and Home-tab fixes, the full headless gate passed all
132 test files on 2026-09-29.
The autorouter routed 74/76 connections with zero clearance violations.
Its 288 traces and 214 vias differ from the older 239/174 baseline,
so those two informational warnings remain; the routing baseline was not
changed to silence them.

Manual checks remain necessary for file permission/write failures, EasyEDA
import followed by Save, mixed-object marquee cancellation, offscreen and
bottom-side footprints, PDF layer filtering, and the component/board 3D views.

## Properties regression follow-up

- Image size/rotation previews retain their deferred copper-refresh policy on
  commit and cancellation. Silk-image edits avoid copper work; copper-image
  edits remain debounced, and changes onto or off copper still refresh pours.
- Arc geometry commands refresh the selected shape's Properties on Undo/Redo,
  keeping the displayed bulge synchronized without rebuilding the panel during
  live dragging.

Focused headless coverage:

```sh
node tools/test.mjs picture-properties arc-properties-history
```

## Confirmed geometry and interaction contracts

- Image and rectangle placement now saves centre, width, height and rotation
  instead of independently rounded corners. Legacy corner records remain
  readable temporarily and migrate on save. Artwork remains lossless; live and
  fabrication geometry retain full precision. See the file-format specification
  for winding and schematic node-identity preservation.
- Exact shape alignment takes priority over grid magnetism when they conflict.
  The grid remains a guide, and Shift bypasses snapping.
- Cancelling a shape-handle drag restores geometry, clearance feedback and fill
  refresh immediately. Committed drags continue to use the existing debounce.

The rectangle-frame regressions cover rotations and both windings, corner/edge
metadata, legacy migration, strict malformed-record rejection, repeated saves,
schematic copy/paste offsets, mixed-project ZIP/autosave round trips and exact
fabrication snapshots:

```sh
node tools/test.mjs rectangle-frame
```

Polygon saves also merge adjacent vertices that become identical at four-decimal
precision, including runs and the closing edge. Surviving metadata is remapped
for PCB/schematic polygons and polygon fills, without changing live or fabrication
geometry. Invalid results and unsafe curve, width or corner-radius combinations
fail explicitly. Coverage includes stable resaves and a mixed-project ZIP
round trip:

```sh
node tools/test.mjs polygon-save-collapse
```

## Rotated rectangle resizing

Corner resizing uses the rectangle's local axes and fixes the opposite corner,
preserving rotation, node order and metadata in schematic/PCB rectangles and
rectangular fills. Fills retain their rectangle kind after a rotated resize.
Uniform rounded outlines also follow the rotated frame, with radii clamped to
actual side lengths rather than the world-aligned bounding box.

Image resizing already scales proportionally about the opposite corner; that
behavior remains unchanged, including its minimum scale and artwork orientation.
Regression coverage checks every corner, both windings, non-cardinal rotations,
crossing the opposite axes, transient collapse/recovery, cancellation, real
Undo/Redo commands, persistence and rounded outlines.

```sh
node tools/test.mjs rotated-rectangle-resize
```

## PCB document reset

New/Open now discard the PCB selection and hover adapters before removing old
artwork, because deselection itself can redraw an object. Selection outlines and
handles are removed, pending drawing previews are cancelled, and the registry
is rebuilt for the replacement document. This prevents selected shapes from
remaining visible or reappearing after their models have been cleared.

Successful New prompts for board dimensions immediately if PCB is active;
otherwise the existing activation prompt handles setup when PCB is next shown.
The previous document's setup dialog is disposed during replacement. Duplicate
setup requests do not stack dialogs, and callbacks from a disposed dialog cannot
change the replacement document. Headless coverage uses the actual dialog
creation/acceptance code as well as the New and activation paths.

```sh
node tools/test.mjs pcb-document-reset pcb-deferred-load project-lifecycle
```

## Home tab after opening a document

Successful New, Open and Open Recent actions return both editors to Home.
Navigation happens after document replacement and file adoption, not when the
button is clicked, so cancelled or failed actions do not request a tab change.
Import and PWA file opening use the same Home navigation.

The project owner dispatches completion through each view's
`onDocumentReplaced(reason)` contract. The schematic no longer manipulates the
PCB's ribbon; each editor owns its own UI response. PCB-specific New setup is
handled by the PCB view, not by the shared project model.

```sh
node tools/test.mjs file-home-tab project-lifecycle project-recovery pcb-document-reset pcb-deferred-load
```

## Future cleanup: remove legacy rectangle formats

TODO: After the user confirms that all existing boards have been resaved in the
centre/width/height/rotation format, remove legacy corner-based loading for images,
PCB rectangles, rectangular copper fills and schematic rectangles. Remove the
associated compatibility normalization and update validation, tests and the
file-format documentation. Keep compatibility until that confirmation.

## Limits

- DRC remains synchronous. The sweep reduces separated candidates but densely
  overlapping bounds can still require quadratic work; no speedup is claimed
  without a benchmark.
- Pad clearance uses shared, posed, conservatively enclosed outlines in DRC
  and the pour engine. Round cutouts enclose their exact circles; Clipper offsets
  include an arc-approximation and integer-rounding allowance so polygon edges
  preserve the requested minimum gap. DRC's clearance tolerance is unchanged.
  Clipper rounds the arc step count, allowing the last chord to span up to
  1.5 steps. The offset allowance therefore covers 2.25 times the nominal arc
  tolerance plus coordinate rounding, not just the nominal tolerance.
- Copper-removal artwork is not subtracted from the other DRC primitives, so it can produce conservative
  false positives. Computed pour holes are respected.
- Preparation failures leave live document content intact. The fallback for
  unexpected rendering/application failures reconstructs prior document content;
  it does not promise restoration of transient selection or undo history.
- PCBApp still owns editor orchestration and interaction UI. This is a scoped
  ownership extraction, not a wholesale rewrite of the facade.