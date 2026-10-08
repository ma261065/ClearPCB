import { PcbPlacementState } from './PcbPlacementState.js';
import { PcbDesignSettings, clampDesignDimensions } from './PcbDesignSettings.js';
import { normalizePcbSection, compactProjectAliases } from './project-field-aliases.js';
import { assertSupportedPcb, defaultPcbStackup } from './project-format.js';
import { createShape } from '../shapes/index.js';
import { Track } from '../shapes/track.js';
import { Via, resetViaIdCounter, updateViaIdCounter } from '../shapes/via.js';
import { Pad, resetPadIdCounter, updatePadIdCounter } from '../shapes/pad.js';
import { createPcbText, serializePcbText } from './pcb-text.js';
import { isBoardShape, loadBoardShapeData, serializeBoardShapes } from './pcb-board-shapes.js';
import { capturePcbGeometry } from './pcb-geometry-snapshot.js';
import { validBoardOutline, getBoardOutline, rectangleBoardOutline, boardBoundary } from '../shared/pcb/board-outline.js';
import { hasRectangleFrame, rectangleFramePoints } from '../shapes/rectangle-frame.js';
import { updateFillIdCounter } from '../shapes/copper-fill.js';
import { isCopperPathShape, trackFromBoardShape } from '../shared/pcb/copper-path-tracks.js';
import { panelSettings } from './pcb-panelization.js';

/** @typedef {import('./project-field-aliases.js').JsonRecord} JsonRecord */
/** @typedef {import('./pcb-board-shapes.js').BoardShape} BoardShape */
/** @typedef {import('./pcb-board-shapes.js').BoardShapeEntry} BoardShapeEntry */
/** @typedef {import('../shapes/copper-fill.js').CopperFill} CopperFill */
/** @typedef {ReturnType<typeof createPcbText>} PcbText */
/** @typedef {JsonRecord & {boardShapes?: Array<BoardShapeEntry|JsonRecord>, board?: {width?: number, height?: number, radius?: number}, tracks?: Array<Parameters<typeof createShape>[0]|JsonRecord>, vias?: Array<Parameters<typeof Via.fromJSON>[0]|JsonRecord>, pads?: Array<ConstructorParameters<typeof Pad>[0]|JsonRecord>, texts?: Array<Parameters<typeof createPcbText>[0]|JsonRecord>, panelization?: Parameters<typeof panelSettings>[0]|JsonRecord, design?: Record<string, unknown>, settings?: JsonRecord, placements?: Parameters<PcbPlacementState['load']>[0]}} PcbData */
/** @typedef {{boardShapes: BoardShapeEntry[], shapeIdCounter: number, data: PcbData|null|undefined, tracks: Track[], vias: Via[], pads: Pad[], texts: PcbText[], panelization: ReturnType<typeof panelSettings>|null}} PcbPreparedData */

/** @param {number} value */
const round4 = value => Number.isFinite(value) ? Math.round(value * 10000) / 10000 : value;
const DEFAULT_BOARD_DIMENSIONS = Object.freeze({ width: 100, height: 80, radius: 0 });

/** Authoritative PCB data and loaded preferences; live viewport settings remain view-owned. */
export class PcbDocument {
    constructor() {
        this.placementState = new PcbPlacementState();
        this.designSettings = new PcbDesignSettings();
        /** @type {{width: number, height: number, radius: number}} */
        this.board = { ...DEFAULT_BOARD_DIMENSIONS };
        /** @type {object|undefined} Loaded viewport preferences; a live view supplies current values. */
        this.settings = undefined;
        this._loadedSection = false;
        /** @type {ReturnType<typeof panelSettings>|null} */
        this.panelization = null;
        /** @type {Track[]} */
        this.tracks = [];
        /** @type {Via[]} */
        this.vias = [];
        /** @type {Pad[]} */
        this.pads = [];
        /** @type {Map<string, PcbText>} */
        this.texts = new Map();
        /** @type {BoardShapeEntry[]} Generic board shapes; fill entries are kept in this collection at runtime. */
        this.boardShapes = [];
        this.shapeIdCounter = 1;
    }

    /** CopperFill entries owned by the canonical board-shape collection. */
    get copperFills() {
        return /** @type {CopperFill[]} */ (/** @type {unknown} */ (this.boardShapes.filter(shape => shape?.type === 'fill')));
    }

    /**
     * @param {PcbData|null|undefined} data Project PCB JSON from disk/import.
     * @returns {PcbPreparedData}
     */
    static prepare(data) {
        data = /** @type {PcbData|null|undefined} */ (normalizePcbSection(data));
        assertSupportedPcb(data);
        for (const shape of data?.boardShapes || []) {
            const boardShape = /** @type {BoardShape} */ (shape);
            const outline = boardShape.kind === 'rect' && hasRectangleFrame(boardShape)
                ? { ...boardShape, points: rectangleFramePoints(boardShape) } : boardShape;
            if (boardShape.layer === 'board-outline' && !validBoardOutline(outline)) {
                throw new Error('The board outline must be one closed rectangle, polygon, or circle.');
            }
        }
        /** @type {{boardShapes: BoardShapeEntry[], shapeIdCounter: number}} */
        const stage = { boardShapes: [], shapeIdCounter: 1 };
        loadBoardShapeData(stage, data?.boardShapes, { strict: true });
        const board = data?.board;
        if (!getBoardOutline(stage) && Number(board?.width) > 0 && Number(board?.height) > 0) {
            const outline = rectangleBoardOutline(Number(board?.width), Number(board?.height), Number(board?.radius) || 0);
            if (stage.boardShapes.some(shape => shape.id === outline.id)) outline.id = `pshape_${stage.shapeIdCounter++}`;
            stage.boardShapes.push(outline);
        }
        const outlines = stage.boardShapes.filter(isBoardShape).filter(shape => shape.layer === 'board-outline');
        if (outlines.length > 1 || outlines.some(shape => !validBoardOutline(shape))) {
            throw new Error('The board outline must be one closed rectangle, polygon, or circle.');
        }
        /** @type {Track[]} */
        const tracks = (data?.tracks || []).map(item => {
            const track = createShape(item);
            if (!(track instanceof Track)) throw new Error('Invalid PCB track.');
            return track;
        });
        // Copper paths that earlier versions saved as board shapes load as Tracks
        // (after the file's own tracks, so new ids never collide with theirs).
        const copperPaths = stage.boardShapes.filter(isBoardShape).filter(isCopperPathShape);
        if (copperPaths.length) {
            const copperPathSet = new Set(copperPaths);
            stage.boardShapes = stage.boardShapes.filter(shape => !(isBoardShape(shape) && isCopperPathShape(shape) && copperPathSet.has(shape)));
            tracks.push(...copperPaths.map(shape => trackFromBoardShape(shape)));
        }
        const prepared = { ...stage, data, tracks, vias: (data?.vias || []).map(item => Via.fromJSON(/** @type {Parameters<typeof Via.fromJSON>[0]} */ (item))),
            pads: (data?.pads || []).map(item => new Pad(item)),
            texts: (data?.texts || []).map(item => createPcbText(item)),
            panelization: data?.panelization ? panelSettings(data.panelization) : null };
        if (data?.design) new PcbDesignSettings().update(clampDesignDimensions(data.design));
        return prepared;
    }

    /** New retains last-used design settings; authored content is cleared in place. */
    clear() {
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
        this.placementState.overrides.clear();
        this.placementState.autoSlots.clear();
        this.settings = undefined;
        this._loadedSection = false;
    }

    /** Load authored content, leaving panel installation to the final load phase. */
    /**
     * @param {PcbData|null|undefined} data Project PCB JSON from disk/import.
     * @param {PcbPreparedData} [prepared]
     */
    loadContent(data, prepared = PcbDocument.prepare(data)) {
        this.clear();
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
        const loaded = prepared.data || data;
        this._loadedSection = !!loaded;
        this.settings = structuredClone(loaded?.settings);
        if (loaded?.design) this.designSettings.update(clampDesignDimensions(loaded.design));
        this.placementState.load(loaded?.placements);
        const board = loaded?.board;
        const outline = getBoardOutline(this);
        if (outline || (board && Number(board.width) > 0 && Number(board.height) > 0)) {
            this.board.width = Number(board?.width) || DEFAULT_BOARD_DIMENSIONS.width;
            this.board.height = Number(board?.height) || DEFAULT_BOARD_DIMENSIONS.height;
            this.board.radius = board?.radius || 0;
            if (outline) this.syncBoardOutlineDimensions();
        }
    }

    syncBoardOutlineDimensions() {
        const bounds = boardBoundary(this);
        this.board.width = bounds.w;
        this.board.height = bounds.h;
        this.board.radius = getBoardOutline(this)?.cornerRadius || 0;
    }

    /** @param {BoardShape} outline */
    setBoardOutline(outline) {
        if (!validBoardOutline(outline)) {
            throw new Error('The board outline must be one closed rectangle, polygon, or circle.');
        }
        const snapshot = structuredClone(outline);
        const current = getBoardOutline(this);
        if (current) {
            for (const key of Object.keys(current)) delete current[key];
            Object.assign(current, snapshot);
        } else {
            this.boardShapes.push(snapshot);
        }
        this.syncBoardOutlineDimensions();
        return current || snapshot;
    }

    ensureBoardOutline() {
        return getBoardOutline(this) || this.setBoardOutline(
            rectangleBoardOutline(this.board.width, this.board.height, this.board.radius));
    }

    /** Complete data-only load; editors may use the two phases around rendering. */
    /**
     * @param {PcbData|null|undefined} data
     * @param {PcbPreparedData} [prepared]
     */
    load(data, prepared = PcbDocument.prepare(data)) {
        this.loadContent(data, prepared);
        this.loadPanelization(prepared.panelization);
    }

    serializeBoardDimensions() {
        return { width: round4(this.board.width), height: round4(this.board.height), radius: round4(this.board.radius) };
    }

    /** @param {Parameters<typeof panelSettings>[0]|ReturnType<typeof panelSettings>|null|undefined} value */
    loadPanelization(value) {
        this.panelization = value ? panelSettings(value) : null;
    }

    serializePanelization() {
        return this.panelization ? panelSettings(this.panelization) : null;
    }

    /**
     * Assemble authored state using the existing file format and save precision.
     * @param {object|undefined} [settings] Viewport preferences supplied by the view.
     */
    serialize(settings = this.settings) {
        const panelization = this.serializePanelization();
        const compacted = /** @type {{pcb: PcbData}} */ (compactProjectAliases({ pcb: {
            stackup: defaultPcbStackup(),
            board: this.serializeBoardDimensions(),
            design: this.designSettings.serialize(),
            ...(panelization ? { panelization } : {}),
            settings,
            ...this.serializeEntities(),
            placements: this.placementState.serialize(),
        } }));
        return compacted.pcb;
    }

    /**
     * Retained design defaults alone do not create an otherwise absent PCB section.
     * Current view preferences preserve a settings-only section for an empty viewed board.
     * @param {object|undefined} [settings] Current view preferences, or loaded preferences by default.
     */
    serializeSection(settings = this.settings) {
        const hasContent = this._loadedSection || this.tracks.length || this.vias.length || this.pads.length
            || this.boardShapes.length || this.texts.size || this.placementState.overrides.size
            || this.placementState.autoSlots.size || this.panelization
            || /** @type {Array<keyof typeof DEFAULT_BOARD_DIMENSIONS>} */ (Object.keys(DEFAULT_BOARD_DIMENSIONS))
                .some(key => this.board[key] !== DEFAULT_BOARD_DIMENSIONS[key])
            || settings !== undefined;
        return hasContent ? this.serialize(settings) : null;
    }

    /** Full-precision physical data, without consumer query methods or computed pours. */
    captureGeometry() {
        return capturePcbGeometry(this);
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
