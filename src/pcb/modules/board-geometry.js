/**
 * Shared, renderer-agnostic geometry helpers for the three PCB consumers
 * (2D canvas preview {@link Board2D}, 3D viewer board3d.js and the Gerber
 * exporter gerber.js). These functions are pure — no Canvas, THREE, DOM or
 * file-format dependencies — so every renderer resolves footprint geometry the
 * same way and a fix lands in one place instead of three.
 *
 * Coordinate convention: footprint-local and board geometry are in
 * SVG-Y-down millimetres (the same space the editor stores). The Gerber
 * exporter applies its own Y-flip when it emits; the 3D viewer maps the
 * board-plane (x, y) to world (x, z) at the point of consumption.
 */

/**
 * Soldermask expansion per side (mm). 0.05 mm is the typical board-house
 * default — a pad emerges with a 0.1 mm-larger opening so solder wicks to
 * copper without ever touching the mask edge. This is the SINGLE source of
 * truth shared by the Gerber soldermask export (gerber.js) and the editor's
 * footprint mask preview (footprint.js), which previously drifted (0.05 vs
 * 0.1 per side, so the editor showed an opening twice the fabricated size).
 */
export const MASK_EXPANSION = 0.05;

/**
 * Whether vias are tented (covered by soldermask, i.e. no mask opening over a
 * via). The 2D preview and 3D viewer never open mask over vias, and the Gerber
 * export honours this flag, so all three agree.
 */
export const TENT_VIAS = true;

/**
 * Footprint-local → board-plane transform for a placement's pose: mirror
 * (about the footprint origin) then rotate then translate. Matches the
 * editor's SVG group transform `translate … rotate … scale(-1,1)`, so pads,
 * silk and holes land exactly where the 2D editor, 2D preview, 3D view and
 * Gerber export all draw them.
 *
 * A user flip (`mirror`) and a bottom-side placement each mirror the footprint;
 * together they cancel out (`mx`).
 *
 * @param {{x?:number,y?:number,rotation?:number,mirror?:boolean,side?:string}} pl
 * @returns {{rad:number, mx:number, cos:number, sin:number,
 *            xf:(lx:number, ly:number) => {x:number, y:number}}}
 */
export function placementPose(pl) {
    const rad = ((pl.rotation || 0) * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const mx = ((!!pl.mirror) !== (pl.side === 'bottom')) ? -1 : 1;
    const ox = pl.x || 0, oy = pl.y || 0;
    return {
        rad, mx, cos, sin,
        /** @param {number} lx @param {number} ly */
        xf(lx, ly) {
            const x = lx * mx;
            return { x: ox + x * cos - ly * sin, y: oy + x * sin + ly * cos };
        },
    };
}

/**
 * Whether a placement angle swaps a pad's width/height. Placement rotation is
 * constrained to 90° steps, so an odd multiple of 90° turns a rectangular or
 * oval aperture on its side.
 * @param {number} rotation degrees
 * @returns {boolean}
 */
export function orthoSwap(rotation) {
    const r = (((rotation || 0) % 360) + 360) % 360;
    return Math.abs(r - 90) < 0.01 || Math.abs(r - 270) < 0.01;
}

/**
 * Resolve all placement-derived drilled holes — through-hole pad drills
 * (round and oval/stadium slots) and footprint mechanical/mounting holes
 * (authored as `'hole'`-layer circles inside a footprint's `silks`) — into
 * renderer-neutral descriptors, posed to board-plane mm.
 *
 * Each descriptor is `{ x, y, dia, plated, slot }`: `(x, y)` is the bore
 * centre (the first stadium cap-centre for a slot), `dia` the bore diameter
 * (= slot width), `plated` true for pad drills / false for mounting holes,
 * and `slot` is `null` for a round hole or `{ x2, y2 }` giving the second
 * stadium cap-centre for an oval slot. Coordinates are SVG-Y-down board mm;
 * the 3D viewer maps y→z and the Gerber exporter applies its Y-flip on emit.
 *
 * This is the single source of truth shared by the 2D preview (`_drawHoles`),
 * the 3D board borer (`collectBoardHoles`) and the Excellon collectors
 * (`_collectPlatedDrills` / `_collectNonPlatedDrills`). Vias and standalone
 * holes/cutouts are NOT included — they carry no pose and each renderer treats
 * them differently.
 *
 * @param {Map<string, object>|Iterable<[any, object]>} placements
 * @returns {Array<{x:number, y:number, dia:number, plated:boolean,
 *                  slot:null|{x2:number, y2:number}}>}
 */
export function resolvePlacementDrills(placements) {
    const out = [];
    for (const [, pl] of placements) {
        const pose = placementPose(pl);
        for (const off of (pl.padOffsets || [])) {
            const dia = off.drill || 0;
            if (dia <= 0) continue;
            const caps = _slotCaps(pose, off, dia);
            if (caps) {
                out.push({ x: caps.a.x, y: caps.a.y, dia, plated: true, slot: { x2: caps.b.x, y2: caps.b.y } });
            } else {
                const p = pose.xf(off.dx, off.dy);
                out.push({ x: p.x, y: p.y, dia, plated: true, slot: null });
            }
        }
        for (const s of (pl.silks || [])) {
            if (s.layer !== 'hole' || s.type !== 'circle' || !(s.r > 0)) continue;
            const p = pose.xf(s.cx, s.cy);
            out.push({ x: p.x, y: p.y, dia: 2 * s.r, plated: false, slot: null });
        }
    }
    return out;
}

/**
 * Pose the two stadium cap-centres of a slotted pad drill. A pad offset is a
 * slot when `off.slotLength > drillWidth`; the caps sit at ±(slotLength-width)/2
 * along `off.slotAngle` in footprint-local space, then run through the pose.
 * @param {{xf:(lx:number,ly:number)=>{x:number,y:number}}} pose
 * @param {object} off pad offset (`dx,dy,slotLength,slotAngle`)
 * @param {number} drillWidth bore width (the round drill diameter)
 * @returns {null|{a:{x:number,y:number}, b:{x:number,y:number}}}
 */
function _slotCaps(pose, off, drillWidth) {
    if (!(off.slotLength > drillWidth)) return null;
    const half = (off.slotLength - drillWidth) / 2;
    const ca = Math.cos(off.slotAngle || 0);
    const sa = Math.sin(off.slotAngle || 0);
    return {
        a: pose.xf(off.dx - half * ca, off.dy - half * sa),
        b: pose.xf(off.dx + half * ca, off.dy + half * sa),
    };
}

/**
 * Resolve the copper-pad flashes for a set of placements into renderer-neutral
 * descriptors, posed to board-plane mm. This is the single source of truth for
 * the pad iteration / pose / shape-default / side-filter logic that the 2D
 * preview (`_drawCopper`), the 3D pad mesh (`padMesh`) and every Gerber pad
 * layer (`_buildCopper`, soldermask & paste `_buildPadLayer`) used to repeat.
 *
 * Each descriptor is:
 *   `{ x, y, shape, w, h, rad, rotation, layer, isThru, paste, mask, drill, slot }`
 * where `(x, y)` is the posed pad centre, `shape` ∈ `'ellipse'|'oval'|'rect'`,
 * `w/h` the (un-ortho-swapped) footprint-local dimensions inflated by
 * `2*expansion`, `rad`/`rotation` the placement rotation (radians / degrees),
 * `layer` the pad's `'top'|'bottom'|'both'`, `isThru` whether it is drilled,
 * `paste`/`mask` the per-pad opt-out flags (default true), `drill` the bore
 * width, and `slot` `null` (round/none) or `{ x1, y1, x2, y2 }` the two posed
 * stadium cap-centres for an oval slot bore. Coordinates are SVG-Y-down board
 * mm; the 3D viewer maps y→z and Gerber ortho-swaps `w/h` + Y-flips on emit.
 *
 * Renderers stay native: Gerber emits C/O/R apertures, the 2D canvas uses
 * `ctx.ellipse`/`arcTo`, and 3D builds meshes — only the descriptor is shared.
 * Standalone vias are NOT included (they carry no footprint pose).
 *
 * @param {Map<string, object>|Iterable<[any, object]>} placements
 * @param {object} [opts]
 * @param {'top'|'bottom'|null} [opts.side=null] filter by pad layer; null = all
 * @param {'pad'|'paste'} [opts.source='pad'] `padOffsets` vs `pasteOffsets`
 * @param {boolean} [opts.includeThruHole=true] include drilled (THT) pads
 * @param {boolean} [opts.includeSmd=true] include non-drilled (SMD) pads
 * @param {number} [opts.expansion=0] mm added to EACH side (mask/paste inflate)
 * @returns {Array<object>}
 */
export function resolvePadFlashes(placements, opts = {}) {
    const {
        side = null,
        source = 'pad',
        includeThruHole = true,
        includeSmd = true,
        expansion = 0,
    } = opts;
    const out = [];
    const offsetsKey = source === 'paste' ? 'pasteOffsets' : 'padOffsets';
    for (const [, pl] of placements) {
        const offsets = pl?.[offsetsKey];
        if (!offsets) continue;
        const pose = placementPose(pl);
        const rotation = pl.rotation || 0;
        for (const off of offsets) {
            // Side filter: pads carry layer 'top'|'bottom'|'both'; paste
            // offsets carry side 'top'|'bottom' (no 'both').
            const layer = source === 'paste' ? (off.side || 'top') : (off.layer || 'top');
            if (side && layer !== 'both' && layer !== side) continue;
            const isThru = source === 'pad' && (off.drill || 0) > 0;
            if (source === 'pad') {
                if (isThru && !includeThruHole) continue;
                if (!isThru && !includeSmd) continue;
            }
            const w = (off.width || 1.2) + 2 * expansion;
            const h = (off.height || 1.2) + 2 * expansion;
            if (w <= 0 || h <= 0) continue;
            const p = pose.xf(off.dx, off.dy);
            const drill = off.drill || 0;
            const caps = isThru ? _slotCaps(pose, off, drill) : null;
            out.push({
                x: p.x, y: p.y,
                shape: off.shape || 'rect',
                w, h, rad: pose.rad, rotation, layer,
                isThru,
                paste: off.paste !== false,
                mask: off.mask !== false,
                drill,
                slot: caps ? { x1: caps.a.x, y1: caps.a.y, x2: caps.b.x, y2: caps.b.y } : null,
            });
        }
    }
    return out;
}

/**
 * Resolve footprint silkscreen shapes (lines, circle outlines/fills and
 * flattened SVG paths) into renderer-neutral, posed descriptors. This is the
 * single source of truth for the per-`pl.silks` iteration, side resolution
 * (a bottom-side placement flips its silk to the opposite layer), stroke-width
 * default and `filled`-flag handling that the 2D preview (`_drawSilk`), the
 * Gerber silk layer (`_buildSilk`) and the 3D silk mesh (`buildSilkMesh`) used
 * to repeat (and quietly diverge on — the 3D view defaulted stroke to 0.15 vs
 * 0.12 elsewhere and never filled paths).
 *
 * Each descriptor carries the EFFECTIVE `side` ('top'|'bottom', after the
 * placement flip) so 3D can render both faces from one call:
 *   `{ kind:'line',  side, x1, y1, x2, y2, width }`
 *   `{ kind:'circle',side, cx, cy, r, width, filled }`
 *   `{ kind:'path',  side, polys:Array<Array<{x,y}>>, width, filled }`
 * Coordinates are posed SVG-Y-down board mm (paths already flattened+posed);
 * the 3D viewer maps y→z and Gerber Y-flips on emit. Reference designators and
 * free-standing text are NOT included — they are stroke-font geometry handled
 * per renderer. Non-silk-layer entries in `pl.silks` (e.g. `'hole'` circles)
 * are skipped.
 *
 * @param {Map<string, object>|Iterable<[any, object]>} placements
 * @param {'top'|'bottom'|null} [side=null] filter by effective side; null = all
 * @returns {Array<object>}
 */
export function resolveSilk(placements, side = null) {
    const out = [];
    for (const [, pl] of placements) {
        const pose = placementPose(pl);
        const flip = pl.side === 'bottom';
        for (const s of (pl.silks || [])) {
            if (s.layer !== 'top-silk' && s.layer !== 'bottom-silk') continue;
            // A bottom-side placement moves top silk to the bottom face (and
            // vice versa); other entries keep their authored layer.
            const layer = flip ? (s.layer === 'top-silk' ? 'bottom-silk' : 'top-silk') : s.layer;
            const effSide = layer === 'bottom-silk' ? 'bottom' : 'top';
            if (side && effSide !== side) continue;
            const width = (Number.isFinite(s.strokeWidth) && s.strokeWidth > 0) ? s.strokeWidth : 0.12;
            if (s.type === 'line') {
                const a = pose.xf(s.x1, s.y1);
                const b = pose.xf(s.x2, s.y2);
                out.push({ kind: 'line', side: effSide, x1: a.x, y1: a.y, x2: b.x, y2: b.y, width });
            } else if (s.type === 'circle') {
                const c = pose.xf(s.cx, s.cy);
                out.push({ kind: 'circle', side: effSide, cx: c.x, cy: c.y, r: s.r, width, filled: !!s.filled });
            } else if (s.type === 'path' && s.d) {
                const polys = flattenSvgPath(s.d).map((poly) => poly.map((p) => pose.xf(p.x, p.y)));
                out.push({ kind: 'path', side: effSide, polys, width, filled: !!s.filled });
            }
        }
    }
    return out;
}

/**
 * Sample a cubic bézier into `steps` chords, pushing points 1..steps onto
 * `poly` (the start point is assumed already present).
 * @param {Array<{x:number,y:number}>} poly
 */
function sampleBezier(poly, x0, y0, x1, y1, x2, y2, x3, y3, steps) {
    for (let s = 1; s <= steps; s++) {
        const t = s / steps, u = 1 - t;
        poly.push({
            x: u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
            y: u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
        });
    }
}

/**
 * Sample an SVG elliptical arc (A/a) into chords, pushing points onto `poly`.
 * Endpoint-to-centre parameterisation per the SVG implementation notes
 * (F.6.5). Returns the arc endpoint so the caller can update the pen.
 * @param {Array<{x:number,y:number}>} poly
 * @returns {{x:number,y:number}}
 */
function sampleArc(poly, x0, y0, rx, ry, phiDeg, largeArc, sweep, ex, ey) {
    rx = Math.abs(rx); ry = Math.abs(ry);
    if (rx === 0 || ry === 0) { poly.push({ x: ex, y: ey }); return { x: ex, y: ey }; }
    const phi = (phiDeg * Math.PI) / 180;
    const cp = Math.cos(phi), sp = Math.sin(phi);
    const dx = (x0 - ex) / 2, dy = (y0 - ey) / 2;
    const x1p = cp * dx + sp * dy;
    const y1p = -sp * dx + cp * dy;
    let rxs = rx * rx, rys = ry * ry;
    const lambda = (x1p * x1p) / rxs + (y1p * y1p) / rys;
    if (lambda > 1) {
        const sl = Math.sqrt(lambda);
        rx *= sl; ry *= sl; rxs = rx * rx; rys = ry * ry;
    }
    const denom = rxs * y1p * y1p + rys * x1p * x1p;
    let factor = Math.sqrt(Math.max(0, (rxs * rys - denom) / denom));
    if (largeArc === sweep) factor = -factor;
    const cxp = (factor * rx * y1p) / ry;
    const cyp = (-factor * ry * x1p) / rx;
    const cx = cp * cxp - sp * cyp + (x0 + ex) / 2;
    const cy = sp * cxp + cp * cyp + (y0 + ey) / 2;
    const ang = (ux, uy, vx, vy) => {
        const dot = ux * vx + uy * vy;
        const len = Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1;
        let a = Math.acos(Math.max(-1, Math.min(1, dot / len)));
        if (ux * vy - uy * vx < 0) a = -a;
        return a;
    };
    const theta1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    let dTheta = ang((x1p - cxp) / rx, (y1p - cyp) / ry,
        (-x1p - cxp) / rx, (-y1p - cyp) / ry);
    if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
    else if (sweep && dTheta < 0) dTheta += 2 * Math.PI;
    const steps = Math.max(4, Math.ceil((Math.abs(dTheta) / (Math.PI * 2)) * 48));
    for (let s = 1; s <= steps; s++) {
        const th = theta1 + (dTheta * s) / steps;
        const ct = Math.cos(th), st = Math.sin(th);
        poly.push({
            x: cp * rx * ct - sp * ry * st + cx,
            y: sp * rx * ct + cp * ry * st + cy,
        });
    }
    return { x: ex, y: ey };
}

/**
 * Flatten an SVG path `d` string into a list of polylines (`{x,y}[]`), in mm.
 * Supports M/L/H/V/Z, cubic/quadratic béziers (C/Q) and elliptical arcs (A);
 * unsupported commands (S/T) skip their numeric args. Béziers are sampled with
 * `bezierSteps` chords (default 16 — the Gerber/2D fidelity; the 3D view passes
 * 24 for smoother curves).
 * @param {string} d
 * @param {number} [bezierSteps=16]
 * @returns {Array<Array<{x:number,y:number}>>}
 */
export function flattenSvgPath(d, bezierSteps = 16) {
    if (!d) return [];
    const tokens = d.match(/[a-zA-Z]|-?[0-9]*\.?[0-9]+(?:e[-+]?[0-9]+)?/g) || [];
    const polys = [];
    let poly = [];
    let x = 0, y = 0, sx = 0, sy = 0, i = 0;
    const num = () => parseFloat(tokens[i++]);
    const push = () => poly.push({ x, y });
    const isCmd = (tok) => /[a-zA-Z]/.test(tok);
    while (i < tokens.length) {
        let t = tokens[i++];
        if (!isCmd(t)) { i--; t = 'L'; }
        const rel = t === t.toLowerCase() && t !== 'Z' && t !== 'z';
        const c = t.toUpperCase();
        if (c === 'M') {
            if (poly.length) { polys.push(poly); poly = []; }
            x = (rel ? x : 0) + num(); y = (rel ? y : 0) + num();
            sx = x; sy = y; push();
            // Subsequent pairs after M are implicit L.
            while (i < tokens.length && !isCmd(tokens[i])) {
                x = (rel ? x : 0) + num(); y = (rel ? y : 0) + num(); push();
            }
        } else if (c === 'L') {
            while (i < tokens.length && !isCmd(tokens[i])) {
                x = (rel ? x : 0) + num(); y = (rel ? y : 0) + num(); push();
            }
        } else if (c === 'H') {
            while (i < tokens.length && !isCmd(tokens[i])) { x = (rel ? x : 0) + num(); push(); }
        } else if (c === 'V') {
            while (i < tokens.length && !isCmd(tokens[i])) { y = (rel ? y : 0) + num(); push(); }
        } else if (c === 'Z') {
            x = sx; y = sy; push();
            polys.push(poly); poly = [];
        } else if (c === 'C') {
            while (i < tokens.length && !isCmd(tokens[i])) {
                const x1 = (rel ? x : 0) + num(), y1 = (rel ? y : 0) + num();
                const x2 = (rel ? x : 0) + num(), y2 = (rel ? y : 0) + num();
                const nx = (rel ? x : 0) + num(), ny = (rel ? y : 0) + num();
                sampleBezier(poly, x, y, x1, y1, x2, y2, nx, ny, bezierSteps);
                x = nx; y = ny;
            }
        } else if (c === 'Q') {
            while (i < tokens.length && !isCmd(tokens[i])) {
                const x1 = (rel ? x : 0) + num(), y1 = (rel ? y : 0) + num();
                const nx = (rel ? x : 0) + num(), ny = (rel ? y : 0) + num();
                // Quadratic → cubic.
                const cx1 = x + (2 / 3) * (x1 - x), cy1 = y + (2 / 3) * (y1 - y);
                const cx2 = nx + (2 / 3) * (x1 - nx), cy2 = ny + (2 / 3) * (y1 - ny);
                sampleBezier(poly, x, y, cx1, cy1, cx2, cy2, nx, ny, bezierSteps);
                x = nx; y = ny;
            }
        } else if (c === 'A') {
            while (i < tokens.length && !isCmd(tokens[i])) {
                const rx = num(), ry = num(), rot = num();
                const large = num(), sweep = num();
                const ex = (rel ? x : 0) + num(), ey = (rel ? y : 0) + num();
                const end = sampleArc(poly, x, y, rx, ry, rot, large !== 0, sweep !== 0, ex, ey);
                x = end.x; y = end.y;
            }
        } else {
            // Unsupported (S/T): skip its numeric args conservatively.
            while (i < tokens.length && !isCmd(tokens[i])) i++;
        }
    }
    if (poly.length) polys.push(poly);
    return polys;
}
