import { beginPcbAnchorInteraction } from './selection-interaction.js';
import { findNearbyPad, resolveGridMagnetSnap } from './track-snap.js';
import { resolvePathPoint, resolvePathTranslation } from '../../shapes/path-snap.js';
import { setBoardShapeNodeFocus, setBoardShapeSegmentFocus } from './board-shape-state.js';
import { dismissContextMenu, showContextMenu } from '../../shared/ui/context-menu.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */
/** @typedef {{x: number, y: number}} Point */
/** @typedef {import('../../shared/ui/context-menu.js').MenuItem} MenuItem */
/** @typedef {import('../../shapes/path-snap.js').PathDragConstraint} PathDragConstraint */
/** @typedef {{id: string, x: number, y: number, [key: string]: unknown}} PathAnchor */
/** @typedef {{id: string, kind: string, object: any, locked?: boolean, getBounds: () => any, hitTest: (point: Point, tolerance?: number) => boolean, invalidate: () => void, beginAnchorDrag: (id: string|number|undefined, point: Point, options?: any) => boolean, updateAnchorDrag?: (point: Point) => void, endAnchorDrag?: (commit: boolean, options?: object) => void, getAnchors: () => PathAnchor[], clearEdit?: () => void}} PathAdapter Dynamic path adapters proxy different selectable model objects. */
export { pathMoveInteraction } from '../../shapes/path-interaction.js';

/**
 * @param {PcbEditor} app
 * @param {PathAdapter} adapter
 * @param {string} anchorId
 * @param {() => void} prepare
 */
export function beginPathSplit(app, adapter, anchorId, prepare) {
    const original = adapter.beginAnchorDrag;
    adapter.beginAnchorDrag = (id, point, options) => {
        const started = original(id, point, options);
        if (started) {
            prepare();
            if (adapter.kind === 'shape') {
                setBoardShapeNodeFocus(app, null);
                setBoardShapeSegmentFocus(app, null);
            } else if (adapter.kind === 'track') /** @type {() => void} */ (adapter.clearEdit)();
        }
        return started;
    };
    const anchor = adapter.getAnchors().find(item => item.id === anchorId);
    return !!anchor && beginPcbAnchorInteraction(app, adapter, anchor, anchor, true);
}

/**
 * @param {PcbEditor} app
 * @param {Point} point
 * @param {Point[]} [neighbours]
 * @param {boolean} [pads]
 * @param {Array<[Point, Point]>} [continuations]
 */
export function snapPathPoint(app, point, neighbours = [], pads = false, continuations = []) {
    if (app.viewport?.shiftHeld) return { x: point.x, y: point.y };
    const threshold = 8 / Math.max(0.01, app.viewport?.scale || 1);
    const pad = pads ? findNearbyPad(app, point, threshold) : null;
    if (pad) return { x: pad.x, y: pad.y };
    const { x, y } = resolveGridMagnetSnap(app, point);
    const grid = { x, y };
    return resolvePathPoint(point, neighbours, grid, threshold, null, continuations);
}

/**
 * Track paths pass `pads` to lock moved nodes onto pads; board shapes and fills do not.
 * @param {PcbEditor} app
 * @param {Point[]} points
 * @param {Point} delta
 * @param {Point[]} [neighbours]
 * @param {PathDragConstraint[]} [constraints]
 * @param {boolean} [pads]
 */
export function snapPathTranslation(app, points, delta, neighbours = [], constraints = [], pads = false) {
    if (app.viewport?.shiftHeld) return delta;
    const threshold = 8 / Math.max(0.01, app.viewport?.scale || 1);
    return resolvePathTranslation(points, delta, neighbours, constraints, threshold,
        pads ? (point, tolerance) => findNearbyPad(app, point, tolerance) : () => null,
        (point, fixed) => snapPathPoint(app, point, fixed));
}

/**
 * @param {{node?: boolean, segment?: boolean, curved?: boolean, standalone?: boolean, split?: (() => any)|null,
 *   deleteNode?: (() => any)|null, convert?: (() => any)|null, deleteSegment?: (() => any)|null,
 *   deleteObject?: (() => any)|null, label?: string}} actions
 */
export function pathContextActions({ node, segment, curved, standalone = false, split, deleteNode, convert, deleteSegment, deleteObject, label }) {
    if (node) return [
        split && { text: 'Split', onClick: split },
        deleteNode && { text: 'Delete node', onClick: deleteNode },
    ].filter(Boolean);
    return [
        segment && convert && { text: `Convert to ${curved ? 'Line' : 'Arc'}${standalone ? '' : ' Segment'}`, onClick: convert },
        segment && !standalone && deleteSegment && { text: 'Delete segment', onClick: deleteSegment },
        deleteObject && { text: `Delete ${label}`, onClick: deleteObject },
    ].filter(Boolean);
}

/** @param {string} id */
export function dismissPathContextMenu(id) {
    dismissContextMenu(id);
}

/**
 * @param {string} id
 * @param {MenuItem[]} items
 * @param {number} clientX
 * @param {number} clientY
 * @param {() => void} [refresh]
 */
export function showPathContextMenu(id, items, clientX, clientY, refresh = () => {}) {
    return showContextMenu(id, items, clientX, clientY, { onChosen: refresh });
}