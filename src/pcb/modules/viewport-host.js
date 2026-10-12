/**
 * Owns PCB canvas viewport creation and viewport-driven refresh hooks.
 */
import { restoreGridSettings } from '../../shared/ui/viewport.js';
import { isEditorActive } from './pcb-editor-api.js';
import { applyLayerPrefsToRender } from './layers.js';
import { getSelectedTrack, getSelectedVia, dismissTrackContextMenu } from './track-select.js';
import { refreshTrackSelectionHalo } from './copper-halos.js';
import { getPcbSelection } from './selection-registry.js';
import { refreshBoxSelectionHighlights } from './box-select.js';
import { renderBoardOutlineHandles } from './board-outline-resize.js';
import { refreshAxisGlow } from './axis-glow.js';
import { refreshTrackDrawPreview } from './track-draw.js';
import { refreshPcbToolFollow } from './pcb-tools.js';
import { updatePcbCulling } from './component-selection.js';
import { hasCopperCuts } from './copper-cuts.js';
import { peekDrcPresentation } from './drc-state.js';
import { cancelHoverUpdate } from './pcb-hover.js';
import { hideNetTooltip } from './net-tooltip.js';
import { showUnlockMenu } from './object-locks.js';
import { createPcbLayerGroups } from './layer-groups.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */
/** @typedef {import('../../core/Viewport.js').Viewport} Viewport */

/**
 * Create the canvas viewport on first use.
 * @param {PcbEditor} app
 */
export function ensurePcbViewport(app) {
    if (app.viewport || !app.canvasContainer) return;

    app.viewport = app.createViewport(app.canvasContainer);

    app.viewport.onMouseMove = (worldPos, snappedPos) => {
        if (!isEditorActive(app)) return;
        if (app.status.cursorPos) {
            app.status.cursorPos.textContent = `${worldPos.x.toFixed(2)}, ${(-worldPos.y).toFixed(2)} mm`;
        }
        if (app.status.gridSnap) {
            app.status.gridSnap.textContent = `${snappedPos.x.toFixed(2)}, ${(-snappedPos.y).toFixed(2)} mm`;
        }
    };

    /** @type {{scaleChanged?: boolean, boundsChanged?: boolean}|null} */
    let pendingView = null;
    let viewRaf = 0;
    const flushViewUpdate = () => {
        viewRaf = 0;
        const view = pendingView;
        pendingView = null;
        if (!view || !isEditorActive(app)) return;

        const scale = app.viewport?.scale || 1;
        if (scale !== app.lastHaloScale && (getSelectedTrack(app) || getSelectedVia(app))) {
            app.lastHaloScale = scale;
            refreshTrackSelectionHalo(app);
        }
        if (view.scaleChanged && getPcbSelection(app).length) {
            refreshBoxSelectionHighlights(app);
        }
        if (view.scaleChanged) {
            renderBoardOutlineHandles(app);
            refreshAxisGlow(app);
            refreshTrackDrawPreview(app);
        }
        refreshPcbToolFollow(app);
        updatePcbCulling(app);
        if (hasCopperCuts(app)) app.updateCopperCuts({ geometryChanged: false });
        if (peekDrcPresentation(app)?.selectedId) peekDrcPresentation(app)?.updateConnector();
    };

    app.viewport.onInteractionStart = (kind) => {
        cancelHoverUpdate(app);
        if (kind !== 'pointer' && viewRaf) {
            cancelAnimationFrame(viewRaf);
            viewRaf = 0;
        }
        hideNetTooltip(app);
    };

    app.viewport.onViewChanged = (view) => {
        if (!isEditorActive(app)) return;
        if (!view || view.scaleChanged || view.boundsChanged) dismissTrackContextMenu();
        if (!view || view.scaleChanged || view.boundsChanged) hideNetTooltip(app);
        app.updateViewportStatus();
        pendingView = pendingView
            ? {
                ...view,
                scaleChanged: pendingView.scaleChanged || view.scaleChanged,
                boundsChanged: pendingView.boundsChanged || view.boundsChanged,
            }
            : view;
        if (!viewRaf) viewRaf = requestAnimationFrame(flushViewUpdate);
    };

    app.viewport.onViewportCull = () => {
        if (!isEditorActive(app)) return;
        updatePcbCulling(app);
        if (hasCopperCuts(app)) app.updateCopperCuts({ geometryChanged: false });
        if (peekDrcPresentation(app)?.selectedId) peekDrcPresentation(app)?.updateConnector();
    };

    app.bindViewportPanHooks();
    app.bindMouseEvents();
    app.viewport.svg.addEventListener('unlock-shape', (event) => {
        const { shape: owner, clientX, clientY } = /** @type {CustomEvent} */ (event).detail || {};
        if (owner?.kind) showUnlockMenu(app, owner.kind, owner.object, clientX, clientY);
    });

    createPcbLayerGroups(app);
    applyLayerPrefsToRender(app);
    restoreGridSettings(app, app.pcbDocument.settings || {});
    app.viewport.updateTheme();
    app.updateViewportStatus();
}
