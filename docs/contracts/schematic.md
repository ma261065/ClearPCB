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

Two PCB patterns are deliberately not mirrored in the schematic. Property
previews and drags still edit the authored entities and restore them on
cancel, instead of editing detached copies: transient state cannot reach a
saved or synchronised snapshot because `ProjectDocument` refuses to snapshot
while `SchematicApp.isSectionEditing()` reports a preview, drag, drawing,
inline edit, paste or placement, and the derived visuals (label guides, the
inline-edit overlay, text measurement) follow the authored entities for free.
Nor is there a PCB-style interaction table: the schematic's in-progress state
is one `interactionState` machine (`draw-states.js`) with a single Escape
precedence (`handleEscape()` in `keyboard.js`), and its keyboard guards test
different subsets of that state rather than one repeated list.

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
a 24-pixel X and shared dialog-close hover/focus styling. Button, Escape and programmatic/toggle closure share
cleanup and emit `component:pickerClosed` once per open-to-closed transition.
The existing tool owner returns Component mode to Select and cancels placement;
closing during a switch to another tool does not override that new tool.
Choosing Place Component does not dismiss the picker or switch back to Select.
Returning to Select with no selection also activates Home, so cancelling a
drawing tool with Escape does not leave an empty Properties tab. Existing
selection properties remain visible when switching to Select with a selection.
The picker's "Exact match" checkbox filters the current Online (EasyEDA/KiCad)
or Local results to those whose part number, manufacturer part number or name
equals the search text, ignoring case (`isExactNameMatch()`); toggling it
re-filters without a new online search.
