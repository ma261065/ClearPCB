import { Component } from '../../components/index.js';
import { AddComponentCommand, TransformComponentCommand } from './commands.js';
import { needsValueDialog, showValueDialog } from './value-dialog.js';
import { componentPreviewElement } from './schematic-view.js';
import { getSchematicInteraction, setSchematicInteraction } from './schematic-interactions.js';

const componentState = new WeakMap();

/** @param {object} app */
export function getPlacingComponent(app) {
    return getSchematicInteraction(app, 'placingComponent');
}

/** @param {object} app */
export function isPlacingComponent(app) {
    return !!getPlacingComponent(app);
}

/**
 * @param {object} app
 * @param {object|null} definition
 */
function setPlacingComponent(app, definition) {
    setSchematicInteraction(app, 'placingComponent', definition);
}

function stateFor(app) {
    let state = componentState.get(app);
    if (!state) {
        state = {
            previewHidden: false,
            codeTooltip: null,
            codeTooltipActiveId: null,
            codeTooltipPinned: false,
            codeTooltipPosition: null,
        };
        componentState.set(app, state);
    }
    return state;
}

export function initializeComponentCodeTooltip(app) {
    const state = stateFor(app);
    const tooltip = document.createElement('div');
    tooltip.className = 'component-code-tooltip';
    tooltip.innerHTML = `
            <div class="component-code-tooltip-title">Component code</div>
            <button class="component-code-tooltip-close" title="Close">×</button>
            <textarea class="component-code-tooltip-text" readonly></textarea>
        `;
    document.body.appendChild(tooltip);
    state.codeTooltip = tooltip;
    tooltip.addEventListener('click', (e) => {
        if (e.target instanceof Element && e.target.classList.contains('component-code-tooltip-close')) {
            updateComponentCodeTooltip(app, null, null, { forceHide: true });
        }
    });
}

/**
 * Returns the topmost component at a world coordinate, or null.
 * @param {object} app
 * @param {{x:number,y:number}} point
 * @returns {object|null}
 */
export function findComponentAt(app, point) {
    for (let i = app.components.length - 1; i >= 0; i--) {
        const comp = app.components[i];
        if (!comp?.visible) continue;
        if (comp.hitTest(point, 0.5)) {
            return comp;
        }
    }
    return null;
}

export function isComponentCodeTooltipPinned(app) {
    return stateFor(app).codeTooltipPinned;
}

export function updateComponentCodeTooltip(app, component, screenPos, options = {}) {
    const state = stateFor(app);
    const tooltip = state.codeTooltip;
    if (!tooltip) return;

    if (!app.showComponentDebugTooltip && !options.forceHide) {
        tooltip.style.display = 'none';
        state.codeTooltipActiveId = null;
        state.codeTooltipPinned = false;
        state.codeTooltipPosition = null;
        return;
    }

    const easyedaRaw = component?.definition?.symbol?._easyedaRawShapes;
    const kicadRaw = component?.definition?._kicadRaw || component?.definition?.symbol?._kicadRaw;
    const hasEasyeda = Array.isArray(easyedaRaw) && easyedaRaw.length > 0;
    const hasKicad = typeof kicadRaw === 'string' && kicadRaw.trim().length > 0;
    if (options.forceHide || !component || (!hasEasyeda && !hasKicad)) {
        tooltip.style.display = 'none';
        state.codeTooltipActiveId = null;
        state.codeTooltipPinned = false;
        state.codeTooltipPosition = null;
        return;
    }

    const textEl = /** @type {HTMLTextAreaElement|null} */ (tooltip.querySelector('.component-code-tooltip-text'));
    if (textEl && state.codeTooltipActiveId !== component.id) {
        textEl.value = hasEasyeda ? easyedaRaw.join('\n') : kicadRaw;
        state.codeTooltipActiveId = component.id;
    }

    const pad = 12;
    const position = state.codeTooltipPinned && state.codeTooltipPosition
        ? state.codeTooltipPosition
        : screenPos;
    const maxX = window.innerWidth - tooltip.offsetWidth - pad;
    const maxY = window.innerHeight - tooltip.offsetHeight - pad;
    const left = Math.min(position.x + pad, Math.max(pad, maxX));
    const top = Math.min(position.y + pad, Math.max(pad, maxY));

    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
    tooltip.style.display = 'block';
}

/**
 * Pins the component tooltip at a fixed position.
 * @param {object} app
 * @param {Object} component - The component to pin the tooltip for.
 * @param {Object} screenPos - The screen position {x, y} to pin at.
 */
export function pinComponentCodeTooltip(app, component, screenPos) {
    if (!component || !screenPos) return;
    const state = stateFor(app);
    state.codeTooltipPinned = true;
    state.codeTooltipPosition = { ...screenPos };
    updateComponentCodeTooltip(app, component, screenPos);
}

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
    app.cancelDrawing();

    const activeEl = document.activeElement;
    if (activeEl instanceof HTMLElement && activeEl.classList.contains('cp-search-input')) {
        activeEl.blur();
    }

    setPlacingComponent(app, definition);
    app.currentTool = 'component';
    app.interactionState = 'placing';

    app.refreshRibbon?.();
    app.updateShapePanelOptions(app.selection.getSelection(), 'component');

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

    app.componentPreview = componentPreviewElement(tempComponent);
    app.componentPreview.style.opacity = '0.6';
    app.componentPreview.style.pointerEvents = 'none';
    app.componentPreview.classList.add('component-preview');

    // Hide until mouse enters the canvas so it doesn't flash at 0,0
    app.componentPreview.style.display = 'none';
    stateFor(app).previewHidden = true;

    app.viewport.componentLayer.appendChild(app.componentPreview);
}

/**
 * Moves the component placement preview to follow the cursor, applying
 * current rotation and mirror transforms.
 * @param {object} app - Application state.
 * @param {{x: number, y: number}} worldPos - Cursor position in world coordinates.
 */
export function updateComponentPreview(app, worldPos) {
    if (!app.componentPreview || !isPlacingComponent(app)) return;

    // Show preview on first mouse move over canvas (hidden initially to avoid flash at 0,0)
    if (stateFor(app).previewHidden) {
        app.componentPreview.style.display = '';
        stateFor(app).previewHidden = false;
    }

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
    const definition = getPlacingComponent(app);
    if (!definition) return;
    const ref = generateReference(app, definition);

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
    const placing = getPlacingComponent(app);
    if (placing) {
        app.componentRotation = (app.componentRotation + 90) % 360;
        createComponentPreview(app, placing);
        if (app.lastCrosshairWorld) {
            updateComponentPreview(app, app.lastCrosshairWorld);
        }
    } else {
        const selected = getSelectedComponents(app).filter(component => !component.locked);
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
    const placing = getPlacingComponent(app);
    if (placing) {
        app.componentRotation = (app.componentRotation - 90 + 360) % 360;
        createComponentPreview(app, placing);
        if (app.lastCrosshairWorld) {
            updateComponentPreview(app, app.lastCrosshairWorld);
        }
    } else {
        const selected = getSelectedComponents(app).filter(component => !component.locked);
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
    const placing = getPlacingComponent(app);
    if (placing) {
        // Flip across the world vertical axis regardless of current rotation.
        app.componentRotation = (360 - (app.componentRotation || 0)) % 360;
        app.componentMirror = !app.componentMirror;
        createComponentPreview(app, placing);
        if (app.lastCrosshairWorld) {
            updateComponentPreview(app, app.lastCrosshairWorld);
        }
    } else {
        const selected = getSelectedComponents(app).filter(component => !component.locked);
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
    const placing = getPlacingComponent(app);
    if (placing) {
        // Flip across the world horizontal axis regardless of current rotation.
        app.componentRotation = (180 - (app.componentRotation || 0) + 360) % 360;
        app.componentMirror = !app.componentMirror;
        createComponentPreview(app, placing);
        if (app.lastCrosshairWorld) {
            updateComponentPreview(app, app.lastCrosshairWorld);
        }
    } else {
        const selected = getSelectedComponents(app).filter(component => !component.locked);
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
    setPlacingComponent(app, null);
    app.componentRotation = 0;
    app.componentMirror = false;

    if (app.currentTool === 'component') {
        app.currentTool = 'select';
        app.interactionState = 'idle';
        app.viewport.svg.style.cursor = 'default';
        app.refreshRibbon?.();
        app.updateShapePanelOptions(app.selection.getSelection(), 'select');
    }
}
