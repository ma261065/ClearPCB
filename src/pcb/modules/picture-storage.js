import { deflateSync, inflateSync, strToU8, strFromU8 } from '../../../assets/vendor/fflate.module.js';
import { validatePictureArtwork } from './picture-raster.js';

const MAX_BYTES = 8 * 1024 * 1024;
const FLAGS = ['invert', 'flipHorizontal', 'flipVertical'];
const KINDS = ['rectangles', 'contours', 'circles'];
const cache = new WeakMap();

function base64(bytes) {
    let text = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) {
        text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    }
    return btoa(text);
}

export function encodePictureArtwork(artwork) {
    validatePictureArtwork(artwork);
    const kind = KINDS.findIndex(key => Array.isArray(artwork[key]));
    const flags = FLAGS.reduce((bits, key, index) => bits
        | (artwork[key] === undefined ? 0 : (artwork[key] ? 3 : 1) << (index * 2)), 0);
    const geometry = kind === 0
        ? artwork.rectangles.flatMap(rectangle => [rectangle.x, rectangle.y, rectangle.width, rectangle.height])
        : kind === 1 ? artwork.contours.map(contour => contour.flatMap(point => [point.x, point.y]))
        : artwork.circles.flatMap(circle => [circle.x, circle.y, circle.radius]);
    const data = [artwork.width, artwork.height, kind, flags, geometry];
    const json = JSON.stringify(data);
    const previous = cache.get(artwork);
    if (previous?.json === json) return structuredClone(previous.encoded);
    const bytes = strToU8(json);
    if (bytes.length > MAX_BYTES) throw new Error('Image storage payload is too large.');
    const packed = { encoding: 'deflate-tuples-v1', bytes: bytes.length, data: base64(deflateSync(bytes, { level: 9 })) };
    const plain = { encoding: 'tuples-v1', data };
    const encoded = JSON.stringify(packed).length < JSON.stringify(plain).length ? packed : plain;
    cache.set(artwork, { json, encoded });
    return structuredClone(encoded);
}

export function decodePictureArtwork(saved) {
    let data;
    if (saved?.encoding === 'tuples-v1') data = saved.data;
    else if (saved?.encoding === 'deflate-tuples-v1') {
        if (!Number.isInteger(saved.bytes) || saved.bytes < 1 || saved.bytes > MAX_BYTES
            || typeof saved.data !== 'string' || saved.data.length > MAX_BYTES * 2) {
            throw new Error('Invalid compressed image size.');
        }
        const compressed = Uint8Array.from(atob(saved.data), character => character.charCodeAt(0));
        const bytes = inflateSync(compressed, { out: new Uint8Array(saved.bytes) });
        if (bytes.length !== saved.bytes) throw new Error('Invalid compressed image length.');
        data = JSON.parse(strFromU8(bytes));
    } else throw new Error('Unsupported image storage encoding.');
    if (!Array.isArray(data) || data.length !== 5) throw new Error('Invalid image storage tuple.');
    const [width, height, kind, flags, geometry] = data;
    if (![0, 1, 2].includes(kind) || !Number.isInteger(flags) || flags < 0 || flags > 63
        || !Array.isArray(geometry)) throw new Error('Invalid image storage metadata.');
    const tuples = (values, stride, build) => {
        if (!Array.isArray(values) || values.length % stride || !values.every(Number.isFinite)) {
            throw new Error('Invalid image coordinate tuple.');
        }
        const result = [];
        for (let index = 0; index < values.length; index += stride) result.push(build(values, index));
        return result;
    };
    const artwork = { width, height };
    artwork[KINDS[kind]] = kind === 0
        ? tuples(geometry, 4, (values, index) => ({ x: values[index], y: values[index + 1], width: values[index + 2], height: values[index + 3] }))
        : kind === 1 ? geometry.map(contour => tuples(contour, 2, (values, index) => ({ x: values[index], y: values[index + 1] })))
        : tuples(geometry, 3, (values, index) => ({ x: values[index], y: values[index + 1], radius: values[index + 2] }));
    FLAGS.forEach((key, index) => {
        const value = (flags >> (index * 2)) & 3;
        if (value === 2) throw new Error('Invalid image storage flags.');
        if (value & 1) artwork[key] = value === 3;
    });
    validatePictureArtwork(artwork);
    return artwork;
}