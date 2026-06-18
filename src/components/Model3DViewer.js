/**
 * Model3DViewer — compact interactive THREE.js viewer for a single component
 * OBJ model. Reuses the exact rendering pipeline that drives the PCB board
 * viewer (parseObjModel + meshToGeometry + makeMaterial + ArcballController)
 * so the schematic component-picker preview matches the board look and gains
 * drag-to-spin / wheel-to-zoom interaction.
 *
 * Usage:
 *   const viewer = new Model3DViewer(containerEl);
 *   viewer.setModel(objText);   // returns true on success, false if unparsable
 *   ...
 *   viewer.dispose();           // free the WebGL context when done
 */

import * as THREE from '../../assets/vendor/three.module.js';
import {
    ArcballController,
    parseObjModel,
    meshToGeometry,
    makeComponentMaterial,
    makeComponentGroupMaterials,
} from '../pcb/modules/board3d.js';

export class Model3DViewer {
    /**
     * @param {HTMLElement} container host element; the canvas fills it
     */
    constructor(container) {
        this.container = container;
        this._disposed = false;
        this._raf = 0;
        this._mesh = null;

        const w = Math.max(1, container.clientWidth || 1);
        const h = Math.max(1, container.clientHeight || 1);

        const canvas = document.createElement('canvas');
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.display = 'block';
        canvas.style.cursor = 'grab';
        canvas.style.touchAction = 'none';
        this.canvas = canvas;
        container.appendChild(canvas);

        const renderer = new THREE.WebGLRenderer({
            canvas,
            antialias: true,
            alpha: true,            // adopt the panel background
            // meshToGeometry splits the OBJ into one draw group per material so
            // setModel can give each a polygonOffset — that's what stops the
            // printed markings/logos (authored coincident with the body shell)
            // from z-fighting. NOTE: logarithmicDepthBuffer MUST stay off — it
            // writes depth via gl_FragDepth in the shader, which bypasses
            // glPolygonOffset and makes the offset (and thus the fix) a no-op.
        });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setSize(w, h, false);
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.setClearColor(0x000000, 0);
        this.renderer = renderer;

        const scene = new THREE.Scene();
        this.scene = scene;

        const camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 20000);
        camera.position.set(60, 50, 80);
        this.camera = camera;

        // Lighting mirrors the board viewer: a soft ambient fill, plus a key
        // directional and a point glint that both ride with the camera. A
        // dim back-fill directional keeps the shadowed faces from going flat
        // grey so the part reads bright from every angle.
        scene.add(new THREE.AmbientLight(0xffffff, 1.05));
        const key = new THREE.DirectionalLight(0xffffff, 1.6);
        const fill = new THREE.DirectionalLight(0xffffff, 0.6);
        const glint = new THREE.PointLight(0xffffff, 1.0, 0, 2);
        scene.add(key);
        scene.add(fill);
        scene.add(glint);
        this._key = key;
        this._fill = fill;
        this._glint = glint;

        const controls = new ArcballController(camera, canvas);
        controls.rotateSpeed = 1.0;
        controls.addEventListener('change', () => this._scheduleRender());
        controls.addEventListener('start', () => { canvas.style.cursor = 'grabbing'; });
        controls.addEventListener('end', () => { canvas.style.cursor = 'grab'; });
        this.controls = controls;

        // Render on demand (only when the view actually changes).
        this._onResize = () => this._handleResize();
        if (typeof ResizeObserver !== 'undefined') {
            this._resizeObs = new ResizeObserver(this._onResize);
            this._resizeObs.observe(container);
        } else {
            window.addEventListener('resize', this._onResize);
        }
    }

    /**
     * Load an OBJ model. Recenters and frames it for a pleasant default view.
     * @param {string} objText raw Wavefront OBJ text
     * @returns {boolean} true if a model was rendered
     */
    setModel(objText) {
        if (this._disposed) return false;
        const parsed = parseObjModel(objText);
        if (!parsed || !parsed.vertices.length || !parsed.faces.length) return false;

        this._clearMesh();

        const geo = meshToGeometry({ verts: parsed.vertices, faces: parsed.faces }, true);
        // OBJ models are authored Z-up; the arcball world is Y-up. Stand the
        // model upright so it spins about its vertical axis.
        geo.rotateX(-Math.PI / 2);
        geo.center();
        geo.computeBoundingSphere();

        this._material = null;
        let meshMaterial;
        // meshToGeometry split the model into one draw group per material
        // colour, preserving the OBJ's authoring order. makeComponentGroupMaterials
        // gives each group a distinct stepped polygonOffset so coincident
        // markings/pads on the shell don't z-fight (see that helper). The board
        // view applies the identical fix to placed bodies.
        const counts = geo.userData.groupVertCounts || [];
        if (counts.length > 1) {
            this._materials = makeComponentGroupMaterials(counts);
            meshMaterial = this._materials;
        } else {
            this._material = makeComponentMaterial();
            meshMaterial = this._material;
        }
        const mesh = new THREE.Mesh(geo, meshMaterial);
        this.scene.add(mesh);
        this._mesh = mesh;

        this._frame(geo.boundingSphere ? geo.boundingSphere.radius : 10);
        this._scheduleRender();
        return true;
    }

    /** Position the camera to frame a model of the given bounding radius. */
    _frame(radius) {
        const r = Math.max(0.001, radius);
        const fov = (this.camera.fov * Math.PI) / 180;
        const dist = (r / Math.sin(fov / 2)) * 1.15;
        const dir = new THREE.Vector3(0.7, 0.5, 0.85).normalize();
        this.camera.position.copy(dir.multiplyScalar(dist));
        this.camera.near = Math.max(0.01, r / 100);
        this.camera.far = dist * 10;
        this.camera.updateProjectionMatrix();
        this.controls.target.set(0, 0, 0);
        this.controls.minDistance = r * 0.4;
        this.controls.maxDistance = dist * 4;
        this.controls.update();
    }

    _handleResize() {
        if (this._disposed) return;
        const w = Math.max(1, this.container.clientWidth || 1);
        const h = Math.max(1, this.container.clientHeight || 1);
        this.renderer.setSize(w, h, false);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        this.controls.handleResize();
        this._scheduleRender();
    }

    _scheduleRender() {
        if (this._disposed || this._raf) return;
        this._raf = requestAnimationFrame(() => {
            this._raf = 0;
            this._render();
        });
    }

    _render() {
        if (this._disposed) return;
        this.controls.update();
        // Lights ride with the camera so the lit side always faces the viewer.
        this._key.position.copy(this.camera.position);
        this._glint.position.copy(this.camera.position);
        // Back-fill from the opposite side of the model so shadowed faces are
        // lit too (keeps the part from reading as a dull grey blob).
        this._fill.position.copy(this.controls.target)
            .sub(this.camera.position).add(this.controls.target);
        // The glint uses inverse-square decay, so a fixed intensity all but
        // vanishes at the camera's standoff distance. Scale by distance² (as
        // the board viewer does) so it stays a consistent, bright highlight.
        const d = this.camera.position.distanceTo(this.controls.target) || 1;
        this._glint.intensity = d * d * 2.2;
        this.renderer.render(this.scene, this.camera);
    }

    _clearMesh() {
        if (this._mesh) {
            this.scene.remove(this._mesh);
            this._mesh.geometry?.dispose();
            this._mesh = null;
        }
        if (this._material) {
            this._material.dispose();
            this._material = null;
        }
        if (this._bodyMaterial) {
            this._bodyMaterial.dispose();
            this._bodyMaterial = null;
        }
        if (this._materials) {
            for (const m of this._materials) m.dispose();
            this._materials = null;
        }
    }

    /** Release the WebGL context and listeners. Safe to call more than once. */
    dispose() {
        if (this._disposed) return;
        this._disposed = true;
        if (this._raf) {
            cancelAnimationFrame(this._raf);
            this._raf = 0;
        }
        if (this._resizeObs) {
            this._resizeObs.disconnect();
            this._resizeObs = null;
        } else {
            window.removeEventListener('resize', this._onResize);
        }
        this.controls?.dispose();
        this._clearMesh();
        this.renderer?.dispose();
        this.renderer?.forceContextLoss?.();
        if (this.canvas && this.canvas.parentNode) {
            this.canvas.parentNode.removeChild(this.canvas);
        }
        this.canvas = null;
    }
}
