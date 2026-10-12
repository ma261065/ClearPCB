import assert from 'node:assert/strict';

const sockets = [];
class FakeSocket {
    constructor(url) {
        this.url = url;
        this.listeners = new Map();
        this.sent = [];
        sockets.push(this);
    }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    send(message) { this.sent.push(JSON.parse(message)); }
    close() { this.listeners.get('close')?.(); }
    emit(type, data) { this.listeners.get(type)?.({ data }); }
}

globalThis.location = { origin: 'https://clearpcb.org' };
globalThis.localStorage = { getItem: () => null };
globalThis.WebSocket = FakeSocket;
globalThis.window = { setTimeout };

const { McpBridge } = await import('../../src/core/McpBridge.js');
let document = { type: 'clearpcb-project', version: '1.0', schematic: { shapes: [], components: [] } };
const project = {
    serialize: () => structuredClone(document),
    async load(value) { document = structuredClone(value); },
};
const states = [];
const bridge = new McpBridge(project, { onStateChanged: state => states.push(state) });
bridge.enable();
assert.match(bridge.mcpUrl, /^https:\/\/clearpcb\.org\/mcp\/[0-9a-f-]{36}$/);
assert.equal(String(sockets[0].url), bridge.mcpUrl.replace('https://', 'wss://').replace('/mcp/', '/mcp/relay/'));
sockets[0].emit('open');
assert.equal(states.at(-1).connected, true);

sockets[0].emit('message', JSON.stringify({ id: 'read', method: 'get_project' }));
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(sockets[0].sent.at(-1).result.type, 'clearpcb-project');
const chunkedRequest = JSON.stringify({
    id: 'chunked-read',
    method: 'get_project',
    params: { padding: 'x'.repeat(200_000) },
});
const midpoint = Math.ceil(chunkedRequest.length / 2);
sockets[0].emit('message', JSON.stringify({
    transport: 'chunk', transferId: 'chunked-read', index: 0, total: 2,
    data: chunkedRequest.slice(0, midpoint),
}));
sockets[0].emit('message', JSON.stringify({
    transport: 'chunk', transferId: 'chunked-read', index: 1, total: 2,
    data: chunkedRequest.slice(midpoint),
}));
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(sockets[0].sent.at(-1).id, 'chunked-read');
document.large = 'x'.repeat(200_000);
const beforeChunks = sockets[0].sent.length;
sockets[0].emit('message', JSON.stringify({ id: 'large-read', method: 'get_project' }));
await new Promise(resolve => setTimeout(resolve, 0));
const responseChunks = sockets[0].sent.slice(beforeChunks);
assert.ok(responseChunks.length > 1);
assert.ok(responseChunks.every(frame => frame.transport === 'chunk' && frame.transferId === 'large-read'));
const largeResponse = JSON.parse(responseChunks.sort((a, b) => a.index - b.index).map(frame => frame.data).join(''));
assert.equal(largeResponse.result.large.length, 200_000);
delete document.large;
sockets[0].emit('message', JSON.stringify({
    id: 'patch',
    method: 'apply_project_patch',
    params: { patch: [{ op: 'add', path: '/schematic/shapes/-', value: { id: 'shape-1' } }] },
}));
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(document.schematic.shapes.length, 1);
assert.equal(sockets[0].sent.at(-1).result.schematic.shapes[0].id, 'shape-1');
assert.equal(states.at(-1).canRevert, true);
assert.equal(await bridge.revertLastChange(), true);
assert.equal(document.schematic.shapes.length, 0);
assert.equal(states.at(-1).canRevert, false);
sockets[0].emit('message', JSON.stringify({ id: 'bad', method: 'unknown' }));
await new Promise(resolve => setTimeout(resolve, 0));
assert.match(sockets[0].sent.at(-1).error, /Unsupported/);
bridge.disable();
assert.equal(states.at(-1).enabled, false);

console.log('PASS: MCP bridge pairs, reads, patches, reports errors, and disables cleanly');
