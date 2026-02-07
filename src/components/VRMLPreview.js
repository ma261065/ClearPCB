/**
 * Simple VRML parser and isometric renderer for 3D model previews
 */
export class VRMLPreview {
    /**
     * Parse VRML (.wrl) file content
     */
    static parseVRML(vrmlText) {
        const geometry = {
            vertices: [],
            faces: []
        };

        try {
            // Extract coordinate points
            const coordMatch = vrmlText.match(/point\s*\[([\s\S]*?)\]/);
            if (coordMatch) {
                const points = coordMatch[1].trim().split(/,|\s+/).filter(v => v);
                for (let i = 0; i < points.length; i += 3) {
                    geometry.vertices.push({
                        x: parseFloat(points[i]),
                        y: parseFloat(points[i + 1]),
                        z: parseFloat(points[i + 2])
                    });
                }
            }

            // Extract face indices
            const coordIndexMatch = vrmlText.match(/coordIndex\s*\[([\s\S]*?)\]/);
            if (coordIndexMatch) {
                const indices = coordIndexMatch[1].trim().split(/,|\s+/).filter(v => v);
                let face = [];
                for (const idx of indices) {
                    const index = parseInt(idx);
                    if (index === -1) {
                        if (face.length >= 3) {
                            geometry.faces.push([...face]);
                        }
                        face = [];
                    } else {
                        face.push(index);
                    }
                }
                if (face.length >= 3) {
                    geometry.faces.push(face);
                }
            }

            return geometry;
        } catch (error) {
            console.error('Error parsing VRML:', error);
            return null;
        }
    }

    /**
     * Project 3D point to isometric 2D coordinates
     */
    static projectIsometric(vertex, scale = 1) {
        // Isometric projection angles (30 degrees)
        const angle = Math.PI / 6; // 30 degrees
        const x = (vertex.x - vertex.z) * Math.cos(angle) * scale;
        const y = (vertex.x + vertex.z) * Math.sin(angle) * scale - vertex.y * scale;
        return { x, y };
    }

    /**
     * Calculate bounding box of projected vertices
     */
    static getBounds(vertices, scale = 1) {
        if (vertices.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };

        let minX = Infinity, minY = Infinity;
        let maxX = -Infinity, maxY = -Infinity;

        for (const vertex of vertices) {
            const p = this.projectIsometric(vertex, scale);
            minX = Math.min(minX, p.x);
            minY = Math.min(minY, p.y);
            maxX = Math.max(maxX, p.x);
            maxY = Math.max(maxY, p.y);
        }

        return { minX, minY, maxX, maxY };
    }

    /**
     * Render geometry to SVG
     */
    static renderToSVG(geometry, options = {}) {
        const {
            width = 200,
            height = 200,
            lineColor = '#444444',
            lineWidth = 0.8,
            fillColor = '#666666',
            strokeOpacity = 0.9,
            fillOpacity = 0.7
        } = options;

        if (!geometry || !geometry.vertices || geometry.vertices.length === 0) {
            return '<div style="color:var(--text-muted);text-align:center;padding:20px">No 3D data</div>';
        }

        // Auto-scale to fit the viewport
        const bounds = this.getBounds(geometry.vertices, 1);
        const boundWidth = bounds.maxX - bounds.minX;
        const boundHeight = bounds.maxY - bounds.minY;
        const maxDim = Math.max(boundWidth, boundHeight);
        const scale = maxDim > 0 ? (Math.min(width, height) * 0.8) / maxDim : 1;

        // Recalculate bounds with final scale
        const scaledBounds = this.getBounds(geometry.vertices, scale);
        const centerX = (scaledBounds.minX + scaledBounds.maxX) / 2;
        const centerY = (scaledBounds.minY + scaledBounds.maxY) / 2;

        // Create SVG
        const padding = 10;
        const viewBoxWidth = scaledBounds.maxX - scaledBounds.minX + padding * 2;
        const viewBoxHeight = scaledBounds.maxY - scaledBounds.minY + padding * 2;
        const viewBox = `${scaledBounds.minX - padding} ${scaledBounds.minY - padding} ${viewBoxWidth} ${viewBoxHeight}`;

        let svg = `<svg viewBox="${viewBox}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%">`;

        // Calculate face depths for back-to-front rendering
        const facesWithDepth = geometry.faces.map(face => {
            let avgZ = 0;
            for (const idx of face) {
                if (idx < geometry.vertices.length) {
                    avgZ += geometry.vertices[idx].z;
                }
            }
            avgZ /= face.length;
            return { face, depth: avgZ };
        });

        // Sort by depth (furthest first)
        facesWithDepth.sort((a, b) => a.depth - b.depth);

        // Render faces
        for (const { face } of facesWithDepth) {
            const points = face
                .filter(idx => idx < geometry.vertices.length)
                .map(idx => {
                    const p = this.projectIsometric(geometry.vertices[idx], scale);
                    return `${p.x},${p.y}`;
                })
                .join(' ');

            if (points) {
                svg += `<polygon points="${points}" fill="${fillColor}" fill-opacity="${fillOpacity}" stroke="${lineColor}" stroke-width="${lineWidth}" stroke-opacity="${strokeOpacity}" />`;
            }
        }
        svg += '</svg>';
        return svg;
    }

    /**
     * Fetch and render VRML from URL
     */
    static async fetchAndRender(url, options = {}) {
        try {
            // Use proxy if provided
            const fetchUrl = options.proxyUrl ? `${options.proxyUrl}${encodeURIComponent(url)}` : url;
            const response = await fetch(fetchUrl);
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            
            const vrmlText = await response.text();
            const geometry = this.parseVRML(vrmlText);
            
            if (!geometry || geometry.vertices.length === 0) {
                return '<div style="color:var(--text-muted);text-align:center;padding:20px">No geometry found</div>';
            }

            return this.renderToSVG(geometry, options);
        } catch (error) {
            console.error('Error fetching/rendering VRML:', error);
            return `<div style="color:var(--accent-color);text-align:center;padding:20px;font-size:12px">3D load error: ${error.message}</div>`;
        }
    }

    /**
     * Render EasyEDA 3D model JSON data
     * EasyEDA stores 3D data as a simple array of vertices and faces
     */
    static renderEasyEDAModel(model3dJson, options = {}) {
        try {
            if (!model3dJson) {
                return '<div style="color:var(--text-muted);text-align:center;padding:20px">No 3D data</div>';
            }

            // Parse EasyEDA 3D JSON format
            const modelData = typeof model3dJson === 'string' ? JSON.parse(model3dJson) : model3dJson;
            
            // EasyEDA format typically has: { vertices: [[x,y,z],...], faces: [[i1,i2,i3],...] }
            // or sometimes just an array of vertices with implicit faces
            if (!modelData || (!modelData.vertices && !Array.isArray(modelData))) {
                return '<div style="color:var(--text-muted);text-align:center;padding:20px">Invalid 3D format</div>';
            }

            // Convert to our geometry format
            const geometry = {
                vertices: [],
                faces: []
            };

            // Handle different EasyEDA formats
            if (modelData.vertices && Array.isArray(modelData.vertices)) {
                // Format: { vertices: [[x,y,z],...], faces: [[i1,i2,i3],...] }
                geometry.vertices = modelData.vertices.map(v => ({
                    x: parseFloat(v[0]) || 0,
                    y: parseFloat(v[1]) || 0,
                    z: parseFloat(v[2]) || 0
                }));

                if (modelData.faces && Array.isArray(modelData.faces)) {
                    geometry.faces = modelData.faces.map(f => f.map(i => parseInt(i)));
                }
            } else if (Array.isArray(modelData)) {
                // Format: [[x,y,z],...]
                geometry.vertices = modelData.map(v => ({
                    x: parseFloat(v[0]) || 0,
                    y: parseFloat(v[1]) || 0,
                    z: parseFloat(v[2]) || 0
                }));
            }

            if (geometry.vertices.length === 0) {
                return '<div style="color:var(--text-muted);text-align:center;padding:20px">No vertices found</div>';
            }

            // If no faces provided, create triangles from sequential vertices
            if (geometry.faces.length === 0 && geometry.vertices.length >= 3) {
                for (let i = 0; i < geometry.vertices.length - 2; i += 3) {
                    geometry.faces.push([i, i + 1, i + 2]);
                }
            }

            return this.renderToSVG(geometry, options);
        } catch (error) {
            console.error('Error rendering EasyEDA 3D model:', error);
            return `<div style="color:var(--accent-color);text-align:center;padding:20px;font-size:12px">3D render error: ${error.message}</div>`;
        }
    }

    /**
     * Parse and render OBJ format 3D model
     * @param {string} objText - OBJ file content
     * @param {object} options - Rendering options
     */
    static renderOBJ(objText, options = {}) {
        try {
            const geometry = this.parseOBJ(objText);
            
            if (geometry.vertices.length === 0) {
                return '<div style="color:var(--text-muted);text-align:center;padding:20px">No vertices found</div>';
            }

            return this.renderToSVG(geometry, options);
        } catch (error) {
            console.error('Error rendering OBJ model:', error);
            return `<div style="color:var(--accent-color);text-align:center;padding:20px;font-size:12px">OBJ render error: ${error.message}</div>`;
        }
    }

    /**
     * Parse OBJ format content
     * @param {string} objText - OBJ file content
     * @returns {object} Geometry data with vertices and faces
     */
    static parseOBJ(objText) {
        const geometry = {
            vertices: [],
            faces: []
        };

        const lines = objText.split('\n');
        
        for (const line of lines) {
            const trimmed = line.trim();
            
            // Vertex line: v x y z
            if (trimmed.startsWith('v ')) {
                const parts = trimmed.split(/\s+/);
                if (parts.length >= 4) {
                    geometry.vertices.push({
                        x: parseFloat(parts[1]),
                        y: parseFloat(parts[2]),
                        z: parseFloat(parts[3])
                    });
                }
            }
            // Face line: f v1 v2 v3 or f v1/vt1/vn1 v2/vt2/vn2 v3/vt3/vn3
            else if (trimmed.startsWith('f ')) {
                const parts = trimmed.split(/\s+/).slice(1);
                const faceIndices = parts.map(p => {
                    // Handle formats like "1/1/1" - we only care about vertex index
                    const vertexIndex = parseInt(p.split('/')[0]);
                    // OBJ indices are 1-based, convert to 0-based
                    return vertexIndex - 1;
                });
                
                if (faceIndices.length >= 3) {
                    // Triangulate if needed (for quads and higher)
                    for (let i = 1; i < faceIndices.length - 1; i++) {
                        geometry.faces.push([
                            faceIndices[0],
                            faceIndices[i],
                            faceIndices[i + 1]
                        ]);
                    }
                }
            }
        }

        return geometry;
    }
}
