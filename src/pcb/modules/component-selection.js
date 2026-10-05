import { getPcbSelection, registerPcbSelectionAdapter, getComponentSelectionHits } from './selection-registry.js';
import { lockPositionOutsideOutline } from './selection-anchors.js';
import { beginRotationHandleDrag, endRotationHandleDrag, rotationHandleAnchor, pointerRotation } from './rotation-handle.js';
import { previewPlacementPose, restorePlacementPosePreview, finishPlacementPreview, MovePlacementCommand, RotatePlacementCommand } from './track-commands.js';
import { setHoverHighlight } from './track-select.js';
import { setDragOverlaysDeferred } from './refresh-state.js';
import { areClearancesVisible, getPadHaloGroup } from './clearance-overlay.js';
import { getPcbInteraction, setPcbInteraction } from './pcb-interactions.js';
import { isEditorActive } from './pcb-editor-api.js';

const componentDragFrames = new WeakMap();

function showFootprintCrosshair(app, placement) {
    if (!placement || !app.viewport?.setCrosshair) return;
    app.viewport.setCrosshair({ x: placement.x, y: placement.y });
}

export function getComponentDrag(app) {
    return getPcbInteraction(app, '_drag');
}

export function beginComponentDrag(app, componentId, worldPos) {
    const placement = app.placements.get(componentId);
    if (!placement || placement.locked) return false;
    setHoverHighlight(app, null);
    app._hoverComponent(null);
    app._hideNetTooltip();
    const drag = {
        compId: componentId,
        startWorld: worldPos,
        startPos: { x: placement.x, y: placement.y },
        nets: app._netsForComponent(componentId),
    };
    setPcbInteraction(app, '_drag', drag);
    setDragOverlaysDeferred(app, true);
    if (areClearancesVisible(app)) {
        const group = getPadHaloGroup(app, componentId);
        if (group) group.style.display = 'none';
        const overlay = app.getLayerGroup('clearance-overlay');
        if (overlay) {
            for (const net of drag.nets) {
                for (const element of overlay.querySelectorAll(`.debug-clearance[data-net="${CSS.escape(net)}"]`)) {
                    /** @type {SVGElement} */ (element).style.display = 'none';
                }
            }
            overlay.style.willChange = 'transform';
        }
    }
    showFootprintCrosshair(app, placement);
    return true;
}

export function updateComponentDrag(app, worldPos) {
    const drag = getComponentDrag(app);
    if (!drag) return;
    const newX = drag.startPos.x + worldPos.x - drag.startWorld.x;
    const newY = drag.startPos.y + worldPos.y - drag.startWorld.y;
    const placement = app.placements.get(drag.compId);
    if (!placement || placement.locked) return;
    const snap = app.snapToGrid({ x: newX, y: newY });
    if (placement.x === snap.x && placement.y === snap.y) return;
    previewPlacementPose(app, drag.compId, { x: snap.x, y: snap.y });
    showFootprintCrosshair(app, placement);
    app.updateRatsnest({ nets: drag.nets });
}

export function scheduleComponentDragUpdate(app, e) {
    let frame = componentDragFrames.get(app);
    if (!frame) {
        frame = { raf: 0, pending: null };
        componentDragFrames.set(app, frame);
    }
    frame.pending = e;
    if (frame.raf) return;
    frame.raf = requestAnimationFrame(() => {
        frame.raf = 0;
        const ev = frame.pending;
        frame.pending = null;
        if (!ev || !isEditorActive(app) || !getComponentDrag(app)) return;
        handleComponentDrag(app, ev);
    });
}

export function handleComponentDrag(app, e) {
    if (!getComponentDrag(app)) return;
    app.viewport.shiftHeld = e.shiftKey;
    updateComponentDrag(app, app.screenToWorld(e));
}

export function endComponentDrag(app, commit = true) {
    const drag = getComponentDrag(app);
    if (!drag) return;
    const frame = componentDragFrames.get(app);
    if (frame?.raf) {
        cancelAnimationFrame(frame.raf);
        frame.raf = 0;
    }
    const pending = frame?.pending || null;
    if (frame) frame.pending = null;
    if (commit && pending) handleComponentDrag(app, pending);
    const { compId, startPos } = drag;
    const placement = app.placements.get(compId);
    setPcbInteraction(app, '_drag', null);
    setDragOverlaysDeferred(app, false);
    if (areClearancesVisible(app)) {
        const overlay = app.getLayerGroup('clearance-overlay');
        if (overlay) overlay.style.willChange = '';
    }
    app.viewport.svg.style.cursor = getPcbSelection(app, 'component').length ? 'grab' : 'default';
    app.viewport.hideCrosshair?.();
    if (commit && placement && (placement.x !== startPos.x || placement.y !== startPos.y)) {
        finishPlacementPreview(app, () => {
            const command = new MovePlacementCommand(app, compId, startPos.x, startPos.y, placement.x, placement.y);
            app.history.execute(command);
        });
    } else {
        finishPlacementPreview(app);
        app.refreshClearanceHalos();
        app.updateRatsnest();
    }
}

function outlineForPlacement(placement) {
    const bounds = placement?.bounds;
    if (!bounds) return [{ x: placement?.x || 0, y: placement?.y || 0 }];
    return [
        { x: bounds.x, y: bounds.y },
        { x: bounds.x + bounds.width, y: bounds.y },
        { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
        { x: bounds.x, y: bounds.y + bounds.height },
    ].map((point) => appLocalToWorld(placement, point));
}

function boundsForPlacement(placement) {
    if (!placement?.bounds) {
        const pads = (placement?.padOffsets || []).flatMap(off => {
            const pos = placement.pads?.get(off.padId);
            if (!pos) return [];
            const halfWidth = (off.width || 1.2) / 2 + 0.5;
            const halfHeight = (off.height || 1.2) / 2 + 0.5;
            return [{ x: pos.x - halfWidth, y: pos.y - halfHeight },
                { x: pos.x + halfWidth, y: pos.y + halfHeight }];
        });
        if (pads.length) return {
            minX: Math.min(...pads.map(point => point.x)),
            minY: Math.min(...pads.map(point => point.y)),
            maxX: Math.max(...pads.map(point => point.x)),
            maxY: Math.max(...pads.map(point => point.y)),
        };
    }
    const points = outlineForPlacement(placement);
    return {
        minX: Math.min(...points.map((point) => point.x)),
        minY: Math.min(...points.map((point) => point.y)),
        maxX: Math.max(...points.map((point) => point.x)),
        maxY: Math.max(...points.map((point) => point.y)),
    };
}

function appLocalToWorld(placement, point) {
    const rad = (Number(placement.rotation) || 0) * Math.PI / 180;
    const mirror = (!!placement.mirror) !== (placement.side === 'bottom') ? -1 : 1;
    const x = point.x * mirror;
    return {
        x: placement.x + x * Math.cos(rad) - point.y * Math.sin(rad),
        y: placement.y + x * Math.sin(rad) + point.y * Math.cos(rad),
    };
}

export function createComponentSelectionAdapter(app, componentId, id) {
    let rotationDrag = null;
    return {
        id,
        kind: 'component',
        object: componentId,
        get visible() { return app.placements?.has(componentId); },
        get locked() { return !!app.placements?.get(componentId)?.locked; },
        getBounds() { return boundsForPlacement(app.placements?.get(componentId)); },
        getAnchors() {
            const placement = app.placements?.get(componentId);
            return placement ? [rotationHandleAnchor(boundsForPlacement(placement), app.viewport?.scale)] : [];
        },
        getLockPosition(pointer, scale) {
            return lockPositionOutsideOutline(
                outlineForPlacement(app.placements?.get(componentId)),
                pointer,
                scale,
            );
        },
        hitTest(point) { return getComponentSelectionHits(app, point).has(componentId); },
        getPosition() {
            const placement = app.placements?.get(componentId);
            return { x: placement?.x || 0, y: placement?.y || 0 };
        },
        beginMove(worldPos) { return beginComponentDrag(app, componentId, worldPos); },
        updateMove(worldPos) { updateComponentDrag(app, worldPos); },
        endMove(commit) { endComponentDrag(app, commit); },
        beginAnchorDrag(anchorId, worldPos) {
            const placement = app.placements?.get(componentId);
            if (anchorId !== 'rotate' || !placement || placement.locked) return false;
            rotationDrag = {
                center: { x: placement.x, y: placement.y }, start: { ...worldPos },
                rotation: placement.rotation || 0, nets: app._netsForComponent?.(componentId),
            };
            beginRotationHandleDrag(app);
            app._hoverComponent?.(null);
            app._hideNetTooltip?.();
            return true;
        },
        updateAnchorDrag(worldPos) {
            const placement = app.placements?.get(componentId);
            if (!rotationDrag || !placement || placement.locked) return;
            // Footprint transforms use SVG's clockwise-positive angles.
            const rotation = pointerRotation(rotationDrag.center, rotationDrag.start, worldPos, rotationDrag.rotation, true);
            if ((placement.rotation || 0) === rotation) return;
            previewPlacementPose(app, componentId, { rotation });
            app.updateRatsnest?.({ nets: rotationDrag.nets, skipFillRefresh: true });
        },
        endAnchorDrag(commit) {
            if (!rotationDrag) return;
            const placement = app.placements?.get(componentId);
            const before = rotationDrag.rotation;
            rotationDrag = null;
            endRotationHandleDrag(app);
            if (!placement) {
                finishPlacementPreview(app);
                return;
            }
            const after = placement.rotation || 0;
            if (commit && !placement.locked && after !== before) {
                // Seed automatic-placement history from the original pose, without repainting it.
                placement.rotation = before;
                finishPlacementPreview(app, () => app.history.execute(new RotatePlacementCommand(app, componentId, before, after)));
            } else if (after !== before) {
                placement.rotation = before;
                restorePlacementPosePreview(app);
                app.updateRatsnest?.();
            } else if (finishPlacementPreview(app)) {
                app.updateRatsnest?.();
            }
        },
        invalidate() { app._updatePcbCulling?.(); },
        render() { this.invalidate(); },
    };
}

registerPcbSelectionAdapter('component', createComponentSelectionAdapter);
