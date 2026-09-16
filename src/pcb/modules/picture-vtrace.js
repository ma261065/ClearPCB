import initialize, { vectorize_rgba } from '../../../assets/vendor/vtracer_wasm.js';
import { flattenSvgPath } from './board-geometry.js';
import { MAX_PICTURE_VERTICES, MAX_TRACE_RESOLUTION, validatePictureArtwork } from './picture-raster.js';

export async function tracePicture(raster, { smooth = 1, speckle = 0 } = {}) {
    if (!Number.isFinite(smooth) || smooth < 0 || smooth > 5
        || !Number.isInteger(speckle) || speckle < 0 || speckle > 128) {
        throw new Error('Invalid VTracer settings.');
    }
    const { width, height, mask } = raster;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
        || width > MAX_TRACE_RESOLUTION || height > MAX_TRACE_RESOLUTION || mask?.length !== width * height) {
        throw new Error('Invalid image tracing pixels.');
    }
    if (!mask.some(Boolean)) throw new Error('The thresholded artwork is empty.');
    await initialize();
    const data = new Uint8Array(width * height * 4);
    for (let index = 0; index < mask.length; index++) {
        const shade = mask[index] ? 0 : 255;
        data.set([shade, shade, shade, 255], index * 4);
    }
    let svg;
    try {
        svg = vectorize_rgba(data, width, height, {
            clustering: 'bw', mode: 'spline', filterSpeckle: speckle,
            ...(smooth > 0 ? { simplify: smooth } : {}),
            cornerThreshold: 60, lengthThreshold: 4, spliceThreshold: 45,
            pathPrecision: 4, optimize: 0,
        });
    } catch (error) {
        throw new Error(`VTracer failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
    if (document.querySelector('parsererror')) throw new Error('Invalid VTracer SVG output.');
    const contours = [];
    let vertices = 0;
    for (const path of document.querySelectorAll('path')) {
        if (path.hasAttribute('transform') || path.getAttribute('fill') !== '#000000') {
            throw new Error('Unsupported VTracer path output.');
        }
        for (const points of flattenSvgPath(path.getAttribute('d'), 16, 0.125)) {
            const contour = [];
            for (const point of points) {
                const bounded = { x: Math.max(0, Math.min(width, point.x)), y: Math.max(0, Math.min(height, point.y)) };
                const previous = contour.at(-1);
                if (previous?.x === bounded.x && previous?.y === bounded.y) continue;
                if (++vertices > MAX_PICTURE_VERTICES) {
                    throw new Error(`Traced artwork exceeds ${MAX_PICTURE_VERTICES} points. Increase smoothing or reduce resolution.`);
                }
                contour.push(bounded);
            }
            if (contour.length > 1 && contour[0].x === contour.at(-1).x && contour[0].y === contour.at(-1).y) contour.pop();
            if (contour.length >= 3) contours.push(contour);
        }
    }
    const artwork = { width, height, contours };
    validatePictureArtwork(artwork);
    return artwork;
}