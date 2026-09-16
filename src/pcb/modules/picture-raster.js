import ClipperLib from '../../../assets/vendor/clipper.esm.js';
import earcut from '../../../assets/vendor/earcut.module.js';

const artworkCache = new WeakMap();
const geometryCache = new WeakMap();
const nativeCircleCache = new WeakMap();
const canvasPathCache = new WeakMap();
const bitmapCache = new WeakMap();

export const PICTURE_LAYERS = ['top-silk', 'bottom-silk', 'top-copper', 'bottom-copper', 'top-document', 'bottom-document'];
export const MAX_PICTURE_REGIONS = 2000;
export const MAX_PICTURE_VERTICES = 50000;
export const MAX_PICTURE_CIRCLES = 20000;
export const MAX_TRACE_RESOLUTION = 2048;

export function pictureShape(raster, { widthMm, layer, center = { x: 0, y: 0 }, net = '', name = 'Image' }) {
    if (!PICTURE_LAYERS.includes(layer)) throw new Error('Choose a silk, copper or document layer.');
    const pitch = widthMm / raster.width;
    if (!Number.isFinite(pitch) || pitch <= 0 || (!raster.contours && !raster.circles && pitch < 0.1) || widthMm > 500 || raster.height * pitch > 500) {
        throw new Error('Pixel size must be at least 0.1 mm and dimensions at most 500 mm.');
    }
    const artwork = raster.circles
        ? { width: raster.width, height: raster.height, circles: structuredClone(raster.circles) }
        : raster.contours
        ? { width: raster.width, height: raster.height, contours: structuredClone(raster.contours) }
        : { width: raster.width, height: raster.height, rectangles: raster.rectangles.map(rectangle => ({ ...rectangle })) };
    validatePictureArtwork(artwork);
    const left = center.x - widthMm / 2;
    const top = center.y - artwork.height * pitch / 2;
    return { kind: 'image', name, layer, filled: true, lineWidth: 0.05, copperMode: 'add',
        net: layer.endsWith('copper') ? net.trim() : '', artwork,
        points: [{ x: left, y: top }, { x: left + widthMm, y: top },
            { x: left + widthMm, y: top + artwork.height * pitch }, { x: left, y: top + artwork.height * pitch }] };
}

export function validatePictureArtwork(artwork) {
    const maxSide = Array.isArray(artwork?.contours) || Array.isArray(artwork?.circles) ? MAX_TRACE_RESOLUTION : 512;
    if (!artwork || !Number.isInteger(artwork.width) || !Number.isInteger(artwork.height)
        || artwork.width < 1 || artwork.height < 1 || artwork.width > maxSide || artwork.height > maxSide
        || !['rectangles', 'contours', 'circles'].some(key => Array.isArray(artwork[key]))) {
        throw new Error(`Invalid image artwork data. Dimensions must be between 1 and ${maxSide} pixels with rectangles, contours or circles.`);
    }
    if (['rectangles', 'contours', 'circles'].filter(key => artwork[key] !== undefined).length !== 1) {
        throw new Error('Image artwork must use only one representation: rectangles, contours or circles.');
    }
    const paths = artwork.circles ?? artwork.contours ?? artwork.rectangles;
    if (!paths.length) {
        throw new Error('Image artwork is empty: no pixels remain after conversion. Adjust the threshold or invert the image.');
    }
    if (artwork.rectangles && artwork.rectangles.length > MAX_PICTURE_REGIONS) {
        throw new Error(`Image artwork has ${artwork.rectangles.length} rectangles; the limit is ${MAX_PICTURE_REGIONS}. Reduce resolution or adjust the threshold to simplify the artwork.`);
    }
    for (const property of ['invert', 'flipHorizontal', 'flipVertical']) {
        if (artwork[property] !== undefined && typeof artwork[property] !== 'boolean') {
            throw new Error(`Invalid image artwork ${property}: expected a boolean.`);
        }
    }
    if (artwork.circles !== undefined) {
        if (!Array.isArray(artwork.circles) || artwork.circles.length > MAX_PICTURE_CIRCLES) {
            throw new Error(`Image artwork exceeds ${MAX_PICTURE_CIRCLES} circles. Increase dot size or reduce image width.`);
        }
        for (const circle of artwork.circles) {
            if (!circle || ![circle.x, circle.y, circle.radius].every(Number.isFinite)
                || circle.radius <= 0 || circle.x - circle.radius < 0 || circle.y - circle.radius < 0
                || circle.x + circle.radius > artwork.width || circle.y + circle.radius > artwork.height) {
                throw new Error('Invalid image circle coordinates or radius.');
            }
        }
        return;
    }
    if (artwork.contours !== undefined) {
        if (!Array.isArray(artwork.contours) || artwork.rectangles !== undefined
            || artwork.contours.length > MAX_PICTURE_REGIONS) {
            throw new Error(`Invalid traced artwork: use at most ${MAX_PICTURE_REGIONS} contours and no rectangles.`);
        }
        let vertices = 0;
        for (const contour of artwork.contours) {
            if (!Array.isArray(contour) || contour.length < 3) throw new Error('Invalid image contour.');
            vertices += contour.length;
            if (vertices > MAX_PICTURE_VERTICES) throw new Error(`Traced artwork exceeds ${MAX_PICTURE_VERTICES} points. Increase simplification or reduce resolution.`);
            if (!contour.every(point => point && Number.isFinite(point.x) && Number.isFinite(point.y)
                && point.x >= 0 && point.x <= artwork.width && point.y >= 0 && point.y <= artwork.height)) {
                throw new Error('Invalid image contour coordinates.');
            }
        }
        return;
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
    const paths = artwork.circles ? artwork.circles.map(circle => {
        const steps = Math.max(12, Math.ceil(Math.PI / Math.acos(1 - Math.min(0.125 / circle.radius, 1))));
        return Array.from({ length: steps }, (_, index) => {
            const angle = 2 * Math.PI * index / steps;
            return { x: circle.x + circle.radius * Math.cos(angle), y: circle.y + circle.radius * Math.sin(angle) };
        });
    }) : artwork.contours || artwork.rectangles.map(rectangle => {
        const { width, height } = rectangle;
        const { x, y } = rectangle;
        return [
            { x, y }, { x: x + width, y },
            { x: x + width, y: y + height }, { x, y: y + height },
        ];
    });
    clipper.AddPaths(paths.map(path => path.map(point => ({
        X: (artwork.flipHorizontal ? artwork.width - point.x : point.x) * scale,
        Y: (artwork.flipVertical ? artwork.height - point.y : point.y) * scale,
    }))), artwork.invert ? ClipperLib.PolyType.ptClip : ClipperLib.PolyType.ptSubject, true);
    if (artwork.invert) {
        clipper.AddPath([
            { X: 0, Y: 0 }, { X: artwork.width * scale, Y: 0 },
            { X: artwork.width * scale, Y: artwork.height * scale }, { X: 0, Y: artwork.height * scale },
        ], ClipperLib.PolyType.ptSubject, true);
    }
    const tree = new ClipperLib.PolyTree();
    clipper.Execute(artwork.invert ? ClipperLib.ClipType.ctDifference : ClipperLib.ClipType.ctUnion, tree,
        artwork.contours ? ClipperLib.PolyFillType.pftEvenOdd : ClipperLib.PolyFillType.pftNonZero,
        artwork.contours ? ClipperLib.PolyFillType.pftEvenOdd : ClipperLib.PolyFillType.pftNonZero);
    const regions = ClipperLib.JS.PolyTreeToExPolygons(tree).map(region => ({
        outer: ClipperLib.Clipper.CleanPolygon(region.outer, 0.01).map(point => ({ x: point.X / scale, y: point.Y / scale })),
        holes: region.holes.map(hole => ClipperLib.Clipper.CleanPolygon(hole, 0.01).map(point => ({ x: point.X / scale, y: point.Y / scale }))),
    }));
    const result = { regions, triangles: null };
    artworkCache.set(artwork, result);
    return result;
}

function triangulateRegions(regions) {
    return regions.flatMap(region => {
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
        triangles: null, map };
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
    const geometry = pictureGeometry(shape);
    if (!geometry.triangles) {
        const source = mergedArtwork(shape.artwork);
        source.triangles ??= triangulateRegions(source.regions);
        geometry.triangles = source.triangles.map(triangle => triangle.map(geometry.map));
    }
    return geometry.triangles;
}

export function canDrawPictureCircles(artwork) {
    if (!artwork.circles) return false;
    return !artwork.invert || pictureCirclesDisjoint(artwork);
}

export function pictureCirclesDisjoint(artwork) {
    if (!artwork.circles) return false;
    if (nativeCircleCache.has(artwork)) return nativeCircleCache.get(artwork);
    const size = artwork.circles.reduce((largest, circle) => Math.max(largest, circle.radius * 2), 0);
    const buckets = new Map();
    for (const circle of artwork.circles) {
        const column = Math.floor(circle.x / size), row = Math.floor(circle.y / size);
        for (let offsetY = -1; offsetY <= 1; offsetY++) for (let offsetX = -1; offsetX <= 1; offsetX++) {
            for (const other of buckets.get(`${column + offsetX},${row + offsetY}`) || []) {
                if (Math.hypot(circle.x - other.x, circle.y - other.y) < circle.radius + other.radius) {
                    nativeCircleCache.set(artwork, false);
                    return false;
                }
            }
        }
        const key = `${column},${row}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(circle);
    }
    nativeCircleCache.set(artwork, true);
    return true;
}

export function pictureCirclePathD(shape) {
    const { artwork, points } = shape;
    if (!canDrawPictureCircles(artwork)) return null;
    const origin = points[0];
    const horizontal = { x: (points[1].x - origin.x) / artwork.width, y: (points[1].y - origin.y) / artwork.width };
    const vertical = { x: (points[3].x - origin.x) / artwork.height, y: (points[3].y - origin.y) / artwork.height };
    const angle = Math.atan2(horizontal.y, horizontal.x) * 180 / Math.PI;
    const sweep = horizontal.x * vertical.y - horizontal.y * vertical.x < 0 ? 1 : 0;
    const boundary = artwork.invert ? points.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ') + ' Z ' : '';
    return boundary + artwork.circles.map(circle => {
        const column = artwork.flipHorizontal ? artwork.width - circle.x : circle.x;
        const row = artwork.flipVertical ? artwork.height - circle.y : circle.y;
        const centerX = origin.x + horizontal.x * column + vertical.x * row;
        const centerY = origin.y + horizontal.y * column + vertical.y * row;
        const deltaX = horizontal.x * circle.radius, deltaY = horizontal.y * circle.radius;
        const radiusX = Math.hypot(horizontal.x, horizontal.y) * circle.radius;
        const radiusY = Math.hypot(vertical.x, vertical.y) * circle.radius;
        return `M ${centerX + deltaX} ${centerY + deltaY} A ${radiusX} ${radiusY} ${angle} 1 ${sweep} ${centerX - deltaX} ${centerY - deltaY} A ${radiusX} ${radiusY} ${angle} 1 ${sweep} ${centerX + deltaX} ${centerY + deltaY} Z`;
    }).join(' ');
}

export function drawPictureCached(context, shape) {
    const { artwork, points } = shape;
    const document = context.canvas?.ownerDocument;
    if (!document || !context.getTransform || (artwork.circles?.length || 0) < 256
        || typeof context.fillStyle !== 'string') {
        drawPicture(context, shape);
        return;
    }
    const origin = points[0];
    const horizontal = { x: points[1].x - origin.x, y: points[1].y - origin.y };
    const vertical = { x: points[3].x - origin.x, y: points[3].y - origin.y };
    const transform = context.getTransform();
    const pixels = axis => Math.hypot(transform.a * axis.x + transform.c * axis.y,
        transform.b * axis.x + transform.d * axis.y);
    const width = 2 ** Math.ceil(Math.log2(Math.max(1, pixels(horizontal))));
    const height = 2 ** Math.ceil(Math.log2(Math.max(1, pixels(vertical))));
    if (!Number.isFinite(width + height) || width > 2048 || height > 2048) {
        drawPicture(context, shape);
        return;
    }
    const color = context.fillStyle;
    let cached = bitmapCache.get(artwork);
    if (!cached || cached.width !== width || cached.height !== height || cached.color !== color) {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const bitmap = canvas.getContext('2d');
        if (!bitmap) {
            drawPicture(context, shape);
            return;
        }
        bitmap.setTransform(width / artwork.width, 0, 0, height / artwork.height, 0, 0);
        bitmap.fillStyle = color;
        drawPicture(bitmap, { artwork, points: [{ x: 0, y: 0 }, { x: artwork.width, y: 0 },
            { x: artwork.width, y: artwork.height }, { x: 0, y: artwork.height }] });
        cached = { canvas, width, height, color };
        bitmapCache.set(artwork, cached);
    }
    context.save();
    context.transform(horizontal.x / artwork.width, horizontal.y / artwork.width,
        vertical.x / artwork.height, vertical.y / artwork.height, origin.x, origin.y);
    context.drawImage(cached.canvas, 0, 0, artwork.width, artwork.height);
    context.restore();
}

export function drawPicture(context, shape) {
    const { artwork, points } = shape;
    context.beginPath();
    if (canDrawPictureCircles(artwork)) {
        const origin = points[0];
        context.save();
        context.transform((points[1].x - origin.x) / artwork.width, (points[1].y - origin.y) / artwork.width,
            (points[3].x - origin.x) / artwork.height, (points[3].y - origin.y) / artwork.height, origin.x, origin.y);
        const Path = context.canvas?.ownerDocument?.defaultView?.Path2D ?? globalThis.Path2D;
        const cached = canvasPathCache.get(artwork);
        if (Path && cached) {
            context.fill(cached, 'nonzero');
            context.restore();
            return;
        }
        const path = Path ? new Path() : context;
        if (artwork.invert) {
            path.moveTo(0, 0);
            path.lineTo(0, artwork.height);
            path.lineTo(artwork.width, artwork.height);
            path.lineTo(artwork.width, 0);
            path.closePath();
        }
        for (const circle of artwork.circles) {
            const column = artwork.flipHorizontal ? artwork.width - circle.x : circle.x;
            const row = artwork.flipVertical ? artwork.height - circle.y : circle.y;
            path.moveTo(column + circle.radius, row);
            path.arc(column, row, circle.radius, 0, Math.PI * 2);
            path.closePath();
        }
        if (Path) {
            canvasPathCache.set(artwork, path);
            context.fill(path, 'nonzero');
        } else {
            context.fill('nonzero');
        }
        context.restore();
        return;
    }
    for (const contour of pictureContours(shape)) {
        contour.forEach((point, index) => {
            if (index === 0) context.moveTo(point.x, point.y);
            else context.lineTo(point.x, point.y);
        });
        context.closePath();
    }
    context.fill('evenodd');
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

export function rasterizePicture({ data, width, height }, { threshold = 128, invert = false, maskOnly = false } = {}) {
    const maxPixels = maskOnly ? MAX_TRACE_RESOLUTION * MAX_TRACE_RESOLUTION : 262144;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
        || width * height > maxPixels || data.length !== width * height * 4
        || (maskOnly && (width > MAX_TRACE_RESOLUTION || height > MAX_TRACE_RESOLUTION))) {
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
            mask[row * width + column] = alpha > 0 && (invert ? luminance <= threshold : luminance > threshold) ? 1 : 0;
            column++;
        }
        if (maskOnly) continue;
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

