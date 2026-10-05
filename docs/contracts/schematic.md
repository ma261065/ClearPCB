# Schematic Editor

Part of the [module contracts](../module-contracts.md). Schematic-only view
lifecycle, deliberate differences from the PCB editor, startup and the component
picker.

## View Lifecycle

`schematic/modules/schematic-view.js` is the schematic's view lifecycle, the
counterpart of the PCB render modules. It owns `renderShapes()`, viewport
culling and level of detail, refined-segment overlays, and the helpers that
create, attach, redraw, re-pose, detach and discard entity SVG
(`mountShape`, `unmountShape`, `mountComponent`, `refreshComponentPose`,
`withContentDetached`, …). Shape and component entities are model-only: shape
SVG/anchor handles and component symbols/highlights/pin dots/lock icons are
owned by renderers in `src/schematic/render/`, backed by WeakMap view state
keyed by entity identity. Commands, file loading, clipboard ghosts, theme
changes and inline text editing call the lifecycle/render helpers; none of them
touch entity `element`, `anchorsGroup`, `pinElements`, `render()` or the
viewport content layers.
Clean shapes only take the zoom fast path (stroke-width update) when the scale
has changed since the previous `renderShapes()` pass, so hover frames do no
per-shape view lookups.
`test-schematic-view-boundary` tests the helpers and fails on new
view-lifecycle code elsewhere in the schematic editor.

## Interactions and Previews

In-progress interactions follow the PCB editor's contract.
`schematic/modules/schematic-interactions.js` is the one list of them, in
cancellation priority, with PCB's categories (`gesture`, `drawing`) and a
`blocksSnapshot` flag: inline text edit, overlap-cycle press, drag (anchor, segment
and move drags and box selection), pending midpoint split, drawing, paste and
component placement. `schematic-interaction-routing.js` holds each one's cancel
handler. Everything that needs to know what is in progress derives from the table:
the snapshot guard (`SchematicApp.isSectionEditing()`, with the Properties live
preview), Escape (cancels the highest-priority interaction), Undo/Redo (drawing
blocks it, inline text, paste and placement are only cancelled, pointer previews
are cancelled and history still steps, as in the PCB editor), tool switching
(cancels everything but inline text and a placement the Component tool keeps), New
(cancels everything) and selection actions (delete, cut, paste, nudge, flip,
rotate, select all wait while anything is in progress). `interactionState` in
`draw-states.js` still drives pointer dispatch; `resolveState()` derives it from the
same fields. `test-schematic-interactions` checks the table, routes and guards.

The mechanism behind a preview differs from the PCB editor's on purpose. PCB
previews edit detached copies because pours, DRC, ratsnest and the 3D view would
otherwise recompute from half-finished geometry. The schematic has no such
background work, and much of what a drag affects follows the authored entities
live (sticky wires, attached labels, junction dots, label guides, text
measurement), so schematic previews and drags edit the authored entities and
restore them on cancel: anchor and segment drags from their before-states, a move
drag from a snapshot of the moved selection, its field and label texts and every
wire taken at its first movement. The cost is that each gesture must restore
everything it touched; `browser-tests/schematic-cancel-isolation.mjs` cancels every
gesture by Escape, tool switch and Undo and checks the model and history are
unchanged, the counterpart of the PCB preview-isolation tests. Snapshots cannot
see a half-finished edit because `ProjectDocument` refuses to snapshot while
`isSectionEditing()` is true. Revisit copies if the schematic gains work that reads
the model during a gesture (live electrical-rule checks, live PCB sync).

## Object Locks

Locks follow the PCB editor's rules (see [PCB Editing](pcb-editing.md#object-locks));
the schematic has no layer locks, so a shape or component's own `locked` flag
(saved as `lk`) is the whole story. A field text that belongs to another object (a
component's reference or value, a wire's name, a net label's text) has no lock of its
own and follows its owner's, as a PCB reference designator follows its component
(`shapes/lock-owner.js`: `lockOwner`, `isSchematicLocked`, `hasOwnLock`); its
Properties show no Locked checkbox and its lock icon offers to unlock the owner.
Detachable labels and free texts keep their own lock. Every lock check uses
`isSchematicLocked`. A locked object can be selected (by click, Select All or the
marquee) but not moved, edited or deleted:

- Move drags and arrow nudges carry only the unlocked part of the selection, and
  their snapping, sticky-wire and junction helpers see only that part; grabbing a
  locked member of a selection moves the rest. Rotate and flip skip locked
  components; Delete and Cut skip locked objects; Copy takes them, and pasted copies
  start unlocked.
- Properties edits apply to the unlocked members only; a field is read-only only when
  every selected object is locked. The Locked checkbox (mixed for a mixed selection)
  locks or unlocks the whole selection as one undo step; it appears whenever any
  selected object has its own lock, even alongside owned field texts.
- A selected locked object shows a lock icon instead of edit handles.
  `render/lock-placement.js` places it with the shared `core/lock-position.js`:
  just outside the object's outline (closed shapes as one loop, wires and lines by
  their stroked segments, other entities by their world bounds), beside the part
  nearest the press that selected it (`SelectionManager.lockPointer`, recorded by
  `mouse.js`). Component locks are drawn in world space next to the symbol, so they
  never rotate or mirror with it. Clicking the icon opens a menu to unlock that
  object (`locks.js`), undoable.

`test-schematic-lock-placement` and `browser-tests/schematic-locks.mjs` cover these.

## Startup and Component Picker

Schematic startup immediately starts KiCad index loading in the background,
without awaiting the download, to minimize the wait on first picker use.
Opening the Online picker or starting a search joins the shared in-flight load,
uses its warmed result, or retries a failed load. Switching an open picker from
Local to Online retains that behavior; Local mode does not add a separate request.
The fetcher owns cache hydration and stale-cache refresh as well as shared work.
Progress belongs to the current visible empty-query picker, and searches retain
their generation guard. Exhausting every index ref rejects explicitly without
publishing incomplete data or replacing a usable cached index. First-search
initialization errors use the normal search error/finally path rather than
leaving the loading state active indefinitely.

The component picker header has an accessible 36-by-36-pixel close button with
a 24-pixel X and shared dialog-close hover/focus styling. Button, Escape and
programmatic/toggle closure share cleanup and emit `component:pickerClosed` once
per open-to-closed transition.
The tool owner returns Component mode to Select and cancels placement;
closing during a switch to another tool does not override that new tool.
Choosing Place Component does not dismiss the picker or switch back to Select.
Returning to Select with no selection also activates Home, so cancelling a
drawing tool with Escape does not leave an empty Properties tab. Selection
properties remain visible when switching to Select with a selection.
The picker's "Exact match" checkbox filters the current Online (EasyEDA/KiCad)
or Local results to those whose part number, manufacturer part number or name
equals the search text, ignoring case (`isExactNameMatch()`); toggling it
re-filters without a new online search.
