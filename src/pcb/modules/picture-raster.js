import ClipperLib from '../../../assets/vendor/clipper.esm.js';
import earcut from '../../../assets/vendor/earcut.module.js';

const artworkCache = new WeakMap();
const geometryCache = new WeakMap();

export const PICTURE_LAYERS = ['top-silk', 'bottom-silk', 'top-copper', 'bottom-copper', 'top-document', 'bottom-document'];
export const MAX_PICTURE_REGIONS = 2000;

export function pictureShape(raster, { widthMm, layer, center = { x: 0, y: 0 }, net = '', name = 'Image' }) {
    if (!PICTURE_LAYERS.includes(layer)) throw new Error('Choose a silk, copper or document layer.');
    const pitch = widthMm / raster.width;
    if (!Number.isFinite(pitch) || pitch < 0.1 || widthMm > 500 || raster.height * pitch > 500) {
        throw new Error('Pixel size must be at least 0.1 mm and dimensions at most 500 mm.');
    }
    const artwork = { width: raster.width, height: raster.height, rectangles: raster.rectangles.map(rectangle => ({ ...rectangle })) };
    validatePictureArtwork(artwork);
    mergedArtwork(artwork);
    const left = center.x - widthMm / 2;
    const top = center.y - artwork.height * pitch / 2;
    return { kind: 'image', name, layer, filled: true, lineWidth: 0.05, copperMode: 'add',
        net: layer.endsWith('copper') ? net.trim() : '', artwork,
        points: [{ x: left, y: top }, { x: left + widthMm, y: top },
            { x: left + widthMm, y: top + artwork.height * pitch }, { x: left, y: top + artwork.height * pitch }] };
}

export function validatePictureArtwork(artwork) {
    if (!artwork || !Number.isInteger(artwork.width) || !Number.isInteger(artwork.height)
        || artwork.width < 1 || artwork.height < 1 || artwork.width > 512 || artwork.height > 512
        || !Array.isArray(artwork.rectangles) || !artwork.rectangles.length || artwork.rectangles.length > MAX_PICTURE_REGIONS) {
        throw new Error('Image artwork is empty or too detailed. Reduce resolution or adjust the threshold.');
    }
    for (const rectangle of artwork.rectangles) {
        if (!rectangle || !['x', 'y', 'width', 'height'].every(key => Number.isInteger(rectangle[key]))
            || rectangle.x < 0 || rectangle.y < 0 || rectangle.width < 1 || rectangle.height < 1
            || rectangle.x + rectangle.width > artwork.width || rectangle.y + rectangle.height > artwork.height) {
            throw new Error('Invalid image artwork data.');
        }
    }
}

export function validatePicturePoints(points) {
    if (!Array.isArray(points) || points.length !== 4
        || !points.every(point => point && Number.isFinite(point.x) && Number.isFinite(point.y))) {
        throw new Error('Invalid image bounding points.');
    }
    const horizontal = { x: points[1].x - points[0].x, y: points[1].y - points[0].y };
    const vertical = { x: points[3].x - points[0].x, y: points[3].y - points[0].y };
    const width = Math.hypot(horizontal.x, horizontal.y);
    const height = Math.hypot(vertical.x, vertical.y);
    if (width < 1e-9 || height < 1e-9
        || Math.abs(horizontal.x * vertical.x + horizontal.y * vertical.y) > 1e-6 * width * height
        || Math.hypot(points[2].x - points[1].x - vertical.x, points[2].y - points[1].y - vertical.y) > 1e-6 * Math.max(width, height)) {
        throw new Error('Image bounds must form a nonempty rectangle.');
    }
}

function mergedArtwork(artwork) {
    const cached = artworkCache.get(artwork);
    if (cached) return cached;
    const scale = 10000;
    const clipper = new ClipperLib.Clipper();
    clipper.StrictlySimple = true;
    clipper.AddPaths(artwork.rectangles.map(({ x, y, width, height }) => [
        { X: x, Y: y }, { X: x + width, Y: y },
        { X: x + width, Y: y + height }, { X: x, Y: y + height },
    ].map(point => ({ X: point.X * scale, Y: point.Y * scale }))), ClipperLib.PolyType.ptSubject, true);
    const tree = new ClipperLib.PolyTree();
    clipper.Execute(ClipperLib.ClipType.ctUnion, tree,
        ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
    const regions = ClipperLib.JS.PolyTreeToExPolygons(tree).map(region => ({
        outer: ClipperLib.Clipper.CleanPolygon(region.outer, 0.01).map(point => ({ x: point.X / scale, y: point.Y / scale })),
        holes: region.holes.map(hole => ClipperLib.Clipper.CleanPolygon(hole, 0.01).map(point => ({ x: point.X / scale, y: point.Y / scale }))),
    }));
    const triangles = regions.flatMap(region => {
        const rings = [region.outer, ...region.holes];
        const points = rings.flat();
        const holes = [];
        let offset = region.outer.length;
        for (const hole of region.holes) { holes.push(offset); offset += hole.length; }
        const indices = earcut(points.flatMap(point => [point.x, point.y]), holes, 2);
        const result = [];
        for (let index = 0; index < indices.length; index += 3) {
            result.push(indices.slice(index, index + 3).map(vertex => points[vertex]));
        }
        return result;
    });
    const result = { regions, triangles };
    artworkCache.set(artwork, result);
    return result;
}

function pictureGeometry(shape) {
    const { artwork, points } = shape;
    const key = points.flatMap(point => [point.x, point.y]).join(',');
    const cached = geometryCache.get(shape);
    if (cached?.artwork === artwork && cached.key === key) return cached;
    const source = mergedArtwork(artwork);
    const origin = points[0];
    const map = ({ x: column, y: row }) => ({
        x: origin.x + (points[1].x - origin.x) * column / artwork.width + (points[3].x - origin.x) * row / artwork.height,
        y: origin.y + (points[1].y - origin.y) * column / artwork.width + (points[3].y - origin.y) * row / artwork.height,
    });
    const regions = source.regions.map(region => ({ outer: region.outer.map(map), holes: region.holes.map(hole => hole.map(map)) }));
    const result = { artwork, key, regions, contours: regions.flatMap(region => [region.outer, ...region.holes]),
        triangles: source.triangles.map(triangle => triangle.map(map)) };
    geometryCache.set(shape, result);
    return result;
}

export function pictureContours(shape) {
    return pictureGeometry(shape).contours;
}

export function pictureRegions(shape) {
    return pictureGeometry(shape).regions;
}

export function pictureTriangles(shape) {
    return pictureGeometry(shape).triangles;
}

export function resizePicturePoints(points, index, target) {
    const opposite = points[(index + 2) % 4];
    const corner = points[index];
    const dx = corner.x - opposite.x;
    const dy = corner.y - opposite.y;
    const diagonalSquared = dx * dx + dy * dy;
    if (diagonalSquared < 1e-12) return points.map(point => ({ ...point }));
    const factor = Math.max(0.01, ((target.x - opposite.x) * dx + (target.y - opposite.y) * dy) / diagonalSquared);
    return points.map(point => ({ x: opposite.x + (point.x - opposite.x) * factor,
        y: opposite.y + (point.y - opposite.y) * factor }));
}

export function rasterizePicture({ data, width, height }, { threshold = 128, invert = false } = {}) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
        || width * height > 262144 || data.length !== width * height * 4) {
        throw new Error('Invalid or oversized image pixel data.');
    }
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 255) throw new Error('Invalid threshold.');
    const mask = new Uint8Array(width * height);
    const rectangles = [];
    let active = new Map();
    for (let row = 0; row < height; row++) {
        const next = new Map();
        let column = 0;
        while (column < width) {
            const offset = (row * width + column) * 4;
            const alpha = data[offset + 3] / 255;
            const luminance = (0.2126 * data[offset] + 0.7152 * data[offset + 1] + 0.0722 * data[offset + 2]) * alpha + 255 * (1 - alpha);
            mask[row * width + column] = alpha > 0 && (invert ? luminance >= threshold : luminance <= threshold) ? 1 : 0;
            column++;
        }
        column = 0;
        while (column < width) {
            if (!mask[row * width + column]) { column++; continue; }
            const start = column;
            while (column < width && mask[row * width + column]) column++;
            const key = `${start}:${column}`;
            let rectangle = active.get(key);
            if (rectangle) rectangle.height++;
            else {
                rectangle = { x: start, y: row, width: column - start, height: 1 };
                rectangles.push(rectangle);
            }
            next.set(key, rectangle);
        }
        active = next;
    }
    return { width, height, mask, rectangles };
}

