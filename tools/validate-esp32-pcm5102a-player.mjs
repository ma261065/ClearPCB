import { readFile } from 'node:fs/promises';
import { unzip, strFromU8 } from '../assets/vendor/fflate.module.js';
import { readProjectFile } from '../src/core/FileManager.js';
import { createShape } from '../src/shapes/index.js';

const filename = new URL('../ESP32-PCM5102A-Audio-Player.cpcb', import.meta.url);
const bytes = await readFile(filename);

const entries = await new Promise((resolve, reject) => {
    unzip(bytes, (error, result) => error ? reject(error) : resolve(result));
});
const expectedEntries = ['manifest.json', 'options.json', 'schematic.json', 'pcb.json'];
for (const name of expectedEntries) {
    if (!entries[name]) throw new Error(`Missing ZIP entry: ${name}`);
}
const manifest = JSON.parse(strFromU8(entries['manifest.json']));
if (manifest.format !== 'clearpcb-zip' || manifest.version !== 1) {
    throw new Error('Invalid ClearPCB ZIP manifest');
}

const document = await readProjectFile(new Blob([bytes], { type: 'application/zip' }));
if (document.version !== '2.0' || document.type !== 'clearpcb-project') {
    throw new Error('Invalid ClearPCB document envelope');
}
if (!document.schematic || !document.pcb) throw new Error('Missing schematic or PCB section');

const { components, shapes, defs } = document.schematic;
if (components.length !== 46) throw new Error(`Expected 46 components, got ${components.length}`);
if (shapes.length !== 30) throw new Error(`Expected 30 wires, got ${shapes.length}`);
if (Object.keys(defs).length !== 13) throw new Error(`Expected 13 definitions, got ${Object.keys(defs).length}`);

const componentsById = new Map(components.map((component) => [component.id, component]));
for (const component of components) {
    if (!defs[component.dn]) throw new Error(`${component.id}: missing definition ${component.dn}`);
}

for (const shapeData of shapes) {
    const shape = createShape(shapeData);
    if (shape.type !== 'wire') throw new Error(`${shapeData.id}: expected wire shape`);
    for (const [edgeId, edge] of Object.entries(shapeData.ed || {})) {
        if (!shapeData.nd?.[edge[0]] || !shapeData.nd?.[edge[1]]) {
            throw new Error(`${shapeData.id}/${edgeId}: edge references a missing node`);
        }
    }
    for (const [nodeId, connection] of Object.entries(shapeData.pc || {})) {
        if (!shapeData.nd?.[nodeId]) throw new Error(`${shapeData.id}: pin connection references missing node ${nodeId}`);
        const component = componentsById.get(connection.componentId);
        if (!component) throw new Error(`${shapeData.id}: missing component ${connection.componentId}`);
        const definition = defs[component.dn];
        if (!definition.symbol.pins.some((pin) => String(pin.number) === String(connection.pinNumber))) {
            throw new Error(`${shapeData.id}: missing pin ${connection.pinNumber} on ${component.ref}`);
        }
    }
}

console.log(`ZIP entries: ${expectedEntries.join(', ')}`);
console.log(`Document: ${document.version} ${document.type}, schematic + PCB`);
console.log(`Validated: ${components.length} components, ${shapes.length} wires, ${Object.keys(defs).length} definitions`);
console.log('Connectivity: all wire nodes, edges, component IDs, and pin numbers valid');