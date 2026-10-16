# ClearPCB MCP Server

ClearPCB includes an experimental remote MCP server for inspecting and editing
the project in an explicitly paired browser tab.

## Tools

The prototype exposes fifteen tools:

- `pair` requests browser approval using the short code shown in ClearPCB.
- `pairing_status` reports whether the connector still has access to a live
  tab.
- `describe_schema` returns canonical shape fields, graph conventions and
  worked component, wire, placement and track examples. For PCB text it
  explains the baseline-left `x,y` origin, cap-height size, supported layers,
  layer aliases, and compact names returned by `get_project`.
- `list_parts` returns valid built-in component `dn` values and summaries.
- `search_parts` searches the built-in, KiCad and LCSC catalogs and returns
  compact source-qualified IDs. Remote searches require at least two
  characters.
- `get_part` fetches exact symbol pin geometry, footprint records and metadata
  for a built-in, KiCad or LCSC part. Built-in definitions are referenced
  directly by `dn` and must not be copied into `schematic.defs`.
  Built-in names are unique. The built-in `OpAmp` is an LM741 with pins 1-8;
  projects saved with its former `+`, `-` and `OUT` aliases migrate those
  schematic and PCB bonds to pins 3, 2 and 6 when loaded.
- `place_part` fetches and places one source-qualified part at schematic
  coordinates. ClearPCB generates a reference when one is omitted and embeds
  external definitions automatically.
- `get_project` returns the complete canonical ClearPCB project.
- `get_connection_points` returns absolute schematic pin and PCB pad positions
  derived from the live project. These computed positions are deliberately not
  added to `get_project`, so its result remains valid round-trippable project
  JSON.
- `get_netlist` returns the derived electrical nets and their component pins.
- `connect` creates a bonded schematic wire between two `Reference.Pin`
  endpoints, such as `U1.3` and `R3.1`. ClearPCB resolves transformed pin
  positions and generates the wire ID and label.
- `run_drc` runs the PCB design rule check against the live board and returns
  counts by rule plus up to `limit` (default 100, maximum 500) violations,
  each with its rule, severity, message, board position in millimetres and
  net when known. Copper pours and the ratsnest are recomputed first, so the
  result does not depend on the PCB editor being visible; `upToDate: false`
  lists anything that could not be settled.
- `render` returns a PNG image of the `schematic` or `pcb` view (longest side
  `maxSize`, default 1600, range 256-4096) followed by a text block giving the
  drawn `bounds`. The schematic is drawn in black on white without grid or
  sheet. The PCB is drawn in layer colours on black with every populated
  artwork layer; its bounds are in millimetres.
- `replace_project` validates and loads a complete replacement project.
- `apply_project_patch` atomically applies 1 to 100 RFC 6902 JSON Patch
  operations, validates the resulting project, and loads it. The `patch`
  argument accepts either the operation array or a JSON string containing that
  array, for clients that encode large tool arguments as strings.

Writes use the normal project loader, so invalid project data is rejected
before either editor is changed. A `pc` or `pdc` connection must name an
existing component pin or pad, and its graph node must be at that physical
connection point. Removing a schematic component also removes its saved PCB
placement. Successful writes return a short operation summary rather than
echoing the whole project. A write clears the editors'
normal undo history. The MCP dialog retains one pre-write snapshot and offers
**Revert last MCP change** until the session is disabled or another MCP write
replaces it.

Component `ref` and `val` data are displayed through linked schematic text
shapes. When an imported project omits those generated shapes, ClearPCB
recreates them from the component fields on load. Explicit `sr: false` or
`sv: false` flags continue to hide the corresponding field.

`get_project` intentionally contains authored, round-trippable data only. Use
`get_connection_points` for absolute pin and pad positions, and `get_netlist`
for resolved electrical connectivity.

PCB text uses `x,y` for the left edge of its first glyph on the text baseline
(positive board Y points down); it is not centred on that point. `size` is the
font cap height. Text layers use IDs such as `top-silk` and `bottom-silk`;
`top-silkscreen` and `bottom-silkscreen` are accepted aliases. `apply_project_patch`
accepts descriptive or compact field names, while `get_project` returns PCB
text fields compacted (`content` → `t`, `size` → `s`, `layer` → `l`,
`strokeWidth` → `lw`).

### Component sources

Use `search_parts` before retrieving or placing an online component:

```json
{ "query": "NE555", "source": "all", "limit": 20 }
```

Results identify their source and carry an ID suitable for `get_part` and
`place_part`. Built-in IDs are definition names such as `Resistor`, KiCad IDs
use `Library:Symbol` form such as `Timer:NE555D`, and LCSC IDs are supplier part
numbers such as `C46749`.

```json
{
  "source": "kicad",
  "id": "Timer:NE555D",
  "x": 70,
  "y": 40,
  "ref": "U1",
  "value": "NE555D",
  "rotation": 0
}
```

KiCad and LCSC retrieval runs in the paired browser tab and reuses the same
fetchers, caches, parsers and footprint conversion as the component picker.
It therefore has the same network and upstream-service requirements as an
interactive online component search. `get_part` omits raw 3D mesh text from
its response; `place_part` still embeds available model data through the normal
project serializer.

## Pairing

1. Open ClearPCB and choose **AI Mode** in the ribbon.
2. Select **Enable MCP**.
3. Add `https://clearpcb-mcp.mikealex.workers.dev/mcp` to the MCP client once.
4. Copy the eight-character code shown in ClearPCB, give it to the client and
   ask it to call `pair`.
5. Check the client name in ClearPCB and select **Allow** or **Deny**.
6. Use **Disconnect** or **Disable MCP** when finished.

The AI Mode dialog remains open while paired, but the **Schematic** and
**PCB Layout** tabs stay clickable so the browser user can inspect both editors
as MCP changes arrive. All other controls behind the dialog remain blocked.

Pairing codes expire after five minutes, can be used once and are limited to
ten attempts per MCP protocol session. A code only identifies a waiting tab:
it does not grant project access until the browser user approves the named
client. An unclaimed code is replaced automatically when it expires. One client
may be paired with a tab at a time. Denial, disconnect, disabling MCP or
closing the tab revokes access.

Before returning `ALREADY_PAIRED`, the Worker verifies that the saved relay
still has the same approved client session and a connected browser tab. A stale
binding left by a tab restart or lost connection is discarded automatically,
and the new `pair` request continues with the supplied code.

The browser connects to `/mcp/relay/<random-relay-id>` by WebSocket. MCP clients
always use the stable `/mcp` Streamable HTTP URL. A client-session Durable
Object owns the protocol `Mcp-Session-Id`; a pairing-broker Durable Object maps
short-lived codes to waiting relay IDs; and the existing tab-relay Durable
Object transports approved calls. None stores project data. Payloads larger
than 192 KiB are chunked, with a 16 MiB limit per request or response.

The sessionful transport is the Agents SDK compatibility transport because the
current stateless handler intentionally has no protocol session to which a
one-time approval can be bound. Project and pairing state remain separate from
the transport and can move to OAuth without changing the browser protocol.

MCP clients commonly cache the advertised tool list for the lifetime of a
connector or chat session. Deploying a Worker with new tools does not update
that existing list; reconnect the MCP connector or start a new chat after
deployment.

## Local Development

The editor remains a static site. Run it normally, then run the Worker:

```powershell
Set-Location mcp-worker
npm install
npm run dev
```

For an editor served from `http://localhost:8000`, point MCP pairing at the
local Worker before loading the editor:

```javascript
localStorage.setItem('clearpcb_mcp_endpoint', 'http://localhost:8787');
location.reload();
```

Remove the override to return to the production Worker endpoint:

```javascript
localStorage.removeItem('clearpcb_mcp_endpoint');
location.reload();
```

Run the browser-side protocol checks with:

```powershell
node tests\unit\test-json-patch.mjs
node tests\unit\test-mcp-bridge.mjs
```

Run `npm run check` in `mcp-worker` to type-check the Worker.

## Cloudflare Deployment

The existing site remains hosted by GitHub Pages. GitHub Pages cannot execute
MCP POST requests or accept WebSockets, so the browser connects directly to
`https://clearpcb-mcp.mikealex.workers.dev`. The Worker accepts production
browser relay connections only from `https://clearpcb.org`; moving the MCP
endpoint does not expose the relay to arbitrary websites.

One-time setup:

1. Confirm that the Cloudflare account's `workers.dev` subdomain is `mikealex`.
2. Create a Cloudflare API token that can deploy Workers and Durable Objects.
   No `clearpcb.org` zone or DNS permission is required.
3. Add repository secrets `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID`.
4. Run the **Deploy MCP Worker** GitHub Actions workflow.
5. Confirm that `https://clearpcb-mcp.mikealex.workers.dev/mcp` responds to an
   MCP client and ordinary browser GET requests do not expose project data.
6. Open `https://clearpcb.org`, enable MCP, and confirm that it displays a
   pairing code while the connector URL remains
   `https://clearpcb-mcp.mikealex.workers.dev/mcp`.

The `workers.dev` publication and Durable Object migration are declared in
`mcp-worker/wrangler.jsonc`. No ClearPCB DNS records or nameserver changes are
needed. Deployment is intentionally separate from the stable-site release
workflow while MCP remains experimental.

Before treating this as a production service, add authenticated user sessions,
rate limits, audit logging, and session revocation independent of the browser
connection.
