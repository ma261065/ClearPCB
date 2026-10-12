import { deflateSync, inflateSync, strToU8, strFromU8 } from '../../../assets/vendor/fflate.module.js';
import { validatePictureArtwork } from './picture-raster.js';

/** @typedef {import('./picture-raster.js').PictureArtwork} PictureArtwork */
/** @typedef {import('./picture-raster.js').PictureRectangle} PictureRectangle */
/** @typedef {import('./picture-raster.js').PictureCircle} PictureCircle */
/** @typedef {import('../../core/geometry.js').Point} Point */
/** @typedef {{encoding:'deflate-tuples-v1', bytes:number, data:string}|{encoding:'tuples-v1', data:PictureStorageTuple}} EncodedPictureArtwork */
/** @typedef {[number, number, 0|1|2, number, unknown[]]} PictureStorageTuple */
/** @typedef {Record<string, unknown> & {encoding?:unknown, bytes?:unknown, data?:unknown}} SavedPictureArtwork */

const MAX_BYTES = 8 * 1024 * 1024;
/** @type {readonly ['invert', 'flipHorizontal', 'flipVertical']} */
const FLAGS = ['invert', 'flipHorizontal', 'flipVertical'];
/** @type {readonly ['rectangles', 'contours', 'circles']} */
const KINDS = ['rectangles', 'contours', 'circles'];
/** @type {WeakMap<PictureArtwork, {json:string, encoded:EncodedPictureArtwork}>} */
const cache = new WeakMap();

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function base64(bytes) {
    let text = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) {
        text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    }
    return btoa(text);
}

/**
 * @param {PictureArtwork} artwork
 * @returns {EncodedPictureArtwork}
 */
export function encodePictureArtwork(artwork) {
    validatePictureArtwork(artwork);
    /** @type {0|1|2} */
    let kind;
    /** @type {PictureStorageTuple[4]} */
    let geometry;
    if (Array.isArray(artwork.rectangles)) {
        kind = 0;
        geometry = artwork.rectangles.flatMap(rectangle => [rectangle.x, rectangle.y, rectangle.width, rectangle.height]);
    } else if (Array.isArray(artwork.contours)) {
        kind = 1;
        geometry = artwork.contours.map(contour => contour.flatMap(point => [point.x, point.y]));
    } else {
        kind = 2;
        geometry = /** @type {PictureCircle[]} */ (artwork.circles).flatMap(circle => [circle.x, circle.y, circle.radius]);
    }
    const flags = FLAGS.reduce((bits, key, index) => bits
        | (artwork[key] === undefined ? 0 : (artwork[key] ? 3 : 1) << (index * 2)), 0);
    const data = /** @type {PictureStorageTuple} */ ([artwork.width, artwork.height, kind, flags, geometry]);
    const json = JSON.stringify(data);
    const previous = cache.get(artwork);
    if (previous?.json === json) return structuredClone(previous.encoded);
    const bytes = strToU8(json);
    if (bytes.length > MAX_BYTES) throw new Error('Image storage payload is too large.');
    /** @type {EncodedPictureArtwork} */
    const packed = { encoding: 'deflate-tuples-v1', bytes: bytes.length, data: base64(deflateSync(bytes, { level: 9 })) };
    /** @type {EncodedPictureArtwork} */
    const plain = { encoding: 'tuples-v1', data };
    const encoded = JSON.stringify(packed).length < JSON.stringify(plain).length ? packed : plain;
    cache.set(artwork, { json, encoded });
    return structuredClone(encoded);
}

/**
 * @param {unknown} saved
 * @returns {PictureArtwork}
 */
export function decodePictureArtwork(saved) {
    const stored = /** @type {SavedPictureArtwork|null|undefined} */ (saved);
    let data;
    if (stored?.encoding === 'tuples-v1') data = stored.data;
    else if (stored?.encoding === 'deflate-tuples-v1') {
        const storedBytes = typeof stored.bytes === 'number' ? stored.bytes : NaN;
        if (!Number.isInteger(storedBytes) || storedBytes < 1 || storedBytes > MAX_BYTES
            || typeof stored.data !== 'string' || stored.data.length > MAX_BYTES * 2) {
            throw new Error('Invalid compressed image size.');
        }
        const compressed = Uint8Array.from(atob(stored.data), character => character.charCodeAt(0));
        const bytes = inflateSync(compressed, { out: new Uint8Array(storedBytes) });
        if (bytes.length !== storedBytes) throw new Error('Invalid compressed image length.');
        data = JSON.parse(strFromU8(bytes));
    } else throw new Error('Unsupported image storage encoding.');
    if (!Array.isArray(data) || data.length !== 5) throw new Error('Invalid image storage tuple.');
    const [rawWidth, rawHeight, kind, flags, geometry] = data;
    const width = /** @type {number} */ (rawWidth);
    const height = /** @type {number} */ (rawHeight);
    if (![0, 1, 2].includes(kind) || !Number.isInteger(flags) || flags < 0 || flags > 63
        || !Array.isArray(geometry)) throw new Error('Invalid image storage metadata.');
    const kindNumber = /** @type {0|1|2} */ (kind);
    const flagBits = /** @type {number} */ (flags);
    /**
     * @template T
     * @param {unknown} values
     * @param {number} stride
     * @param {(values:number[], index:number)=>T} build
     * @returns {T[]}
     */
    const tuples = (values, stride, build) => {
        if (!Array.isArray(values) || values.length % stride || !values.every(Number.isFinite)) {
            throw new Error('Invalid image coordinate tuple.');
        }
        const numbers = /** @type {number[]} */ (values);
        /** @type {T[]} */
        const result = [];
        for (let index = 0; index < numbers.length; index += stride) result.push(build(numbers, index));
        return result;
    };
    /** @type {PictureArtwork} */
    let artwork;
    if (kindNumber === 0) {
        artwork = { width, height, rectangles: tuples(geometry, 4,
            (values, index) => ({ x: values[index], y: values[index + 1], width: values[index + 2], height: values[index + 3] })) };
    } else if (kindNumber === 1) {
        artwork = { width, height, contours: geometry.map(contour => tuples(contour, 2,
            (values, index) => ({ x: values[index], y: values[index + 1] }))) };
    } else {
        artwork = { width, height, circles: tuples(geometry, 3,
            (values, index) => ({ x: values[index], y: values[index + 1], radius: values[index + 2] })) };
    }
    FLAGS.forEach((key, index) => {
        const value = (flagBits >> (index * 2)) & 3;
        if (value === 2) throw new Error('Invalid image storage flags.');
        if (value & 1) artwork[key] = value === 3;
    });
    validatePictureArtwork(artwork);
    return artwork;
}