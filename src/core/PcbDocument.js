import { PcbPlacementState } from './PcbPlacementState.js';
import { PcbDesignSettings } from './PcbDesignSettings.js';
import { normalizePcbSection } from './project-field-aliases.js';
import { assertSupportedPcb } from './project-format.js';
import { createShape } from '../shapes/index.js';
import { Track } from '../shapes/track.js';
import { Via, resetViaIdCounter, updateViaIdCounter } from '../shapes/via.js';
import { Pad, resetPadIdCounter, updatePadIdCounter } from '../shapes/pad.js';

/** Authoritative PCB data; board shapes and text still await migration from the view. */
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
    }

    static prepareCopper(data) {
        data = normalizePcbSection(data);
        assertSupportedPcb(data);
        const tracks = (data?.tracks || []).map(item => {
            const track = createShape(item);
            if (!(track instanceof Track)) throw new Error('Invalid PCB track.');
            return track;
        });
        return { data, tracks, vias: (data?.vias || []).map(item => Via.fromJSON(item)),
            pads: (data?.pads || []).map(item => new Pad(item)) };
    }

    clearCopper() {
        this.tracks.length = 0;
        this.vias.length = 0;
        this.pads.length = 0;
        resetViaIdCounter();
        resetPadIdCounter();
    }

    loadCopper(data, prepared = PcbDocument.prepareCopper(data)) {
        this.clearCopper();
        for (const track of prepared.tracks) this.tracks.push(track);
        for (const via of prepared.vias) {
            updateViaIdCounter(via.id);
            this.vias.push(via);
        }
        for (const pad of prepared.pads) {
            updatePadIdCounter(pad.id);
            this.pads.push(pad);
        }
    }

    serializeCopper() {
        return { tracks: this.tracks.map(track => track.toJSON()),
            vias: this.vias.map(via => via.toJSON()), pads: this.pads.map(pad => pad.toJSON()) };
    }
}
