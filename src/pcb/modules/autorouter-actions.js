/**
 * Owns autorouter session wiring, route diagnostics and test-board loading.
 */
import { errorMessage } from '../../core/errors.js';
import { AutorouterSession } from './autorouter-session.js';
import { buildCopperObstacles } from './copper-obstacles.js';
import { buildRouteInput } from './route-input.js';
import { hasPcbEditInProgress } from './edit-lifecycle.js';
import { isPcbDrawing } from './pcb-interactions.js';
import { isEditorActive } from './pcb-editor-api.js';
import { reconcileRatsnest } from './ratsnest.js';
import { noteEditSettled } from './refresh-state.js';
import { tracksFromAutorouterResult } from './autorouter-adapter.js';
import { ReplaceRoutesCommand, renderRoutedCopper } from './track-commands.js';
import { lockedRoutedCopper } from './object-locks.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */
/** @typedef {import('./autorouter-common.js').RouteInput} RouteInput */
/** @typedef {import('./autorouter-common.js').RouteResult} RouteResult */
/** @typedef {import('../../core/pcb-placement-geometry.js').PadOffset} PadOffset */
/** @typedef {import('../../core/pcb-placement-geometry.js').BoardPad} BoardPad */

/** @type {WeakMap<PcbEditor, AutorouterSession>} */
const autorouters = new WeakMap();
/** @type {WeakMap<PcbEditor, RouteInput|null>} */
const testRouteInputs = new WeakMap();

/** @param {PcbEditor} app @param {RouteInput|null} input */
export function setAutorouterTestRouteInput(app, input) {
    testRouteInputs.set(app, input);
}

/** @param {PcbEditor} app */
export function getAutorouter(app) {
    let autorouter = autorouters.get(app);
    if (!autorouter) {
        autorouter = new AutorouterSession({
            readBoard: () => ({
                active: isEditorActive(app),
                editing: hasPcbEditInProgress(app) || isPcbDrawing(app),
                model: app.pcbDocument,
                placements: app.placements,
                netlist: app.netlist,
                undo: app.history.undoStack,
                redo: app.history.redoStack,
                rules: app.getRoutingParams(),
            }),
            takeRouteInput: () => {
                const testInput = testRouteInputs.get(app) || null;
                const input = testInput || buildRouteInput(app);
                testRouteInputs.set(app, null);
                if (testInput) input.copperObstacles = buildCopperObstacles(app);
                return input;
            },
            getRouterMode: () => app.designSettings.values.router,
            adoptResult: result => renderRouteResult(app, /** @type {RouteResult} */ (result)),
            reconcileRatsnest: () => reconcileRatsnest(app),
            sessionEnded: () => noteEditSettled(app),
            setStatus: message => app.setStatus(message),
            presentation: {
                getProgressHost: () => app.status.modeStatus,
                getLayerGroup: id => app.getLayerGroup(id),
                getSvg: () => /** @type {SVGElement|null} */ (app.viewport?.svg),
                getRoutingParams: () => app.getRoutingParams(),
                refreshClearanceHalos: () => app.refreshClearanceHalos(),
            },
        });
        autorouters.set(app, autorouter);
    }
    return autorouter;
}

/** @param {PcbEditor} app */
export function isAutorouterActive(app) {
    return !!autorouters.get(app)?.active;
}

/** @param {PcbEditor} app */
export function runAutoRoute(app) {
    return getAutorouter(app).run();
}

/** @param {PcbEditor} app @param {string|null} [message] */
export function cancelAutoRoute(app, message = null) {
    const autorouter = autorouters.get(app);
    if (autorouter) /** @type {(message?: string|null) => void} */ (autorouter.cancel).call(autorouter, message);
}

/** @param {PcbEditor} app */
export function disposeAutorouter(app) {
    autorouters.get(app)?.dispose();
    autorouters.delete(app);
}

/**
 * Load a test board JSON file and auto-route it.
 * @param {PcbEditor} app
 * @param {string} filename
 */
export async function loadTestBoard(app, filename) {
    try {
        const resp = await fetch(filename);
        if (!resp.ok) throw new Error(`Failed to fetch ${filename}: ${resp.status}`);
        const routeInput = /** @type {RouteInput} */ (await resp.json());

        clearRoutes(app);
        clearTestBoardPlacements(app);
        renderTestBoardPads(app, routeInput);
        setupTestBoardState(app, routeInput);

        app.getLayerGroup('ratlines');
        app.refreshClearanceHalos();
        app.updateRatsnest();

        if (routeInput.bounds && app.viewport) {
            const bounds = routeInput.bounds;
            const margin = 5;
            app.viewport.fitToBounds(
                bounds.minX - margin, bounds.minY - margin,
                bounds.maxX + margin, bounds.maxY + margin,
            );
        }

        app.setStatus(`Loaded ${filename} — ${routeInput.connections.length} nets, click Auto Route to route`);
        testRouteInputs.set(app, routeInput);
    } catch (err) {
        app.setStatus(`Error loading test board: ${errorMessage(err)}`);
        console.error(err);
    }
}

/**
 * Dump the current route input as JSON to clipboard or a new tab.
 * @param {PcbEditor} app
 * @param {string} [filename]
 */
export async function dumpRouteInput(app, filename = 'route-input.json') {
    const input = testRouteInputs.get(app) || buildRouteInput(app);
    const json = JSON.stringify(input);
    try {
        await navigator.clipboard.writeText(json);
        const obstaclePads = /** @type {NonNullable<RouteInput['allObstaclePads']>} */ (input.allObstaclePads);
        console.log(`Route input copied to clipboard (${input.connections.length} nets, ${obstaclePads.length} pads). Paste into ${filename}`);
    } catch {
        const popup = window.open('', '_blank');
        if (popup) {
            const pre = popup.document.createElement('pre');
            pre.textContent = json;
            popup.document.body.appendChild(pre);
        }
        console.log(`Clipboard failed — opened in new tab. Save as ${filename}`);
    }
}

/**
 * Render routing result onto copper layers and hide routed ratlines.
 * @param {PcbEditor} app
 * @param {RouteResult} result
 */
export function renderRouteResult(app, result) {
    const params = app.getRoutingParams();
    const { tracks, vias } = tracksFromAutorouterResult(result, {
        trackWidth: params.trackWidth,
        viaDiameter: params.viaDiameter,
        viaDrill: params.viaDrill,
        placements: app.placements,
    });
    const kept = lockedRoutedCopper(app);
    app.history.execute(new ReplaceRoutesCommand(app, [...kept.tracks, ...tracks], [...kept.vias, ...vias],
        result.failedConnections));
}

/** @param {PcbEditor} app */
export function clearRoutes(app) {
    cancelAutoRoute(app);

    const kept = lockedRoutedCopper(app);
    const command = new ReplaceRoutesCommand(app, kept.tracks, kept.vias);
    command.description = 'Clear routed copper';
    if (app.pcbDocument.tracks.length > kept.tracks.length || app.pcbDocument.vias.length > kept.vias.length) {
        app.history.execute(command);
    } else {
        renderRoutedCopper(app);
    }
    app.setStatus(kept.tracks.length || kept.vias.length ? 'Routes cleared; locked copper kept' : 'Routes cleared');
}

/**
 * Render test board pads as SVG rectangles for visual reference.
 * @param {PcbEditor} app
 * @param {RouteInput} routeInput
 */
function renderTestBoardPads(app, routeInput) {
    const topCopper = app.getLayerGroup('top-copper');
    const bottomCopper = app.getLayerGroup('bottom-copper');
    const pads = routeInput.allObstaclePads || [];
    for (const pad of pads) {
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('class', 'pcb-test-pad');
        rect.setAttribute('x', String(pad.x - pad.width / 2));
        rect.setAttribute('y', String(pad.y - pad.height / 2));
        rect.setAttribute('width', String(pad.width));
        rect.setAttribute('height', String(pad.height));
        rect.setAttribute('fill', pad.layer === 'bottom' ? '#0066ff' : '#ff6633');
        rect.setAttribute('opacity', '0.8');
        const parent = pad.layer === 'bottom' ? bottomCopper : topCopper;
        parent.appendChild(rect);
    }
}

/**
 * Set up placement/netlist state from a RouteInput so ratsnest and routing work.
 * @param {PcbEditor} app
 * @param {RouteInput} routeInput
 */
function setupTestBoardState(app, routeInput) {
    app.placements = new Map();
    app.netlist = [];

    const padOffsets = /** @type {PadOffset[]} */ ((routeInput.allObstaclePads || []).map((pad, index) => ({
        number: String(index),
        dx: pad.x,
        dy: pad.y,
        width: pad.width,
        height: pad.height,
        layer: pad.layer === 'bottom' ? 'bottom' : pad.layer === 'both' ? 'both' : 'top',
    })));
    /** @type {Map<string|number, BoardPad>} */
    const padMap = new Map();
    for (const offset of padOffsets) {
        padMap.set(offset.number, { x: offset.dx, y: offset.dy });
    }
    app.placements.set('TestBoard', {
        x: 0,
        y: 0,
        name: 'TestBoard',
        pads: padMap,
        padOffsets,
        elements: [],
        bounds: routeInput.bounds || { minX: 0, minY: 0, maxX: 100, maxY: 100 },
    });

    for (const connection of routeInput.connections) {
        const pins = connection.pads.map(pad => {
            const allPads = routeInput.allObstaclePads || [];
            const index = allPads.findIndex(candidate =>
                Math.abs(candidate.x - pad.x) < 0.01 && Math.abs(candidate.y - pad.y) < 0.01);
            return { componentId: 'TestBoard', pinNumber: String(index >= 0 ? index : 0) };
        });
        app.netlist.push({ net: connection.net, pins });
    }
}

/** @param {PcbEditor} app */
function clearTestBoardPlacements(app) {
    if (!app.viewport?.svg) return;
    for (const element of app.viewport.svg.querySelectorAll('.pcb-test-pad')) {
        element.remove();
    }
}
