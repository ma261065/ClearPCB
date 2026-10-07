# Release Readiness

Open items before a release, and the working agreements for changes. Completed
milestones are recorded in the git history.

## Open items

| Milestone | Status | Evidence required / remaining work |
| --- | --- | --- |
| Hosted checks and merge protection | Hosted checks passing; merge protection pending | **Regression Checks** runs the Regression gate, Type check and the four Browser tests shards on every push to `dev` and on pull requests (see [releases](releases.md#automated-regression-gate)). The type-check baseline is empty, so any type error fails. Remaining: require those checks in the `dev`/`release_*` branch rulesets (see [releases](releases.md#branch-protection)). |
| Live-session rollback checkpoints | Deferred by user decision | Open recovery stays serialized: it keeps rounding/normalization and loses Undo and selection on rollback. Exact editing-session recovery is not a release requirement. |
| Separation of duties and maintainability | In progress | In place: one registry of in-progress interactions per editor (`pcb-interactions.js`, `schematic-interactions.js`), through which the PCB routes pointer moves, releases and cancels and the schematic routes cancels; public editor services (`pcb-editor-api.js`, `schematic-editor-api.js`); module-owned state (e.g. `property-editors.js`, `refresh-state.js`, `board-shape-state.js`, `drc-state.js`, `shape-focus.js`, `clearance-overlay.js`, `picture-refresh.js`, `track-select.js`, `track-draw.js`, `track-connections.js`, `track-commit.js`, `save-toast.js`, `svg-defs.js`, `layers.js`, and the schematic's owner modules); shared code in `src/shared/` with no import violations; one entity ID allocator; PCB model commands separate from editor commands; PCB tools, mouse, keyboard, overlays and dialogs in `pcb/modules`, with `PCBApp` keeping thin seams. All source is type-checked with no opt-outs. The gate enforces import directions and ratchets both editors' private accesses: the schematic's are gone; the PCB's are down to 23 (from 287). Remaining: 23 PCB accesses: project load/lifecycle state in `project-state.js` (`_stale`, `_isDirty`, `_ensureViewport`, `_applyPlacementOverrides`, `_cancelAutoRoute`, `_cancelDrawingMode`); preview-cancel seams (`_cancelPosePreviews`) used by load/paste/layer protection; selection-highlight repaint seams (`_refreshPcbSelectionHighlights`); Properties/component seams (`_showPcbMultiSelectionProperties`, `_showPadProperties`, `_selectComponent`, `_syncComponentRotationInput`) where editor-hosted panels remain; and command/test seams (`_markDirty`, `_renderRoutedCopper`) tied to history dirtying and routed-copper rendering. Schematic previews edit authored entities by design (see [schematic contracts](contracts/schematic.md)). Avoid generic frameworks and mechanical file splitting. |
| Planned hardening | Partly done | Done: the browser scenarios run on every push in CI (four parallel shards, offline), and locally with `node tools/browser-test.mjs`. Remaining: add a document validator that runs on load, save and recovery; add automated speed checks for pointer moves, panel rebuilds, pour refresh and picture load. |
| Rendered via-drag handler benchmark | Isolated browser evidence | A native-pointer fixture rendered all 201 tracks (8,002 graph nodes) with normal snapping and actual SVG, without app bootstrap or user data. Pickup measured 1.3 ms; first move 7.2 ms; 50 moves had median 1.7 ms/max 7.2 ms. Canonical serialization remained identical throughout, and cancellation retained empty history and exactly 201 track polylines without duplicates. Clearance/pour hooks and the ratline layer were intentionally absent: this measures pickup/snap/preview-SVG handler work, not full PCBApp or end-to-end frame latency. |
| KiCad index loading and failure recovery | Implemented | Schematic startup starts loading the KiCad index without awaiting it, hiding download latency before the first picker use. Opening or searching joins the pending request or uses its result; cache hydration and stale refresh stay in the fetcher. Exhausted refs reject explicitly instead of leaving Connecting active, and first-search initialization stays inside the normal error path. Focused tests cover startup while downloading, one shared startup/picker request, progress, visible failures, retry and cached reopening. Stable releases publish a prebuilt index (`assets/kicad-index.json`) that the app loads first, falling back to live loading; a weekly workflow reports when it is missing or behind KiCad (see [releases](releases.md#kicad-library-index)). Not yet verified on clearpcb.org: the first release that includes it will. |
| Current documentation and distribution notices | Documentation reviewed against the code; distribution review pending | README, architecture, contracts and format docs were reviewed against the code and outdated material removed (2026-10-05). Standalone licence/notices and distribution approval remain separate release work. |
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
