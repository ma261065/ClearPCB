# Developer Guide

Start here if you are new to the code. This page gives the mental model, follows
one edit from click to screen, and has recipes for the changes people make most.
It links to the reference pages rather than repeating them:

- [project_structure.md](project_structure.md): the layout, import rules, state
  ownership, the owner index (who owns what) and the checks.
- [module-contracts.md](module-contracts.md): how each area behaves, one page per
  area.
- [clearpcb_file_format.md](clearpcb_file_format.md): the saved `.cpcb` format.

If you are taking the code over, read [Handover: Where Things Stand](#handover-where-things-stand)
for what is enforced, what is unfinished and the routine before pushing.

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
   `schematic/modules/schematic-editor-api.js`). The gate fails on any module or
   shared code that uses an editor's private (`_`-prefixed) members.
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
   (`pcb/modules/via-properties.js`). It builds a `describe()` function returning a
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

1. An entry in `PCB_TOOLS` (`pcb/modules/pcb-tools.js`) names everything about the
   tool: its `press` (a function in its owner module, like `pressViaTool`), its
   `targets` (the layers it places on: this makes it a placement tool, with a
   crosshair and its own "New …" Properties panel, `showProperties`, and presses
   refused with the reason on a locked or hidden layer), `drawing` if presses
   continue a draw, `hover` or `follow` for pointer movement, the `layer` the
   status bar names, its status-bar `tip`, and its ribbon `button`. The ribbon places the button with
   `toolButton(id)` in `ribbon-description.js`. Multi-click drawing finishes like
   the others: double-click or Enter with the corners placed, a stationary
   right-click with the cursor as the last corner.
2. `test-pcb-tools` checks the entry's shape; add the tool to
   `test-pcb-pointer-press`, which checks that a real press does what it should.
3. In-progress state: a drawing session or drag is a slot in `PCB_INTERACTIONS`
   (`pcb/modules/pcb-interactions.js`) naming its owner module, with its move,
   release and cancel handlers in `pcb-interaction-routing.js`. Only the owner
   writes the slot (`setPcbInteraction`); other modules call the owner's
   functions (`getFillDraw`, `endRefDrag`, …). `test-pcb-interaction-registry`
   fails if a slot is unregistered or written outside its owner.
4. Finish with one command (above) and add a browser scenario.

Schematic tools follow the same shape: an entry in `SCHEMATIC_TOOLS`
(`schematic/modules/schematic-tools.js`) names the tool's shortcut, ribbon label,
set-up when chosen, and its press, move, release and finishing hooks, which the
mouse states in `draw-states.js`, the keyboard, `onToolSelected` and the ribbon
read; `test-schematic-tools` checks the entry and its draws.

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
  `tests/unit/pcb-editor-fixture.mjs` (real undo history and lock gate; a test that
  needs only a plain-object editor spreads `pcbEditorStubs()` or
  `schematicEditorStubs()` from `tests/unit/helpers/`), and DOM code on
  `installFakeDom()` from `tests/unit/helpers/fake-dom.mjs` (never a hand-rolled
  `globalThis.document`). Run one with
  `node tools/test.mjs <name>`. A test that passes but prints a `TypeError`,
  `ReferenceError`, `SyntaxError` or `RangeError` fails: some handler caught and logged a
  programming error, usually because the fixture lacks something the real editor has.
  A test that exercises such a path on purpose replaces `console.error` for that step.
- **Browser scenarios** are `tests/browser/*.mjs`, each exporting
  `scenarios: [{ name, run(page, url) }]`, driven by Playwright in headless
  Chromium. Use the helpers in `tests/browser/helpers/editor-helpers.mjs`
  (`openPcb`, `clickWorld`, `dragWorld`, `stepSpinnerOneRun`, `undoPcb`,
  `saveAndReopen`, …); `pcb-object-workflows.mjs` and
  `schematic-object-workflows.mjs` walk each object type through place, select,
  edit, move, lock, undo and save/reopen. Run a subset with
  `node tools/browser-test.mjs <name filter>`; `HEADED=1` shows the browser and
  `CPU_THROTTLE=4` slows the page like a CI runner. `speed-checks.mjs` loads a large
  board and checks main-thread CPU time for hover and drag moves, Properties panel
  rebuilds, pour refresh and picture import against budgets at the top of the file.
  CPU time does not grow when the machine is busy or the page is throttled, so only
  the wall-time load budget scales with `CPU_THROTTLE`; raise a budget only with the
  reason in the commit. Pages run offline (only the
  local server answers; `ALLOW_NETWORK=1` lifts that), so a scenario must not need
  the KiCad library or other remote data. CI runs them on Linux, where
  fonts (and so text sizes and the canvas height) differ from Windows and macOS:
  click relative to where the model says an object is, not at offsets from the
  view centre, and check what got selected before editing it.

## Before You Commit

Run these before pushing (setup for TypeScript and Playwright is in the
[README](../README.md#testing)):

1. `node tools/typecheck.mjs`: TypeScript `checkJs` uses `jsconfig.json` with
   `strict: true`; any error fails. Type new code fully: JSDoc on every parameter,
   null cases handled, and callbacks typed to accept every value their caller may pass.
   A PCB module types the editor as `PcbEditor` and plain board data as `PcbBoard`
   (`pcb-editor-api.js`); a schematic module types the editor as `SchematicEditor`
   (`schematic-editor-api.js`) and its objects as `SchematicShape`. Keep all of a
   declaration's tags in one JSDoc block: the type check reads only the block
   nearest the declaration, and `typecheck.mjs` fails on tags it would ignore.
2. `node tools/regression.mjs`: the gate. It checks the import directions, that no
   module or shared code uses an editor's private members, that every file, test and page a doc
   names exists (so rename or update the doc with the code), runs every unit test,
   and routes the autorouter's fixture board against its baseline. It takes a few
   minutes, most of it routing.
3. `node tools/browser-test.mjs`: the browser scenarios. For changes to timing,
   rendering or input, also run two full runs at once (`--shard=1/4` to
   `--shard=4/4` twice, in parallel) to load the machine the way a CI runner is.
4. Push, then check that the Regression Checks workflow is green on CI, which runs
   all three, with the browser tests on Linux.

Files use LF line endings (`.gitattributes`).

## Handover: Where Things Stand

The structure is enforced rather than documented only: the gate fails on an import
that crosses a layer, on a module that reaches an editor's private members, on an
optional call to an editor method (`app.method?.()`), on a doc that names a file
that no longer exists, and on any strict type error. The source now type-checks under
TypeScript's strict settings; keep new code fully typed and fix type errors as part of
the change that introduces them. Work that is known but not done, with a way in:
- **Loose types.** `SchematicShape` (`SchematicDocument.js`) and the PCB's `BoardShape`
  accept any field, so a misspelt shape field is not caught. Making them unions
  discriminated by a literal `type` lets the checker narrow on `shape.type`; do it
  one shape class at a time. A few drag and selection states are still `any`
  (`VertexDrag` in `track-drag.js`, `SelectionShape` in `selection-registry.js`).
- **Autorouter.** `tools/regression.mjs` routes fixture boards and compares the result
  with a baseline, and the lifecycle and ownership have unit tests, but the
  pathfinder, maze and common modules (about 5,900 lines) have no unit tests of their
  own. Add tests for the pieces with clear inputs and outputs (cost functions,
  obstacle maps, path simplification) before changing their behaviour.
- **Browser tests under load.** When two full browser runs share the machine, a
  few schematic scenarios (corner drag and wire drawing in cancel isolation, text
  autoreplace and text property changes) have occasionally failed once and then
  passed on every rerun, also at `CPU_THROTTLE=6`. If one fails again, read its
  failure screenshot (`browser-test-failure-*.png` in the repository root) and look
  for a wait on a fixed delay or on a condition that holds before the editor has
  finished.

Before pushing, follow [Before You Commit](#before-you-commit).
