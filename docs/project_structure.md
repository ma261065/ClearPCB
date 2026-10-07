# ClearPCB Project Structure

Where code lives, which way imports may point, and which module owns each piece
of shared state. The regression gate enforces the import and editor-access rules.
Detailed per-module behaviour is in [module-contracts.md](module-contracts.md),
an index of area pages under [contracts/](contracts/).

## Current Structure

```text
clearpcb/
├── index.html
├── sw.js                       # Service worker (PWA)
├── mcp-worker/                 # Cloudflare Worker + Durable Object MCP relay
├── manifest.json
├── jsconfig.json               # checkJs: true, noImplicitAny: false
├── assets/
│   ├── icons/
│   └── vendor/                 # Vendored libraries: three, clipper, earcut, fflate, jsPDF,
│                               # svg2pdf, imagetracer, vtracer (see docs/vendoring_npm_packages.md)
├── src/
│   ├── core/                   # Project model and editor-neutral services:
│   │                           # ProjectDocument, SchematicDocument, PcbDocument (+ PcbDesignSettings,
│   │                           # PcbPlacementState, pcb-*-commands, pcb-* geometry), FileManager,
│   │                           # project-format, CommandHistory, Viewport, SelectionManager,
│   │                           # McpBridge, geometry, grid-snap, id-allocator, …
│   ├── shapes/                 # Drawing and copper primitives shared by both editors
│   │                           # (shape, polyline, polyline-graph, rect, circle, arc, polygon,
│   │                           # text, net, wire, noconnect, track, via, pad, copper-fill) and
│   │                           # shared path editing (path-*, arc-*, shape-join, axis-glow, …)
│   ├── components/             # Component/symbol ingestion and preview (BuiltInComponents,
│   │                           # BuiltInPackages, BuiltInModels3D, ComponentLibrary,
│   │                           # ComponentPicker, KiCadFetcher, kicad-index-format,
│   │                           # LCSCFetcher, Model3D*, …)
│   ├── easyeda/                # EasyEDA importers (schematic-importer.js)
│   ├── shared/
│   │   ├── 3d/                 # Arcball controller, model rendering
│   │   ├── pcb/                # PCB geometry used by the project model and editor
│   │   │                       # (board-outline, board-shape-geometry, board-geometry,
│   │   │                       # footprint, reference-text, stroke-font, picture-*)
│   │   └── ui/                 # UI helpers used by both editors (theme, modal,
│   │                           # viewport, cursor, export, box-selection, recents,
│   │                           # ribbon renderer/height, inline-text-overlay,
│   │                           # property-order, …)
│   ├── schematic/
│   │   ├── render/             # Schematic shape/component SVG renderers + WeakMap view state
│   │   └── modules/            # Schematic-only modules: interaction (mouse, keyboard,
│   │                           # drag, drawing, draw-states, clipboard, context-menu,
│   │                           # properties, ribbon + ribbon-description, tool, text-edit), model helpers
│   │                           # (wire, label-attachment, pin-wire-connect, commands,
│   │                           # files, shape-management) and schematic-view (the
│   │                           # entity-SVG lifecycle boundary)
│   ├── pcb/
│   │   └── modules/            # PCB-only modules: tools and interaction (mouse, keyboard,
│   │                           # track-*, board-shapes, pcb-interaction-*), rendering,
│   │                           # pours, DRC, autorouter family, fabrication (gerber, dsn, …)
│   └── ui/
│       ├── AppBootstrap.js     # Shared startup + mode switching
│       ├── SchematicApp.js     # Schematic editor facade over src/schematic
│       ├── PCBApp.js           # PCB editor facade over src/pcb
│       ├── mcp-session.js      # MCP session dialog (used by AppBootstrap)
│       └── schematic.css
├── workers/
│   └── cors-proxy.js
├── tests/                      # Isolated headless regression scripts (test-*.mjs)
├── browser-tests/              # Playwright scenarios run by tools/browser-test.mjs
├── tools/                      # Regression gate and checks (regression, test, typecheck,
│                               # check-imports, check-*-editor-access, check-clearance-*),
│                               # browser-test, serve, benchmarks, release packaging,
│                               # build-kicad-index (release-time KiCad index)
└── docs/
    ├── project_structure.md    # This page: layout, enforced rules, owners
    ├── module-contracts.md     # Index of the per-module behaviour contracts
    ├── contracts/              # Contract pages by area (editing, model, pours/DRC, …)
    ├── clearpcb_file_format.md # Canonical project format
    ├── release-readiness.md    # Open release items and working agreements
    ├── releases.md             # Branching, CI gates and release checklist
    └── autorouter.md, mcp.md, easyeda_pcb_format.md, netname_wirelabel_contract.md,
        shape_join_arcs.md, vendoring_npm_packages.md
```

## Ownership Rules

- `src/core/*`, `src/shapes/*`, `src/components/*`, `src/shared/*` are
  shared by schematic and pcb.
- `src/schematic/**` and `src/ui/SchematicApp.js` are schematic-only.
  `PCBApp.js` must not import them.
- `src/pcb/**` and `src/ui/PCBApp.js` are pcb-only. Schematic code must
  not import them.
- `src/ui/AppBootstrap.js` is shared orchestration only (startup, mode
  switching, platform launch hooks); other `src/ui` files besides the two
  editor facades (`mcp-session.js`) serve only it.
- `src/easyeda/*` is import-only (read EasyEDA files into our model).
- Shared code (`core`, `shapes`, `components`, `shared`, `easyeda`) must not
  import either editor.
- `src/shared/ui/*` holds UI helpers both editors use (modal dialogs, viewport
  grid controls, cursors, export helpers, box selection, recents, the shared ribbon
  renderer and ribbon height, inline text, theme, the Properties panel renderer and control order, pop-up menus,
  settled number fields). `src/shared/pcb/*` holds PCB geometry that the project
  model in `core` and the PCB editor both need (board outline and shape
  geometry, footprint generation, reference text, stroke font, picture artwork).
  Promote code there, rather than importing across editors, when both sides need it.

`node tools/check-imports.mjs` enforces these import directions as part of the
regression gate. `tools/import-baseline.json` lists known violations (currently
none); new ones fail, and fixed ones must be removed so the baseline only shrinks.

Ribbon markup follows the same ownership rule as Properties panels:
`src/shared/ui/ribbon.js` builds the DOM from editor-local descriptions in
`src/schematic/modules/ribbon-description.js` and
`src/pcb/modules/ribbon-description.js`. `index.html` owns only the empty ribbon
host elements, while editor control modules bind behaviour to the generated stable
IDs.

Both editors follow the same module rules. A module that needs another module's
behaviour imports that module's function and calls it directly; it does not go
through the editor. What the editor itself owns, modules reach through its public
services, listed and typed in `pcb/modules/pcb-editor-api.js` (`getLayerGroup`,
`getRoutingParams`, `refreshFills`, `updateRatsnest`, `setStatus`, …) and
`schematic/modules/schematic-editor-api.js` (`updatePropertiesPanel`, the
crosshair, `alert`/`confirm`, the cancel helpers, inline text editing, tool
selection and the command view hooks), rather than its `_`-prefixed members.
Services are also the seams tests stub. A service both editors offer has one name
in both (`fitToContent`, `setActiveRibbonTab`, `copySelection`).
`node tools/check-pcb-editor-access.mjs` ratchets the remaining private
accesses per module in `src/pcb` and `src/shared/pcb` against
`tools/pcb-editor-access-baseline.json` in the same way; promote a member to a
service instead of adding a new private access.
`node tools/check-schematic-editor-access.mjs` applies the same ratchet to the
schematic layer (`src/schematic`) against
`tools/schematic-editor-access-baseline.json`; use a public `SchematicApp` method or a
module export instead of adding a private access. Both run as hard checks in the
regression gate. `test-schematic-module-load-order` loads each
schematic module first in a fresh process, so a direct import that creates an
evaluation-order cycle fails.

## State Ownership

- State shared by PCB modules lives in its owning module behind functions, usually
  a WeakMap keyed by the editor, rather than as `app._x` fields:
  `property-editors.js` (Properties bindings), `refresh-state.js` (pour/picture
  refresh status and refresh suspensions), `fill-refresh.js` (computed-pour
  scheduling, terminal disposal, cached rerenders and fill-layer clearing),
  `board-shape-state.js` (board-shape
  node/segment focus, hover and tool defaults), `pcb-text-render.js` (free-text
  SVG elements and hover), `cursor-state.js` (last pointer/crosshair positions),
  `refresh-state.js` (derived-refresh flags, suspensions, and shared 3D/2D
  board-view panel state), `component-selection.js` (component hover outline),
  `pcb-hover.js` (coalesced select-tool hover frame state), `board-outline-resize.js`
  (board-outline drawn/selected state), `clearance-overlay.js` (clearance
  visibility and halo caches), `picture-refresh.js` (pending/deferred
  shape-clearance refresh state), and `pcb-interactions.js` (in-progress
  interaction slots).
- In-progress interaction slots (`_drag`, `_trackDraw`, …) are listed once in
  `pcb-interactions.js` with their owner module and stored in its import-free
  WeakMap. Only the owner writes its slot with `setPcbInteraction`; other code
  asks the owner through intent APIs such as `getBoardShapeDrag`,
  `endComponentDrag`, `getTrackDraw`, `cancelFillDraw` or
  `activeTextInlineEdit`. `pcb-interaction-routing.js` reads the store to route
  pointer move, release and cancel handlers. `test-pcb-interaction-registry`
  fails if a slot is unregistered or written outside its owner.
- `pcb/modules/mouse.js` binds the PCB canvas's mouse events (like the schematic's
  `mouse.js`). Presses go to one `_press…Tool` method per tool through its
  `PCB_TOOL_PRESS_HANDLERS`; releases go to `releasePcbPointerGestures`.
- PCB modules call the editor through `pcb-editor-api.js` services; the access
  ratchet lists the private members they still use.
- Schematic modules follow the same pattern. `schematic-interactions.js` owns the
  overlap-cycle press slot in an import-free WeakMap; `draw-states.js` owns its
  pending segment-toggle and drag scratch buffers; `drawing.js` owns one-shot
  draw snap data; `wire.js` owns wire axis-lock and junction highlight state;
  `components.js` owns component placement-preview visibility plus the component
  code tooltip; `mouse.js` owns right-button pan tracking; `ribbon.js` owns the
  tab activator, height retainer, Escape cleanup and save-toast handler; `tool-ghost.js`
  owns placement ghosts; `label-attachment.js` owns the label guide; and
  `schematic-view.js` owns the refined segment-selection overlay. Other modules
  call exported intent APIs instead of reading `app._…`.
- `pcb-interactions.js`, `property-editors.js`, `refresh-state.js` and
  `board-shape-state.js` have no imports, because worker-loaded export and DRC
  code (or low-level selection plumbing) reads them.
- Entity IDs come from `core/id-allocator.js`; board shapes use
  `PcbDocument.shapeIdCounter`.

## Owner Index

Project and documents:

- `core/ProjectDocument.js` — the single project file: models, registered views,
  combined serialize/load with rollback, aggregate dirty state.
- `core/SchematicDocument.js`, `core/PcbDocument.js` — authored entities, loaded
  preferences and serialization; `core/PcbPlacementState.js` — saved footprint poses.
- `core/FileManager.js` — file identity, ZIP read/write, autosave and recents;
  `core/project-format.js`, `core/project-field-aliases.js` — validation and key aliases.
- `core/CommandHistory.js` — undo/redo engine; `core/id-allocator.js` — entity IDs.

PCB editor:

- `pcb/modules/pcb-editor-api.js` — public editor services for PCB modules.
- `pcb/modules/edit-lifecycle.js` — preview cancellation, property-editor disposal,
  snapshot readiness; `tool-lifecycle.js` — tool selection and drawing cancellation.
- `pcb/modules/editor-actions.js` — Undo, Redo, Save, Delete, nudge and Escape entry points;
  `keyboard.js` — the PCB keyboard shortcuts (like `schematic/modules/keyboard.js`),
  with each drawing tool handling its own keys (`handleTrackDrawKey`, …).
- `pcb/modules/project-state.js` — PCB serialization, preparation and restoration.
- `pcb/modules/board-shapes.js` — board-shape rendering, selection, interaction,
  Track conversion and the shared path-edit/profile machinery also used by copper
  fills; `board-shape-properties.js` — board-shape Properties and shared geometry
  preview transactions.
- `pcb/modules/board-outline-resize.js` — board-outline draw/selection state,
  board-size previews and resize gestures, the Board Dimensions dialog and the
  read-only `isBoardOutlineDrawn()` service used by page/test readiness checks.
- `pcb/modules/ref-text-geometry.js` — a reference designator's box, hit test and
  inline-edit corners, and the footprint-local ↔ board transforms (pure functions of
  the placement); `ref-text-selection.js` — its selection adapter, direct selection
  and inline-edit entry points.
- Properties panels by object: `track-select.js` (tracks, segments, nodes, vias),
  `pad-properties.js` (pads and the Pad tool), `text-properties.js` (free text, the
  Text tool, and the stroke-text field binder shared with reference designators),
  `copper-fill-edit.js` (pour-specific fill fields plus the fill edit profile used
  by the shared board-shape path editor), `board-outline-resize.js` (board size before an
  outline shape exists, and the Board Dimensions dialog for a new board),
  `component-properties.js` (components and references) and
  `multi-selection-properties.js` (the shared properties of a mixed selection).
  Each describes its panel as data (`shared/ui/property-fields.js`) and shows it
  through the editor services in `pcb-editor-api.js` (`openPropertyPanel`,
  `refreshPropertyPanel`, `netNames`, `setPropertiesTitle`, `showPropertiesTab`,
  `layerLabel`); `PCBApp` hosts the rendering while owner modules keep their
  tool defaults/previews in per-editor WeakMaps. Track defaults and the New Track
  panel live in `track-draw.js`; the Fill tool layer/net/radius defaults and
  drawing session live in `copper-fill-draw.js`, while selected-fill Properties
  rendering and in-place refresh live in `copper-fill-edit.js`; Via defaults and
  preview rings live in `via-tool.js`; Pad and Text defaults live with their
  Properties modules.
- `pcb/modules/ref-text-selection.js` — reference-designator selection, hit-test
  adapter, drag gestures, overlay group, highlight refresh, glyph rerendering and
  reference-specific command adapters. Reference boxes remain pure geometry in
  `ref-text-geometry.js`.
- `pcb/modules/pcb-text-render.js` — free-text SVG element state, render/remove,
  refresh, hit-testing and hover state in per-editor WeakMaps; `pcb-text.js`
  remains the glyph geometry/color helper.
- `pcb/modules/component-selection.js` — component hit-testing, hover outline state,
  3D context-menu entry point and movement/rotation selection adapter.
- `pcb/modules/copper-fill-selection.js` — copper-fill selection adapter and legacy
  outline hit-testing for right-click and select-tool press paths.
- `pcb/modules/pcb-hover.js` — select-tool hover scheduling, pointer coalescing and
  cursor/overlap feedback state.
- `pcb/modules/text-inline-edit.js` — in-place editing of free text (hidden input,
  stroke-font caret overlay, commit and cancel); `selectText` and
  `showTextProperties` are editor services.
- `pcb/modules/clearance-overlay.js` — the clearance halos (`showClearances`, and
  incremental refresh for a dragged track, a moved via or a changed shape), plus
  the visibility flag and halo caches; other modules read its state through
  `areClearancesVisible`, `getBoardShapeClearance` and `getPadHaloGroup`.
- `pcb/modules/copper-cuts.js` — the per-side clip paths that cut copper under
  copper-removal shapes and board holes (`updateCopperCuts`, an editor service); other
  modules ask `hasCopperCuts` whether any cut is active.
- `pcb/modules/removal-hatch.js` — the hatch that fills copper-removal shapes: one SVG
  `<pattern>` per removal mode in the editor's own `<defs>`, in board units so it zooms
  with the board (1.8 mm tiles of three 0.1 mm lines, 0.6 mm apart). It is a fill on the
  shapes themselves, not a canvas overlay, so holes and silk stacked above cover it.
  Exports strip it (`stripRemovalHatches`).
- `pcb/modules/debug-tooltip.js` — the footprint shape-data tooltip (Help tab), pinned
  and unpinned by a stationary right-click.
- `pcb/modules/layer-changes.js` — what hiding, showing, locking or unlocking a layer,
  pour or overlay does to the editor (cancels stranded gestures and edits, updates the
  render groups, prunes the selection); the layer panel calls it through the editor's
  `_on…Changed` methods.
- `pcb/modules/object-locks.js` — individual object locks alongside layer locks: the
  combined lock predicates every edit path uses, the undoable lock command, the lock
  icon's unlock menu and the Properties "Locked" row.

Schematic editor:

- `schematic/modules/schematic-editor-api.js` — public editor services for schematic modules.
- `schematic/modules/shape-focus.js` — the refined node or segment focus within the
  selected shape, like `pcb/modules/board-shape-state.js`.
- `schematic/modules/editor-actions.js` — Undo, Redo, Delete and Escape entry points,
  like `pcb/modules/editor-actions.js`.
- `schematic/modules/schematic-interactions.js` — the one list of in-progress
  interactions, with PCB's categories, and the WeakMap-owned overlap-cycle press
  slot; `schematic-interaction-routing.js` — their cancel handlers (counterparts
  of `pcb-interactions.js` and `pcb-interaction-routing.js`).
- `schematic/modules/schematic-view.js` — entity SVG lifecycle, culling and level of
  detail; `schematic/render/` — shape and component renderers and their view state.
- `schematic/modules/draw-states.js` — the pointer interaction state machine, pending
  segment-toggle state and reusable drag scratch buffers;
  `mouse.js`, `keyboard.js`, `ribbon.js`, `context-menu.js` — the input bindings
  that drive it and the editor actions.
- `schematic/modules/drawing.js`, `wire.js`, `components.js`, `clipboard.js`,
  `drag.js`, `text-edit.js` — drawing, wiring, placement, paste, drag commits and
  inline text; `selection.js` — lock toggling and shape-state capture; `locks.js` —
  the lock icon's unlock menu (`render/lock-placement.js` places lock icons, using
  the editors' shared `core/lock-position.js`).
- `schematic/modules/commands.js` — undo/redo commands; `shape-management.js` — the
  add/remove/delete/restore work behind the command view hooks.
- `schematic/modules/properties.js` — the Properties panel (described as data);
  `property-host.js` — where it is rendered; `files.js` — Open, Save
  and document loading; `tool.js` — tool selection and persisted tool options;
  `tool-ghost.js` — single-click placement ghosts.

Derived PCB work:

- `pcb/modules/fill-refresh.js` — coalesced pour recomputation (worker) and adoption;
  `picture-refresh.js` — debounced picture-copper refresh.
- `pcb/modules/drc-state.js` — DRC presentation ownership, ratline cache and
  lifecycle; `drc-refresh.js` — scheduled DRC (worker); `drc-presentation.js` —
  DRC panel, markers and status.
- `pcb/modules/autorouter-session.js` — routing session, worker and result adoption;
  `route-input.js` — the router input built from placements, netlist and copper.
- `pcb/modules/copper-model.js`, `copper-connectivity.js` — physical pads, nets and
  clusters; `fill-context.js`, `copper-artwork.js` — pour inputs and DRC artwork.
- `pcb/modules/fabrication-snapshot.js` — detached export inputs and readiness guard.

Shared geometry:

- `shared/pcb/` — board outline and shape geometry, footprints, reference text,
  stroke font, picture artwork; `core/pcb-placement-geometry.js` — resolved placements.
- `shapes/arc-edit.js`, `rounded-path.js`, `path-geometry.js`, `path-operations.js`,
  `shape-drawing.js` — arcs, rounded corners, strokes, path editing, drawing completion.
- `shapes/property-preview.js` — reversible live-property transactions;
  `core/grid-snap.js` — displayed-grid magnet.
- `core/DerivedUpdates.js`, `core/spatial-pairs.js` — batched derived callbacks and the
  DRC broad phase; `shared/3d/` — arcball control and model rendering.

## Coordinate & Layer Conventions

- All PCB coordinates are stored in **mm** with **SVG-Y-down** semantics.
  Y is flipped only at the Gerber / Excellon emission boundary.
- Copper layer and SVG-group ids use the long form: `'top-copper' | 'bottom-copper'`,
  as do standalone pads (`shapes/pad.js`: `'top-copper' | 'bottom-copper' | 'both'`).
- Footprint pads generated by `shared/pcb/footprint.js` use the short form
  `'top' | 'bottom' | 'both'`.

## Undo / Redo

Every authored change goes through `core/CommandHistory` as a command. PCB commands
come in two layers:

- **Model commands** in `core/pcb-*-commands.js` (track, via, pad, fill, shape, text,
  lock, placement, outline) change only `PcbDocument`. Tests and `pcb-paste.js` use them
  directly.
- **Editor commands** in `pcb/modules` (`track-commands.js`, `pad-commands.js`,
  `shape-commands.js`, `text-commands.js`, `copper-fill-commands.js`) subclass the
  model commands under the same names, then re-render the changed objects and
  refresh derived views such as the ratsnest, clearance halos and pours.
  `track-commands.js` also defines `CompoundCommand`, which groups several commands
  into one undo step. `AddTrackCommand` accepts optional `vias[]`, so a drawn track
  and its layer-change vias are one step.

Schematic commands are in `schematic/modules/commands.js`. Shapes implement
`captureState()` / `applyState()` for serializable snapshots, used by the generic
modify commands.

Every model command (both editors) declares the objects it changes or removes with
`lockTargets()`. Each editor's `CommandHistory` runs the lock gate in
`core/edit-guard.js` on new commands, refusing any that would change a locked
object before it runs. A new command class must declare `lockTargets()`;
`test-edit-guard` enforces this.

## Checks

- `node tools/regression.mjs` — the gate CI runs: import boundaries, both editors'
  private-access ratchets, every `tests/test-*.mjs` in its own process, and the
  autorouter baseline on `test-board.json`.
- `node tools/test.mjs [filter…]` — only the regression tests, optionally filtered.
- `node tools/typecheck.mjs` — `checkJs` type check; the baseline is empty, so any error
  fails.
- `node tools/browser-test.mjs [filter] [--shard=i/n]` — real-browser scenarios (headless
  Chromium; `HEADED=1` shows the browser; CI runs four shards in parallel). `node tools/serve.mjs [port]` serves the app without
  dependencies.
- TypeScript 5.9.3 and Playwright 1.55.0 are not vendored: install them into the
  git-ignored `node_modules` as CI does (see [README](../README.md#testing)), or set
  `TSC` / `PLAYWRIGHT`.
- `node tools/bench-pointer-dispatch.mjs` — PCB pointer-move routing cost.
- `node tools/bench-pcb-hit-test.mjs [scale]` — PCB selection sync and pointer hit
  query cost on a large synthetic board.
- Tests call real functions; editor methods run on `tests/pcb-editor-fixture.mjs` or
  via `PCBApp.prototype.method.call(fixture)`. `test-source-text-ratchet` fails any test that
  evaluates sliced source text; add a small seam when a collaborator must be observed.
- The PCB fixture uses the editor's real undo history (`createPcbHistory`, with the lock
  gate). New tests build their DOM with `installFakeDom()` from
  `tests/helpers/fake-dom.mjs`; `test-fixture-ratchet` counts the tests that still
  hand-roll a `globalThis.document` stub, and that number may only go down.
- `test-property-panels-logic-only` keeps Properties panels as descriptions: panel
  modules use no DOM, and only `shared/ui/property-fields.js` and the editors' hosts
  build property rows. Panel tests drive the description (`field.preview`/`commit`)
  or the rendered controls on the fake DOM.

## Coding & Tooling Conventions

- Vanilla JS ES modules; **no bundler**. Browser loads `src/**` directly.
- All source is type-checked (`node tools/typecheck.mjs`); no file opts out with
  `// @ts-nocheck`.
- Use `console.info` (not `console.warn`) for diagnostics that must
  survive PowerShell `2>$null` redirection.
- Node-side routing checks in `tools/` import the router modules directly:
  - `node tools/regression.mjs` — maze-router baseline on `test-board.json` (via
    `check-clearance-full.mjs`).
  - `node tools/check-clearance-pathfinder.mjs <board>.json` —
    pathfinder + post-route geometric clearance check.
- Vendored libs go in `assets/vendor/` (see
  [docs/vendoring_npm_packages.md](vendoring_npm_packages.md)).
- If the autorouter is much slower on the hosted site than on `localhost`, suspect
  Microsoft Edge's "Enhance your security on the web" setting before the code; see
  [Troubleshooting](../README.md#troubleshooting).
