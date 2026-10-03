/**
 * Schematic view lifecycle. The only editor code that creates, attaches, redraws,
 * culls or detaches entity SVG: commands, file loading, clipboard and theme
 * changes call these helpers instead of touching `element`, `anchorsGroup`,
 * `render()` or the viewport content layers. Entity SVG is built by
 * src/schematic/render.
 */
import { syncAttachedLabels, updateLabelGuide } from '../../ui/modules/label-attachment.js';
import { arcEdgePathD } from '../../shapes/arc-edge.js';
import { appendSegmentSelection } from '../../core/ui-helpers.js';
import { refreshAxisGlow } from '../../shapes/axis-glow.js';
import { NO_SELECTION } from '../../shapes/selection-view.js';
import { Component } from '../../components/Component.js';
import { renderShape, updateShapeAnchors, effectiveStrokeWidth } from '../render/shape-renderer.js';
import { viewOf, deleteView, componentViewOf } from '../render/shape-view-state.js';
import {
    buildComponentSymbol,
    componentTransform,
    discardComponent,
    rebuildComponentSymbol as rebuildComponentSymbolView,
    renderComponent,
} from '../render/component-renderer.js';

/** Shape types that render above wires (re-appended at end of each render cycle). */
const OVERLAY_TYPES = new Set(['noconnect', 'net']);

/**
 * On-screen size (in CSS pixels) below which a component is drawn as a single
 * level-of-detail placeholder rect instead of its full symbol graphics.
 */
const LOD_PIXEL_THRESHOLD = 16;

/**
 * Selected/hovered state for rendering: the editor's SelectionManager, or
 * NO_SELECTION when there is none (headless callers, previews).
 * @returns {import('../../shapes/selection-view.js').SelectionView}
 */
export function selectionView(app) {
    const selection = app.selection;
    return typeof selection?.isSelected === 'function' && typeof selection.isHovered === 'function'
        ? selection : NO_SELECTION;
}

/**
 * SelectionManager `invalidateEntity` hook: mark an entity whose selection,
 * hover or ownership tint changed for redraw. Component highlights update at
 * once, because selection changes are not always followed by a render pass.
 */
export function refreshSelectionVisual(app, entity) {
    entity.invalidate();
    if (entity instanceof Component) renderComponent(entity, app.viewport?.scale ?? 1, { selection: selectionView(app) });
}

/** Draw a shape and attach it to the content layer. */
export function mountShape(app, shape) {
    const element = renderShape(shape, app.viewport.scale, { selection: selectionView(app) });
    app.viewport.addContent(element);
}

/** Mount a shape unless its SVG is already attached. */
export function ensureShapeMounted(app, shape) {
    if (!viewOf(shape)?.element?.parentNode) mountShape(app, shape);
}

/** Detach a shape's SVG and anchor handles, keeping them for a later mount. */
export function unmountShape(shape) {
    const view = viewOf(shape);
    if (view?.element?.parentNode) view.element.parentNode.removeChild(view.element);
    if (view?.anchorsGroup?.parentNode) view.anchorsGroup.parentNode.removeChild(view.anchorsGroup);
}

/** Redraw a mounted shape now (outside the batched renderShapes pass). */
export function redrawShape(app, shape) {
    renderShape(shape, app.viewport.scale, { selection: selectionView(app) });
}

/** Build a component symbol if needed and attach it to the component layer. */
export function mountComponent(app, component) {
    let element = componentViewOf(component)?.element;
    if (!element) element = buildComponentSymbol(component);
    app.viewport.addComponentContent(element);
}

/** Detach a component symbol, keeping it for a later mount. */
export function unmountComponent(component) {
    const element = componentViewOf(component)?.element;
    if (element?.parentNode) element.parentNode.removeChild(element);
}

/** Rebuild a component symbol from scratch (theme colours changed). */
export function rebuildComponentSymbol(app, component) {
    componentViewOf(component)?.element?.remove();
    app.viewport.addComponentContent(buildComponentSymbol(component));
}

/**
 * Bring a component symbol up to date after its pose changed. Rotation and
 * mirroring are baked into the symbol, so `rebuild` recreates it first.
 */
export function refreshComponentPose(component, { rebuild = false } = {}) {
    if (rebuild) rebuildComponentSymbolView(component);
    const element = componentViewOf(component)?.element;
    if (!element) return;
    const transform = componentTransform(component);
    if (transform) element.setAttribute('transform', transform);
    else element.removeAttribute('transform');
}

/** Detach and release a shape's SVG for good (document cleared). */
export function discardShapeView(app, shape) {
    const view = viewOf(shape);
    if (view?.element) app.viewport.removeContent(view.element);
    view?.anchorsGroup?.remove?.();
    deleteView(shape);
}

/** Detach and release a component symbol for good (document cleared). */
export function discardComponentView(app, component) {
    const element = componentViewOf(component)?.element;
    if (element) app.viewport.removeContent(element);
    discardComponent(component);
}

/** Build SVG for a prepared document before it replaces the live one. */
export function prepareDocumentView(app, prepared) {
    for (const { shape } of prepared.shapes) renderShape(shape, app.viewport.scale);
    for (const component of prepared.components) buildComponentSymbol(component);
}

/** Attach every loaded shape and prebuilt component symbol. */
export function mountDocument(app) {
    for (const shape of app.shapes) mountShape(app, shape);
    for (const component of app.components) mountComponent(app, component);
}

/**
 * Run DOM-heavy work with the content layer detached, so many inserts and
 * removals cost one layout instead of one each.
 * @template T
 * @param {object} app
 * @param {() => T} work
 * @returns {T}
 */
export function withContentDetached(app, work) {
    const layer = app.viewport.contentLayer;
    const parent = layer.parentNode;
    const next = layer.nextSibling;
    if (parent) parent.removeChild(layer);
    try {
        return work();
    } finally {
        if (parent) parent.insertBefore(layer, next);
    }
}

/** An entity's live SVG (read-only use, e.g. measuring text for inline edit), or null. */
export function viewElementOf(entity) {
    if (!entity) return null;
    if (entity instanceof Component) return componentViewOf(entity)?.element || null;
    return viewOf(entity)?.element || null;
}

/** Copy of an entity's current SVG (paste ghost), or null when it has none. */
export function cloneEntityElement(entity) {
    const element = viewElementOf(entity);
    return element ? element.cloneNode(true) : null;
}

/** Free-standing symbol SVG for a placement or paste preview. */
export function componentPreviewElement(component) {
    return buildComponentSymbol(component);
}

/** Free-standing shape SVG for a paste preview. */
export function shapePreviewElement(app, shape) {
    return renderShape(shape, app.viewport.scale);
}

/** Whether viewport culling has hidden this entity. */
export function isCulled(entity) {
    return !!entity._culled;
}

/**
 * Re-renders all visible (non-culled) shapes and components. If `force` is true,
 * invalidates hit-test cache and recalculates stroke widths on zoom.
 * @param {object} app - Application state.
 * @param {boolean} [force=false] - Force full re-render regardless of dirty state.
 */
/**
 * Viewport scale of each editor's last completed renderShapes pass. Every render
 * path draws at the current scale, so clean shapes only need the zoom fast path
 * after the scale changes; skipping it otherwise keeps hover frames lookup-free.
 * @type {WeakMap<object, number>}
 */
const lastPassScale = new WeakMap();

export function renderShapes(app, force = false) {
    syncAttachedLabels(app);

    if (force && app.selection) {
        app.selection.invalidateHitCache();
    }
    const scale = app.viewport.scale;
    const view = selectionView(app);
    const scaleChanged = lastPassScale.get(app) !== scale;
    for (const shape of app.shapes) {
        if (shape._culled) continue; // skip off-screen
        const selected = view.isSelected(shape);
        if (force || shape._dirty || selected || view.isHovered(shape)) {
            const selectedNodeId = app._selectedShapeNode?.shapeId === shape.id
                ? app._selectedShapeNode.nodeId : null;
            const refined = app._selectedShapeSegment?.shapeId === shape.id || selectedNodeId != null;
            renderShape(shape, scale, {
                suppressSelection: refined,
                selection: view,
            });
            if (refined && selected && shape.type === 'polyline') {
                updateShapeAnchors(shape, scale, true, selectedNodeId);
            }
        } else if (scaleChanged) {
            const shapeView = viewOf(shape);
            if (shapeView?.lastScale !== scale && shapeView?.element) {
                // Only stroke-width changed on zoom or force — fast-path update
                const sw = effectiveStrokeWidth(shape, scale);
                if (sw > 0) shapeView.element.setAttribute('stroke-width', sw);
                shapeView.lastScale = scale;
            }
        }
    }
    
    // Only render components that actually need visual updates
    for (const comp of app.components) {
        if (comp._culled) continue; // skip off-screen
        if (comp._dirty || view.isSelected(comp) || view.isHovered(comp) || comp.locked) {
            renderComponent(comp, scale, { selection: view });
        }
    }

    // Ensure overlay-type shapes (noconnect, Net) render above wires.
    // Selected-shape rendering calls appendChild() which can move wire SVG
    // elements past overlay shapes. Re-append overlay shape elements (and
    // their anchor groups) as the last children of contentLayer so they
    // always paint on top.  Skip when shapes are selected so anchor
    // handles remain accessible during editing.
    if (!app.selection?.count) {
        const cl = app.viewport.contentLayer;
        for (const shape of app.shapes) {
            const shapeView = viewOf(shape);
            if (shape._culled || !shapeView?.element) continue;
            if (OVERLAY_TYPES.has(shape.type)) {
                cl.appendChild(shapeView.element);
                if (shapeView.anchorsGroup && shapeView.anchorsGroup.parentNode) {
                    cl.appendChild(shapeView.anchorsGroup);
                }
            }
        }
    }
    lastPassScale.set(app, scale);
    renderShapeSegmentSelection(app);
    refreshAxisGlow(app);
    updateLabelGuide(app);
}

/** Render the refined edge of a selected schematic polyline above the shape. */
export function renderShapeSegmentSelection(app) {
    app._shapeSegmentSelectionElement?.remove?.();
    app._shapeSegmentSelectionElement = null;
    const selected = app._selectedShapeSegment;
    const shape = selected ? app.shapes.find((candidate) => candidate.id === selected.shapeId) : null;
    if (!shape || !selectionView(app).isSelected(shape) || shape.type !== 'polyline') return;
    const edge = shape.edges?.get(selected.edgeId);
    const first = edge ? shape.nodes?.get(edge.from) : null;
    const second = edge ? shape.nodes?.get(edge.to) : null;
    if (!first || !second) return;
    const NS = 'http://www.w3.org/2000/svg';
    const bulge = shape.getEdgeAttr?.(selected.edgeId, 'bulge') || 0;
    const straight = bulge ? null : shape.getStraightEdgePortion(selected.edgeId);
    if (!bulge && !straight) return;
    const element = document.createElementNS(NS, bulge ? 'path' : 'line');
    if (bulge) {
        element.setAttribute('d', arcEdgePathD(first, second, bulge));
        element.setAttribute('fill', 'none');
    } else {
        element.setAttribute('x1', String(straight.first.x));
        element.setAttribute('y1', String(straight.first.y));
        element.setAttribute('x2', String(straight.second.x));
        element.setAttribute('y2', String(straight.second.y));
    }
    element.setAttribute('class', 'schematic-shape-segment-selection');
    const width = Math.max(Number(shape.getEdgeAttr(selected.edgeId, 'width')) || shape.lineWidth,
        1 / app.viewport.scale);
    const overlay = app.viewport.contentLayer;
    const anchorsGroup = viewOf(shape)?.anchorsGroup;
    const handles = anchorsGroup?.parentNode === overlay ? anchorsGroup : null;
    appendSegmentSelection(overlay, element, '#e94560', width, handles);
    app._shapeSegmentSelectionElement = element;
}

/** Clear refined schematic segment state and its independent SVG overlay. */
export function clearShapeSegmentSelection(app) {
    app._selectedShapeSegment = null;
    app._shapeSegmentSelectionElement?.remove?.();
    app._shapeSegmentSelectionElement = null;
}

/**
 * Viewport culling — hide/show shapes & components based on whether they
 * intersect the visible viewport.  Uses a generous margin so elements
 * don't pop in during fast panning.
 */
export function updateViewportCulling(app) {
    const bounds = app.viewport.getVisibleBounds();
    const w = bounds.maxX - bounds.minX;
    const h = bounds.maxY - bounds.minY;
    const margin = Math.max(w, h) * 0.5; // 50 % overdraw

    const minX = bounds.minX - margin;
    const maxX = bounds.maxX + margin;
    const minY = bounds.minY - margin;
    const maxY = bounds.maxY + margin;
    const scale = app.viewport.scale;
    const view = selectionView(app);

    for (const shape of app.shapes) {
        const b = shape.getBounds();
        const inView = b.maxX >= minX && b.minX <= maxX &&
                       b.maxY >= minY && b.minY <= maxY;

        if (inView && shape._culled) {
            // scrolled into view — un-cull and re-render
            shape._culled = false;
            const shapeView = viewOf(shape);
            if (shapeView?.element) shapeView.element.classList.remove('culled');
            if (shapeView?.anchorsGroup) shapeView.anchorsGroup.classList.remove('culled');
            renderShape(shape, scale, { selection: view });
        } else if (!inView && !shape._culled) {
            // scrolled out of view — cull
            shape._culled = true;
            const shapeView = viewOf(shape);
            if (shapeView?.element) shapeView.element.classList.add('culled');
            if (shapeView?.anchorsGroup) shapeView.anchorsGroup.classList.add('culled');
        }
    }

    for (const comp of app.components) {
        const b = comp.getBounds();
        if (!b) continue;
        const compView = componentViewOf(comp);
        const inView = b.maxX >= minX && b.minX <= maxX &&
                       b.maxY >= minY && b.minY <= maxY;

        if (inView && comp._culled) {
            comp._culled = false;
            if (compView?.element) compView.element.classList.remove('culled');
            renderComponent(comp, scale, { selection: view });
        } else if (!inView && !comp._culled) {
            comp._culled = true;
            if (compView?.element) compView.element.classList.add('culled');
        }

        // Level-of-detail: when an in-view component is drawn smaller than a
        // few pixels, collapse it to its placeholder rect so the SVG renderer
        // paints one node instead of dozens. Skip selected/hovered components
        // so editing always shows full detail.
        if (!comp._culled && compView?.element) {
            const px = Math.max(b.maxX - b.minX, b.maxY - b.minY) * scale;
            const far = px < LOD_PIXEL_THRESHOLD && !view.isSelected(comp) && !view.isHovered(comp);
            if (far !== compView.lodFar) {
                compView.lodFar = far;
                compView.element.classList.toggle('lod-far', far);
            }
        }
    }
}
