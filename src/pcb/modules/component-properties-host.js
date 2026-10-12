/**
 * Owns the component/reference Properties editor instance for each PCB editor.
 */
import { ComponentProperties } from './component-properties.js';
import { getPropertyEditor, setPropertyEditor } from './property-editors.js';
import { isEditorActive } from './pcb-editor-api.js';
import { isPcbSelected } from './selection-registry.js';
import { RotatePlacementCommand, SetPlacementLockedCommand, SetPlacementSideCommand, SetPlacementRefVisibleCommand } from './track-commands.js';
import { finishSelectionInteraction } from './selection-interaction.js';
import { openComponent3DPopout } from './component-selection.js';
import { SetRefStyleCommand } from './ref-text-selection.js';
import { bindStrokeTextProps } from './text-properties.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */

/** @param {PcbEditor} app @returns {ComponentProperties} */
export function getComponentProperties(app) {
    const editor = getPropertyEditor(app, 'component');
    if (editor instanceof ComponentProperties) return editor;
    return /** @type {ComponentProperties} */ (setPropertyEditor(app, 'component', new ComponentProperties({
        getPlacement: /** @param {string} id */ (id) => app.placements.get(id),
        isActive: () => isEditorActive(app),
        isSelected: /** @param {string} kind @param {string} id */ (kind, id) => isPcbSelected(app, kind, id),
        openPanel: (panel, owner) => app.openPropertyPanel(panel, owner),
        refreshPanel: panel => app.refreshPropertyPanel(panel),
        layerLabel: /** @param {string} layer */ (layer) => app.layerLabel(layer),
        bindStrokeText: (model, spec) => bindStrokeTextProps(app, model, spec),
        rotate: (id, before, after) => app.history.execute(new RotatePlacementCommand(app, id, before, after)),
        setLocked: (id, locked) => {
            finishSelectionInteraction(app, false);
            app.history.execute(new SetPlacementLockedCommand(app, id, locked));
        },
        setReferenceVisible: setComponentRefVisible.bind(null, app),
        setSide: /** @param {string} id @param {string} side */ (id, side) =>
            setPlacementSide(app, id, /** @type {'top'|'bottom'} */ (side)),
        flip: /** @param {string} id @param {string} axis */ (id, axis) => app.flipComponent(id, /** @type {'H'|'V'} */ (axis)),
        open3D: /** @param {string} id */ (id) => openComponent3DPopout(app, id),
        renderReference: /** @param {string} id */ (id) => app.rerenderRef(id),
        drawReferenceOverlay: (id, tether) => app.drawRefOverlay(id, tether),
        setReferenceStyle: (id, before, after) => app.history.execute(new SetRefStyleCommand(app, id, before, after)),
    })));
}

/** @param {PcbEditor} app @param {string} compId @param {'top'|'bottom'} side */
export function setPlacementSide(app, compId, side) {
    const placement = app.placements.get(compId);
    if (!placement || placement.locked) return;
    const current = placement.side === 'bottom' ? 'bottom' : 'top';
    if (current === side) return;
    app.history.execute(new SetPlacementSideCommand(app, compId, side));
}

/** @param {PcbEditor} app @param {string} compId @param {boolean} visible */
export function setComponentRefVisible(app, compId, visible) {
    const placement = app.placements.get(compId);
    if (!placement || placement.locked) return;
    if ((placement.refVisible !== false) === !!visible) return;
    app.history.execute(new SetPlacementRefVisibleCommand(app, compId, !!visible));
}
