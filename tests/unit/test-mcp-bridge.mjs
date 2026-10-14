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
let configuredEndpoint = null;
globalThis.localStorage = { getItem: () => configuredEndpoint };
globalThis.WebSocket = FakeSocket;
globalThis.window = { setTimeout };
const fetchCalls = [];
globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url: String(url), options });
    if (String(url).endsWith('/mcp/pairing/register')) {
        return {
            ok: true,
            status: 200,
            json: async () => ({ code: 'K7QM-2X9R', expiresAt: Date.now() + 300_000 }),
        };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
};

const { McpBridge } = await import('../../src/core/McpBridge.js');
let document = { type: 'clearpcb-project', version: '1.0', schematic: { shapes: [], components: [] } };
const project = {
    serialize: () => structuredClone(document),
    async load(value) { document = structuredClone(value); },
    schematicDocument: {
        components: [{
            id: 'comp-geometry', reference: 'R9', value: '1k',
            definition: { name: 'Resistor' },
            symbol: { pins: [{ number: '1', name: '1', type: 'passive', x: -3.81, y: 0 }] },
            localToWorld: (x, y) => ({ x: 40 + x, y: 25 + y }),
        }],
    },
    resolvePcbLayout: () => ({
        placements: new Map([['comp-geometry', {
            reference: 'R9', footprint: 'R_Axial', x: 10, y: -10, rotation: 0, side: 'top',
            pads: new Map([['pad-1', { number: '1', x: 10, y: -10 }]]),
        }]]),
    }),
    getNetlist: () => [{ net: 'R9.1', pins: [{ componentId: 'comp-geometry', pinNumber: '1' }] }],
};
const externalDefinition = {
    name: 'KiCad_NE555D',
    description: 'NE555D timer',
    category: 'KiCad',
    defaultReference: 'U?',
    defaultValue: 'NE555D',
    _source: 'KiCad',
    symbol: {
        width: 20,
        height: 20,
        origin: { x: 10, y: 10 },
        graphics: [],
        pins: [{ number: '1', name: 'GND', x: 0, y: 10, orientation: 'right', length: 2.54, type: 'power_in' }],
    },
    footprintName: 'Package_SO:SOIC-8',
    footprintShapes: ['PAD~1~RECT~0~0~1~2~0~~1~0~0~0~0~0'],
    hasFootprint: true,
};
const componentLibrary = {
    searchKiCad: async () => [{ library: 'Timer', name: 'NE555D', fullName: 'Timer:NE555D' }],
    searchLCSC: async () => [{
        lcscPartNumber: 'C46749',
        mpn: 'NE555DR',
        manufacturer: 'Texas Instruments',
        description: 'Timer',
        package: 'SOIC-8',
        stock: 100,
    }],
    fetchFromKiCad: async () => structuredClone(externalDefinition),
    fetchFromLCSC: async () => ({ ...structuredClone(externalDefinition), name: 'LCSC_C46749', _source: 'LCSC' }),
};
const states = [];
const bridge = new McpBridge(project, {
    onStateChanged: state => states.push(state),
    componentLibrary,
});
bridge.enable();
assert.equal(bridge.mcpUrl, 'https://clearpcb-mcp.mikealex.workers.dev/mcp');
assert.match(String(sockets[0].url), /^wss:\/\/clearpcb-mcp\.mikealex\.workers\.dev\/mcp\/relay\/[0-9a-f-]{36}$/);
sockets[0].emit('open');
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(states.at(-1).connected, true);
assert.equal(states.at(-1).pairingCode, 'K7QM-2X9R');

sockets[0].emit('message', JSON.stringify({
    id: 'pair',
    method: 'request_pairing',
    params: { client: { id: 'client-1', name: 'Claude', version: '1.0' } },
}));
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(states.at(-1).pendingClient.name, 'Claude');
assert.equal(bridge.approvePairing(), true);
assert.deepEqual(sockets[0].sent.at(-1).result, { approved: true });
assert.equal(states.at(-1).pairedClient.name, 'Claude');

sockets[0].emit('message', JSON.stringify({ id: 'schema', method: 'describe_schema' }));
await new Promise(resolve => setTimeout(resolve, 0));
const schema = sockets[0].sent.at(-1).result;
assert.equal(schema.examples.component.dn, 'Resistor');
assert.ok(schema.notes.some(note => note.includes('do not add bundled definitions')));
assert.deepEqual(schema.format.schematic.shapeTypes,
    ['polyline', 'wire', 'circle', 'arc', 'text', 'net', 'noconnect']);
assert.equal(schema.format.schematic.shapeTypes.includes('power'), false);
assert.equal(schema.format.pcb.optional.includes('boardShapes'), true);
assert.equal(schema.format.pcb.optional.includes('shapes'), false);

sockets[0].emit('message', JSON.stringify({ id: 'parts', method: 'list_parts' }));
await new Promise(resolve => setTimeout(resolve, 0));
const parts = sockets[0].sent.at(-1).result;
assert.equal(parts.find(part => part.dn === 'IC_DIP8').pinCount, 8);

sockets[0].emit('message', JSON.stringify({ id: 'part', method: 'get_part', params: { dn: 'LED' } }));
await new Promise(resolve => setTimeout(resolve, 0));
const part = sockets[0].sent.at(-1).result;
assert.deepEqual(part.pins.map(pin => pin.number), ['A', 'K']);
assert.ok(part.footprintShapes.some(shape => shape.includes('PAD')));

sockets[0].emit('message', JSON.stringify({
    id: 'search-parts',
    method: 'search_parts',
    params: { query: '555', source: 'all', limit: 10 },
}));
await new Promise(resolve => setTimeout(resolve, 0));
const searchResults = sockets[0].sent.at(-1).result.results;
assert.ok(searchResults.some(result => result.source === 'kicad' && result.id === 'Timer:NE555D'));
assert.ok(searchResults.some(result => result.source === 'lcsc' && result.id === 'C46749'));

sockets[0].emit('message', JSON.stringify({
    id: 'external-part',
    method: 'get_part',
    params: { source: 'kicad', id: 'Timer:NE555D' },
}));
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(sockets[0].sent.at(-1).result.source, 'kicad');
assert.equal(sockets[0].sent.at(-1).result.footprintName, 'Package_SO:SOIC-8');

sockets[0].emit('message', JSON.stringify({
    id: 'place-part',
    method: 'place_part',
    params: { source: 'kicad', id: 'Timer:NE555D', x: 70, y: 40 },
}));
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(sockets[0].sent.at(-1).result.component.ref, 'U1');
assert.equal(document.schematic.components.at(-1).dn, 'KiCad_NE555D');
assert.ok(document.schematic.defs.KiCad_NE555D);
assert.equal(await bridge.revertLastChange(), true);
assert.equal(document.schematic.components.length, 0);

sockets[0].emit('message', JSON.stringify({ id: 'read', method: 'get_project' }));
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(sockets[0].sent.at(-1).result.type, 'clearpcb-project');
sockets[0].emit('message', JSON.stringify({ id: 'points', method: 'get_connection_points' }));
await new Promise(resolve => setTimeout(resolve, 0));
assert.deepEqual(sockets[0].sent.at(-1).result.schematic.components[0].pins[0],
    { number: '1', name: '1', type: 'passive', x: 36.19, y: 25 });
assert.deepEqual(sockets[0].sent.at(-1).result.pcb.placements[0].pads[0],
    { id: 'pad-1', number: '1', x: 10, y: -10 });
sockets[0].emit('message', JSON.stringify({ id: 'netlist', method: 'get_netlist' }));
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(sockets[0].sent.at(-1).result.nets[0].net, 'R9.1');
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
assert.deepEqual(sockets[0].sent.at(-1).result, {
    ok: true,
    operation: 'apply_project_patch',
    operations: 1,
});
assert.equal(states.at(-1).canRevert, true);
assert.equal(await bridge.revertLastChange(), true);
assert.equal(document.schematic.shapes.length, 0);
assert.equal(states.at(-1).canRevert, false);
sockets[0].emit('message', JSON.stringify({ id: 'bad', method: 'unknown' }));
await new Promise(resolve => setTimeout(resolve, 0));
assert.match(sockets[0].sent.at(-1).error, /Unsupported/);
assert.equal(bridge.disconnectClient(), true);
assert.deepEqual(sockets[0].sent.at(-1), { transport: 'control', action: 'disconnect' });
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(states.at(-1).pairedClient, undefined);
bridge.disable();
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(states.at(-1).enabled, false);
assert.ok(fetchCalls.some(call => call.url.endsWith('/mcp/pairing/revoke')));

configuredEndpoint = 'http://localhost:8787/ignored-path';
const localBridge = new McpBridge(project);
localBridge.enable();
assert.equal(localBridge.mcpUrl, 'http://localhost:8787/mcp');
assert.match(String(sockets.at(-1).url), /^ws:\/\/localhost:8787\/mcp\/relay\/[0-9a-f-]{36}$/);
localBridge.disable();

console.log('PASS: MCP bridge registers, approves, discovers, patches, disconnects, and disables cleanly');
