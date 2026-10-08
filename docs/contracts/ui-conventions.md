# UI Conventions

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
renderer rather than rewriting either editor's description. Truly custom or
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
  read-only state.

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
