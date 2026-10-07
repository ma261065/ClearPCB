# Project, Document and Files

Part of the [module contracts](../module-contracts.md). How the project
document, the two editors and file storage cooperate: file actions, change
notification, autosave, snapshot readiness, serialization and loading.

## Document Lifecycle, Autosave and Readiness

`ProjectDocument` dispatches successful file-action completion through registered
views' `onDocumentReplaced(reason)` hooks (`new`, `open`, or `import`). Each editor
owns its own Home-tab navigation; the PCB view also owns new-board setup timing
and disposal of its dimensions dialog. Completion is not emitted for cancelled
or failed file actions. The UI host confirms New; `ProjectDocument.reset()` clears
the schematic and then the PCB through each view's `clearSection()` hook.
The schematic clear boundary first cancels pending Properties, pointer, drawing,
paste and component-placement work and verifies readiness. Failed cleanup stops
before either model or its history is cleared.
`FileManager` adopts the new identity and stores the cleared project's actual
settings for recovery. Reset guards section clearing, not the entire asynchronous
confirmation/picker/adoption lifetime, and does not promise atomic recovery.

Registered editors report changes through `onDocumentChanged()`. The project
advances the revision and calls its UI host's `onProjectChanged()` to refresh
aggregate title/dirty indicators. PCB edits keep their section dirty flag separate
from `FileManager.isDirty`, avoiding schematic-to-PCB refresh notifications.

`AppBootstrap` stores its schematic instance directly; there is no `window.app`
alias. Both editor constructors receive their project owner. PCB file commands
resolve their own `app.project` at invocation time. `window.bootstrap` remains only a console-inspection
handle, not a runtime service lookup.

Storage reports autosave failures through `FileManager.onAutoSaveError`; the UI
host shows the existing alert dialog, visible from either editor. Notifications
are once per storage-failure streak, reset after a successful autosave. Storage
and notification failures are logged; error reporting does not discover editors
through globals. Completed document/index writes emit `FileManager.onAutoSaveSuccess`;
the UI host injects `flashAutoSaveIndicator()` from `schematic/modules/ui-utils.js`.
The fixed 4px blue dot uses a 250ms retriggerable visibility window and existing
styling. Success-indicator failures are logged separately: they cannot turn a
completed autosave into a storage-failure warning or cause it to be retried.
`onAutoSaveChanged` remains the separate size/title update callback.

Storage writes only what the loader accepts. Open and recovery validate a project
with `validateEditableProject` (`project-format.js`); `FileManager` checks every
Save, Save As and autosave with `storableProject`, the same validation, and writes
the compact form it returns, so the check adds no copy. A project that fails is not
written. Save and Save As report the `ProjectIntegrityError` through the save-failure
alert before any permission prompt or file picker, so the file on disk is unchanged;
autosave keeps the last good snapshot and the UI host says why, once per failure
streak. Such a failure is an application bug, not a user error: the message carries
the validator's location and snippet for the report. `test-project-write-integrity`
covers these.
Successful Open and Open Recent clean up only the opened file's recovery
snapshot; Import preserves existing recovery entries. Unrelated project backups
are never purged as a side effect of adopting another document.

Browser idle time is not an edit-completion signal. Registered views may report
`isSectionEditing()`; `ProjectDocument.canSerialize()` uses that neutral readiness
contract without inspecting editor fields. Pending PCB and schematic edits block project
snapshots rather than silently saving committed geometry that differs from the
displayed preview. Autosave retains its existing idle scheduling and rechecks readiness
both before scheduling and at idle execution, leaving the pending revision
unsaved until commit/cancel makes it safe. Timer-only browsers use the same guard.
Manual Save/Save As report a snapshot failure through the existing failure UI
without opening or writing a file. Headless serialization remains available.
This readiness policy is independent of the detached per-family preview
ownership described in [pcb-editing.md](pcb-editing.md#previews-and-projections).

The schematic view includes reversible numeric Properties previews, pointer
edits, pre-threshold splits, drawing, placement and inline text in this readiness
query. Numeric ownership is per editor rather than per DOM root, so replacing
Properties cannot hide an unfinished edit from save or history. Schematic
keyboard and ribbon Undo/Redo share a completion boundary: restore numeric and
pointer previews before advancing history, cancel placement/inline text without
advancing history, and leave in-progress drawing alone. Failed rollback prevents
history traversal. Escape, history and tool switches reuse the same pointer
rollback, including linked-wire snapshots and provisional shape conversions.

## Section Callbacks and Renames

Schematic history/dirty callbacks update their own UI, then call
`ProjectDocument.notifySchematicChanged()`. The project calls the registered
PCB's `onSchematicChanged()`; PCB never replaces another editor's callbacks.
Active edits retain the 300 ms debounce, while hidden boards defer rebuilds.
Synchronization reads `project.schematicDocument`, not a schematic editor.
A missing project leaves synchronization pending; a project-owned model can
synchronize even without a registered schematic view. PCB-only edits do not
send schematic-change notifications.

PCB reference editing and footprint inspection use the project's narrow component
interface: `getComponentInfo()`, `validateComponentReference()`,
`createReferenceRenameCommand()` and `getNetlist()`. Queries return detached data;
rename commands expose only `execute()`/`undo()`, not an editor or live component.
`core/SchematicDocument.js`, owned by `ProjectDocument.schematicDocument`, owns
the schematic collections, component lookup/validation/rename, connectivity
queries and data-only loading/serialization. Editor `shapes`/`components`
accessors alias those collections, including replacements during load and clear;
there is no second entity store. Schematic property commands reuse the same
reference/field-text mutation helper.

Project rename commands perform the model operation and then notify the
schematic adapter to invalidate/render. PCB retains its dialogs, preview, history
entry and derived-display updates. The model can load, rename/undo, derive
connectivity and serialize without either editor or a DOM. Pure connectivity
queries remain in `core/netlist.js`.

## Serialization and Loading

`serialize(settings)` assembles the complete authored PCB section: stackup,
dimensions, design settings, optional panelization, entities and saved placements.
It applies the existing compact aliases and save-boundary precision, returning a
detached snapshot without rounding live data. Viewport preferences are an explicit
optional argument; the adapter's `serializePcb()` supplies them from the viewport,
but no editor-owned authored aliases are read. With no explicit preferences it
uses a detached snapshot retained during loading, preserving absent settings
without inventing defaults. Live viewport edits still belong to the view; the
loaded snapshot is a persistence fallback, not a second live viewport.

`ProjectDocument` always serializes schematic entities from `SchematicDocument`
and authored PCB state from `PcbDocument`. Registered views contribute only
`getViewSettings()`: current persisted view settings, or undefined before viewport
creation so loaded settings remain the fallback. A view cannot suppress or replace
model content by returning its own serialized section. The direct editor
serialization APIs remain available and delegate to their models.

The schematic model assembles shapes, components and deduplicated embedded
definitions. Its view-settings adapter captures grid, paper size/orientation and
title-block settings, including detached title-block data. Current settings
override the loaded fallback only for the saved snapshot; saving does not mutate
either the fallback or live entities. Loading restores a file's title-block data
whether or not it has a paper size, so a project never keeps another project's
title block. Direct schematic serialization and combined
project serialization use the same model codec.
The registered schematic view implements `prepareSection()` using the model's
preflight and adopts those prepared entities during loading. Missing component
definitions therefore fail before document adoption, preserving existing
undo/redo instead of reloading an unchanged document through rollback.
EasyEDA import emits native component types and maps part metadata to canonical
`defaultProperties.mpn` and `footprintName`, preserving it through native ZIP
and autosave round trips.

For preparation, load and reset, `ProjectDocument` uses the PCB model directly
when no PCB view is registered; registered adapters retain their existing
model-adoption and presentation dispatch without double loading/clearing.
This works both with neither editor and with only the schematic editor.
`PcbDocument.serializeSection()` omits a genuinely absent/cleared PCB, but
preserves an explicitly loaded section even if it only contains metadata.
Fresh authored entities, placements, panelization or nondefault dimensions also
make a section persistable; retained design defaults alone do not. Supplying
current view preferences retains the existing settings-only section behavior
for an empty board whose viewport has been created, including after New.
Saving neither creates a viewport nor writes current preferences back into the
loaded fallback. The project saves current model state rather than caching a
serialized PCB. Best-effort serialized recovery uses the same model-owned
snapshot and captured view preferences; it remains serialized recovery, not
exact rollback.

Attaching a PCB editor preserves already supplied design settings rather than
replacing them with local defaults. `PcbDesignSettings.hasAppliedSettings` records
successful updates; rejected updates do not suppress default restoration, and
New retains the marker with the last-used values. A fresh model still accepts
local defaults, including the legacy display-unit format. Binding always displays
the model's values without reading rounded controls back.
The first viewport restores the model's loaded grid preferences. Controls bound
before or after viewport creation synchronize from the live viewport, selecting
the nearest fixed grid preset. Later viewport checks do not
reapply the loaded snapshot. Initial control edits capture the requested value
before viewport creation can refresh the controls. A metadata-only loaded PCB
also remains serializable through an attached editor before a viewport exists.

## Export Naming and Open Rollback

PDF, Gerber, BOM and pick-and-place naming share `projectBaseName()` from
`pcb/modules/pcb-export.js`, using the owning project's `FileManager`. Unnamed
exports use `pcb` for PDF and `untitled` for manufacturing exports.

Open uses best-effort serialized rollback if a registered section fails to load
after preflight. The rollback can round or normalize geometry and does not
preserve Undo or selection, so load failures are still reported instead of being
treated as transparent recovery.
