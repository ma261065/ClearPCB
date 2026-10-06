import { hitTestBoardShape, setBoardShapeHover } from './board-shapes.js';
import { hitTestPcbSelectionAnchor } from './selection-anchors.js';
import { getPcbSelectionHits, isPcbSelected } from './selection-registry.js';
import { hitTestTrack, getSelectedTrack, setHoverHighlight } from './track-select.js';
import { hitTestTrackMidpoint, hitTestTrackNode } from './track-drag.js';
import { hitTestText, setTextHover } from './pcb-text-render.js';
import { normalizeShapeCopperMode } from '../../shared/pcb/board-shape-geometry.js';
import { hoverComponent } from './component-selection.js';
import { hitTestReferenceText } from './ref-text-selection.js';
import { isEditorActive } from './pcb-editor-api.js';
import { hitTestBoardOutline, hoverBoardOutline } from './board-outline-resize.js';
import { hitTestPad } from './pad-tool.js';
import { updateCursorForTool } from './tool-lifecycle.js';
import { updateNetTooltip } from './net-tooltip.js';

const hoverStates = new WeakMap();

function state(app) {
    let s = hoverStates.get(app);
    if (!s) {
        s = { pendingEvent: null, raf: 0, nodeCursor: false, overlapHitCount: 0, componentHover: null };
        hoverStates.set(app, s);
    }

    return s;
}

export function cancelHoverUpdate(app) {
    const s = state(app);
    s.pendingEvent = null;
    if (s.raf) {
        cancelAnimationFrame(s.raf);
        s.raf = 0;
    }
}

export function hoverOverlapHitCount(app) {
    return state(app).overlapHitCount;
}

export function setHoverOverlapHitCount(app, count) {
    state(app).overlapHitCount = count;
}

export function hoverComponentCandidate(app) {
    return state(app).componentHover;
}

/**
 * Schedule a select-tool hover update for the next animation frame.
 * Mousemove fires many times per frame; the hover hit-test is O(N) over
 * every pad/track/text, so running it per-event makes the highlight lag
 * the cursor on dense boards. We stash the latest pointer event and do a
 * single hit-test pass per frame against the current viewport.
 * @param {import('../../ui/PCBApp.js').default} app
 * @param {MouseEvent} e
 */
export function scheduleHoverUpdate(app, e) {
    const s = state(app);
    // Keep the freshest pointer position; the rAF callback re-derives the
    // world coordinate so it always reflects the current pan/zoom.
    s.pendingEvent = e;
    if (s.raf) return;
    s.raf = requestAnimationFrame(() => {
        s.raf = 0;
        const ev = s.pendingEvent;
        s.pendingEvent = null;
        // Bail if the tool changed or the tab went inactive between the
        // event and this frame.
        if (!ev || !isEditorActive(app) || app.currentTool !== 'select') return;
        const worldPos = app.screenToWorld(ev);
        hoverBoardOutline(app, hitTestBoardOutline(app, worldPos));
        // Hover highlight for tracks/vias.
        const trackHover = hitTestTrack(app, worldPos);
        // Read-only overlap count: skip the per-frame adapter-list rebuild
        // and reuse the last-synced entries (structural edits resync).
        const selectionHits = getPcbSelectionHits(app, worldPos, null, { sync: false });
        const componentHover = (selectionHits.find(hit => hit.kind === 'component' && isPcbSelected(app, hit.kind, hit.object))
            || selectionHits.find(hit => hit.kind === 'component'))?.object || null;
        s.componentHover = componentHover;
        hoverComponent(app, componentHover);
        const standalonePadHover = selectionHits.find(hit => hit.kind === 'pad')?.object || null;
        const shapeHover = hitTestBoardShape(app, worldPos);
        const copperShapeHover = shapeHover
            && (shapeHover.layer === 'top-copper' || shapeHover.layer === 'bottom-copper')
            && normalizeShapeCopperMode(shapeHover.copperMode) === 'add'
            ? shapeHover : null;
        const hovered = hitTestPad(app, worldPos) || trackHover
            || (standalonePadHover ? { type: 'standalone-pad', pad: standalonePadHover } : null)
            || (copperShapeHover ? { type: 'shape', shape: copperShapeHover } : null);
        setHoverHighlight(app, hovered);
        // Net-name tooltip for the hovered copper object.
        updateNetTooltip(app, ev, hovered);
        // Hover highlight for text annotations.
        const textHover = hitTestText(app, worldPos);
        setTextHover(app, textHover);
        // Hover highlight for free-standing board shapes.
        setBoardShapeHover(app, shapeHover);
        const overlapHitCount = selectionHits.length;
        if (overlapHitCount !== s.overlapHitCount) {
            s.overlapHitCount = overlapHitCount;
            app.setPcbStatus();
        }
        // Cursor feedback: a diagonal double-arrow (matching the
        // schematic editor's graph anchors) when the pointer is over a
        // draggable track node. Only toggle on transitions so we don't
        // clobber other cursors (e.g. a selected component's grab).
        const overNode = trackHover?.type === 'track'
            && !!hitTestTrackNode(app, trackHover.track, worldPos);
        const overMidpoint = !overNode
            && trackHover?.type === 'track'
            && trackHover.track === getSelectedTrack(app)
            && !!hitTestTrackMidpoint(app, trackHover.track, worldPos);
        const overCopper = !overNode && !overMidpoint
            && (trackHover?.type === 'track' || trackHover?.type === 'via');
        const overRef = !overNode && !overMidpoint
            && !!hitTestReferenceText(app, worldPos);
        const selectedAnchor = hitTestPcbSelectionAnchor(app, worldPos, ['shape', 'text']);
        const shapeIsSelected = !!shapeHover && isPcbSelected(app, 'shape', shapeHover);
        const copperIsSelected = (trackHover?.type === 'track' && isPcbSelected(app, 'track', trackHover.track))
            || (trackHover?.type === 'via' && isPcbSelected(app, 'via', trackHover.via));
        const hoverCursor = selectedAnchor?.anchor.symbol === 'rotate' ? 'grab'
            : overNode ? 'nwse-resize'
            : overMidpoint ? 'copy'
            : overCopper ? (copperIsSelected ? 'move' : 'pointer')
            : overRef ? 'move'
            : selectedAnchor ? (selectedAnchor.anchor.cursor || 'move')
            : shapeHover ? (shapeIsSelected ? 'move' : 'pointer')
            : textHover ? (isPcbSelected(app, 'text', textHover) ? 'move' : 'pointer')
            : standalonePadHover ? (isPcbSelected(app, 'pad', standalonePadHover) ? 'move' : 'pointer')
            : componentHover ? (isPcbSelected(app, 'component', componentHover) ? 'move' : 'pointer')
            : null;
        if (hoverCursor) {
            // Compare against the live inline value so we skip redundant
            // writes without a private cache that other cursor-setting
            // paths (drag 'grabbing', tool crosshair) could leave stale.
            if (app.viewport.svg.style.cursor !== hoverCursor) {
                app.viewport.svg.style.cursor = hoverCursor;
            }
            s.nodeCursor = true;
        } else if (s.nodeCursor) {
            s.nodeCursor = false;
            updateCursorForTool(app);
        }
    });
}
