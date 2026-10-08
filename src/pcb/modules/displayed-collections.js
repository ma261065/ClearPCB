/**
 * Which copy of each board collection the editor shows and edits.
 *
 * A preview (a group move, paste, drag, rotation or Properties number step) displays
 * detached copies of the objects it changes and leaves the document's own collections
 * untouched until its command commits. PCBApp's collection getters (`tracks`, `vias`,
 * `pads`, `texts`, `boardShapes`) all resolve here: the first active source below that
 * replaces the collection supplies it, otherwise the document does.
 *
 * Sources are listed outermost first. A group move or a paste holds every object it
 * shows, so it outranks anything else; then pointer drags, rotations and, last,
 * Properties previews. A new kind of preview adds one row here, naming the collections
 * it replaces; a collection its preview object carries but does not name is ignored.
 */
import { getBoardDimensionPreview } from '../../shared/pcb/board-outline.js';
import { getBoardShapePointerPreview, getBoardShapePropertyPreview, getBoardShapeRotationPreview } from './board-shapes.js';
import { getGroupPreview } from './box-select.js';
import { getPadPropertyPreview, getPadRotationPreview } from './pad-commands.js';
import { getPcbPastePreview } from './pcb-paste.js';
import { getTextPosePreviewTexts } from './text-commands.js';
import { getPlacementPreviewTracks, getTrackPropertyPreview, getViaPropertyPreview } from './track-commands.js';
import { getVertexDrag, getViaDrag } from './track-drag.js';

/** @typedef {'tracks'|'vias'|'pads'|'texts'|'boardShapes'} DisplayedCollection */
/**
 * @typedef {object} PreviewSource
 * @property {string} name
 * @property {DisplayedCollection[]} collections - the collections this preview replaces
 * @property {(app: any) => any} preview - its preview object while active, else null/undefined
 */

export const PREVIEW_SOURCES = Object.freeze(/** @type {PreviewSource[]} */ ([
    { name: 'group move', collections: ['tracks', 'vias', 'pads', 'boardShapes'], preview: getGroupPreview },
    { name: 'paste', collections: ['tracks', 'vias', 'pads', 'texts', 'boardShapes'], preview: getPcbPastePreview },
    { name: 'component move', collections: ['tracks'], preview: app => wrap('tracks', getPlacementPreviewTracks(app)) },
    { name: 'board size', collections: ['boardShapes'], preview: getBoardDimensionPreview },
    { name: 'via or pad drag', collections: ['tracks', 'vias', 'pads'], preview: app => getViaDrag(app)?.preview },
    { name: 'track drag', collections: ['tracks'], preview: app => getVertexDrag(app)?.preview },
    { name: 'shape drag', collections: ['boardShapes'], preview: getBoardShapePointerPreview },
    { name: 'text move or rotation', collections: ['texts'], preview: app => wrap('texts', getTextPosePreviewTexts(app)) },
    { name: 'pad rotation', collections: ['pads'], preview: getPadRotationPreview },
    { name: 'shape rotation', collections: ['boardShapes'], preview: getBoardShapeRotationPreview },
    { name: 'track Properties', collections: ['tracks'], preview: getTrackPropertyPreview },
    { name: 'via Properties', collections: ['vias'], preview: getViaPropertyPreview },
    { name: 'pad Properties', collections: ['pads'], preview: getPadPropertyPreview },
    { name: 'shape Properties', collections: ['boardShapes'], preview: getBoardShapePropertyPreview },
]).map(source => Object.freeze(source)));

function wrap(key, collection) {
    return collection ? { [key]: collection } : null;
}

/** @type {Record<DisplayedCollection, PreviewSource[]>} */
const SOURCES_BY_COLLECTION = {
    tracks: [], vias: [], pads: [], texts: [], boardShapes: [],
};
for (const source of PREVIEW_SOURCES) {
    for (const key of source.collections) SOURCES_BY_COLLECTION[key].push(source);
}

/**
 * The collection the editor displays: the first active preview's copy, else the document's.
 * @param {any} app - PCBApp
 * @param {DisplayedCollection} key
 */
export function displayedCollection(app, key) {
    for (const source of SOURCES_BY_COLLECTION[key]) {
        const collection = source.preview(app)?.[key];
        if (collection) return collection;
    }
    return app.pcbDocument[key];
}
