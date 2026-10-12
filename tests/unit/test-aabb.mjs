function segmentIntersectsAABB(x1, y1, x2, y2, rxMin, ryMin, rxMax, ryMax) {
    if (x1 >= rxMin && x1 <= rxMax && y1 >= ryMin && y1 <= ryMax) return true;
    if (x2 >= rxMin && x2 <= rxMax && y2 >= ryMin && y2 <= ryMax) return true;
    const dx = x2 - x1, dy = y2 - y1;
    let tMin = 0, tMax = 1;
    const edges = [[-dx, x1 - rxMin], [dx, rxMax - x1], [-dy, y1 - ryMin], [dy, ryMax - y1]];
    for (const [p, q] of edges) {
        if (Math.abs(p) < 1e-10) { if (q < 0) return false; }
        else { const t = q / p; if (p < 0) { if (t > tMax) return false; tMin = Math.max(tMin, t); } else { if (t < tMin) return false; tMax = Math.min(tMax, t); } }
    }
    return tMin <= tMax;
}
const pcx=6.3, pcy=7.6, hw=0.35, hh=0.35, cl=0.33;
console.log("AABB:", (pcx-hw-cl).toFixed(2), (pcy-hh-cl).toFixed(2), (pcx+hw+cl).toFixed(2), (pcy+hh+cl).toFixed(2));
console.log("Test1 horiz y=7.5:", segmentIntersectsAABB(-5.5, 7.5, 16.5, 7.5, pcx-hw-cl, pcy-hh-cl, pcx+hw+cl, pcy+hh+cl));
console.log("Test2 horiz y=7.5:", segmentIntersectsAABB(22.0, 7.5, 6.5, 7.5, pcx-hw-cl, pcy-hh-cl, pcx+hw+cl, pcy+hh+cl));
console.log("Test3 vert miss:", segmentIntersectsAABB(0, 0, 0, 20, pcx-hw-cl, pcy-hh-cl, pcx+hw+cl, pcy+hh+cl));
console.log("Test4 through center:", segmentIntersectsAABB(0, 7.6, 20, 7.6, pcx-hw-cl, pcy-hh-cl, pcx+hw+cl, pcy+hh+cl));
