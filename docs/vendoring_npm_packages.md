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

## Example: capacity-autorouter

The `@tscircuit/capacity-autorouter` package (MIT-licensed PCB autorouter) was vendored as follows:

```powershell
# Install
Push-Location $env:TEMP
npm init -y
npm install @tscircuit/capacity-autorouter esbuild

# Bundle (entry point: dist/index.js)
npx esbuild node_modules/@tscircuit/capacity-autorouter/dist/index.js --bundle --format=esm --outfile="C:\path\to\ClearPCB\assets\vendor\capacity-autorouter.esm.js" --minify

# Clean up
Pop-Location
```

Result: `capacity-autorouter.esm.js` — 1.1MB minified, self-contained ESM module.

Usage in ClearPCB:
```javascript
const { CapacityMeshSolver } = await import('../assets/vendor/capacity-autorouter.esm.js');
```

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
| `capacity-autorouter.esm.js` | @tscircuit/capacity-autorouter | [tscircuit/tscircuit-autorouter](https://github.com/tscircuit/tscircuit-autorouter) | 0.0.354 | 1.1MB | MIT |

## Notes

- **No build step in development** — vendored files are committed to git and loaded directly by the browser
- **Offline support** — vendored files work without internet, important for PWA/service worker
- **Lazy loading** — use `await import(...)` to load heavy vendor files only when needed
- **esbuild is only needed for vendoring** — it's not a project dependency, just a one-time tool
