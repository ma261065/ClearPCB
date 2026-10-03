import { updateViewportCulling } from './schematic-view.js';
import { dismissAnchorContextMenu } from './context-menu.js';
import { onComponentDefinitionSelected } from './components.js';
import { onComponentPickerClosed } from './tool.js';
import { updatePastePreview } from './clipboard.js';

/**
 * Wires up EventBus listeners (component picker) and viewport callbacks
 * (`onMouseMove`, `onViewChanged`, `onViewportCull`) for status bar updates,
 * cursor tracking, hover detection, and viewport culling.
 * @param {object} app - Application state.
 */
export function setupCallbacks(app) {
    // Event bus listeners (component picker)
    app.eventBus.on('component:selected', (def) => {
        onComponentDefinitionSelected(app, def);
    });
    app.eventBus.on('component:pickerClosed', () => {
        onComponentPickerClosed(app);
    });

    // Hover + status updates are coalesced to one animation frame so a burst
    // of mousemove events performs at most one hit-test / DOM update per frame
    // (matches the PCB editor's _scheduleHoverUpdate pattern).
    let pendingMove = null;
    let moveRaf = 0;
    let pendingView = null;
    let viewRaf = 0;

    const cancelPendingMove = () => {
        pendingMove = null;
        if (!moveRaf) return;
        cancelAnimationFrame(moveRaf);
        moveRaf = 0;
    };

    const flushMouseMove = () => {
        moveRaf = 0;
        const move = pendingMove;
        pendingMove = null;
        if (!move) return;
        const { world, snapped } = move;

        if (!app.viewport.isPanning && app.interactionState === 'idle') {
            // Single hit-test pass per frame: derive both the overlap count
            // and the hover hit from the same z-ordered list. The hover hit
            // mirrors hitTest()'s selected-first priority (a selected shape
            // under the cursor "wins" even if another is drawn on top).
            const allHits = app.selection.hitTest(world, true);
            const overlapHitCount = allHits.length;
            if (overlapHitCount !== app._overlapHitCount) {
                app._overlapHitCount = overlapHitCount;
                app._updateShapeSelectionTip?.();
            }
            const hit = allHits.find((shape) => app.selection.isSelected(shape)) || allHits[0] || null;
            const hoveredChanged = app.selection.setHovered(hit);

            let cursor = 'default';
            const selectedShapes = app.selection.getSelection();
            for (const shape of selectedShapes) {
                const anchorId = shape.hitTestAnchor(world, app.viewport.scale);
                if (anchorId) {
                    const anchors = shape.getAnchors();
                    const anchor = anchors.find(a => a.id === anchorId);
                    cursor = anchor?.cursor || 'crosshair';
                    break;
                }
            }

            if (cursor === 'default' && hit && app.selection.isSelected(hit)) {
                cursor = 'move';
            } else if (cursor === 'default' && hit) {
                cursor = 'pointer';
            }

            if (app.viewport.svg.style.cursor !== cursor) {
                app.viewport.svg.style.cursor = cursor;
            }

            if (hoveredChanged) {
                app.renderShapes();
            }
        }

        const v = app.viewport;
        const unitLabel = v.units === 'inch' ? '"' : ` ${v.units}`;
        if (app.ui.cursorPos) {
            app.ui.cursorPos.textContent = `${v.formatValue(world.x)}, ${v.formatValue(-world.y)}${unitLabel}`;
        }
        if (app.ui.gridSnap) {
            app.ui.gridSnap.textContent = `${v.formatValue(snapped.x)}, ${v.formatValue(-snapped.y)}${unitLabel}`;
        }
    };

    app.viewport.onMouseMove = (world, snapped) => {
        if (app.pastingClipboard && app.pastePreviewGroup) {
            updatePastePreview(app, snapped);
        }

        // Component preview is handled by placingState.mousemove to avoid double-update

        pendingMove = { world, snapped };
        if (!moveRaf) moveRaf = requestAnimationFrame(flushMouseMove);
    };

    const flushViewUpdate = () => {
        viewRaf = 0;
        const view = pendingView;
        pendingView = null;
        if (!view) return;

        // Let the inexpensive SVG viewBox change paint before culling and
        // scale-dependent shape updates consume the following frame.
        updateViewportCulling(app);
        if (view.scaleChanged) {
            app.renderShapes(true);
        }
        app._updateTextEditOverlay?.();
    };

    app.viewport.onInteractionStart = (kind) => {
        cancelPendingMove();
        if (kind === 'pointer' || !viewRaf) return;
        cancelAnimationFrame(viewRaf);
        viewRaf = 0;
    };

    app.viewport.onViewChanged = (view) => {
        // A context menu is anchored to a screen position but refers to a board
        // location; any zoom or pan (wheel, +/- keys, arrow-key pan, buttons,
        // drag) makes it stale, so dismiss it as soon as the view moves.
        // Guard on an actual move: endPan() fires this callback even for a
        // zero-distance right-click, which would otherwise instantly close the
        // context menu the right-click just opened.
        if (view.scaleChanged || view.boundsChanged) dismissAnchorContextMenu();

        const zoomPercent = Math.round(app.viewport.zoom * 100);
        if (app.ui.zoomPercent) {
            app.ui.zoomPercent.textContent = `${zoomPercent}%`;
        }

        const bounds = view.bounds;
        const v = app.viewport;
        const widthDisplay = v.formatValue(bounds.maxX - bounds.minX, 1);
        const heightDisplay = v.formatValue(bounds.maxY - bounds.minY, 1);
        const unitLabel = v.units === 'inch' ? '"' : ` ${v.units}`;
        if (app.ui.viewportInfo) {
            app.ui.viewportInfo.textContent = `${widthDisplay} × ${heightDisplay}${unitLabel}`;
        }

        pendingView = pendingView
            ? {
                ...view,
                scaleChanged: pendingView.scaleChanged || view.scaleChanged,
                boundsChanged: pendingView.boundsChanged || view.boundsChanged,
            }
            : view;
        if (!viewRaf) viewRaf = requestAnimationFrame(flushViewUpdate);
    };

    // Throttled culling during pan (fired by Viewport rAF)
    app.viewport.onViewportCull = () => {
        updateViewportCulling(app);
    };
}
