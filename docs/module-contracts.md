# ClearPCB Module Contracts

Detailed behaviour and ownership contracts for individual modules, split by
area. The layout, the enforced import rules and the owner index are in
[project_structure.md](project_structure.md); start there to find which module
owns something, then read its area page here for how it behaves.

| Page | Covers |
|------|--------|
| [Project, Document and Files](contracts/project-and-document.md) | File actions, change notification, autosave, snapshot readiness, serialization and loading |
| [PCB Editing](contracts/pcb-editing.md) | Edit lifecycle, property-editor ownership, pointer routing, layer visibility and lock changes, derived refreshes, keyboard/ribbon actions, selection, preview projections, copper cuts and removal hatching |
| [PCB Components, References and Text](contracts/pcb-components-and-text.md) | Placements and their overrides, reference designators, free text |
| [PCB Model and Geometry](contracts/pcb-model.md) | `PcbDocument` and its commands, which function resolves each kind of geometry and who consumes it, model limits, copper geometry, board shapes and outline, settings, fabrication, 3D data, tracks and vias |
| [Copper Pours, Ratsnest and DRC](contracts/pcb-pours-and-drc.md) | Pour commands and live computation, ratsnest traversal, DRC checking and panel |
| [Autorouter](contracts/routing.md) | Routing session and router worker contracts |
| [Schematic Editor](contracts/schematic.md) | Schematic view lifecycle, in-progress interactions and previews, startup, component picker |
| [Shared Shapes, Selection and Services](contracts/shared-services.md) | Shape geometry and editing, selection, previews, snapping, IDs, history, extracted PCB services |
| [UI Conventions](contracts/ui-conventions.md) | Grids, units, palette, ribbon height, Properties control order and labels |

When a change alters a module's contract, update the page for its area in the
same commit. Keep each paragraph about one module or behaviour so it can move
between pages if an area is split again.
