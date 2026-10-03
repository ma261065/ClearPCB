# Autorouter

Part of the [module contracts](../module-contracts.md). The routing session in
the editor and the contracts of the router worker behind it. The routing
algorithms are described in [autorouter.md](../autorouter.md).

## Routing Session

Autorouting retains existing authored copper while its worker produces a preview.
The pending session blocks project snapshots and owns its worker, model, layout,
netlist, routing rules and command-history baseline. Edits, document replacement,
schematic changes, deactivation and disposal invalidate that ownership; stale
progress, errors and results cannot affect a successor session. User Stop remains
distinct: a current worker may return a partial result. Successful routing and
SES imports use `ReplaceRoutesCommand`, an atomic, dirtying replacement with exact
undo/redo; Clear Routes uses the same command. Worker failures preserve the previous
copper and history. The editor adapter rebuilds selection, copper presentation,
ratlines, fills and DRC after command replay.
The temporary active-connection guide uses the normal ratline color, width and
opacity, with rounded 4px dashes and 3px gaps distinguishing it from real ratlines.
It promotes exactly one actual node-based ratline from the active copper,
retaining that edge's exact endpoints; it does not independently target curve
interiors or hide the other edges attached to the source. After every graph
rebuild, the solid lines plus the dashed replacement still represent every
connection exactly once. The dashed edge remains visible with Ratlines disabled.
Track drawing supplies detached preview tracks/vias to the same connectivity
calculation, restricted to the affected nets, without authoring model entities.
Unchanged previews reuse that input. Cancel/commit removes the provisional input
and restores the normal graph. DRC's existing pending-edit guard prevents checking
an unfinished gesture; guide styling itself never removes neutral ratline records.

`pcb/modules/autorouter-session.js` owns the routing session, worker, cancellation
polling, result-adoption guard and disposal. It receives explicit capabilities
for board-state capture, route-input capture, router mode, command adoption,
ratsnest reconciliation and status/error reporting, not the editor object.
`pcb/modules/autorouter-presentation.js` owns progress controls, phase delays,
temporary routing artwork, fade frames and ratline visibility, using injected
DOM/layer/rule capabilities and schedulers. `PCBApp` supplies those adapters and
retains the canonical model/command boundary; it no longer owns the worker or
presentation timers. Independent owner tests exercise cancellation, supersession
and cleanup without constructing an editor.

## Architecture

The router lives under `src/pcb/modules/` and is split into three
modules sharing common infrastructure:

- `autorouter-common.js` — min-heap, `SpatialHash`, geometry,
  `padPointBlocked` / `padSegmentBlocked`, `CongestionGrid`,
  `PathfinderGrid`, `astarRoute`, `astarProbe`, path post-processors
  (`simplifyPath`, `fixAngles`, `optimizePath`, `sanitizeAngles`),
  `buildCandidateRoutes`, `isValidAngle`, `NODE_KEY` constants.
- `autorouter-maze.js` — Maze (rip-up) router. Exports `routeAll`,
  `routeWithMazeRouter`, plus maze-only helpers (`buildMstEdges`,
  `defaultChainEdges`, `netManhattan`). Holds the `RouteInput` /
  `RouteResult` typedefs.
- `autorouter-pathfinder.js` — Negotiated-congestion (McMurchie/Ebeling)
  router. Exports `routeAllPathfinder`, `routeWithPathfinderRouter`,
  plus extraction / re-route / verification helpers (`extractFeasibleSubset`,
  `extractAndReroute`, `geometricVerifyAndDrop`, `smoothPathfinderRoutes`,
  `unionExtend`, `ripUpSwap`, `astarRouteWithRefinement`,
  `astarRouteAnyEndpoint`).

`autorouter-worker.js` (Web Worker) imports `routeWithMazeRouter`
and `routeWithPathfinderRouter`. UI dropdown values are `'maze'`
and `'pathfinder'`.

### Router I/O Contract

`RouteInput` (from `PCBApp._buildRouteInput()`):

```js
{
  connections: [{ net, pads: [{ x, y, width, height, layer, shape, alternates? }] }],
  allObstaclePads,
  trackWidth, clearance, viaDiameter,
  gridStep,
  bounds,
}
```

`RouteResult`:

```js
{
  tracks: [{ net, layer: 'top'|'bottom', points: [{x,y}], vias?: [{x,y}] }],
  vias: [{ x, y, net? }],
  failed: [...],
  failedConnectionCount,
  totalConnectionCount,
}
```

### Design-Rule Single Source of Truth

`clearance`, `trackWidth`, `viaDiameter` are **never** hardcoded in
the router or DSN code. They flow from `#pcbClearance`,
`#pcbTrackWidth`, `#pcbViaDiameter` HTML inputs through
`PCBApp.getRoutingParams()`. `routeAll`, `routeAllPathfinder`,
`exportDSN`, and `importDSN` all throw if any of these are missing
or non-positive. DSN round-trips `viaDiameter` via the
`via_default` padstack circle radius.

### Pad Obstacle Model

Pad shape vocabulary `'rect' | 'ellipse' | 'oval' | 'polygon'` flows
through `padPointBlocked` / `padSegmentBlocked` in `autorouter-common.js`:

- `rect` — exact AABB distance with `clearance²` (rounded corners)
- `ellipse` — circle distance when `hw == hh`; anisotropic ellipse otherwise
- `oval` — stadium (segment-to-segment distance + minor radius)
- other — rect bbox fallback (conservative)

Vias are treated as `shape: 'ellipse'` with `hw == hh` so they
behave as exact circles (not over-blocking squares).

Source pipeline for pad shapes: EasyEDA `PAD~ELLIPSE/RECT/OVAL/POLYGON`
in `footprint.js`, KiCad circle/oval split in `KiCadFetcher.js`.

### Connection Topology

- Classic / maze router uses a planar **Euclidean MST** (Prim's,
  `buildMstEdges`) for each net's connection graph. MST in the plane
  is provably non-crossing; previous nearest-neighbour chains caused
  visible self-crossings on high-pin nets.
- Pathfinder still uses the legacy `nncReorderPads` chain — its
  negotiated-congestion loop was tuned against the chain ordering
  and multi-start / MST variants tested neutral-to-negative.

### Multi-Pad Pins (`alternates`)

A connection pad may carry `alternates: [{x,y,width,height,layer,shape}, ...]`
representing other pads sharing the same logical pin (e.g. thermal
pads with via-stitched copies). Router internals:

- `netPadIdList` is `Array<Array<string>>` — one group per pad
  (primary + alts). `skipIdsForPair` flattens groups so all alt pad
  ids are skipped during routing.
- `astarRouteAnyEndpoint` enumerates `(primary+alts) × (primary+alts)`
  endpoint pairs, sorted by Manhattan distance, tries each until one
  succeeds. Used in pathfinder's three A* call sites; classic
  `routeAll` only benefits from skipIds union (single-endpoint A*).

### Same-Net Via-In-Pad

Same-net vias on pads are **allowed** (required for SMD thermal /
centre pads only reachable from the opposite layer). Pad obstacle
records carry both `obj.net = pad.id` (for `skipIds`) and
`obj.netName = conn.net` (for `isOnPad` `skipNet`). Foreign pads
still hard-block. `tools/check-clearance-full.mjs` exempts same-net
via-pad too.
