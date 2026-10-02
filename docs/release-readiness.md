# Release Readiness

Open items before a release, and the working agreements for changes. Completed
milestones, the original review findings and their verification are archived in
[archive/review-fixes.md](archive/review-fixes.md). Rows are copied verbatim from that
tracker as of 2026-10-02; update them here from now on.

## Open items

| Milestone | Status | Evidence required / remaining work |
| --- | --- | --- |
| Hosted checks and merge protection | Pending authorization | After an authorized push, verify the first hosted run and require Regression gate in branch rulesets. No remote settings, push or release have been performed. |
| Live-session rollback checkpoints | Deferred by user decision | Oversized uncommitted experiment removed. Retain existing serialized Open recovery, including rounding/normalization and loss of Undo/selection on rollback. Exact editing-session recovery is not a release requirement. |
| Separation of duties and maintainability | In progress | Completion, New/reset, DRC scheduling, fill/pad refreshes and PCB project lookups are bounded verified slices. First neutral schematic model migration now passes all regressions. Broader private-state coupling remains; avoid generic frameworks and mechanical file splitting. |
| Rendered via-drag handler benchmark | Isolated browser evidence | A native-pointer fixture rendered all 201 tracks (8,002 graph nodes) with normal snapping and actual SVG, without app bootstrap or user data. Pickup measured 1.3 ms; first move 7.2 ms; 50 moves had median 1.7 ms/max 7.2 ms. Canonical serialization remained identical throughout, and cancellation retained empty history and exactly 201 track polylines without duplicates. Clearance/pour hooks and the ratline layer were intentionally absent: this measures pickup/snap/preview-SVG handler work, not full PCBApp or end-to-end frame latency. |
| KiCad early background loading and failure recovery | Early loading restored; recovery fixes retained | Schematic startup immediately starts index loading without awaiting it, intentionally hiding download latency before the first picker use. The on-demand-only experiment was rejected and reverted at the user's direction. Opening/searching joins the existing request or uses its warmed result; cache hydration and stale refresh remain fetcher-owned. Exhausted refs still reject explicitly instead of leaving Connecting active forever, and first-search initialization remains inside the normal catch/finally error path. Three focused files pass, including startup continuation while downloading, one shared startup/picker request, progress attachment, visible failures, retry and cached reopening. A controlled native full-app check holds the index response: the application becomes ready with the picker closed and one index download already pending; opening the picker joins it, and the completed 100-library index is reused without a second download. No external request or native storage access was allowed by the fixture. |
| Current documentation and distribution notices | Ownership documentation reconciled; distribution review pending | README and architecture now describe model-owned entities/persistence and detached previews, retaining file format 1.0 and distinguishing historical milestones from current guarantees. Standalone licence/notices and distribution approval remain separate release work. |
| Final release acceptance | Pending | Run the full gate on the final revision, complete user-led real-board/browser acceptance and independent manufacturing-output review, record limitations, and obtain release approval. |

## Working agreements

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
