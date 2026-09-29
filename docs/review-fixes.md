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
| Ownership cleanup integration checkpoint | Verified | Commit `c0e65b1`: full gate passes 132/132 files; autorouter 74/76, 288 traces, 214 vias, zero clearance violations. Zero hard failures; the two existing trace/via count warnings are unchanged. No source edits during the run. |
| Automated release gate implementation | Committed, locally verified | Commit `7e03035`: push/PR workflow and tag-specific pre-package gate. Both pass actionlint 1.7.7 (workflow/schema/expression checks; external shellcheck/pyflakes disabled). The unchanged gate command passed the full checkpoint above. |
| Hosted checks and merge protection | Pending authorization | After an authorized push, verify the first hosted run and require Regression gate in branch rulesets. No remote settings, push or release have been performed. |
| Document-completion UI ownership | Implemented, locally verified | ProjectDocument notifies registered views after successful New/Open/Recent/import/PWA; each view owns its own Home navigation. New clears its own registered PCB instead of relying on a global bootstrap. Five focused suites pass. |
| New/reset responsibility boundary | Committed, locally verified | Commit `ae1a6e6`: UI confirms/reports; ProjectDocument coordinates section clearing; editors own their content; FileManager adopts identity and stores the cleared project. Six focused suites pass (lifecycle, recovery, autosave, Home navigation, PCB reset and deferred loading). No new rollback framework. |
| Live DRC scheduling ownership | Committed, locally verified | Commit `4a29e98`: existing scheduler owns visibility and frame coalescing; mutation/fill/picture callers only request checks. Closing the DRC UI suppresses an already queued check. Six focused suites pass: DRC/picture/fill scheduling, shape clearance, handle refresh and fill editing. Pour ordering, drag deferral and the 100 ms geometry debounce remain unchanged. |
| Fill/pad command refresh ownership | Committed, locally verified | Commit `3788629`: direct fill add/remove/modify and undo/redo use one synchronous recompute, not a second scheduled pour. Last-fill removal still restores ratlines immediately. Pad commands leave fill requests to the existing debounce. Both new regressions failed before the fix; eight focused suites pass. Other command refresh calls remain unchanged, including those involved in drag/paste deferral. |
| Project-owned dirty/title notifications | Committed, locally verified | Commit `69dfce4`: PCB reports edits through the existing project callback; the registered UI host refreshes aggregate titles. No global schematic-title lookup and no schematic dirty event for PCB-only edits. Two new regressions failed before the fix; six focused suites pass, including autosave revisions, lifecycle and PCB reset. |
| Project-scoped schematic synchronization | Committed, locally verified | Commit `5b6f03d`: PCB subscribes to and reads its registered schematic, not the global app. Missing registration stays pending. Actual-method regression covers listener preservation, once-only subscription, 300 ms coalescing, latest model data and hidden deferral. Five focused suites pass, including preload, activation and document reset. |
| Project-scoped component access and export naming | Committed, verified | Commit `c0e65b1`: PDF/Gerber/BOM/pick-and-place share project-owned basename lookup with existing defaults. Global app/bootstrap lookups removed from PCBApp and PCB PDF export. Four focused suites and the full gate passed. Component editor decoupling is addressed by the separate boundary below, not merely by changing its lookup. |
| Project component-operation boundary | Committed, verified | Commit `c0e65b1`: detached component info, reference validation, opaque rename commands and netlist queries hide the schematic editor from PCB reference editing/inspection. Schematic owns model mutation; PCB retains its dialogs, previews and history. Existing pure netlist queries moved to core without duplication. Eight focused suites and the full gate passed. This slice does not move model ownership or redesign synchronization subscriptions. |
| Retiring runtime global project discovery | Committed, verified | Commit `c0e65b1`: removed the legacy window.app alias. PCB File-menu actions use their own project; FileManager emits an injected autosave-error callback. User chose the existing alert dialog once per storage-failure streak (the old status method did not exist). Seven focused suites and the full gate passed. window.bootstrap is retained for console inspection only, with no production consumers. |
| Live-session rollback checkpoints | Deferred by user decision | Oversized uncommitted experiment removed. Retain existing serialized Open recovery, including rounding/normalization and loss of Undo/selection on rollback. Exact editing-session recovery is not a release requirement. |
| File > New board-size prompt | Implemented, locally verified | User chose immediate setup in active PCB, deferred until PCB activation after schematic New. Reuses the existing dialog; repeated setup cannot stack dialogs, replacement disposes old dialogs, and stale acceptance cannot mutate the new document. |
| Project-owned schematic model, first slice | Committed, locally verified | Commit `ab723e1`: SchematicDocument owns live collections and data-only load/serialize, lookup/validation, rename/undo and connectivity. Editor collection accessors share the same instances; project commands notify the editor only after model mutation. A new DOM-free acceptance suite and existing reference-edit/load tests cover the boundary. Full test runner: 133/133 files pass; no reported diagnostics in changed production files. Autorouter benchmark was not rerun for this slice. |
| Model-driven PCB synchronization | Committed, locally verified | Commit `c6e9c11`: PCB reads the project-owned model, not the schematic editor. The owning schematic history/dirty callbacks explicitly notify the project, which requests PCB refresh; no callback wrapping/listening flag remains. Eight focused suites pass, covering synchronization without a schematic view, latest data, history/dirty UI callbacks, 300 ms coalescing, hidden/preload behavior, missing-project deferral and PCB-only edit isolation. Net production change: -21 lines. |
| Autosave-success UI boundary | Committed, locally verified | Commit `bf1cdc3`: FileManager emits onAutoSaveSuccess after document/index writes; the UI host injects the indicator from existing UI utilities. Preserves the global 4px blue dot, 250ms retriggerable visibility and styles. Synchronous/asynchronous indicator failures log separately without retrying saved revisions or issuing storage-failure warnings. Six focused suites passed; also covered by the subsequent full test run. |
| Project-owned saved PCB placements | Committed, locally verified | Commit `253b65f`: user chose saved placement/reference state before the whole PCB model. PcbPlacementState owns the override map and record/load/serialize operations; PCB receives its project at construction and aliases the map. Generated footprints, pads, SVG/caches and auto-layout remain editor-owned. DOM-free persistence, map identity, precision/defaults, real move-command undo/redo and reference Canvas/3D/Gerber parity pass. Production net +34 lines. |
| Placement migration integration check | Verified locally | All 134/134 test files pass after updating one constructor-bypassing multi-properties fixture. Autorouter on the same production code: 74/76 connections, 288 traces, 214 vias, zero clearance violations; the two old count warnings remain. The initial full-gate command failed only that fixture; the complete test runner was rerun after its correction, with no production changes or routing rerun. |
| Canonical PCB design settings | Committed, locally verified | Commit `edd886c`: reproduced drift: loading 0.1234 mm clearance read back 0.123 mm; 0.2 mm track width in inch display read back 0.20066 mm. Project-owned millimetre settings now supply routing/persistence. Ribbon and New Track/Via tools share commits; unit changes are display-only, valid edits mark dirty, and user chose last-valid values plus field validation for invalid input. Removed shared two-decimal formatting for these inputs; legacy stored defaults remain readable. All 135/135 test files pass, including 100 unit switches without drift, DOM-free reads, load/save precision, tool-unit parity, invalid edits and refresh notifications. Autorouter benchmark not rerun for this slice. Production net +22 lines. |
| Project-owned PCB copper model | Committed, locally verified | Commit `af8f4ff`: PcbDocument consolidates migrated placement/design state and owns tracks, standalone vias and pads. Copper preparation/load/serialization and ID restoration no longer require an editor or DOM. Editor accessors retain entity identity and existing command behavior. Three temporary-context spreads needed explicit inherited collections; regression tests using actual editor accessors first failed, then passed after fixing drawing, cross-layer drag and bonded Net editing. Final full gate passes: 136/136 test files, 74/76 connections, 288 traces, 214 vias and zero clearance violations; the two old count warnings remain. No reported diagnostics in checked production files; no browser testing. Production net +29 lines. Board shapes and text were still adapter-owned at this checkpoint. |
| Project-owned PCB text | Committed, locally verified | Commit `7ea076c`: PcbDocument now owns the free-standing text map and entity preparation/load/serialization. Creation/defaults and full-precision undo/clipboard snapshots moved out of the renderer into a neutral data module; existing rendering-module imports remain compatible. Save rounding, IDs, layer/side/border behavior, map identity, actual add/move/edit/delete undo/redo and hidden-load/New cleanup are covered. Full runner: 136/136 test files pass, including existing text geometry/highlight/clearance and panelization suites. No reported diagnostics in checked production files. Production net -4 lines. Autorouter benchmark and browser tests were not rerun for this slice. |
| Project-owned board shapes and fills | Committed, locally verified | Commit `f3bbdca`: PcbDocument owns board shapes, copper-fill regions and the shape ID counter. Neutral decoding/serialization reuse existing geometry/artwork helpers; editor adapters retain rendering and command presentation. Headless tests cover artwork references, frames, IDs, outline validation and prepared-object identity; real shape/fill undo/redo and legacy dimension-only outline restoration are covered. The inherited-shape drawing regression first failed and now passes with explicit shape collections in temporary contexts. All 34 focused suites and the final 136/136 test files pass. The full-gate invocation initially failed one constructor-bypassing DRC fixture; its model wiring was corrected without changing assertions or production code. Routing on that same production code passed: 74/76 connections, 288 traces, 214 vias and zero clearance violations; two old count warnings remain. Routing was not repeated after the fixture-only fix. No reported diagnostics in checked production files; no browser testing. Production net +16 lines. |
| Project-owned board dimensions | Committed, locally verified | Commit `46bf788`: PcbDocument owns dimension defaults, restoration and save serialization. Editor dimension accessors share the model; existing outline bounds take precedence over saved metadata, and legacy dimension-only boards remain supported. Headless tests cover both field formats, outline precedence, default restoration, stable state identity and four-decimal save precision. Resize tests use actual editor accessors and verify live previews, undo/redo and cancellation update the model without rounding. A DRC scheduling fixture now declares an enclosing outline instead of relying on absent dimensions to disable clipping; its assertions are unchanged. All 136/136 test files pass. No reported diagnostics in checked production files. Production net +9 lines, no new files. Autorouter benchmark and browser tests were not rerun. |
| Project-owned panelization settings | Committed, locally verified | Commit `b8c9cb5`: PcbDocument owns panelization, with neutral defaults/validation and detached load/save copies preserving precision and noteCreated. Editor accessors retain existing commands and note undo/redo. Preparation rejects invalid settings before replacing live content; explicit late installation preserves preview timing after artwork/pours, including hidden loads and New/reset. Headless layout derivation creates no authored notes. Five focused suites and the final 136/136 test files pass, including panel fabrication output. The initial full run exposed one constructor-bypassing File-menu fixture without its model; wiring was corrected without changing assertions. No reported diagnostics in checked production files. Production net +15 lines. Autorouter benchmark and browser tests were not rerun. |
| Model-owned PCB save assembly and preflight | Committed, locally verified | Commit `8d06a39`: PcbDocument assembles the complete authored PCB section and applies existing compact aliases; the save adapter supplies only optional viewport preferences. Design validation joins entity/panel preflight in the model. Headless tests verify exact section shape, detached snapshots, save precision, compact/long-form round-trips, panel/settings omission and invalid-design rejection before replacement. Existing load/render phasing is unchanged. All 7 focused suites and 136/136 full regression files pass; no reported diagnostics in the two changed production files. Production net +3 lines, no new files. Autorouter benchmark and browser tests were not rerun. |
| Model-owned authored PCB loading | Committed, locally verified | Commit `6a57997`: PcbDocument.load restores authored state headlessly using shared content and panel phases. The editor uses the same content phase and retains late panel installation; design/placement adoption and clearing no longer live in the adapter. Removed obsolete design-loading wrappers; presentation only refreshes controls/local defaults from the model. New and missing design retain last-used settings, partial designs merge without rounding, and collections/submodels retain identity. Five initial focused suites and final 136/136 regression files pass, covering complete compact/long-form round-trips, detached settings, invalid-input preflight, active/hidden loads, reset, notes and preview timing. No reported diagnostics in checked production modules. Production net -14 lines, no new files. Autorouter benchmark and browser tests were not rerun. |
| Project PCB persistence without an editor | Committed, locally verified | Commit `e781140`: ProjectDocument now falls back to the PCB model for preparation, load, save, existing serialized recovery and reset when no PCB view is registered. Loaded viewport preferences are retained as detached fallback data; live viewport ownership remains unchanged. Explicitly loaded metadata-only sections survive, while absent/cleared PCB sections remain omitted despite retained design defaults. Tests cover both no-editor and schematic-only projects, compact/long-form round-trips, model edits, preflight identity preservation, simulated adoption failure/recovery, reset recovery and unchanged registered-view dispatch. Seven focused suites and all 137/137 regression files pass; no reported diagnostics in changed production modules. Production net +18 lines, one new test file. Autorouter benchmark and browser tests were not rerun. |
| Preloaded PCB settings during editor attachment | Committed, locally verified | Commit `638420b`: reproduced initialization replacing loaded 0.123456 mm clearance with a 0.9 mm local default, and a loaded 0.123456 mm grid with the 1.27 mm viewport default. Successful design-model updates now prevent reseeding from local defaults; fresh models retain canonical/legacy default restoration. First viewport creation restores saved grid preferences, while control binding reflects live values in either initialization order without dirtying. Custom grid preservation at this checkpoint is superseded by the fixed-list policy below. Lazy first control edits retain the requested value despite restoration, and metadata-only sections survive saves before viewport creation. Both reproduction suites failed before the fix; six initial focused suites and final 137/137 files pass. No reported diagnostics in checked production modules. Production net +19 lines, no new files. Autorouter benchmark and browser tests were not rerun. |
| Fixed separated grid presets | Committed, locally verified | Commit `899c1c6`: user chose permanent metric equivalents of every inch preset, separated from pure metric sizes, and explicitly chose nearest-preset conversion for saved non-preset grids rather than dynamic options. Shared metric dropdowns use a nonselectable bar with no group headings; inch-derived sizes show inch / mil values in parentheses. The inch list is unchanged. All six inch sizes round-trip through metric exactly; metric-only sizes still select the nearest inch preset. Tests verify fixed values/counts/labels, separator exclusion from selection, nearest conversion with or without controls, no redundant redraw for matching sizes, both editor control paths and loaded settings. Five focused suites and 137/137 regression files passed for the fixed-list implementation; the grid suite was rerun and passes after the final bar/label adjustments. No reported diagnostics in checked production modules. Documentation reflects the intentional behavior change. No browser or autorouter rerun. |
| Viewport conversion and fractional ruler precision | Committed, locally verified | Commit `293ffc9`: reproduced one inch converting to 25.399986284 mm with the truncated reciprocal, inaccurate ruler tick positions, and missing exact 0.125-inch labels. The viewport now uses the 25.4 mm/inch definition; ruler label precision derives from preset spacing and retains 1/8- and 1/16-inch digits. New tests exercise the actual viewport constructor and ruler builder, positive/negative conversions, all inch grid labels, physical tick positions, metric formatting and bounded extreme-zoom output. Three focused regression files pass, including all four new test cases; conversion, position and fractional-label regressions failed before correction. No reported diagnostics in the changed production file. Full suite, browser and autorouter checks were not rerun for this slice. |
| Grid-aligned ruler labels | Committed, locally verified | Commit `293ffc9`: user's 0.1-inch grid example now labels 0.1-inch intervals when zoom permits. Visible-grid labels use the shared adaptive 1-2-5 spacing with an 80-pixel minimum; hidden grids retain unit-based rulers. Both axes and capped large-view output stay grid-aligned, with indexed tick positions avoiding cumulative addition drift. Grid size/visibility changes rebuild labels, while normal panning and line/dot style changes retain the cache. Regressions reproduced missing 0.1-inch labels, off-grid capped ticks and stale rulers. Final three focused files pass, including all eight viewport tests across all presets and supported zoom levels. Test fixtures use scale-consistent bounds and isolate each axis's SVG labels. No reported diagnostics in the changed production file. Full suite, browser and autorouter checks were not rerun. |
| Manufacturing edit guards and detached connection metadata | Committed, locally verified | Commit `bf7f1de`: reproduced export capture accepting an active inline text edit and snapshot connection records changing with the live track. Capture now rejects inline text edits and board-outline resize previews using the existing explicit export error, and copies each track-to-pad connection record before asynchronous preparation. Four focused regression files pass, covering all existing edit guards, the actual resize lifecycle, worker export rejection, two-way metadata isolation, real worker/ZIP generation, Gerber geometry parity and inline text overlay behavior. No reported diagnostics in the changed production file; diff check passes. Full suite, browser and autorouter checks were not rerun. |
| Preloaded board outline during editor attachment | Implemented, locally verified | Reproduced PCBApp constructor treating a model-owned outline as absent after headless loading. Initial outline readiness now comes from the canonical model, without replaying a load or changing geometry. Twenty regression cases cover fresh and metadata-only projects, legacy dimensions, offset circles and polygons, each with direct activation or hidden preload, with and without schematic components; they check outline rendering, setup prompts, authored-state equality, identity and dirtiness. Five focused files pass, including model command/history, persistence, document reset and board-view synchronization. No reported diagnostics in changed code; diff check passes. Full suite, browser and autorouter checks were not rerun. Uncommitted. |
| Single outline render per load/rebuild | Implemented, locally verified | Reproduced two renders of the same outline during persistent-object rebuild and duplicate outline rendering during active load. The general shape batches now skip outlines already rendered by the dedicated path, including the post-footprint batch. Undrawn outlines still render normally, and other board artwork remains above footprint artwork. Five focused files pass, including renderer call-count, retained SVG registration/replacement, active/hidden load, component-present/absent rebuild, preload, persistence and reset coverage. This removes redundant rendering work; browser latency and visual performance were not measured. Full suite and autorouter checks were not rerun. Uncommitted. |
| Curved-segment clearance cache invalidation | Implemented, locally verified | Reproduced a curved line retaining its old clearance contour after an in-place segment-bulge edit with unchanged endpoints. The halo cache key now includes per-segment curvature. Nine shape/layer combinations cover lines and hollow/filled polygons on top copper, bottom copper and hole layers; 36 curvature changes verify exact contour parity, stale-element removal and one recomputation per edit, while unchanged refreshes and translations retain geometry reuse. Four focused files pass, including arc property/history and text-clearance coverage. No reported diagnostics; diff check passes. No full-suite, browser or autorouter rerun. Uncommitted. |
| Footprint culling selection lookup | Implemented, locally verified | Reproduced 512 selection-list reads per culling pass for 512 small footprints, and only the first selected footprint retaining detailed artwork. Culling now uses the existing constant-time selection membership helper, reducing selection-list reads to zero and honoring the complete component selection. Five new headless cases exercise actual PCBApp culling/bounds/transform methods and the selection registry, including a 256-component selection, selection changes, the 24-pixel threshold, overdraw margins, offscreen selection, unchanged-frame DOM/bounds reuse and empty/uninitialized views. Four focused files pass; no reported diagnostics and diff check passes. Browser latency, full-suite and autorouter checks were not rerun. Uncommitted. |
| Data model ownership and representation consistency | In progress | Schematic ownership, explicit synchronization, saved PCB placement/reference ownership, canonical design settings, board dimensions, panelization, PCB entity ownership (tracks/vias/pads/text/board shapes/fills), authored PCB load/save operations and project persistence without editors are delivered. Remaining: entity rendering state, general command/presentation separation and live viewport settings ownership. Preserve IDs, undo/redo, file format and legacy rectangle readers; broader precision and manufacturing conversions still need review. |
| Separation of duties and maintainability | In progress | Completion, New/reset, DRC scheduling, fill/pad refreshes and PCB project lookups are bounded verified slices. First neutral schematic model migration now passes all regressions. Broader private-state coupling remains; avoid generic frameworks and mechanical file splitting. |
| Measured performance | Pending | Define representative boards, latency budgets and repeatable first-interaction/load/switch/dense-board measurements; check visual correctness as well as speed. Browser checks remain user-led unless authorized. |
| Reliability and routing baseline review | Pending | Exercise failure paths and multi-step editing sequences. Review 288 traces/214 vias versus the old 239/174 baseline; the hard routed threshold is still 65 despite current 74/76. Do not merely reset baselines to silence warnings. |
| Current documentation and distribution notices | Pending | Reconcile README, structure, file-format and limitation descriptions; distinguish historical audit results from current guarantees; review licence/notices. |
| Final release acceptance | Pending | Run the full gate on the final revision, complete user-led real-board/browser acceptance and independent manufacturing-output review, record limitations, and obtain release approval. |

### First model-ownership migration

- User chose incremental project ownership rather than separating every entity
  from its renderer at once.
- `ProjectDocument.schematicDocument` now owns the live schematic collections.
  The editor aliases them; load/clear and commands preserve that single store.
- Data construction, persistence, component operations and netlist queries now
  run without either editor. Reference mutation and field-text synchronization
  are shared with schematic property commands; presentation refresh stays in
  the editor callback, outside model operations.
- SVG preparation remains in the editor before its live content is cleared.
  Loaded model instances are adopted directly, not cloned into a second store.
- Acceptance passes for DOM-free component/wire loading, reference rename/undo,
  connectivity, compact-format serialization, field linkage, failed preparation,
  identity preservation and editor load/clear. Existing PCB preview/cancel,
  validation and undo/redo tests also pass. Full test runner: 133/133 files.
- Existing entities still contain rendering state, PCB data is still
  editor-owned, and viewport settings/label layout remain presentation-adapter
  responsibilities. This is not complete model/view separation.

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