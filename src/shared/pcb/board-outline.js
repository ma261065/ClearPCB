import { shapeOutline } from './board-shape-geometry.js';
import { validClosedShape } from '../../shapes/closed-outline.js';

/**
 * @typedef {import('../../core/pcb-board-shapes.js').BoardShapeData} BoardShapeData
 * @typedef {Record<string, any>} BoardOutlineState
 * @typedef {BoardShapeData & {id: string, kind: any, layer: any, points: any[]}} BoardOutlineShape
 * @typedef {BoardOutlineState & {width: number, height: number, radius: number}} BoardDimensions
 * @typedef {BoardOutlineState & {board: BoardDimensions, outline: BoardOutlineShape}} BoardDimensionPreview
 * @typedef {BoardOutlineState & {boardShapes?: BoardShapeData[], pcbDocument?: {board?: Partial<BoardDimensions>, syncBoardOutlineDimensions: () => void}, board?: Partial<BoardDimensions>, boardWidth?: number, boardHeight?: number, boardRadius?: number, width?: number, height?: number, radius?: number}} BoardOutlineApp
 */

/** @type {WeakMap<BoardOutlineApp, BoardDimensionPreview>} */
const dimensionPreviews = new WeakMap();

/** @param {BoardOutlineApp} app */
export function getBoardDimensionPreview(app) {
    return dimensionPreviews.get(app);
}

/** @param {BoardOutlineApp} app @param {BoardDimensionPreview} preview */
export function setBoardDimensionPreview(app, preview) {
    dimensionPreviews.set(app, preview);
}

/** @param {BoardOutlineApp} app */
export function clearBoardDimensionPreview(app) {
    const preview = dimensionPreviews.get(app);
    dimensionPreviews.delete(app);
    return preview;
}

/**
 * The editor's rectangular board dimensions (mm), exactly as stored; undefined until set.
 * @param {any} app
 * @returns {BoardDimensions}
 */
export function boardDimensions(app) {
    const preview = getBoardDimensionPreview(app);
    const board = /** @type {BoardDimensions} */ (preview ? preview.board : app.pcbDocument ? app.pcbDocument.board : app.board || app);
    return {
        width: /** @type {number} */ (board.width !== undefined ? board.width : app.boardWidth),
        height: /** @type {number} */ (board.height !== undefined ? board.height : app.boardHeight),
        radius: /** @type {number} */ (board.radius !== undefined ? board.radius : app.boardRadius),
    };
}

/** @param {BoardOutlineApp} app @returns {any} */
export function getBoardOutline(app) {
    return app.boardShapes?.find(shape => shape.layer === 'board-outline') || null;
}

/** @param {number} width @param {number} height @param {number} [radius] @returns {BoardOutlineShape} */
export function rectangleBoardOutline(width, height, radius = 0) {
    return { id: 'board-outline', kind: 'rect', layer: 'board-outline', lineWidth: 0.2,
        filled: false, cornerRadius: radius,
        points: [{ x: 0, y: -height }, { x: width, y: -height }, { x: width, y: 0 }, { x: 0, y: 0 }] };
}

/** @param {BoardShapeData|null|undefined} shape */
export function validBoardOutline(shape) {
    return shape?.layer === 'board-outline' && validClosedShape(shape, { minArea: 1e-6 });
}

/** @param {any} app @returns {any} */
export function boardBoundary(app) {
    const shape = getBoardOutline(app);
    const { width, height, radius } = boardDimensions(app);
    if (!shape) return { x: 0, y: -(height || 80),
        w: width || 100,
        h: height || 80,
        r: radius || 0, points: null };
    const points = shapeOutline(shape);
    const minX = Math.min(...points.map(point => point.x)), maxX = Math.max(...points.map(point => point.x));
    const minY = Math.min(...points.map(point => point.y)), maxY = Math.max(...points.map(point => point.y));
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY, r: 0, points };
}

/** @param {{pcbDocument: {syncBoardOutlineDimensions: () => void}}} app */
export function syncBoardOutlineDimensions(app) {
    app.pcbDocument.syncBoardOutlineDimensions();
}