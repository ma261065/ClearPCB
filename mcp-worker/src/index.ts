import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WorkerTransport, type MCPStorageApi } from 'agents/mcp';
import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';

interface Env {
    TAB_RELAY: DurableObjectNamespace<TabRelay>;
    PAIRING_BROKER: DurableObjectNamespace<PairingBroker>;
    CLIENT_SESSION: DurableObjectNamespace<ClientSession>;
}

interface RelayRequest {
    id: string;
    method: 'request_pairing' | 'describe_schema' | 'list_parts' | 'get_part'
        | 'get_project' | 'replace_project' | 'apply_project_patch';
    params?: unknown;
}

interface RelayResponse {
    id: string;
    result?: unknown;
    error?: string;
}

interface PairingRecord {
    relayId: string;
    expiresAt: number;
}

interface ClientIdentity {
    id: string;
    name: string;
    version?: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{8}$/;
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const WORKER_HOSTNAME = 'clearpcb-mcp.mikealex.workers.dev';
const PAIRING_TTL_MS = 5 * 60_000;
const MAX_PAIRING_ATTEMPTS = 10;
const CHUNK_SIZE = 192 * 1024;
const MAX_RELAY_MESSAGE = 16 * 1024 * 1024;
const JSON_VALUE = z.unknown();
const PATCH_OPERATION = z.object({
    op: z.enum(['add', 'remove', 'replace', 'move', 'copy', 'test']),
    path: z.string(),
    from: z.string().optional(),
    value: JSON_VALUE.optional(),
}).strict();

function relayStub(env: Env, relayId: string): DurableObjectStub<TabRelay> {
    return env.TAB_RELAY.get(env.TAB_RELAY.idFromName(relayId));
}

function brokerStub(env: Env): DurableObjectStub<PairingBroker> {
    return env.PAIRING_BROKER.get(env.PAIRING_BROKER.idFromName('global'));
}

function normalizeCode(value: string): string {
    return value.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

function toolResult(result: unknown) {
    return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
}

function toolError(code: string, message: string) {
    return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: { code, message } }) }],
        isError: true as const,
    };
}

async function responsePayload(response: Response): Promise<RelayResponse> {
    return response.headers.get('content-type')?.includes('application/json')
        ? response.json<RelayResponse>()
        : { id: '', error: await response.text() };
}

async function invokeTab(
    env: Env,
    relayId: string,
    clientSessionId: string,
    request: Omit<RelayRequest, 'id'>,
): Promise<unknown> {
    const response = await relayStub(env, relayId).fetch('https://relay.internal/invoke', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-clearpcb-client-session': clientSessionId,
        },
        body: JSON.stringify(request),
    });
    const payload = await responsePayload(response);
    if (!response.ok || payload.error) throw new Error(payload.error || `Relay failed with HTTP ${response.status}.`);
    return payload.result;
}

function allowedRelayOrigin(request: Request): boolean {
    const origin = request.headers.get('origin');
    if (origin === 'https://clearpcb.org') return true;
    if (!origin) return false;
    try {
        return ['localhost', '127.0.0.1'].includes(new URL(origin).hostname);
    } catch {
        return false;
    }
}

function allowedMcpHost(request: Request): boolean {
    try {
        return [WORKER_HOSTNAME, 'clearpcb.org', 'localhost', '127.0.0.1'].includes(new URL(request.url).hostname);
    } catch {
        return false;
    }
}

function browserCors(response: Response, request: Request): Response {
    const headers = new Headers(response.headers);
    const origin = request.headers.get('origin');
    if (origin) headers.set('access-control-allow-origin', origin);
    headers.set('vary', 'Origin');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export class PairingBroker extends DurableObject<Env> {
    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname === '/register' && request.method === 'POST') return this.register(request);
        if (url.pathname === '/claim' && request.method === 'POST') return this.claim(request);
        if (url.pathname === '/revoke' && request.method === 'POST') return this.revoke(request);
        return new Response('Not found.', { status: 404 });
    }

    private async register(request: Request): Promise<Response> {
        const { relayId } = await request.json<{ relayId?: string }>();
        if (!relayId || !UUID_PATTERN.test(relayId)) {
            return Response.json({ error: 'Invalid relay ID.' }, { status: 400 });
        }
        await this.deleteRelayCodes(relayId);
        let code = '';
        for (let attempt = 0; attempt < 5; attempt++) {
            code = this.makeCode();
            if (!await this.ctx.storage.get(`code:${code}`)) break;
            code = '';
        }
        if (!code) return Response.json({ error: 'Unable to allocate a pairing code.' }, { status: 503 });
        const expiresAt = Date.now() + PAIRING_TTL_MS;
        await this.ctx.storage.put(`code:${code}`, { relayId, expiresAt } satisfies PairingRecord);
        return Response.json({ code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt });
    }

    private async claim(request: Request): Promise<Response> {
        const { code } = await request.json<{ code?: string }>();
        const normalized = normalizeCode(code || '');
        if (!CODE_PATTERN.test(normalized)) {
            return Response.json({ error: 'Invalid or expired pairing code.' }, { status: 404 });
        }
        const record = await this.ctx.storage.get<PairingRecord>(`code:${normalized}`);
        if (!record || record.expiresAt <= Date.now()) {
            if (record) await this.ctx.storage.delete(`code:${normalized}`);
            return Response.json({ error: 'Invalid or expired pairing code.' }, { status: 404 });
        }
        await this.ctx.storage.delete(`code:${normalized}`);
        return Response.json(record);
    }

    private async revoke(request: Request): Promise<Response> {
        const { relayId } = await request.json<{ relayId?: string }>();
        if (relayId) await this.deleteRelayCodes(relayId);
        return Response.json({ ok: true });
    }

    private async deleteRelayCodes(relayId: string): Promise<void> {
        const records = await this.ctx.storage.list<PairingRecord>({ prefix: 'code:' });
        const keys = [...records].filter(([, record]) =>
            record.relayId === relayId || record.expiresAt <= Date.now()).map(([key]) => key);
        if (keys.length) await this.ctx.storage.delete(keys);
    }

    private makeCode(): string {
        const bytes = crypto.getRandomValues(new Uint8Array(8));
        return [...bytes].map(value => CODE_ALPHABET[value & 31]).join('');
    }
}

export class ClientSession extends DurableObject<Env> {
    async fetch(request: Request): Promise<Response> {
        const sessionId = request.headers.get('x-clearpcb-session-id')
            || request.headers.get('mcp-session-id');
        if (!sessionId || !UUID_PATTERN.test(sessionId)) {
            return Response.json({ error: 'Invalid MCP session ID.' }, { status: 400 });
        }
        await this.captureClientIdentity(request);
        const storage: MCPStorageApi = {
            get: () => this.ctx.storage.get('transport'),
            set: state => this.ctx.storage.put('transport', state),
        };
        const server = this.createServer(sessionId);
        const transport = new WorkerTransport({
            storage,
            sessionIdGenerator: () => sessionId,
            enableJsonResponse: true,
        });
        await server.connect(transport);
        return transport.handleRequest(request);
    }

    private createServer(sessionId: string): McpServer {
        const server = new McpServer({ name: 'ClearPCB', version: '0.2.0' });
        server.registerTool('pair', {
            title: 'Pair with a ClearPCB tab',
            description: 'Request access using the short code shown in ClearPCB. The browser user must explicitly approve the request.',
            inputSchema: { code: z.string().min(8).max(12) },
        }, async ({ code }) => this.pair(sessionId, code));
        server.registerTool('pairing_status', {
            title: 'Get ClearPCB pairing status',
            description: 'Report whether this MCP connector is approved for a live ClearPCB tab.',
            inputSchema: {},
            annotations: { readOnlyHint: true },
        }, async () => toolResult(await this.pairingStatus(sessionId)));
        server.registerTool('describe_schema', {
            title: 'Describe the ClearPCB project schema',
            description: 'Return the canonical shape fields, graph conventions and worked component, wire, placement and track examples.',
            inputSchema: {},
            annotations: { readOnlyHint: true },
        }, async () => this.pairedTool(sessionId, 'describe_schema'));
        server.registerTool('list_parts', {
            title: 'List ClearPCB built-in parts',
            description: 'List valid built-in component dn values with descriptions, default values, pin counts and footprints.',
            inputSchema: {},
            annotations: { readOnlyHint: true },
        }, async () => this.pairedTool(sessionId, 'list_parts'));
        server.registerTool('get_part', {
            title: 'Get a ClearPCB built-in part',
            description: 'Return exact symbol pin geometry and footprint shapes for one built-in dn.',
            inputSchema: { dn: z.string().min(1) },
            annotations: { readOnlyHint: true },
        }, async ({ dn }) => this.pairedTool(sessionId, 'get_part', { dn }));
        server.registerTool('get_project', {
            title: 'Get ClearPCB project',
            description: 'Return the complete canonical project currently open in the paired ClearPCB tab.',
            inputSchema: {},
            annotations: { readOnlyHint: true },
        }, async () => this.pairedTool(sessionId, 'get_project'));
        server.registerTool('replace_project', {
            title: 'Replace ClearPCB project',
            description: 'Validate and replace the complete canonical project. Returns a short operation summary.',
            inputSchema: { project: z.record(z.string(), JSON_VALUE) },
            annotations: { destructiveHint: true, idempotentHint: false },
        }, async ({ project }) => this.pairedTool(sessionId, 'replace_project', { project }));
        server.registerTool('apply_project_patch', {
            title: 'Patch ClearPCB project',
            description: 'Atomically apply 1 to 100 RFC 6902 operations and return a short operation summary.',
            inputSchema: { patch: z.array(PATCH_OPERATION).min(1).max(100) },
            annotations: { destructiveHint: true, idempotentHint: false },
        }, async ({ patch }) => this.pairedTool(sessionId, 'apply_project_patch', { patch }));
        return server;
    }

    private async pair(sessionId: string, code: string) {
        if (await this.ctx.storage.get<string>('relayId')) {
            return toolError('ALREADY_PAIRED', 'This MCP session is already paired.');
        }
        const attempts = await this.ctx.storage.get<number>('pairAttempts') || 0;
        if (attempts >= MAX_PAIRING_ATTEMPTS) {
            return toolError('PAIRING_ATTEMPTS_EXCEEDED', 'Too many pairing attempts. Reconnect the MCP client.');
        }
        await this.ctx.storage.put('pairAttempts', attempts + 1);
        const claim = await brokerStub(this.env).fetch('https://broker.internal/claim', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ code }),
        });
        if (!claim.ok) return toolError('INVALID_PAIRING_CODE', 'The pairing code is invalid or expired.');
        const { relayId } = await claim.json<PairingRecord>();
        const client = await this.clientIdentity(sessionId);
        const approval = await relayStub(this.env, relayId).fetch('https://relay.internal/pair', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, client }),
        });
        const payload = await responsePayload(approval);
        if (!approval.ok || payload.error) {
            return toolError('PAIRING_FAILED', payload.error || 'The ClearPCB tab could not approve this request.');
        }
        if (!(payload.result as { approved?: boolean } | undefined)?.approved) {
            return toolError('PAIRING_DENIED', 'The ClearPCB user denied access.');
        }
        await this.ctx.storage.put('relayId', relayId);
        return toolResult({ paired: true, client: client.name });
    }

    private async pairingStatus(sessionId: string): Promise<unknown> {
        const relayId = await this.ctx.storage.get<string>('relayId');
        if (!relayId) return { paired: false, code: 'PAIRING_REQUIRED' };
        const response = await relayStub(this.env, relayId).fetch('https://relay.internal/status', {
            headers: { 'x-clearpcb-client-session': sessionId },
        });
        if (!response.ok) {
            await this.ctx.storage.delete('relayId');
            return { paired: false, code: 'PAIRING_REVOKED' };
        }
        return { paired: true };
    }

    private async pairedTool(
        sessionId: string,
        method: Omit<RelayRequest, 'id'>['method'],
        params?: Record<string, unknown>,
    ) {
        const relayId = await this.ctx.storage.get<string>('relayId');
        if (!relayId) return toolError('PAIRING_REQUIRED', 'Call pair with the code shown in ClearPCB first.');
        try {
            return toolResult(await invokeTab(this.env, relayId, sessionId, { method, params }));
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (/revoked|not connected|disconnected/i.test(message)) await this.ctx.storage.delete('relayId');
            return toolError('TAB_UNAVAILABLE', message);
        }
    }

    private async captureClientIdentity(request: Request): Promise<void> {
        if (request.method !== 'POST') return;
        try {
            const body = await request.clone().json<{
                method?: string;
                params?: { clientInfo?: { name?: string; version?: string } };
            }>();
            if (body.method !== 'initialize' || !body.params?.clientInfo?.name) return;
            await this.ctx.storage.put('client', {
                name: body.params.clientInfo.name,
                version: body.params.clientInfo.version,
            });
        } catch {
            // The transport returns the protocol-level parse error.
        }
    }

    private async clientIdentity(sessionId: string): Promise<ClientIdentity> {
        const stored = await this.ctx.storage.get<{ name?: string; version?: string }>('client');
        return {
            id: sessionId,
            name: stored?.name || 'Unknown MCP client',
            version: stored?.version,
        };
    }
}

export class TabRelay extends DurableObject<Env> {
    private pending = new Map<string, {
        resolve: (response: RelayResponse) => void;
        timer: ReturnType<typeof setTimeout>;
    }>();
    private incomingChunks = new Map<string, { chunks: Array<string | undefined>; bytes: number }>();

    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname === '/connect') {
            if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
                return new Response('WebSocket upgrade required.', { status: 426 });
            }
            const pair = new WebSocketPair();
            const [client, server] = Object.values(pair);
            this.ctx.acceptWebSocket(server);
            return new Response(null, { status: 101, webSocket: client });
        }
        if (url.pathname === '/status') {
            const expected = await this.ctx.storage.get<string>('pairedSessionId');
            const actual = request.headers.get('x-clearpcb-client-session');
            return expected && actual === expected && this.ctx.getWebSockets().length === 1
                ? Response.json({ paired: true })
                : Response.json({ error: 'Pairing revoked or ClearPCB tab disconnected.' }, { status: 409 });
        }
        if (url.pathname === '/pair' && request.method === 'POST') return this.requestPairing(request);
        if (url.pathname === '/invoke' && request.method === 'POST') return this.invoke(request);
        return new Response('Not found.', { status: 404 });
    }

    private async requestPairing(request: Request): Promise<Response> {
        const { sessionId, client } = await request.json<{ sessionId?: string; client?: ClientIdentity }>();
        if (!sessionId || !UUID_PATTERN.test(sessionId) || !client?.name) {
            return Response.json({ error: 'Invalid pairing request.' }, { status: 400 });
        }
        if (await this.ctx.storage.get('pairedSessionId')) {
            return Response.json({ error: 'This ClearPCB tab already has a paired client.' }, { status: 409 });
        }
        const result = await this.sendRequest({
            method: 'request_pairing',
            params: { client },
        }, 60_000);
        if (!result.error && (result.result as { approved?: boolean } | undefined)?.approved) {
            await this.ctx.storage.put('pairedSessionId', sessionId);
        }
        return Response.json(result, { status: result.error ? 502 : 200 });
    }

    private async invoke(request: Request): Promise<Response> {
        const expected = await this.ctx.storage.get<string>('pairedSessionId');
        const actual = request.headers.get('x-clearpcb-client-session');
        if (!expected || actual !== expected) {
            return Response.json({ error: 'Pairing revoked or not approved for this client.' }, { status: 403 });
        }
        const input = await request.json<Omit<RelayRequest, 'id'>>();
        const result = await this.sendRequest(input, 15_000);
        return Response.json(result, { status: result.error ? 502 : 200 });
    }

    private async sendRequest(input: Omit<RelayRequest, 'id'>, timeout: number): Promise<RelayResponse> {
        const sockets = this.ctx.getWebSockets();
        if (sockets.length !== 1) {
            return {
                id: '',
                error: sockets.length ? 'Multiple ClearPCB tabs use this relay.' : 'No ClearPCB tab is connected.',
            };
        }
        const id = crypto.randomUUID();
        const message: RelayRequest = { id, ...input };
        return new Promise(resolve => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                resolve({ id, error: 'ClearPCB tab did not respond in time.' });
            }, timeout);
            this.pending.set(id, { resolve, timer });
            this.sendChunked(sockets[0], id, message);
        });
    }

    async webSocketMessage(_socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
        if (typeof message !== 'string') return;
        let frame: RelayResponse & {
            transport?: string;
            action?: string;
            transferId?: string;
            index?: number;
            total?: number;
            data?: string;
        };
        try {
            frame = JSON.parse(message) as typeof frame;
        } catch {
            return;
        }
        if (frame.transport === 'control' && frame.action === 'disconnect') {
            await this.ctx.storage.delete('pairedSessionId');
            return;
        }
        if (frame.transport === 'chunk') {
            const { transferId, index, total, data } = frame;
            if (typeof transferId !== 'string' || !Number.isInteger(index) || !Number.isInteger(total)
                || total! < 1 || total! > 128 || index! < 0 || index! >= total! || typeof data !== 'string') return;
            let transfer = this.incomingChunks.get(transferId);
            if (!transfer) {
                transfer = { chunks: new Array(total), bytes: 0 };
                this.incomingChunks.set(transferId, transfer);
            }
            if (transfer.chunks.length !== total || transfer.chunks[index!] !== undefined) return;
            transfer.bytes += data.length;
            if (transfer.bytes > MAX_RELAY_MESSAGE) {
                this.incomingChunks.delete(transferId);
                this.resolvePending({ id: transferId, error: 'ClearPCB response exceeds the 16 MiB relay limit.' });
                return;
            }
            transfer.chunks[index!] = data;
            if (transfer.chunks.some(chunk => chunk === undefined)) return;
            this.incomingChunks.delete(transferId);
            try {
                this.resolvePending(JSON.parse(transfer.chunks.join('')) as RelayResponse);
            } catch {
                this.resolvePending({ id: transferId, error: 'ClearPCB returned invalid chunked JSON.' });
            }
            return;
        }
        this.resolvePending(frame);
    }

    private resolvePending(response: RelayResponse): void {
        const pending = typeof response.id === 'string' ? this.pending.get(response.id) : null;
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(response.id);
        pending.resolve(response);
    }

    async webSocketClose(): Promise<void> {
        for (const [id, pending] of this.pending) {
            clearTimeout(pending.timer);
            pending.resolve({ id, error: 'ClearPCB tab disconnected.' });
        }
        this.pending.clear();
        this.incomingChunks.clear();
        await this.ctx.storage.delete('pairedSessionId');
    }

    private sendChunked(socket: WebSocket, id: string, value: unknown): void {
        const serialized = JSON.stringify(value);
        if (serialized.length > MAX_RELAY_MESSAGE) {
            this.resolvePending({ id, error: 'MCP request exceeds the 16 MiB relay limit.' });
            return;
        }
        if (serialized.length <= CHUNK_SIZE) {
            socket.send(serialized);
            return;
        }
        const total = Math.ceil(serialized.length / CHUNK_SIZE);
        for (let index = 0; index < total; index++) {
            socket.send(JSON.stringify({
                transport: 'chunk',
                transferId: id,
                index,
                total,
                data: serialized.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE),
            }));
        }
    }
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname.startsWith('/mcp/pairing/')) {
            if (!allowedRelayOrigin(request)) return new Response('Forbidden.', { status: 403 });
            if (request.method === 'OPTIONS') {
                return browserCors(new Response(null, {
                    status: 204,
                    headers: {
                        'access-control-allow-methods': 'POST, OPTIONS',
                        'access-control-allow-headers': 'content-type',
                    },
                }), request);
            }
            const action = url.pathname.slice('/mcp/pairing/'.length);
            const response = await brokerStub(env).fetch(new Request(`https://broker.internal/${action}`, request));
            return browserCors(response, request);
        }
        const relayPrefix = '/mcp/relay/';
        if (url.pathname.startsWith(relayPrefix)) {
            if (!allowedRelayOrigin(request)) return new Response('Forbidden.', { status: 403 });
            const relayId = url.pathname.slice(relayPrefix.length);
            if (!UUID_PATTERN.test(relayId)) return new Response('Not found.', { status: 404 });
            return relayStub(env, relayId).fetch(new Request('https://relay.internal/connect', request));
        }
        if (url.pathname !== '/mcp') return new Response('Not found.', { status: 404 });
        if (!allowedMcpHost(request)) return new Response('Forbidden.', { status: 403 });
        const supplied = request.headers.get('mcp-session-id');
        const sessionId = supplied || crypto.randomUUID();
        if (!UUID_PATTERN.test(sessionId)) return Response.json({ error: 'Invalid MCP session ID.' }, { status: 400 });
        const headers = new Headers(request.headers);
        headers.set('x-clearpcb-session-id', sessionId);
        return env.CLIENT_SESSION.get(env.CLIENT_SESSION.idFromName(sessionId))
            .fetch(new Request(request, { headers }));
    },
} satisfies ExportedHandler<Env>;
