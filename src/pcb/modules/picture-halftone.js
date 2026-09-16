import { MAX_PICTURE_CIRCLES, MAX_TRACE_RESOLUTION, validatePictureArtwork } from './picture-raster.js';

export function halftonePicture(image, { widthMm = 30, dotSizeMm = 0.8, invert = false } = {}) {
    const { width, height, data } = image;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
        || width > MAX_TRACE_RESOLUTION || height > MAX_TRACE_RESOLUTION || data?.length !== width * height * 4) {
        throw new Error('Invalid halftone image pixels.');
    }
    if (!Number.isFinite(widthMm) || widthMm <= 0 || widthMm > 500
        || !Number.isFinite(dotSizeMm) || dotSizeMm < 0.05 || dotSizeMm > 10 || typeof invert !== 'boolean') {
        throw new Error('Invalid halftone settings.');
    }
    if (dotSizeMm > 0.9 * Math.min(widthMm, widthMm * height / width)) {
        throw new Error('Dot size is too large for this image. Reduce dot size or increase image width.');
    }
    const dotDiameter = dotSizeMm * width / widthMm;
    const pitch = Math.max(1, dotDiameter / 0.9);
    const columns = Math.max(1, Math.floor(width / pitch));
    const rows = Math.max(1, Math.floor(height / pitch));
    const cellWidth = width / columns;
    const cellHeight = height / rows;
    const totals = new Float64Array(columns * rows);
    const samples = new Uint32Array(columns * rows);
    for (let row = 0; row < height; row++) {
        const cellRow = Math.min(rows - 1, Math.floor((row + 0.5) / cellHeight));
        for (let column = 0; column < width; column++) {
            const cellColumn = Math.min(columns - 1, Math.floor((column + 0.5) / cellWidth));
            const cell = cellRow * columns + cellColumn;
            const pixel = (row * width + column) * 4;
            const luminance = (2126 * data[pixel] + 7152 * data[pixel + 1] + 722 * data[pixel + 2]) / 2550000;
            totals[cell] += (invert ? 1 - luminance : luminance) * data[pixel + 3] / 255;
            samples[cell]++;
        }
    }
    const circles = [];
    for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
            const cell = row * columns + column;
            const tone = samples[cell] ? Math.max(0, Math.min(1, totals[cell] / samples[cell])) : 0;
            if (tone === 0) continue;
            const radius = dotDiameter / 2 * Math.sqrt(tone);
            if (circles.length >= MAX_PICTURE_CIRCLES) {
                throw new Error(`Halftone exceeds ${MAX_PICTURE_CIRCLES} dots. Increase dot size or reduce image width.`);
            }
            const centerX = (column + 0.5) * cellWidth;
            const centerY = (row + 0.5) * cellHeight;
            circles.push({ x: centerX, y: centerY, radius });
        }
    }
    if (!circles.length) throw new Error('Halftone artwork is empty. Invert the image or choose a different photo.');
    const artwork = { width, height, circles };
    validatePictureArtwork(artwork);
    return artwork;
}