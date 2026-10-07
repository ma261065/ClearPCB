# Developer Guide

Start here if you are new to the code. This page gives the mental model, follows
one edit from click to screen, and has recipes for the changes people make most.
It links to the reference pages rather than repeating them:

- [project_structure.md](project_structure.md): the layout, import rules, state
  ownership, the owner index (who owns what) and the checks.
- [module-contracts.md](module-contracts.md): how each area behaves, one page per
  area.
- [clearpcb_file_format.md](clearpcb_file_format.md): the saved `.cpcb` format.

## The Mental Model

ClearPCB is vanilla JavaScript ES modules with no build step: the browser loads
`src/**` directly. Six ideas explain most of the code.

1. **One document, two views.** `core/ProjectDocument.js` owns the one project:
   a `SchematicDocument`, a `PcbDocument` and the `FileManager`. `SchematicApp`
   and `PCBApp` (`src/ui/`) are peer views of it; neither owns the other, and
   shared code (`core`, `shapes`, `components`, `shared`) never imports either
   editor. `tools/check-imports.mjs` enforces the directions.
2. **Editors are thin hosts; modules do the work.** `schematic/modules/` and
   `pcb/modules/` export plain functions that take the editor as their first
   argument (`showViaProperties(app, via)`). The editor class coordinates the
   viewport, document, history, lifecycle and the Properties/ribbon hosts.
3. **Each piece of state has one owner.** A module keeps the state it owns in a
   module-level `WeakMap` keyed by the editor and exposes functions to read and
   change it (`fillToolDefaults(app)` / `setFillToolDefaults(app, …)` in
   `copper-fill-draw.js`, `getBoardViewPanel(app)` in `refresh-state.js`,
   `getLastCrosshairWorld(app)` in `cursor-state.js`). Other modules call those functions; they do not reach
   into `app._something`. What the editor itself provides, modules reach through
   its public services (`pcb/modules/pcb-editor-api.js`,
   `schematic/modules/schematic-editor-api.js`). Two ratchets count the private
   accesses that remain, and the counts may only fall.
4. **Every authored change is a command.** A command changes the model and can
   undo itself; `core/CommandHistory` runs it. PCB *model* commands
   (`core/pcb-*-commands.js`) change only `PcbDocument`; *editor* commands
   (`pcb/modules/*-commands.js`) subclass them to re-render and refresh derived
   views. Every command declares what it changes with `lockTargets()`, and the
   history's **lock gate** (`core/edit-guard.js`) refuses one that would change a
   locked object.
5. **Gestures are previews until they commit.** Drags, spinner runs and live
   outlines change a copy that is drawn on screen; the model changes once, through
   one command, when the gesture ends. Escape discards the copy. In-progress
   gestures are listed in one table (`pcb/modules/pcb-interactions.js`,
   `schematic/modules/schematic-interactions.js`) so cancel, save and export can
   ask "is anything in progress?".
6. **UI is described as data and drawn by one renderer.** A Properties panel is a
   description (title, fields, actions) that `shared/ui/property-fields.js`
   renders. The ribbons are descriptions (`*/modules/ribbon-description.js`) that
   `shared/ui/ribbon.js` renders; `index.html` has only empty hosts. Description
   modules never touch the DOM (`test-property-panels-logic-only`,
   `test-ribbons-logic-only`), so a new look changes the renderers only.

## The Life of an Edit

Following one change through the PCB editor shows how the pieces fit: the user
selects a via and clicks the Diameter spinner up three times.

1. **Selection to panel.** Selecting the via calls `showViaProperties`
   (`pcb/modules/track-select.js`). It builds a `describe()` function returning a
   `PropertyPanel`, starting with `lockedProperty(app, entries)` (the Locked row
   and whether the panel is read-only), and hands it to the editor's host,
   `app.openPropertyPanel(describe())`.
2. **Render.** `renderPropertyFields` creates the controls, in the canonical order
   from `shared/ui/property-order.js`, and tags each row with `data-prop`.
3. **Each click previews.** The renderer passes each value through the field's
   `normalize` (NaN rejects it), then calls `preview`. The via panel copies the
   via, changes the copy and redraws it; the model is unchanged.
4. **The run settles, then commits once.** `shared/ui/settled-input.js` waits for
   a quiet period (or Enter, or blur) and calls `commit` once for the whole run.
   Undo, save, export and switching editors call `flushSettledChanges()` first, so
   a settling run is never lost.
5. **Command and lock gate.** The commit runs
   `app.history.execute(new ModifyViaCommand(app, via, before, after))`. The
   history's lock gate checks `lockTargets()`; a locked via is refused with a
   message and nothing changes.
6. **Model and derived views.** The model command applies the new state; the
   editor subclass (`pcb/modules/track-commands.js`) re-renders the via and
   refreshes clearance halos and the ratsnest. Pours and DRC follow through their
   coalescing refresh modules (`fill-refresh.js`, `drc-refresh.js`).
7. **Panel and ribbon catch up.** The panel describes itself again and the
   renderer reconciles rows by key, updating in place; the history's change hook
   refreshes the ribbon (Undo is now enabled). Undo runs the command's `undo` and
   the same refreshes.

The schematic follows the same path with its own host
(`schematic/modules/property-host.js`), commands (`schematic/modules/commands.js`)
and lock gate.

## Recipes

Each recipe lists what to touch and which check catches a mistake. Update the
area's contract page in [module-contracts.md](module-contracts.md) in the same
commit when behaviour changes.

### Add a field to an existing Properties panel

1. Find the panel's `describe()` (the owner index in
   [project_structure.md](project_structure.md) names the module).
2. Add a field: `{ key, id, type, label, value, … }`. Use the shared label for
   the property (see [UI Conventions](contracts/ui-conventions.md)); for numbers
   give `min`/`max`/`step`, a `normalize` that returns NaN for invalid input, a
   `preview` if it should show live, and a `commit` that executes one command.
3. Rank the key in `PROPERTY_ORDER` (`shared/ui/property-order.js`) if it is new;
   `test-property-order` fails otherwise.
4. Respect locks: compute `lockedProperty(app, entries)` *inside* `describe()`
   and disable the field when `readOnly`. Computing it outside leaves a stale
   Locked checkbox after the lock changes.
5. Never build or patch controls. To change what the panel shows, describe it
   again (`app.refreshPropertyPanel(describe())`).

### Add a Properties panel for a new object

Write a `show…Properties(app, object)` function in the object's module, shaped
like `showViaProperties` or `showFillToolProperties` (`copper-fill-edit.js`, a
small panel for a tool's defaults). Return a description; open it with
`app.openPropertyPanel` (PCB) or the schematic host. Live previews follow the
preview-then-commit-once pattern above. Drive it in a unit test with the fake DOM
(`tests/unit/test-picture-properties.mjs` is a compact example).

### Add a ribbon button or control

1. Add an item to the editor's description (`pcb/modules/ribbon-description.js` or
   `schematic/modules/ribbon-description.js`): a stable `id`, `title`, `content`,
   and behaviour (`run`, `onChange`, `onInput`) plus state accessors (`active`,
   `disabled`, `checked`, `value`). Existing items are the best examples; the
   tool buttons and Undo/Redo show the common cases.
2. State accessors are re-read when the editor refreshes its ribbon, so they read
   current state instead of being pushed values.
3. No DOM in descriptions and no controls in `index.html`;
   `test-ribbons-logic-only` enforces both. New control *shapes* belong in
   `shared/ui/ribbon.js`.

### Add a model command

1. Add the class to the right `core/pcb-*-commands.js` (or
   `schematic/modules/commands.js`) with `execute()`, `undo()` and `lockTargets()`.
   `lockTargets()` returns `{ kind, object }` for each object the command changes or
   removes; `editTargets(kind, object, before, after)` covers modify commands, and
   additions return `[]`. `test-edit-guard` fails if a command class has none.
2. For the PCB, subclass it in the editor's command module
   (`pcb/modules/track-commands.js` and friends) to re-render and refresh derived
   views, keeping the same name.
3. Several changes that are one user action go in one `CompoundCommand`, so they
   undo together.

### Add a PCB tool

1. Ribbon: a `toolButton` in `pcb/modules/ribbon-description.js` whose `run`
   selects the tool and whose `active` reads `normalizePcbTool(app.currentTool)`.
2. Lifecycle: register the tool in `pcb/modules/tool-lifecycle.js`
   (`PCB_CROSSHAIR_TOOLS` for a crosshair; `selectPcbTool` opens its "New …"
   Properties panel, like the Fill tool, and a tool with such a panel also goes in
   `PCB_PROPERTIES_TOOLS`, so presses on the canvas keep the Properties tab open).
   Multi-click drawing finishes like the others: double-click or Enter with the
   corners placed, a stationary right-click with the cursor as the last corner.
3. Presses: add the tool's press handler to `PCB_TOOL_PRESS_HANDLERS`
   (`pcb/modules/mouse.js`); `test-pcb-pointer-press` checks the routing.
4. In-progress state: a drawing session or drag is a slot in `PCB_INTERACTIONS`
   (`pcb/modules/pcb-interactions.js`) naming its owner module, with its move,
   release and cancel handlers in `pcb-interaction-routing.js`. Only the owner
   writes the slot (`setPcbInteraction`); other modules call the owner's
   functions (`getFillDraw`, `endRefDrag`, …). `test-pcb-interaction-registry`
   fails if a slot is unregistered or written outside its owner.
5. Finish with one command (above) and add a browser scenario.

Schematic tools follow the same shape: `schematic/modules/tool.js`
(`onToolSelected`), `draw-states.js`, `schematic-interactions.js` and the
schematic ribbon description.

### Add state an editor needs

Put it in the module that owns the behaviour, in a `WeakMap` keyed by the editor,
with exported functions to read and change it. Do not add an `app._field` that
other modules read: the access checks fail on any private access. If many
modules need an editor capability, add a public method on the editor and list it
in `pcb-editor-api.js` (or `schematic-editor-api.js`). See State Ownership in
[project_structure.md](project_structure.md#state-ownership).

## Tests

- **Unit and regression tests** are `tests/unit/test-*.mjs`, plain Node scripts using
  `node:assert`. They call real functions: PCB editor code runs on
  `tests/unit/pcb-editor-fixture.mjs` (real undo history and lock gate), and DOM code on
  `installFakeDom()` from `tests/unit/helpers/fake-dom.mjs`. Run one with
  `node tools/test.mjs <name>`.
- **Browser scenarios** are `tests/browser/*.mjs`, each exporting
  `scenarios: [{ name, run(page, url) }]`, driven by Playwright in headless
  Chromium. Use the helpers in `tests/browser/helpers/editor-helpers.mjs`
  (`openPcb`, `clickWorld`, `dragWorld`, `stepSpinnerOneRun`, `undoPcb`,
  `saveAndReopen`, …); `pcb-object-workflows.mjs` and
  `schematic-object-workflows.mjs` walk each object type through place, select,
  edit, move, lock, undo and save/reopen. Run a subset with
  `node tools/browser-test.mjs <name filter>`; `HEADED=1` shows the browser and
  `CPU_THROTTLE=4` slows the page like a CI runner. `speed-checks.mjs` loads a large
  board and checks main-thread time for hover and drag moves, Properties panel
  rebuilds, pour refresh and picture import against budgets at the top of the file
  (scaled by `CPU_THROTTLE`); raise a budget only with the reason in the commit. Pages run offline (only the
  local server answers; `ALLOW_NETWORK=1` lifts that), so a scenario must not need
  the KiCad library or other remote data. CI runs them on Linux, where
  fonts (and so text sizes and the canvas height) differ from Windows and macOS:
  click relative to where the model says an object is, not at offsets from the
  view centre, and check what got selected before editing it.

## Before You Commit

Run the gate (setup for TypeScript and Playwright is in the
[README](../README.md#testing)):

```
node tools/typecheck.mjs
node tools/regression.mjs
node tools/browser-test.mjs
```

`regression.mjs` covers the import rules, both private-access ratchets, every unit
test and the autorouter baseline. When a ratchet reports resolved accesses, remove
them from its baseline so the count only falls. Files use LF line endings
(`.gitattributes`). A local pass is not the last word: after pushing, check that
the Regression Checks workflow is green on CI, which runs the browser tests on Linux.
