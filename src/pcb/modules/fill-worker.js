import { computeFillBatch } from './fill-worker-geometry.js';
import { prepareCopperRegionContact } from './track-contact-geometry.js';

globalThis.onmessage = async ({ data }) => {
    try {
        const results = await computeFillBatch(data.inputs);
        const contacts = results.map(regions => regions.map(prepareCopperRegionContact));
        const transfer = contacts.flat().flatMap(contact =>
            [contact.indices.buffer, contact.bounds.buffer, contact.triangleBounds.buffer]);
        globalThis.postMessage({ id: data.id, results, contacts }, { transfer });
    } catch (error) {
        globalThis.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) });
    }
};
