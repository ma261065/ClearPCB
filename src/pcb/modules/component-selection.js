import { beginDragSession, refreshDragRatlines, releaseDragSession } from './drag-session.js';
import { getPcbSelection, isPcbSelected, registerPcbPlacementHitTest, registerPcbSelectionAdapter, getComponentSelectionHits } from './selection-registry.js';
import { lockPositionOutsideOutline } from './selection-anchors.js';
import { beginRotationHandleDrag, endRotationHandleDrag, rotationHandleAnchor, pointerRotation } from './rotation-handle.js';
import { previewPlacementPose, restorePlacementPosePreview, finishPlacementPreview, MovePlacementCommand, RotatePlacementCommand, placementTransform, isPlacementMirrored } from './track-commands.js';
import { worldToPlacementLocal } from './ref-text-geometry.js';
import { dismissTrackContextMenu, setHoverHighlight } from './track-select.js';
import { areClearancesVisible, getPadHaloGroup } from './clearance-overlay.js';
import { getPcbInteraction, setPcbInteraction } from './pcb-interactions.js';
import { isEditorActive } from './pcb-editor-api.js';
import { showContextMenu } from '../../shared/ui/context-menu.js';
import { hasAny3DModel, openComponent3DFromData, buildComponent3DTitle } from '../../components/model3d-source.js';
import { hideNetTooltip } from './net-tooltip.js';

const componentDragFrames = new WeakMap();
const hoveredComponents = new WeakMap();
const componentPopups = new WeakMap();
const PCB_LOD_PIXEL_THRESHOLD = 24;

function showFootprintCrosshair(app, placement) {
    if (!placement || !app.viewport?.setCrosshair) return;
    app.viewport.setCrosshair({ x: placement.x, y: placement.y });
}

export function getComponentDrag(app) {
    return getPcbInteraction(app, '_drag');
}

export function showComponentPopup(app, compId, message) {
    const pl = app.placements.get(compId);
    if (!pl || !app.viewport?.worldToScreen || !app.viewport?.svg) return;

    // Approximate popup anchor at footprint centre (bounds are in the
    // footprint's local space, offset by the placement translate).
    const b = pl.bounds;
    const cx = pl.x + (b ? b.x + b.width / 2 : 0);
    const cy = pl.y + (b ? b.y + b.height / 2 : 0);

    const screen = app.viewport.worldToScreen({ x: cx, y: cy });
    const svgRect = app.viewport.svg.getBoundingClientRect();

    // Remove any existing popup so rapid presses don't stack.
    componentPopups.get(app)?.remove();

    const popup = document.createElement('div');
    popup.className = 'pcb-component-popup';
    popup.textContent = message;
    popup.style.left = `${svgRect.left + screen.x}px`;
    popup.style.top = `${svgRect.top + screen.y}px`;
    document.body.appendChild(popup);
    componentPopups.set(app, popup);

    requestAnimationFrame(() => popup.classList.add('show'));
    window.setTimeout(() => {
        popup.classList.remove('show');
        window.setTimeout(() => {
            popup.remove();
            if (componentPopups.get(app) === popup) componentPopups.delete(app);
        }, 250);
    }, 1400);
}

export function beginComponentDrag(app, componentId, worldPos) {
    const placement = app.placements.get(componentId);
    if (!placement || placement.locked) return false;
    setHoverHighlight(app, null);
    hoverComponent(app, null);
    hideNetTooltip(app);
    const drag = {
        compId: componentId,
        startWorld: worldPos,
        startPos: { x: placement.x, y: placement.y },
        session: beginDragSession(app, { nets: netsForComponent(app, componentId) }),
    };
    setPcbInteraction(app, '_drag', drag);
    if (areClearancesVisible(app)) {
        const group = getPadHaloGroup(app, componentId);
        if (group) group.style.display = 'none';
        const overlay = app.getLayerGroup('clearance-overlay');
        if (overlay) {
            for (const net of drag.session.nets || []) {
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

/**
 * Hide/show footprints based on whether they intersect the viewport, and
 * collapse on-screen footprints that are drawn very small to a single
 * placeholder rect. This keeps each SVG viewBox change from repainting the
 * tens of thousands of pad/silk/text nodes of a large board.
 */
export function updatePcbCulling(app) {
    if (!app.viewport || !app.placements.size) return;
    const vb = app.viewport.getVisibleBounds();
    const w = vb.maxX - vb.minX;
    const h = vb.maxY - vb.minY;
    const margin = Math.max(w, h) * 0.5; // 50% overdraw so nothing pops in
    const minX = vb.minX - margin, maxX = vb.maxX + margin;
    const minY = vb.minY - margin, maxY = vb.maxY + margin;
    const scale = app.viewport.scale;

    for (const [compId, pl] of app.placements) {
        const b = placementWorldBounds(pl);
        if (!b) continue;
        const inView = b.maxX >= minX && b.minX <= maxX &&
                       b.maxY >= minY && b.minY <= maxY;
        // Keep every selected footprint detailed so it stays editable.
        const px = Math.max(b.maxX - b.minX, b.maxY - b.minY) * scale;
        const far = inView && px < PCB_LOD_PIXEL_THRESHOLD
            && !isPcbSelected(app, 'component', compId);

        // Detail (real geometry) is visible only when in view AND not far.
        const detailHidden = !inView || far;
        if (detailHidden !== pl._culled) {
            pl._culled = detailHidden;
            for (const el of pl.elements) el.classList.toggle('culled', detailHidden);
        }
        // Placeholder is visible only when in view AND far.
        const lodShown = inView && far;
        if (lodShown === pl._lodFar) continue;
        pl._lodFar = lodShown;
        if (pl.lodEl) {
            if (lodShown) syncLodTransform(pl);
            pl.lodEl.classList.toggle('culled', !lodShown);
        }
    }
}

/**
 * Force every footprint (and its placeholder) back to its detailed,
 * non-culled state. Used before measuring all artwork for fit-to-content,
 * since culled (display:none) groups report a zero bounding box. The next
 * view-change re-applies culling automatically.
 */
export function uncullAllPlacements(app) {
    for (const [, pl] of app.placements) {
        if (pl._culled) {
            pl._culled = false;
            for (const el of pl.elements) el.classList.remove('culled');
        }
        if (pl._lodFar) {
            pl._lodFar = false;
            if (pl.lodEl) pl.lodEl.classList.add('culled');
        }
    }
}

/**
 * The set of net names a placement's pads belong to (from the netlist).
 * Used to scope the live ratsnest rebuild during a drag to just the nets
 * that actually move with the component.
 * @param {object} app
 * @param {string} compId
 * @returns {Set<string>}
 */
export function netsForComponent(app, compId) {
    const nets = new Set();
    for (const entry of (app.netlist || [])) {
        if (!entry?.net) continue;
        for (const pin of (entry.pins || [])) {
            if (pin.componentId === compId) { nets.add(entry.net); break; }
        }
    }
    return nets;
}

/**
 * Keep a placement's LOD placeholder rect aligned with the footprint's
 * current pose. Called when revealing it and whenever the footprint moves.
 * @param {object} pl
 */
function syncLodTransform(pl) {
    if (!pl.lodEl) return;
    pl.lodEl.setAttribute('transform', placementTransform(pl));
}

/**
 * World-space AABB of a placement's footprint bounds (local courtyard/
 * outline rotated by the placement rotation and translated to position).
 * Cached and recomputed only when the placement's pose changes.
 * @param {object} pl
 * @returns {{minX:number,minY:number,maxX:number,maxY:number}|null}
 */
function placementWorldBounds(pl) {
    const b = pl.bounds;
    if (!b) return null;
    const rot = pl.rotation || 0;
    const mx = isPlacementMirrored(pl) ? -1 : 1;
    const sig = `${pl.x}|${pl.y}|${rot}|${mx}`;
    if (pl._cullSig === sig && pl._cullBounds) return pl._cullBounds;
    const rad = rot * Math.PI / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const corners = [
        [b.x, b.y],
        [b.x + b.width, b.y],
        [b.x, b.y + b.height],
        [b.x + b.width, b.y + b.height],
    ];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [lx0, ly] of corners) {
        const lx = lx0 * mx;
        const wx = pl.x + lx * cos - ly * sin;
        const wy = pl.y + lx * sin + ly * cos;
        if (wx < minX) minX = wx;
        if (wx > maxX) maxX = wx;
        if (wy < minY) minY = wy;
        if (wy > maxY) maxY = wy;
    }
    pl._cullBounds = { minX, minY, maxX, maxY };
    pl._cullSig = sig;
    return pl._cullBounds;
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
    refreshDragRatlines(app, drag.session);
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
    releaseDragSession(app, drag.session);
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

/**
 * Hit-test: find which component contains a world position.
 * Tests against the footprint's courtyard/outline bounds (the same box
 * drawn as the selection highlight). Falls back to the pad bounding-box
 * extent for footprints without stored bounds. Returns the component ID
 * or null. Iterates in insertion order and keeps the last (topmost)
 * match so overlapping components resolve to the one drawn on top.
 * @param {import('../../ui/PCBApp.js').default} app
 * @param {{x: number, y: number}} worldPos
 * @param {boolean} [all=false] Return every hit in top-to-bottom order for overlap selection.
 * @returns {string|string[]|null}
 */
export function hitTestComponent(app, worldPos, all = false) {
    let hit = null;
    const hits = all ? [] : null;
    for (const [compId, pl] of app.placements) {
        const b = pl.bounds;
        if (b) {
            // `bounds` is in footprint-LOCAL coordinates; the rendered
            // halo/LOD rects apply the full placement transform
            // (translate → rotate → mirror). Map the cursor into the same
            // local frame by inverting that transform, then test the
            // axis-aligned local bounds rect — otherwise a rotated or
            // mirrored footprint's hit box wouldn't match its halo.
            const local = worldToPlacementLocal(worldPos, pl);
            if (
                local.x >= b.x && local.x <= b.x + b.width
                && local.y >= b.y && local.y <= b.y + b.height
            ) {
                hit = compId;
                hits?.push(compId);
            }
            continue;
        }
        // Fallback: no courtyard/outline — use the union of pad bounding
        // boxes plus a small margin so the body between pads is clickable.
        const MARGIN = 0.5; // mm
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const off of (pl.padOffsets || [])) {
            const pos = pl.pads.get(off.padId);
            if (!pos) continue;
            const w = (off.width || 1.2) / 2;
            const h = (off.height || 1.2) / 2;
            if (pos.x - w < minX) minX = pos.x - w;
            if (pos.y - h < minY) minY = pos.y - h;
            if (pos.x + w > maxX) maxX = pos.x + w;
            if (pos.y + h > maxY) maxY = pos.y + h;
        }
        if (
            minX !== Infinity
            && worldPos.x >= minX - MARGIN && worldPos.x <= maxX + MARGIN
            && worldPos.y >= minY - MARGIN && worldPos.y <= maxY + MARGIN
        ) {
            hit = compId;
            hits?.push(compId);
        }
    }
    return hits ? hits.reverse() : hit;
}

/**
 * Hover highlight for a component under the select-tool cursor: a faint
 * dashed outline over the footprint's bounds, matching the selection box
 * but lighter. Skipped for the currently selected component (its solid
 * highlight already shows). Pass null to clear. The rect is appended to
 * the footprint's first layer group so it inherits the placement
 * transform (bounds are in footprint-local coords).
 * @param {import('../../ui/PCBApp.js').default} app
 * @param {string|null} compId
 */
export function hoverComponent(app, compId) {
    if (compId === getPcbSelection(app, 'component')[0]) compId = null;
    const previous = hoveredComponents.get(app) || null;
    if (previous === compId) return;
    if (previous) {
        const oldPl = app.placements.get(previous);
        oldPl?.elements?.[0]?.querySelector('.pcb-hover-highlight')?.remove();
    }
    if (compId) hoveredComponents.set(app, compId);
    else hoveredComponents.delete(app);
    if (!compId) return;
    const pl = app.placements.get(compId);
    const b = pl?.bounds;
    if (!pl?.elements?.length || !b) { hoveredComponents.delete(app); return; }
    const NS = 'http://www.w3.org/2000/svg';
    const hl = document.createElementNS(NS, 'rect');
    hl.setAttribute('class', 'pcb-hover-highlight');
    hl.setAttribute('x', String(b.x));
    hl.setAttribute('y', String(b.y));
    hl.setAttribute('width', String(b.width));
    hl.setAttribute('height', String(b.height));
    hl.setAttribute('fill', 'rgba(51,153,255,0.07)');
    hl.setAttribute('stroke', '#3399ff');
    hl.setAttribute('stroke-width', '0.1');
    hl.setAttribute('stroke-dasharray', '0.5 0.35');
    hl.setAttribute('pointer-events', 'none');
    pl.elements[0].appendChild(hl);
}

export function getHoveredComponent(app) {
    return hoveredComponents.get(app) || null;
}

/**
 * Show a small "Show 3D" context menu for a placed footprint that carries a
 * 3D OBJ model, at the given screen position. Takes the component id (not a
 * placement object) so the action resolves the *live* placement at click
 * time — mirroring the Properties button — and never acts on a placement
 * that was orphaned by an autosave/schematic re-sync between right-click
 * and selecting the menu item.
 * @param {import('../../ui/PCBApp.js').default} app
 * @param {string} compId
 * @param {number} clientX
 * @param {number} clientY
 */
export function showComponent3DMenu(app, compId, clientX, clientY) {
    if (!hasAny3DModel(app.placements.get(compId))) return;
    dismissTrackContextMenu();
    showContextMenu('pcbTrackContextMenu',
        [{ text: '🧊 Show 3D', onClick: () => openComponent3DPopout(app, compId) }], clientX, clientY);
}

/**
 * Open the interactive 3D model pop-out for a placement (or compId).
 * @param {import('../../ui/PCBApp.js').default} app
 * @param {string|object} placementOrId
 */
export function openComponent3DPopout(app, placementOrId) {
    const pl = typeof placementOrId === 'string'
        ? app.placements.get(placementOrId)
        : placementOrId;
    if (!hasAny3DModel(pl)) return;
    const title = buildComponent3DTitle(pl);
    openComponent3DFromData({ data: pl, title })
        .then((ok) => {
            if (!ok) console.warn('No renderable 3D model found for component');
        })
        .catch(err => console.error('Failed to open 3D pop-out:', err));
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
                rotation: placement.rotation || 0, nets: netsForComponent(app, componentId),
            };
            beginRotationHandleDrag(app);
            hoverComponent(app, null);
            hideNetTooltip(app);
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
        invalidate() { updatePcbCulling(app); },
        render() { this.invalidate(); },
    };
}

registerPcbSelectionAdapter('component', createComponentSelectionAdapter);
registerPcbPlacementHitTest('component', hitTestComponent);
