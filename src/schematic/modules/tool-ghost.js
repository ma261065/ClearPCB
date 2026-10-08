import { isNetItem as isNetShape } from '../../core/schematic-items.js';
import {
    buildNetGroundBarsPath,
    buildNetSymbolPath,
    getNetTextBaseLocal,
    normalizeNetOrientation,
    normalizeNetStyle
} from '../../shapes/net.js';
/** @typedef {import('./schematic-editor-api.js').SchematicEditor} SchematicEditor */
/** @typedef {import('../../shapes/net.js').NetStyle} NetStyle */
/** @typedef {import('../../shapes/net.js').NetOrientation} NetOrientation */
/** @typedef {import('../../shapes/net.js').Net} NetShape */
/** @typedef {{x: number, y: number}} Point */
/** @typedef {{netStyle?: string, netOrientation?: string, netPresetText?: string|null, netFontSize?: number, [key: string]: unknown}} ToolOptions */
/** @typedef {SVGGElement & {__ghostType?: string, __ghostTextEl?: SVGTextElement, __ghostPathEl?: SVGPathElement, __ghostDetailPathEl?: SVGPathElement}} ToolGhost */

/** Half-size of the NoConnect X mark in mm (mirrors noconnect.js NC_HALF). */
const NC_HALF = 0.8;
/** Net ghost text defaults. */
const NL_FONT_SIZE = 1.4;
/** @type {WeakMap<SchematicEditor, ToolGhost>} */
const toolGhosts = new WeakMap();

/** @param {SchematicEditor} app */
export function getToolGhost(app) {
    return toolGhosts.get(app) || null;
}

/** @param {SchematicEditor} app @param {ToolGhost|null} ghost */
function setToolGhost(app, ghost) {
    if (ghost) toolGhosts.set(app, ghost);
    else toolGhosts.delete(app);
}

/** @param {SchematicEditor} app */
function nextNetName(app) {
    const used = new Set();
    for (const shape of app.shapes) {
        if (!isNetShape(shape)) continue;
        const netName = shape.net;
        if (typeof netName !== 'string') continue;
        const m = netName.trim().match(/^NET(\d+)$/i);
        if (m) used.add(Number(m[1]));
    }
    let i = 1;
    while (used.has(i)) i += 1;
    return `NET${i}`;
}

/** @param {SchematicEditor} app @param {NetStyle} style */
function defaultNetText(app, style) {
    const toolOptions = /** @type {ToolOptions} */ (app.toolOptions || {});
    if (toolOptions.netPresetText) return toolOptions.netPresetText;
    if (style === 'gnd') return 'Gnd';
    return nextNetName(app);
}

/** @param {SchematicEditor} app */
function netToolOptionState(app) {
    const toolOptions = /** @type {ToolOptions} */ (app.toolOptions || {});
    const style = normalizeNetStyle(toolOptions.netStyle || 't');
    const orientation = normalizeNetOrientation(toolOptions.netOrientation || 'N');
    return { style, orientation };
}

/**
 * @param {NetOrientation} orientation
 * @param {number} s
 * @param {number} t
 * @returns {Point}
 */
function orientNetLocal(orientation, s, t) {
    switch (orientation) {
        case 'N': return { x: t, y: -s };
        case 'S': return { x: -t, y: s };
        case 'W': return { x: -s, y: -t };
        default: return { x: s, y: t };
    }
}

/** @param {SchematicEditor} app */
export function createNoConnectToolGhost(app) {
    const ns = 'http://www.w3.org/2000/svg';
    const g = document.createElementNS(ns, 'g');
    g.style.opacity = '0.5';
    g.style.pointerEvents = 'none';

    const color = 'var(--sch-no-connect, #cc0000)';
    const sw = 0.25;
    const l1 = document.createElementNS(ns, 'line');
    l1.setAttribute('x1', String(-NC_HALF)); l1.setAttribute('y1', String(-NC_HALF));
    l1.setAttribute('x2',  String(NC_HALF)); l1.setAttribute('y2',  String(NC_HALF));
    l1.setAttribute('stroke', color); l1.setAttribute('stroke-width', String(sw));
    l1.setAttribute('stroke-linecap', 'round');
    const l2 = document.createElementNS(ns, 'line');
    l2.setAttribute('x1', String(-NC_HALF)); l2.setAttribute('y1',  String(NC_HALF));
    l2.setAttribute('x2',  String(NC_HALF)); l2.setAttribute('y2', String(-NC_HALF));
    l2.setAttribute('stroke', color); l2.setAttribute('stroke-width', String(sw));
    l2.setAttribute('stroke-linecap', 'round');
    g.appendChild(l1);
    g.appendChild(l2);

    app.viewport.contentLayer.appendChild(g);
    setToolGhost(app, g);
}

/** @param {SchematicEditor} app */
export function createNetToolGhost(app) {
    const ns = 'http://www.w3.org/2000/svg';
    const g = /** @type {ToolGhost} */ (document.createElementNS(ns, 'g'));
    g.style.opacity = '0.55';
    g.style.pointerEvents = 'none';

    const { style, orientation } = netToolOptionState(app);
    const net = defaultNetText(app, style);
    const textBase = getNetTextBaseLocal(style);

    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', buildNetSymbolPath(style, orientation));
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'var(--sch-net-label, #00cccc)');
    path.setAttribute('stroke-width', '0.25');
    path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('stroke-linecap', 'round');

    const detailPath = document.createElementNS(ns, 'path');
    detailPath.setAttribute('fill', 'none');
    detailPath.setAttribute('stroke', 'var(--sch-net-label, #00cccc)');
    detailPath.setAttribute('stroke-linejoin', 'round');
    detailPath.setAttribute('stroke-linecap', 'round');
    if (style === 'gnd') {
        detailPath.setAttribute('d', buildNetGroundBarsPath(orientation));
        detailPath.setAttribute('stroke-width', '0.08');
    } else {
        detailPath.setAttribute('display', 'none');
    }

    const text = document.createElementNS(ns, 'text');
    const textLocal = orientNetLocal(orientation, textBase.s, textBase.t);
    text.setAttribute('x', String(textLocal.x));
    text.setAttribute('y', String(textLocal.y));
    text.setAttribute('fill', 'var(--sch-net-label, #00cccc)');
    const toolOptions = /** @type {ToolOptions} */ (app.toolOptions || {});
    text.setAttribute('font-size', String(toolOptions.netFontSize || NL_FONT_SIZE));
    text.setAttribute('font-family', 'Arial');
    text.setAttribute('dominant-baseline', 'alphabetic');
    text.setAttribute('alignment-baseline', 'alphabetic');
    text.setAttribute('text-anchor', (style === 'chevron') ? 'start' : 'middle');
    text.textContent = net;

    g.appendChild(path);
    g.appendChild(detailPath);
    g.appendChild(text);
    g.setAttribute('data-nl-style', style);
    g.setAttribute('data-nl-orientation', orientation);
    app.viewport.contentLayer.appendChild(g);
    g.__ghostType = 'net';
    g.__ghostTextEl = text;
    g.__ghostPathEl = path;
    g.__ghostDetailPathEl = detailPath;
    setToolGhost(app, g);
}

/** @param {SchematicEditor} app */
export function removeToolGhost(app) {
    const ghost = getToolGhost(app);
    if (ghost) {
        ghost.remove();
        setToolGhost(app, null);
    }
}

/** @param {SchematicEditor} app @param {Point} pos */
export function updateToolGhost(app, pos) {
    const ghost = getToolGhost(app);
    if (ghost) {
        if (ghost.__ghostType === 'net' && ghost.__ghostTextEl) {
            const { style, orientation } = netToolOptionState(app);
            const path = ghost.__ghostPathEl;
            if (path) {
                path.setAttribute('d', buildNetSymbolPath(style, orientation));
                ghost.setAttribute('data-nl-style', style);
            }
            const detailPath = ghost.__ghostDetailPathEl;
            if (detailPath) {
                if (style === 'gnd') {
                    detailPath.setAttribute('d', buildNetGroundBarsPath(orientation));
                    detailPath.setAttribute('stroke-width', '0.08');
                    detailPath.removeAttribute('display');
                } else {
                    detailPath.setAttribute('d', '');
                    detailPath.setAttribute('display', 'none');
                }
            }
            const base = getNetTextBaseLocal(style);
            const textLocal = orientNetLocal(orientation, base.s, base.t);
            ghost.__ghostTextEl.setAttribute('x', String(textLocal.x));
            ghost.__ghostTextEl.setAttribute('y', String(textLocal.y));
            const toolOptions = /** @type {ToolOptions} */ (app.toolOptions || {});
            ghost.__ghostTextEl.setAttribute('font-size', String(toolOptions.netFontSize || NL_FONT_SIZE));
            ghost.__ghostTextEl.setAttribute('text-anchor', (style === 'chevron') ? 'start' : 'middle');
            ghost.setAttribute('data-nl-orientation', orientation);
            ghost.__ghostTextEl.textContent = defaultNetText(app, style);
            ghost.setAttribute('transform', `translate(${pos.x},${pos.y})`);
            return;
        }
        ghost.setAttribute('transform', `translate(${pos.x},${pos.y})`);
    }
}
