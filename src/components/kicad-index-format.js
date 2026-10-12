/**
 * KiCad library index rules shared by the app (KiCadFetcher) and the release-time
 * generator (tools/build-kicad-index.mjs), so both parse and validate identically.
 */

export const KICAD_SYMBOLS_PROJECT_PATH = 'kicad%2Flibraries%2Fkicad-symbols';
export const KICAD_FOOTPRINTS_PROJECT_PATH = 'kicad%2Flibraries%2Fkicad-footprints';
export const MIN_EXPECTED_LIBRARY_COUNT = 100;
export const REQUIRED_LIBRARY_NAMES = ['Device', 'Timer'];
export const MIN_EXPECTED_FOOTPRINT_COUNT = 5000;
export const REQUIRED_FOOTPRINT_LIB_PREFIXES = ['Package_TO_SOT_SMD:', 'Package_SO:', 'Resistor_SMD:'];
export const STATIC_INDEX_FORMAT = 1;

/**
 * @typedef {{ format: number, tag: string, generatedAt: string,
 *   symbols: Object<string, string[]>, footprints: string[] }} StaticKiCadIndex
 */

/**
 * Pick the newest stable release from GitLab tag names (skips rc/alpha/beta/backport
 * and legacy `v`-prefixed tags).
 * @param {string[]} names
 * @returns {string|null}
 */
export function latestStableTag(names) {
    const stable = names
        .filter(name => typeof name === 'string' && name && !/rc|alpha|beta|backport|^v/i.test(name))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    return stable[0] || null;
}

/**
 * Add `Lib.kicad_symdir/Symbol.kicad_sym` blobs from a recursive tree listing.
 * @param {Array<{type?: string, path?: string}>} entries
 * @param {Object<string, string[]>} index - Mutated: library name -> symbol names
 */
export function addSymbolTreeEntries(entries, index) {
    for (const entry of entries) {
        if (entry?.type !== 'blob' || typeof entry.path !== 'string') continue;
        const match = entry.path.match(/^([^/]+)\.kicad_symdir\/([^/]+)\.kicad_sym$/);
        if (!match) continue;
        if (!index[match[1]]) index[match[1]] = [];
        index[match[1]].push(match[2]);
    }
}

/**
 * Footprint name (`Lib:Name`) for a `Lib.pretty/Name.kicad_mod` tree path.
 * @param {string} path
 * @returns {string|null}
 */
export function footprintNameFromPath(path) {
    const match = typeof path === 'string' ? path.match(/^(.+?)\.pretty\/(.+?)\.kicad_mod$/i) : null;
    return match ? `${match[1]}:${match[2]}` : null;
}

/**
 * Heuristic guard against partial symbol indexes (e.g. interrupted downloads).
 * @param {unknown} index
 * @returns {boolean}
 */
export function isLikelyValidSymbolIndex(index) {
    if (!index || typeof index !== 'object' || Array.isArray(index)) return false;
    const symbols = /** @type {Object<string, unknown>} */ (index);
    if (Object.keys(symbols).length < MIN_EXPECTED_LIBRARY_COUNT) return false;
    return REQUIRED_LIBRARY_NAMES.every(name => Array.isArray(symbols[name]) && symbols[name].length > 0);
}

/**
 * Heuristic guard against partial footprint name indexes.
 * @param {unknown} list
 * @returns {boolean}
 */
export function isLikelyValidFootprintIndex(list) {
    if (!Array.isArray(list) || list.length < MIN_EXPECTED_FOOTPRINT_COUNT) return false;
    return REQUIRED_FOOTPRINT_LIB_PREFIXES.every(prefix =>
        list.some(name => typeof name === 'string' && name.startsWith(prefix))
    );
}

/**
 * Whether a parsed `assets/kicad-index.json` document is complete and usable.
 * @param {unknown} doc
 * @returns {doc is StaticKiCadIndex}
 */
export function isValidStaticIndex(doc) {
    if (!doc || typeof doc !== 'object') return false;
    const candidate = /** @type {Partial<StaticKiCadIndex>} */ (doc);
    return candidate.format === STATIC_INDEX_FORMAT
        && typeof candidate.tag === 'string' && candidate.tag.length > 0
        && isLikelyValidSymbolIndex(candidate.symbols)
        && isLikelyValidFootprintIndex(candidate.footprints);
}
