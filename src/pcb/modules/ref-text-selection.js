import { getPcbSelection, isPcbSelected, registerPcbPlacementHitTest, registerPcbReferenceOverlayRefresh, registerPcbSelectionAdapter, getRefTextSelectionHit, setPcbSelection } from './selection-registry.js';
import { lockPositionOutsideOutline } from './selection-anchors.js';
import { isLayerVisible, isLayerLocked } from './layers.js';
import { getPropertyEditor } from './property-editors.js';
import { renderPlacementPose, placementTransform } from './track-commands.js';
import { hitTestRefText, placementLocalToWorld, refBox, refCenterWorld, refEditBoxWorldCorners, worldToPlacementLocal } from './ref-text-geometry.js';
import { getPcbInteraction, setPcbInteraction } from './pcb-interactions.js';
import { hitTestText } from './pcb-text-render.js';
import { applyRefGeometry, REF_DEFAULT_SIZE, REF_DEFAULT_STROKE } from '../../shared/pcb/footprint.js';
import { measureText as measureStrokeText } from '../../shared/pcb/stroke-font.js';
import { showAlert } from '../../shared/ui/modal.js';
import { applyTextConnectionGuide } from '../../shared/ui/inline-text-overlay.js';
import { connectBoxOutlines } from '../../core/geometry.js';
import { textColorForLayer } from './pcb-text.js';
import { activeTextInlineEdit } from './text-inline-edit.js';
import { refreshBoardView } from './refresh-state.js';
import {
    MoveRefTextCommand as ModelMoveRefTextCommand,
    RotateRefTextCommand as ModelRotateRefTextCommand,
    SetRefStyleCommand as ModelSetRefStyleCommand,
} from '../../core/pcb-placement-commands.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */
/** @typedef {import('../../core/pcb-placement-geometry.js').Placement} Placement */
/** @typedef {{x: number, y: number}} Point */
/** @typedef {{refSize?: number, refStrokeWidth?: number, refRot?: number}} RefStyleState */

const refOverlays = new WeakMap();

/** @param {Placement|null|undefined} placement */
export function isRefTextLocked(placement) {
    return !!placement && (!!placement.locked
        || isLayerLocked(placement.side === 'bottom' ? 'bottom-silk' : 'top-silk'));
}

/** @param {PcbEditor} app */
export function getRefDrag(app) {
    return getPcbInteraction(app, '_refDrag');
}

/** @param {PcbEditor} app */
export function hasRefOverlay(app) {
    return refOverlays.has(app);
}

/** @param {PcbEditor} app */
function ensureRefOverlay(app) {
    let overlay = refOverlays.get(app);
    if (!overlay || !overlay.isConnected) {
        overlay = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        overlay.setAttribute('class', 'pcb-ref-overlay');
        overlay.setAttribute('pointer-events', 'none');
        app.viewport?.addContent(overlay);
        refOverlays.set(app, overlay);
    }
    return overlay;
}

/**
 * @param {PcbEditor} app
 * @param {string} compId
 */
export function refreshRefHighlight(app, compId) {
    const pl = app.placements.get(compId);
    if (!pl || !refBox(pl)) return;
    const active = isPcbSelected(app, 'reftext', compId)
        || activeTextInlineEdit(app)?.options?.componentId === compId;
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    pl._refEl.setAttribute('stroke', active ? (isLight ? '#000000' : '#ffffff')
        : textColorForLayer(pl.side === 'bottom' ? 'bottom-silk' : 'top-silk'));
}

/**
 * @param {PcbEditor} app
 * @param {string|null} compId
 * @param {boolean} withTether
 */
export function drawRefOverlay(app, compId, withTether) {
    if (!compId) {
        const existing = refOverlays.get(app);
        if (existing) while (existing.firstChild) existing.removeChild(existing.firstChild);
        return;
    }
    const g = ensureRefOverlay(app);
    while (g.firstChild) g.removeChild(g.firstChild);
    const pl = app.placements.get(compId);
    if (!pl) return;
    const box = refBox(pl);
    if (!box) return;
    refreshRefHighlight(app, compId);
    const NS = 'http://www.w3.org/2000/svg';
    if (pl.bounds) {
        const outline = document.createElementNS(NS, 'rect');
        outline.setAttribute('class', 'pcb-ref-component-outline');
        outline.setAttribute('x', String(pl.bounds.x));
        outline.setAttribute('y', String(pl.bounds.y));
        outline.setAttribute('width', String(pl.bounds.width));
        outline.setAttribute('height', String(pl.bounds.height));
        outline.setAttribute('transform', placementTransform(pl));
        outline.setAttribute('fill', 'none');
        outline.setAttribute('stroke', '#3399ff');
        outline.setAttribute('stroke-width', '1.2');
        outline.setAttribute('vector-effect', 'non-scaling-stroke');
        outline.setAttribute('pointer-events', 'none');
        g.appendChild(outline);
    }
    if (withTether || isPcbSelected(app, 'reftext', compId) || getRefDrag(app)?.compId === compId
        || activeTextInlineEdit(app)?.options?.componentId === compId) {
        const bounds = pl.bounds;
        if (!bounds || bounds.width <= 0 || bounds.height <= 0) return;
        const textBox = refEditBoxWorldCorners(pl, box);
        if (!textBox) return;
        const componentBox = [
            [bounds.x, bounds.y], [bounds.x + bounds.width, bounds.y],
            [bounds.x + bounds.width, bounds.y + bounds.height], [bounds.x, bounds.y + bounds.height],
        ].map(([x, y]) => placementLocalToWorld(pl, x, y));
        const connection = connectBoxOutlines(componentBox, textBox);
        if (!connection) return;
        const line = document.createElementNS(NS, 'line');
        applyTextConnectionGuide(line, connection, '#3399ff');
        g.appendChild(line);
    }
}

/**
 * @param {PcbEditor} app
 * @param {string} compId
 */
export function rerenderRef(app, compId) {
    const pl = app.placements.get(compId);
    if (!pl) return;
    refBox(pl);
    const el = pl._refEl;
    if (!el) return;
    const cxRef = parseFloat(el.getAttribute('data-mx-center'));
    const baseY = parseFloat(el.getAttribute('data-ref-anchor-y'));
    if (!Number.isFinite(cxRef) || !Number.isFinite(baseY)) return;
    if (applyRefGeometry(el, /** @type {string} */ (pl.reference), cxRef, baseY,
        pl.refSize || REF_DEFAULT_SIZE, pl.refStrokeWidth || REF_DEFAULT_STROKE)) {
        pl._refBox = null;
    }
    renderPlacementPose(app, compId);
    refreshRefHighlight(app, compId);
    if (activeTextInlineEdit(app)?.options?.componentId === compId) activeTextInlineEdit(app).updateCaret?.();
}

/**
 * @param {PcbEditor} app
 * @param {string} componentId
 * @param {Point} worldPos
 */
export function beginRefTextDrag(app, componentId, worldPos) {
    getPropertyEditor(app, 'component')?.commit();
    const placement = app.placements.get(componentId);
    if (!placement || isRefTextLocked(placement)) return false;
    setPcbInteraction(app, '_refDrag', {
        compId: componentId,
        startWorld: worldPos,
        startDx: placement.refDx || 0,
        startDy: placement.refDy || 0,
    });
    app.drawRefOverlay(componentId, true);
    return true;
}

/**
 * @param {PcbEditor} app
 * @param {Point} worldPos
 */
export function updateRefTextDrag(app, worldPos) {
    const drag = getRefDrag(app);
    if (!drag) return;
    const placement = app.placements.get(drag.compId);
    if (!placement || isRefTextLocked(placement)) return;
    const localNow = worldToPlacementLocal(worldPos, placement);
    const localStart = worldToPlacementLocal(drag.startWorld, placement);
    const raw = {
        x: drag.startDx + localNow.x - localStart.x,
        y: drag.startDy + localNow.y - localStart.y,
    };
    const snap = app.snapToGrid(raw);
    if ((placement.refDx || 0) === snap.x && (placement.refDy || 0) === snap.y) return;
    placement.refDx = snap.x;
    placement.refDy = snap.y;
    renderPlacementPose(app, drag.compId);
    app.drawRefOverlay(drag.compId, true);
}

/**
 * @param {PcbEditor} app
 * @param {MouseEvent} e
 */
export function handleRefDrag(app, e) {
    if (!getRefDrag(app)) return;
    if (!app.viewport) return;
    app.viewport.shiftHeld = e.shiftKey;
    updateRefTextDrag(app, app.screenToWorld(e));
}

/** @param {PcbEditor} app */
export function endRefDrag(app, commit = true) {
    const drag = getRefDrag(app);
    if (!drag) return;
    const { compId, startDx, startDy } = drag;
    setPcbInteraction(app, '_refDrag', null);
    const placement = app.placements.get(compId);
    if (app.viewport) app.viewport.svg.style.cursor = 'default';
    if (!placement) { app.drawRefOverlay(null, false); return; }
    if ((placement.refDx || 0) === startDx && (placement.refDy || 0) === startDy) {
        app.drawRefOverlay(compId, false);
        return;
    }
    if (commit && !isRefTextLocked(placement)) {
        app.history.execute(new MoveRefTextCommand(app, compId, startDx, startDy, placement.refDx || 0, placement.refDy || 0));
    } else {
        placement.refDx = startDx;
        placement.refDy = startDy;
        renderPlacementPose(app, compId);
        app.drawRefOverlay(compId, false);
    }
}

export class MoveRefTextCommand extends ModelMoveRefTextCommand {
    /**
     * @param {PcbEditor} app
     * @param {string} compId
     * @param {number} fromDx
     * @param {number} fromDy
     * @param {number} toDx
     * @param {number} toDy
     */
    constructor(app, compId, fromDx, fromDy, toDx, toDy) {
        super(app.placementState, compId, fromDx, fromDy, toDx, toDy, app.placements?.get(compId));
        this.app = app;
    }
    /** @param {Parameters<ModelMoveRefTextCommand['_apply']>[0]} s */
    _apply(s) {
        const saved = super._apply(s);
        const pl = this.app.placements?.get(this.compId);
        if (pl) { pl.refDx = saved.refDx; pl.refDy = saved.refDy; }
        renderPlacementPose(this.app, this.compId);
        this.app.markDirty?.();
        this.app.drawRefOverlay?.(this.compId, false);
        refreshBoardView(this.app);
        return saved;
    }
}

export class RotateRefTextCommand extends ModelRotateRefTextCommand {
    /**
     * @param {PcbEditor} app
     * @param {string} compId
     * @param {number} fromDeg
     * @param {number} toDeg
     */
    constructor(app, compId, fromDeg, toDeg) {
        super(app.placementState, compId, fromDeg, toDeg, app.placements?.get(compId));
        this.app = app;
    }
    /** @param {number} deg */
    _apply(deg) {
        const saved = super._apply(deg);
        const pl = this.app.placements?.get(this.compId);
        if (pl) pl.refRot = saved.refRot;
        renderPlacementPose(this.app, this.compId);
        this.app.markDirty?.();
        this.app.drawRefOverlay?.(this.compId, false);
        refreshBoardView(this.app);
        return saved;
    }
}

export class SetRefStyleCommand extends ModelSetRefStyleCommand {
    /**
     * @param {PcbEditor} app
     * @param {string} compId
     * @param {RefStyleState} before
     * @param {RefStyleState} after
     */
    constructor(app, compId, before, after) {
        super(app.placementState, compId, before, after, app.placements?.get(compId));
        this.app = app;
    }
    /** @param {RefStyleState} state */
    _apply(state) {
        const saved = super._apply(state);
        const pl = this.app.placements?.get(this.compId);
        if (pl) {
            if (state.refSize !== undefined) pl.refSize = saved.refSize;
            if (state.refStrokeWidth !== undefined) pl.refStrokeWidth = saved.refStrokeWidth;
            if (state.refRot !== undefined) pl.refRot = saved.refRot;
        }
        this.app.rerenderRef?.(this.compId);
        this.app.markDirty?.();
        this.app.drawRefOverlay?.(this.compId, false);
        refreshBoardView(this.app);
        return saved;
    }
}

/**
 * @param {PcbEditor} app
 * @param {Point} worldPos
 */
export function hitTestReferenceText(app, worldPos) {
    return hitTestRefText(app.placements, worldPos, refBox);
}

registerPcbPlacementHitTest('reftext', hitTestReferenceText);
registerPcbReferenceOverlayRefresh(/** @param {PcbEditor} app @param {string|null} componentId */ (app, componentId) => {
    if (componentId || hasRefOverlay(app)) app.drawRefOverlay?.(componentId, false);
});

/**
 * @param {PcbEditor} app
 * @param {Point} worldPos
 */
export function tryEditReferenceAt(app, worldPos) {
    if (hitTestText(app, worldPos)) return false;
    const compId = hitTestReferenceText(app, worldPos);
    if (!compId) return false;
    const pl = app.placements.get(compId);
    const project = app.project;
    const component = project?.getComponentInfo(compId);
    const layer = pl?.side === 'bottom' ? 'bottom-silk' : 'top-silk';
    if (!pl || !project || pl.locked || !component || component.locked || isLayerLocked(layer) || !isLayerVisible(layer)) return false;
    const placement = /** @type {NonNullable<typeof pl>} */ (pl);
    const original = component.reference;
    const text = {
        id: compId,
        content: original,
        x: 0,
        y: 0,
        size: placement.refSize || REF_DEFAULT_SIZE,
        rotation: 0,
        strokeWidth: placement.refStrokeWidth || REF_DEFAULT_STROKE,
        layer,
    };
    const baseX = () => (refBox(placement)?.cx || 0) - measureStrokeText(text.content, text.size) / 2;
    const render = () => {
        placement.reference = text.content;
        app.rerenderRef(compId);
        app.drawRefOverlay(compId, false);
    };
    app.startTextInlineEdit(text, worldPos, {
        componentId: compId,
        select: () => {
            selectRefText(app, compId);
            app.showRefProperties(compId);
        },
        prepare: () => {
            text.size = pl.refSize || REF_DEFAULT_SIZE;
            text.strokeWidth = pl.refStrokeWidth || REF_DEFAULT_STROKE;
        },
        transform: () => `${placementTransform(pl)} ${pl._refEl.getAttribute('transform') || ''}`
            + ` translate(${baseX()},${pl._refEl.getAttribute('data-ref-anchor-y')})`,
        /** @param {Point} point */
        localX: point => {
            if (!app.viewport) return 0;
            const svg = app.viewport.svg;
            const cursor = svg.createSVGPoint();
            cursor.x = point.x;
            cursor.y = point.y;
            const local = cursor.matrixTransform(pl._refEl.getCTM().inverse().multiply(svg.getCTM()));
            return local.x - baseX();
        },
        render,
        /** @param {string} value */
        validate: value => {
            const issue = project.validateComponentReference(compId, value);
            if (issue) {
                showAlert(issue.message, { title: issue.title });
                return false;
            }
            return true;
        },
        /** @param {string} value @param {boolean} commit */
        finish: (value, commit) => {
            const reference = value.trim();
            if (commit && reference !== original) {
                const command = project.createReferenceRenameCommand(compId, reference);
                /** @param {boolean} redo */
                const apply = redo => {
                    if (redo) command.execute();
                    else command.undo();
                    const current = project.getComponentInfo(compId);
                    const placement = app.placements.get(compId);
                    if (placement && current) {
                        placement.reference = current.reference;
                        app.rerenderRef(compId);
                        app.drawRefOverlay(compId, false);
                        app.showRefProperties(compId);
                    }
                    app.netlist = project.getNetlist();
                    app.updateRatsnest();
                    app.refreshComponent3D();
                };
                app.history.execute({
                    description: `Rename ${original} to ${reference}`,
                    execute: () => apply(true),
                    undo: () => apply(false),
                });
            } else {
                text.content = original;
                render();
                app.showRefProperties(compId);
            }
        },
    });
    return true;
}

/**
 * Select/deselect a component's reference text. Pass null to clear.
 * @param {PcbEditor} app
 * @param {string|null} compId
 */
export function selectRefText(app, compId) {
    const prev = getPcbSelection(app, 'reftext')[0] || null;
    const next = compId || null;
    if (prev === next) {
        if (next) app.drawRefOverlay(next, false);
        return;
    }
    setPcbSelection(app, next ? [{ kind: 'reftext', object: next }] : []);
    app.syncClipboardButtons?.();
    app.drawRefOverlay(next, false);
}

/**
 * @param {PcbEditor} app
 * @param {string} componentId
 */
function outlineForRefText(app, componentId) {
    const placement = app.placements?.get(componentId);
    const box = placement ? refBox(placement) : null;
    if (!placement || !box) return [];
    const rotation = (placement.refRot || 0) * Math.PI / 180;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const dx = placement.refDx || 0;
    const dy = placement.refDy || 0;
    return [
        [box.bx, box.by],
        [box.bx + box.bw, box.by],
        [box.bx + box.bw, box.by + box.bh],
        [box.bx, box.by + box.bh],
    ].map(([x, y]) => {
        const offsetX = x - box.cx;
        const offsetY = y - box.cy;
        let localX = box.cx + offsetX * cos - offsetY * sin;
        if (placement.mirror) localX = 2 * box.cx - localX;
        return placementLocalToWorld(
            placement,
            localX + dx,
            box.cy + offsetX * sin + offsetY * cos + dy,
        );
    });
}

/**
 * @param {PcbEditor} app
 * @param {string} componentId
 */
function boundsForRefText(app, componentId) {
    const points = outlineForRefText(app, componentId);
    if (!points.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    return {
        minX: Math.min(...points.map((point) => point.x)),
        minY: Math.min(...points.map((point) => point.y)),
        maxX: Math.max(...points.map((point) => point.x)),
        maxY: Math.max(...points.map((point) => point.y)),
    };
}

/**
 * @param {PcbEditor} app
 * @param {string} componentId
 * @param {string} id
 */
export function createRefTextSelectionAdapter(app, componentId, id) {
    return {
        id,
        kind: 'reftext',
        object: componentId,
        get visible() {
            const placement = app.placements?.get(componentId);
            return !!placement && placement.refVisible !== false
                && isLayerVisible(placement.side === 'bottom' ? 'bottom-silk' : 'top-silk');
        },
        get locked() { return isRefTextLocked(app.placements?.get(componentId)); },
        getBounds() { return boundsForRefText(app, componentId); },
        /** @param {Point} pointer @param {number} scale */
        getLockPosition(pointer, scale) {
            return lockPositionOutsideOutline(
                outlineForRefText(app, componentId),
                pointer,
                scale,
            );
        },
        /** @param {Point} point */
        hitTest(point) { return getRefTextSelectionHit(app, point) === componentId; },
        getPosition() {
            const placement = app.placements?.get(componentId);
            const box = placement ? refBox(placement) : null;
            return placement && box ? refCenterWorld(placement, box) : { x: 0, y: 0 };
        },
        /** @param {Point} worldPos */
        beginMove(worldPos) { return beginRefTextDrag(app, componentId, worldPos); },
        /** @param {Point} worldPos */
        updateMove(worldPos) { updateRefTextDrag(app, worldPos); },
        /** @param {boolean} commit */
        endMove(commit) { endRefDrag(app, commit); },
        invalidate() {
            refreshRefHighlight(app, componentId);
            app.drawRefOverlay?.(componentId, false);
        },
        render() { this.invalidate(); },
    };
}

registerPcbSelectionAdapter('reftext', createRefTextSelectionAdapter);
