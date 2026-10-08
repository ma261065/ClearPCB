# Component Libraries and KiCad Fetching

Component ingestion lives under `src/components/`. `ComponentLibrary.js` owns the
library instance, built-in/user component registration, and the live `kicadFetcher`
used by schematic and PCB flows. `KiCadFetcher.js` remains the public entry point:
callers construct it or import `warmKiCadIndex()`, while the implementation is split
under `src/components/kicad/` by responsibility.

`kicad/constants.js` owns shared cache keys, KiCad markers, TTLs and keyword aliases.
`kicad/network.js` owns release detection, the published static-index fetch, CORS
proxy fetch retries, response validation, raw GitLab URL construction and standard
content-cache writes. `kicad/symbol-index.js` owns the searchable symbol index,
published/static index hydration, stale-cache refresh and progress callbacks.
`kicad/symbol-fetch.js` owns symbol library/symdir resolution and raw symbol file
downloads. `kicad/sexp-parser.js` owns tokenizing and parsing KiCad S-expression
syntax shared by symbol and footprint conversion. `kicad/symbol-parser.js` owns
KiCad symbol conversion into ClearPCB symbol objects; `kicad/symbol-graphics.js`
owns primitive pin, stroke, fill and graphic parsing used by that conversion.

Footprint ownership is separate from symbol ownership. `kicad/footprints.js` owns
footprint availability checks, footprint-name indexes, filter matching and raw
`.kicad_mod` downloads, including 3D model URL existence checks. `kicad/footprint-parser.js`
owns translating `.kicad_mod` S-expressions into the ClearPCB preview shape list and
bounding box. KiCad footprint coordinates are already Y-down like ClearPCB, so the
parser uses them as written; KiCad symbol coordinates remain converted from Y-up by
the symbol parser.
