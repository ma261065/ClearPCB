/**
 * Schematic view lifecycle. The only editor code that creates, attaches, redraws,
 * culls or detaches entity SVG: commands, file loading, clipboard and theme
 * changes call these helpers instead of touching `element`, `anchorsGroup`,
 * `render()` or the viewport content layers. Entities still build their own SVG
 * (`Shape.render`, `Component.createSymbolElement`) behind this boundary.
 */
import { syncAttachedLabels, updateLabelGuide } from '../../ui/modules/label-attachment.js';
import { arcEdgePathD } from '../../shapes/arc-edge.js';
import { appendSegmentSelection } from '../../core/ui-helpers.js';
import { refreshAxisGlow } from '../../shapes/axis-glow.js';

/** Shape types that render above wires (re-appended at end of each render cycle). */
const OVERLAY_TYPES = new Set(['noconnect', 'net']);

/**
 * On-screen size (in CSS pixels) below which a component is drawn as a single
 * level-of-detail placeholder rect instead of its full symbol graphics.
 */
const LOD_PIXEL_THRESHOLD = 16;

/** Draw a shape and attach it to the content layer. */
export function mountShape(app, shape) {
    shape.render(app.viewport.scale);
    app.viewport.addContent(shape.element);
}

/** Mount a shape unless its SVG is already attached. */
export function ensureShapeMounted(app, shape) {
    if (!shape.element?.parentNode) mountShape(app, shape);
}

/** Detach a shape's SVG and anchor handles, keeping them for a later mount. */
export function unmountShape(shape) {
    if (shape.element?.parentNode) shape.element.parentNode.removeChild(shape.element);
    if (shape.anchorsGroup?.parentNode) shape.anchorsGroup.parentNode.removeChild(shape.anchorsGroup);
}

/** Redraw a mounted shape now (outside the batched renderShapes pass). */
export function redrawShape(app, shape) {
    shape.render(app.viewport.scale);
}

/** Build a component symbol if needed and attach it to the component layer. */
export function mountComponent(app, component) {
    if (!component.element) component.createSymbolElement();
    app.viewport.addComponentContent(component.element);
}

/** Detach a component symbol, keeping it for a later mount. */
export function unmountComponent(component) {
    if (component.element?.parentNode) component.element.parentNode.removeChild(component.element);
}

/** Rebuild a component symbol from scratch (theme colours changed). */
export function rebuildComponentSymbol(app, component) {
    component.element?.remove();
    app.viewport.addComponentContent(component.createSymbolElement());
}

/**
 * Bring a component symbol up to date after its pose changed. Rotation and
 * mirroring are baked into the symbol, so `rebuild` recreates it first.
 */
export function refreshComponentPose(component, { rebuild = false } = {}) {
    if (rebuild) component._recreateElement();
    if (!component.element) return;
    const transform = component._buildTransform();
    if (transform) component.element.setAttribute('transform', transform);
    else component.element.removeAttribute('transform');
}

/** Detach and release a shape's SVG for good (document cleared). */
export function discardShapeView(app, shape) {
    if (shape.element) app.viewport.removeContent(shape.element);
    shape.destroy();
}

/** Detach and release a component symbol for good (document cleared). */
export function discardComponentView(app, component) {
    if (component.element) app.viewport.removeContent(component.element);
    component.destroy();
}

/** Build SVG for a prepared document before it replaces the live one. */
export function prepareDocumentView(app, prepared) {
    for (const { shape } of prepared.shapes) shape.render(app.viewport.scale);
    for (const component of prepared.components) component.createSymbolElement();
}

/** Attach every loaded shape and prebuilt component symbol. */
export function mountDocument(app) {
    for (const shape of app.shapes) mountShape(app, shape);
    for (const component of app.components) app.viewport.addComponentContent(component.element);
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
    return entity?.element || null;
}

/** Copy of an entity's current SVG (paste ghost), or null when it has none. */
export function cloneEntityElement(entity) {
    return entity.element ? entity.element.cloneNode(true) : null;
}

/** Free-standing symbol SVG for a placement or paste preview. */
export function componentPreviewElement(component) {
    return component.createSymbolElement();
}

/** Free-standing shape SVG for a paste preview. */
export function shapePreviewElement(app, shape) {
    return shape.render(app.viewport.scale);
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
export function renderShapes(app, force = false) {
    syncAttachedLabels(app);

    if (force && app.selection) {
        app.selection.invalidateHitCache();
    }
    const scale = app.viewport.scale;
    for (const shape of app.shapes) {
        if (shape._culled) continue; // skip off-screen
        if (force || shape._dirty || shape.selected || shape.hovered) {
            const selectedNodeId = app._selectedShapeNode?.shapeId === shape.id
                ? app._selectedShapeNode.nodeId : null;
            const refined = app._selectedShapeSegment?.shapeId === shape.id || selectedNodeId != null;
            shape.render(scale, {
                suppressSelection: refined,
            });
            if (refined && shape.selected && shape.type === 'polyline') {
                shape._updateAnchors(scale, true, selectedNodeId);
            }
        } else if (shape._lastScale !== scale && shape.element) {
            // Only stroke-width changed on zoom or force — fast-path update
            const sw = shape._getEffectiveStrokeWidth(scale);
            if (sw > 0) shape.element.setAttribute('stroke-width', sw);
            shape._lastScale = scale;
        }
    }
    
    // Only render components that actually need visual updates
    for (const comp of app.components) {
        if (comp._culled) continue; // skip off-screen
        if (comp.selected || comp.hovered || comp.locked) {
            comp.render(scale);
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
            if (shape._culled || !shape.element) continue;
            if (OVERLAY_TYPES.has(shape.type)) {
                cl.appendChild(shape.element);
                if (shape.anchorsGroup && shape.anchorsGroup.parentNode) {
                    cl.appendChild(shape.anchorsGroup);
                }
            }
        }
    }
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
    if (!shape || !shape.selected || shape.type !== 'polyline') return;
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
    const handles = shape.anchorsGroup?.parentNode === overlay ? shape.anchorsGroup : null;
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

    for (const shape of app.shapes) {
        const b = shape.getBounds();
        const inView = b.maxX >= minX && b.minX <= maxX &&
                       b.maxY >= minY && b.minY <= maxY;

        if (inView && shape._culled) {
            // scrolled into view — un-cull and re-render
            shape._culled = false;
            if (shape.element) shape.element.classList.remove('culled');
            if (shape.anchorsGroup) shape.anchorsGroup.classList.remove('culled');
            shape.render(scale);
        } else if (!inView && !shape._culled) {
            // scrolled out of view — cull
            shape._culled = true;
            if (shape.element) shape.element.classList.add('culled');
            if (shape.anchorsGroup) shape.anchorsGroup.classList.add('culled');
        }
    }

    for (const comp of app.components) {
        const b = comp.getBounds();
        if (!b) continue;
        const inView = b.maxX >= minX && b.minX <= maxX &&
                       b.maxY >= minY && b.minY <= maxY;

        if (inView && comp._culled) {
            comp._culled = false;
            if (comp.element) comp.element.classList.remove('culled');
            comp.render(scale);
        } else if (!inView && !comp._culled) {
            comp._culled = true;
            if (comp.element) comp.element.classList.add('culled');
        }

        // Level-of-detail: when an in-view component is drawn smaller than a
        // few pixels, collapse it to its placeholder rect so the SVG renderer
        // paints one node instead of dozens. Skip selected/hovered components
        // so editing always shows full detail.
        if (!comp._culled && comp.element) {
            const px = Math.max(b.maxX - b.minX, b.maxY - b.minY) * scale;
            const far = px < LOD_PIXEL_THRESHOLD && !comp.selected && !comp.hovered;
            if (far !== comp._lodFar) {
                comp._lodFar = far;
                comp.element.classList.toggle('lod-far', far);
            }
        }
    }
}
