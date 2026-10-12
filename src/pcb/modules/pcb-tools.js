/**
 * The PCB editor's tools, one entry each.
 *
 * An entry declares everything the editor needs to know about a tool: the layers it
 * places on, what a primary press does, what pointer movement shows, its Properties
 * panel and its ribbon button. The mouse, the status bar, the ribbon, Properties and the
 * placement checks all read this table, so a new tool is one entry here plus the
 * functions it names in its owner module.
 *
 * A placement tool (one with `targets`) shows a crosshair, owns the Properties panel
 * while active, and is refused, with the reason, when it would start placing on a
 * locked or hidden layer (`pressPcbTool`); Home considers every supported unlocked
 * layer and selects a usable default. Presses that continue a draw already under
 * way (`drawing`) are not checked again.
 */
import { padLayers } from '../../shapes/pad-geometry.js';
import { getShapeDraw, resolveShapeDrawLayer, shapeDrawClick } from './board-shape-draw.js';
import { PROP_HIDDEN_LAYERS, showBoardShapeToolProperties } from './board-shape-properties.js';
import { pressFillTool, showFillToolProperties } from './copper-fill-edit.js';
import { fillToolDefaults, getFillDraw, setFillToolDefaults } from './copper-fill-draw.js';
import { getLastCrosshairWorld, updateCursorCrosshair } from './cursor-state.js';
import { PCB_LAYERS, isLayerLocked, isCopperFillLocked, placementBlock, placementBlockName, showLayerBubble, refuseBlockedPlacement } from './layers.js';
import { PAD_TIP, getPadPreviewWorld, getPadToolDefaults, pressPadTool, showPadToolProperties, updatePadPreview } from './pad-tool.js';
import { hoverSelectTool, pressSelectTool, selectToolTip } from './select-tool.js';
import { TEXT_LAYERS } from '../../core/pcb-text.js';
import { getTextToolDefaults, pressTextTool, showTextToolProperties } from './text-properties.js';
import { getTrackDraw, getTrackToolLayer, hoverTrackTool, pressTrackTool, setTrackToolLayer, showTrackDrawProperties } from './track-draw.js';
import { getViaPreviewWorld, pressViaTool, showViaToolProperties, updateViaPreview } from './via-tool.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */

/** @typedef {{x: number, y: number}} WorldPoint */
/**
 * @typedef {object} PcbToolButton
 * @property {string} [id] - the ribbon button's element id (shapes live in the Shapes menu)
 * @property {string} title
 * @property {string} content
 * @property {string} [icon] - a shape's glyph on the Shapes split button
 */
/**
 * @typedef {object} PcbTool
 * @property {string} id
 * @property {PcbToolButton} button
 * @property {(app: PcbEditor, e: MouseEvent, worldPos: WorldPoint, groupHit: unknown) => void} press - a primary press
 * @property {(app: PcbEditor) => import('./layers.js').PlacementLayer[]} [targets] - the layer-panel rows it places on
 * @property {() => string[]} [layers] Supported placement layer choices, in dropdown order.
 * @property {(layer: string) => import('./layers.js').PlacementLayer[]} [layerTargets]
 * @property {(app: PcbEditor, layer: string) => void} [setLayer]
 * @property {(app: PcbEditor) => string} [layer] - the layer the status bar names
 * @property {(app: PcbEditor) => boolean} [drawing] - a draw of this tool is under way, so a press continues it
 * @property {(app: PcbEditor, e: MouseEvent) => void} [hover] - pointer movement outside an interaction
 * @property {(app: PcbEditor, worldPos: WorldPoint) => void} [follow] - keep its cursor preview under the pointer
 * @property {(app: PcbEditor) => WorldPoint|null} [followPoint] - where `follow` last drew
 * @property {(app: PcbEditor) => void} [showProperties] - show its Properties panel
 * @property {(app: PcbEditor) => string} [tip] - the status-bar tip while the tool is active ('' for none)
 */

/** @param {(app: PcbEditor) => string} layer */
const onLayer = layer => {
    /** @param {PcbEditor} app */
    const targets = app => [{ id: layer(app) }];
    return targets;
};

/**
 * @param {'line'|'circle'|'arc'|'rect'|'polygon'} kind
 * @param {string} title
 * @param {string} content
 * @param {string} icon
 * @returns {PcbTool}
 */
function shapeTool(kind, title, content, icon) {
    /** @param {PcbEditor} app */
    const layer = app => {
        const draw = getShapeDraw(app);
        return (draw?.kind === kind && draw.layer) || resolveShapeDrawLayer(app, app.activeLayer);
    };
    return {
        id: kind, button: { title, content, icon }, layer, targets: onLayer(layer),
        layers: () => PCB_LAYERS.filter(item => !PROP_HIDDEN_LAYERS.has(item.id)).map(item => item.id),
        setLayer: (app, id) => { app.activeLayer = id; },
        /** @param {PcbEditor} app */
        drawing: app => getShapeDraw(app)?.kind === kind,
        /** @param {PcbEditor} app */
        press: (app, _e, worldPos) => shapeDrawClick(app, kind, worldPos),
        /** @param {PcbEditor} app */
        showProperties: app => showBoardShapeToolProperties(app, kind),
        // The Hole button is this tool on the Hole layer.
        /** @param {PcbEditor} app */
        tip: app => (kind === 'circle' && layer(app) === 'hole' ? 'Tip: A hole is just a circle on the hole layer' : ''),
    };
}

/** @param {PcbEditor} app */
const trackLayer = app => getTrackDraw(app)?.currentLayer || getTrackToolLayer(app) || 'top-copper';
/** @param {PcbEditor} app */
const textLayer = app => getTextToolDefaults(app).layer;
/** @param {PcbEditor} app */
const fillLayer = app => getFillDraw(app)?.layer || fillToolDefaults(app).layer;

/** @type {Readonly<Record<string, Readonly<PcbTool>>>} */
export const PCB_TOOLS = Object.freeze(Object.fromEntries(/** @type {PcbTool[]} */ ([
    {
        id: 'select', button: { id: 'pcbToolSelect', title: 'Select (V)', content: '⊹ Select' },
        press: pressSelectTool, hover: hoverSelectTool, tip: selectToolTip,
    },
    {
        id: 'track', button: { id: 'pcbToolTrack', title: 'Route Track', content: '⏤ Track' },
        /** @param {PcbEditor} app */
        layer: trackLayer, targets: onLayer(trackLayer), drawing: app => !!getTrackDraw(app),
        layers: () => ['top-copper', 'bottom-copper'], setLayer: setTrackToolLayer,
        /** @param {PcbEditor} app */
        press: (app, _e, worldPos) => pressTrackTool(app, worldPos), hover: hoverTrackTool,
        showProperties: showTrackDrawProperties,
        tip: () => 'Tip: Press SPACE to insert a via and switch to the other layer',
    },
    {
        id: 'via', button: { id: 'pcbToolVia', title: 'Place Via', content: '◉ Via' },
        targets: () => [{ id: 'vias' }],
        layers: () => ['vias'],
        /** @param {PcbEditor} app */
        press: (app, _e, worldPos) => pressViaTool(app, worldPos),
        follow: updateViaPreview, followPoint: getViaPreviewWorld, showProperties: showViaToolProperties,
    },
    {
        id: 'pad', button: { id: 'pcbToolPad', title: 'Place Pad', content: '▣ Pad' },
        /** @param {PcbEditor} app */
        targets: app => padLayers(getPadToolDefaults(app)).map(id => ({ id })),
        layers: () => ['top-copper', 'bottom-copper', 'both'],
        layerTargets: layer => (layer === 'both' ? ['top-copper', 'bottom-copper'] : [layer]).map(id => ({ id })),
        setLayer: (app, layer) => { getPadToolDefaults(app).layers = layer; },
        /** @param {PcbEditor} app */
        press: (app, _e, worldPos) => pressPadTool(app, worldPos),
        follow: updatePadPreview, followPoint: getPadPreviewWorld, showProperties: showPadToolProperties,
        tip: () => PAD_TIP,
    },
    shapeTool('line', 'Draw Line', '/ Line', '/'),
    shapeTool('circle', 'Draw Circle', '◯ Circle', '◯'),
    shapeTool('arc', 'Draw Arc', '◠ Arc', '◠'),
    shapeTool('rect', 'Draw Rectangle', '▢ Rectangle', '▢'),
    shapeTool('polygon', 'Draw Polygon', '⬠ Polygon', '⬠'),
    {
        id: 'text', button: { id: 'pcbToolText', title: 'Place Text', content: 'T Text' },
        layer: textLayer, targets: onLayer(textLayer),
        layers: () => [...TEXT_LAYERS], setLayer: (app, layer) => { getTextToolDefaults(app).layer = layer; },
        /** @param {PcbEditor} app */
        press: (app, _e, worldPos) => pressTextTool(app, worldPos), showProperties: showTextToolProperties,
    },
    {
        id: 'fill', button: { id: 'pcbToolFill', title: 'Draw Copper Fill / Pour', content: '▦ Fill' },
        /** @param {PcbEditor} app */
        layer: fillLayer, targets: app => [{ id: fillLayer(app) }, { id: fillLayer(app), fill: true }],
        layers: () => ['top-copper', 'bottom-copper'],
        layerTargets: id => [{ id }, { id, fill: true }],
        setLayer: (app, layer) => {
            if (layer === 'top-copper' || layer === 'bottom-copper') setFillToolDefaults(app, { layer });
        },
        /** @param {PcbEditor} app */
        drawing: app => !!getFillDraw(app),
        /** @param {PcbEditor} app */
        press: (app, _e, worldPos) => pressFillTool(app, worldPos), showProperties: showFillToolProperties,
    },
]).map(tool => [tool.id, Object.freeze(tool)])));

/**
 * Ribbon buttons that pick a tool with a preset layer: Hole is the Circle tool on the
 * Hole layer.
 * @type {Readonly<Record<string, Readonly<{tool: string, layer: string, button: PcbToolButton,
 *   targets: (app: PcbEditor) => import('./layers.js').PlacementLayer[]}>>>}
 */
export const PCB_TOOL_PRESETS = Object.freeze({
    hole: Object.freeze({
        tool: 'circle', layer: 'hole', targets: () => [{ id: 'hole' }],
        button: { id: 'pcbToolHole', title: 'Place Hole', content: '◎ Hole' },
    }),
});

/** Tools that place objects: they show a crosshair and their own Properties panel. */
export const PCB_PLACEMENT_TOOLS = new Set(Object.values(PCB_TOOLS).filter(tool => tool.targets).map(tool => tool.id));
export const PCB_SHAPE_TOOLS = new Set(['line', 'circle', 'arc', 'rect', 'polygon']);
/** Ribbon buttons whose supported layers determine drawing availability. */
export const PCB_RIBBON_PLACEMENT_TOOLS = Object.freeze([...PCB_PLACEMENT_TOOLS, ...Object.keys(PCB_TOOL_PRESETS)]);

/**
 * A tool id the editor knows, else 'select'.
 * @param {string|null|undefined} tool
 */
export function normalizePcbTool(tool) {
    return tool && Object.hasOwn(PCB_TOOLS, tool) ? tool : 'select';
}

/**
 * The layer-panel rows a placement tool or preset would put new objects on, from its own
 * settings (or the draw in progress). Its press and Properties read these actual
 * targets; Home availability considers every supported choice. Tools that place nothing give none.
 * @param {PcbEditor} app
 * @param {string} [tool]
 * @returns {import('./layers.js').PlacementLayer[]}
 */
export function pcbToolTargets(app, tool = app.currentTool) {
    const entry = Object.hasOwn(PCB_TOOLS, tool) ? PCB_TOOLS[tool] : PCB_TOOL_PRESETS[tool];
    return entry?.targets?.(app) || [];
}

/** @param {string} tool @returns {string[]} */
export function pcbToolLayers(tool) {
    const preset = PCB_TOOL_PRESETS[tool];
    return preset ? [preset.layer] : PCB_TOOLS[tool]?.layers?.() || [];
}

/** @param {string} tool @param {string} layer */
export function pcbToolLayerLocked(tool, layer) {
    return placementBlock(pcbToolLayerTargets(tool, layer))?.reason === 'locked';
}

/** @param {string} tool @param {string} layer @returns {import('./layers.js').PlacementLayer[]} */
function pcbToolLayerTargets(tool, layer) {
    const entry = PCB_TOOLS[PCB_TOOL_PRESETS[tool]?.tool || normalizePcbTool(tool)];
    return entry?.layerTargets?.(layer) || [{ id: layer }];
}

/** Actual layer locks relevant to a tool, deduplicated across compound placement choices.
 * @param {string} tool @returns {import('./layers.js').PlacementBlock[]}
 */
export function pcbToolLayerLocks(tool) {
    const locks = new Map();
    for (const layer of pcbToolLayers(tool)) for (const target of pcbToolLayerTargets(tool, layer)) {
        if (target.fill ? !isCopperFillLocked(target.id) : !isLayerLocked(target.id)) continue;
        locks.set(`${target.id}:${!!target.fill}`, { ...target, reason: /** @type {const} */ ('locked') });
    }
    return [...locks.values()];
}

/** @param {PcbEditor} app @param {string} tool @param {{x: number, y: number}} anchor */
export function showPcbToolLayerLocks(app, tool, anchor) {
    if (!pcbToolAllLayersLocked(app, tool)) return;
    const locks = pcbToolLayerLocks(tool);
    const first = locks[0];
    if (!first) return;
    const names = locks.map(placementBlockName);
    showLayerBubble(app, first, anchor, {
        message: `${names.join(', ')} ${names.length === 1 ? 'layer' : 'layers'} locked`,
    });
}

/** Home availability is independent of the tool's remembered/default layer or layer visibility.
 * @param {PcbEditor} app @param {string} tool
 */
export function pcbToolAllLayersLocked(app, tool) {
    const layers = pcbToolLayers(tool);
    return layers.length > 0 && layers.every(layer => pcbToolLayerLocked(tool, layer));
}

/** Choose the active supported layer, otherwise the first unlocked choice.
 * @param {PcbEditor} app @param {string} tool
 */
export function preparePcbToolLayer(app, tool) {
    const layers = pcbToolLayers(tool);
    const layer = layers.includes(app.activeLayer) && !pcbToolLayerLocked(tool, app.activeLayer)
        ? app.activeLayer : layers.find(id => !pcbToolLayerLocked(tool, id));
    if (!layer) return;
    PCB_TOOLS[PCB_TOOL_PRESETS[tool]?.tool || normalizePcbTool(tool)]?.setLayer?.(app, layer);
}

/**
 * The layer the status bar names for the active tool.
 * @param {PcbEditor} app
 * @param {string} [tool]
 */
export function pcbToolLayer(app, tool = app.currentTool) {
    return PCB_TOOLS[tool]?.layer?.(app) || app.activeLayer;
}

/**
 * The status-bar tip for the active tool, or ''.
 * @param {PcbEditor} app
 * @param {string} [tool]
 * @returns {string}
 */
export function pcbToolTip(app, tool = app.currentTool) {
    return PCB_TOOLS[tool]?.tip?.(app) || '';
}

/**
 * Show the Properties panel the tool owns (its defaults, or the draw in progress).
 * @param {PcbEditor} app
 * @param {string} [tool]
 */
export function showPcbToolProperties(app, tool = app.currentTool) {
    PCB_TOOLS[tool]?.showProperties?.(app);
}

/**
 * A primary press on the canvas with the active tool. Starting to place on a locked or
 * hidden layer is refused with a status message and cursor popup; a press that continues a draw
 * is not. Returns whether a tool took the press.
 * @param {PcbEditor} app
 * @param {MouseEvent} e
 * @param {WorldPoint|null} worldPos - the press position when already resolved
 * @param {unknown} [groupHit] - the box-selected group member under the pointer
 * @param {Readonly<Record<string, Readonly<PcbTool>>>} [tools]
 */
export function pressPcbTool(app, e, worldPos, groupHit = null, tools = PCB_TOOLS) {
    const tool = Object.hasOwn(tools, app.currentTool) ? tools[app.currentTool] : null;
    if (!tool) return false;
    if (tool.targets && !tool.drawing?.(app) && refuseBlockedPlacement(app, tool.targets(app), e)) return true;
    tool.press(app, e, worldPos || app.screenToWorld(e), groupHit);
    return true;
}

/**
 * Keep the active tool's cursor preview (via ring, pad outline or crosshair) under the pointer.
 * @param {PcbEditor} app
 * @param {WorldPoint} worldPos
 */
export function followPcbTool(app, worldPos) {
    const tool = PCB_TOOLS[app.currentTool];
    if (!tool?.targets) return;
    if (tool.follow) tool.follow(app, worldPos);
    else updateCursorCrosshair(app, worldPos);
}

/**
 * Pointer movement with no interaction under way: the active tool's hover, else its cursor.
 * @param {PcbEditor} app
 * @param {MouseEvent} e
 */
export function hoverPcbTool(app, e) {
    const tool = PCB_TOOLS[app.currentTool];
    if (tool?.hover) tool.hover(app, e);
    else followPcbTool(app, app.screenToWorld(e));
}

/**
 * Redraw the active tool's cursor preview where it last was (after a zoom).
 * @param {PcbEditor} app
 */
export function refreshPcbToolFollow(app) {
    const tool = PCB_TOOLS[app.currentTool];
    if (!tool?.targets) return;
    const own = tool.followPoint?.(app);
    if (own && tool.follow) tool.follow(app, own);
    else {
        const crosshair = getLastCrosshairWorld(app);
        if (crosshair) updateCursorCrosshair(app, crosshair);
    }
}
