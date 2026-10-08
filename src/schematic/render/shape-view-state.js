/** @typedef {import('../../core/SchematicDocument.js').SchematicDrawable} SchematicDrawable */
/** @typedef {import('../../components/Component.js').Component} Component */
/** @typedef {{element: SVGElement|null, anchorsGroup: SVGGElement|null, lastScale: number|undefined, anchorRects: SVGElement[]|null, anchorsHaveLock: boolean, culled: boolean}} ShapeView */
/** @typedef {{element: SVGGElement|null, pinElements: Map<string|number|undefined, SVGGElement>, highlightEl: SVGRectElement|null, lockIconEl: SVGElement|null, lodFar: boolean, culled: boolean}} ComponentView */

/** @type {WeakMap<SchematicDrawable, ShapeView>} */
const shapeViews = new WeakMap();

/** @param {SchematicDrawable} shape */
export function viewOf(shape) {
    return shapeViews.get(shape);
}

/** @param {SchematicDrawable} shape */
export function ensureView(shape) {
    let view = shapeViews.get(shape);
    if (!view) {
        view = {
            element: null,
            anchorsGroup: null,
            lastScale: undefined,
            anchorRects: null,
            anchorsHaveLock: false,
            culled: false,
        };
        shapeViews.set(shape, view);
    }
    return view;
}

/** @param {SchematicDrawable} shape */
export function deleteView(shape) {
    shapeViews.delete(shape);
}

/** @param {SchematicDrawable|null|undefined} shape */
export function isShapeCulled(shape) {
    return !!shape && !!shapeViews.get(shape)?.culled;
}

/** @param {SchematicDrawable} shape @param {boolean} culled */
export function setShapeCulled(shape, culled) {
    ensureView(shape).culled = culled;
}

/** @type {WeakMap<object, ComponentView>} */
const componentViews = new WeakMap();

/** @param {object} component */
export function componentViewOf(component) {
    return componentViews.get(component);
}

/** @param {object} component */
export function ensureComponentView(component) {
    let view = componentViews.get(component);
    if (!view) {
        view = {
            element: null,
            pinElements: new Map(),
            highlightEl: null,
            lockIconEl: null,
            lodFar: false,
            culled: false,
        };
        componentViews.set(component, view);
    }
    return view;
}

/** @param {object} component */
export function deleteComponentView(component) {
    componentViews.delete(component);
}

/** @param {object|null|undefined} component */
export function isComponentCulled(component) {
    return !!component && !!componentViews.get(component)?.culled;
}

/** @param {object} component @param {boolean} culled */
export function setComponentCulled(component, culled) {
    ensureComponentView(component).culled = culled;
}
