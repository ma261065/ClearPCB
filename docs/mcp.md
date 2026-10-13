# ClearPCB MCP Server

ClearPCB includes an experimental remote MCP server for inspecting and editing
the project in an explicitly paired browser tab.

## Tools

The prototype exposes three tools:

- `get_project` returns the complete canonical ClearPCB project.
- `replace_project` validates and loads a complete replacement project.
- `apply_project_patch` atomically applies 1 to 100 RFC 6902 JSON Patch
  operations, validates the resulting project, and loads it.

Writes use the normal project loader, so invalid project data is rejected
before either editor is changed. A write clears the editors' normal undo
history. The MCP dialog retains one pre-write snapshot and offers **Revert last
MCP change** until the session is disabled or another MCP write replaces it.

## Pairing

1. Open ClearPCB and choose **AI Mode** in the ribbon.
2. Select **Enable MCP**.
3. Copy the generated URL into the MCP client.
4. Disable the session when finished.

The browser generates a new random session ID each time MCP is enabled. The
session URL is a temporary capability: anyone who has it can read and modify
the open project while that tab remains enabled. The prototype has no account
login or separate authorization layer. Do not share the URL or enable MCP for
an untrusted client.

The browser connects to `/mcp/relay/<session-id>` by WebSocket. MCP clients use
`/mcp/<session-id>` over Streamable HTTP. A Durable Object keyed by the random
session ID relays typed requests and responses; it does not store project data.
Payloads larger than 192 KiB are chunked, with a 16 MiB limit per request or
response.

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
5. Confirm that
   `https://clearpcb-mcp.mikealex.workers.dev/mcp/not-a-session` returns `404`.
6. Open `https://clearpcb.org`, enable MCP, and confirm that its generated URL
   starts with `https://clearpcb-mcp.mikealex.workers.dev/mcp/`.

The `workers.dev` publication and Durable Object migration are declared in
`mcp-worker/wrangler.jsonc`. No ClearPCB DNS records or nameserver changes are
needed. Deployment is intentionally separate from the stable-site release
workflow while MCP remains experimental.

Before treating this as a production service, add authenticated user sessions,
rate limits, audit logging, and session revocation independent of the browser
connection.
