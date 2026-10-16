/**
 * Owns the component/reference Properties editor instance for each PCB editor.
 */
import { ComponentProperties } from './component-properties.js';
import { getPropertyEditor, setPropertyEditor } from './property-editors.js';
import { isEditorActive } from './pcb-editor-api.js';
import { isPcbSelected } from './selection-registry.js';
import { MovePlacementCommand, RotatePlacementCommand, SetPlacementLockedCommand, SetPlacementSideCommand, SetPlacementRefVisibleCommand,
    finishPlacementPreview, previewPlacementPose } from './track-commands.js';
import { finishSelectionInteraction } from './selection-interaction.js';
import { netsForComponent, openComponent3DPopout } from './component-selection.js';
import { beginDragSession, refreshDragRatlines, releaseDragSession } from './drag-session.js';
import { SetRefStyleCommand } from './ref-text-selection.js';
import { bindStrokeTextProps } from './text-properties.js';
import { activeTextInlineEdit, insertInlineTextSymbol } from './text-inline-edit.js';
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
        gridStep: () => app.viewport?.gridSize || 0,
        previewMove: (id, x, y) => previewComponentMove(app, id, x, y),
        finishMove: (id, commit) => finishComponentMove(app, id, commit),
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
        activeTextEdit: () => activeTextInlineEdit(app),
        insertInlineSymbol: (textId, symbol) => insertInlineTextSymbol(app, textId, symbol),
    })));
}

/**
 * A Properties-panel move in progress: the component previews like a canvas drag
 * (bonded copper follows, only its nets' ratlines refresh) until it is committed.
 * @type {WeakMap<PcbEditor, {compId: string, start: {x: number, y: number}, session: import('./drag-session.js').DragSession}>}
 */
const panelMoves = new WeakMap();

/**
 * Commit a pending Properties-panel move before a canvas gesture starts.
 * @param {PcbEditor} app
 */
export function settleComponentMovePreview(app) {
    const editor = getPropertyEditor(app, 'component');
    return editor instanceof ComponentProperties ? editor.settleMove() : false;
}

/**
 * Preview `compId` at (x, y) without changing the document.
 * @param {PcbEditor} app @param {string} compId @param {number} x @param {number} y
 */
export function previewComponentMove(app, compId, x, y) {
    const placement = app.placements.get(compId);
    if (!placement || placement.locked || !Number.isFinite(x) || !Number.isFinite(y)) return false;
    let move = panelMoves.get(app);
    if (move && move.compId !== compId) finishComponentMove(app, move.compId, false);
    move = panelMoves.get(app);
    if (!move) {
        move = { compId, start: { x: placement.x, y: placement.y },
            session: beginDragSession(app, { nets: netsForComponent(app, compId) }) };
        panelMoves.set(app, move);
    }
    previewPlacementPose(app, compId, { x, y });
    refreshDragRatlines(app, move.session);
    return true;
}

/**
 * End a panel move: commit it as one MovePlacementCommand, or restore the start pose.
 * Returns whether a move was in progress.
 * @param {PcbEditor} app @param {string} compId @param {boolean} commit
 */
export function finishComponentMove(app, compId, commit) {
    const move = panelMoves.get(app);
    if (!move || move.compId !== compId) return false;
    panelMoves.delete(app);
    releaseDragSession(app, move.session);
    const placement = app.placements.get(compId);
    const { x: fromX, y: fromY } = move.start;
    if (commit && placement && !placement.locked && (placement.x !== fromX || placement.y !== fromY)) {
        const { x, y } = placement;
        finishPlacementPreview(app, () => app.history.execute(new MovePlacementCommand(app, compId, fromX, fromY, x, y)));
    } else {
        finishPlacementPreview(app);
        app.refreshClearanceHalos();
        app.updateRatsnest();
    }
    return true;
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
