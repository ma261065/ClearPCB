/**
 * Free-standing PCB board shapes: line, rectangle, polygon, arc and circle, stored as
 * plain objects in app.boardShapes; geometry-specific code dispatches on shape.kind.
 * This module owns their IDs, the edit profile pointer gestures use, the live previews
 * of edits (which copy is displayed while a Properties change, rotation or drag previews),
 * the selection adapter, handles and anchors, segment and node edits, deletion, the
 * context menu, the copper cuts removal shapes make and loading.
 *
 * Rendering is board-shape-render.js, the shape-drawing tools board-shape-draw.js,
 * dragging board-shape-drag.js, turning tracks into shapes and back
 * track-shape-conversion.js, and the Properties panel
 * board-shape-properties.js.
 *
 * Shape object shape:
 *   common: { id, kind:'line'|'rect'|'polygon'|'arc'|'circle', layer, lineWidth, filled, copperMode, plated }
 *   line:   + { points: [{x,y}, {x,y}] }   (open)
 *   rect:   + { cornerRadius }
 *   rect/polygon: + { points: [{x,y}, ...] }   (closed)
 *   arc:          + { start:{x,y}, end:{x,y}, bulge:{x,y} }
 *   circle:       + { x, y, radius }
 */
import { beginDragSession, releaseDragSession } from './drag-session.js';
import { bulgeRatio, distanceToSegment } from '../../core/geometry.js';
import { formatNumberInputValue } from '../../core/number-inputs.js';
import { pathHandleDescriptors } from '../../shapes/path-geometry.js';
import { remapPathNodes, splitPathSegmentMetadata, deletePathVertex, collapseCollinearPath, deletePathSegment, pointsFormAxisAlignedRect, setPathSegmentType, splitPathAtNode } from '../../shapes/path-operations.js';
import { validBoardOutline } from '../../shared/pcb/board-outline.js';
import { loadBoardShapeData, cloneShapeGeometry, applyShapeGeometry, applyShapeSnapshot, captureBoardShapeState as shapeSnapshot } from '../../core/pcb-board-shapes.js';
import { getBoardShapeNodeFocus, getBoardShapeSegmentFocus, getShapeDefaults, setBoardShapeNodeFocus, setBoardShapeSegmentFocus } from './board-shape-state.js';
import { isLayerVisible } from './layers.js';
import { boardShapeLocked, isPcbObjectLocked } from './object-locks.js';
import { RemoveBoardShapeCommand, MoveBoardShapeCommand, ModifyBoardShapeCommand } from './shape-commands.js';
import { CompoundCommand } from './track-commands.js';
import { redrawPropertyPreview, createPropertyBinding } from '../../shapes/property-preview.js';
import {
    boundsWithPathNodes,
    getPcbSelection,
    getPcbSelectionEntries,
    hitTestPcbSelection,
    isPcbSelected,
    registerPcbSelectionAdapter,
    setPcbSelection,
    syncPcbSelection,
} from './selection-registry.js';
import { clearPcbSelectionAnchors, lockPositionOutsideOutline, renderPcbSelectionAnchors } from './selection-anchors.js';
import { appendSegmentSelection } from '../../core/ui-helpers.js';
import { beginPcbAnchorInteraction, finishSelectionInteraction, setSelectionInteraction } from './selection-interaction.js';
import { pathMoveInteraction, beginPathSplit, pathContextActions, showPathContextMenu, dismissPathContextMenu } from './path-edit.js';
import { cancelPictureCopperRefresh, isShapeClearancePending, schedulePictureCopperRefresh } from './picture-refresh.js';
import { beginRotationHandleDrag, endRotationHandleDrag, isRotationHandleDragActive, rotationHandleAnchor, pointerRotation, rotatedImagePoints } from './rotation-handle.js';
import { BULGE_EPS, arcFromBulge } from '../../shapes/arc-edge.js';
import { syncBoardOutlineDimensions } from '../../shared/pcb/board-outline.js';
import { getPropertyEditor, releasePropertyEditor, setPropertyEditor } from './property-editors.js';
import { isPictureCopperRefreshPending } from './refresh-state.js';
import { normalizeShapeCopperMode, rectCornerRadius, polygonCornerRadius, circleOutline, circleFilledRadius, boardShapeSegmentBulge, shapeOutline, boardShapeStrokeSegments, boardShapeRemovalPathD, boardShapeBounds, boardShapeHitTest, shapePathD, boardShapeSegmentWidth, resolveBoardShapeGeometry } from '../../shared/pcb/board-shape-geometry.js';
import { showBoardShapeProperties, syncBoardShapePanel, syncCircleDiameterProperty } from './board-shape-properties.js';
import { isEditorActive } from './pcb-editor-api.js';
import { removeBoardShapeElement, renderBoardShape, shapeSelectionColor } from './board-shape-render.js';
import { applyBoardShapeVertexResize, endBoardShapeDrag, getBoardShapeDrag, handleBoardShapeDrag, hitTestBoardShapeVertex, polygonSegmentIndexAt, startBoardShapeDrag } from './board-shape-drag.js';
import { addBoardShapeOrTrackCommand } from './track-shape-conversion.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */
/** @typedef {import('./pcb-editor-api.js').PcbBoard} PcbBoard */
/** @typedef {import('../../core/geometry.js').Point} Point */
/** @typedef {import('../../core/pcb-board-shapes.js').BoardShape} BoardShape */
/** @typedef {import('../../core/pcb-board-shapes.js').BoardPathShape} BoardPathShape */
/** @typedef {import('../../core/pcb-board-shapes.js').BoardShapeGeometry} BoardShapeGeometry */
/** @typedef {import('../../core/pcb-board-shapes.js').BoardShapeSnapshot} BoardShapeSnapshot */
/** @typedef {Record<string, any>} BoardShapeEditProfile */
/** @typedef {import('./board-shape-drag.js').BoardShapeDrag} BoardShapeDrag */
/** @typedef {import('./board-shape-render.js').BoardShapeRenderOptions} BoardShapeRenderOptions */

const NS = 'http://www.w3.org/2000/svg';
const boardShapeRotationPreviews = new WeakMap();
const boardShapePropertyPreviews = new WeakMap();

/** @param {PcbEditor} app */
function boardShapeIdDocument(app) {
    return app.pcbDocument;
}

/** @param {PcbEditor} app */
export function nextBoardShapeId(app) {
    return `pshape_${boardShapeIdDocument(app).shapeIdCounter++}`;
}

/** @param {PcbEditor} app */
function peekBoardShapeId(app) {
    return `pshape_${boardShapeIdDocument(app).shapeIdCounter}`;
}

/**
 * @param {PcbEditor} app
 * @param {number} value
 */
function setBoardShapeIdCounter(app, value) {
    boardShapeIdDocument(app).shapeIdCounter = value;
}

/** @returns {BoardShapeEditProfile} */
function boardShapeEditProfile() {
    return {
        kind: 'shape',
        editorKey: 'boardShape',
        missingEditMessage: 'Cannot edit a missing board shape.',
        missingDragMessage: 'Cannot finish a drag of a missing board shape.',
        canonical: canonicalBoardShape,
        displayed: displayedBoardShape,
        /** @param {PcbEditor} app */
        collection: app => app.pcbDocument?.boardShapes || app.boardShapes,
        copy: copyBoardShape,
        capture: shapeSnapshot,
        /**
         * @param {PcbEditor} _app
         * @param {BoardShape|null} shape
         */
        canEdit: (_app, shape) => !!shape && !boardShapeLocked(shape) && isLayerVisible(shape.layer),
        getNodeFocus: getBoardShapeNodeFocus,
        getSegmentFocus: getBoardShapeSegmentFocus,
        setNodeFocus: setBoardShapeNodeFocus,
        setSegmentFocus: setBoardShapeSegmentFocus,
        /** @param {PcbEditor} app */
        clearFocus(app) {
            setBoardShapeNodeFocus(app, null);
            setBoardShapeSegmentFocus(app, null);
        },
        /**
         * @param {PcbEditor} app
         * @param {BoardShape} shape
         */
        remove(app, shape) { removeBoardShapeElement(app, shape.id); },
        /**
         * @param {PcbEditor} app
         * @param {BoardShape} shape
         * @param {BoardShapeRenderOptions} [opts]
         */
        render(app, shape, opts = {}) { renderBoardShape(app, shape, opts); },
        /**
         * @param {PcbEditor} app
         * @param {BoardShape} shape
         */
        renderHandles(app, shape) { renderBoardShapeHandles(app, shape); },
        /** @param {PcbEditor} app */
        renderSegmentSelection(app) { renderBoardShapeSegmentSelection(app); },
        /**
         * @param {PcbEditor} app
         * @param {BoardShape} shape
         */
        showProperties(app, shape) { showBoardShapeProperties(app, shape); },
        /**
         * @param {PcbEditor} app
         * @param {BoardShape} shape
         */
        refreshProperties(app, shape) { showBoardShapeProperties(app, shape); },
        /**
         * Update the open panel's values in place during a drag.
         * @param {PcbEditor} app
         * @param {BoardShape} shape
         */
        syncProperties(app, shape) { syncBoardShapePanel(app, shape); },
        /**
         * @param {PcbEditor} app
         * @param {BoardShape[]} changed
         * @param {boolean} liveDrag
         */
        propertyPreviewRender(app, changed, liveDrag) {
            for (const target of changed) renderBoardShape(app, target, {
                liveDrag, skipCopperUpdate: target.kind === 'image' && !target.layer.endsWith('copper'),
            });
        },
        /**
         * @param {PcbEditor} app
         * @param {BoardShape} target
         */
        propertyPreviewPrepare(app, target) {
            if (target.kind !== 'image' || target.layer.endsWith('copper')) schedulePictureCopperRefresh(app, target);
        },
        /**
         * @param {PcbEditor} app
         * @param {BoardShape[]} originals
         * @param {Record<string, any>} preview
         */
        propertyPreviewCancel(app, originals, preview) {
            for (const original of originals) {
                if (this.collection(app).includes(original)) {
                    if (isShapeClearancePending(app, original)) schedulePictureCopperRefresh(app, original);
                    renderBoardShape(app, original, {
                        liveDrag: true, skipCopperUpdate: original.kind === 'image' && !original.layer.endsWith('copper'),
                    });
                } else removeBoardShapeElement(app, original.id);
            }
            if (originals.some(shape => shape.kind !== 'image' || shape.layer.endsWith('copper'))) {
                cancelPictureCopperRefresh(app);
                if (preview.previousPictureRefreshPending) schedulePictureCopperRefresh(app);
            }
            syncPcbSelection(app);
            renderBoardShapeSegmentSelection(app);
            renderPcbSelectionAnchors(app);
        },
        /**
         * @param {PcbEditor} app
         * @param {BoardShape} original
         * @param {BoardShapeSnapshot} beforeState
         * @param {BoardShapeSnapshot} afterState
         * @param {BoardShape} previewShape
         * @param {BoardShapeDrag} drag
         */
        makeCommand(app, original, beforeState, afterState, previewShape, drag) {
            const after = cloneShapeGeometry(previewShape);
            const metadataChanged = ['kind', 'segmentWidths', 'segmentBulges', 'nodeCornerRadii'].some(
                key => JSON.stringify(afterState[key]) !== JSON.stringify(beforeState[key]));
            return drag.splitBeforeState || metadataChanged || after.points?.length !== drag.before.points?.length
                ? new ModifyBoardShapeCommand(app, original, beforeState, afterState)
                : new MoveBoardShapeCommand(app, original, drag.before, after);
        },
        /**
         * @param {PcbEditor} app
         * @param {BoardShape} original
         * @param {BoardShapeSnapshot} beforeState
         * @param {BoardShapeSnapshot} afterState
         */
        modifyCommand(app, original, beforeState, afterState) {
            return new ModifyBoardShapeCommand(app, original, beforeState, afterState);
        },
        /**
         * @param {PcbEditor} app
         * @param {BoardShape} shape
         */
        removeCommand(app, shape) { return new RemoveBoardShapeCommand(app, shape); },
        /**
         * @param {PcbEditor} _app
         * @param {BoardShape} shape
         */
        valid(_app, shape) { return shape.layer !== 'board-outline' || validBoardOutline(shape); },
        /**
         * The nets whose ratlines follow the shape while it is dragged: its own, if it is net copper.
         * @param {BoardShape} shape
         */
        dragRatsnestNets(shape) {
            const net = String(shape.net || '');
            return net && (shape.layer === 'top-copper' || shape.layer === 'bottom-copper')
                && normalizeShapeCopperMode(shape.copperMode) === 'add' ? new Set([net]) : null;
        },
        /**
         * @param {PcbEditor} app
         * @param {BoardShape} original
         * @param {boolean} committed
         * @param {BoardShapeDrag} drag
         */
        afterCommit(app, original, committed, drag) {
            if (drag.session?.nets) app.updateRatsnest({ nets: drag.session.nets, skipFillRefresh: !committed });
            if (original && this.collection(app).includes(original)) {
                renderBoardShapeHandles(app, original);
                renderBoardShapeSegmentSelection(app);
                syncBoardShapePanel(app, original);
            }
        },
    };
}

/** @param {BoardShapeEditProfile|null|undefined} profile */
export function editProfile(profile) {
    return profile || boardShapeEditProfile();
}

/** @param {BoardShapeDrag|null|undefined} drag */
export function dragProfile(drag) {
    return editProfile(drag?.editProfile);
}

/** @param {PcbEditor} app */
export function getBoardShapePropertyPreview(app) {
    return boardShapePropertyPreviews.get(app);
}

/** @param {PcbEditor} app */
export function getBoardShapeRotationPreview(app) {
    return boardShapeRotationPreviews.get(app);
}

/**
 * @param {PcbEditor} app
 * @param {BoardShape|null} shape
 */
export function canonicalBoardShape(app, shape) {
    shape = boardShapePropertyPreviews.get(app)?.originalsByCopy.get(shape) || shape;
    const drag = getBoardShapeDrag(app);
    if (drag?.shape === shape) return drag.original;
    const preview = boardShapeRotationPreviews.get(app);
    return preview && preview.shape === shape ? preview.original : shape;
}

/**
 * @param {PcbEditor} app
 * @param {BoardShape|null} shape
 */
export function displayedBoardShape(app, shape) {
    shape = boardShapePropertyPreviews.get(app)?.copiesByOriginal.get(shape) || shape;
    const drag = getBoardShapeDrag(app);
    if (drag && (drag.original === shape || drag.shape === shape)) return drag.shape;
    const preview = boardShapeRotationPreviews.get(app);
    return preview && (preview.original === shape || preview.shape === shape) ? preview.shape : shape;
}

/** @param {PcbEditor} app */
export function getBoardShapePointerPreview(app) {
    return getBoardShapeDrag(app)?.preview;
}

/** @param {BoardShape} shape */
export function copyBoardShape(shape) {
    const copy = { ...shape };
    applyShapeGeometry(copy, cloneShapeGeometry(shape));
    for (const key of ['nodeCornerRadii', 'segmentWidths', 'segmentBulges']) {
        const source = /** @type {Record<string, BoardShapeSnapshot[keyof BoardShapeSnapshot]>} */ (shape);
        const target = /** @type {Record<string, BoardShapeSnapshot[keyof BoardShapeSnapshot]>} */ (copy);
        if (source[key]) target[key] = { .../** @type {object} */ (source[key]) };
    }
    return copy;
}

/**
 * @param {PcbEditor} app
 * @param {BoardShapeDrag} drag
 */
export function beginBoardShapePointerPreview(app, drag) {
    if (!drag.preview) {
        const profile = dragProfile(drag);
        const originals = profile.collection(app);
        if (!originals.includes(drag.original)) {
            endBoardShapeDrag(app, false);
            throw new Error(profile.missingEditMessage);
        }
        drag.shape = profile.copy(drag.original);
        drag.preview = { boardShapes: originals.map(/** @param {BoardShape} shape */ shape => shape === drag.original ? drag.shape : shape) };
    }
    return drag.shape;
}

/**
 * Release displayed geometry before handing the canonical image to history.
 * @param {PcbEditor} app
 */
export function finishBoardShapeRotationPreview(app, commit = false) {
    const preview = boardShapeRotationPreviews.get(app);
    if (!preview) return false;
    boardShapeRotationPreviews.delete(app);
    endRotationHandleDrag(app);
    const { original, shape, before } = preview;
    const present = app.pcbDocument.boardShapes.includes(original);
    let committed = false;
    try {
        if (commit && !present) throw new Error('Cannot rotate a missing board shape.');
        if (commit && isLayerVisible(original.layer) && !boardShapeLocked(original) && shape !== original) {
            const after = shapeSnapshot(shape);
            if (JSON.stringify(before) !== JSON.stringify(after)) {
                schedulePictureCopperRefresh(app, original);
                app.history.execute(new ModifyBoardShapeCommand(app, original, before, after));
                committed = true;
            }
        }
    } finally {
        if (!present) {
            removeBoardShapeElement(app, original.id);
            if (shape !== original) cancelPictureCopperRefresh(app);
        } else if (shape !== original && !committed) {
            schedulePictureCopperRefresh(app, original);
            renderBoardShape(app, original, { liveDrag: true });
            cancelPictureCopperRefresh(app);
            showBoardShapeProperties(app, original);
        }
        if (!present || shape !== original) renderPcbSelectionAnchors(app);
        const input = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropImageRot'));
        if (input && present) {
            const points = original.points;
            const rotation = ((-Math.atan2(points[1].y - points[0].y,
                points[1].x - points[0].x) * 180 / Math.PI) % 360 + 360) % 360;
            input.value = String(Math.round(rotation) % 360);
        }
    }
    return committed;
}

/**
 * Round to 4 dp for compact, stable path/serialisation output.
 * @param {number} n
 */
const r4 = (n) => Math.round(n * 10000) / 10000;

/**
 * Human-friendly title for the Properties panel.
 * @param {string} kind
 */
export function shapeKindLabel(kind) {
    return kind === 'image' ? 'Image' : kind === 'line' ? 'Line'
        : kind === 'rect' ? 'Rectangle'
        : kind === 'polygon' ? 'Polygon'
            : kind === 'arc' ? 'Arc'
                : kind === 'circle' ? 'Circle'
                : 'Shape';
}

// â”€â”€ Geometry â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Keep PCB kinds in lockstep with the schematic Polyline topology.
 * @param {BoardShape} shape
 */
export function normalizeBoardPolylineKind(shape) {
    if (!shape || shape.kind !== 'line' && shape.kind !== 'polygon' && shape.kind !== 'rect') return false;
    const points = shape.points || [];
    const before = shape.kind;
    if (shape.kind === 'line') {
        shape.filled = false;
    } else if (points.length <= 2) {
        /** @type {import('../../core/pcb-board-shapes.js').BoardShapeBase} */ (shape).kind = 'line';
        shape.filled = false;
        /** @type {import('../../core/pcb-board-shapes.js').BoardShapeBase} */ (shape).cornerRadius = undefined;
    } else if (pointsFormAxisAlignedRect(points) && !Object.values(shape.segmentBulges || {}).some(value => Math.abs(value) >= BULGE_EPS)) {
        /** @type {import('../../core/pcb-board-shapes.js').BoardShapeBase} */ (shape).kind = 'rect';
        shape.cornerRadius = Math.max(0, Number(shape.cornerRadius) || 0);
    } else {
        /** @type {import('../../core/pcb-board-shapes.js').BoardShapeBase} */ (shape).kind = 'polygon';
        shape.cornerRadius = Math.max(0, Number(shape.cornerRadius) || 0);
    }
    return shape.kind !== before;
}

/**
 * @param {BoardShape} shape
 * @param {number} index
 * @param {number} radius
 */
export function setBoardShapeNodeCornerRadius(shape, index, radius) {
    if (!['line', 'rect', 'polygon'].includes(shape?.kind) || !shape.points?.[index]) return;
    const fallback = shape.kind === 'rect' ? rectCornerRadius(shape) : polygonCornerRadius(shape);
    const value = Math.max(0, Number(radius) || 0);
    shape.nodeCornerRadii ||= {};
    if (Math.abs(value - fallback) < 1e-9) delete shape.nodeCornerRadii[index];
    else shape.nodeCornerRadii[index] = value;
}

/**
 * @param {BoardShape} shape
 * @param {number|null} [segment]
 */
export function editableShapeBulge(shape, segment = null) {
    return shape.kind === 'arc'
        ? Math.max(-1, Math.min(1, bulgeRatio(shape.start, shape.end, shape.bulge)))
        : segment == null ? 0 : boardShapeSegmentBulge(shape, segment);
}

/**
 * @param {BoardShape} shape
 * @param {number|null} [segment]
 */
export function normalizeStraightArc(shape, segment = null) {
    if (Math.abs(editableShapeBulge(shape, segment)) >= BULGE_EPS) return;
    if (shape.kind === 'arc') {
        const points = [shape.start, shape.end];
        /** @type {import('../../core/pcb-board-shapes.js').BoardShapeBase} */ (shape).kind = 'line';
        shape.filled = false;
        applyShapeGeometry(shape, { points });
    } else if (segment != null && shape.segmentBulges) {
        delete shape.segmentBulges[segment];
    }
}

/**
 * Translate a geometry snapshot without changing its dimensions or curvature.
 * @param {BoardShapeGeometry} geom
 * @param {number} dx
 * @param {number} dy
 */
export function translateShapeGeometry(geom, dx, dy) {
    if (geom.points) {
        return { points: geom.points.map(/** @param {Point} p */ (p) => ({ x: p.x + dx, y: p.y + dy })) };
    }
    if ('radius' in geom) {
        const circle = /** @type {{x:number, y:number, radius:number}} */ (geom);
        return { x: circle.x + dx, y: circle.y + dy, radius: circle.radius };
    }
    const arc = /** @type {{start: Point, end: Point, bulge: Point}} */ (geom);
    return {
        start: { x: arc.start.x + dx, y: arc.start.y + dy },
        end: { x: arc.end.x + dx, y: arc.end.y + dy },
        bulge: { x: arc.bulge.x + dx, y: arc.bulge.y + dy },
    };
}

// â”€â”€ Render â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * @param {PcbEditor} app
 * @param {BoardShape[]} targets
 * @param {{liveDrag?: boolean, editProfile?: BoardShapeEditProfile|null}} [options]
 */
function redrawBoardShapePropertyPreview(app, targets, { liveDrag = false, editProfile: profileArg = null } = {}) {
    const profile = editProfile(profileArg);
    redrawPropertyPreview(targets, {
        prepare: /** @param {BoardShape} target */ target => profile.propertyPreviewPrepare?.(app, target),
        render: /** @param {BoardShape[]} changed */ changed => {
            profile.propertyPreviewRender(app, changed, liveDrag);
        },
        refreshSelection: () => {
            profile.renderSegmentSelection(app);
            app.refreshSelectionHighlights();
        },
        refreshDerived() {},
    });
}

/**
 * @param {PcbEditor} app
 * @param {BoardShapeEditProfile|null} [profileArg]
 */
export function createBoardShapePropertyBinding(app, profileArg = null) {
    const profile = editProfile(profileArg);
    getPropertyEditor(app, profile.editorKey)?.dispose();
    const binding = createPropertyBinding({
        beforeActivate() {
            const drag = getBoardShapeDrag(app);
            if (drag && dragProfile(drag).editorKey === profile.editorKey) endBoardShapeDrag(app, true);
            if (getBoardShapeRotationPreview(app)) finishBoardShapeRotationPreview(app, true);
        },
        onDispose() {
            releasePropertyEditor(app, profile.editorKey, binding);
        },
    });
    /** @param {string} layer */
    binding.affectsLayer = layer =>
        boardShapePropertyPreviews.get(app)?.editorKey === profile.editorKey
        && boardShapePropertyPreviews.get(app)?.originals.some(/** @param {BoardShape} shape */ shape => shape.layer === layer) || false;
    setPropertyEditor(app, profile.editorKey, binding);
    return binding;
}

/**
 * @param {PcbEditor} app
 * @param {any[]} targets
 * @param {{liveDrag?: boolean, beforeCommit?: (copies: any[]) => boolean|void, editProfile?: any}} [options]
 */
export function createBoardShapePropertyPreview(app, targets, { liveDrag = false, beforeCommit = () => false, editProfile: profileArg = null } = {}) {
    const profile = editProfile(profileArg);
    const binding = /** @type {ReturnType<typeof createBoardShapePropertyBinding>} */ (getPropertyEditor(app, profile.editorKey));
    const originals = targets.map(target => profile.canonical(app, target));
    const collection = () => profile.collection(app);
    const editable = () => !binding.disposed && isEditorActive(app)
        && originals.every(shape => profile.canEdit(app, shape));
    /** @type {Record<string, any>|null} */
    let state = null;
    /**
     * @param {boolean} commit
     * @param {{rebuild?: boolean}} [options]
     */
    const finish = (commit, { rebuild = true } = {}) => {
        if (!state) return false;
        const preview = state;
        state = null;
        binding.release(control);
        if (boardShapePropertyPreviews.get(app)?.editorKey === profile.editorKey) boardShapePropertyPreviews.delete(app);
        releaseDragSession(app, preview.session);
        let committed = false;
        try {
            if (commit && originals.some(shape => !collection().includes(shape))) {
                throw new Error(profile.missingEditMessage);
            }
            const canCommit = commit && editable();
            if (canCommit) rebuild = beforeCommit(preview.copies) || rebuild;
            if (canCommit && preview.copies.every(/** @param {BoardShape} shape */ shape => profile.valid(app, shape))) {
                const after = preview.copies.map(profile.capture);
                const commands = originals.flatMap((target, index) => JSON.stringify(preview.before[index]) === JSON.stringify(after[index])
                    ? [] : [profile.modifyCommand(app, target, preview.before[index], after[index])]);
                if (commands.length) {
                    if (originals.some((shape, index) => getBoardShapeSegmentFocus(app)?.shapeId === shape.id
                        && shape.points?.length !== preview.copies[index].points?.length)) {
                        setBoardShapeSegmentFocus(app, null);
                    }
                    binding.committing = true;
                    try {
                        app.history.execute(commands.length === 1 ? commands[0] : new CompoundCommand(commands));
                        committed = true;
                    } finally { binding.committing = false; }
                }
            }
        } finally {
            if (!committed) profile.propertyPreviewCancel(app, originals, preview);
        }
        if (committed && rebuild) profile.showProperties(app, originals[0]);
        return committed;
    };
    /** @type {import('../../shapes/property-preview.js').PropertyPreview & Record<string, any>} */
    const control = {
        get active() { return !!state; },
        /** @param {(before: BoardShapeSnapshot[], copies: BoardShape[]) => void} mutate */
        update(mutate) {
            if (!editable()) { control.cancel(); return; }
            if (!state) {
                if (!binding.activate(control)) return;
                if (originals.some(shape => !collection().includes(shape))) {
                    binding.release(control);
                    binding.dispose();
                    for (const original of originals) {
                        if (!collection().includes(original)) profile.remove(app, original);
                    }
                    syncPcbSelection(app);
                    renderPcbSelectionAnchors(app);
                    throw new Error(profile.missingEditMessage);
                }
                const copies = originals.map(profile.copy);
                const copiesByOriginal = new Map(originals.map((original, index) => [original, copies[index]]));
                state = {
                    originals, copies, copiesByOriginal, editorKey: profile.editorKey,
                    originalsByCopy: new Map(copies.map((copy, index) => [copy, originals[index]])),
                    before: originals.map(profile.capture),
                    previousPictureRefreshPending: !!isPictureCopperRefreshPending(app),
                    boardShapes: collection().map(/** @param {BoardShape} shape */ shape => copiesByOriginal.get(shape) || shape),
                    session: beginDragSession(app),
                };
                boardShapePropertyPreviews.set(app, state);
            }
            try {
                mutate(state.before, state.copies);
                redrawBoardShapePropertyPreview(app, state.copies, { liveDrag, editProfile: profile });
            } catch (error) {
                control.cancel();
                throw error;
            }
        },
        /** @param {{rebuild?: boolean}} [options] */
        commit(options) { return finish(true, options); },
        cancel() {
            if (!state) return false;
            finish(false);
            return true;
        },
    };
    return control;
}

// â”€â”€ Hit-test / hover / selection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * @param {PcbEditor} app
 * @param {Point|null} worldPos
 */
export function hitTestBoardShape(app, worldPos) {
    return worldPos ? hitTestPcbSelection(app, worldPos, 'shape') : null;
}

/**
 * @param {PcbEditor} app
 * @param {BoardShape|null} shape
 */
export function selectBoardShape(app, shape) {
    shape = canonicalBoardShape(app, shape);
    const properties = boardShapePropertyPreviews.get(app);
    if (properties && !properties.originals.includes(shape)) getPropertyEditor(app, 'boardShape')?.dispose();
    const drag = getBoardShapeDrag(app);
    if (drag && drag.original !== shape) endBoardShapeDrag(app, false);
    const rotation = boardShapeRotationPreviews.get(app);
    if (rotation && rotation.original !== shape) {
        if (!finishSelectionInteraction(app, false)) finishBoardShapeRotationPreview(app);
    }
    const previousShapes = getPcbSelection(app, 'shape');
    const prev = previousShapes[0] || null;
    const next = shape || null;
    if (prev === next || (prev && next && prev.id === next.id)) return;
    setBoardShapeSegmentFocus(app, null);
    setBoardShapeNodeFocus(app, null);
    if (next && !isPcbSelected(app, 'shape', next)) {
        setPcbSelection(app, [{ kind: 'shape', object: next }]);
    } else if (!next) {
        setPcbSelection(app, getPcbSelectionEntries(app).filter(/** @param {{kind: string}} entry */ entry => entry.kind !== 'shape'));
    }
    app.syncClipboardButtons();
    for (const previous of previousShapes) {
        if (app.boardShapes.includes(previous)) renderBoardShape(app, previous);
    }
    if (next) renderBoardShape(app, next);
    clearBoardShapeHandles(app);
    if (next) renderBoardShapeHandles(app, next);
    renderBoardShapeSegmentSelection(app);
    app.setPcbStatus();
}

// â”€â”€ Resize handles â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** @param {BoardShape} shape */
export function shapeHandlePoints(shape) {
    if (shape.kind === 'arc') {
        return [
            { key: 'start', ...shape.start },
            { key: 'end', ...shape.end },
            { key: 'bulge', ...shape.bulge },
        ];
    }
    if (shape.kind === 'circle') {
        return [
            { key: 'center', x: shape.x, y: shape.y, cursor: 'move' },
            { key: 'radius', x: shape.x + circleFilledRadius(shape), y: shape.y, cursor: 'ew-resize' },
        ];
    }
    return boardPathHandles(shape).filter(anchor => !anchor.midpoint).map(anchor => ({ ...anchor, key: anchor.id }));
}

/** @param {BoardShape} shape */
function boardPathHandles(shape) {
    const points = shape.points || [];
    const count = shape.kind === 'line' ? points.length - 1 : points.length;
    const edges = shape.kind !== 'line' && shape.kind !== 'polygon' && shape.kind !== 'rect' ? [] : points.slice(0, count).map((start, id) => ({
        id, start, end: points[(id + 1) % points.length], bulge: boardShapeSegmentBulge(shape, id),
    }));
    return pathHandleDescriptors(/** @type {any} */ (points.map((point, id) => ({ id, ...point }))), /** @type {any} */ (edges),
        id => `mid:${id}`, id => `bulge:${id}`, (shape.kind === 'line' || shape.kind === 'polygon'));
}

/**
 * Midpoint insertion handles belong to editable open and closed polylines.
 * @param {BoardShape} shape
 */
function shapeMidpointHandles(shape) {
    return boardPathHandles(shape).filter(anchor => anchor.midpoint).map(anchor => ({ ...anchor, key: anchor.id }));
}

/**
 * Anchors exposed through the common PCB selection adapter contract.
 * @param {BoardShape} shape
 */
export function getBoardShapeAnchors(shape) {
    const vertices = shapeHandlePoints(shape).map((anchor) => ({
        ...anchor,
        id: anchor.key,
        cursor: /** @type {{cursor?: string}} */ (anchor).cursor || 'nwse-resize',
        round: anchor.key === 'bulge' || String(anchor.key).startsWith('bulge:'),
        fill: anchor.key === 'bulge' || String(anchor.key).startsWith('bulge:') ? '#33dd77' : '#ffffff',
    }));
    const midpoints = shapeMidpointHandles(shape).map((anchor) => ({
        ...anchor,
        id: anchor.key,
        round: true,
        fill: '#ffffff',
        symbol: 'plus',
    }));
    return [...vertices, ...midpoints];
}

/**
 * Move one anchor through the existing geometry and rendering path.
 * @param {PcbEditor} app
 * @param {BoardShape} shape
 * @param {number|string} anchorId
 * @param {Point} worldPos
 */
export function moveBoardShapeAnchor(app, shape, anchorId, worldPos) {
    const before = cloneShapeGeometry(shape);
    const snap = app.snapToGrid(worldPos);
    applyBoardShapeVertexResize(shape, { before, handle: anchorId }, snap);
    if (shape.layer === 'board-outline') syncBoardOutlineDimensions(app);
    schedulePictureCopperRefresh(app, shape);
    renderBoardShape(app, shape, { liveDrag: true });
    syncCircleDiameterProperty(app, shape);
}

/**
 * Full SelectionManager adapter for rectangle, polygon, and arc objects.
 * @param {PcbEditor} app
 * @param {BoardShape} shape
 * @param {string} id
 * @param {BoardShapeEditProfile|null} [profileArg]
 * @returns {import('./selection-registry.js').SelectionAdapter}
 */
export function createBoardShapeSelectionAdapter(app, shape, id, profileArg = null) {
    const profile = editProfile(profileArg);
    shape = profile.canonical(app, shape);
    const displayed = () => profile.displayed(app, shape);
    return {
        id,
        kind: profile.kind,
        get object() { return displayed(); },
        get visible() { return profile.visible ? profile.visible(app, shape) : isLayerVisible(shape.layer); },
        get locked() { return profile.locked ? profile.locked(app, shape) : isPcbObjectLocked(app, profile.kind, shape); },
        /**
         * @param {Point} pointer
         * @param {number} scale
         */
        getLockPosition(pointer, scale) {
            if (profile.getLockPosition) return profile.getLockPosition(app, displayed(), pointer, scale);
            const shape = displayed();
            const geometry = resolveBoardShapeGeometry(shape);
            if ((shape.kind === 'rect' || shape.kind === 'polygon') && geometry.physicalContours?.length) {
                return lockPositionOutsideOutline(
                    geometry.physicalContours,
                    pointer,
                    scale,
                );
            }
            const strokedCenterline = (shape.kind === 'line' || shape.kind === 'arc');
            if (strokedCenterline) {
                const segments = boardShapeStrokeSegments(shape);
                return lockPositionOutsideOutline(
                    segments.map(segment => [segment.start, segment.end]),
                    pointer,
                    scale,
                    false,
                    segments.map(segment => segment.lineWidth / 2),
                );
            }
            return lockPositionOutsideOutline(
                shapeOutline(shape),
                pointer,
                scale,
                true,
            );
        },
        getBounds() { return profile.getBounds ? profile.getBounds(app, displayed()) : boardShapeBounds(displayed()); },
        getHitBounds() {
            const shape = displayed();
            const bounds = profile.getBounds ? profile.getBounds(app, shape) : boardShapeBounds(shape);
            return (shape.kind === 'line' || shape.kind === 'rect' || shape.kind === 'polygon') && isPcbSelected(app, profile.kind, shape)
                ? boundsWithPathNodes(bounds, shape.points) : bounds;
        },
        /**
         * @param {Point} point
         * @param {number} tolerance
         */
        hitTest(point, tolerance) {
            const shape = displayed();
            if (profile.hitTest) return profile.hitTest(app, shape, point, tolerance);
            if (boardShapeHitTest(shape, point, tolerance)) return true;
            if (!isPcbSelected(app, profile.kind, shape) || shape.kind !== 'line' && shape.kind !== 'rect' && shape.kind !== 'polygon') return false;
            const points = shape.points || [];
            const count = shape.kind === 'line' ? points.length - 1 : points.length;
            return points.slice(0, count).some(/** @param {Point} start @param {number} index */ (start, index) =>
                distanceToSegment(point, start, points[(index + 1) % points.length]) <= tolerance);
        },
        getEditPath() {
            const shape = displayed();
            if (profile.getEditPath) return profile.getEditPath(app, shape);
            if (profile.getNodeFocus(app)?.shapeId === shape.id) return '';
            return shapePathD({ ...shape, cornerRadius: 0, nodeCornerRadii: {} });
        },
        getAnchors() {
            const shape = displayed();
            const nodeFocus = profile.getNodeFocus(app);
            const anchors = getBoardShapeAnchors(shape).map(anchor => ({ ...anchor,
                selected: nodeFocus?.shapeId === shape.id
                    && nodeFocus.index === anchor.id,
            }));
            return shape.kind === 'image'
                ? [...anchors, rotationHandleAnchor(boardShapeBounds(shape), app.viewport?.scale ?? 1)] : anchors;
        },
        /**
         * @param {number|string} anchorId
         * @param {number} x
         * @param {number} y
         */
        moveAnchor(anchorId, x, y) { moveBoardShapeAnchor(app, shape, anchorId, { x, y }); },
        /**
         * @param {number|string} anchorId
         * @param {Point} worldPos
         */
        beginAnchorDrag(anchorId, worldPos) {
            if (anchorId !== 'rotate' || shape.kind !== 'image') return startBoardShapeDrag(app, shape, worldPos, anchorId, { editProfile: profile });
            getPropertyEditor(app, 'boardShape')?.commit();
            if (boardShapeLocked(shape) || !isLayerVisible(shape.layer)) return false;
            if (!!getBoardShapeRotationPreview(app) || isRotationHandleDragActive(app) || getBoardShapeDrag(app)) {
                throw new Error('Finish the current shape preview before rotating an image.');
            }
            if (!app.pcbDocument.boardShapes.includes(shape)) throw new Error('Cannot rotate a missing board shape.');
            const center = { x: (shape.points[0].x + shape.points[2].x) / 2,
                y: (shape.points[0].y + shape.points[2].y) / 2 };
            const rotation = ((-Math.atan2(shape.points[1].y - shape.points[0].y,
                shape.points[1].x - shape.points[0].x) * 180 / Math.PI) % 360 + 360) % 360;
            const before = shapeSnapshot(shape);
            boardShapeRotationPreviews.set(app, {
                original: shape, shape, before, points: before.geom.points,
                center, start: { ...worldPos }, rotation, currentRotation: rotation,
            });
            beginRotationHandleDrag(app);
            return true;
        },
        /** @param {Point} worldPos */
        updateAnchorDrag(worldPos) {
            const rotationDrag = boardShapeRotationPreviews.get(app);
            if (!rotationDrag || rotationDrag.original !== shape) return handleBoardShapeDrag(app, worldPos);
            const { center, start, rotation, points } = rotationDrag;
            const next = pointerRotation(center, start, worldPos, rotation);
            if (next === rotationDrag.currentRotation) return;
            if (!rotationDrag.boardShapes) {
                if (!app.pcbDocument.boardShapes.includes(shape)) {
                    if (!finishSelectionInteraction(app, false)) finishBoardShapeRotationPreview(app);
                    throw new Error('Cannot rotate a missing board shape.');
                }
                rotationDrag.shape = { ...shape };
                rotationDrag.boardShapes = app.pcbDocument.boardShapes.map(
                    original => original === shape ? rotationDrag.shape : original);
            }
            const displayed = rotationDrag.shape;
            displayed.points = next === rotation
                ? points.map(/** @param {Point} point */ point => ({ ...point }))
                : rotatedImagePoints(points, center, next - rotation);
            schedulePictureCopperRefresh(app, displayed);
            renderBoardShape(app, displayed, { liveDrag: true });
            const input = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropImageRot'));
            if (input) input.value = String(Math.round(next) % 360);
            rotationDrag.currentRotation = next;
        },
        /**
         * @param {boolean} commit
         * @param {{moved?: boolean, place?: boolean}} [options]
         */
        endAnchorDrag(commit, options = {}) {
            if (boardShapeRotationPreviews.get(app)?.original === shape) return finishBoardShapeRotationPreview(app, commit);
            const drag = getBoardShapeDrag(app);
            if (commit && drag && !options.moved && !options.place
                && typeof drag.sourceAnchorId === 'number'
                && (shape.kind === 'line' || shape.kind === 'rect' || shape.kind === 'polygon')) {
                profile.setSegmentFocus(app, null);
                profile.setNodeFocus(app, { shapeId: shape.id, index: drag.sourceAnchorId });
                profile.showProperties(app, shape);
                profile.render(app, shape);
                profile.renderSegmentSelection(app);
                profile.renderHandles(app, shape);
                endBoardShapeDrag(app, true);
                return;
            }
            if (commit && drag && !options.moved && !options.place) {
                endBoardShapeDrag(app, true);
                return;
            }
            endBoardShapeDrag(app, commit);
        },
        ...pathMoveInteraction({
            segmentAt: /** @param {Point} point */ point => profile.segmentAt
                ? profile.segmentAt(app, displayed(), point, 8 / Math.max(0.01, app.viewport?.scale || 1))
                : shape.kind === 'arc' ? 0
                    : polygonSegmentIndexAt(shape, point, 8 / Math.max(0.01, app.viewport?.scale || 1)),
            selectedSegment: () => profile.getSegmentFocus(app)?.shapeId === shape.id ? profile.getSegmentFocus(app).segment : null,
            selectSegment: /** @param {number|null} segment */ segment => {
                profile.setNodeFocus(app, null);
                profile.setSegmentFocus(app, { shapeId: shape.id, segment });
                profile.render(app, shape);
                profile.renderSegmentSelection(app);
                profile.showProperties(app, shape);
            },
            begin: /** @param {Point} point @param {number|null} segment */ (point, segment) => {
                profile.setNodeFocus(app, null);
                return startBoardShapeDrag(app, shape, point, null, { whole: true, allowSegment: segment != null, editProfile: profile });
            },
            update: /** @param {Point} point */ point => handleBoardShapeDrag(app, point),
            end: /** @param {boolean} commit */ commit => endBoardShapeDrag(app, commit),
        }),
        anchorColor: profile.anchorColor ? profile.anchorColor(app, shape) : shapeSelectionColor(shape),
        getPosition() {
            const bounds = profile.getBounds ? profile.getBounds(app, displayed()) : boardShapeBounds(displayed());
            return { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
        },
        invalidate() { profile.render(app, shape); },
        render() { profile.render(app, shape); },
    };
}

registerPcbSelectionAdapter('shape', createBoardShapeSelectionAdapter);

/**
 * Draw the resize handles for the selected shape on the overlay layer.
 * @param {PcbEditor} app
 * @param {BoardShape} shape
 */
export function renderBoardShapeHandles(app, shape) {
    shape = displayedBoardShape(app, shape);
    if (!shape || boardShapeLocked(shape) || !isLayerVisible(shape.layer)) return;
    const selectedNode = getBoardShapeNodeFocus(app);
    const node = selectedNode?.shapeId === shape.id ? shape.points?.[selectedNode.index] : null;
    if (shape.kind === 'line' && node) {
        for (const axis of ['x', 'y']) {
            const field = document.getElementById(`pcbPropShapeNode${axis.toUpperCase()}`);
            if (field) field.textContent = formatNumberInputValue(axis === 'x' ? node.x : node.y);
        }
    }
    renderPcbSelectionAnchors(app);
}

/**
 * Remove all board-shape resize handles from the overlay.
 * @param {PcbEditor} app
 */
export function clearBoardShapeHandles(app) {
    clearPcbSelectionAnchors(app);
}

/**
 * Remove obsolete standalone segment overlays after selection changes.
 * @param {PcbEditor} app
 */
export function renderBoardShapeSegmentSelection(app) {
    const overlay = app.getLayerGroup('selection-overlay');
    if (!overlay) return;
    for (const element of [...overlay.querySelectorAll('.pcb-shape-segment-selection')]) element.remove();
    const selected = getBoardShapeSegmentFocus(app);
    const shape = selected && displayedBoardShape(app, app.boardShapes?.find(/** @param {BoardShape} shape */ shape => shape.id === selected.shapeId));
    if (!shape || !isPcbSelected(app, 'shape', shape)) return;
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('class', 'pcb-shape-segment-selection');
    path.setAttribute('d', shape.kind === 'arc' ? shapePathD(shape, { close: false })
        : boardShapeStrokeSegments(shape).filter(segment => segment.logicalSegment === selected.segment)
            .map(({ start, end }) => `M ${start.x} ${start.y} L ${end.x} ${end.y}`).join(' '));
    const handles = overlay.querySelectorAll('.pcb-selection-anchors')[0];
    appendSegmentSelection(overlay, path, shapeSelectionColor(shape),
        boardShapeSegmentWidth(shape, selected.segment), handles);
}

/**
 * Remove redundant straight-through waypoints after a polyline edit.
 * @param {BoardShape} shape
 */
export function collapseCollinearPolylinePoints(shape) {
    return collapseCollinearPath(/** @type {BoardPathShape} */ (shape), index => boardShapeSegmentWidth(shape, index));
}

/**
 * @param {BoardShape} shape
 * @param {number} index
 * @param {number} delta
 */
export function remapBoardShapeNodeRadii(shape, index, delta) {
    remapPathNodes(/** @type {BoardPathShape} */ (shape), index, delta);
}

/**
 * @param {BoardShape} shape
 * @param {number} segment
 */
export function splitBoardShapeSegmentMetadata(shape, segment) {
    splitPathSegmentMetadata(/** @type {BoardPathShape} */ (shape), segment);
}

/** @param {PcbEditor} app */
function finishBoardShapeRemoval(app) {
    setBoardShapeNodeFocus(app, null);
    setBoardShapeSegmentFocus(app, null);
    app.clearProperties();
    app.setActiveRibbonTab('pcb-home');
}

/** @param {PcbEditor} app */
export function deleteSelectedBoardShape(app) {
    const s = getPcbSelection(app, 'shape')[0] || null;
    if (!s) return false;
    if (s.layer === 'board-outline') return false;
    if (boardShapeLocked(s)) return false;
    app.history.execute(new RemoveBoardShapeCommand(app, s));
    selectBoardShape(app, null);
    finishBoardShapeRemoval(app);
    return true;
}

/**
 * @param {PcbEditor} app
 * @param {BoardShape} shape
 * @param {number} segment
 * @param {'line'|'arc'} type
 * @param {{floating?: boolean}} [options]
 */
export function setBoardShapeSegmentType(app, shape, segment, type, { floating = false } = {}) {
    shape = canonicalBoardShape(app, shape);
    const original = shape;
    const standalone = shape?.kind === 'arc' || (shape?.kind === 'line' && shape.points?.length === 2);
    const count = shape?.kind === 'line' ? shape.points.length - 1
        : shape?.kind === 'polygon' || shape?.kind === 'rect' ? shape.points.length : shape?.kind === 'arc' ? 1 : 0;
    if (!Number.isInteger(segment) || segment < 0 || segment >= count
        || type !== 'line' && type !== 'arc' || boardShapeLocked(shape)) return false;
    const before = shapeSnapshot(shape);
    shape = copyBoardShape(shape);
    if (shape.kind === 'rect') /** @type {import('../../core/pcb-board-shapes.js').BoardShapeBase} */ (shape).kind = 'polygon';
    if (standalone) {
        if (shape.kind === 'line' && type === 'arc') {
            const [start, end] = shape.points;
            const arc = arcFromBulge(start, end, boardShapeSegmentBulge(shape, 0) || 0.25);
            if (!arc) return false;
            shape.lineWidth = boardShapeSegmentWidth(shape, 0);
            /** @type {import('../../core/pcb-board-shapes.js').BoardShapeBase} */ (shape).kind = 'arc';
            applyShapeGeometry(shape, { start, end, bulge: arc.bulgePoint });
        } else if (shape.kind === 'arc' && type === 'line') {
            const points = [shape.start, shape.end];
            /** @type {import('../../core/pcb-board-shapes.js').BoardShapeBase} */ (shape).kind = 'line';
            applyShapeGeometry(shape, { points });
        }
        shape.filled = false;
        shape.segmentWidths = {};
        shape.segmentBulges = {};
    } else if (!setPathSegmentType(/** @type {BoardPathShape} */ (shape), segment, type)) {
        return false;
    }
    const merged = type === 'line' && collapseCollinearPolylinePoints(shape);
    const after = shapeSnapshot(shape);
    setBoardShapeSegmentFocus(app, merged ? null : { shapeId: shape.id, segment });
    setBoardShapeNodeFocus(app, null);
    if (floating && type === 'arc') {
        const anchorId = shape.kind === 'arc' ? 'bulge' : `bulge:${segment}`;
        const stagedAnchor = getBoardShapeAnchors(shape).find(/** @param {Record<string, any>} item */ item => item.id === anchorId);
        if (!stagedAnchor || !startBoardShapeDrag(app, original, stagedAnchor, anchorId)) return false;
        const drag = getBoardShapeDrag(app);
        applyShapeSnapshot(beginBoardShapePointerPreview(app, drag), after);
        setBoardShapeSegmentFocus(app, { shapeId: original.id, segment });
        drag.editBefore = after.geom;
        drag.editKind = after.kind;
        drag.vertexBefore = cloneShapeGeometry(drag.shape);
        drag.preparing = true;
        const adapter = createBoardShapeSelectionAdapter(app, original, original.id);
        const anchor = adapter.getAnchors?.().find(/** @param {Record<string, any>} item */ item => item.id === anchorId);
        if (!anchor || !beginPcbAnchorInteraction(app, adapter, anchor, anchor, true)) {
            endBoardShapeDrag(app, false);
            return false;
        }
        drag.preparing = false;
        renderBoardShape(app, drag.shape, { liveDrag: true });
    } else app.history.execute(new ModifyBoardShapeCommand(app, original, before, after));
    showBoardShapeProperties(app, original);
    renderBoardShapeHandles(app, original);
    renderBoardShapeSegmentSelection(app);
    return true;
}

/**
 * Split a closed shape at a node and float one of the coincident endpoints.
 * @param {PcbEditor} app
 * @param {BoardShape} shape
 * @param {number} [vertexIndex]
 */
export function openBoardShape(app, shape, vertexIndex = 0) {
    shape = canonicalBoardShape(app, shape);
    if (shape?.layer === 'board-outline') return false;
    if (!shape || shape.kind !== 'line' && shape.kind !== 'polygon' && shape.kind !== 'rect' || boardShapeLocked(shape)) return false;
    const points = shape.points || [];
    if (points.length < 3) return false;
    const before = shapeSnapshot(shape);
    const start = Math.max(0, Math.min(points.length - 1, Math.trunc(Number(vertexIndex) || 0)));
    const split = splitPathAtNode(/** @type {BoardPathShape} */ (shape), start);
    if (!split) return false;
    const remainder = split.remainder;
    if (remainder) remainder.id = peekBoardShapeId(app);
    selectBoardShape(app, shape);
    if (!startBoardShapeDrag(app, shape, split.moving.points[0], 0)) return false;
    const drag = /** @type {BoardShapeDrag} */ (getBoardShapeDrag(app));
    Object.assign(beginBoardShapePointerPreview(app, drag), split.moving);
    drag.editBefore = cloneShapeGeometry(drag.shape);
    drag.editKind = drag.shape.kind;
    drag.vertexBefore = drag.editBefore;
    drag.preparing = true;
    Object.assign(drag, { splitBeforeState: before, splitRemainder: remainder, splitOrigin: { ...points[start] } });
    if (remainder) { drag.preview.boardShapes.push(remainder); renderBoardShape(app, /** @type {BoardShape} */ (remainder)); }
    const adapter = createBoardShapeSelectionAdapter(app, shape, shape.id);
    if (!beginPathSplit(app, /** @type {any} */ (adapter), /** @type {string} */ (/** @type {unknown} */ (0)), () => {
        drag.preparing = false;
    })) {
        endBoardShapeDrag(app, false);
        setBoardShapeNodeFocus(app, null);
        return false;
    }
    renderBoardShape(app, drag.shape, { liveDrag: true });
    return true;
}

/**
 * @param {PcbEditor} app
 * @param {BoardShape} shape
 * @param {number} segment
 */
export function deleteBoardShapeSegment(app, shape, segment) {
    if (shape?.layer === 'board-outline') {
        if (shape.kind !== 'line' && shape.kind !== 'polygon' && shape.kind !== 'rect') return false;
        if (!Number.isInteger(segment) || segment < 0 || segment >= shape.points.length) return false;
        return deleteBoardShapeVertex(app, shape, (segment + 1) % shape.points.length);
    }
    if (shape.kind === 'arc' && segment === 0 && !boardShapeLocked(shape)) {
        setPcbSelection(app, []);
        app.history.execute(new RemoveBoardShapeCommand(app, shape));
        finishBoardShapeRemoval(app);
        return true;
    }
    const count = shape.kind === 'line' ? shape.points.length - 1
        : shape.kind === 'polygon' || shape.kind === 'rect' ? shape.points.length : 0;
    if (!Number.isInteger(segment) || segment < 0 || segment >= count || boardShapeLocked(shape)) return false;
    const parts = /** @type {any[]} */ (deletePathSegment(/** @type {BoardPathShape} */ (shape), segment)).map(part => {
        part.id = nextBoardShapeId(app);
        return /** @type {BoardShape} */ (part);
    });
    setPcbSelection(app, []);
    app.history.execute(new CompoundCommand([new RemoveBoardShapeCommand(app, shape),
        ...parts.map(part => addBoardShapeOrTrackCommand(app, part).command)]));
    if (parts.length === 0) finishBoardShapeRemoval(app);
    return true;
}

/** @param {PcbEditor} app */
export function deleteFocusedBoardShape(app) {
    const selected = getPcbSelection(app, 'shape');
    if (selected.length !== 1 || getPcbSelection(app).length !== 1) return false;
    const shape = /** @type {BoardShape} */ (canonicalBoardShape(app, selected[0]));
    const nodeFocus = getBoardShapeNodeFocus(app);
    const segmentFocus = getBoardShapeSegmentFocus(app);
    const node = nodeFocus?.shapeId === shape.id ? nodeFocus.index : null;
    const segment = segmentFocus?.shapeId === shape.id ? segmentFocus.segment : null;
    if (node == null && segment == null) return false;
    const activeShapeDrag = getBoardShapeDrag(app);
    if (activeShapeDrag) {
        const splitting = !!activeShapeDrag.splitBeforeState;
        endBoardShapeDrag(app, false);
        setSelectionInteraction(app, null);
        if (splitting) {
            setBoardShapeNodeFocus(app, null);
            setBoardShapeSegmentFocus(app, null);
            showBoardShapeProperties(app, shape);
            return true;
        }
    }
    if (node != null) deleteBoardShapeVertex(app, shape, node);
    else deleteBoardShapeSegment(app, shape, segment);
    setBoardShapeNodeFocus(app, null);
    setBoardShapeSegmentFocus(app, null);
    app.refreshSelectionHighlights();
    return true;
}

/**
 * Delete a polyline vertex; a triangle reduces to an open two-point Line.
 * @param {PcbEditor} app
 * @param {BoardShape} shape
 * @param {number} vertexIndex
 */
export function deleteBoardShapeVertex(app, shape, vertexIndex) {
    shape = canonicalBoardShape(app, shape);
    if (!shape || shape.kind !== 'line' && shape.kind !== 'polygon' && shape.kind !== 'rect' || boardShapeLocked(shape)) return false;
    const points = shape.points || [];
    if (shape.layer === 'board-outline' && points.length <= 3) return false;
    if (!Number.isInteger(vertexIndex) || vertexIndex < 0 || vertexIndex >= points.length) return false;
    if (shape.kind === 'line' && points.length <= 2) {
        setPcbSelection(app, []);
        app.history.execute(new RemoveBoardShapeCommand(app, shape));
        finishBoardShapeRemoval(app);
        return true;
    }
    const before = shapeSnapshot(shape);
    const candidate = copyBoardShape(shape);
    deletePathVertex(/** @type {BoardPathShape} */ (candidate), vertexIndex);
    normalizeBoardPolylineKind(candidate);
    const after = shapeSnapshot(candidate);
    app.history.execute(new ModifyBoardShapeCommand(app, shape, before, after));
    setBoardShapeNodeFocus(app, null);
    setBoardShapeSegmentFocus(app, null);
    showBoardShapeProperties(app, shape);
    return true;
}

/** Remove the currently-open board-shape context menu. */
export function dismissBoardShapeContextMenu() {
    dismissPathContextMenu('pcbBoardShapeContextMenu');
}

/**
 * Show topology actions for a Line, Polygon, or Rectangle.
 * @param {PcbEditor} app
 * @param {BoardShape} shape
 * @param {number} clientX
 * @param {number} clientY
 * @param {Point} worldPos
 */
export function showBoardShapeContextMenu(app, shape, clientX, clientY, worldPos) {
    dismissBoardShapeContextMenu();
    if (!shape || shape.kind !== 'line' && shape.kind !== 'polygon' && shape.kind !== 'rect' && shape.kind !== 'arc' || boardShapeLocked(shape)) return;
    selectBoardShape(app, shape);
    const vertexIndex = hitTestBoardShapeVertex(app, shape, worldPos);
    const node = typeof vertexIndex === 'number';
    const segmentIndex = node ? null : shape.kind === 'arc' ? 0
        : polygonSegmentIndexAt(shape, worldPos, 8 / Math.max(0.01, app.viewport?.scale || 1));
    setBoardShapeNodeFocus(app, node ? { shapeId: shape.id, index: vertexIndex } : null);
    setBoardShapeSegmentFocus(app, segmentIndex != null ? { shapeId: shape.id, segment: segmentIndex } : null);
    const curved = shape.kind === 'arc' || !!boardShapeSegmentBulge(shape, /** @type {number} */ (segmentIndex));
    const remove = () => {
        setPcbSelection(app, []);
        app.history.execute(new RemoveBoardShapeCommand(app, shape));
        finishBoardShapeRemoval(app);
    };
    const items = /** @type {any} */ (pathContextActions({ node, segment: segmentIndex != null, curved,
        standalone: shape.kind === 'arc' || (shape.kind === 'line' && shape.points.length === 2),
        split: shape.layer !== 'board-outline' && node && (shape.kind !== 'line' || vertexIndex > 0 && vertexIndex < /** @type {BoardPathShape} */ (shape).points.length - 1)
            ? () => openBoardShape(app, shape, vertexIndex) : null,
        deleteNode: shape.layer === 'board-outline' && /** @type {BoardPathShape} */ (shape).points.length <= 3 ? null : () => deleteBoardShapeVertex(app, shape, /** @type {number} */ (/** @type {unknown} */ (vertexIndex))),
        convert: () => setBoardShapeSegmentType(app, shape, /** @type {number} */ (segmentIndex), curved ? 'line' : 'arc', { floating: !curved }),
        deleteSegment: shape.layer === 'board-outline' && /** @type {BoardPathShape} */ (shape).points.length <= 3 ? null
            : shape.kind === 'arc' ? remove : () => deleteBoardShapeSegment(app, shape, /** @type {number} */ (segmentIndex)),
        deleteObject: shape.layer === 'board-outline' ? null : remove, label: shapeKindLabel(shape.kind).toLowerCase(),
    }));
    showBoardShapeProperties(app, shape);
    renderBoardShape(app, shape);
    renderBoardShapeHandles(app, shape);
    renderBoardShapeSegmentSelection(app);
    return showPathContextMenu('pcbBoardShapeContextMenu', items, clientX, clientY, () => app.refreshSelectionHighlights());
}

// â”€â”€ Copper cuts â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * SVG sub-paths for board shapes that subtract copper on the given copper
 * layer. Returns { count, d } to fold into updateCopperCuts (copper-cuts.js).
 * @param {PcbBoard} app
 * @param {string} copperLayer
 */
export function boardShapeCopperCuts(app, copperLayer) {
    let d = '';
    let count = 0;
    /** @param {Point[]} points */
    const appendLoop = (points) => {
        if (points.length < 3) return;
        d += ` M ${r4(points[0].x)} ${r4(points[0].y)}`;
        for (let index = 1; index < points.length; index++) d += ` L ${r4(points[index].x)} ${r4(points[index].y)}`;
        d += ' Z';
    };
    for (const s of (app.boardShapes || [])) {
        if (!s) continue;
        // A hole-layer shape is a board cutout â€” it removes copper on both
        // sides regardless of mode. Copper-removal shapes only cut their own
        // copper layer.
        if (s.layer === 'hole') {
            // included on every side
        } else if (s.layer === copperLayer) {
            const m = normalizeShapeCopperMode(s.copperMode);
            if (m !== 'remove-copper' && m !== 'remove-copper-mask') continue;
        } else {
            continue;
        }
        if (s.layer !== 'hole') {
            const removalPath = boardShapeRemovalPathD(s);
            if (!removalPath) continue;
            d += ` ${removalPath}`;
            count++;
            continue;
        }
        const geometry = resolveBoardShapeGeometry(s);
        if (geometry.physicalContours) {
            for (const contour of geometry.physicalContours) appendLoop(contour);
            count++;
            continue;
        }
        if (geometry.filled) {
            const outline = geometry.circle
                ? circleOutline({ ...s, radius: geometry.circle.outerRadius, filled: false })
                : geometry.areaOutline || [];
            if (outline.length < 3) continue;
            appendLoop(outline);
        } else {
            continue;
        }
        count++;
    }
    return { count, d };
}

// â”€â”€ Serialisation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * @param {PcbEditor} app
 * @param {any[]} arr
 * @param {{render?: boolean, strict?: boolean}} [options]
 */
export function loadBoardShapes(app, arr, { render = true, strict = false } = {}) {
    /** @type {{boardShapes: BoardShape[], shapeIdCounter: number}} */
    const stage = { boardShapes: [], shapeIdCounter: boardShapeIdDocument(app).shapeIdCounter };
    loadBoardShapeData(stage, arr, { strict, lineWidth: getShapeDefaults(app)?.lineWidth ?? 0.2 });
    setBoardShapeIdCounter(app, stage.shapeIdCounter);
    for (const shape of stage.boardShapes) {
        app.boardShapes.push(shape);
        if (shape.layer === 'board-outline') syncBoardOutlineDimensions(app);
        if (render && shape.type !== 'fill') renderBoardShape(app, shape);
    }
}
