# Code Review Follow-Up

This maps the 19 review findings to the corresponding implementation changes.
Behavioral tests and browser verification have not been run for this change.

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

Manual checks remain necessary for file permission/write failures, EasyEDA
import followed by Save, mixed-object marquee cancellation, offscreen and
bottom-side footprints, PDF layer filtering, and the component/board 3D views.

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