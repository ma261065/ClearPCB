# Work in progress: shrinking PCBApp

Handoff note for the PCBApp reduction (item 2 of the 2026-10-04 assessment). Delete this
file when the work is finished.

## Where we are

`src/ui/PCBApp.js` went from 7,254 to 4,998 lines. PCB modules' private editor accesses
went from 296 to 280, then rose to 305 with the last three moves (agreed with the user:
the mouse binding and layer handlers touch dozens of editor members and could not be
access-neutral; see below). Every step passed the full gate (`node tools/regression.mjs`,
282/282) with no new type errors, and was checked in the browser.

| Commit | Step |
|---|---|
| `263edd8` | Router input moved to `pcb/modules/route-input.js`; five forwarders replaced by direct module calls |
| `2d466ef` | Inline text editing moved to `pcb/modules/text-inline-edit.js`; `selectText`, `showTextProperties` became services |
| `0c957c8` | Keyboard shortcuts moved to `pcb/modules/keyboard.js`; drawing tools handle their own keys |
| `53385dc` | Clearance overlay moved to `pcb/modules/clearance-overlay.js`; `existingLayerGroups()` service |
| `064e89d` | Copper cuts and removal hatches moved to `pcb/modules/copper-cuts.js`; dead SVG-pattern hatch removed |
| `6e73fef` | Footprint debug tooltip moved to `pcb/modules/debug-tooltip.js` |
| `fbbea29` | Mouse binding moved to `pcb/modules/mouse.js`; release handlers in the interaction table (+14 accesses) |
| `2abbe9e` | Board Dimensions dialog moved to `pcb/modules/board-outline-resize.js` (+1: `_markDirty`) |
| `00b5e47` | Layer visibility/lock handlers moved to `pcb/modules/layer-changes.js` (+10) |

The moves kept new accesses down by using module getters for interaction state
(`getTrackDraw`, `getFillDraw`, `getShapeDraw`, `activeTextInlineEdit`, `getGroupDrag`,
`getBoardShapeDrag`, `getVertexDrag`, `getSelectionInteraction`, `isBoardOutlineSelected`)
and by putting mouse-up finishing in `release` handlers in `pcb-interaction-routing.js`.
What remains are members tests stub or count through (`_cancelPosePreviews`,
`_cancelPasteDrop`, `_scheduleRemovalHatchRender`, `_markDirty`, â€¦) and editor methods
with no service yet.

## Next steps

All planned PCBApp moves are done. Optional follow-up to win back accesses:

1. Make `screenToWorld`, `hitTestText`, `hitTestFill` and `hitTestComponent` editor
   services (mouse.js).
2. Make `markDirty` a service (used by controls, design-settings, track-commands and
   board-outline-resize; 19 test files stub `_markDirty`).

## How each step is done

- Look up who uses each private member (src, tests, browser-tests) before moving anything.
  A member that tests stub or count through stays on PCBApp as a one-line seam;
  everything else becomes module state or a public service in
  `pcb/modules/pcb-editor-api.js`.
- After moving, check:
  - type checking reports no undefined names (`TS2304`/`TS2552`);
  - `node tools/check-pcb-editor-access.mjs` shows a net reduction, then `--update`;
  - the full suite, then the full gate;
  - a type comparison against the previous commit, which must show no new errors.
- Prune now-unused PCBApp imports only when another module still imports that module.
- Browser check: `node tools/serve.mjs 8790`, open the PCB tab, and exercise the moved
  feature.
- Tooling on this machine: Git and Node.js are not on the default PATH in fresh shells
  (`C:\Program Files\Git\cmd`, `C:\Program Files\nodejs`). TypeScript 5.9.3 and
  Playwright 1.55.0 (with Chromium) are installed in the repo's git-ignored
  `node_modules`, as CI does, so `node tools/typecheck.mjs` and
  `node tools/browser-test.mjs` need no `TSC`/`PLAYWRIGHT` settings. Reinstall with
  `npm install --no-save --no-package-lock --ignore-scripts typescript@5.9.3 playwright@1.55.0`
  then `npx playwright install chromium`.

## Other open items

- Run the browser scenarios (17, about 2 minutes; Playwright is now installed locally)
  from the local gate, or document running them alongside it.
- Add a document validator that runs on load, save and recovery.
- Add automated speed checks: pointer moves, panel rebuilds, pour refresh, picture load.
