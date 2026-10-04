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
│   └── vendor/                 # jspdf, svg2pdf (vendored, see docs/vendoring_npm_packages.md)
├── src/
│   ├── core/                   # Mode-agnostic services: Viewport, CommandHistory,
│   │                           # SelectionManager, StorageManager, FileManager,
│   │                           # ModalManager, EventBus, geometry, ShapeValidator,
│   │                           # SearchManager, LazyLoader, ui-helpers
│   ├── shapes/                 # Drawing primitives shared by schematic + pcb
│   │                           # (shape, line, rect, circle, arc, polygon,
│   │                           # polyline, polyline-graph, text, net, wire,
│   │                           # noconnect, track, via)
│   ├── components/             # Component/symbol ingestion (BuiltInComponents,
│   │                           # ComponentLibrary, ComponentPicker, KiCadFetcher,
│   │                           # LCSCFetcher, STEPPreview, VRMLPreview)
│   ├── easyeda/                # EasyEDA importers (schematic-importer.js)
│   ├── shared/
│   │   ├── 3d/                 # Arcball controller, model rendering
│   │   ├── pcb/                # PCB geometry used by the project model and editor
│   │   │                       # (board-outline, board-shape-geometry, board-geometry,
│   │   │                       # footprint, reference-text, stroke-font, picture-*)
│   │   └── ui/                 # UI helpers used by both editors (theme, modal,
│   │                           # viewport, cursor, export, box-selection, recents,
│   │                           # ribbon-height, inline-text-overlay,
│   │                           # property-order, …)
│   ├── schematic/
│   │   ├── render/             # Schematic shape/component SVG renderers + WeakMap view state
│   │   └── modules/            # Schematic-only modules: interaction (mouse, keyboard,
│   │                           # drag, drawing, draw-states, clipboard, context-menu,
│   │                           # properties, ribbon, tool, text-edit), model helpers
│   │                           # (wire, label-attachment, pin-wire-connect, commands,
│   │                           # files, shape-management) and schematic-view (the
│   │                           # entity-SVG lifecycle boundary)
│   ├── pcb/
│   │   └── modules/            # PCB-only interaction + I/O modules
│   │                           # (autorouter family, controls, dsn, gerber,
│   │                           # layers, ratsnest, track-*)
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
├── tools/                      # Node-side benchmarks + DRC sanity tools
│                               # (autorouter-benchmark, check-clearance-*,
│                               # check-via-on-pad, regression, debug-pf-*)
└── docs/
    ├── project_structure.md    # This page: layout, enforced rules, owners
    ├── module-contracts.md     # Index of the per-module behaviour contracts
    ├── contracts/              # Contract pages by area (editing, model, pours/DRC, …)
    ├── clearpcb_file_format.md # Canonical project format
    ├── release-readiness.md    # Open release items and working agreements
    ├── releases.md             # Branching, CI gates and release checklist
    ├── autorouter.md, mcp.md, easyeda_pcb_format.md, …
    └── archive/                # Completed review log (review-fixes.md)
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
  grid controls, cursors, export helpers, box selection, recents, ribbon height,
  inline text, theme, the Properties panel control order). `src/shared/pcb/*` holds PCB geometry that the project
  model in `core` and the PCB editor both need (board outline and shape
  geometry, footprint generation, reference text, stroke font, picture artwork).
  Promote code there, rather than importing across editors, when both sides need it.

`node tools/check-imports.mjs` enforces these import directions as part of the
regression gate. `tools/import-baseline.json` lists known violations (currently
none); new ones fail, and fixed ones must be removed so the baseline only shrinks.

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
`tools/schematic-editor-access-baseline.json` (217 accesses to 106 private
`SchematicApp` members when introduced, 61 after the services); use a public
`SchematicApp` method or a module export instead of adding one. Both run as hard
checks in the regression gate. `test-schematic-module-load-order` loads each
schematic module first in a fresh process, so a direct import that creates an
evaluation-order cycle fails.

## State Ownership

- State shared by PCB modules lives in its owning module behind functions, usually
  a WeakMap keyed by the editor, rather than as `app._x` fields:
  `property-editors.js` (Properties bindings), `refresh-state.js` (pour/picture
  refresh status and refresh suspensions) and `board-shape-state.js` (board-shape
  node/segment focus, hover and tool defaults).
- In-progress interaction fields (`_drag`, `_trackDraw`, …) are listed once in
  `pcb-interactions.js`; `pcb-interaction-routing.js` holds their pointer-move,
  primary-release and cancel handlers. `test-pcb-interaction-registry` fails if a new
  one is unregistered.
- `pcb/modules/mouse.js` binds the PCB canvas's mouse events (like the schematic's
  `mouse.js`). Presses go to one `_press…Tool` method per tool through its
  `PCB_TOOL_PRESS_HANDLERS`; releases go to `releasePcbPointerGestures`.
- PCB modules call the editor through `pcb-editor-api.js` services; the access
  ratchet lists the private members they still use.
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
- `pcb/modules/board-shapes.js` — board-shape rendering, selection, interaction and
  Track conversion; `board-shape-properties.js` — their Properties panel.
- Properties panels by object: `track-select.js` (tracks, segments, nodes, vias),
  `pad-properties.js` (pads and the Pad tool), `text-properties.js` (free text, the
  Text tool, and the stroke-text field binder shared with reference designators),
  `copper-fill-edit.js` (pours), `board-outline-resize.js` (board size before an
  outline shape exists, and the Board Dimensions dialog for a new board),
  `component-properties.js` (components and references) and
  `multi-selection-properties.js` (the shared properties of a mixed selection).
  They use the panel services in `pcb-editor-api.js` (`propertiesItems`,
  `setPropertiesTitle`, `showPropertiesTab`, `toolNetOptions`, `bindToolNetControl`,
  `layerLabel`); `PCBApp` keeps a one-line forwarding method for each, passing tool
  state (pad and text defaults, inline-edit state) explicitly.
- `pcb/modules/text-inline-edit.js` — in-place editing of free text (hidden input,
  stroke-font caret overlay, commit and cancel); `selectText` and
  `showTextProperties` are editor services.
- `pcb/modules/clearance-overlay.js` — the clearance halos (`showClearances`, and
  incremental refresh for a dragged track, a moved via or a changed shape); other
  modules read its state through `areClearancesVisible`, `getBoardShapeClearance`
  and `getPadHaloGroup`.
- `pcb/modules/copper-cuts.js` — the per-side clip paths that cut copper under
  copper-removal shapes and board holes (`updateCopperCuts`, an editor service); other
  modules ask `hasCopperCuts` whether any cut is active.
- `pcb/modules/removal-hatch.js` — the hatch that fills copper-removal shapes: one SVG
  `<pattern>` per removal mode in the editor's own `<defs>` (1.8 mm tiles of three lines,
  0.6 mm apart and 0.1 mm wide, in board units so it zooms with the board), so holes and
  silk stacked above cover it.
  Exports strip it (`stripRemovalHatches`). It replaced a canvas overlay drawn above the
  whole SVG, which hatched over holes. On a stress board (220 removal shapes including 14
  traced pictures, headless Chromium) SVG hatching did about 25–60% more raster work but
  halved main-thread frame spikes during zoom and pan (p95 50 ms vs 117–133 ms).
- `pcb/modules/debug-tooltip.js` — the footprint shape-data tooltip (Help tab), pinned
  and unpinned by a stationary right-click.
- `pcb/modules/layer-changes.js` — what hiding, showing, locking or unlocking a layer,
  pour or overlay does to the editor (cancels stranded gestures and edits, updates the
  render groups, prunes the selection); the layer panel calls it through the editor's
  `_on…Changed` methods.

Schematic editor:

- `schematic/modules/schematic-editor-api.js` — public editor services for schematic modules.
- `schematic/modules/shape-focus.js` — the refined node or segment focus within the
  selected shape, like `pcb/modules/board-shape-state.js`.
- `schematic/modules/editor-actions.js` — Undo, Redo, Delete and Escape entry points,
  like `pcb/modules/editor-actions.js`.
- `schematic/modules/schematic-interactions.js` — the one list of in-progress
  interactions, with PCB's categories; `schematic-interaction-routing.js` — their
  cancel handlers (counterparts of `pcb-interactions.js` and `pcb-interaction-routing.js`).
- `schematic/modules/schematic-view.js` — entity SVG lifecycle, culling and level of
  detail; `schematic/render/` — shape and component renderers and their view state.
- `schematic/modules/draw-states.js` — the pointer interaction state machine;
  `mouse.js`, `keyboard.js`, `ribbon.js`, `context-menu.js` — the input bindings
  that drive it and the editor actions.
- `schematic/modules/drawing.js`, `wire.js`, `components.js`, `clipboard.js`,
  `drag.js`, `text-edit.js` — drawing, wiring, placement, paste, drag commits and
  inline text; `selection.js` — lock and shape-state capture.
- `schematic/modules/commands.js` — undo/redo commands; `shape-management.js` — the
  add/remove/delete/restore work behind the command view hooks.
- `schematic/modules/properties.js` — the Properties panel; `files.js` — Open, Save
  and document loading; `tool.js` — tool selection and persisted tool options.

Derived PCB work:

- `pcb/modules/fill-refresh.js` — coalesced pour recomputation (worker) and adoption;
  `picture-refresh.js` — debounced picture-copper refresh.
- `pcb/modules/drc-refresh.js` — scheduled DRC (worker); `drc-presentation.js` — DRC
  panel, markers and status.
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
- Pad layer names use the short form: `'top' | 'bottom' | 'both'`.
- Track / SVG-group ids use the long form: `'top-copper' | 'bottom-copper'`.

## Undo / Redo

All mutating PCB operations go through `core/CommandHistory` via
command classes in `src/pcb/modules/track-commands.js`
(`AddTrackCommand`, `RemoveTrackCommand`, `ModifyTrackCommand`,
`MoveVertexCommand`, `AddViaCommand`, `RemoveViaCommand`,
`MovePlacementCommand`, `SetBoardOutlineCommand`). `AddTrackCommand`
accepts an optional `vias[]` so a freshly-drawn track and its
layer-change vias land on the stack as a single atomic step.

Shapes implement `captureState()` / `applyState()` for serializable
state snapshots, used by generic modify commands.

## Checks

- `node tools/regression.mjs` — the gate CI runs: import boundaries, PCB editor
  access, every `tests/test-*.mjs` in its own process, and the autorouter baseline.
- `node tools/test.mjs [filter…]` — only the regression tests, optionally filtered.
- `node tools/typecheck.mjs` — `checkJs` type check; the baseline is empty, so any error
  fails (CI installs TypeScript 5.9.3; locally set `TSC`).
- `node tools/bench-pointer-dispatch.mjs` — PCB pointer-move routing cost.
- `node tools/browser-test.mjs [filter]` — real-browser scenarios (headless Chromium;
  CI installs Playwright, locally set `PLAYWRIGHT`). `node tools/serve.mjs [port]`
  serves the app without dependencies.
- `node tools/bench-pcb-hit-test.mjs [scale]` — PCB selection sync and pointer hit
  query cost on a large synthetic board.
- Tests call real functions; editor methods run on `tests/pcb-editor-fixture.mjs` or
  via `PCBApp.prototype.method.call(fixture)`. `test-source-text-ratchet` fails any test that
  evaluates sliced source text; add a small seam when a collaborator must be observed.

## Coding & Tooling Conventions

- Vanilla JS ES modules; **no bundler**. Browser loads `src/**` directly.
- `// @ts-nocheck` files exist in the autorouter modules; propagate to
  every file when splitting one with the pragma.
- Use `console.info` (not `console.warn`) for diagnostics that must
  survive PowerShell `2>$null` redirection.
- Node-side benchmarks/DRC checkers in `tools/` import the worker
  modules directly. They are the authoritative regression gates:
  - `node tools/regression.mjs` — classic router baseline.
  - `node tools/check-clearance-pathfinder.mjs <board>.json` —
    pathfinder + post-route geometric clearance check.
- Vendored libs go in `assets/vendor/` (see
  [docs/vendoring_npm_packages.md](vendoring_npm_packages.md)).

## Known Environmental Gotcha

Microsoft Edge's "Enhance your security on the web" setting
(`edge://settings/privacy`) disables V8 TurboFan JIT on "unfamiliar"
sites (rarely-visited HTTPS origins). `localhost` is exempt. Symptom:
the autorouter worker can run **~8–10× slower** on the deployed site
than on localhost despite identical bytes. Add the origin to the
setting's exception list before suspecting code/network issues.
