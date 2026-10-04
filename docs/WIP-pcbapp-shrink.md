# Work in progress: shrinking PCBApp

Handoff note for the PCBApp reduction (item 2 of the 2026-10-04 assessment). Delete this
file when the work is finished.

## Where we are

`src/ui/PCBApp.js` went from 7,254 to 6,101 lines, and PCB modules' private editor
accesses from 296 to 281. Every step passed the full gate (`node tools/regression.mjs`,
282/282) with no new type errors, and was checked in the browser.

| Commit | Step |
|---|---|
| `263edd8` | Router input moved to `pcb/modules/route-input.js`; five forwarders replaced by direct module calls |
| `2d466ef` | Inline text editing moved to `pcb/modules/text-inline-edit.js`; `selectText`, `showTextProperties` became services |
| `0c957c8` | Keyboard shortcuts moved to `pcb/modules/keyboard.js`; drawing tools handle their own keys |
| `53385dc` | Clearance overlay moved to `pcb/modules/clearance-overlay.js`; `existingLayerGroups()` service |

## Next steps

1. **Copper cuts and removal hatches** (about 190 lines). Move `updateCopperCuts`,
   `_renderRemovalHatches`, `_scheduleRemovalHatchRender`, `_ensureCopperRemovalHatch`,
   `_setCopperRemovalHatchMetrics`, `_syncCopperRemovalHatches` and the copper-cut part of
   the board reset into `pcb/modules/copper-cuts.js`.
   - Make `_copperCutCache`, `_removalHatchCanvas`, `_removalHatchPatterns` and
     `_removalHatchFrame` module state (a WeakMap per editor).
   - Keep `_copperCutGeometry` and `_hasCopperCuts` on the editor: tests read them.
   - Keep `_scheduleRemovalHatchRender` as a one-line seam: 12 tests stub it.
2. **Mouse binding.** `_bindMouseEvents` is 458 lines. Move it to `pcb/modules/mouse.js`,
   like `schematic/modules/mouse.js`. It touches 47 private members, so split it by event
   first (mousedown already routes to per-tool handlers).
3. **Smaller clusters:** layer visibility and lock changes (208 lines); the board
   dimensions dialog (120 lines); the debug tooltip (58 lines).

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

## Other open items

- Install Playwright locally once npm is reachable, so the browser scenarios
  (including `browser-tests/schematic-cancel-isolation.mjs`) run in the local gate, not
  only in CI.
- Add a document validator that runs on load, save and recovery.
- Add automated speed checks: pointer moves, panel rebuilds, pour refresh, picture load.
