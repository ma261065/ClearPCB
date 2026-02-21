import { Component } from '../../components/index.js';
import { AddComponentCommand, TransformComponentCommand } from '../../core/CommandHistory.js';

export function updateSelectableItems(app) {
    // Components first (lower z-order), then shapes (higher z-order)
    // hitTest iterates in reverse, so shapes at the end get priority — 
    // matching the visual layering (contentLayer above componentLayer)
    const items = [...app.components, ...app.shapes];
    app.selection.setShapes(items);
}

export function generateReference(app, definition) {
    let prefix = definition.defaultReference || 'U?';
    prefix = prefix.replace(/[0-9?]+$/, '');

    let maxNum = 0;
    for (const comp of app.components) {
        if (comp.reference.startsWith(prefix)) {
            const num = parseInt(comp.reference.slice(prefix.length)) || 0;
            maxNum = Math.max(maxNum, num);
        }
    }

    return `${prefix}${maxNum + 1}`;
}

export function getSelectedComponents(app) {
    return app.selection.getSelection().filter(item => item instanceof Component);
}

export function onComponentDefinitionSelected(app, definition) {
    app._cancelDrawing();

    app.placingComponent = definition;
    app.currentTool = 'component';

    app._setActiveToolButton?.('component');
    app._updateShapePanelOptions(app.selection.getSelection(), 'component');

    createComponentPreview(app, definition);

    app.viewport.svg.style.cursor = 'crosshair';

    console.log('Placing component:', definition.name);
}

export function createComponentPreview(app, definition) {
    if (app.componentPreview) {
        app.componentPreview.remove();
    }

    const tempComponent = new Component(definition, {
        x: 0,
        y: 0,
        rotation: app.componentRotation,
        mirror: app.componentMirror,
        reference: definition.defaultReference || 'U?'
    });

    app.componentPreview = tempComponent.createSymbolElement();
    app.componentPreview.style.opacity = '0.6';
    app.componentPreview.style.pointerEvents = 'none';
    app.componentPreview.classList.add('component-preview');

    app.viewport.componentLayer.appendChild(app.componentPreview);
}

export function updateComponentPreview(app, worldPos) {
    if (!app.componentPreview || !app.placingComponent) return;

    if (app.componentRotation === undefined) app.componentRotation = 0;
    if (app.componentMirror === undefined) app.componentMirror = false;

    const parts = [`translate(${worldPos.x}, ${worldPos.y})`];
    if (app.componentRotation !== 0) {
        parts.push(`rotate(${app.componentRotation})`);
    }

    app.componentPreview.setAttribute('transform', parts.join(' '));
}

export function placeComponent(app, worldPos) {
    if (!app.placingComponent) return;

    const ref = app._generateReference(app.placingComponent);

    const component = new Component(app.placingComponent, {
        x: worldPos.x,
        y: worldPos.y,
        rotation: app.componentRotation,
        mirror: app.componentMirror,
        reference: ref
    });

    const command = new AddComponentCommand(app, component);
    app.history.execute(command);

    console.log('Placed component:', component.reference, 'at', worldPos.x, worldPos.y);
}

export function rotateComponent(app) {
    if (app.placingComponent) {
        app.componentRotation = (app.componentRotation + 90) % 360;
        createComponentPreview(app, app.placingComponent);
        if (app.lastCrosshairWorld) {
            updateComponentPreview(app, app.lastCrosshairWorld);
        }
    } else {
        const selected = app._getSelectedComponents();
        if (selected.length > 0) {
            const command = new TransformComponentCommand(app, selected, 'Rotate');
            app.history.execute(command);
        }
    }
}

export function mirrorComponent(app) {
    if (app.placingComponent) {
        app.componentMirror = !app.componentMirror;
        createComponentPreview(app, app.placingComponent);
        if (app.lastCrosshairWorld) {
            updateComponentPreview(app, app.lastCrosshairWorld);
        }
    } else {
        const selected = app._getSelectedComponents();
        if (selected.length > 0) {
            const command = new TransformComponentCommand(app, selected, 'Mirror');
            app.history.execute(command);
        }
    }
}

export function cancelComponentPlacement(app) {
    if (app.componentPreview) {
        app.componentPreview.remove();
        app.componentPreview = null;
    }
    app.placingComponent = null;
    app.componentRotation = 0;
    app.componentMirror = false;

    if (app.currentTool === 'component') {
        app.currentTool = 'select';
        app.viewport.svg.style.cursor = 'default';
        app._setActiveToolButton?.('select');
        app._updateShapePanelOptions(app.selection.getSelection(), 'select');
    }
}
