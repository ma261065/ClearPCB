import { padCopperPathD } from './pad.js';
import { showPadEditor } from './pad-properties.js';
import { isLayerVisible } from './layers.js';

const padToolDefaults = new WeakMap();
const padPreviewGroups = new WeakMap();
const padPreviewWorlds = new WeakMap();

export function getPadToolDefaults(app) {
    let defaults = padToolDefaults.get(app);
    if (!defaults) {
        defaults = {
            shape: 'round', size: 1.5, drill: 0.8, ratio: 2,
            rotation: 0, layers: 'both', net: '',
        };
        padToolDefaults.set(app, defaults);
    }
    return defaults;
}

export function setPadToolDefaults(app, defaults) {
    padToolDefaults.set(app, defaults);
}

export function snapPadPlacement(app, point) {
    return app.viewport?.getSnappedPosition?.(point) || { x: point.x, y: point.y };
}

/**
 * Hit-test: find a pad whose bounding box contains the world position.
 * Returns `{ type:'pad', componentId, pinNumber }` or null. Pad shape
 * is approximated by the bounding box from padOffsets.
 */
export function hitTestPad(app, worldPos) {
    const topVisible = isLayerVisible('top-copper');
    const bottomVisible = isLayerVisible('bottom-copper');
    if (!topVisible && !bottomVisible) return null;
    for (const [componentId, pl] of app.placements) {
        if (!pl?.padOffsets) continue;
        // For 90°/270° placement rotations the pad's footprint-local
        // width/height are swapped in world space; account for that so the
        // hit region tracks the pad's actual on-screen extent.
        const ortho = Math.abs((pl.rotation || 0) % 180) === 90;
        for (const off of pl.padOffsets) {
            // Respect copper-layer visibility. Through-hole pads ('both')
            // are hover-hittable when either side is visible.
            const padLayer = String(off.layer || 'top');
            const onTop = padLayer === 'top' || padLayer === 'top-copper';
            const onBottom = padLayer === 'bottom' || padLayer === 'bottom-copper';
            const onBoth = padLayer === 'both';
            if (onTop && !topVisible) continue;
            if (onBottom && !bottomVisible) continue;
            if (onBoth && !topVisible && !bottomVisible) continue;
            const pos = pl.pads.get(off.padId);
            if (!pos) continue;
            const ow = off.width || 1.2;
            const oh = off.height || 1.2;
            const w = (ortho ? oh : ow) / 2;
            const h = (ortho ? ow : oh) / 2;
            if (
                worldPos.x >= pos.x - w && worldPos.x <= pos.x + w
                && worldPos.y >= pos.y - h && worldPos.y <= pos.y + h
            ) {
                return { type: 'pad', componentId, pinNumber: off.number };
            }
        }
    }
    return null;
}

export function updatePadPreview(app, worldPos) {
    if (!app.viewport) return;
    const snap = snapPadPlacement(app, worldPos);
    padPreviewWorlds.set(app, { x: worldPos.x, y: worldPos.y });
    app.viewport.setCrosshair({ x: snap.x, y: snap.y });
    const svg = app.viewport.svg;
    if (!svg) return;
    const scale = app.viewport.scale || 1;
    const stroke = 1 / scale;
    let group = padPreviewGroups.get(app);
    if (!group) {
        const NS = 'http://www.w3.org/2000/svg';
        const accent = getComputedStyle(document.documentElement)
            .getPropertyValue('--accent-color').trim() || '#0098ff';
        group = document.createElementNS(NS, 'g');
        group.setAttribute('class', 'pcb-pad-preview');
        group.setAttribute('pointer-events', 'none');
        const outline = document.createElementNS(NS, 'path');
        outline.setAttribute('data-role', 'outline');
        outline.setAttribute('fill', 'none');
        outline.setAttribute('stroke', accent);
        outline.setAttribute('fill-rule', 'evenodd');
        group.appendChild(outline);
        svg.appendChild(group);
        padPreviewGroups.set(app, group);
    }
    const outline = group.querySelector('[data-role="outline"]');
    outline.setAttribute('d', padCopperPathD({ ...getPadToolDefaults(app), x: snap.x, y: snap.y }));
    outline.setAttribute('stroke-width', String(stroke * 1.5));
}

export function clearPadPreview(app) {
    const group = padPreviewGroups.get(app);
    if (group) {
        group.remove();
        padPreviewGroups.set(app, null);
    }
    padPreviewWorlds.delete(app);
}

export function getPadPreviewWorld(app) {
    return padPreviewWorlds.get(app) || null;
}

export function showPadToolProperties(app) {
    showPadEditor(app, null, {
        defaults: getPadToolDefaults(app),
        refreshPreview: () => { const world = getPadPreviewWorld(app); if (world) updatePadPreview(app, world); },
    });
}
