# Implicit-via convention

## Definition

A **via** in ClearPCB is any plated through-hole that connects two copper
layers. Vias come in two flavours:

1. **Standalone `Via` shapes** — independent `Via` objects in
   `PCBApp.vias`, rendered by `track-render.renderVia()`. Used for
   ground-plane stitching, decoupling, and user-placed vias.
2. **Implicit vias** — *not* a separate object. They are inferred from a
   single `Track` whose `edgeLayers` map assigns different copper layers
   to edges that meet at the same node. The node where the layer changes
   *is* the via.

The autorouter produces implicit vias because a routed net is one
connected `Track` graph that may freely switch layers mid-route.
Materialising a separate `Via` for every layer change would double-book
the geometry (the `Via` and the `Track` node at the same point) and risk
the two drifting apart on edit.

## API

`Track.getImplicitViaNodes()` ([src/shapes/track.js](src/shapes/track.js))
returns the node IDs at which the `Track`'s incident edges use more than
one layer. It is the single source of truth for "where are this track's
implicit vias?"; every consumer must go through it.

```js
const viaNodeIds = track.getImplicitViaNodes();
for (const nid of viaNodeIds) {
    const node = track.nodes.get(nid);
    // node.x, node.y is the via position
    // via diameter / drill come from the routing params,
    // not from the Track itself.
}
```

Diameter and drill for an implicit via are **not** stored on the
`Track`; consumers pull them from app routing params (PCBApp's
`_getRoutingParams()`), so the value is uniform across a board and
follows the user's clearance/via settings.

## Consumers

| Code path | Behaviour |
|-----------|-----------|
| [src/pcb/modules/track-render.js](src/pcb/modules/track-render.js) | Draws an SVG ring + drill at each implicit-via node. Tags the elements with `dataset.implicitVia = '1'` so hit-testing can distinguish them from `Via`-shape vias. |
| [src/pcb/modules/gerber.js](src/pcb/modules/gerber.js) | Emits a circular flash on both copper layers and an Excellon hole at every implicit-via node, in addition to the standalone `Via` shapes. |
| Autorouter adapter ([src/pcb/modules/autorouter-adapter.js](src/pcb/modules/autorouter-adapter.js)) | Produces tracks whose `edgeLayers` already encode the layer changes. The adapter deliberately does *not* create separate `Via` shapes for layer transitions — those become implicit vias on render. |

## Invariants

- An implicit via has identical (x, y) as the `Track` node that produced
  it. Editing the node moves the via automatically; there is nothing
  separate to keep in sync.
- The set of implicit vias is a pure function of `Track.nodes`,
  `Track.edges`, and `Track.edgeLayers`. Do not cache it across edits —
  always re-derive via `getImplicitViaNodes()`.
- Standalone `Via` shapes never overlap implicit vias for the same net.
  If a routed track lands on an existing standalone `Via`, the standalone
  one wins (and the track simply terminates at its position).
- `Track.toJSON()` does not separately serialise implicit vias; the
  `edgeLayers` map is sufficient to reconstruct them. Older save files
  that did emit explicit vias for layer changes are still loadable —
  duplicate vias at the same coordinate are deduped on render.

## Why not always use a `Via` shape?

We considered (and rejected) materialising every layer-change node as a
separate `Via` shape. Reasons:

- **Identity**: A single routed net is conceptually one connected piece
  of copper. Splitting it across many `Track`/`Via` objects makes
  selection, deletion, and net membership awkward.
- **Edit drift**: A user dragging a track node would have to also drag
  the colocated `Via` shape, with no enforcement that they stay glued
  together.
- **Net membership**: A `Via` shape carries its own net string. An
  implicit via inherits the `Track`'s net by definition, eliminating the
  possibility of net-mismatch on layer change.

If you ever need a piece of code to treat all vias uniformly — for
example, DRC or fabrication output — iterate both `PCBApp.vias` and
`track.getImplicitViaNodes()` for every `Track`. See
[src/pcb/modules/gerber.js](src/pcb/modules/gerber.js) `_buildDrill` for
the canonical pattern.
