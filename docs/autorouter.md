# ClearPCB Autorouter

Two connection-oriented routers — a maze router with rip-up-and-reroute
(inspired by [Freerouting](https://github.com/freerouting/freerouting)) and a
negotiated-congestion pathfinder — sharing a common geometry / A* core.

## Architecture

```
┌─────────────┐     postMessage      ┌────────────────────┐
│  PCBApp.js  │◄────────────────────►│ autorouter-worker.js│
│  (main UI)  │  Worker messages     │   (Web Worker)      │
└─────────────┘                      └────────┬───────────┘
                                              │
                              ┌──────────────┴─────────────┐
                              ▼                            ▼
                  ┌───────────────────┐    ┌─────────────────────┐
                  │ autorouter-maze.js │    │ autorouter-pathfinder │
                  │   routeAll()       │    │   routeAllPathfinder()│
                  └────────┬──────────┘    └───────────┬─────────┘
                           │                       │
                           └──────────┬───────────┘
                                      ▼
                            ┌────────────────────┐
                            │ autorouter-common.js │
                            │  ┌─────────────┐ │
                            │  │ SpatialHash  │ │
                            │  │ (obstacles)  │ │
                            │  └─────────────┘ │
                            │  ┌─────────────┐ │
                            │  │ A* Pathfinder│ │
                            │  │ (2-layer)    │ │
                            │  └─────────────┘ │
                            │  ┌─────────────┐ │
                            │  │ Congestion / │ │
                            │  │ Pathfinder   │ │
                            │  │ Grids        │ │
                            │  └─────────────┘ │
                                     └────────────────┘
```

The autorouter runs in a **Web Worker** to keep the UI responsive. The main
thread communicates via `postMessage`:

| Message (worker → UI)  | Purpose                                     |
|------------------------|---------------------------------------------|
| `progress`             | Phase/pass progress for status bar           |
| `netRouted`            | New traces drawn — render incrementally      |
| `netFailed`            | Connection could not be routed               |
| `connRipped`           | Connection removed during rip-up             |
| `netPendingChanged`    | Update ratsnest visibility for a net         |
| `trying`               | Flash yellow line showing current A* attempt |
| `done`                 | Routing complete — final `RouteResult`       |

| Message (UI → worker)  | Purpose                                     |
|------------------------|---------------------------------------------|
| `start`                | Begin routing with `RouteInput`              |
| `cancel`               | Abort routing (checked each A* yield)        |

## Data Structures

### RouteInput

Passed from `PCBApp._buildRouteInput()` to the worker.

| Field             | Type                | Description                         |
|-------------------|---------------------|-------------------------------------|
| `connections`     | `Array<{net, pads}>` | Net name + ordered pad array       |
| `allObstaclePads` | `Array<Pad>`        | All pads (including non-netlist)    |
| `traceWidth`      | `number`            | Trace width in mm (default 0.254)  |
| `clearance`       | `number`            | Min clearance in mm (default 0.2)  |
| `viaDiameter`     | `number`            | Via diameter in mm (default 0.6)   |
| `gridStep`        | `number`            | Grid resolution in mm (default 0.5)|
| `bounds`          | `{minX,minY,maxX,maxY}` | Board bounding box             |

### RouteResult

| Field                  | Type           | Description                          |
|------------------------|----------------|--------------------------------------|
| `traces`               | `Array`        | Routed trace segments                |
| `vias`                 | `Array`        | Via locations `{net, x, y}`          |
| `failed`               | `string[]`     | Unrouted net names                   |
| `failedConnectionCount`| `number`       | Number of unrouted connections       |
| `totalConnectionCount` | `number`       | Total connections in input           |

### SpatialHash

Grid-based spatial index for obstacle queries. Each cell is `gridStep × 4` mm.
Stores two types of obstacles:

- **Pads**: `{cx, cy, hw, hh, net, layer, isPad: true, isVia, connId, id}`
- **Segments**: `{x1, y1, x2, y2, hw, net, layer, connId}`

Key operations:
- `isBlocked(x, y, clearance, skipIds, layer, skipNet)` — point query
- `isSegmentBlocked(...)` — segment query
- `insert(x1, y1, x2, y2, hw, net, layer, connId)` — add trace segment
- `removeConnection(connId)` — surgical removal for rip-up
- `isOnPad(x, y, clearance, skipNet)` — via placement check

The `skipNet` parameter enables **same-net transparency**: traces belonging to
the same net are invisible to A\*, so connections within a multi-pad net don't
block each other.

### CongestionGrid

Tracks how many different nets use each spatial cell. Built from routed traces
plus demand lines from failed connections. Used during rip-up passes to steer
A\* away from congested corridors.

## Routing Algorithm

### Phase 1: Initial Routing

All connections are routed individually (not as whole nets), sorted
**hardest-first** by difficulty score:

```
score = manhattan_distance + local_pad_density × gridStep
```

For multi-pad nets (≥3 pads), pads are reordered using a **nearest-neighbor
chain** starting from the pad farthest from the centroid. This prevents
redundant parallel traces.

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
any foreign pad edge. Own-net pads are exempt.

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
later passes penalize congested areas more aggressively, spreading traces.

For each failed connection:

1. **Probe** — `astarProbe` finds the cheapest path treating traces as
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
`routedTraces` if the routed connection count exceeds the previous best.
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
  the entire net's traces
- **Same-net transparency**: `skipNet` makes same-net traces invisible to A\*,
  so routing order within a net doesn't matter

### Nearest-Neighbor Pad Ordering

Multi-pad nets have pads reordered by a greedy nearest-neighbor chain starting
from the outlier pad. This prevents the common failure mode of two long
parallel traces to a distant pad instead of one long trace + short hops.

### Via-Pad Clearance

Via placement uses `viaRadius + clearance` as the minimum distance from foreign
pad edges. This is tighter than the conservative `totalClear × 2` originally
used, enabling via placement near closely-spaced SMD pads (e.g., 0.8mm pitch
IC pins).

### Negotiated Congestion

The `CongestionGrid` records both actual trace usage and demand from failed
connections. During rip-up, A\* penalizes paths through high-congestion cells
with a weight that increases each pass (`0.3 × pass`). This spreads traces
across the board and resolves routing-order butterfly effects.

## File Structure

```
src/pcb/modules/
├── autorouter-common.js      # Shared infrastructure (~1700 lines)
│   ├── SpatialHash            # Obstacle spatial index
│   ├── CongestionGrid         # Historical routing demand (maze)
│   ├── PathfinderGrid         # Cell-based path-cost accumulation
│   ├── astarRoute()           # Weighted A* pathfinder
│   ├── astarProbe()           # Crossing-aware A* for rip-up
│   ├── padPointBlocked / padSegmentBlocked   # Pad blocking predicates
│   ├── RouteInput / RouteResult typedefs     # Router contract
│   └── (geometry helpers, path post-processing, node-key packing)
│
├── autorouter-maze.js        # Maze router (~1300 lines)
│   ├── routeAll()             # Rip-up-and-reroute main entry
│   ├── routeWithMazeRouter()  # Worker-facing wrapper
│   └── defaultChainEdges / buildMstEdges / netManhattan
│
├── autorouter-pathfinder.js  # Negotiated-congestion router (~1800 lines)
│   ├── routeAllPathfinder()         # Main entry
│   ├── routeWithPathfinderRouter()  # Worker-facing wrapper
│   └── nncReorderPads, extractFeasibleSubset, geometricVerifyAndDrop,
│       smoothPathfinderRoutes, ripUpSwap, unionExtend, …
│
└── autorouter-worker.js      # Web Worker wrapper (~50 lines)

src/ui/
└── PCBApp.js                 # UI integration
    ├── _buildRouteInput()
    ├── _runAutoRouteInWorker()
    ├── _renderNetTraces()
    └── _clearIncrementalConnection()
```
