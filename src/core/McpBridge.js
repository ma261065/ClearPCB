import { applyJsonPatch } from './json-patch.js';
import { BuiltInComponents } from '../components/BuiltInComponents.js';

const SESSION_STORAGE_KEY = 'clearpcb_mcp_endpoint';
const DEFAULT_ENDPOINT = 'https://clearpcb-mcp.mikealex.workers.dev';
const CHUNK_SIZE = 192 * 1024;
const MAX_RELAY_MESSAGE = 16 * 1024 * 1024;

/**
 * @typedef {{chunks: Array<string|undefined>, bytes: number}} ChunkTransfer
 * @typedef {{id: string, method: string, params?: Record<string, unknown>}} RelayRequest
 * @typedef {{id: string, result?: unknown, error?: string}} RelayResponse
 * @typedef {{enabled: boolean, connected: boolean, sessionId?: string, mcpUrl?: string, connectionError?: string, canRevert?: boolean}} McpBridgeState
 */

function endpointOrigin() {
    try {
        const configured = localStorage.getItem(SESSION_STORAGE_KEY);
        if (configured) return new URL(configured).origin;
    } catch { /* local storage unavailable */ }
    return DEFAULT_ENDPOINT;
}

function makeSessionId() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function getComponentCatalog() {
    return {
        usage: {
            component: {
                type: 'component', id: 'comp_1', dn: 'Resistor',
                x: 40, y: 25, rot: 0, ref: 'R1', val: '10k',
            },
            notes: [
                'Use a catalog dn directly; do not add bundled definitions to schematic.defs.',
                'Component x/y is the symbol origin. Rotate pin offsets around that origin by rot degrees.',
                'Wire nd stores node coordinates, ed stores [from,to], and pc bonds nodes to {cid,pn}.',
                'PCB placements use the schematic component id and include x, y, and rot.',
                'Footprint PAD records are relative to the placement origin; track pdc bonds nodes to {cid,pn}.',
            ],
            wire: {
                id: 'wire_1', type: 'wire',
                nd: { n0: [36.19, 25], n1: [45, 25] },
                ed: { e0: ['n0', 'n1'] },
                pc: { n0: { cid: 'comp_1', pn: '1' } },
                n: 'SIGNAL',
            },
            placement: { x: 35, y: -20, rot: 0 },
            track: {
                id: 'track_1', type: 'track', l: 'top-copper',
                nd: { n0: [35, -20], n1: [45, -20] },
                ed: { e0: ['n0', 'n1'] },
                pdc: { n0: { cid: 'comp_1', pn: '1' } },
                n: 'SIGNAL', w: 0.25,
            },
        },
        components: BuiltInComponents.map(definition => ({
            dn: definition.name,
            description: definition.description,
            defaultReference: definition.defaultReference,
            defaultValue: definition.defaultValue,
            pins: definition.symbol.pins.map(pin => ({
                number: String(pin.number),
                name: pin.name,
                x: pin.x,
                y: pin.y,
                orientation: pin.orientation,
                length: pin.length,
                type: pin.type,
            })),
            footprintName: definition.footprintName,
            footprintShapes: definition.footprintShapes,
        })),
    };
}

export class McpBridge {
    /**
     * @param {import('./ProjectDocument.js').ProjectDocument} project
     * @param {{onStateChanged?: (state: McpBridgeState) => void}} [options]
     */
    constructor(project, { onStateChanged = () => {} } = {}) {
        this.project = project;
        this.onStateChanged = onStateChanged;
        this.enabled = false;
        this.connected = false;
        this.sessionId = '';
        this.socket = null;
        this.retryTimer = 0;
        this.retryCount = 0;
        this.connectionError = '';
        this.lastMcpSnapshot = null;
        /** @type {Map<string, ChunkTransfer>} */
        this.incomingChunks = new Map();
    }

    get mcpUrl() {
        return this.sessionId ? `${endpointOrigin()}/mcp/${this.sessionId}` : '';
    }

    enable() {
        if (this.enabled) return;
        this.enabled = true;
        this.sessionId = makeSessionId();
        this.retryCount = 0;
        this.connectionError = '';
        this._connect();
        this._notify();
    }

    disable() {
        this.enabled = false;
        this.connected = false;
        this.sessionId = '';
        this.connectionError = '';
        this.lastMcpSnapshot = null;
        this.incomingChunks.clear();
        clearTimeout(this.retryTimer);
        this.retryTimer = 0;
        this.socket?.close();
        this.socket = null;
        this._notify();
    }

    _connect() {
        if (!this.enabled || this.socket) return;
        const relay = new URL(`/mcp/relay/${this.sessionId}`, endpointOrigin());
        relay.protocol = relay.protocol === 'https:' ? 'wss:' : 'ws:';
        const socket = new WebSocket(relay);
        this.socket = socket;
        socket.addEventListener('open', () => {
            if (this.socket !== socket) return;
            this.connected = true;
            this.retryCount = 0;
            this.connectionError = '';
            this._notify();
        });
        socket.addEventListener('message', event => void this._handleRelayFrame(socket, event.data));
        socket.addEventListener('close', () => {
            if (this.socket !== socket) return;
            this.socket = null;
            this.connected = false;
            this.retryCount++;
            if (this.retryCount >= 3) this.connectionError = `Cannot reach ${endpointOrigin()}.`;
            this._notify();
            if (this.enabled) {
                const delay = Math.min(30_000, 1000 * (2 ** Math.min(this.retryCount, 5)));
                this.retryTimer = window.setTimeout(() => this._connect(), delay);
            }
        });
        socket.addEventListener('error', () => socket.close());
    }

    async revertLastChange() {
        if (!this.lastMcpSnapshot) return false;
        const snapshot = this.lastMcpSnapshot;
        await this.project.load(snapshot);
        this.lastMcpSnapshot = null;
        this._notify();
        return true;
    }

    /**
     * @param {WebSocket} socket
     * @param {unknown} raw
     */
    async _handleRelayFrame(socket, raw) {
        let frame;
        try {
            frame = JSON.parse(String(raw));
        } catch {
            return;
        }
        if (frame?.transport !== 'chunk') {
            await this._handleMessage(socket, frame);
            return;
        }
        if (typeof frame.transferId !== 'string' || !Number.isInteger(frame.index)
            || !Number.isInteger(frame.total) || frame.total < 1 || frame.total > 128
            || frame.index < 0 || frame.index >= frame.total || typeof frame.data !== 'string') return;
        let transfer = this.incomingChunks.get(frame.transferId);
        if (!transfer) {
            transfer = { chunks: new Array(frame.total), bytes: 0 };
            this.incomingChunks.set(frame.transferId, transfer);
        }
        if (transfer.chunks.length !== frame.total || transfer.chunks[frame.index] !== undefined) return;
        transfer.bytes += frame.data.length;
        if (transfer.bytes > MAX_RELAY_MESSAGE) {
            this.incomingChunks.delete(frame.transferId);
            this._send(socket, { id: frame.transferId, error: 'MCP request exceeds the 16 MiB relay limit.' });
            return;
        }
        transfer.chunks[frame.index] = frame.data;
        if (transfer.chunks.some(chunk => chunk === undefined)) return;
        this.incomingChunks.delete(frame.transferId);
        try {
            await this._handleMessage(socket, JSON.parse(transfer.chunks.join('')));
        } catch (error) {
            this._send(socket, { id: frame.transferId, error: /** @type {{message: string}} */ (error).message });
        }
    }

    /**
     * @param {WebSocket} socket
     * @param {unknown} raw Parsed relay JSON from an external MCP client.
     */
    async _handleMessage(socket, raw) {
        /** @type {RelayRequest|undefined} */
        let request = /** @type {RelayRequest|undefined} */ (raw);
        try {
            if (!request || typeof request.id !== 'string' || typeof request.method !== 'string') {
                throw new Error('Invalid relay request.');
            }
            let result;
            if (request.method === 'get_component_catalog') {
                result = getComponentCatalog();
            } else if (request.method === 'get_project') {
                result = this.project.serialize();
            } else if (request.method === 'replace_project') {
                if (!request.params?.project) throw new Error('replace_project requires project.');
                const previous = this.project.serialize();
                await this.project.load(/** @type {import('./ProjectDocument.js').ProjectData} */ (request.params.project));
                this.lastMcpSnapshot = previous;
                result = this.project.serialize();
            } else if (request.method === 'apply_project_patch') {
                const previous = this.project.serialize();
                const updated = applyJsonPatch(previous, /** @type {Parameters<typeof applyJsonPatch>[1]} */ (request.params?.patch));
                await this.project.load(/** @type {import('./ProjectDocument.js').ProjectData} */ (updated));
                this.lastMcpSnapshot = previous;
                result = this.project.serialize();
            } else {
                throw new Error(`Unsupported MCP operation: ${request.method}`);
            }
            this._send(socket, { id: request.id, result });
            this._notify();
        } catch (error) {
            if (request?.id) {
                const message = /** @type {{message: string}} */ (error).message;
                try { this._send(socket, { id: request.id, error: message }); } catch { /* disconnected */ }
            }
        }
    }

    /**
     * @param {WebSocket} socket
     * @param {RelayResponse} response
     */
    _send(socket, response) {
        const serialized = JSON.stringify(response);
        if (serialized.length > MAX_RELAY_MESSAGE) {
            socket.send(JSON.stringify({ id: response.id, error: 'MCP response exceeds the 16 MiB relay limit.' }));
            return;
        }
        if (serialized.length <= CHUNK_SIZE) {
            socket.send(serialized);
            return;
        }
        const total = Math.ceil(serialized.length / CHUNK_SIZE);
        for (let index = 0; index < total; index++) {
            socket.send(JSON.stringify({
                transport: 'chunk', transferId: response.id, index, total,
                data: serialized.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE),
            }));
        }
    }

    _notify() {
        this.onStateChanged({
            enabled: this.enabled,
            connected: this.connected,
            sessionId: this.sessionId,
            mcpUrl: this.mcpUrl,
            connectionError: this.connectionError,
            canRevert: !!this.lastMcpSnapshot,
        });
    }
}
