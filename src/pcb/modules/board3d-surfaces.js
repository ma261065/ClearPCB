/**
 * Board surfaces built off the main thread: the inputs sent to the surface worker,
 * how its results become meshes, and when the 3D view resyncs with the editor.
 * Split from board3d.js; the viewer itself is board3d.js.
 */
import * as THREE from '../../../assets/vendor/three.module.js';
import { boardBoundary, boardDimensions } from '../../shared/pcb/board-outline.js';
import { pointInPolygon, distanceToSegment } from '../../core/geometry.js';
import { boardShapeFilledRemovalOutlines, resolveBoardShapeGeometry } from '../../shared/pcb/board-shape-geometry.js';
import { refreshStatus } from './refresh-state.js';
import { BOARD_THICKNESS, COLOR_RAW_BOARD, SHOW_SOLDERMASK, Y_TOP, Y_BOT, COPPER_EPS } from './board3d-params.js';
import { roundedRectOutline, capsuleRing, discardNestedBores, boardSlabWithCutouts } from './board3d-board.js';
import { padMesh } from './board3d-parts.js';
import { emptyMesh, appendMesh } from './board3d-mesh-ops.js';
import { buildCopperMesh, collectCopperSubtractHoles, collectMaskOpeningHoles, buildMaskFaceMesh, buildFillMesh, buildViaMesh, buildPlatedShapeHoleMesh, standalonePadMesh, standalonePadEdgeMesh, boardCutoutEdgeRings, collectBoardHoles, buildMaskOpeningMesh, buildSilkMesh, buildTextMesh } from './board3d-layers.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */

/**
 * Board outline and drilled holes shared by every 3D surface: pad drills,
 * HOLE-layer cutouts and via bores, with nested bores discarded. Bores wholly
 * inside the board are punched as holes (`boardHoles`); bores breaching the
 * edge notch the outline (`crossingRings`); bores wholly outside are ignored.
 * @param {PcbEditor} app
 */
export function boardSurfaceFrame(app) {
    const dimensions = boardDimensions(app);
    const w = dimensions.width || 100;
    const h = dimensions.height || 80;
    const r = dimensions.radius || 0;
    // PCB world: X∈[0,w], Z(=pcb y)∈[-h,0].
    const boundary = boardBoundary(app);
    const outline = boundary.points
        ? boundary.points.map(point => ({ x: point.x, z: point.y }))
        : roundedRectOutline(0, -h, w, h, r);
    // Bore drilled holes (pad drills + mounting holes) clean through the
    // slab so they read as real openings; only holes wholly inside the board.
    let drilledHoles = collectBoardHoles(app.placements, app.pads).filter((ho) => ho.r > 0);
    // Free-standing circles on HOLE layer are real board cutouts.
    // Free-standing board shapes (rect/polygon/arc/circle) on HOLE layer are real
    // board cutouts too — carry an explicit polygon ring plus a bounding
    // circle (centroid + max radius) for the bbox/inside-board tests.
    for (const s of (app.boardShapes || [])) {
        if (!s || s.layer !== 'hole') continue;
        const geometry = resolveBoardShapeGeometry(s);
        if (geometry.circle) {
            drilledHoles.push({
                x: geometry.circle.x,
                z: geometry.circle.y,
                r: geometry.circle.outerRadius,
                plated: !!s.plated,
                boardShape: true,
            });
            continue;
        }
        const outlinePts = geometry.path;
        if (!outlinePts || outlinePts.length < 2) continue;
        if (!geometry.filled) {
            const segments = geometry.strokeSegments?.length
                ? geometry.strokeSegments
                : outlinePts.slice(1).map((end, index) => ({
                    start: outlinePts[index], end, lineWidth: geometry.lineWidth,
                }));
            for (const segment of segments) {
                const { start, end } = segment;
                if (Math.hypot(end.x - start.x, end.y - start.y) <= 1e-9) continue;
                const ring = capsuleRing(start.x, start.y, end.x, end.y, segment.lineWidth / 2)
                    .map((point) => ({ x: point.x, z: point.y }));
                let cx = 0, cz = 0;
                for (const point of ring) { cx += point.x; cz += point.z; }
                cx /= ring.length; cz /= ring.length;
                let rad = 0;
                for (const point of ring) rad = Math.max(rad, Math.hypot(point.x - cx, point.z - cz));
                drilledHoles.push({ x: cx, z: cz, r: rad, ring, plated: !!s.plated, boardShape: true });
            }
            continue;
        }
        for (const outline of boardShapeFilledRemovalOutlines(s)) {
            if (outline.length < 3) continue;
            const ring = outline.map((point) => ({ x: point.x, z: point.y }));
            let cx = 0, cz = 0;
            for (const point of ring) { cx += point.x; cz += point.z; }
            cx /= ring.length; cz /= ring.length;
            let rad = 0;
            for (const point of ring) {
                const distance = Math.hypot(point.x - cx, point.z - cz);
                if (distance > rad) rad = distance;
            }
            drilledHoles.push({ x: cx, z: cz, r: rad, ring, plated: !!s.plated, boardShape: true });
        }
    }
    // Vias are real drilled, plated holes too — bore the board/copper at
    // each via's drill so the open bore reads as a genuine hole (the gold
    // barrel from buildViaMesh lines it).
    for (const via of (app.vias || [])) {
        const r = (via.drill || 0.3) / 2;
        if (r > 0) drilledHoles.push({ x: via.x, z: via.y, r, plated: true });
    }
    drilledHoles = discardNestedBores(drilledHoles);
    // Classify bores: wholly-inside ones are punched as fast earcut holes;
    // ones that breach the board edge are subtracted from the outline with
    // a polygon boolean so the slab is genuinely notched. Bores wholly
    // outside the board are ignored.
    const boardHoles = [];
    const crossingRings = [];
    for (const ho of drilledHoles) {
        const center = { x: ho.x, y: ho.z };
        const inside = boundary.points
            ? pointInPolygon(center, boundary.points) && boundary.points.every((point, index) =>
                distanceToSegment(center, point, boundary.points[(index + 1) % boundary.points.length]) > ho.r)
            : ho.x - ho.r > 0 && ho.x + ho.r < w && ho.z - ho.r > -h && ho.z + ho.r < 0;
        if (inside) { boardHoles.push(ho); continue; }
        const outside = ho.x + ho.r <= boundary.x || ho.x - ho.r >= boundary.x + boundary.w ||
            ho.z + ho.r <= boundary.y || ho.z - ho.r >= boundary.y + boundary.h;
        if (outside) continue;
        if (ho.ring && ho.ring.length >= 3) {
            crossingRings.push(ho.ring);
        } else if (ho.r > 0) {
            const ring = [];
            for (let i = 0; i < 48; i++) {
                const a = (i / 48) * Math.PI * 2;
                ring.push({ x: ho.x + ho.r * Math.cos(a), z: ho.z + ho.r * Math.sin(a) });
            }
            crossingRings.push(ring);
        }
    }
    return { boundary, outline, drilledHoles, boardHoles, crossingRings };
}

/**
 * Per-layer worker inputs for the 3D board surfaces (meshes plus the holes to
 * punch through each), built from the editor model and a surface frame.
 * @param {PcbEditor} app
 * @param {{ outline: any[], drilledHoles: any[], boardHoles: any[], crossingRings: any[] }} frame
 * @param {(boardShapes: any[]) => any} silkArtworkMesh Per-viewer cache from createSilkArtworkMeshCache().
 */
export function buildBoardSurfaceInputs(app, { outline, drilledHoles, boardHoles, crossingRings }, silkArtworkMesh) {
    const surfaces = {
        board: { parts: [{ mesh: boardSlabWithCutouts(outline, boardHoles, crossingRings,
            0, BOARD_THICKNESS, COLOR_RAW_BOARD, COLOR_RAW_BOARD) }] },
    };
    const addSurface = (key, parts) => { surfaces[key] = { parts, outline }; };
    if (SHOW_SOLDERMASK) {
        // Solder-mask openings are raw-board cutouts drawn beneath copper, so
        // copper naturally appears only where geometry exists above them.
        addSurface('maskOpenings', [{ mesh: buildMaskOpeningMesh(app.boardShapes || []), holes: drilledHoles }]);
    }
    // Punch the same drilled holes through the flat copper so tracks/pours
    // crossing a hole are bored out instead of lidding over an open hole.
    // Copper remove circles are also treated as geometric subtractions.
    // Copper pours sit on the same plane as tracks, so combine both into
    // the one copper surface before boring/clipping.
    const circleShapes = (app.boardShapes || []).filter((shape) => shape?.kind === 'circle');
    const copperSubtractHoles = collectCopperSubtractHoles(app.boardShapes || []);
    const copperPunchHoles = drilledHoles.concat(copperSubtractHoles);
    const platedMeshHoles = platedSurfaceRemovalHoles(drilledHoles, copperSubtractHoles);
    const copperMesh = buildCopperMesh(app.tracks, circleShapes, app.boardShapes, app.texts);
    appendMesh(copperMesh, buildFillMesh(app.copperFills));
    addSurface('copper', [{ mesh: copperMesh, holes: copperPunchHoles }]);
    const padsMesh = emptyMesh();
    const padEdgeMesh = emptyMesh();
    const edgeRings = [outline, ...boardCutoutEdgeRings(drilledHoles)];
    for (const [, pl] of app.placements) appendMesh(padsMesh, padMesh(pl));
    for (const pad of app.pads || []) {
        appendMesh(padsMesh, standalonePadMesh(pad));
        for (const edgeRing of edgeRings) {
            appendMesh(padEdgeMesh, standalonePadEdgeMesh(pad, edgeRing));
        }
    }
    addSurface('via', [
        { mesh: buildViaMesh(app.vias), holes: platedMeshHoles },
        { mesh: buildPlatedShapeHoleMesh(drilledHoles) },
    ]);
    addSurface('pads', [
        { mesh: padsMesh, holes: platedMeshHoles },
        { mesh: padEdgeMesh, holes: copperSubtractHoles },
    ]);
    if (SHOW_SOLDERMASK) {
        addSurface('maskCoatTop', [
            { mesh: buildMaskFaceMesh(outline, Y_TOP + COPPER_EPS, false),
                holes: drilledHoles.concat(collectMaskOpeningHoles(app.boardShapes || [], 'top', app.placements, app.pads)) },
        ]);
        addSurface('maskCoatBottom', [
            { mesh: buildMaskFaceMesh(outline, Y_BOT - COPPER_EPS, true),
                holes: drilledHoles.concat(collectMaskOpeningHoles(app.boardShapes || [], 'bottom', app.placements, app.pads)) },
        ]);
    }
    // Document-layer circles expose raw board material above mask/copper.
    addSurface('silk', [{ mesh: buildSilkMesh({ placements: app.placements }), holes: drilledHoles }]);
    addSurface('silkArtwork', [{ mesh: silkArtworkMesh(app.boardShapes || []), holes: drilledHoles }]);
    addSurface('text', [{ mesh: buildTextMesh(app), holes: drilledHoles }]);
    return surfaces;
}

/**
 * Painting order for the coplanar board layers. They share one tiny depth bias,
 * so where two overlap the depth test ties and the later-drawn one wins: board
 * behind, then mask openings, copper, via, pads, both mask coats, silk (component
 * and artwork alike) and text on top. Without it layers paint in mesh-add order.
 */
export const BOARD_SURFACE_ORDER = Object.freeze({
    board: 0, maskOpenings: 1, copper: 2, via: 3, pads: 4,
    maskCoatTop: 5, maskCoatBottom: 5, silk: 7, silkArtwork: 7, text: 8,
});

/**
 * Material for each board surface. Both mask coats share the mask material, and
 * component silk and authored silk artwork share the silk material (same
 * opacity and depth bias).
 * @param {any} scene
 */
export function boardSurfaceMaterials(scene) {
    return { board: scene.boardMaterial, maskOpenings: scene.maskOpeningMaterial,
        copper: scene.copperMaterial, via: scene.viaMaterial, pads: scene.padMaterial,
        maskCoatTop: scene.maskCoatMaterial, maskCoatBottom: scene.maskCoatMaterial,
        silk: scene.silkMaterial, silkArtwork: scene.silkMaterial, text: scene.textMaterial };
}

/**
 * Publish every surface of one completed build in a single synchronous pass, so
 * the viewer never shows a mix of old and new layers.
 * @param {(key: string, data: any, material: any) => void} swap
 * @param {string[]} keys @param {Record<string, any>} result @param {Record<string, any>} materials
 */
export function publishBoardSurfaces(swap, keys, result, materials) {
    for (const key of keys) swap(key, result[key], materials[key]);
}

/** Upload one surface's finished worker buffers as a Three.js geometry. */
export function surfaceBufferGeometry(data) {
    const geometry = new THREE.BufferGeometry();
    for (const key of ['position', 'normal', 'color']) {
        geometry.setAttribute(key, new THREE.Float32BufferAttribute(data[key], 3));
    }
    return geometry;
}

/**
 * Publish finished surface buffers to the scene. A surface whose buffers are
 * the same object as last time keeps its GPU mesh; empty buffers remove it.
 * @param {{ getScene: () => any, surf: Record<string, any>, order: Record<string, number>,
 *   geometry?: (data: any) => any }} options
 */
export function createSurfacePublisher({ getScene, surf, order, geometry = surfaceBufferGeometry }) {
    const applied = new Map();
    return (/** @type {string} */ key, /** @type {any} */ data, /** @type {any} */ material) => {
        const scene = getScene();
        if (!scene) return;
        if (applied.has(key) && applied.get(key) === data) return;
        scene.removeMesh(surf[key]);
        const mesh = data && data.position.length ? scene.addMesh(geometry(data), material) : null;
        if (mesh) mesh.renderOrder = order[key] ?? 0;
        surf[key] = mesh;
        applied.set(key, data);
    };
}

/**
 * Coalesce live-sync requests into one animation frame. Visibility and the
 * refresh guards (drags, pours, picture copper) are checked both when a frame
 * is queued and again when it runs, so a frame queued before a guard was
 * raised never builds stale geometry.
 * @param {{ app: any, panel: any, viewSync: { invalidate(): void, flush(view: string): void },
 *   surfaceBuilder: { invalidate(options?: object): void }, win?: any }} options
 */
export function createBoard3DSyncScheduler({ app, panel, viewSync, surfaceBuilder, win = window }) {
    let frame = 0;
    const canSync = () => {
        if (panel.closed || panel.hidden) return false;
        const status = refreshStatus(app);
        return !status.pictureCopperPending
            && !status.boardViewSuspended && !status.overlaysDeferred
            && !status.fillSuspended && !status.fillScheduled
            && !(status.fillPending && app.copperFills?.length);
    };
    const schedulePending = () => {
        if (!canSync() || frame) return;
        frame = win.requestAnimationFrame(() => {
            frame = 0;
            if (!canSync()) return;
            viewSync.flush(panel.view);
        });
    };
    return {
        /** A committed edit: preempt obsolete worker jobs and refresh next frame. */
        schedule() {
            surfaceBuilder.invalidate({ cancelActive: true });
            viewSync.invalidate();
            schedulePending();
        },
        /** Retry an already-invalidated view (e.g. after a deferred build settles dirty). */
        schedulePending,
        cancel() {
            if (frame) { win.cancelAnimationFrame(frame); frame = 0; }
        },
    };
}


export function platedSurfaceRemovalHoles(drilledHoles, copperSubtractHoles) {
    return drilledHoles.filter(hole => hole.boardShape).concat(copperSubtractHoles);
}
