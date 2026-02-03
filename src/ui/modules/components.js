import { Component } from '../../components/index.js';

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

    app.viewport.contentLayer.appendChild(app.componentPreview);
}

export function updateComponentPreview(app, worldPos) {
    if (!app.componentPreview || !app.placingComponent) return;

    if (app.componentRotation === undefined) app.componentRotation = 0;
    if (app.componentMirror === undefined) app.componentMirror = false;

    const parts = [`translate(${worldPos.x}, ${worldPos.y})`];
    if (app.componentRotation !== 0) {
        parts.push(`rotate(${app.componentRotation})`);
    }
    if (app.componentMirror) {
        parts.push('scale(-1, 1)');
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

    app.components.push(component);

    const element = component.createSymbolElement();
    app.viewport.addContent(element);

    app.fileManager.setDirty(true);

    app._updateSelectableItems();

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
        for (const comp of selected) {
            comp.rotate(90);
        }
        if (selected.length > 0) {
            app.fileManager.setDirty(true);
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
        for (const comp of selected) {
            comp.toggleMirror();
        }
        if (selected.length > 0) {
            app.fileManager.setDirty(true);
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
