import ClipperLib from '../../../assets/vendor/clipper.esm.js';
import earcut from '../../../assets/vendor/earcut.module.js';

export function contourRegions(contours) {
    const scale = 1e6;
    const clipper = new ClipperLib.Clipper();
    clipper.AddPaths(contours.filter(contour => contour.length >= 3).map(contour => contour.map(point => ({
        X: Math.round(point.x * scale), Y: Math.round(point.y * scale),
    }))), ClipperLib.PolyType.ptSubject, true);
    const tree = new ClipperLib.PolyTree();
    clipper.Execute(ClipperLib.ClipType.ctUnion, tree,
        ClipperLib.PolyFillType.pftEvenOdd, ClipperLib.PolyFillType.pftEvenOdd);
    const convert = ring => ring.map(point => ({ x: point.X / scale, y: point.Y / scale }));
    return ClipperLib.JS.PolyTreeToExPolygons(tree).map(region => ({
        outer: convert(region.outer), holes: region.holes.map(convert),
    }));
}

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