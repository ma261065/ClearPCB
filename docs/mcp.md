# ClearPCB MCP Server

ClearPCB includes an experimental remote MCP server for inspecting and editing
the project in an explicitly paired browser tab.

## Tools

The prototype exposes ten tools:

- `pair` requests browser approval using the short code shown in ClearPCB.
- `pairing_status` reports whether the connector still has access to a live
  tab.
- `describe_schema` returns canonical shape fields, graph conventions and
  worked component, wire, placement and track examples.
- `list_parts` returns valid built-in component `dn` values and summaries.
- `search_parts` searches the built-in, KiCad and LCSC catalogs and returns
  compact source-qualified IDs. Remote searches require at least two
  characters.
- `get_part` fetches exact symbol pin geometry, footprint records and metadata
  for a built-in, KiCad or LCSC part. Built-in definitions are referenced
  directly by `dn` and must not be copied into `schematic.defs`.
- `place_part` fetches and places one source-qualified part at schematic
  coordinates. ClearPCB generates a reference when one is omitted and embeds
  external definitions automatically.
- `get_project` returns the complete canonical ClearPCB project.
- `replace_project` validates and loads a complete replacement project.
- `apply_project_patch` atomically applies 1 to 100 RFC 6902 JSON Patch
  operations, validates the resulting project, and loads it.

Writes use the normal project loader, so invalid project data is rejected
before either editor is changed. Successful writes return a short operation
summary rather than echoing the whole project. A write clears the editors'
normal undo history. The MCP dialog retains one pre-write snapshot and offers
**Revert last MCP change** until the session is disabled or another MCP write
replaces it.

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

Pairing codes expire after five minutes, can be used once and are limited to
ten attempts per MCP protocol session. A code only identifies a waiting tab:
it does not grant project access until the browser user approves the named
client. An unclaimed code is replaced automatically when it expires. One client
may be paired with a tab at a time. Denial, disconnect, disabling MCP or
closing the tab revokes access.

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
