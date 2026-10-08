/**
 * The schematic editor's tools, one entry each (as pcb/modules/pcb-tools.js is for the PCB).
 *
 * The mouse states in draw-states.js (`toolActive` before a draw, `drawing` during one)
 * hand each event to the active tool's entry, and the keyboard, tool selection and ribbon
 * read the same entries, so a tool is described in one place: its shortcut and ribbon
 * label, what selecting it sets up, what a press, a move and a release do before and
 * during a draw, and how a draw finishes (a stationary right-click at the pointer, or a
 * double-click or Enter with the points already placed).
 *
 * Hooks receive the mouse state's positions `{ screenPos, worldPos, snapped }`. A move
 * hook that returns true has placed the crosshair itself; otherwise the state does.
 */
import { Text } from '../../shapes/text.js';
import { attachLabelToTarget } from './label-attachment.js';
import { createNetToolGhost, createNoConnectToolGhost, updateToolGhost } from './tool-ghost.js';
import { addWireWaypoint, finishWireDrawing, getWireJunctionData, hasWireJunctionDot, startWireDrawing, updateSnapHighlight, updateWireDrawing } from './wire.js';
import { resolveWireSnapPosition } from './wire-snap.js';
import {
    addLinePoint, addPolygonPoint, finishDrawing, finishLine, finishPolygon, isSchematicDrawingActive, shapeDrawingClick, startDrawing, updateDrawing,
} from './drawing.js';
import { resolveLabelAttachTarget, setDrawSnapResult, updateToolCrosshair } from './draw-states.js';
import { resolvePinSnapPlacement } from './component-snap.js';
import { normalizeNetOrientation, normalizeNetStyle } from '../../shapes/net.js';
import { isPlacingComponent } from './components.js';
/** @typedef {import('./schematic-editor-api.js').SchematicEditor} SchematicEditor */
/** @typedef {{fontSize?: number, textColor?: string|number, netStyle?: string, netOrientation?: string, [key: string]: any}} ToolOptions */

/** @typedef {{screenPos: {x: number, y: number}, worldPos: {x: number, y: number}, snapped: {x: number, y: number}}} Positions */
/**
 * @typedef {object} SchematicTool
 * @property {string} id
 * @property {string} name - its ribbon label and the start of its tooltip
 * @property {string} [key] - its single-letter shortcut, shown in the tooltip
 * @property {string} [content] - the ribbon button's label (Label and Net draw their own)
 * @property {boolean} [newShapeDefaults] - selecting it shows the Properties tab with its defaults
 * @property {boolean} [placesComponents] - it keeps the component picker and a placement open
 * @property {boolean} [multiClick] - its draw continues across clicks; releasing the button never finishes it
 * @property {(app: any) => void} [onSelected] - set-up when the tool is chosen
 * @property {(app: any, event: MouseEvent, pos: Positions) => void} [press] - primary press before a draw
 * @property {(app: any, event: MouseEvent, pos: Positions) => void} [pressDrawing] - primary press during a draw
 * @property {(app: any, event: MouseEvent, pos: Positions) => boolean|void} [hover] - move before a draw
 * @property {(app: any, event: MouseEvent, pos: Positions) => boolean|void} [moveDrawing] - move during a draw
 * @property {(app: any, pos: Positions) => boolean} [finishAtPointer] - right-click in place: finish here
 * @property {(app: any) => boolean} [finishInPlace] - double-click or Enter: finish with the points placed
 */

/**
 * Arc's middle click follows the pointer exactly; other clicks land on the grid.
 * @param {string} kind
 * @param {SchematicEditor} app
 * @param {Positions} pos
 */
const drawPoint = (kind, app, { worldPos, snapped }) => (kind === 'arc' && app.arcEndpoint ? worldPos : snapped);

/**
 * Line, Rectangle, Circle, Arc and Polygon: shapes drawn click by click.
 * @param {'line'|'rect'|'circle'|'arc'|'polygon'} kind
 * @param {string} name
 * @param {string} content
 * @param {string} key
 * @returns {SchematicTool}
 */
function shapeTool(kind, name, content, key) {
    /** @param {SchematicEditor} app @param {MouseEvent} _event @param {Positions} pos */
    const click = (app, _event, pos) => shapeDrawingClick(app, drawPoint(kind, app, pos));
    return {
        id: kind, name, content, key, newShapeDefaults: true, multiClick: true,
        press: click,
        pressDrawing: click,
        /** @param {SchematicEditor} app */
        moveDrawing: (app, _event, pos) => { updateDrawing(app, drawPoint(kind, app, pos)); },
        /** @param {SchematicEditor} app */
        finishAtPointer(app, { worldPos, snapped }) {
            if (kind === 'line') { addLinePoint(app, snapped); finishLine(app); return true; }
            if (kind === 'polygon') { addPolygonPoint(app, snapped); finishPolygon(app); return true; }
            if (kind === 'arc') {
                if (!app.arcEndpoint) return false;
                updateDrawing(app, worldPos);
                finishDrawing(app, worldPos);
                return true;
            }
            finishDrawing(app, snapped);
            return true;
        },
        /** @param {SchematicEditor} app */
        finishInPlace(app) {
            if (kind === 'line') { finishLine(app); return true; }
            if (kind === 'polygon') { finishPolygon(app); return true; }
            return false;
        },
    };
}

/**
 * Net and No Connect: one click places the marker, snapped to a pin when one is near.
 * @param {'net'|'noconnect'} id
 * @param {string} name
 * @param {string} key
 * @param {(app: any) => void} onSelected
 * @param {string} [content]
 * @returns {SchematicTool}
 */
function pinMarkerTool(id, name, key, onSelected, content) {
    /** @param {SchematicEditor} app @param {Positions} pos */
    const showPlacement = (app, { worldPos }) => {
        const { resolved, pos } = resolvePinSnapPlacement(app, worldPos);
        updateSnapHighlight(app, resolved);
        updateToolGhost(app, pos);
    };
    return {
        id, name, key, content, newShapeDefaults: true, onSelected,
        /** @param {SchematicEditor} app */
        press(app, _event, { worldPos }) {
            const { resolved, pos } = resolvePinSnapPlacement(app, worldPos);
            setDrawSnapResult(app, resolved);
            if (!isSchematicDrawingActive(app)) { startDrawing(app, pos); }
            else { finishDrawing(app, pos); }
            updateToolGhost(app, pos);
        },
        /** @param {SchematicEditor} app */
        pressDrawing(app, _event, { worldPos }) {
            const { resolved, pos } = resolvePinSnapPlacement(app, worldPos);
            setDrawSnapResult(app, resolved);
            finishDrawing(app, pos);
            updateToolGhost(app, pos);
            // Stay in toolActive — these are click-to-place
            app.interactionState = 'toolActive';
        },
        /** @param {SchematicEditor} app */
        hover: (app, _event, pos) => { showPlacement(app, pos); },
        /** @param {SchematicEditor} app */
        moveDrawing: (app, _event, pos) => { showPlacement(app, pos); },
    };
}

/** @type {Readonly<Record<string, Readonly<SchematicTool>>>} */
export const SCHEMATIC_TOOLS = Object.freeze(Object.fromEntries(/** @type {SchematicTool[]} */ ([
    { id: 'select', name: 'Select', key: 'v', content: '⊹ Select' },
    {
        id: 'wire', name: 'Wire', key: 'w', content: '●⏤● Wire', newShapeDefaults: true, multiClick: true,
        /** @param {SchematicEditor} app */
        press(app, event, { worldPos }) {
            app.selection.clearSelection();
            app.renderShapes(true);
            const snap = resolveWireSnapPosition(app, worldPos, { pinTolerance: 0.5 });
            startWireDrawing(app, { x: snap.x, y: snap.y, snapPin: snap.snapPin || null });
            app.interactionState = 'drawing';
            event.preventDefault();
        },
        /** @param {SchematicEditor} app */
        pressDrawing(app, event) {
            if (!app.drawCurrent) return;
            let waypointPos = { x: app.drawCurrent.x, y: app.drawCurrent.y };
            const junctionData = getWireJunctionData(app);
            if (hasWireJunctionDot(app) && junctionData) {
                waypointPos = { x: junctionData.x, y: junctionData.y };
                app.drawCurrent = { ...waypointPos };
            }
            if (app.drawCorner) {
                addWireWaypoint(app, { x: app.drawCorner.x, y: app.drawCorner.y, snapPin: null });
            }
            addWireWaypoint(app, { ...waypointPos, snapPin: app.lastSnappedData?.snapPin || null });
            if (app.wirePoints.length >= 2 && (app.lastSnappedData?.snapPin || hasWireJunctionDot(app))) {
                finishWireDrawing(app, app.lastSnappedData);
                app.interactionState = 'toolActive';
            }
            event.preventDefault();
        },
        /** @param {SchematicEditor} app */
        hover(app, _event, { worldPos }) {
            updateSnapHighlight(app, resolveWireSnapPosition(app, worldPos, { pinTolerance: 0.5 }));
        },
        /** @param {SchematicEditor} app */
        moveDrawing(app, _event, { worldPos }) {
            updateWireDrawing(app, worldPos);
        },
        /** @param {SchematicEditor} app */
        finishAtPointer(app, { worldPos }) {
            if (!(app.wirePoints?.length >= 1)) return false;
            finishWireDrawing(app, app.drawCurrent || worldPos);
            return true;
        },
        /** @param {SchematicEditor} app */
        finishInPlace(app) {
            if (!(app.wirePoints?.length >= 1) || !app.drawCurrent) return false;
            finishWireDrawing(app, app.drawCurrent);
            return true;
        },
    },
    shapeTool('rect', 'Rectangle', '▢ Rectangle', 'r'),
    shapeTool('circle', 'Circle', '○ Circle', 'c'),
    shapeTool('arc', 'Arc', '◠ Arc', 'a'),
    shapeTool('line', 'Line', '╱ Line', 'i'),
    shapeTool('polygon', 'Polygon', '⬠ Polygon', 'p'),
    {
        id: 'text', name: 'Label', key: 'l', newShapeDefaults: true,
        /** @param {SchematicEditor} app */
        press(app, event, { worldPos, snapped }) {
            const attach = resolveLabelAttachTarget(app, worldPos);
            const placePos = attach ? attach.snapPos : snapped;
            const toolOptions = /** @type {ToolOptions} */ (app.toolOptions || {});
            const shape = new Text({
                x: placePos.x,
                y: placePos.y,
                text: '',
                fontSize: toolOptions.fontSize || 2.0,
                color: toolOptions.textColor,
                fillColor: toolOptions.textColor
            });
            attachLabelToTarget(shape, attach?.target || null, attach?.snapPos || null, { isNewLabel: true });
            app.addShape(shape);
            app.selection.select(shape);
            app.startTextEdit?.(shape);
            app.interactionState = 'toolActive';
            app.renderShapes(true);
            event.preventDefault();
        },
        /** @param {SchematicEditor} app */
        hover(app, _event, { worldPos }) {
            const attach = resolveLabelAttachTarget(app, worldPos);
            updateSnapHighlight(app, attach ? { x: attach.snapPos.x, y: attach.snapPos.y, type: 'attach' } : null);
        },
    },
    pinMarkerTool('net', 'Net', 'n', app => {
        // Keep Net placement preferences initialized
        const style = normalizeNetStyle(app.toolOptions?.netStyle || 't');
        const orientation = normalizeNetOrientation(app.toolOptions?.netOrientation || 'N');
        app.updateToolOptions?.({ netStyle: style, netOrientation: orientation });
        createNetToolGhost(app);
    }),
    pinMarkerTool('noconnect', 'No Connect', 'x', app => createNoConnectToolGhost(app), '✕ No Connect'),
    {
        id: 'component', name: 'Component', key: 'o', content: '⊞ Component', placesComponents: true,
        /** @param {SchematicEditor} app */
        onSelected(app) {
            if (!app.componentPicker.isOpen) {
                app.componentPicker.open();
            }
            app.componentPicker.focusSearch();
            // Don't show placement guides until the user clicks Place Component.
            app.hideCrosshair();
        },
        /** @param {SchematicEditor} app */
        hover(app) {
            if (isPlacingComponent(app)) return false;
            app.hideCrosshair();
            return true;
        },
    },
]).map(tool => [tool.id, Object.freeze(tool)])));

/** Shortcut letter → tool id. */
export const SCHEMATIC_TOOL_KEYS = Object.freeze(Object.fromEntries(
    Object.values(SCHEMATIC_TOOLS).filter(tool => tool.key).map(tool => [tool.key, tool.id])));

/**
 * The tool's tooltip: its name and shortcut, as "Wire (W)".
 * @param {string} id
 */
export function schematicToolTitle(id) {
    const tool = SCHEMATIC_TOOLS[id];
    return tool.key ? `${tool.name} (${tool.key.toUpperCase()})` : tool.name;
}

/** @param {SchematicEditor} app */
const activeTool = app => (Object.hasOwn(SCHEMATIC_TOOLS, app.currentTool) ? SCHEMATIC_TOOLS[app.currentTool] : null);

/**
 * A primary press with a tool chosen and no draw under way. A tool without its own press
 * starts a draw, or finishes one already open.
 * @param {SchematicEditor} app
 * @param {MouseEvent} event
 * @param {Positions} pos
 */
export function pressSchematicTool(app, event, pos) {
    const tool = activeTool(app);
    if (tool?.press) { tool.press(app, event, pos); return; }
    if (!isSchematicDrawingActive(app)) { startDrawing(app, pos.snapped); app.interactionState = 'drawing'; }
    else { finishDrawing(app, pos.snapped); app.interactionState = 'toolActive'; }
}

/**
 * A primary press during a draw. A tool without its own finishes the draw there.
 * @param {SchematicEditor} app
 * @param {MouseEvent} event
 * @param {Positions} pos
 */
export function pressSchematicToolDrawing(app, event, pos) {
    const tool = activeTool(app);
    if (tool?.pressDrawing) { tool.pressDrawing(app, event, pos); return; }
    finishDrawing(app, pos.snapped);
    app.interactionState = 'toolActive';
}

/**
 * Pointer movement with a tool chosen: its hover before a draw, its preview during one,
 * then the crosshair at the snapped point unless the tool placed it.
 * @param {SchematicEditor} app
 * @param {MouseEvent} event
 * @param {Positions} pos
 * @param {boolean} drawing
 */
export function moveSchematicTool(app, event, pos, drawing) {
    const tool = activeTool(app);
    const placed = drawing ? tool?.moveDrawing?.(app, event, pos) : tool?.hover?.(app, event, pos);
    if (!placed) updateToolCrosshair(app, pos.snapped, pos.screenPos);
}

/**
 * Releasing the primary button finishes a draw of a single-click tool; draws that
 * continue across clicks are left open.
 * @param {SchematicEditor} app
 * @param {Positions} pos
 */
export function releaseSchematicTool(app, pos) {
    if (activeTool(app)?.multiClick) return;
    if (isSchematicDrawingActive(app)) {
        finishDrawing(app, pos.snapped);
        app.interactionState = 'toolActive';
    }
}

/**
 * A stationary right-click during a draw: finish it at the pointer. Returns whether it did.
 * @param {SchematicEditor} app
 * @param {Positions} pos
 */
export function finishSchematicDrawAtPointer(app, pos) {
    return !!activeTool(app)?.finishAtPointer?.(app, pos);
}

/**
 * A double-click or Enter during a draw: finish it with the points already placed.
 * Returns whether it did.
 * @param {SchematicEditor} app
 */
export function finishSchematicDrawInPlace(app) {
    if (activeTool(app)?.finishInPlace?.(app)) return true;
    if (isSchematicDrawingActive(app) && app.drawCurrent) {
        finishDrawing(app, app.drawCurrent);
        return true;
    }
    return false;
}
