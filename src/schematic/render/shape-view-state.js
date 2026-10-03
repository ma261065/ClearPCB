const shapeViews = new WeakMap();

export function viewOf(shape) {
    return shapeViews.get(shape);
}

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

export function deleteView(shape) {
    shapeViews.delete(shape);
}

const componentViews = new WeakMap();

export function componentViewOf(component) {
    return componentViews.get(component);
}

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

export function deleteComponentView(component) {
    componentViews.delete(component);
}
