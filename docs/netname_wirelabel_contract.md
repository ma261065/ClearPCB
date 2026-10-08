# Net Name vs Wire Label Contract

## Goal

Describe the data model ClearPCB uses today for schematic wire identity and
visible labels. The current model has two separate concepts:

- `wire.net`: electrical identity for a wire graph.
- `wire.wireLabel`: the visible wire-name text, shown through an attached label.

There is no `wire.netName` field in the current source or file format.

## Wire shape

`src/shapes/wire.js` defines `Wire`, a `PolylineGraph` subclass. One `Wire`
object is one electrical net graph. It stores graph nodes and edges, pin
connections, the electrical net name, and a user-facing wire label.

```js
{
  type: 'wire',
  id: string,
  nd: Record<string, [number, number]>,
  ed: Record<string, [string, string]>,

  // Compact JSON key `n`; runtime property `wire.net`.
  n: string,

  // Compact JSON key `wl`; runtime property `wire.wireLabel`.
  wl: string,

  // Compact JSON key `pc`; runtime property `wire.pinConnections`.
  pc?: Record<string, { componentId: string, pinNumber: string }>,

  // Compact JSON key `lo`; runtime property `wire.labelOffset`.
  lo?: [number, number]
}
```

When no net is supplied, `Wire` allocates `Net0001`, `Net0002`, and so on.
When no label is supplied, it allocates `W0001`, `W0002`, and so on. The ID
pools live in `src/shapes/wire.js` and are reset on New/load.

## Net label shape

Net labels are `Net` shapes from `src/shapes/net.js`, serialized as
`type: 'net'`. The canonical name entered by the user is the `net` runtime
property and compact JSON key `n`.

```js
{
  type: 'net',
  id: string,
  x: number,
  y: number,
  n: string,
  fs?: number,
  nst?: 't' | 'gnd' | 'arrow' | 'chevron',
  no?: 'N' | 'E' | 'S' | 'W',
  nto?: [number, number],
  bd?: true
}
```

A `Net` exposes a virtual `conn` pin so the existing pin-to-wire attachment path
can connect it to wires. Its display text is a derived `Text` shape with
`fieldKey === 'net'`; `SchematicDocument.serialize()` omits that derived text
and recreates it from the `Net` shape on load.

## Text labels

`Text` shapes are presentation objects. Linked text stores its parent by compact
JSON keys `cid` and `fk`, which load into `parentComponent` and `fieldKey`.

```js
{
  type: 'text',
  id: string,
  x: number,
  y: number,
  t: string,
  cid?: string,
  fk?: 'reference' | 'value' | 'net' | 'label' | 'wireLabel'
}
```

Wire names are not created as dedicated `fieldKey === 'wireLabel'` text in new
documents. Generic attached labels use `fieldKey === 'label'`; when such a label
is attached to a wire, `label-attachment.js` can copy its text into
`wire.wireLabel`, and wire reconciliation (`schematic/modules/wire-reconcile.js`, with the label rules in
`wire-labels.js`) marks one
attached label as the primary wire-name label with `attachment.wireName === true`.
The command and property paths still accept the `wireLabel` field key so older or
undo-restored data remains editable.

## Source-of-truth rules

1. `wire.net` is the electrical net name used by netlist extraction.
2. A placed or renamed `Net` shape propagates its `net` value to attached wires.
3. `wire.wireLabel` is display metadata for the wire name. It does not determine
   electrical connectivity.
4. Derived `Text` children mirror parent display fields and are recreated or
   re-linked during load.

## Conflict rules

Net-name validation trims and compares case-insensitively in
`schematic/modules/net-validation.js`.

- Placing or moving a `Net` shape onto an unlabeled connected wire network is
  allowed and propagates that name to connected wires.
- Placing or moving a `Net` shape onto a connected network that already has a
  different attached net label is rejected with a net-conflict alert.
- Drawing or merging wires with incompatible non-default net names is rejected
  by the wire/drag reconciliation paths.
- Physically disconnected wire graphs may share the same custom net name.

Wire labels are also unique case-insensitively. Properties and inline text edit
paths reject a wire label that is already used by another wire.

## Editing behavior

### Place net label

`drawing.js` validates the default net text at the placement point. If accepted,
`shape-management.js` creates the `Net`, creates its derived display text, connects
the virtual pin to nearby wires, and copies `Net.net` into those wires.

### Rename net label

`ModifyPropertyCommand` updates the `Net.net` property and calls the net
propagation helper so connected wires receive the new name. Inline net editing
uses the same validation before committing.

### Drag net label

Drag handling disconnects the `Net` from its previous wires, validates the target
connected network, and reconnects it. A conflict alert reverts the drag.

### Edit wire label text

Editing the primary attached label or the wire's `wireLabel` property updates only
`wire.wireLabel` and the visible label text. It does not mutate `wire.net`.

## Serialization rules

- Wire records persist `n` (`wire.net`) and `wl` (`wire.wireLabel`).
- Net-label records persist their own `n` (`Net.net`) and display options.
- Derived net-label text (`fieldKey === 'net'`) is omitted from the saved
  schematic and recreated on load.
- Generic attached labels (`fieldKey === 'label'`) are saved as `Text` shapes and
  reattached to their parent by `cid` during load.
- Net extraction in `src/core/netlist.js` reads `shape.net` from wires as the
  netlist name.

## Undo/redo rules

Commands that change a wire or net label capture the affected shape state before
and after the edit. Wire reconciliation records `wire.net`, `wire.wireLabel`,
pin connections, label visibility/position and linked label text as part of its
wire snapshots, so undo/redo restores both electrical identity and display text.
