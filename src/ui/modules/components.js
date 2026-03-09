import { Component } from '../../components/index.js';
import { AddComponentCommand, TransformComponentCommand } from '../../core/CommandHistory.js';
import { needsValueDialog, showValueDialog } from './value-dialog.js';

/**
 * Rebuilds the selection manager's list of selectable items by merging
 * `app.components` and `app.shapes`.
 * @param {object} app - Application state.
 */
export function updateSelectableItems(app) {
    const items = [...app.components, ...app.shapes];
    app.selection.setShapes(items);
}

/**
 * Generates the next unique reference designator (e.g. `R3`, `U5`) for a
 * component definition by scanning existing components.
 * @param {object} app - Application state.
 * @param {object} definition - Component definition with `defaultReference`.
 * @returns {string} Next available reference designator.
 */
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

/**
 * Filters the current selection to return only `Component` instances.
 * @param {object} app - Application state.
 * @returns {import('../../components/Component.js').Component[]} Selected components.
 */
export function getSelectedComponents(app) {
    return app.selection.getSelection().filter(item => item instanceof Component);
}

/**
 * Handles a component definition being chosen from the picker — sets placement
 * mode, creates a preview, and sets crosshair cursor.
 * @param {object} app - Application state.
 * @param {object} definition - The selected component definition.
 */
export function onComponentDefinitionSelected(app, definition) {
    app._cancelDrawing();

    app.placingComponent = definition;
    app.currentTool = 'component';
    app.interactionState = 'placing';

    app._setActiveToolButton?.('component');
    app._updateShapePanelOptions(app.selection.getSelection(), 'component');

    createComponentPreview(app, definition);

    app.viewport.svg.style.cursor = 'crosshair';

    console.log('Placing component:', definition.name);
}

/**
 * Creates a semi-transparent SVG element showing the component symbol
 * under the cursor during placement.
 * @param {object} app - Application state.
 * @param {object} definition - Component definition to preview.
 */
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

/**
 * Moves the component placement preview to follow the cursor, applying
 * current rotation and mirror transforms.
 * @param {object} app - Application state.
 * @param {{x: number, y: number}} worldPos - Cursor position in world coordinates.
 */
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

/**
 * Instantiates a `Component` at the given position, executes an
 * `AddComponentCommand`, and optionally shows a value dialog for passive
 * components (R/C/L).
 * @param {object} app - Application state.
 * @param {{x: number, y: number}} worldPos - Placement position in world coordinates.
 */
export async function placeComponent(app, worldPos) {
    if (!app.placingComponent) return;

    const definition = app.placingComponent;
    const ref = app._generateReference(definition);

    const component = new Component(definition, {
        x: worldPos.x,
        y: worldPos.y,
        rotation: app.componentRotation,
        mirror: app.componentMirror,
        reference: ref
    });

    const command = new AddComponentCommand(app, component);
    app.history.execute(command);

    console.log('Placed component:', component.reference, 'at', worldPos.x, worldPos.y);

    // Show value dialog for passive components (R, C, L)
    if (needsValueDialog(definition)) {
        const screenPos = app.viewport.worldToScreen(worldPos);
        const value = await showValueDialog(definition, screenPos.x, screenPos.y);
        if (value !== null && component.valueText) {
            component.value = value;
            component.valueText.text = value;
            component.valueText.invalidate();
            app.renderShapes(true);
        }
    }
}

/**
 * Rotates the placement preview +90°, or rotates all selected components
 * right via `TransformComponentCommand`.
 * @param {object} app - Application state.
 */
export function rotateComponentRight(app) {
    if (app.placingComponent) {
        app.componentRotation = (app.componentRotation + 90) % 360;
        createComponentPreview(app, app.placingComponent);
        if (app.lastCrosshairWorld) {
            updateComponentPreview(app, app.lastCrosshairWorld);
        }
    } else {
        const selected = app._getSelectedComponents();
        if (selected.length > 0) {
            const command = new TransformComponentCommand(app, selected, 'RotateRight');
            app.history.execute(command);
        }
    }
}

/**
 * Rotates the placement preview −90°, or rotates all selected components
 * left via `TransformComponentCommand`.
 * @param {object} app - Application state.
 */
export function rotateComponentLeft(app) {
    if (app.placingComponent) {
        app.componentRotation = (app.componentRotation - 90 + 360) % 360;
        createComponentPreview(app, app.placingComponent);
        if (app.lastCrosshairWorld) {
            updateComponentPreview(app, app.lastCrosshairWorld);
        }
    } else {
        const selected = app._getSelectedComponents();
        if (selected.length > 0) {
            const command = new TransformComponentCommand(app, selected, 'RotateLeft');
            app.history.execute(command);
        }
    }
}

/**
 * Toggles horizontal mirror on the placement preview, or flips selected
 * components horizontally via `TransformComponentCommand`.
 * @param {object} app - Application state.
 */
export function flipComponentH(app) {
    if (app.placingComponent) {
        app.componentMirror = !app.componentMirror;
        createComponentPreview(app, app.placingComponent);
        if (app.lastCrosshairWorld) {
            updateComponentPreview(app, app.lastCrosshairWorld);
        }
    } else {
        const selected = app._getSelectedComponents();
        if (selected.length > 0) {
            const command = new TransformComponentCommand(app, selected, 'FlipH');
            app.history.execute(command);
        }
    }
}

/**
 * Flips selected components vertically via `TransformComponentCommand`
 * (no effect during placement).
 * @param {object} app - Application state.
 */
export function flipComponentV(app) {
    if (app.placingComponent) {
        app.componentRotation = (app.componentRotation + 180) % 360;
        app.componentMirror = !app.componentMirror;
        createComponentPreview(app, app.placingComponent);
        if (app.lastCrosshairWorld) {
            updateComponentPreview(app, app.lastCrosshairWorld);
        }
    } else {
        const selected = app._getSelectedComponents();
        if (selected.length > 0) {
            const command = new TransformComponentCommand(app, selected, 'FlipV');
            app.history.execute(command);
        }
    }
}

/**
 * Removes the placement preview, resets rotation/mirror state, and switches
 * back to the select tool.
 * @param {object} app - Application state.
 */
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
        app.interactionState = 'idle';
        app.viewport.svg.style.cursor = 'default';
        app._setActiveToolButton?.('select');
        app._updateShapePanelOptions(app.selection.getSelection(), 'select');
    }
}
