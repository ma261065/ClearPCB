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
