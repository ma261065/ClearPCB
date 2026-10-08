/** @typedef {import('./SchematicDocument.js').SchematicItem} SchematicItem */
/** @typedef {import('./SchematicDocument.js').SchematicDrawable} SchematicDrawable */
/** @typedef {import('../components/Component.js').Component} Component */
/** @typedef {import('../shapes/arc.js').Arc} Arc */
/** @typedef {import('../shapes/circle.js').Circle} Circle */
/** @typedef {import('../shapes/net.js').Net} Net */
/** @typedef {import('../shapes/noconnect.js').NoConnect} NoConnect */
/** @typedef {import('../shapes/polyline.js').Polyline} Polyline */
/** @typedef {import('../shapes/text.js').Text} Text */
/** @typedef {import('../shapes/wire.js').Wire} Wire */

/** @param {SchematicItem|null|undefined} item @returns {item is Component} */
export const isComponentItem = item => item?.type === 'component';
/** @param {SchematicItem|null|undefined} item @returns {item is Arc} */
export const isArcItem = item => item?.type === 'arc';
/** @param {SchematicItem|null|undefined} item @returns {item is Circle} */
export const isCircleItem = item => item?.type === 'circle';
/** @param {SchematicItem|null|undefined} item @returns {item is Net} */
export const isNetItem = item => item?.type === 'net';
/** @param {SchematicItem|null|undefined} item @returns {item is NoConnect} */
export const isNoConnectItem = item => item?.type === 'noconnect';
/** @param {SchematicItem|null|undefined} item @returns {item is Polyline} */
export const isPolylineItem = item => item?.type === 'polyline';
/** @param {SchematicItem|null|undefined} item @returns {item is Text} */
export const isTextItem = item => item?.type === 'text';
/** @param {SchematicItem|null|undefined} item @returns {item is Wire} */
export const isWireItem = item => item?.type === 'wire';
/** @param {SchematicItem|null|undefined} item @returns {item is Wire|Net} */
export const isWireOrNetItem = item => item?.type === 'wire' || item?.type === 'net';
/** @param {SchematicItem|null|undefined} item @returns {item is Wire|Polyline} */
export const isGraphItem = item => item?.type === 'wire' || item?.type === 'polyline';
