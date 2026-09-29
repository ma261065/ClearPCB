import { PcbPlacementState } from './PcbPlacementState.js';
import { PcbDesignSettings } from './PcbDesignSettings.js';
import { normalizePcbSection } from './project-field-aliases.js';
import { assertSupportedPcb } from './project-format.js';
import { createShape } from '../shapes/index.js';
import { Track } from '../shapes/track.js';
import { Via, resetViaIdCounter, updateViaIdCounter } from '../shapes/via.js';
import { Pad, resetPadIdCounter, updatePadIdCounter } from '../shapes/pad.js';
import { createPcbText, serializePcbText } from './pcb-text.js';

const round4 = value => Number.isFinite(value) ? Math.round(value * 10000) / 10000 : value;

/** Authoritative PCB data; board shapes still await migration from the view. */
export class PcbDocument {
    constructor() {
        this.placementState = new PcbPlacementState();
        this.designSettings = new PcbDesignSettings();
        /** @type {Track[]} */
        this.tracks = [];
        /** @type {Via[]} */
        this.vias = [];
        /** @type {Pad[]} */
        this.pads = [];
        /** @type {Map<string, ReturnType<typeof createPcbText>>} */
        this.texts = new Map();
    }

    static prepareEntities(data) {
        data = normalizePcbSection(data);
        assertSupportedPcb(data);
        const tracks = (data?.tracks || []).map(item => {
            const track = createShape(item);
            if (!(track instanceof Track)) throw new Error('Invalid PCB track.');
            return track;
        });
        return { data, tracks, vias: (data?.vias || []).map(item => Via.fromJSON(item)),
            pads: (data?.pads || []).map(item => new Pad(item)),
            texts: (data?.texts || []).map(item => createPcbText(item)) };
    }

    clearEntities() {
        this.tracks.length = 0;
        this.vias.length = 0;
        this.pads.length = 0;
        this.texts.clear();
        resetViaIdCounter();
        resetPadIdCounter();
    }

    loadEntities(data, prepared = PcbDocument.prepareEntities(data)) {
        this.clearEntities();
        for (const track of prepared.tracks) this.tracks.push(track);
        for (const via of prepared.vias) {
            updateViaIdCounter(via.id);
            this.vias.push(via);
        }
        for (const pad of prepared.pads) {
            updatePadIdCounter(pad.id);
            this.pads.push(pad);
        }
        for (const text of prepared.texts) this.texts.set(text.id, text);
    }

    serializeEntities() {
        return { tracks: this.tracks.map(track => track.toJSON()),
            vias: this.vias.map(via => via.toJSON()), pads: this.pads.map(pad => pad.toJSON()),
            texts: [...this.texts.values()].map(text => {
                const saved = serializePcbText(text);
                return { ...saved, x: round4(saved.x), y: round4(saved.y), size: round4(saved.size),
                    rotation: round4(saved.rotation), strokeWidth: round4(saved.strokeWidth) };
            }) };
    }
}
