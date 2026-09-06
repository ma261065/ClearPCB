import { updateViewportCulling } from './shape-management.js';
import { dismissAnchorContextMenu } from './context-menu.js';

/**
 * Wires up EventBus listeners (component picker) and viewport callbacks
 * (`onMouseMove`, `onViewChanged`, `onViewportCull`) for status bar updates,
 * cursor tracking, hover detection, and viewport culling.
 * @param {object} app - Application state.
 */
export function setupCallbacks(app) {
    // Event bus listeners (component picker)
    app.eventBus.on('component:selected', (def) => {
        app._onComponentDefinitionSelected(def);
    });
    app.eventBus.on('component:pickerClosed', () => {
        app._onComponentPickerClosed();
    });

    // Hover + status updates are coalesced to one animation frame so a burst
    // of mousemove events performs at most one hit-test / DOM update per frame
    // (matches the PCB editor's _scheduleHoverUpdate pattern).
    let pendingMove = null;
    let moveRaf = 0;

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
            const hit = allHits.find((shape) => shape.selected) || allHits[0] || null;
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

            if (cursor === 'default' && hit && hit.selected) {
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
            app._updatePastePreview(snapped);
        }

        // Component preview is handled by placingState.mousemove to avoid double-update

        pendingMove = { world, snapped };
        if (!moveRaf) moveRaf = requestAnimationFrame(flushMouseMove);
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

        // Cull off-screen elements before rendering (so renderShapes can skip them)
        updateViewportCulling(app);

        // Only force full re-render when zoom/scale changed (stroke widths, anchors depend on scale).
        // On pan-only, shapes don't need any update since SVG viewBox handles translation.
        if (view.scaleChanged) {
            app.renderShapes(true);
        }
        app._updateTextEditOverlay?.();
    };

    // Throttled culling during pan (fired by Viewport rAF)
    app.viewport.onViewportCull = () => {
        updateViewportCulling(app);
    };
}
