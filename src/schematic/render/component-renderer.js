import { createLockIcon } from '../../core/ui-helpers.js';
import { schematicLockPosition } from './lock-placement.js';
import { NO_SELECTION } from '../../shapes/selection-view.js';
import { ensureComponentView, deleteComponentView, componentViewOf } from './shape-view-state.js';
import { createSymbolGraphicElement, createSymbolPinElement } from '../../components/symbol-svg.js';

/** @typedef {import('../../components/Component.js').Component} Component */
/** @typedef {import('../../shapes/text.js').Text} Text */

const NS = 'http://www.w3.org/2000/svg';

/**
 * Create the SVG `<g>` element for a component including all graphic shapes and pins.
 * @param {Component} component
 * @param {string} [ns]
 * @returns {SVGGElement}
 */
export function buildComponentSymbol(component, ns = NS) {
    const viewState = ensureComponentView(component);
    viewState.pinElements.clear();
        const group = /** @type {SVGGElement} */ (document.createElementNS(ns, 'g'));
        group.setAttribute('class', 'component');
        group.setAttribute('data-id', component.id);
        
        const transform = componentTransform(component);
        if (transform) group.setAttribute('transform', transform);

        // Level-of-detail placeholder: a single rect covering the symbol,
        // hidden by default and revealed via the `.lod-far` class when the
        // component is drawn very small. Replacing the dozens of graphic/pin
        // nodes with one rect keeps zoomed-out pan/zoom fast on large boards.
        const lb = component._getLocalBounds();
        const lod = document.createElementNS(ns, 'rect');
        lod.setAttribute('class', 'cpcb-lod-rect');
        lod.setAttribute('x', String(lb.minX));
        lod.setAttribute('y', String(lb.minY));
        lod.setAttribute('width', String(Math.max(0, lb.maxX - lb.minX)));
        lod.setAttribute('height', String(Math.max(0, lb.maxY - lb.minY)));
        group.appendChild(lod);

        if (component.symbol?.graphics) {
            for (const graphic of component.symbol.graphics) {
                const el = createSymbolGraphicElement(component, graphic, ns);
                if (el) group.appendChild(el);
            }
        }

        if (component.symbol?.pins) {
            for (const pin of component.symbol.pins) {
                // KiCad hides certain pins (e.g. no-connect / duplicate
                // hidden pins). Match KiCad's default view: don't draw them.
                if (pin.hidden) continue;
                const pinGroup = createSymbolPinElement(component, pin, ns);
                if (pinGroup) {
                    group.appendChild(pinGroup);
                    const pinKey = pin._key || pin._id || pin.number || `${pin.x},${pin.y}`;
                    viewState.pinElements.set(pinKey, pinGroup);
                }
            }
        }
        
        viewState.element = group;
        return group;
}

/**
 * Rebuild the component SVG element in-place.
 * @param {Component} component
 * @returns {SVGGElement}
 */
export function rebuildComponentSymbol(component) {
    const viewState = ensureComponentView(component);
    const parent = viewState.element?.parentNode;
    if (viewState.element) viewState.element.remove();
    viewState.pinElements.clear();
    const element = buildComponentSymbol(component);
    if (parent) parent.appendChild(element);
    return element;
}

/**
 * Build the SVG transform string for the component's position and rotation.
 * @param {Component} component
 * @returns {string|null}
 */
export function componentTransform(component) {
        const parts = [];
        if (component.x || component.y) parts.push(`translate(${component.x},${component.y})`);
        if (component.rotation) parts.push(`rotate(${component.rotation})`);
        return parts.length ? parts.join(' ') : null;
}

/**
 * Render the component with optional highlight and lock icon.
 * @param {Component} component
 * @param {number} scale
 * @param {{selection?: import('../../shapes/selection-view.js').SelectionView}} [options]
 * @returns {SVGGElement|null}
 */
export function renderComponent(component, scale, options = {}) {
    const viewState = componentViewOf(component);
    const element = viewState?.element;
    if (!element) return null;
    const transform = componentTransform(component);
    if (transform) element.setAttribute('transform', transform);
    else element.removeAttribute('transform');
    const view = options.selection || NO_SELECTION;
    component._dirty = false;

    updateHighlight(component, view);

    if (viewState.lockIconEl) {
        viewState.lockIconEl.remove();
        viewState.lockIconEl = null;
    }

    // The lock is drawn in world space beside the component, not inside its group,
    // so it never rotates or mirrors with the symbol.
    const position = component.locked && view.isSelected(component)
        ? schematicLockPosition(component, view.lockPointer, scale) : null;
    if (position) {
        viewState.lockIconEl = createLockIcon(position.x, position.y, component, 'component-lock-icon', scale);
        if (element.parentNode) element.parentNode.insertBefore(viewState.lockIconEl, element.nextSibling);
        else element.appendChild(viewState.lockIconEl);
    }
    return element;
}

/** @param {{id: string, [key: string]: unknown}} component @param {string|number|undefined} pinKey */
export function componentPinElement(component, pinKey) {
    return componentViewOf(component)?.pinElements.get(pinKey) || null;
}

/** @param {Component} component */
export function discardComponent(component) {
    const viewState = componentViewOf(component);
    viewState?.element?.remove?.();
    viewState?.highlightEl?.remove?.();
    viewState?.lockIconEl?.remove?.();
    deleteComponentView(component);
}

/**
 * @param {Component} component
 * @param {import('../../shapes/selection-view.js').SelectionView} [view]
 */
function updateHighlight(component, view = NO_SELECTION) {
    const viewState = componentViewOf(component);
    const element = viewState?.element;
    if (!element || !viewState) return;
    const selected = view.isSelected(component);

    const fieldTextSelected = component.getFieldTexts().some(/** @param {Text} ft */ (ft) => view.isSelected(ft));

    if (!view.isHovered(component) && !selected && !fieldTextSelected) {
        if (viewState.highlightEl) {
            viewState.highlightEl.remove();
            viewState.highlightEl = null;
        }
        for (const pinGroup of viewState.pinElements.values()) {
            const dot = pinGroup.querySelector('circle');
            if (dot) dot.setAttribute('display', 'none');
        }
        return;
    }

    const bounds = component.getBounds();
    if (!bounds) return;

    const localBounds = component._getLocalBounds();
    const minX = localBounds.minX;
    const minY = localBounds.minY;
    const maxX = localBounds.maxX;
    const maxY = localBounds.maxY;

    let highlight = viewState.highlightEl;
    if (!highlight) {
        highlight = document.createElementNS(NS, 'rect');
        highlight.setAttribute('class', 'component-highlight');
        highlight.setAttribute('pointer-events', 'none');
        viewState.highlightEl = highlight;
    }

    highlight.setAttribute('x', String(minX - 0.5));
    highlight.setAttribute('y', String(minY - 0.5));
    highlight.setAttribute('width', String(maxX - minX + 1));
    highlight.setAttribute('height', String(maxY - minY + 1));
    highlight.setAttribute('fill', selected ? 'var(--sch-selection-fill, rgba(51,153,255,0.2))' : 'none');
    highlight.setAttribute('stroke', 'var(--sch-selection, #3399ff)');
    highlight.setAttribute('stroke-width', '0.15');
    highlight.setAttribute('stroke-opacity', selected ? '0.6' : '0.35');
    highlight.setAttribute('stroke-dasharray', 'none');

    if (!highlight.parentNode || highlight.parentNode !== element) {
        element.insertBefore(highlight, element.firstChild);
    }

    if (selected) {
        for (const pinGroup of viewState.pinElements.values()) {
            const dot = pinGroup.querySelector('circle');
            if (dot) dot.setAttribute('display', '');
        }
    }
}
