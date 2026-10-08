/**
 * Board layers in 3D: copper tracks and pours, solder mask and its openings,
 * silkscreen, pictures and text.
 * Split from board3d.js; the viewer itself is board3d.js.
 */
import * as THREE from '../../../assets/vendor/three.module.js';
import ClipperLib from '../../../assets/vendor/clipper.esm.js';
import { pictureTriangles, pictureCirclesDisjoint, picturePoints } from '../../shared/pcb/picture-raster.js';
import { getComputedFill } from './computed-fill-cache.js';
import { surfaceInputsEqual } from './board3d-surface-equality.js';
import { makeMaterial } from '../../shared/3d/model-rendering.js';
import { resolveReferenceText } from '../../shared/pcb/reference-text.js';
import { pointInPolygon } from '../../core/geometry.js';
import { resolvePlacementDrills, resolveSilk, resolvePadMaskOpenings, padFlashOutline, MASK_EXPANSION, CORNER_CHORD_TOLERANCE } from '../../shared/pcb/board-geometry.js';
import { buildTrackLayerRuns } from './track-render.js';
import { regionFillContours } from './region-geometry.js';
import { resolveBoardShapeGeometry } from '../../shared/pcb/board-shape-geometry.js';
import { pcbTextPolylines } from './pcb-text.js';
import { FILLED_CIRCLE_SEGMENTS, COLOR_RAW_BOARD, COLOR_SOLDERMASK, COLOR_PAD, COLOR_COPPER_TOP, COLOR_COPPER_BOTTOM, COLOR_VIA, COLOR_SILK, Y_TOP, Y_BOT, COPPER_EPS, PAD_EPS, SILK_EPS, PAD_BARREL_SEGMENTS } from './board3d-params.js';
import { triangulateWithHoles, circleRing, unionBoreRings, polygonWallMesh, polygonWallSegmentsMesh, pointToSegmentDistance } from './board3d-board.js';
import { flatPadMesh, throughHolePadMesh, discMesh, ribbonMesh, flatRingMesh, tubeMesh } from './board3d-parts.js';
import { emptyMesh, appendMesh } from './board3d-mesh-ops.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */
/** @typedef {import('./pcb-editor-api.js').PcbBoard} PcbBoard */
/** @typedef {{x:number,y:number}} Point */
/** @typedef {import('./board3d-mesh-ops.js').XzPoint} XzPoint */
/** @typedef {import('./board3d-mesh-ops.js').MeshVertex} MeshVertex */
/** @typedef {import('./board3d-mesh-ops.js').MeshFace} MeshFace */
/** @typedef {import('./board3d-mesh-ops.js').Mesh & {cull?: boolean}} Mesh */
/** @typedef {{circle?: any, path?: Point[], pathClosed?: boolean, filled?: boolean, lineWidth?: number, strokeSegments?: any[], physicalContours?: Point[][], copperMode?: string}} ResolvedBoardGeometry */
/** @typedef {{x:number,y?:number,z:number,dia?:number,r:number,slot?:null|{x2:number,y2:number,points?:Point[]}, plated?:boolean, ring?:Array<XzPoint>, layer?:string, boardShape?: boolean}} DrillHole */
/** @typedef {{x:number,y:number,size:number,shape:string,layers?:string,rotation?:number,drill:number,holeLength?:number,ratio?:number,locked?:boolean,visible?:boolean,net?:string}} StandalonePad */

/**
 * Build a mesh that strokes a list of 2D polylines as flat ribbons with
 * round joints on a single y-plane. `toWorld(px, py)` maps each polyline
 * point into world (x, z).
 * @param {Array<Array<{x:number,y:number}>>} polys
 * @param {number} strokeWidth @param {number} y @param {number[]} color
 * @param {(px:number, py:number) => {x:number,z:number}} toWorld
 * @returns {Mesh}
 */
function strokePolysToMesh(polys, strokeWidth, y, color, toWorld) {
    const mesh = emptyMesh();
    const sw = strokeWidth > 0 ? strokeWidth : 0.15;
    for (const poly of polys) {
        if (!poly || poly.length === 0) continue;
        if (poly.length === 1) {
            const p = toWorld(poly[0].x, poly[0].y);
            appendMesh(mesh, discMesh(p.x, p.z, sw / 2, y, color, 12));
            continue;
        }
        for (let i = 1; i < poly.length; i++) {
            const a = toWorld(poly[i - 1].x, poly[i - 1].y);
            const b = toWorld(poly[i].x, poly[i].y);
            appendMesh(mesh, ribbonMesh(a.x, a.z, b.x, b.z, sw, y, color));
            appendMesh(mesh, discMesh(a.x, a.z, sw / 2, y, color, 12));
        }
        const last = poly[poly.length - 1];
        const lp = toWorld(last.x, last.y);
        appendMesh(mesh, discMesh(lp.x, lp.z, sw / 2, y, color, 12));
    }
    return mesh;
}

/**
 * Flat mesh for a picture board shape's raster artwork, at one elevation.
 * @param {any} shape picture board shape
 * @param {number} elevation
 * @param {number[]} color
 * @returns {Mesh}
 */
export function imageArtworkMesh(shape, elevation, color) {
    const mesh = emptyMesh();
    const { artwork } = shape;
    const points = picturePoints(shape);
    if (!artwork.invert && pictureCirclesDisjoint(artwork)) {
        const origin = points[0];
        const horizontal = { x: (points[1].x - origin.x) / artwork.width, y: (points[1].y - origin.y) / artwork.width };
        const vertical = { x: (points[3].x - origin.x) / artwork.height, y: (points[3].y - origin.y) / artwork.height };
        for (const circle of artwork.circles) {
            const base = mesh.verts.length;
            const column = artwork.flipHorizontal ? artwork.width - circle.x : circle.x;
            const row = artwork.flipVertical ? artwork.height - circle.y : circle.y;
            const steps = Math.max(12, Math.ceil(Math.PI / Math.acos(1 - Math.min(0.125 / circle.radius, 1))));
            for (let index = 0; index < steps; index++) {
                const angle = index * Math.PI * 2 / steps;
                const sourceX = column + circle.radius * Math.cos(angle);
                const sourceY = row + circle.radius * Math.sin(angle);
                mesh.verts.push({ x: origin.x + horizontal.x * sourceX + vertical.x * sourceY,
                    y: elevation, z: origin.y + horizontal.y * sourceX + vertical.y * sourceY });
            }
            for (let index = 1; index < steps - 1; index++) {
                mesh.faces.push({ idx: [base, base + index, base + index + 1], color });
            }
        }
        return mesh;
    }
    for (const contour of pictureTriangles(shape)) {
        const base = mesh.verts.length;
        for (const point of contour) mesh.verts.push({ x: point.x, y: elevation, z: point.y });
        mesh.faces.push({ idx: [base, base + 1, base + 2], color });
    }
    return mesh;
}

/**
 * Build one combined copper mesh from all routed Tracks. Each edge becomes a
 * flat ribbon on its layer's surface with round end-caps so joints look smooth.
 * @param {Array<any>} tracks
 * @param {Array<any>} [circles] @param {Array<any>} [boardShapes] @param {any} [texts] a Map of texts or an array
 * @returns {Mesh}
 */
export function buildCopperMesh(tracks, circles = [], boardShapes = [], texts = []) {
    const mesh = emptyMesh();
    for (const track of tracks || []) {
        if (!track?.edges || !track?.nodes) continue;
        for (const { points, layer, width } of buildTrackLayerRuns(track)) {
            const bottom = layer === 'bottom-copper';
            const y = bottom ? Y_BOT - COPPER_EPS : Y_TOP + COPPER_EPS;
            const color = bottom ? COLOR_COPPER_BOTTOM : COLOR_COPPER_TOP;
            appendFlatStroke(mesh, points, false, width, y, color);
        }
    }
    // Free-standing circles authored on copper layers.
    for (const c of circles || []) {
        if (c?.type === 'fill') continue;
        if (!c || (c.layer !== 'top-copper' && c.layer !== 'bottom-copper')) continue;
        if (!(c.radius > 0)) continue;
        const geometry = resolveBoardShapeGeometry(c);
        if (geometry.copperMode !== 'add') continue;
        const bottom = c.layer === 'bottom-copper';
        const y = bottom ? Y_BOT - COPPER_EPS : Y_TOP + COPPER_EPS;
        const color = bottom ? COLOR_COPPER_BOTTOM : COLOR_COPPER_TOP;
        if (geometry.filled) appendMesh(mesh, discMesh(c.x, c.y, /** @type {{outerRadius:number}} */ (geometry.circle).outerRadius, y, color, FILLED_CIRCLE_SEGMENTS));
        else appendMesh(mesh, flatRingMesh(c.x, c.y, /** @type {{radius:number}} */ (geometry.circle).radius, geometry.lineWidth, y, color, 32));
    }
    // Non-circular board shapes authored on copper layers. Circles use the
    // specialised disc/ring path above so unfilled rings remain hollow.
    for (const s of boardShapes || []) {
        if (s?.type === 'fill') continue;
        if (s?.kind === 'circle') continue;
        if (!s || (s.layer !== 'top-copper' && s.layer !== 'bottom-copper')) continue;
        const geometry = resolveBoardShapeGeometry(s);
        if (geometry.copperMode !== 'add') continue;
        const o = geometry.path;
        if (!o || o.length < (geometry.filled ? 3 : 2)) continue;
        const bottom = s.layer === 'bottom-copper';
        const y = bottom ? Y_BOT - COPPER_EPS : Y_TOP + COPPER_EPS;
        const color = bottom ? COLOR_COPPER_BOTTOM : COLOR_COPPER_TOP;
        if (s.kind === 'image') {
            appendMesh(mesh, imageArtworkMesh(s, y, color));
            continue;
        }
        if (!geometry.filled) {
            appendResolvedFlatStroke(mesh, geometry, y, color);
            continue;
        }
        let tri = null;
        try { tri = triangulateWithHoles(o.map((/** @type {Point} */ p) => ({ x: p.x, y: p.y })), []); } catch { tri = null; }
        if (!tri || !tri.tris.length) continue;
        const base = mesh.verts.length;
        for (const p of tri.pts) mesh.verts.push({ x: p.x, y, z: p.y });
        for (const t of tri.tris) {
            mesh.faces.push({ idx: [base + t[0], base + t[1], base + t[2]], color });
        }
        appendFlatStroke(mesh, o, geometry.pathClosed, geometry.lineWidth, y, color);
    }
    for (const text of texts?.values?.() || texts || []) {
        if (text.layer !== 'top-copper' && text.layer !== 'bottom-copper') continue;
        const bottom = text.layer === 'bottom-copper';
        const y = bottom ? Y_BOT - COPPER_EPS : Y_TOP + COPPER_EPS;
        const color = bottom ? COLOR_COPPER_BOTTOM : COLOR_COPPER_TOP;
        appendMesh(mesh, strokePolysToMesh(
            pcbTextPolylines(text),
            text.strokeWidth || 0.15,
            y,
            color,
            (x, z) => ({ x, z }),
        ));
    }
    return mesh;
}

/**
 * @param {Point[]} outline
 * @param {boolean} closed
 * @param {number} width
 * @returns {Array<{ring:Array<{x:number,z:number}>}>}
 */
function strokeOutlineHoles(outline, closed, width) {
    const holes = [];
    const radius = width / 2;
    const circleSegments = 12;
    /** @param {Point} point */
    const addDisc = (point) => {
        const ring = [];
        for (let index = 0; index < circleSegments; index++) {
            const angle = (index / circleSegments) * Math.PI * 2;
            ring.push({ x: point.x + radius * Math.cos(angle), z: point.y + radius * Math.sin(angle) });
        }
        holes.push({ ring });
    };
    const segmentCount = closed ? outline.length : outline.length - 1;
    for (let index = 0; index < segmentCount; index++) {
        const start = outline[index];
        const end = outline[(index + 1) % outline.length];
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const length = Math.hypot(dx, dy);
        if (length <= 1e-9) continue;
        const normalX = -dy / length * radius;
        const normalY = dx / length * radius;
        holes.push({ ring: [
            { x: start.x + normalX, z: start.y + normalY },
            { x: end.x + normalX, z: end.y + normalY },
            { x: end.x - normalX, z: end.y - normalY },
            { x: start.x - normalX, z: start.y - normalY },
        ] });
    }
    for (const point of outline) addDisc(point);
    return holes;
}

/** Append a flat round-joined stroke for an open or closed sampled outline.
 * @param {Mesh} mesh
 * @param {Point[]} outline
 * @param {boolean} closed
 * @param {number} width
 * @param {number} y
 * @param {number[]} color
 */
export function appendFlatStroke(mesh, outline, closed, width, y, color) {
    if (outline.length < 2 || !(width > 0)) return;
    const scale = 1e6;
    const offset = new ClipperLib.ClipperOffset(2, CORNER_CHORD_TOLERANCE * scale);
    offset.AddPath(outline.map(point => ({ X: Math.round(point.x * scale), Y: Math.round(point.y * scale) })),
        ClipperLib.JoinType.jtRound, closed ? ClipperLib.EndType.etClosedLine : ClipperLib.EndType.etOpenRound);
    const tree = new ClipperLib.PolyTree();
    offset.Execute(tree, width * scale / 2);
    /** @param {Array<{X:number,Y:number}>} ring */
    const convert = ring => ring.map(point => ({ x: point.X / scale, y: point.Y / scale }));
    for (const region of ClipperLib.JS.PolyTreeToExPolygons(tree)) {
        const triangulation = triangulateWithHoles(convert(region.outer), region.holes.map(convert));
        const base = mesh.verts.length;
        for (const point of triangulation.pts) mesh.verts.push({ x: point.x, y, z: point.y });
        for (const triangle of triangulation.tris) {
            mesh.faces.push({ idx: triangle.map(index => base + index), color });
        }
    }
}

/** @param {Mesh} mesh @param {ResolvedBoardGeometry & {centerlineClosed?: boolean}} geometry @param {number} y @param {number[]} color */
function appendResolvedFlatStroke(mesh, geometry, y, color) {
    if (geometry.strokeSegments?.length) {
        let outline = [];
        let width = 0;
        for (const segment of geometry.strokeSegments) {
            const previous = outline.at(-1);
            if (previous && width === segment.lineWidth
                && previous.x === segment.start.x && previous.y === segment.start.y) {
                outline.push(segment.end);
            } else {
                appendFlatStroke(mesh, outline, false, width, y, color);
                outline = [segment.start, segment.end];
                width = segment.lineWidth;
            }
        }
        appendFlatStroke(mesh, outline, false, width, y, color);
        return;
    }
    appendFlatStroke(mesh, /** @type {Point[]} */ (geometry.path), !!geometry.centerlineClosed, geometry.lineWidth || 0, y, color);
}

/** Approximate a stroked circle with bounded convex annular sectors.
 * @param {any} circle
 * @param {number} [segments]
 */
function circleStrokeHoles(circle, segments = 24) {
    const geometry = resolveBoardShapeGeometry(circle);
    const circleGeometry = /** @type {{radius:number,outerRadius:number}} */ (geometry.circle);
    const radius = circleGeometry.radius;
    const halfWidth = geometry.lineWidth / 2;
    const outerRadius = radius + halfWidth;
    const innerRadius = Math.max(0, radius - halfWidth);
    const holes = [];
    for (let index = 0; index < segments; index++) {
        const startAngle = index / segments * Math.PI * 2;
        const endAngle = (index + 1) / segments * Math.PI * 2;
        const midAngle = (startAngle + endAngle) / 2;
        const midRadius = (outerRadius + innerRadius) / 2;
        const boundRadius = Math.hypot(halfWidth, outerRadius * Math.sin(Math.PI / segments));
        holes.push({
            x: circle.x + midRadius * Math.cos(midAngle),
            z: circle.y + midRadius * Math.sin(midAngle),
            r: boundRadius,
            ring: [
                { x: circle.x + innerRadius * Math.cos(startAngle), z: circle.y + innerRadius * Math.sin(startAngle) },
                { x: circle.x + outerRadius * Math.cos(startAngle), z: circle.y + outerRadius * Math.sin(startAngle) },
                { x: circle.x + outerRadius * Math.cos(endAngle), z: circle.y + outerRadius * Math.sin(endAngle) },
                { x: circle.x + innerRadius * Math.cos(endAngle), z: circle.y + innerRadius * Math.sin(endAngle) },
            ],
        });
    }
    return holes;
}

/** @param {ResolvedBoardGeometry} geometry */
function resolvedRemovalHoles(geometry) {
    const contours = geometry.physicalContours;
    if (contours) return regionFillContours(contours).map((/** @type {Point[]} */ contour) => ({
        ring: contour.map(point => ({ x: point.x, z: point.y })),
    }));
    const path = /** @type {Point[]} */ (geometry.path || []);
    const holes = geometry.filled && path.length >= 3
        ? [{ ring: path.map(point => ({ x: point.x, z: point.y })) }] : [];
    if (geometry.strokeSegments?.length) {
        for (const segment of geometry.strokeSegments) {
            holes.push(...strokeOutlineHoles([segment.start, segment.end], false, segment.lineWidth));
        }
    } else holes.push(...strokeOutlineHoles(path, !!geometry.pathClosed, geometry.lineWidth || 0));
    return holes;
}

/** @param {Array<any>} [boardShapes] */
export function collectCopperSubtractHoles(boardShapes = []) {
    const holes = [];
    for (const c of boardShapes || []) {
        if (c?.kind !== 'circle') continue;
        if (!c || (c.layer !== 'top-copper' && c.layer !== 'bottom-copper')) continue;
        if (!(c.radius > 0)) continue;
        const geometry = resolveBoardShapeGeometry(c);
        if (geometry.copperMode !== 'remove-copper' && geometry.copperMode !== 'remove-copper-mask') continue;
        const y = c.layer === 'bottom-copper' ? Y_BOT - COPPER_EPS : Y_TOP + COPPER_EPS;
        if (geometry.filled) {
            holes.push({ x: c.x, z: c.y, r: /** @type {{outerRadius:number}} */ (geometry.circle).outerRadius, y });
        } else {
            holes.push(...circleStrokeHoles(c).map((hole) => ({ ...hole, y })));
        }
    }
    for (const shape of boardShapes || []) {
        if (!shape || shape.kind === 'circle') continue;
        if (shape.layer !== 'top-copper' && shape.layer !== 'bottom-copper') continue;
        const geometry = resolveBoardShapeGeometry(shape);
        if (geometry.copperMode !== 'remove-copper' && geometry.copperMode !== 'remove-copper-mask') continue;
        const y = shape.layer === 'bottom-copper' ? Y_BOT - COPPER_EPS : Y_TOP + COPPER_EPS;
        holes.push(...resolvedRemovalHoles(geometry).map((/** @type {any} */ hole) => ({ ...hole, y })));
    }
    return holes;
}

/**
 * Collect mask openings for one board side.
 * @param {Array<any>} boardShapes
 * @param {'top'|'bottom'} side
 * @param {Map<string, any>} [placements]
 * @param {StandalonePad[]} [pads]
 * @returns {Array<{x?:number,z?:number,r?:number,ring?:Array<{x:number,z:number}>}>}
 */
export function collectMaskOpeningHoles(boardShapes = [], side = 'top', placements = new Map(), pads = []) {
     /** @type {Array<{x?:number,z?:number,r?:number,ring?:Array<{x:number,z:number}>}>} */
    const holes = resolvePadMaskOpenings(placements, side).map((/** @type {any} */ flash) => ({
        ring: padFlashOutline(flash).map(point => ({ x: point.x, z: point.y })),
    }));
    const copperLayer = `${side}-copper`;
    for (const pad of pads || []) {
       if (pad.layers !== 'both' && pad.layers !== copperLayer) continue;
       holes.push({
           ring: padFlashOutline(standalonePadFlash(pad, MASK_EXPANSION))
               .map(point => ({ x: point.x, z: point.y })),
       });
    }
    for (const c of boardShapes || []) {
        if (c?.kind !== 'circle') continue;
        if (!c || !(c.radius > 0)) continue;
        const layer = String(c.layer || '');
        if (layer === 'top-mask' || layer === 'bottom-mask') {
            const cSide = layer === 'bottom-mask' ? 'bottom' : 'top';
            if (cSide !== side) continue;
            const geometry = resolveBoardShapeGeometry(c);
            holes.push({ x: c.x, z: c.y, r: /** @type {{outerRadius:number}} */ (geometry.circle).outerRadius });
            continue;
        }
        if (layer !== 'top-copper' && layer !== 'bottom-copper') continue;
        const cSide = layer === 'bottom-copper' ? 'bottom' : 'top';
        if (cSide !== side) continue;
        const geometry = resolveBoardShapeGeometry(c);
        if (geometry.copperMode !== 'remove-solder-mask' && geometry.copperMode !== 'remove-copper-mask') continue;
        if (geometry.filled) {
            holes.push({ x: c.x, z: c.y, r: /** @type {{outerRadius:number}} */ (geometry.circle).outerRadius });
        } else {
            holes.push(...circleStrokeHoles(c));
        }
    }
    for (const shape of boardShapes || []) {
        if (!shape || shape.kind === 'circle') continue;
        const layer = String(shape.layer || '');
        const isMaskLayer = layer === 'top-mask' || layer === 'bottom-mask';
        const isCopperLayer = layer === 'top-copper' || layer === 'bottom-copper';
        const shapeSide = layer === 'bottom-mask' || layer === 'bottom-copper' ? 'bottom' : 'top';
        if ((!isMaskLayer && !isCopperLayer) || shapeSide !== side) continue;
        const geometry = resolveBoardShapeGeometry(shape);
        if (!isMaskLayer && (geometry.copperMode !== 'remove-solder-mask' && geometry.copperMode !== 'remove-copper-mask')) continue;
        holes.push(...resolvedRemovalHoles(geometry));
    }
    return holes;
}

/**
 * Build one flat board-face mesh (top or bottom) in solder-mask colour.
 * @param {Array<{x:number,z:number}>} outline
 * @param {number} y
 * @param {boolean} reverse winding for bottom face
 * @returns {Mesh}
 */
export function buildMaskFaceMesh(outline, y, reverse = false) {
    const mesh = emptyMesh();
    const color = [...COLOR_SOLDERMASK];
    const outer = outline.map((p) => ({ x: p.x, y: p.z }));
    let tri = null;
    try { tri = triangulateWithHoles(outer, []); } catch { tri = null; }
    if (!tri || !tri.tris.length) return mesh;
    const base = mesh.verts.length;
    for (const p of tri.pts) mesh.verts.push({ x: p.x, y, z: p.y });
    for (const t of tri.tris) {
        mesh.faces.push({
            idx: reverse
                ? [base + t[2], base + t[1], base + t[0]]
                : [base + t[0], base + t[1], base + t[2]],
            color,
        });
    }
    return mesh;
}

/**
 * Build one combined mesh for every copper pour. Each fill's computed
 * geometry (an array of ExPolygons {outer, holes} in world mm) is laid flat
 * on its copper plane and triangulated (holes punched) so it reads as solid
 * copper matching the tracks on that side.
 * @param {Array<any>} fills  app.copperFills
 * @returns {Mesh}
 */
export function buildFillMesh(fills) {
    const mesh = emptyMesh();
    for (const fill of fills || []) {
        if (fill?.visible === false) continue;
        const polys = getComputedFill(fill);
        if (!Array.isArray(polys) || polys.length === 0) continue;
        const bottom = fill.layer === 'bottom-copper';
        const y = bottom ? Y_BOT - COPPER_EPS : Y_TOP + COPPER_EPS;
        const color = bottom ? COLOR_COPPER_BOTTOM : COLOR_COPPER_TOP;
        for (const ex of polys) {
            const outer = (ex.outer || []).map((p) => ({ x: p.x, y: p.y }));
            if (outer.length < 3) continue;
            const holes = (ex.holes || []).map((h) => h.map((p) => ({ x: p.x, y: p.y })));
            let tri = null;
            try { tri = triangulateWithHoles(outer, holes); } catch { tri = null; }
            if (!tri) continue;
            const base = mesh.verts.length;
            for (const p of tri.pts) mesh.verts.push({ x: p.x, y, z: p.y });
            for (const t of tri.tris) {
                mesh.faces.push({ idx: [base + t[0], base + t[1], base + t[2]], color });
            }
        }
    }
    return mesh;
}

/**
 * Build one combined mesh for standalone vias. Each via is a real DRILLED,
 * plated hole: the board (and copper) is bored through at the via's drill (see
 * rebuildSurfaces), and here we line that bore with a single gold barrel whose
 * top/bottom rings ARE the annular pads on each face. The open centre reads as
 * a genuine hole rather than a painted dot — matching the through-hole pads.
 * @param {Array<any>} vias
 * @returns {Mesh}
 */
export function buildViaMesh(vias) {
    const mesh = emptyMesh();
    const yTop = Y_TOP + COPPER_EPS;
    const yBot = Y_BOT - COPPER_EPS;
    for (const via of vias || []) {
        const ro = (via.diameter || 0.6) / 2;
        // Inner radius inset just inside the bored wall so the gold barrel
        // occludes the FR4 bore edge cleanly (no z-fighting on the wall). The
        // board is bored at drill/2 in rebuildSurfaces; this sits a hair inside.
        const ri = Math.max(0.05, Math.min((via.drill || 0.3) / 2 - 0.02, ro - 0.02));
        // Single plated barrel: walls line the bore, top/bottom rings are the
        // gold annular pads. Open centre ⇒ the drilled hole reads as a hole.
        appendMesh(mesh, tubeMesh(via.x, via.y, ri, ro, yBot, yTop, COLOR_VIA, 16));
    }
    return mesh;
}

/**
 * Build gold barrel walls for plated Hole-layer shapes. The board opening is
 * the union of every bore, but a wall segment is plated only when that exposed
 * union boundary came from a plated board shape.
 * @param {DrillHole[]} drilledHoles
 * @returns {Mesh}
 */
export function buildPlatedShapeHoleMesh(drilledHoles) {
    const mesh = emptyMesh();
    const shapeHoles = (drilledHoles || []).filter(
        (hole) => hole?.boardShape &&
            ((Array.isArray(hole.ring) && hole.ring.length >= 3) || hole.r > 0),
    );
    const platedRings = shapeHoles
        .filter((hole) => hole.plated)
        .map((hole) => Array.isArray(hole.ring) && hole.ring.length >= 3
            ? hole.ring.map((point) => ({ x: point.x, y: point.z }))
            : circleRing(hole.x, hole.z, hole.r, 48));
    if (!platedRings.length) return mesh;

    const allRings = (drilledHoles || []).flatMap((hole) => {
        if (Array.isArray(hole?.ring) && hole.ring.length >= 3) {
            return [hole.ring.map((point) => ({ x: point.x, y: point.z }))];
        }
        return hole?.r > 0 ? [circleRing(hole.x, hole.z, hole.r, 48)] : [];
    });
    const unioned = unionBoreRings(allRings);
    if (!unioned) {
        for (const ring of platedRings) {
            appendMesh(mesh, polygonWallMesh(ring, Y_BOT - COPPER_EPS, Y_TOP + COPPER_EPS, COLOR_VIA));
        }
        return mesh;
    }
    /** @param {Point} a @param {Point} b */
    const isPlatedBoundary = (a, b) => {
        const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        return platedRings.some((ring) => ring.some((start, index) => {
            const end = ring[(index + 1) % ring.length];
            return pointToSegmentDistance(midpoint, start, end) <= 0.002;
        }));
    };
    for (const ring of unioned) {
        appendMesh(mesh, polygonWallSegmentsMesh(
            ring, isPlatedBoundary, Y_BOT - COPPER_EPS, Y_TOP + COPPER_EPS, COLOR_VIA));
    }
    return mesh;
}

/** Copper flash of a standalone pad, optionally grown by a mask/paste expansion.
 * @param {StandalonePad} pad
 * @param {number} [expansion]
 */
function standalonePadFlash(pad, expansion = 0) {
    const ratio = ['stadium', 'rectangle', 'oval'].includes(pad.shape) ? pad.ratio || 2 : 1;
    return {
        x: pad.x, y: pad.y, w: pad.size * ratio + expansion * 2, h: pad.size + expansion * 2,
        shape: pad.shape === 'round' ? 'circle'
            : pad.shape === 'oval' ? 'ellipse'
                : pad.shape === 'stadium' ? 'oval' : 'rect',
        rotation: pad.rotation || 0, rad: -(pad.rotation || 0) * Math.PI / 180,
    };
}

/** @param {StandalonePad} pad */
function standalonePadBarrelRadius(pad) {
    return Math.max(0.05, pad.drill / 2 - 0.02);
}

/** @param {StandalonePad} pad */
function standalonePadBarrelOutline(pad) {
    if (!(pad.drill > 0)) return [];
    const radius = standalonePadBarrelRadius(pad);
    return Array.from({ length: PAD_BARREL_SEGMENTS }, (_, index) => {
        const angle = index / PAD_BARREL_SEGMENTS * Math.PI * 2;
        return {
            x: pad.x + radius * Math.cos(angle),
            z: pad.y + radius * Math.sin(angle),
        };
    });
}

/** @param {StandalonePad} pad @returns {Mesh} */
export function standalonePadMesh(pad) {
    const flash = standalonePadFlash(pad);
    if (!(pad.drill > 0)) {
        // No hole: flat copper on each face the pad is assigned to.
        const mesh = emptyMesh();
        if (pad.layers !== 'bottom-copper') appendMesh(mesh, flatPadMesh(flash, Y_TOP + PAD_EPS));
        if (pad.layers !== 'top-copper') appendMesh(mesh, flatPadMesh(flash, Y_BOT - PAD_EPS));
        return mesh;
    }
    const halfW = flash.w / 2;
    const halfH = flash.h / 2;
    const ri = standalonePadBarrelRadius(pad);
    return throughHolePadMesh(
        flash.x, flash.y, flash.shape === 'circle' ? 'ellipse' : flash.shape,
        halfW, halfH, Math.cos(flash.rad), Math.sin(flash.rad), ri,
        Y_BOT - PAD_EPS, Y_TOP + PAD_EPS, COLOR_PAD, null,
        {
            top: pad.layers === 'both' || pad.layers === 'top-copper',
            bottom: pad.layers === 'both' || pad.layers === 'bottom-copper',
            outerWall: false,
        },
    );
}

/** @param {StandalonePad} pad @param {XzPoint[]} boardOutline @returns {Mesh} */
export function standalonePadEdgeMesh(pad, boardOutline) {
    const mesh = emptyMesh();
    if (!Array.isArray(boardOutline) || boardOutline.length < 3) return mesh;
    const flash = standalonePadFlash(pad);
    const padOutline = padFlashOutline(flash).map(point => ({ x: point.x, z: point.y }));
    if (padOutline.length < 3) return mesh;
    const padPolygon = padOutline.map(point => ({ x: point.x, y: point.z }));
    const barrelOutline = standalonePadBarrelOutline(pad);
    const barrelPolygon = barrelOutline.map(point => ({ x: point.x, y: point.z }));
    /** @param {number} ax @param {number} az @param {number} bx @param {number} bz */
    const cross = (ax, az, bx, bz) => ax * bz - az * bx;
    /** @param {number[]} values @param {XzPoint} a @param {XzPoint} b @param {XzPoint} c @param {XzPoint} d */
    const addIntersection = (values, a, b, c, d) => {
        const rx = b.x - a.x;
        const rz = b.z - a.z;
        const sx = d.x - c.x;
        const sz = d.z - c.z;
        const denominator = cross(rx, rz, sx, sz);
        if (Math.abs(denominator) <= 1e-12) return;
        const qx = c.x - a.x;
        const qz = c.z - a.z;
        const t = cross(qx, qz, sx, sz) / denominator;
        const u = cross(qx, qz, rx, rz) / denominator;
        if (t > 1e-9 && t < 1 - 1e-9 && u >= -1e-9 && u <= 1 + 1e-9) values.push(t);
    };
    /** @param {XzPoint} a @param {XzPoint} b @param {number} t */
    const pointAt = (a, b, t) => ({
        x: a.x + (b.x - a.x) * t,
        z: a.z + (b.z - a.z) * t,
    });
    for (let edgeIndex = 0; edgeIndex < boardOutline.length; edgeIndex++) {
        const a = boardOutline[edgeIndex];
        const b = boardOutline[(edgeIndex + 1) % boardOutline.length];
        const values = [0, 1];
        for (let padIndex = 0; padIndex < padOutline.length; padIndex++) {
            addIntersection(values, a, b, padOutline[padIndex],
                padOutline[(padIndex + 1) % padOutline.length]);
        }
        for (let barrelIndex = 0; barrelIndex < barrelOutline.length; barrelIndex++) {
            addIntersection(values, a, b, barrelOutline[barrelIndex],
                barrelOutline[(barrelIndex + 1) % barrelOutline.length]);
        }
        values.sort((first, second) => first - second);
        const unique = values.filter((value, index) => index === 0 || value - values[index - 1] > 1e-8);
        for (let index = 0; index + 1 < unique.length; index++) {
            const start = pointAt(a, b, unique[index]);
            const end = pointAt(a, b, unique[index + 1]);
            if (Math.hypot(end.x - start.x, end.z - start.z) <= 1e-8) continue;
            const midpoint = pointAt(start, end, 0.5);
            if (!pointInPolygon({ x: midpoint.x, y: midpoint.z }, padPolygon)) continue;
            if (barrelPolygon.length >= 3
                && pointInPolygon({ x: midpoint.x, y: midpoint.z }, barrelPolygon)) continue;
            const base = mesh.verts.length;
            mesh.verts.push(
                { x: start.x, y: Y_TOP + PAD_EPS, z: start.z },
                { x: end.x, y: Y_TOP + PAD_EPS, z: end.z },
                { x: end.x, y: Y_BOT - PAD_EPS, z: end.z },
                { x: start.x, y: Y_BOT - PAD_EPS, z: start.z },
            );
            mesh.faces.push(
                { idx: [base, base + 1, base + 2], color: COLOR_PAD },
                { idx: [base, base + 2, base + 3], color: COLOR_PAD },
            );
        }
    }
    return mesh;
}

/** @param {DrillHole[]} drilledHoles */
export function boardCutoutEdgeRings(drilledHoles) {
    const rings = (drilledHoles || [])
        .filter((/** @type {any} */ hole) => hole?.boardShape)
        .flatMap((/** @type {any} */ hole) => {
            if (Array.isArray(hole.ring) && hole.ring.length >= 3) {
                return [hole.ring.map((/** @type {XzPoint} */ point) => ({ x: point.x, y: point.z }))];
            }
            return hole.r > 0 ? [circleRing(hole.x, hole.z, hole.r, 48)] : [];
        });
    const unioned = unionBoreRings(rings);
    return (unioned || rings)
        .map((/** @type {Point[]} */ ring) => ring.map(point => ({ x: point.x, z: point.y })));
}

/**
 * Collect drilled-hole positions (plated pad drills + bare HOLE shapes) from
 * all component placements, in world board-plane coordinates. These are bored
 * clean through the board slab by {@link boardWithHoles}; plated holes are
 * additionally lined with a gold barrel by {@link padMesh}.
 * @param {Iterable<[string, any]>} placements
 * @param {StandalonePad[]} [pads] standalone pads
 * @returns {Array<{x:number,z:number,r:number,plated:boolean,boardShape?:boolean,ring?:Array<{x:number,z:number}>}>}
 */
export function collectBoardHoles(placements, pads = []) {
    const holes = [];
    for (const drill of resolvePlacementDrills(placements)) {
        const r = drill.dia / 2;
        if (drill.slot) {
            // Stadium-shaped slot: approximate the bore as a row of
            // overlapping round holes sampled along the slot's long axis
            // (the circular borer handles each; together they read as a
            // slot without new mesh maths). Sampling between the posed world
            // end-caps is identical to posing samples taken in local space.
            const dx = drill.slot.x2 - drill.x;
            const dy = drill.slot.y2 - drill.y;
            const len = Math.hypot(dx, dy);
            const n = Math.max(2, Math.ceil(len / Math.max(0.1, r * 0.5)));
            for (let i = 0; i <= n; i++) {
                const t = i / n;
                holes.push({ x: drill.x + dx * t, z: drill.y + dy * t, r, plated: drill.plated });
            }
        } else {
            holes.push({ x: drill.x, z: drill.y, r, plated: drill.plated });
        }
    }
    for (const pad of pads) {
        if (pad.drill > 0) holes.push({ x: pad.x, z: pad.y, r: pad.drill / 2, plated: true });
    }
    return holes;
}

/**
 * Build a mesh of solder-mask openings (raw-board cutouts) from:
 *  - legacy circles on top/bottom mask layers, and
 *  - top/bottom copper circles using remove-solder-mask mode.
 * Drawn BETWEEN board and copper, so copper shows where it exists and raw
 * board remains where it does not.
 * Legacy mask-layer circles are treated as area openings (filled).
 * @param {Array<any>} boardShapes
 * @returns {Mesh}
 */
export function buildMaskOpeningMesh(boardShapes = []) {
    const mesh = emptyMesh();
    for (const c of boardShapes || []) {
        if (c?.kind !== 'circle') continue;
        if (!c || !(c.radius > 0)) continue;
        const layer = String(c.layer || '');
        if (layer === 'top-mask' || layer === 'bottom-mask') {
            const geometry = resolveBoardShapeGeometry(c);
            const bottom = layer === 'bottom-mask';
            const y = bottom ? Y_BOT - COPPER_EPS : Y_TOP + COPPER_EPS;
            appendMesh(mesh, discMesh(c.x, c.y, /** @type {{outerRadius:number}} */ (geometry.circle).outerRadius, y, COLOR_RAW_BOARD, FILLED_CIRCLE_SEGMENTS));
            continue;
        }
        if (layer !== 'top-copper' && layer !== 'bottom-copper') continue;
        const geometry = resolveBoardShapeGeometry(c);
        if (geometry.copperMode !== 'remove-solder-mask' && geometry.copperMode !== 'remove-copper-mask') continue;
        const bottom = layer === 'bottom-copper';
        const y = bottom ? Y_BOT - COPPER_EPS : Y_TOP + COPPER_EPS;
        if (geometry.filled) appendMesh(mesh, discMesh(c.x, c.y, /** @type {{outerRadius:number}} */ (geometry.circle).outerRadius, y, COLOR_RAW_BOARD, FILLED_CIRCLE_SEGMENTS));
        else appendMesh(mesh, flatRingMesh(c.x, c.y, /** @type {{radius:number}} */ (geometry.circle).radius, geometry.lineWidth, y, COLOR_RAW_BOARD, 32));
    }
    for (const shape of boardShapes || []) {
        if (!shape || shape.kind === 'circle') continue;
        const layer = String(shape.layer || '');
        const isMaskLayer = layer === 'top-mask' || layer === 'bottom-mask';
        const isCopperLayer = layer === 'top-copper' || layer === 'bottom-copper';
        if (!isMaskLayer && !isCopperLayer) continue;
        const geometry = resolveBoardShapeGeometry(shape);
        if (!isMaskLayer && (geometry.copperMode !== 'remove-solder-mask' && geometry.copperMode !== 'remove-copper-mask')) continue;
        const outline = geometry.path;
        const bottom = layer === 'bottom-mask' || layer === 'bottom-copper';
        const y = bottom ? Y_BOT - COPPER_EPS : Y_TOP + COPPER_EPS;
        if (!geometry.filled) {
            if (outline.length >= 2) {
                appendResolvedFlatStroke(mesh, geometry, y, COLOR_RAW_BOARD);
            }
            continue;
        }
        if (outline.length < 3) continue;
        let tri = null;
        try { tri = triangulateWithHoles(outline.map((/** @type {Point} */ point) => ({ x: point.x, y: point.y })), []); } catch { tri = null; }
        if (!tri?.tris?.length) continue;
        const base = mesh.verts.length;
        for (const point of tri.pts) mesh.verts.push({ x: point.x, y, z: point.y });
        for (const face of tri.tris) mesh.faces.push({ idx: [base + face[0], base + face[1], base + face[2]], color: COLOR_RAW_BOARD });
        appendFlatStroke(mesh, outline, geometry.pathClosed, geometry.lineWidth, y, COLOR_RAW_BOARD);
    }
    return mesh;
}

/**
 * Build one combined silkscreen mesh (lines, circle outlines/fills and
 * flattened SVG paths) from all component placements, dropped onto the top
 * or bottom face as appropriate. Stroke-font text is handled separately by
 * {@link buildTextMesh}.
 * @param {PcbBoard} app
 * @returns {Mesh}
 */
export function buildSilkMesh(app) {
    const placements = app?.placements || [];
    const circles = (app?.boardShapes || []).filter((/** @type {any} */ shape) => shape?.kind === 'circle');
    const mesh = emptyMesh();
    const color = [...COLOR_SILK];
    // Footprint silk shapes via the shared resolver. Each descriptor carries
    // its effective side, so both faces are built from one pass. Stroke width
    // and the `filled` flag now match the 2D preview and Gerber output (the 3D
    // view previously defaulted stroke to 0.15 and never filled paths).
    for (const rawSk of resolveSilk(placements)) {
        const sk = /** @type {any} */ (rawSk);
        const bottom = sk.side === 'bottom';
        const y = bottom ? Y_BOT - SILK_EPS : Y_TOP + SILK_EPS;
        if (sk.kind === 'line') {
            appendMesh(mesh, ribbonMesh(sk.x1, sk.y1, sk.x2, sk.y2, sk.width, y, color));
            appendMesh(mesh, discMesh(sk.x1, sk.y1, sk.width / 2, y, color, 8));
            appendMesh(mesh, discMesh(sk.x2, sk.y2, sk.width / 2, y, color, 8));
        } else if (sk.kind === 'circle' && sk.r > 0) {
            if (sk.filled) {
                appendMesh(mesh, discMesh(sk.cx, sk.cy, sk.r + sk.width / 2, y, color, 24));
            } else {
                appendMesh(mesh, flatRingMesh(sk.cx, sk.cy, sk.r, sk.width, y, color, 28));
            }
        } else if (sk.kind === 'path') {
            // Filled silk paths (e.g. pin-1 triangles) render solid, matching
            // the fab output — each subpath is triangulated as its own region
            // (mirrors Gerber's per-poly G36 fill).
            if (sk.filled) {
                for (const poly of regionFillContours(sk.polys)) {
                    if (poly.length < 3) continue;
                    let tri = null;
                    try { tri = triangulateWithHoles(poly, []); } catch { tri = null; }
                    if (!tri || !tri.tris.length) continue;
                    const base = mesh.verts.length;
                    for (const p of tri.pts) mesh.verts.push({ x: p.x, y, z: p.y });
                    for (const t of tri.tris) {
                        mesh.faces.push({ idx: [base + t[0], base + t[1], base + t[2]], color });
                    }
                }
            }
            // The resolver returns already-posed polylines, so map (x,y)→(x,z).
            appendMesh(mesh, strokePolysToMesh(
                sk.polys, sk.width, y, color,
                (px, py) => ({ x: px, z: py })));
        }
    }
    // Free-standing circles on any non-copper, non-hole, non-mask,
    // non-document layer. Mask-layer circles are composited by
    // buildMaskOpeningMesh(); document graphics are design-only.
    for (const c of circles || []) {
        if (!c) continue;
        const layer = String(c.layer || 'top-silk');
        if (layer === 'top-copper' || layer === 'bottom-copper' || layer === 'hole'
            || layer === 'top-mask' || layer === 'bottom-mask'
            || layer === 'top-document' || layer === 'bottom-document') continue;
        if (!(c.radius > 0)) continue;
        const bottom = layer.startsWith('bottom-');
        const y = bottom ? Y_BOT - SILK_EPS : Y_TOP + SILK_EPS;
        const geometry = resolveBoardShapeGeometry(c);
        if (geometry.filled) appendMesh(mesh, discMesh(c.x, c.y, /** @type {{outerRadius:number}} */ (geometry.circle).outerRadius, y, color, FILLED_CIRCLE_SEGMENTS));
        else appendMesh(mesh, flatRingMesh(c.x, c.y, /** @type {{radius:number}} */ (geometry.circle).radius, geometry.lineWidth, y, color, 32));
    }
    // Free-standing board shapes (rect/polygon/arc) on the silk layers.
    for (const s of (app.boardShapes || [])) {
        if (!s) continue;
        const layer = String(s.layer || 'top-silk');
        if (layer !== 'top-silk' && layer !== 'bottom-silk') continue;
        const geometry = resolveBoardShapeGeometry(s);
        const o = geometry.path;
        if (!o || o.length < 2) continue;
        const bottom = layer.startsWith('bottom-');
        const y = bottom ? Y_BOT - SILK_EPS : Y_TOP + SILK_EPS;
        if (s.kind === 'image') {
            appendMesh(mesh, imageArtworkMesh(s, y, color));
            continue;
        }
        if (geometry.filled && o.length >= 3) {
            let tri = null;
            try { tri = triangulateWithHoles(o.map((/** @type {Point} */ p) => ({ x: p.x, y: p.y })), []); } catch { tri = null; }
            if (tri && tri.tris.length) {
                const base = mesh.verts.length;
                for (const p of tri.pts) mesh.verts.push({ x: p.x, y, z: p.y });
                for (const t of tri.tris) {
                    mesh.faces.push({ idx: [base + t[0], base + t[1], base + t[2]], color });
                }
            }
        }
        if (!geometry.filled && geometry.strokeSegments?.length) {
            appendResolvedFlatStroke(mesh, geometry, y, color);
        } else {
            const poly = geometry.pathClosed ? o.concat([o[0]]) : o;
            appendMesh(mesh, strokePolysToMesh(
                [poly],
                geometry.lineWidth,
                y,
                color,
                (px, py) => ({ x: px, z: py }),
            ));
        }
    }
    return mesh;
}

/** Viewer-owned immutable mesh cache; compare authored inputs, not expanded image triangles. */
export function createSilkArtworkMeshCache() {
    /** @type {{input: any, mesh: Mesh}|null} */
    let cached = null;
    /** @param {Array<any>} boardShapes */
    return (boardShapes) => {
        const input = { boardShapes, color: [...COLOR_SILK] };
        if (cached && surfaceInputsEqual(cached.input, input)) return cached.mesh;
        const snapshot = structuredClone(input);
        const mesh = buildSilkMesh({ boardShapes });
        cached = { input: snapshot, mesh };
        return mesh;
    };
}

/**
 * Build one combined mesh of stroke-font text — free-standing PCB text
 * annotations plus component reference designators — as white silk strokes
 * (copper-coloured when the text lives on a copper layer).
 * @param {PcbEditor} app PCBApp instance
 * @returns {Mesh}
 */
export function buildTextMesh(app) {
    const mesh = emptyMesh();

    // ── Free-standing text annotations (app.texts) ──────────────────────
    for (const [, t] of (app.texts || [])) {
        if (!t?.content) continue;
        if (t.layer === 'top-copper' || t.layer === 'bottom-copper') continue;
        if (t.layer === 'top-document' || t.layer === 'bottom-document') continue;
        const bottom = typeof t.layer === 'string' && t.layer.startsWith('bottom-');
        const y = bottom ? Y_BOT - SILK_EPS : Y_TOP + SILK_EPS;
        appendMesh(mesh, strokePolysToMesh(
            pcbTextPolylines(t),
            t.strokeWidth || 0.15,
            y,
            COLOR_SILK,
            (x, z) => ({ x, z }),
        ));
    }

    // ── Component reference designators (silk) ──────────────────────────
    for (const [, pl] of (app.placements || [])) {
        const reference = resolveReferenceText(pl);
        if (!reference) continue;
        const bottom = reference.layer === 'bottom-silk';
        const y = bottom ? Y_BOT - SILK_EPS : Y_TOP + SILK_EPS;
        appendMesh(mesh, strokePolysToMesh(
            reference.polylines, reference.strokeWidth, y, COLOR_SILK,
            (x, z) => ({ x, z })));
    }

    return mesh;
}

/* ───────────────────────── mesh → BufferGeometry ─────────────────────────── */

/**
 * Material for a thin board-surface layer (copper, vias, pads, silk, text).
 * Identical look to {@link makeMaterial} but nudged in the DEPTH BUFFER via a
 * CONSTANT polygonOffset so coplanar layers resolve deterministically with no
 * world-space Y step (a step shimmers at distance and shows a visible "side").
 * Two rules learned the hard way:
 *  1. `polygonOffsetFactor` is kept at 0 (NOT slope-scaled). A non-zero factor
 *     scales the bias by the depth SLOPE, so at grazing angles it shoves the
 *     layer far forward — enough to poke in front of the 1.6 mm bore/edge walls
 *     and read as a raised lip (the "tracks have depth" artifact).
 *  2. `polygonOffsetUnits` IS stepped per layer (constant, angle-independent,
 *     microscopic in world terms). A single shared unit value left overlapping
 *     coplanar layers — e.g. a track under a via's annular ring — at identical
 *     depth, so they z-fought (shimmer). Distinct units give each layer its own
 *     depth slice: copper < via < pad < silk < text, all just above the board.
 * @param {number} units constant depth-bias units (more negative = nearer)
 */
export function makeDecalMaterial(units) {
    const m = makeMaterial();
    m.polygonOffset = true;
    // Constant (units-only) bias — NO slope term. polygonOffset writes only a
    // biased DEPTH value; it never moves geometry in screen space, so larger
    // units raise nothing visually. The only risk of cranking units is
    // depth-order bleed: a decal whose biased depth jumps in front of the
    // near-vertical 1.6 mm bore/edge walls would draw on top of them. The units
    // below are spaced generously to kill oblique-angle shimmer while staying
    // far short of the walls.
    m.polygonOffsetFactor = 0;
    m.polygonOffsetUnits = units;
    return m;
}

/**
 * Material for the bare board. A soft, mostly-matte solder mask: the overhead
 * point light pools into a gentle radial glow on the surface (EasyEDA style)
 * rather than a tight mirror glint, which also keeps shading cheap.
 */
export function makeBoardMaterial() {
    return new THREE.MeshStandardMaterial({
        vertexColors: true,
        flatShading: false,
        side: THREE.DoubleSide,
        roughness: 0.55,
        metalness: 0.0,
        // Pushed slightly BACK in the depth buffer (positive offset) so the
        // coplanar surface art (copper/silk/pads, all pulled forward) and the
        // component-body bases that share the board's top plane reliably win the
        // depth test against it — no z-fighting at the contact plane.
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
    });
}
