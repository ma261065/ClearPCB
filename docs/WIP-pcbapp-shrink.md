# Work in progress: shrinking PCBApp

Handoff note for the PCBApp reduction (item 2 of the 2026-10-04 assessment). Delete this
file when the work is finished.

## Where we are

`src/ui/PCBApp.js` went from 7,254 to 5,267 lines. PCB modules' private editor accesses
went from 296 to 280, then rose to 294 with the mouse move (agreed with the user: moving
458 lines that touch 47 editor members could not be access-neutral; see below). Every step
passed the full gate (`node tools/regression.mjs`, 282/282) with no new type errors, and
was checked in the browser.

| Commit | Step |
|---|---|
| `263edd8` | Router input moved to `pcb/modules/route-input.js`; five forwarders replaced by direct module calls |
| `2d466ef` | Inline text editing moved to `pcb/modules/text-inline-edit.js`; `selectText`, `showTextProperties` became services |
| `0c957c8` | Keyboard shortcuts moved to `pcb/modules/keyboard.js`; drawing tools handle their own keys |
| `53385dc` | Clearance overlay moved to `pcb/modules/clearance-overlay.js`; `existingLayerGroups()` service |
| `064e89d` | Copper cuts and removal hatches moved to `pcb/modules/copper-cuts.js`; dead SVG-pattern hatch removed |
| `6e73fef` | Footprint debug tooltip moved to `pcb/modules/debug-tooltip.js` |
| (next) | Mouse binding moved to `pcb/modules/mouse.js`; release handlers in the interaction table |

The mouse move kept new accesses down by moving mouse-up finishing into `release`
handlers in `pcb-interaction-routing.js` (which already reads those fields), making the
right-click/pan gesture state module state, and adding getters in the modules that own
drawing and inline-edit state (`getTrackDraw`, `getFillDraw`, `getShapeDraw`,
`activeTextInlineEdit`). The 12 members `mouse.js` still reads (`_screenToWorld`, the
hit tests, tool previews) are candidates for services.

## Next steps

1. **Smaller clusters:** layer visibility and lock changes (208 lines); the board
   dimensions dialog (120 lines).
2. Optionally win back mouse.js accesses: make `screenToWorld`, `hitTestText`,
   `hitTestFill` and `hitTestComponent` editor services.

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
  (`C:\Program Files\Git\cmd`, `C:\Program Files\nodejs`). TypeScript 5.9.3 is installed
  outside the repo; set `TSC=%LOCALAPPDATA%\clearpcb-tsc\node_modules\typescript\lib\tsc.js`
  for `node tools/typecheck.mjs`.

## Other open items

- Install Playwright locally once npm is reachable, so the browser scenarios
  (including `browser-tests/schematic-cancel-isolation.mjs`) run in the local gate, not
  only in CI.
- Add a document validator that runs on load, save and recovery.
- Add automated speed checks: pointer moves, panel rebuilds, pour refresh, picture load.
