import { PcbPlacementState } from './PcbPlacementState.js';
import { PcbDesignSettings } from './PcbDesignSettings.js';
import { normalizePcbSection, compactProjectAliases } from './project-field-aliases.js';
import { assertSupportedPcb, defaultPcbStackup } from './project-format.js';
import { createShape } from '../shapes/index.js';
import { Track } from '../shapes/track.js';
import { Via, resetViaIdCounter, updateViaIdCounter } from '../shapes/via.js';
import { Pad, resetPadIdCounter, updatePadIdCounter } from '../shapes/pad.js';
import { createPcbText, serializePcbText } from './pcb-text.js';
import { loadBoardShapeData, serializeBoardShapes } from './pcb-board-shapes.js';
import { validBoardOutline, getBoardOutline, boardBoundary } from '../pcb/modules/board-outline.js';
import { hasRectangleFrame, rectangleFramePoints } from '../shapes/rectangle-frame.js';
import { updateFillIdCounter } from '../shapes/copper-fill.js';
import { panelSettings } from './pcb-panelization.js';

const round4 = value => Number.isFinite(value) ? Math.round(value * 10000) / 10000 : value;
const DEFAULT_BOARD_DIMENSIONS = Object.freeze({ width: 100, height: 80, radius: 0 });

/** Authoritative PCB data; view settings still await migration from the editor. */
export class PcbDocument {
    constructor() {
        this.placementState = new PcbPlacementState();
        this.designSettings = new PcbDesignSettings();
        this.board = { ...DEFAULT_BOARD_DIMENSIONS };
        /** @type {ReturnType<typeof panelSettings>|null} */
        this.panelization = null;
        /** @type {Track[]} */
        this.tracks = [];
        /** @type {Via[]} */
        this.vias = [];
        /** @type {Pad[]} */
        this.pads = [];
        /** @type {Map<string, ReturnType<typeof createPcbText>>} */
        this.texts = new Map();
        /** @type {any[]} Generic board shapes and CopperFill instances. */
        this.boardShapes = [];
        this.shapeIdCounter = 1;
    }

    static prepare(data) {
        data = normalizePcbSection(data);
        assertSupportedPcb(data);
        for (const shape of data?.boardShapes || []) {
            const outline = shape.kind === 'rect' && hasRectangleFrame(shape)
                ? { ...shape, points: rectangleFramePoints(shape) } : shape;
            if (shape.layer === 'board-outline' && !validBoardOutline(outline)) {
                throw new Error('The board outline must be one closed rectangle, polygon, or circle.');
            }
        }
        const stage = { boardShapes: [], shapeIdCounter: 1 };
        loadBoardShapeData(stage, data?.boardShapes, { strict: true });
        const outlines = stage.boardShapes.filter(shape => shape.layer === 'board-outline');
        if (outlines.length > 1 || outlines.some(shape => !validBoardOutline(shape))) {
            throw new Error('The board outline must be one closed rectangle, polygon, or circle.');
        }
        const tracks = (data?.tracks || []).map(item => {
            const track = createShape(item);
            if (!(track instanceof Track)) throw new Error('Invalid PCB track.');
            return track;
        });
        const prepared = { ...stage, data, tracks, vias: (data?.vias || []).map(item => Via.fromJSON(item)),
            pads: (data?.pads || []).map(item => new Pad(item)),
            texts: (data?.texts || []).map(item => createPcbText(item)),
            panelization: data?.panelization ? panelSettings(data.panelization) : null };
        if (data?.design) new PcbDesignSettings().update(data.design);
        return prepared;
    }

    clearEntities() {
        this.tracks.length = 0;
        this.vias.length = 0;
        this.pads.length = 0;
        this.texts.clear();
        this.boardShapes.length = 0;
        this.shapeIdCounter = 1;
        resetViaIdCounter();
        resetPadIdCounter();
        Object.assign(this.board, DEFAULT_BOARD_DIMENSIONS);
        this.panelization = null;
    }

    loadEntities(data, prepared = PcbDocument.prepare(data)) {
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
        this.shapeIdCounter = prepared.shapeIdCounter;
        for (const shape of prepared.boardShapes) {
            this.boardShapes.push(shape);
            if (shape.type === 'fill') updateFillIdCounter(shape.id);
        }
        const board = (prepared.data || data)?.board;
        const outline = getBoardOutline(this);
        if (outline || (board && board.width > 0 && board.height > 0)) {
            this.board.width = board?.width || DEFAULT_BOARD_DIMENSIONS.width;
            this.board.height = board?.height || DEFAULT_BOARD_DIMENSIONS.height;
            this.board.radius = board?.radius || 0;
            if (outline) {
                const bounds = boardBoundary(this);
                this.board.width = bounds.w;
                this.board.height = bounds.h;
                this.board.radius = outline.cornerRadius || 0;
            }
        }
    }

    serializeBoardDimensions() {
        return { width: round4(this.board.width), height: round4(this.board.height), radius: round4(this.board.radius) };
    }

    loadPanelization(value) {
        this.panelization = value ? panelSettings(value) : null;
    }

    serializePanelization() {
        return this.panelization ? panelSettings(this.panelization) : null;
    }

    /**
     * Assemble authored state using the existing file format and save precision.
     * @param {object} [settings] Viewport preferences supplied by the view.
     */
    serialize(settings) {
        const panelization = this.serializePanelization();
        return compactProjectAliases({ pcb: {
            stackup: defaultPcbStackup(),
            board: this.serializeBoardDimensions(),
            design: this.designSettings.serialize(),
            ...(panelization ? { panelization } : {}),
            settings,
            ...this.serializeEntities(),
            placements: this.placementState.serialize(),
        } }).pcb;
    }

    serializeEntities() {
        return { boardShapes: serializeBoardShapes(this), tracks: this.tracks.map(track => track.toJSON()),
            vias: this.vias.map(via => via.toJSON()), pads: this.pads.map(pad => pad.toJSON()),
            texts: [...this.texts.values()].map(text => {
                const saved = serializePcbText(text);
                return { ...saved, x: round4(saved.x), y: round4(saved.y), size: round4(saved.size),
                    rotation: round4(saved.rotation), strokeWidth: round4(saved.strokeWidth) };
            }) };
    }
}
