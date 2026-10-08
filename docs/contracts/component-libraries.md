# Component Libraries and KiCad Fetching

Component ingestion lives under `src/components/`. `ComponentLibrary.js` owns
library instances, built-in and user component registration, and the live
`kicadFetcher` used by schematic and PCB flows.

`KiCadFetcher.js` is the public KiCad entry point. Callers construct
`KiCadFetcher` or import `warmKiCadIndex()`; the class stores fetcher state and
delegates KiCad-specific work to modules under `src/components/kicad/`.

KiCad responsibilities are split by data source and conversion step:

- `kicad/constants.js` owns shared cache keys, KiCad markers, TTLs and keyword
  aliases.
- `kicad/network.js` owns release detection, published static-index fetching,
  CORS-proxy retries, response validation, raw GitLab URL construction,
  first-existing URL resolution and content-cache writes.
- `kicad/symbol-index.js` owns searchable symbol indexes, published/static index
  hydration, stale-cache refresh and progress callbacks.
- `kicad/symbol-fetch.js` owns symbol library/symdir resolution and raw symbol
  file downloads.
- `kicad/sexp-parser.js` owns KiCad S-expression tokenizing and parsing shared
  by symbol and footprint conversion.
- `kicad/symbol-parser.js` owns KiCad symbol conversion into ClearPCB symbol
  objects.
- `kicad/symbol-graphics.js` owns primitive pin, stroke, fill and graphic
  parsing used by symbol conversion.
- `kicad/footprints.js` owns footprint availability checks, footprint-name
  indexes, filter matching, sibling variant lookup, raw `.kicad_mod` downloads
  and 3D model URL existence checks.
- `kicad/footprint-parser.js` owns `.kicad_mod` S-expression conversion into
  ClearPCB preview shapes and bounding boxes.

`ComponentPicker.js` owns the public picker lifecycle and wires the focused
picker owner modules. Under `src/components/picker/`, `dom.js` owns DOM binding
and modal cleanup; `results-list.js`, `search.js`, `online-selection.js`,
`symbol-preview.js`, `footprint-preview.js`, `placement.js` and `ui-state.js`
own their respective result, preview, placement and small UI-state concerns.
The shared component definition, symbol, pin and graphic typedefs live in
`Component.js`; picker code aliases those types instead of declaring local
stand-ins.

Footprint ownership is separate from symbol ownership. KiCad footprint coordinates
are Y-down like ClearPCB, so `kicad/footprint-parser.js` uses them as written.
KiCad symbol coordinates are Y-up and are negated by `kicad/symbol-parser.js`.
