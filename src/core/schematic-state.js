import {
    isArcItem,
    isCircleItem,
    isComponentItem,
    isNetItem,
    isNoConnectItem,
    isPolylineItem,
    isTextItem,
    isWireItem,
} from './schematic-items.js';

/** @typedef {import('../shapes/arc.js').ArcState|import('../shapes/circle.js').CircleState|import('../components/Component.js').ComponentState|import('../shapes/net.js').NetState|import('../shapes/noconnect.js').NoConnectState|import('../shapes/polyline.js').PolylineState|import('../shapes/text.js').TextState|import('../shapes/wire.js').WireState} SchematicItemState */

/** @typedef {import('./SchematicDocument.js').SchematicItem} SchematicItem */

/**
 * Apply a snapshot captured from the same schematic item. Undo/redo entries are
 * stored by item id, so the item type and its snapshot type stay paired.
 * @param {SchematicItem} item
 * @param {SchematicItemState} state
 */
export function applySchematicItemState(item, state) {
    if (isArcItem(item)) {
        item.applyState(/** @type {import('../shapes/arc.js').ArcState} */ (state));
    } else if (isCircleItem(item)) {
        item.applyState(/** @type {import('../shapes/circle.js').CircleState} */ (state));
    } else if (isComponentItem(item)) {
        item.applyState(/** @type {import('../components/Component.js').ComponentState} */ (state));
    } else if (isNetItem(item)) {
        item.applyState(/** @type {import('../shapes/net.js').NetState} */ (state));
    } else if (isNoConnectItem(item)) {
        item.applyState(/** @type {import('../shapes/noconnect.js').NoConnectState} */ (state));
    } else if (isPolylineItem(item)) {
        item.applyState(/** @type {import('../shapes/polyline.js').PolylineState} */ (state));
    } else if (isTextItem(item)) {
        item.applyState(/** @type {import('../shapes/text.js').TextState} */ (state));
    } else if (isWireItem(item)) {
        item.applyState(/** @type {import('../shapes/wire.js').WireState} */ (state));
    } else {
        const unsupported = /** @type {{type?: string}} */ (item);
        throw new Error(`Unsupported schematic item type: ${unsupported.type || 'unknown'}`);
    }
}
