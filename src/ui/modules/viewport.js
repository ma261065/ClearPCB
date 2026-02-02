export function bindViewportControls(app) {
    app.ui.gridSize.addEventListener('change', (e) => {
        app.viewport.setGridSize(parseFloat(e.target.value));
    });

    app.ui.gridStyle.addEventListener('change', (e) => {
        app.viewport.setGridStyle(e.target.value);
    });

    app.ui.units.addEventListener('change', (e) => {
        app.viewport.setUnits(e.target.value);
        app._updateGridDropdown();
    });

    app.ui.showGrid.addEventListener('change', (e) => {
        app.viewport.setGridVisible(e.target.checked);
    });

    app.ui.snapToGrid.addEventListener('change', (e) => {
        app.viewport.snapToGrid = e.target.checked;
    });

    document.getElementById('zoomFit').addEventListener('click', () => {
        app._fitToContent();
    });

    document.getElementById('zoomIn').addEventListener('click', () => {
        app.viewport.zoomIn();
    });

    document.getElementById('zoomOut').addEventListener('click', () => {
        app.viewport.zoomOut();
    });

    document.getElementById('resetView').addEventListener('click', () => {
        app.viewport.resetView();
    });
}

export function updateGridDropdown(app) {
    const options = app.viewport.getGridOptions();
    const currentValue = app.viewport.gridSize;

    app.ui.gridSize.innerHTML = '';

    for (const opt of options) {
        const option = document.createElement('option');
        option.value = opt.value;
        option.textContent = opt.label;
        app.ui.gridSize.appendChild(option);
    }

    let closestIdx = 0;
    let closestDiff = Infinity;
    for (let i = 0; i < options.length; i++) {
        const diff = Math.abs(options[i].value - currentValue);
        if (diff < closestDiff) {
            closestDiff = diff;
            closestIdx = i;
        }
    }
    app.ui.gridSize.selectedIndex = closestIdx;

    app.viewport.setGridSize(options[closestIdx].value);
}

export function fitToContent(app) {
    // If we have a defined paper size, fit to the paper
    const paperSize = app.viewport.paperSize;
    if (paperSize) {
        // Fit to paper bounds: (0, -height) to (width, 0)
        // Paper is drawn with bottom-left at (0,0), so it extends "up" (negative Y) in SVG space if Y-down is standard,
        // Actually _drawPaperOutline uses y = -height, so top of paper is at -height, bottom at 0.
        // Add a small 2% padding so the paper border is visible
        app.viewport.fitToBounds(0, -paperSize.height, paperSize.width, 0, 2);
        return;
    }

    // Fallback: If no paper size (None), fit to shapes content
    if (app.shapes.length === 0) {
        app.viewport.resetView();
        return;
    }

    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;

    for (const shape of app.shapes) {
        const b = shape.getBounds();
        minX = Math.min(minX, b.minX);
        minY = Math.min(minY, b.minY);
        maxX = Math.max(maxX, b.maxX);
        maxY = Math.max(maxY, b.maxY);
    }

    app.viewport.fitToBounds(minX, minY, maxX, maxY, 10);
}
