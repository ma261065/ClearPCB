# Vendoring npm Packages for ClearPCB

ClearPCB is a zero-build-step web app that loads ES modules directly in the browser. When we need to use an npm package, we "vendor" it — bundle it into a single standalone `.js` file and commit it to `assets/vendor/`.

## Process

### Prerequisites

You need **Node.js** (which includes npm and npx) installed.

### Steps

1. **Create a temp working directory and install the package:**

```powershell
Push-Location $env:TEMP
npm init -y
npm install <package-name> esbuild
```

This downloads the package and all its dependencies into `node_modules/`, plus esbuild (the bundler).

2. **Find the package's entry point:**

The entry point is usually listed in the package's `package.json` under `main`, `module`, or `exports`. For example:

```powershell
Get-Content node_modules/<package-name>/package.json | Select-String '"main"|"module"'
```

Common locations: `dist/index.js`, `dist/index.mjs`, `lib/index.js`.

3. **Bundle into a single ESM file:**

```powershell
npx esbuild node_modules/<package-name>/dist/index.js --bundle --format=esm --outfile="<path-to-ClearPCB>/assets/vendor/<name>.esm.js" --minify
```

Flags:
- `--bundle` — follows all `import`/`require` statements and inlines every dependency
- `--format=esm` — outputs an ES module (with `export` statements) so it works with `import`
- `--minify` — compresses the output to reduce file size
- `--outfile` — where to write the result

4. **Return to the workspace:**

```powershell
Pop-Location
```

5. **Verify the output:**

```powershell
# Check file size
Get-Item assets/vendor/<name>.esm.js | Select-Object Length, Name

# Verify it has ESM exports
(Get-Content assets/vendor/<name>.esm.js -Raw) -match 'export\s*\{'
```

6. **Test it works:**

Create a quick `.mjs` test file:

```javascript
import { SomeExport } from './assets/vendor/<name>.esm.js';
console.log(typeof SomeExport); // should print 'function' or 'object'
```

Run with: `node test.mjs`

Delete the test file after.

## Updating a vendored package

Re-run the same install + bundle steps with a newer version:

```powershell
Push-Location $env:TEMP
npm init -y
npm install <package-name>@latest esbuild
npx esbuild node_modules/<package-name>/dist/index.js --bundle --format=esm --outfile="<path>/assets/vendor/<name>.esm.js" --minify
Pop-Location
```

## Currently vendored packages

| File | Package | GitHub | Version | Size | License |
|------|---------|--------|---------|------|---------|
| `jspdf.umd.min.js` | jspdf | [MrRio/jsPDF](https://github.com/MrRio/jsPDF) | — | ~500KB | MIT |
| `svg2pdf.umd.min.js` | svg2pdf.js | [yWorks/svg2pdf.js](https://github.com/yWorks/svg2pdf.js) | — | ~100KB | MIT |
| `three.module.js` | three (core only) | [mrdoob/three.js](https://github.com/mrdoob/three.js) | 0.184.0 | ~502KB | MIT |
| `imagetracer.js` | imagetracerjs | [jankovicsandras/imagetracerjs](https://github.com/jankovicsandras/imagetracerjs/tree/1.2.6) | 1.2.6 | ~47KB | Unlicense |
| `vtracer_wasm.js` + `vtracer_wasm_bg.wasm` | @visioncortex/vtracer | [visioncortex/vtracer](https://github.com/visioncortex/vtracer/tree/1.0.0-alpha.4) | 1.0.0-alpha.4 | ~15KB + 653KB | MIT OR Apache-2.0; dependency notices included |

ImageTracerJS is downloaded from the upstream `1.2.6` tag's
`imagetracer_v1.2.6.js` rather than bundled from npm. The full upstream license is
retained in the file. Local changes: add `// @ts-nocheck`, remove the enclosing
IIFE and AMD/CommonJS/global export dispatch, and use `export default new
ImageTracer()`. The importer dynamically loads the tracing adapter only in trace
mode; existing image rendering does not load the tracer.

### VTracer Trial

The matching generated loader and WASM were downloaded from
`https://cdn.jsdelivr.net/npm/@visioncortex/vtracer@1.0.0-alpha.4/pkg/`
(`vtracer_wasm.js` and `vtracer_wasm_bg.wasm`). This is a vendoring-time
download only: the app fetches its own local WASM asset, never the CDN.
The binary is unchanged. Upstream SHA-256 hashes (hex):

- Loader, before adaptation: `e1855e9bb29d785344f672abdc692ca90ffa7ed863b9186b51c4e95a2a7dc17d`
- WASM: `63716b70497b7468ef97545b50f5f34b8bbb7acde2d7b00deb4eb40781446d45`

Local loader changes: remove the declaration-file reference, add `@ts-nocheck`,
replace CommonJS exports with ES exports, and replace the synchronous Node `fs`
bootstrap with a cached async initializer. It loads via `new URL(..., import.meta.url)`
and `WebAssembly.instantiate` on an ArrayBuffer, so servers need not provide the
WASM streaming MIME type. Failed initialization is retryable. No Rust installation,
Node runtime, or build step is required to use ClearPCB. Browser WebAssembly support
must be enabled; load/compile failures disable Import and are shown in the dialog.

The adapter selects binary clustering, spline fitting, absolute SVG commands,
four decimal places, and no SVG command optimization. Black foreground is supplied
from ClearPCB's white-material mask. SVG is parsed as an inert document and flattened
through the shared path parser with 0.125-source-pixel curve tolerance. Nothing from
the generated SVG is inserted into the live DOM or stored in the project.

`assets/vendor/vtracer-NOTICES.txt` retains upstream and dependency licence texts;
`vtracer-notice-sources.json` pins the collected crate archives and checksums.
The npm archive omits its WASM build lockfile. The notice set is therefore a
conservative reconstruction from the tagged core lockfile, binding versions embedded
in the WASM, and compatible binding transitives, **not a verified binary SBOM**.
It includes some build-time and optional decoder crates not necessarily linked into
the binary. All collected crate declarations offer permissive terms (MIT, Apache,
BSD, Zlib, Unicode, or public-domain alternatives); do not describe the entire bundle
as MIT-only. WASM producers identify Rust 1.95.0 and wasm-bindgen 0.2.126.

Regenerate the pinned notices with `node tools/vendor-vtracer-notices.mjs` (network
access and `tar` required). Bootstrapping a new notice manifest additionally uses
Python's `tomllib` or pip's bundled `tomli`. For a future production replacement,
prefer an upstream WASM lockfile or a locally reproducible Rust build and regenerate
the dependency inventory from that exact build. Headless coverage:
`node tools/test.mjs picture-vtracing picture-tracing-dialog`.

> **three.js note:** the bundle entry re-exports only the core symbols the
> 3D board viewer uses (`Scene`, `PerspectiveCamera`, `WebGLRenderer`,
> `MeshStandardMaterial`, `PointLight`, `BufferGeometry`, `CanvasTexture`,
> `LinearFilter`, `LinearMipmapLinearFilter`, etc.) so esbuild tree-shakes the
> rest of the library. `CanvasTexture` + the two filter constants back the
> board-face texture bake (the 2D fabricated render projected onto each board
> face). `EquirectangularReflectionMapping` backs the procedural studio
> environment map that gives the glossy solder mask its moving reflection — a
> punctual light on the camera axis can't glint a flat face, so the board
> reflects a world-fixed equirectangular env image instead. Orbit/pan/zoom is a
> custom Shoemake arcball implemented directly in `board3d.js` (no three.js
> controls addon is bundled). If the viewer starts using new three.js features
> (e.g. `RoomEnvironment` / `PMREMGenerator` for prefiltered environment
> reflections), add the symbols to the entry's export list and re-vendor. Full
> current export list: `AmbientLight, Box3, BufferGeometry, CanvasTexture,
> Color, DirectionalLight, DoubleSide, EquirectangularReflectionMapping,
> Float32BufferAttribute, Group, LinearFilter, LinearMipmapLinearFilter, Mesh,
> MeshStandardMaterial, PerspectiveCamera, PointLight, SRGBColorSpace, Scene,
> Vector3, WebGLRenderer`.


## Notes

- **`// @ts-nocheck` header** — vendored bundles (`three.module.js`, `earcut.module.js`) carry a `// @ts-nocheck` first line so the editor's `checkJs` type-checker skips them (jsconfig `exclude` doesn't help because they're imported by `src/`). Re-add this line after re-vendoring.
- **No build step in development** — vendored files are committed to git and loaded directly by the browser
- **Offline support** — vendored files work without internet, important for PWA/service worker
- **Lazy loading** — use `await import(...)` to load heavy vendor files only when needed
- **esbuild is only needed for vendoring** — it's not a project dependency, just a one-time tool
