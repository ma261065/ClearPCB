# UI Conventions

Both editors' status bars align labels, monospace values, hints and filenames
on a shared text baseline rather than vertically centering their different font
boxes. The status bar retains its 24 px height.

Placing a NetLabel directly on a schematic pin names that pin's PCB net without
requiring a wire. If the pin already has a wire, the label names the connected
wire net too. Same-named labels join their pins, and the label spelling is
preserved in PCB net menus. Moving or removing the label restores the remaining
wire name or the default single-pin net on the next schematic-to-PCB sync.
Dragging a standalone NetLabel by its symbol or connection anchor uses the same
0.5 mm pin snap tolerance as placing a new label or picking up a wire at a pin.
This does not change active-wire routing's existing approach tolerance.
Snap probes
use the raw projected connection point before grid quantization, exclude the
label's own virtual pin, and move the connection point exactly to the highlighted
target. Already wire-connected whole-label drags retain sticky-wire behavior.
NetLabels directly on component pins follow the pin when the component moves,
rotates or flips, including live drag, Escape and undo/redo. Their visible text
travels once with the label, and wires owned by that label follow afterward.
Contacts are captured from authored geometry before each edit, so dragging a
label off its pin detaches it without persistent attachment metadata.
During component dragging, yellow snap dots indicate potential new connections
for free pins only. Pins already attached to wires, including wires attached
through a direct pin NetLabel, are excluded from the connection magnet; their
sticky wires still follow normally. The component's own pins and other moving
pin owners cannot become snap targets.
Component dragging shows only collinearity feedback when an attached wire's
dogleg straightens and can be eliminated, not H/V indicators for automatically
orthogonal wire stubs. Straightening targets use stationary wire nodes beyond
sticky bridges. Guides are rebuilt after the final snapped movement; moving
owners are not fixed references.
The generated bridge path and the stationary continuation must share the same
straight direction. Aligning a pin stub with a corner that still turns, or
doubles back, does not qualify for collinearity feedback.
When a pin-side dogleg straightens, its indicator covers the complete
straightened prefix, including intermediate stationary nodes. It stops at the
next bend, branch, pin attachment, curved edge or reversal; later unrelated
doglegs do not suppress feedback for that useful straightened section.

Both editors offer only Fit, not a separate Default view action. Outside text
and Properties inputs, Home activates Select, opens the active editor's Home tab and fits its
content using the same operation as the Fit button. Native Home-key cursor
movement and inline text selection remain unchanged.
Help lists Home for Select, Home-tab navigation and Fit. Space does not fit the
view when nothing is selected; its object rotation and routing Via shortcuts
remain unchanged.
Schematic and PCB Fit use the same bottom-left alignment: the left margin is
10 mm from the left ruler's inner edge, and the bottom margin is 10 mm above
the viewport bottom. The origin is included in the fitted bounds, and zoom
selection excludes the ruler area so content remains visible. PCB panels retain
their extra top clearance. An empty schematic retains its 100% initial zoom
with those same margins. With rulers hidden, margins start at the viewport edges.

When only components are selected, both editors show:
“Tip: SPACE to rotate, X for horizontal flip, Y for vertical flip”.
The hint clears or changes when selection changes to other object types.

Object actions offered by a context menu must also be available in Properties
for the same object or focused node/segment, with the same eligibility and lock
restrictions. The two surfaces reuse action builders and command handlers.
This includes splitting nodes/junctions, disconnecting wire pins, converting
segments, deleting a part or the whole object, detaching text and viewing a
component's 3D model. Properties conversions commit the new segment geometry
without picking up its bulge handle; context-menu conversions retain their
existing floating-handle interaction. Split actions retain their drag workflow
from either surface.

In the schematic, one blank-canvas click clears the selected shape even after
refining its node or segment. Suppression of a refinement's native click is
limited to that gesture, including when rerendering removes the clicked SVG node.

Node dragging can snap both adjoining segments at once: H/V–H/V intersections
and nearby H/V–45° intersections from different neighbours are supported. A mixed
intersection must be within the normal snap distance, so distant intersections
do not pull the node away. Hard connection targets and collinear snapping retain
priority; Shift bypasses alignment snapping.
Wire endpoint dragging composes compatible hard targets with alignment
constraints. For example, snapping onto a horizontal wire segment preserves a
vertical incident-wire guide and lands at the segment/axis intersection.
Yellow hard-target feedback and compatible axis guides remain visible together;
an incompatible point target does not move merely to satisfy an axis guide.
Two schematic wires that cross through both segment interiors show a local
crossover cue on the visually upper wire: two canvas-colored one-screen-pixel
strokes run
parallel just outside its edges. There is no local wire overdraw or foreground
box; the already-rendered wire remains visually continuous during hover/selection.
Normal visual stacking follows document render order, while selecting a wire
raises it and moves the cue to its edges.
Schematic shape hover and selection use a six-screen-pixel margin outside the
rendered geometry at every zoom; there is no additional fixed 0.5 mm margin at
high zoom.
While placing a component-only schematic paste, the normal component-placement
shortcuts remain active: Space rotates right, X flips horizontally and Y flips
vertically. The preview and placed component use the same transform, and each
new paste starts from the copied orientation.
Dragging a wire segment computes collinearity from the rigid translation of
both segment endpoints. When that translation makes the moved segment and an
adjoining stationary segment collinear, the usual blue dotted collinearity
guide is shown; node dragging is not required. If the intervening dogleg
collapses to zero length, the coincident bend remains a valid collinearity
transition and the guide extends through the stationary straight continuation.
Separate side strokes avoid crosswise end caps at every zoom, including 5000%
and 10000%. They span the complete rendered width of the crossed wire rather
than truncating at a fixed screen length. At an angled crossing, each side
stroke is shifted to the actual intersection of that overpass edge with the
crossed wire. The cue is confined to the crossing, ignores pointer input and
does not change connectivity.
Crossings at authored nodes, shared endpoints and T-junctions have no cue.
Direct contact between pins of two physical schematic components shows the same
green junction-dot visual used for wire-to-pin connections. The dot is derived
from the coincident pin geometry, ignores pointer input and disappears when the
components separate.
A NetLabel attached directly to a component pin shows the same green dot at the
pin. It is likewise presentation-only and follows the label's derived geometric
connection.

The flat 2D board viewer pans and zooms a cached transparent board image, leaving
its background fixed. Dragging with either the left or right mouse button pans
the view; the right button does not open a browser context menu.
Pointer moves and wheel events coalesce to one
animation-frame bitmap draw and do not rebuild copper, mask, silk or hole
geometry. Zoom keeps the world point under the cursor fixed and scales the
cached image during the gesture. A normal redraw on pan release or after 300 ms
without a zoom change restores full detail. Board/display/resize changes
invalidate the navigation image and cancel pending zoom settlement.
Normal renders retain the transparent artwork, so the first pan or wheel event
does not build a new image. Opening the viewer slides the panel and loading
indicator into view before preparing the initial artwork; selecting a 2D side
updates side and board data in a single render.
The opaque panel backdrop and initial 2D canvas background are painted before
the opening slide, preventing the underlying editor from showing through
behind the loading spinner.
The 2D and 3D views have independent loading overlays. Loading 2D must not
suppress the first 3D build's spinner; switching views hides the other view's
overlay without clearing its pending loading state.
The first switch from 3D to 2D paints the background and shows the 2D spinner
immediately, yielding through two animation frames before building artwork.
Switching away or closing/hiding the panel cancels that pending first render.
Canvas2D draws traced silkscreen pictures directly from their raw even-odd
rings, just like SVG fill-only rendering. Opening or sharpening the 2D preview
must not trigger the strictly-simple polygon merge used by physical geometry
and fabrication consumers.
At extreme zoom an overscanned viewport is captured instead of allocating an
unbounded board-sized canvas. Overscan is capped at 4096 pixels per side (or the
viewport size if larger), and refreshed when a long pan exhausts its coverage
so newly revealed artwork does not disappear.

Track clearance outlines use round polygon offsets of the rendered centreline,
including doubled-back or overlapping runs. Full and live refresh use the same
boundary, respect per-run widths and visible copper layers, and retain inner
boundaries of closed loops. Pad attachment must not change the clearance distance
or introduce diagonal lines across the copper.

Moving a track node does not show a Net Conflict popup solely because the track
already has a short. The popup guards newly made incompatible node connections,
including new Via transitions; edits that retain or remove an existing contact
remain available. Existing and incidental segment-crossing shorts remain DRC
issues rather than blocking unrelated node edits.

Drawing a new track to a yellow node target on the opposite copper layer inserts
an automatic Via at that node. Starting a new track on an opposite-layer node
does the same. Existing Vias are reused; the two track graphs stay on their own
layers, and the draw, Via and any net adoption undo together. A locked or hidden
Via layer refuses the finish with a cursor popup and leaves the drawing intact.
Different-net targets remain rejected.

Part of the [module contracts](../module-contracts.md). Conventions both editors
share: grids, units, the light palette, ribbon height, and the order and labels
of Properties controls.

Both editors use fixed grid dropdowns. The metric list starts with 0.1, 0.25,
0.5 and 1 mm, followed by a nonselectable separator bar, then 0.0254, 0.127,
0.254, 0.635, 1.27 and 2.54 mm. There are no group headings; inch-derived
sizes show their inch and mil values in parentheses, for example `0.127 mm (0.005" / 5 mil)`.
The inch list is 0.001, 0.005, 0.01, 0.025, 0.05 and 0.1 inch.
All inch presets therefore survive a switch to metric and back exactly.
Per the chosen fixed-list policy, a non-preset saved grid selects the nearest
preset when restored into an editor, even before controls exist; no custom option
is added. Unit changes also select the nearest available preset, so metric-only
sizes can still change when switching to inches. Saving from the editor records
the selected preset. Refreshing an already matching preset does not redraw the grid.

Viewport display conversions and inch ruler spacing use `1 / 25.4` rather than a
rounded reciprocal. Ruler label precision follows the selected tick spacing,
including all digits in 1/8-inch (`0.125"`) and 1/16-inch (`0.0625"`) ticks.
With a visible grid, ruler labels use 1-2-5 multiples of the grid spacing to
maintain at least 80 screen pixels between major labels. Thus a 0.1-inch grid
labels 0.1-inch intervals when zoom permits, rather than unrelated fractional
intervals. Both ruler axes remain aligned to displayed grid lines, including when
the tick limit requires skipping more lines. With the grid hidden, unit-based
spacing is used. Changing grid size or visibility refreshes the
rulers; ordinary panning still translates cached ticks without rebuilding them.
Metric labels omit trailing zeros, and extreme-zoom output stays bounded.
These presentation changes do not alter
authored geometry, grid presets or file-save precision.

Both editors share the viewport's light-mode palette: a white canvas, subtle
gray grid, medium-gray origin axes and pale-gray rulers. The `--bg-ruler` token
separates ruler shading from the rest of the UI; without it, rulers retain the
`--bg-primary` background. Dark mode and electrical layer/net colors keep their
own palettes.

The PCB Design tab's DRC status button has a fixed 160 px width across checking,
clear, error, warning and failure states so status updates do not shift the
ribbon. Long status counts ellipsize without shrinking the status icon.

The top of the DRC panel includes "Exclude clearance between pads in the same footprint",
unchecked by default. All different-net pad pairs are checked unless this
project setting is enabled; enabling it skips only internal footprint pad
clearance, not shorts or clearance to tracks, Vias or other components.
The DRC panel visibly states "Same-footprint pad clearance excluded" while enabled,
including when there are no reported problems. Toggling it reruns DRC without
altering authored copper or routing parameters.
The checkbox and exclusion notice remain above the scrolling results, not in the
Design ribbon.

Via Diameter and Via Drill settings must retain a minimum 0.050 mm annular ring:
diameter must be at least drill plus 0.100 mm. Both Design fields and New Via
Properties reject incompatible edits with validation feedback instead of
silently clamping the drill. Validated dimensions remain in millimetres regardless
of display units. The settings model rejects incompatible saved values; there is
no compatibility fallback or automatic resizing. Auto Route checks the same rule
before starting, and route adoption refuses invalid Via sizes.

Both editors use `shared/ui/ribbon-height.js` to retain the tallest static
ribbon panel. A cached container width and retained style avoid cycling every
tab through forced layout on each activation or tab change. Width changes and
font completion trigger fresh measurements; hidden ribbons retain their last
valid height until shown, and resize requests share one animation-frame callback.
Schematic reactivation also rechecks the cache after resizing while hidden.
Panel classes and height are restored if measurement fails. Flex layout,
inactive-panel hiding and maximum-height behavior continue to apply.

### Ribbon: description, renderer

The schematic and PCB ribbons are described as plain data in
`schematic/modules/ribbon-description.js` and `pcb/modules/ribbon-description.js`.
A description lists tabs, panels, titled groups and items; items cover the shared
control shapes currently used by both editors: buttons, tool buttons, checkboxes,
selects, dropdowns, split buttons, menu items and generic structured elements for
rich help/flyout content. Items also carry their behaviour (`run`, `onChange` and
`onInput`) and state accessors (`active`, `disabled`, `checked`, `value`,
dynamic labels and dynamic options). `shared/ui/ribbon.js` is the only module
that turns those descriptions into ribbon DOM, binds those handlers and refreshes
state; `index.html` keeps only the empty `#ribbonSchematic` and `#ribbonPCB`
hosts.

Ribbons keep stable IDs, classes, `data-*` attributes, titles, labels and order so
controller code and browser scenarios can wire behaviour by ID. The renderer
exposes a refresh API for description-owned state accessors
(`active`, `disabled`, `checked`, `value`), so a visual redesign should change the
renderer rather than rewriting either editor's description. Its attribute-only
refresh updates dependent input bounds without overwriting an in-progress entry
or unrelated control state; Via Design handlers use it after validated changes.
Truly custom or
externally populated areas remain slots: recent-file menus, the schematic shape
options container, the PCB layer picker/panel, DRC status, and the schematic/PCB
Properties hosts (`#propertiesPanel`, `#pcbPropertiesPanel`, `#pcbPropsItems`).
`test-ribbons-logic-only` enforces that ribbon descriptions do not touch the DOM
and that `index.html` contains no static ribbon controls.

Every Properties panel, in both editors, lists its controls in one order
defined by `PROPERTY_ORDER` in `shared/ui/property-order.js`. Panels show only
the rows that apply; whatever is shown keeps its place:

1. Locked
2. What it is: Reference, Show Reference, Ref Visible, Value, Show Value, text,
   Insert, pad Shape, Shape Kind, Outline, part source, supplier part number and
   package
3. Layer (a pad's copper sides), then Copper Mode, then Net
4. Fill, Plated
5. Position and size: X, Y, Width, Height, Size, Ratio, text size, Diameter, Drill
6. Line width, then a stroked circle's outer diameter (it includes the line
   width), Corner radius, Bulge
7. Rotation, Flip Horizontal, Flip Vertical, Orientation
8. Border, Invert, Style

Controls that decide which other controls apply come first (Locked disables the
rest; Layer decides Copper Mode and Net; Fill decides the line width). Every row
carries `data-prop` with its key, and the renderer (below) shows fields in this
order by their `prop` (or `key`), so no panel orders its own rows; a schematic
descriptor's `orderKey` becomes the field's `prop`, ranking it as a related
property. `test-property-order` checks every key is ranked and every row is tagged;
the `properties-panels-share-one-control-order-and-labels` browser scenario
renders each panel and checks the order and that each property has one label.

### Properties panels: description, renderer, host

A Properties panel is logic only. It describes itself as a `PropertyPanel`
(`shared/ui/property-fields.js`): a title, fields and action groups. A field has a
key, a type (number, select, checkbox, text, net or readout), a label and its
value, plus Mixed and disabled state, limits and options. Its edit hooks are
`normalize`, `preview`, `commit`, `cancel` and `hold`. Action groups are titled
buttons such as Transform. `renderPropertyFields` and `renderPropertyActions` are
the only code that builds the controls.

Each editor has a small host that decides where a description appears. The PCB
host is `openPropertyPanel` / `refreshPropertyPanel` in `PCBApp`; the schematic
host is `schematic/modules/property-host.js`. A new look for the panels (for
example a redesigned ribbon) changes only the renderer and the hosts. Panel
modules never touch the DOM; `test-property-panels-logic-only` enforces this.

A panel updates by describing itself again, never by patching controls. The
renderer reconciles rows by key and updates them in place, and a focused field
with unsaved edits keeps what the user is typing. Limits that follow another value
(a via's drill follows its diameter) and rows that come and go (a pad's Ratio)
are simply part of the next description.

The renderer owns the edit protocol, the same in every panel:

- **Number fields:** `input` and `change` normalize the entry (clamp or wrap; NaN
  rejects it) and call `preview`. The run commits once with `commit`, as described
  below. An invalid entry cancels the preview and restores the field. Escape calls
  `cancel` and is consumed only when something was undone. Holding a spinner (the
  pointer or an Arrow key) brackets the run with `hold.begin` and `hold.end`. Values
  show two decimals, including when updated in place, unless the field keeps its own
  digits (`numberFormat` rotation, integer or precise, or its own `format`). Text the
  renderer showed is not an edit, so leaving or "changing" an untouched field never
  rounds the model to the displayed digits.
- **Select, checkbox, text and net fields** commit on `change`. A net field's menu
  lists the current nets.
- **Mixed values** (the selected objects disagree) show an empty field with a
  `Mixed` placeholder, a disabled `Mixed` option or an indeterminate checkbox, in
  both editors.
- **Locked or layer-locked objects** use the native `disabled` attribute. The
  PCB's `lockedProperty(app, entries)` gives each panel its Locked field and
  read-only state. Unavailable fields have a muted label, tinted control,
  reduced opacity and a not-allowed cursor; disabled net controls retain a
  muted dropdown indicator. Clicking a layer-disabled field or action shows a
  short-lived "<layer name> layer locked" bubble beside the pointer, including
  copper-fill row locks and focused track-node/segment locks. The own-object
  Locked checkbox stays usable; clicking it never reports a layer lock.
  Cut is disabled when every copyable selected object is locked, in both Home
  and Properties; Copy remains available. Mixed selections can still cut their
  unlocked members without modifying locked objects.

Home drawing buttons are disabled only when all layers supported by that tool
are locked. Clicking a disabled drawing button shows a brief popup listing its
blocking layer locks (including Copper Fill rows), without an unlock action.
The popup grows to fit its text, wrapping only at the window-width limit, and
stays inside the window edges.
Tool selection defaults to the active supported unlocked layer, or
the first unlocked layer in dropdown order. Locked layer choices are disabled
and display a grey monochrome lock icon; Both-side pads require both copper
layers, and fills require the copper layer and its Copper Fill row unlocked.
Drawing Properties has no Unlock/Show section or button, and there is no
cursor-following unlock popup or blocked-tool badge. Refused placement reports
the reason in the status bar; existing object/property lock feedback is unchanged.
Attempting to draw on a hidden layer also shows a brief cursor popup naming
the hidden layer (including a hidden Copper Fill row), without a Show/Unlock
action or placing an invisible object.
Locked drawing-layer assignments do not add a yellow outline or warning-label
highlight to the dropdown; normal focus styling and the grey lock indicator remain.
The Import Picture dialog uses the same grey monochrome lock marker for locked
layer options. Locked and hidden layers remain unavailable as import destinations.
Across Properties and dialogs, the closed dropdown also shows an unavailable
selected value in grey, while remaining usable to choose an available value.
Available entries retain their normal colour in the open list. Image-dialog
layer choices update when layer locks or visibility change.
While a PCB drawing tool is active, moving the pointer back onto the canvas
releases focus from a Properties dropdown so Escape can cancel the tool or
drawing. Text and number fields retain their native editing focus and key handling.

While routing, Space can insert a Via and switch copper sides only when both
the Via layer and destination copper layer are unlocked and visible. A blocked
transition shows a brief non-actionable popup at the cursor naming the blocking
layers, without adding a waypoint, Via or locked-layer preview. Changing the
layer dropdown during an active route enforces the same transition checks.

Labels use Title Case with units on measured values, and a property has the
same label everywhere: Line Width (mm), Corner Radius (mm), Text Size (mm),
Rotation (°), Outer Diameter (mm) for a stroked circle, Layer (including a
pad's copper sides) and Net. Tracks label their width "Width (mm)" because a
track's line is its width; field text is named for its field (Reference,
Value, Label).

Pop-up menus (context menus and the lock icon's unlock menu) come from
`shared/ui/context-menu.js` in both editors: opened at the pointer, one per id,
closed by choosing an item, an outside press or Escape. Every Properties number
field, in both editors, commits through `shared/ui/settled-input.js`, so a run of
spinner clicks is one undo step and one pour/DRC refresh: the commit comes after a
quiet period, or at once on Enter or when the field loses focus. Fields with a live
preview keep showing each step while the run settles; Escape discards it. Undo/redo,
save/open/new, PCB fabrication export and switching editors call
`flushSettledChanges()` first, so a run still settling is committed rather than
lost or refused.
