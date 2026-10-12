import ImageTracer from '../../../assets/vendor/imagetracer.js';
import { MAX_PICTURE_VERTICES, MAX_TRACE_RESOLUTION, validatePictureArtwork } from '../../shared/pcb/picture-raster.js';

/** @typedef {{x:number,y:number}} Point */
/** @typedef {{width:number,height:number,mask:ArrayLike<number>}} PictureRaster */
/** @typedef {{type:'L',x1:number,y1:number,x2:number,y2:number}|{type:'Q',x1:number,y1:number,x2:number,y2:number,x3:number,y3:number}} TraceSegment */
/** @typedef {{segments: TraceSegment[]}} TracePath */
/** @typedef {{layers: TracePath[][]}} TraceData */

/**
 * @param {PictureRaster} raster
 * @param {{simplify?: number, despeckle?: number, preserveCorners?: boolean}} [options]
 */
export function tracePicture(raster, { simplify = 1, despeckle = 0, preserveCorners = true } = {}) {
    if (!Number.isFinite(simplify) || simplify < 0 || simplify > 5
        || !Number.isFinite(despeckle) || despeckle < 0 || despeckle > 128) {
        throw new Error('Invalid image tracing settings.');
    }
    const { width, height, mask } = raster;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
        || width > MAX_TRACE_RESOLUTION || height > MAX_TRACE_RESOLUTION || mask?.length !== width * height) {
        throw new Error('Invalid image tracing pixels.');
    }
    const data = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < mask.length; index++) {
        const shade = mask[index] ? 255 : 0;
        data.set([shade, shade, shade, 255], index * 4);
    }
    const traced = /** @type {TraceData} */ (ImageTracer.imagedataToTracedata({ width, height, data }, {
        pal: [{ r: 0, g: 0, b: 0, a: 255 }, { r: 255, g: 255, b: 255, a: 255 }],
        colorsampling: 0, colorquantcycles: 1, layering: 0,
        ltres: simplify, qtres: simplify, pathomit: despeckle,
        rightangleenhance: preserveCorners, blurradius: 0,
    }));
    let vertices = 0;
    /** @type {Point[][]} */
    const contours = [];
    for (const path of traced.layers[1] || []) {
        /** @type {Point[]} */
        const contour = [];
        /** @param {number} x @param {number} y */
        const append = (x, y) => {
            const point = { x: Math.max(0, Math.min(width, x)), y: Math.max(0, Math.min(height, y)) };
            const previous = contour.at(-1);
            if (previous && previous.x === point.x && previous.y === point.y) return;
            if (++vertices > MAX_PICTURE_VERTICES) {
                throw new Error(`Traced artwork exceeds ${MAX_PICTURE_VERTICES} points. Increase simplification or reduce resolution.`);
            }
            contour.push(point);
        };
        for (const segment of path.segments) {
            append(segment.x1, segment.y1);
            if (segment.type === 'L') {
                append(segment.x2, segment.y2);
            } else if (segment.type === 'Q') {
                const curvature = Math.hypot(segment.x1 - 2 * segment.x2 + segment.x3,
                    segment.y1 - 2 * segment.y2 + segment.y3);
                const steps = Math.max(1, Math.ceil(Math.sqrt(curvature / (4 * 0.125))));
                for (let step = 1; step <= steps; step++) {
                    const ratio = step / steps;
                    const remaining = 1 - ratio;
                    append(remaining * remaining * segment.x1 + 2 * remaining * ratio * segment.x2 + ratio * ratio * segment.x3,
                        remaining * remaining * segment.y1 + 2 * remaining * ratio * segment.y2 + ratio * ratio * segment.y3);
                }
            } else {
                throw new Error('Unsupported traced image segment.');
            }
        }
        const last = contour.at(-1);
        if (contour.length > 1 && last && contour[0].x === last.x && contour[0].y === last.y) contour.pop();
        if (contour.length >= 3) contours.push(contour);
    }
    const artwork = { width, height, contours };
    validatePictureArtwork(artwork);
    return artwork;
}