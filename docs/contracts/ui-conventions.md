# UI Conventions

Part of the [module contracts](../module-contracts.md). Conventions both editors
share: grids, units, the light palette, ribbon height, and the order and labels
of Properties controls.

Both editors use fixed grid dropdowns. The metric list starts with 0.1, 0.25,
0.5 and 1 mm, followed by a nonselectable separator bar, then 0.0254, 0.127,
0.254, 0.635, 1.27 and 2.54 mm. There are no group headings; inch-derived
sizes show their inch and mil values in parentheses, for example `0.127 mm (0.005" / 5 mil)`.
The inch list remains 0.001, 0.005, 0.01, 0.025, 0.05 and 0.1 inch.
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
the tick limit requires skipping more lines. With the grid hidden, the existing
unit-based spacing is retained. Changing grid size or visibility refreshes the
rulers; ordinary panning still translates cached ticks without rebuilding them.
Metric labels omit trailing zeros, and extreme-zoom output stays bounded.
These presentation changes do not alter
authored geometry, grid presets or file-save precision.

Both editors share the viewport's light-mode palette: a white canvas, subtle
gray grid, medium-gray origin axes and pale-gray rulers. The `--bg-ruler` token
separates ruler shading from the rest of the UI; without it, rulers retain the
existing `--bg-primary` background. Dark mode and electrical layer/net colors
are unchanged.

Both editors use `shared/ui/ribbon-height.js` to retain the tallest static
ribbon panel. A cached container width and retained style avoid cycling every
tab through forced layout on each activation or tab change. Width changes and
font completion trigger fresh measurements; hidden ribbons retain their last
valid height until shown, and resize requests share one animation-frame callback.
Schematic reactivation also rechecks the cache after resizing while hidden.
Panel classes and height are restored if measurement fails. Existing flex layout,
inactive-panel hiding and maximum-height behavior are unchanged.

Every Properties panel, in both editors, lists its controls in one order
defined by `PROPERTY_ORDER` in `shared/ui/property-order.js`. Panels show only
the rows that apply; whatever is shown keeps its place:

1. Locked
2. What it is: Reference, Show Reference, Value, Show Value, text, pad Shape,
   Outline, part source and package
3. Layer (a pad's copper sides), then Copper Mode, then Net
4. Fill, Plated
5. Position and size: X, Y, Width, Height, Size, Ratio, text size, Diameter, Drill
6. Line width, then a stroked circle's outer diameter (it includes the line
   width), Corner radius, Bulge
7. Rotation, Flip Horizontal, Flip Vertical, Orientation
8. Border, Invert, Style

Controls that decide which other controls apply come first (Locked disables the
rest; Layer decides Copper Mode and Net; Fill decides the line width). PCB rows
carry `data-prop` with their key; the schematic sorts its descriptors with
`sortByPropertyOrder` (a descriptor's `orderKey` can rank it as a related
property) and the PCB multi-selection panel sorts its shared keys the same way.
`test-property-order` checks every key is ranked and every row is tagged;
the `properties-panels-share-one-control-order-and-labels` browser scenario
renders each panel and checks the order and that each property has one label.

Labels use Title Case with units on measured values, and a property has the
same label everywhere: Line Width (mm), Corner Radius (mm), Text Size (mm),
Rotation (°), Outer Diameter (mm) for a stroked circle, Layer (including a
pad's copper sides) and Net. Tracks label their width "Width (mm)" because a
track's line is its width; field text is named for its field (Reference,
Value, Label).

Pop-up menus (context menus and the lock icon's unlock menu) come from
`shared/ui/context-menu.js` in both editors: opened at the pointer, one per id,
closed by choosing an item, an outside press or Escape. Number fields whose commit
is expensive (pour geometry, the PCB multi-selection panel) use
`shared/ui/settled-input.js`, so a run of spinner clicks commits once: after a
quiet period, or at once on Enter or blur. Fields with a live preview (PCB pad,
via and track panels, schematic numbers) commit on `change` as before.
