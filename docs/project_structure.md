# ClearPCB Project Structure

This document reflects the current repository and the near-term split between schematic-only, pcb-only, and shared code.

## Current Structure (Implemented)

```text
clearpcb/
├── index.html
├── src/
│   ├── core/                  # Shared engine primitives (viewport, history, selection, storage)
│   ├── shapes/                # Shared drawing primitives used by schematic today
│   ├── components/            # Shared component/symbol ingestion and rendering helpers
│   └── ui/
│       ├── AppBootstrap.js    # Shared startup + mode switching (schematic/pcb)
│       ├── SchematicApp.js    # Schematic editor facade
│       ├── PCBApp.js          # PCB editor facade scaffold
│       ├── schematic.css
│       └── modules/           # Schematic-focused interaction modules
└── docs/
    └── project_structure.md
```

## Ownership Rules

- `src/core/*` is shared by schematic and pcb.
- `src/ui/SchematicApp.js` and `src/ui/modules/*` are schematic-only unless explicitly migrated.
- `src/ui/PCBApp.js` owns pcb mode behavior and should not import schematic modules.
- `src/ui/AppBootstrap.js` is shared app orchestration only (startup, mode switching, platform launch hooks).

## Target Structure (Next Refactor Steps)

```text
src/
├── core/                      # Shared, mode-agnostic services
├── shared/
│   ├── io/                    # Shared file helpers, validators, serializers
│   ├── ui/                    # Shared UI helpers (theme, tabs, modals)
│   └── models/                # Shared document metadata/project model
├── schematic/
│   ├── app/SchematicApp.js
│   ├── modules/               # Existing src/ui/modules moved here incrementally
│   ├── shapes/
│   └── io/
├── pcb/
│   ├── app/PCBApp.js
│   ├── modules/
│   ├── geometry/
│   └── io/
└── ui/
    └── AppBootstrap.js
```

## Migration Plan

1. Keep runtime behavior stable by introducing thin re-export shims when files move.
2. Move obvious schematic-only modules first: `files.js`, `wire.js`, `draw-states.js`, `shape-management.js`.
3. Extract shared helpers from schematic modules into `src/shared` only when needed by pcb.
4. Add pcb-specific document I/O in `src/pcb/io` rather than extending schematic file format handlers.
5. Retire shims after imports are fully updated.