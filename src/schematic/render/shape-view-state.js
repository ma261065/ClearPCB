/** @typedef {import('../../core/SchematicDocument.js').SchematicShape} SchematicShape */
/** @typedef {import('../../components/Component.js').Component} Component */
/** @typedef {{element: SVGElement|null, anchorsGroup: SVGGElement|null, lastScale: number|undefined, anchorRects: SVGElement[]|null, anchorsHaveLock: boolean}} ShapeView */
/** @typedef {{element: SVGGElement|null, pinElements: Map<string|number|undefined, SVGGElement>, highlightEl: SVGRectElement|null, lockIconEl: SVGElement|null, lodFar: boolean}} ComponentView */

/** @type {WeakMap<SchematicShape, ShapeView>} */
const shapeViews = new WeakMap();

/** @param {SchematicShape} shape */
export function viewOf(shape) {
    return shapeViews.get(shape);
}

/** @param {SchematicShape} shape */
export function ensureView(shape) {
    let view = shapeViews.get(shape);
    if (!view) {
        view = {
            element: null,
            anchorsGroup: null,
            lastScale: undefined,
            anchorRects: null,
            anchorsHaveLock: false,
        };
        shapeViews.set(shape, view);
    }
    return view;
}

/** @param {SchematicShape} shape */
export function deleteView(shape) {
    shapeViews.delete(shape);
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
        };
        componentViews.set(component, view);
    }
    return view;
}

/** @param {object} component */
export function deleteComponentView(component) {
    componentViews.delete(component);
}
