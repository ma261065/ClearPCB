export function createBoxSelectElement(app) {
    app.boxSelectElement = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    app.boxSelectElement.setAttribute('fill', 'rgba(51, 153, 255, 0.15)');
    app.boxSelectElement.setAttribute('stroke', '#3399ff');
    app.boxSelectElement.setAttribute('stroke-width', 1 / app.viewport.scale);
    app.boxSelectElement.setAttribute('stroke-dasharray', `${4 / app.viewport.scale} ${4 / app.viewport.scale}`);
    app.boxSelectElement.style.pointerEvents = 'none';
    app.viewport.contentLayer.appendChild(app.boxSelectElement);
}

export function updateBoxSelectElement(app, currentPos) {
    if (!app.boxSelectElement || !app.boxSelectStart) return;

    const x = Math.min(app.boxSelectStart.x, currentPos.x);
    const y = Math.min(app.boxSelectStart.y, currentPos.y);
    const width = Math.abs(currentPos.x - app.boxSelectStart.x);
    const height = Math.abs(currentPos.y - app.boxSelectStart.y);

    app.boxSelectElement.setAttribute('x', x);
    app.boxSelectElement.setAttribute('y', y);
    app.boxSelectElement.setAttribute('width', width);
    app.boxSelectElement.setAttribute('height', height);
}

export function removeBoxSelectElement(app) {
    if (app.boxSelectElement) {
        app.boxSelectElement.remove();
        app.boxSelectElement = null;
    }
}

export function getBoxSelectBounds(app, currentPos) {
    return {
        minX: Math.min(app.boxSelectStart.x, currentPos.x),
        minY: Math.min(app.boxSelectStart.y, currentPos.y),
        maxX: Math.max(app.boxSelectStart.x, currentPos.x),
        maxY: Math.max(app.boxSelectStart.y, currentPos.y)
    };
}
