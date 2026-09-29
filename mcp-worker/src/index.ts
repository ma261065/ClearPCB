import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';

interface Env {
    TAB_RELAY: DurableObjectNamespace<TabRelay>;
}

interface RelayRequest {
    id: string;
    method: 'get_project' | 'replace_project' | 'apply_project_patch';
    params?: unknown;
}

interface RelayResponse {
    id: string;
    result?: unknown;
    error?: string;
}

const SESSION_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHUNK_SIZE = 192 * 1024;
const MAX_RELAY_MESSAGE = 16 * 1024 * 1024;
const JSON_VALUE = z.unknown();
const PATCH_OPERATION = z.object({
    op: z.enum(['add', 'remove', 'replace', 'move', 'copy', 'test']),
    path: z.string(),
    from: z.string().optional(),
    value: JSON_VALUE.optional(),
}).strict();

function sessionPath(pathname: string, relay = false): string | null {
    const prefix = relay ? '/mcp/relay/' : '/mcp/';
    if (!pathname.startsWith(prefix)) return null;
    const value = pathname.slice(prefix.length);
    return SESSION_PATTERN.test(value) ? value : null;
}

function relayStub(env: Env, sessionId: string): DurableObjectStub<TabRelay> {
    return env.TAB_RELAY.get(env.TAB_RELAY.idFromName(sessionId));
}

async function invokeTab(env: Env, sessionId: string, request: Omit<RelayRequest, 'id'>): Promise<unknown> {
    const response = await relayStub(env, sessionId).fetch('https://relay.internal/invoke', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
    });
    const payload = response.headers.get('content-type')?.includes('application/json')
        ? await response.json<RelayResponse>()
        : { id: '', error: await response.text() };
    if (!response.ok || payload.error) throw new Error(payload.error || `Relay failed with HTTP ${response.status}.`);
    return payload.result;
}

function toolResult(result: unknown) {
    return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
}

function createServer(env: Env, sessionId: string) {
    const server = new McpServer({ name: 'ClearPCB', version: '0.1.0' });
    server.registerTool('get_project', {
        title: 'Get ClearPCB project',
        description: 'Return the complete canonical project currently open in the paired ClearPCB tab.',
        inputSchema: {},
        annotations: { readOnlyHint: true },
    }, async () => toolResult(await invokeTab(env, sessionId, { method: 'get_project' })));
    server.registerTool('replace_project', {
        title: 'Replace ClearPCB project',
        description: 'Validate and replace the complete project in the paired ClearPCB tab.',
        inputSchema: { project: z.record(z.string(), JSON_VALUE) },
        annotations: { destructiveHint: true, idempotentHint: false },
    }, async ({ project }) => toolResult(await invokeTab(env, sessionId, {
        method: 'replace_project', params: { project },
    })));
    server.registerTool('apply_project_patch', {
        title: 'Patch ClearPCB project',
        description: 'Atomically apply RFC 6902 JSON Patch operations, validate the result, and load it in the paired tab.',
        inputSchema: { patch: z.array(PATCH_OPERATION).min(1).max(100) },
        annotations: { destructiveHint: true, idempotentHint: false },
    }, async ({ patch }) => toolResult(await invokeTab(env, sessionId, {
        method: 'apply_project_patch', params: { patch },
    })));
    return server;
}

function allowedRelayOrigin(request: Request): boolean {
    const origin = request.headers.get('origin');
    if (origin === 'https://clearpcb.org') return true;
    if (!origin) return false;
    try {
        const url = new URL(origin);
        return ['localhost', '127.0.0.1'].includes(url.hostname);
    } catch {
        return false;
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
        if (url.pathname !== '/invoke' || request.method !== 'POST') {
            return new Response('Not found.', { status: 404 });
        }
        const sockets = this.ctx.getWebSockets();
        if (sockets.length !== 1) {
            return Response.json({ error: sockets.length ? 'Multiple ClearPCB tabs use this session.' : 'No ClearPCB tab is connected.' },
                { status: 409 });
        }
        const input = await request.json<Omit<RelayRequest, 'id'>>();
        const id = crypto.randomUUID();
        const message: RelayRequest = { id, ...input };
        const result = await new Promise<RelayResponse>((resolve) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                resolve({ id, error: 'ClearPCB tab did not respond within 15 seconds.' });
            }, 15_000);
            this.pending.set(id, { resolve, timer });
            this.sendChunked(sockets[0], id, message);
        });
        return Response.json(result, { status: result.error ? 502 : 200 });
    }

    webSocketMessage(_socket: WebSocket, message: string | ArrayBuffer): void {
        if (typeof message !== 'string') return;
        let frame: RelayResponse & {
            transport?: string;
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

    webSocketClose(): void {
        for (const [id, pending] of this.pending) {
            clearTimeout(pending.timer);
            pending.resolve({ id, error: 'ClearPCB tab disconnected.' });
        }
        this.pending.clear();
        this.incomingChunks.clear();
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
                transport: 'chunk', transferId: id, index, total,
                data: serialized.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE),
            }));
        }
    }
}

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);
        const relaySession = sessionPath(url.pathname, true);
        if (relaySession) {
            if (!allowedRelayOrigin(request)) return new Response('Forbidden.', { status: 403 });
            return relayStub(env, relaySession).fetch(new Request('https://relay.internal/connect', request));
        }
        const sessionId = sessionPath(url.pathname);
        if (!sessionId) return new Response('Not found.', { status: 404 });
        return createMcpHandler(() => createServer(env, sessionId), {
            route: url.pathname,
            allowedHostnames: ['clearpcb.org', 'localhost', '127.0.0.1'],
            allowedOriginHostnames: ['clearpcb.org', 'localhost', '127.0.0.1'],
            legacy: 'stateless',
        })(request, env, ctx);
    },
} satisfies ExportedHandler<Env>;
