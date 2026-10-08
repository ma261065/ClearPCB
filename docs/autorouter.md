# ClearPCB Autorouter

Two connection-oriented routers — a maze router with rip-up-and-reroute
(inspired by [Freerouting](https://github.com/freerouting/freerouting)) and a
negotiated-congestion pathfinder — sharing a common geometry / A* core.

PCB conductors are called **tracks** in the UI, reports and documentation.
Routing payloads use `tracks`, `trackWidth` and `netTracks` consistently.
Authored `.cpcb` board data uses tracks and its format is unchanged. DSN/SES
syntax retains the external format's `wire` and `path` keywords.
Image tracing is an unrelated image-conversion operation.

## Architecture

```
┌─────────────┐     adapters      ┌──────────────────────────┐
│  PCBApp.js  │◄─────────────────►│ autorouter-session.js    │
│  (main UI)  │                   │ + autorouter-presentation│
└─────────────┘                   └────────────┬─────────────┘
                                               │ postMessage
                                               ▼
                                   ┌──────────────────────┐
                                   │ autorouter-worker.js │
                                   │   (Web Worker)       │
                                   └──────────┬───────────┘
                                              │
                              ┌──────────────┴─────────────┐
                              ▼                            ▼
                  ┌───────────────────┐    ┌──────────────────────┐
                  │ autorouter-maze.js │    │ autorouter-pathfinder.js │
                  │   routeAll()       │    │   routeAllPathfinder()   │
                  └────────┬──────────┘    └───────────┬──────────┘
                           │                       │
                           └──────────┬────────────┘
                                      ▼
                            ┌──────────────────────┐
                            │ autorouter-common.js │
                            │ SpatialHash, A*,     │
                            │ CongestionGrid,      │
                            │ PathfinderGrid       │
                            └──────────────────────┘
```

`autorouter-session.js` owns the current routing session, worker lifetime,
cancel/stop semantics and result adoption guard. `autorouter-presentation.js`
owns progress UI, incremental preview copper, temporary attempt artwork and
ratline visibility. `PCBApp` supplies adapters for board-state capture, route
input, routing rules, command adoption and status reporting.

The router runs in a **Web Worker** to keep the UI responsive. The session and
worker communicate via `postMessage`:

| Message (worker → UI)  | Purpose                                     |
|------------------------|---------------------------------------------|
| `progress`             | Phase/pass progress for status bar           |
| `netRouted`            | `netTracks` array — render incrementally      |
| `netFailed`            | Connection could not be routed               |
| `connRipped`           | Connection removed during rip-up             |
| `netPendingChanged`    | Update ratsnest visibility for a net         |
| `trying`               | Flash yellow line showing current A* attempt |
| `done`                 | Routing complete — final `RouteResult`       |
| `error`                | Routing failed with an error message         |

| Message (UI → worker)  | Purpose                                     |
|------------------------|---------------------------------------------|
| `start`                | Begin routing with `RouteInput`              |
| `cancel`               | Abort routing (checked each A* yield)        |

## Data Structures

### RouteInput

`buildRouteInput(app)` in `pcb/modules/route-input.js` builds this payload.
`PCBApp._buildRouteInput()` delegates to that module.

| Field             | Type                | Description                         |
|-------------------|---------------------|-------------------------------------|
| `connections`     | `Array<{net, pads}>` | Net name + ordered pad array; pads may include `alternates` |
| `allObstaclePads` | `Array<Pad>`        | All pads (including non-netlist)    |
| `copperObstacles` | `Array`             | Fixed copper features to avoid but not rip up |
| `trackWidth`      | `number`            | Required track width in mm         |
| `clearance`       | `number`            | Required clearance in mm           |
| `viaDiameter`     | `number`            | Required via diameter in mm        |
| `gridStep`        | `number`            | Required grid resolution in mm; editor/DSN inputs use `0.5` |
| `bounds`          | `{minX,minY,maxX,maxY}` | Board bounding box             |

### RouteResult

| Field                  | Type           | Description                          |
|------------------------|----------------|--------------------------------------|
| `tracks`               | `Array`        | Routed track segments                |
| `vias`                 | `Array`        | Via locations `{net, x, y}`          |
| `failed`               | `string[]`     | Unrouted net names                   |
| `failedConnectionCount`| `number`       | Number of unrouted connections       |
| `totalConnectionCount` | `number`       | Total connections in input           |

### SpatialHash

Grid-based spatial index for obstacle queries. Maze and pathfinder routing use
`Math.max(gridStep * 4, 2.0)` mm cells for their main obstacle hash.
Stores two types of obstacles:

- **Pads**: `{cx, cy, hw, hh, net, layer, isPad: true, isVia, connId, id}`
- **Segments**: `{x1, y1, x2, y2, hw, net, layer, connId}`

Key operations:
- `isBlocked(x, y, clearance, skipIds, layer, skipNet)` — point query
- `isSegmentBlocked(...)` — segment query
- `insert(x1, y1, x2, y2, hw, net, layer, connId)` — add track segment
- `removeConnection(connId)` — surgical removal for rip-up
- `isOnPad(x, y, clearance, skipNet)` — via placement check

The `skipIds` set exempts the source and destination pad groups for the current
sub-route. The `skipNet` parameter makes same-net routed tracks and fixed copper
transparent to A\*; unrelated pads still block unless their pad IDs are in
`skipIds`.

### CongestionGrid

Tracks how many different nets use each spatial cell. Built from routed tracks
plus demand lines from failed connections. Used during rip-up passes to steer
A\* away from congested corridors.

## Routing Algorithm

### Phase 1: Initial Routing

All connections are routed individually (not as whole nets), sorted
**hardest-first** by difficulty score:

```
score = manhattan_distance + local_pad_density × max(gridStep, 0.5)
```

The maze router builds a Euclidean MST for each multi-pad net and flattens the
MST edges into individual connections before scoring them.

Each connection attempts routing in three stages:
1. **Direct line** — if H/V/45° and unblocked on a shared layer
2. **Sanitized 2-segment** — dog-leg for invalid angles
3. **A\* pathfinder** — 3 escalating attempts with finer grid + more iterations

### A\* Pathfinder

Weighted A\* on a virtual 2-layer grid with 8-directional movement + via
transitions.

**Grid**: Positions snapped to `effectiveStep` (adapts to route length).
Restricted to a corridor of `max(routeDist × 0.6, gridStep × 30)` around
start/end.

**Costs**:

| Cost Component     | Formula                                         |
|--------------------|-------------------------------------------------|
| Step               | `effectiveStep` (diagonal: `× 1.414`)           |
| Via                | `gridStep × 30 × viaCostScale`                  |
| Bend               | `gridStep × 0.5 × bendCostScale`                |
| Pad diagonal       | `gridStep × 5` near pad (discourages diagonal pad entries) |
| Direction          | `gridStep × 2` for non-preferred direction (top=H, bottom=V) |
| Congestion         | `min(density, 120) × gridStep × 0.01 × scale`   |
| History            | `(congestion − 1) × gridStep × historyWeight`   |

**Via placement rule**: Via center must be at least `viaRadius + clearance` from
any foreign pad edge. Source/destination pad groups are exempt through
`skipIds`; same-net pad checks use `skipNet` where the router tests whether a
via is on a pad.

**Termination**: Max iterations, stagnation detection, detour factor cap, or
cancel token.

After pathfinding, the raw path is post-processed:
1. `simplifyPath` — line-of-sight redundant waypoint removal
2. `fixAngles` — insert dog-legs for non-H/V/45° segments
3. `optimizePath` — replace staircase patterns with clean L-shapes
4. `sanitizeAngles` — final decomposition to H/V/45° segments
5. Split into single-layer segments at via points

### Phase 2+: Rip-up-and-Reroute

Up to `MAX_PASSES` (default 4) passes while failed connections remain.

Before each pass, a **CongestionGrid** is rebuilt and
`activeHistoryWeight = 0.3 × pass`. This implements **negotiated congestion**:
later passes penalize congested areas more aggressively, spreading tracks.

For each failed connection:

1. **Probe** — `astarProbe` finds the cheapest path treating tracks as
   crossable (with heavy penalty). Returns the set of foreign connection IDs
   crossed.
2. **Identify blockers** — If probe fails, fall back to
   `findBlockingConnIds` (direct segment check), then `findBlockingNets` →
   expand to all connection IDs.
3. **Rip** — Surgically remove blocking connection obstacles using
   `removeConnection(connId)`. Fire `onConnRipped`.
4. **Route** — Attempt the failed connection using the pass's phase profile.
5. **Re-route ripped** — Re-route each ripped connection individually.
   Failed re-routes are added to the next pass's failed list.

### Best-State Tracking

After each successful routing, `captureBestIfImproved()` snapshots
`routedTracks` if the routed connection count exceeds the previous best.
The final output uses the best snapshot, so transient rip-up degradation
doesn't affect the result.

## Phase Profiles

Each A\* attempt has tunable parameters. Profiles escalate across attempts
(coarse→fine grid) and across rip-up passes (increasingly aggressive).

| Parameter         | Attempt 1 | Attempt 2  | Attempt 3       |
|-------------------|-----------|------------|-----------------|
| Grid step scale   | 1.0×      | 0.5×       | 0.25×           |
| Greedy weight     | 1.4       | 1.2        | 1.0 (optimal)   |
| Max iterations    | 100K      | 300K       | 600K            |
| Detour factor     | 2.0×      | 3.0×       | 5.0×            |

Later rip-up passes reduce via costs (encouraging layer changes), relax
direction penalties, and increase iteration/detour limits.

## Key Design Decisions

### Connection-Oriented (not Net-Oriented)

Every operation — initial routing, rip-up probing, obstacle removal,
re-routing — works on individual **connections** (pad pairs), not whole nets.
This enables:

- **Independent ordering**: connections sorted by global difficulty regardless
  of which net they belong to
- **Surgical rip-up**: only the specific blocking connection is removed, not
  the entire net's tracks
- **Same-net transparency**: `skipNet` makes same-net tracks invisible to A\*,
  so routing order within a net doesn't matter

### Multi-Pad Topology

The maze router connects each multi-pad net with a Euclidean MST (`buildMstEdges`).
The pathfinder router mutates each multi-pad net into a nearest-neighbour chain
with `nncReorderPads` and reorders the parallel pad-ID groups the same way.

### Via-Pad Clearance

Via placement uses `viaRadius + clearance` as the minimum distance from foreign
pad edges. Own-net source and destination pad groups are exempt through
`skipIds`, and same-net pad checks use `skipNet` where the router tests whether a
via is on a pad.

### Negotiated Congestion

The `CongestionGrid` records both actual track usage and demand from failed
connections. During rip-up, A\* penalizes paths through high-congestion cells
with a weight that increases each pass (`0.3 × pass`). This spreads tracks
across the board and resolves routing-order butterfly effects.

## Tests

Focused unit tests in `tests/unit/test-autorouter-geometry.mjs`,
`tests/unit/test-autorouter-maze.mjs`, and
`tests/unit/test-autorouter-pathfinder.mjs` cover the shared geometry/grid
helpers and tiny router scenarios. The end-to-end fixture regression remains in
`tools/regression.mjs` for whole-board baseline coverage.

## File Structure

```
src/pcb/modules/
├── route-input.js            # Board/editor state → RouteInput
├── autorouter-session.js     # Session ownership, worker lifetime, result adoption
├── autorouter-presentation.js # Progress UI, incremental preview, ratline visibility
├── autorouter-common.js      # Shared infrastructure
│   ├── SpatialHash            # Obstacle spatial index
│   ├── CongestionGrid         # Historical routing demand (maze)
│   ├── PathfinderGrid         # Cell-based path-cost accumulation
│   ├── astarRoute()           # Weighted A* pathfinder
│   ├── astarProbe()           # Crossing-aware A* for rip-up
│   ├── padPointBlocked / padSegmentBlocked   # Pad blocking predicates
│   ├── RouteInput / RouteResult typedefs     # Router contract
│   └── (geometry helpers, path post-processing, node-key packing)
│
├── autorouter-maze.js        # Maze router
│   ├── routeAll()             # Rip-up-and-reroute main entry
│   ├── routeWithMazeRouter()  # Worker-facing wrapper
│   └── defaultChainEdges / buildMstEdges / netManhattan
│
├── autorouter-pathfinder.js  # Negotiated-congestion router
│   ├── routeAllPathfinder()         # Main entry
│   ├── routeWithPathfinderRouter()  # Worker-facing wrapper
│   └── nncReorderPads, extractFeasibleSubset, geometricVerifyAndDrop,
│       smoothPathfinderRoutes, ripUpSwap, unionExtend, …
│
└── autorouter-worker.js      # Web Worker wrapper

src/ui/
└── PCBApp.js                 # UI integration
    ├── _getAutorouter()
    ├── _buildRouteInput()
    └── _renderRouteResult()
```
