import ClipperLib from '../../../assets/vendor/clipper.esm.js';
import earcut from '../../../assets/vendor/earcut.module.js';

/** @typedef {{x: number, y: number}} Point */
/** @typedef {import('./copper-fill-geom.js').ClipperPoint} ClipperPoint */
/** @typedef {{outer: Point[], holes: Point[][]}} Region */

/**
 * @param {Point[][]} contours
 * @returns {Region[]}
 */
export function contourRegions(contours) {
    const scale = 1e6;
    const clipper = new ClipperLib.Clipper();
    clipper.AddPaths(contours.filter(contour => contour.length >= 3).map(contour => contour.map(point => ({
        X: Math.round(point.x * scale), Y: Math.round(point.y * scale),
    }))), ClipperLib.PolyType.ptSubject, true);
    const tree = new ClipperLib.PolyTree();
    clipper.Execute(ClipperLib.ClipType.ctUnion, tree,
        ClipperLib.PolyFillType.pftEvenOdd, ClipperLib.PolyFillType.pftEvenOdd);
    /** @param {ClipperPoint[]} ring */
    const convert = ring => ring.map(point => ({ x: point.X / scale, y: point.Y / scale }));
    return ClipperLib.JS.PolyTreeToExPolygons(tree).map((
        /** @type {{outer: ClipperPoint[], holes: ClipperPoint[][]}} */ region
    ) => ({
        outer: convert(region.outer), holes: region.holes.map(convert),
    }));
}

/**
 * @param {Point[][]} contours
 * @returns {Point[][]}
 */
export function regionFillContours(contours) {
    return contourRegions(contours).flatMap(region => {
        if (!region.holes.length) return [region.outer];
        const points = [region.outer, ...region.holes].flat();
        let offset = region.outer.length;
        const holes = region.holes.map(hole => {
            const start = offset;
            offset += hole.length;
            return start;
        });
        const indices = earcut(points.flatMap(point => [point.x, point.y]), holes);
        const triangles = [];
        for (let index = 0; index < indices.length; index += 3) {
            triangles.push(indices.slice(index, index + 3).map(vertex => points[vertex]));
        }
        return triangles;
    });
}