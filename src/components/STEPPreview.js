/**
 * STEP file (ISO-10303-21) preview renderer.
 *
 * This is a *previewer* — it extracts enough face-boundary geometry from the
 * STEP topology to produce a recognisable isometric silhouette, but does not
 * attempt to tessellate curved surfaces (B-splines, cylinders, etc.).
 * Curved edges are represented by their start/end vertices, giving a
 * straight-edge approximation that is adequate for a small preview thumbnail.
 */
export class STEPPreview {

    // ── public API ──────────────────────────────────────────────────────

    /**
     * Detect whether text content is a STEP file.
     * @param {string} text - First ~500 chars of the file
     * @returns {boolean}
     */
    static isSTEP(text) {
        const head = text.slice(0, 500);
        return /ISO[- ]?10303[- ]?21/i.test(head) || /\bHEADER\s*;/i.test(head);
    }

    /**
     * Parse a STEP file into preview geometry.
     *
     * Walks: ADVANCED_FACE → FACE_BOUND / FACE_OUTER_BOUND → EDGE_LOOP
     *        → ORIENTED_EDGE → EDGE_CURVE → VERTEX_POINT → CARTESIAN_POINT
     *
     * @param {string} stepText - Full STEP file content
     * @returns {{vertices:{x:number,y:number,z:number}[], faces:number[][]}|null}
     */
    static parse(stepText) {
        const geometry = { vertices: [], faces: [] };

        try {
            // Flatten to a single line
            const flat = stepText.replace(/\r\n?/g, '\n').replace(/\n/g, ' ');

            // Isolate the DATA section
            const dataMatch = flat.match(/DATA\s*;(.*?)ENDSEC\s*;/i);
            if (!dataMatch) return null;

            // ── Build entity map ─────────────────────────────────────────
            const entities = {};
            for (const stmt of dataMatch[1].split(';')) {
                const t = stmt.trim();
                if (!t || t.startsWith('/*')) continue;
                const m = t.match(/^#(\d+)\s*=\s*([A-Z_][A-Z0-9_]*)\s*\(([\s\S]*)\)$/);
                if (m) entities[m[1]] = { type: m[2], raw: m[3] };
            }

            // ── Helpers ──────────────────────────────────────────────────

            /** Split top-level comma-separated args, respecting nested parens & strings */
            function splitArgs(raw) {
                const out = [];
                let cur = '', depth = 0, inStr = false;
                for (let i = 0; i < raw.length; i++) {
                    const ch = raw[i];
                    if (inStr)  { cur += ch; if (ch === "'") inStr = false; continue; }
                    if (ch === "'") { inStr = true; cur += ch; continue; }
                    if (ch === '(') { depth++; cur += ch; continue; }
                    if (ch === ')') { depth--; cur += ch; continue; }
                    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
                    cur += ch;
                }
                if (cur.trim()) out.push(cur.trim());
                return out;
            }

            function refList(s) {
                const inner = s.replace(/^\(/, '').replace(/\)$/, '').trim();
                if (!inner) return [];
                return inner.split(',')
                    .map(t => { const r = t.trim().match(/#(\d+)/); return r ? r[1] : null; })
                    .filter(Boolean);
            }

            function ref(s) { const r = s.trim().match(/#(\d+)/); return r ? r[1] : null; }

            function coords(s) {
                const inner = s.replace(/^\(/, '').replace(/\)$/, '').trim();
                const p = inner.split(',').map(v => parseFloat(v.trim()));
                return { x: p[0] || 0, y: p[1] || 0, z: p[2] || 0 };
            }

            // ── Cached lookups ───────────────────────────────────────────
            const cpCache = {};
            const vpCache = {};

            function getCartesianPoint(id) {
                if (cpCache[id] !== undefined) return cpCache[id];
                const e = entities[id];
                if (!e || e.type !== 'CARTESIAN_POINT') return (cpCache[id] = null);
                const args = splitArgs(e.raw);
                return (cpCache[id] = args.length >= 2 ? coords(args[1]) : null);
            }

            function getVertexPoint(id) {
                if (vpCache[id] !== undefined) return vpCache[id];
                const e = entities[id];
                if (!e || e.type !== 'VERTEX_POINT') return (vpCache[id] = null);
                const args = splitArgs(e.raw);
                const r = args.length >= 2 ? ref(args[1]) : null;
                return (vpCache[id] = r ? getCartesianPoint(r) : null);
            }

            // Vertex deduplication
            const vertexMap = new Map();
            function vertexIdx(pt) {
                if (!pt) return -1;
                const key = `${pt.x.toFixed(6)},${pt.y.toFixed(6)},${pt.z.toFixed(6)}`;
                if (vertexMap.has(key)) return vertexMap.get(key);
                const idx = geometry.vertices.length;
                geometry.vertices.push(pt);
                vertexMap.set(key, idx);
                return idx;
            }

            // ── Walk ADVANCED_FACE topology ──────────────────────────────
            for (const ent of Object.values(entities)) {
                if (ent.type !== 'ADVANCED_FACE') continue;

                const args = splitArgs(ent.raw);
                if (args.length < 2) continue;

                for (const bId of refList(args[1])) {
                    const bound = entities[bId];
                    if (!bound || (bound.type !== 'FACE_BOUND' && bound.type !== 'FACE_OUTER_BOUND')) continue;

                    const bArgs = splitArgs(bound.raw);
                    if (bArgs.length < 2) continue;
                    const edgeLoop = entities[ref(bArgs[1])];
                    if (!edgeLoop || edgeLoop.type !== 'EDGE_LOOP') continue;

                    const elArgs = splitArgs(edgeLoop.raw);
                    if (elArgs.length < 2) continue;

                    const faceVerts = [];
                    for (const oeId of refList(elArgs[1])) {
                        const oe = entities[oeId];
                        if (!oe || oe.type !== 'ORIENTED_EDGE') continue;
                        const oeArgs = splitArgs(oe.raw);
                        if (oeArgs.length < 5) continue;

                        const ec = entities[ref(oeArgs[3])];
                        if (!ec || ec.type !== 'EDGE_CURVE') continue;
                        const ecArgs = splitArgs(ec.raw);
                        if (ecArgs.length < 3) continue;

                        const sense = oeArgs[4].trim();
                        const vRef = sense === '.T.' ? ref(ecArgs[1]) : ref(ecArgs[2]);
                        const idx = vertexIdx(vRef ? getVertexPoint(vRef) : null);
                        if (idx >= 0 && (faceVerts.length === 0 || faceVerts[faceVerts.length - 1] !== idx)) {
                            faceVerts.push(idx);
                        }
                    }

                    if (faceVerts.length >= 3) geometry.faces.push(faceVerts);
                }
            }

            return geometry.vertices.length > 0 ? geometry : null;
        } catch (error) {
            console.error('Error parsing STEP:', error);
            return null;
        }
    }

    // ── Projection & rendering (self-contained for preview) ─────────────

    /**
     * Project a 3D point to 2D isometric coordinates.
     */
    static _project(v, scale) {
        const a = Math.PI / 6;
        return {
            x: (v.x - v.z) * Math.cos(a) * scale,
            y: (v.x + v.z) * Math.sin(a) * scale - v.y * scale
        };
    }

    /**
     * Render parsed geometry to an SVG string.
     * @param {{vertices:{x:number,y:number,z:number}[], faces:number[][]}} geometry
     * @param {object} [options]
     * @returns {string} SVG markup
     */
    static renderToSVG(geometry, options = {}) {
        const {
            width = 200, height = 200,
            lineColor = '#444444', lineWidth = 0.8,
            fillColor = '#666666',
            strokeOpacity = 0.9, fillOpacity = 0.7
        } = options;

        if (!geometry?.vertices?.length) {
            return '<div style="color:var(--text-muted);text-align:center;padding:20px">No 3D data</div>';
        }

        // Auto-scale
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const v of geometry.vertices) {
            const p = this._project(v, 1);
            if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
        }
        const maxDim = Math.max(maxX - minX, maxY - minY);
        const scale = maxDim > 0 ? (Math.min(width, height) * 0.8) / maxDim : 1;

        // Recompute bounds at final scale
        minX = Infinity; minY = Infinity; maxX = -Infinity; maxY = -Infinity;
        for (const v of geometry.vertices) {
            const p = this._project(v, scale);
            if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
        }

        const pad = 10;
        const vb = `${minX - pad} ${minY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`;
        let svg = `<svg viewBox="${vb}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%">`;

        // Depth-sort faces (back-to-front)
        const sorted = geometry.faces
            .map(face => {
                let z = 0;
                for (const i of face) if (i < geometry.vertices.length) z += geometry.vertices[i].z;
                return { face, depth: z / face.length };
            })
            .sort((a, b) => a.depth - b.depth);

        for (const { face } of sorted) {
            const pts = face
                .filter(i => i < geometry.vertices.length)
                .map(i => { const p = this._project(geometry.vertices[i], scale); return `${p.x},${p.y}`; })
                .join(' ');
            if (pts) {
                svg += `<polygon points="${pts}" fill="${fillColor}" fill-opacity="${fillOpacity}" stroke="${lineColor}" stroke-width="${lineWidth}" stroke-opacity="${strokeOpacity}"/>`;
            }
        }

        svg += '</svg>';
        return svg;
    }

    /**
     * Fetch a STEP file via URL and render a preview SVG.
     * @param {string} url
     * @param {object} [options] - Rendering options + optional `proxyUrl`
     * @returns {Promise<string>} SVG markup or error HTML
     */
    static async fetchAndRender(url, options = {}) {
        try {
            const fetchUrl = options.proxyUrl
                ? `${options.proxyUrl}${encodeURIComponent(url)}`
                : url;
            const res = await fetch(fetchUrl);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            const text = await res.text();
            const geometry = this.parse(text);

            if (!geometry?.vertices?.length) {
                return '<div style="color:var(--text-muted);text-align:center;padding:20px">No geometry found</div>';
            }
            return this.renderToSVG(geometry, options);
        } catch (error) {
            console.error('Error fetching/rendering STEP:', error);
            return `<div style="color:var(--accent-color);text-align:center;padding:20px;font-size:12px">3D load error: ${error.message}</div>`;
        }
    }
}
