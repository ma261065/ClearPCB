/**
 * KiCad fetcher constants own cache keys, TTLs, markers and symbol search aliases
 * shared by the focused KiCad modules.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
export const SEARCH_CACHE_TTL_MS = DAY_MS;
export const CONTENT_CACHE_TTL_MS = 7 * DAY_MS;
export const SYMBOL_LIBRARY_MARKER = 'kicad_symbol_lib';
export const FOOTPRINT_MARKER = 'footprint';
export const CONTENT_PREVIEW_LENGTH = 200;
export const KICAD_FALLBACK_RELEASE = '9.0.2';
export const KICAD_GIT_REFS_BRANCHES = ['master', 'main'];
export const KICAD_LATEST_TAG_CACHE_KEY = 'kicad_latest_release_tag';
export const KICAD_LIBRARY_INDEX_CACHE_KEY = 'kicad_library_index';
export const KICAD_FULL_SYMBOL_INDEX_CACHE_KEY = 'kicad_full_symbol_index';
export const KICAD_FULL_FOOTPRINT_INDEX_CACHE_KEY = 'kicad_full_footprint_index';
// Built into the deployed site at release time by tools/build-kicad-index.mjs.
export const STATIC_INDEX_URL = new URL('../../../assets/kicad-index.json', import.meta.url).href;

/**
 * Keyword aliases for common component types.
 * Maps human-readable terms to KiCad symbol-name prefixes so that
 * searching "resistor" finds R, R_Small, R_US, etc. in the Device library.
 */
export const KEYWORD_ALIASES = new Map([
    ['resistor',    ['R']],
    ['capacitor',   ['C']],
    ['inductor',    ['L']],
    ['led',         ['LED']],
    ['potentiometer', ['R_Potentiometer']],
    ['thermistor',  ['Thermistor']],
    ['fuse',        ['Fuse', 'Polyfuse']],
    ['ferrite',     ['FerriteBead', 'L_Ferrite']],
    ['crystal',     ['Crystal']],
    ['transformer', ['Transformer']],
    ['relay',       ['Relay']],
    ['switch',      ['SW']],
    ['button',      ['SW_Push', 'SW_DPDT']],
    ['mosfet',      ['Q_NMOS', 'Q_PMOS', 'BSS', 'IRF', 'IRLML', 'Si2', 'AO']],
    ['transistor',  ['Q', 'BC', '2N', 'MMBT']],
    ['opamp',       ['LM358', 'LM324', 'TL07', 'TL08', 'OPA', 'MCP60', 'NE5532', 'AD82']],
    ['regulator',   ['LM78', 'LM317', 'AMS1117', 'MCP170', 'AP2112', 'L78']],
    ['op-amp',      ['LM358', 'LM324', 'TL07', 'TL08', 'OPA', 'MCP60', 'NE5532', 'AD82']],
    ['battery',     ['Battery']],
    ['motor',       ['Motor']],
    ['speaker',     ['Speaker']],
    ['microphone',  ['Microphone']],
    ['buzzer',      ['Buzzer']],
    ['varistor',    ['Varistor']],
    ['antenna',     ['Antenna']],
]);
