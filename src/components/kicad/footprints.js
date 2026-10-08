/**
 * KiCad footprints owns footprint availability checks, footprint-name indexes
 * and raw footprint downloads. Parsing lives in footprint-parser.js.
 */

import { storageManager } from '../../core/StorageManager.js';
import { CONTENT_CACHE_TTL_MS, KICAD_FULL_FOOTPRINT_INDEX_CACHE_KEY } from './constants.js';
import { footprintNameFromPath, isLikelyValidFootprintIndex, KICAD_FOOTPRINTS_PROJECT_PATH } from '../kicad-index-format.js';

/** @typedef {{hasFootprint: boolean, has3d: boolean, footprintUrl?: string, modelUrl?: string}} FootprintAvailability */



    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Check whether a KiCad footprint file and its 3D STEP model exist on GitLab.
     * @param {string} footprintName - e.g. 'Resistor_SMD:R_0603_1608Metric'
     * @returns {Promise<FootprintAvailability>}
     */
export async function checkFootprintAvailability(fetcher, footprintName) {
    if (!footprintName || typeof footprintName !== 'string') {
        return { hasFootprint: false, has3d: false };
    }

    const [lib, name] = footprintName.split(':');
    if (!lib || !name) {
        return { hasFootprint: false, has3d: false };
    }

    const footprintCandidates = fetcher._buildRawUrlCandidates(
        fetcher.footprintsBase,
        `${lib}.pretty/${name}.kicad_mod`
    );
    const modelCandidates = [];
    for (const base of fetcher._getRawBaseCandidates(fetcher.models3dBase)) {
        modelCandidates.push(`${base}/${lib}.3dshapes/${name}.wrl`);
        modelCandidates.push(`${base}/${lib}.3dshapes/${name}.vrml`);
        modelCandidates.push(`${base}/${lib}.3dshapes/${name}.step`);
        modelCandidates.push(`${base}/${lib}.3dshapes/${name}.stp`);
    }

    const footprintResolved = await fetcher._resolveFirstExistingUrl(footprintCandidates, fetcher.footprintExistsCache, 'fp');
    const modelResolved = await fetcher._resolveFirstExistingUrl(modelCandidates, fetcher.model3dExistsCache, '3d');

    return {
        hasFootprint: !!footprintResolved,
        has3d: !!modelResolved,
        footprintUrl: footprintResolved || footprintCandidates[0],
        modelUrl: modelResolved || modelCandidates[0]
    };
}



    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Fetch and parse a `.kicad_mod` footprint file into a pad-shape preview.
     * @param {string} footprintName - e.g. 'Resistor_SMD:R_0603_1608Metric'
     * @returns {Promise<import('./footprint-parser.js').FootprintPreview|null>}
     */
export async function fetchFootprintPreview(fetcher, footprintName) {
    if (!footprintName || typeof footprintName !== 'string') {
        return null;
    }

    const cacheKey = `fp_preview:${footprintName}`;
    if (fetcher.footprintPreviewCache.has(cacheKey)) {
        return /** @type {import('./footprint-parser.js').FootprintPreview} */ (fetcher.footprintPreviewCache.get(cacheKey));
    }

    const [lib, name] = footprintName.split(':');
    if (!lib || !name) {
        return null;
    }

    const content = await fetcher._fetchFootprintFile(lib, name);
    if (!content) {
        return null;
    }

    const preview = fetcher._parseFootprintPreview(content);
    if (preview) {
        fetcher.footprintPreviewCache.set(cacheKey, preview);
    }

    return preview;
}



    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Find likely concrete footprints from KiCad fp-filter patterns.
     * @param {string[]} filters
     * @param {{limit?: number}} [options]
     * @returns {Promise<string[]>}
     */
export async function findFootprintCandidatesByFilters(fetcher, filters, options = {}) {
    const limit = Math.max(1, Math.min(500, options.limit || 50));
    const normalized = Array.from(new Set((filters || [])
        .map(f => (typeof f === 'string' ? f.trim() : ''))
        .filter(Boolean)));
    if (normalized.length === 0) return [];

    const cacheKey = `fp_filters:${normalized.join('|').toLowerCase()}:${limit}`;
    if (fetcher.footprintFilterSearchCache.has(cacheKey)) {
        return /** @type {string[]} */ (fetcher.footprintFilterSearchCache.get(cacheKey));
    }

    await fetcher._ensureFootprintIndexLoaded();
    const footprintNames = Array.isArray(fetcher.footprintNameIndex) ? fetcher.footprintNameIndex : [];
    if (footprintNames.length === 0) {
        fetcher.footprintFilterSearchCache.set(cacheKey, []);
        return [];
    }

    const regexes = normalized.map(f => fetcher._fpFilterToRegex(f));
    const matched = footprintNames.filter((fpName) => {
        const [lib, name] = fpName.split(':');
        const full = `${lib}:${name}`;
        return regexes.some(rx => rx.test(name) || rx.test(full));
    });

    // KiCad wildcards (e.g. *SC*70*, SOT?23*) already match suffix variants
    // like _Handsoldering, so no sibling expansion is needed here.

    const sorted = Array.from(new Set(matched))
        .sort((a, b) => a.localeCompare(b))
        .slice(0, limit);

    fetcher.footprintFilterSearchCache.set(cacheKey, sorted);
    return sorted;
}



    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Convert wildcard fp-filter to a case-insensitive regex.
     * @param {string} filter
     * @returns {RegExp}
     */
export function _fpFilterToRegex(fetcher, filter) {
    const escaped = filter
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
    return new RegExp(`^${escaped}$`, 'i');
}



    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Load all footprint names inside a specific KiCad footprint library.
     * @param {string} libName
     * @returns {Promise<string[]>}
     */
export async function _getFootprintNamesForLibrary(fetcher, libName) {
    const key = String(libName || '').trim();
    if (!key) return [];
    if (fetcher.footprintLibraryNamesCache.has(key)) {
        return /** @type {string[]} */ (fetcher.footprintLibraryNamesCache.get(key));
    }

    const names = new Set();
    const perPage = 100;

    for (const ref of fetcher._getGitRefs()) {
        let page = 1;
        let hasMore = true;

        while (hasMore) {
            const result = await fetcher._fetchGitLabTreePage({
                projectPath: KICAD_FOOTPRINTS_PROJECT_PATH,
                ref,
                perPage,
                page,
                path: `${key}.pretty`
            }, true);

            const data = result?.json;
            if (!Array.isArray(data) || data.length === 0) {
                break;
            }

            for (const entry of data) {
                const path = typeof entry?.path === 'string' ? entry.path : '';
                const match = path.match(/\.pretty\/(.+?)\.kicad_mod$/i);
                if (!match) continue;
                names.add(match[1]);
            }

            // Prefer header-based pagination when available, but fall back
            // to page-size progression because some proxies strip headers.
            const nextPage = Number(result?.headers?.get?.('x-next-page') || 0);
            if (Number.isFinite(nextPage) && nextPage > 0) {
                page = nextPage;
                continue;
            }
            if (data.length >= perPage) {
                page += 1;
                continue;
            }

            hasMore = false;
        }

        if (names.size > 0) {
            break;
        }
    }

    const out = Array.from(names).sort((a, b) => a.localeCompare(b));
    fetcher.footprintLibraryNamesCache.set(key, out);
    return out;
}



    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Find suffix sibling variants for a concrete footprint in the same library.
     * Example: Lib:Base -> Lib:Base_Handsoldering
     * @param {string} footprintName
     * @returns {Promise<string[]>}
     */
export async function findFootprintSiblingVariants(fetcher, footprintName) {
    const [libRaw, nameRaw] = String(footprintName || '').split(':');
    const lib = (libRaw || '').trim();
    const base = (nameRaw || '').trim();
    if (!lib || !base) return [];

    const libNames = await fetcher._getFootprintNamesForLibrary(lib);
    if (!Array.isArray(libNames) || libNames.length === 0) return [];

    const prefix = `${base}_`;
    return libNames
        .filter(name => typeof name === 'string' && name.startsWith(prefix))
        .map(name => `${lib}:${name}`)
        .sort((a, b) => a.localeCompare(b));
}



    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Ensure full footprint-name index is loaded for deterministic filter matching.
     * @returns {Promise<void>}
     */
export async function _ensureFootprintIndexLoaded(fetcher) {
    if (Array.isArray(fetcher.footprintNameIndex) && fetcher.footprintNameIndex.length > 0) return;
    if (fetcher._footprintIndexLoadPromise) {
        await fetcher._footprintIndexLoadPromise;
        return;
    }

    fetcher._footprintIndexLoadPromise = fetcher._loadFootprintNameIndex();
    try {
        await fetcher._footprintIndexLoadPromise;
    } finally {
        fetcher._footprintIndexLoadPromise = null;
    }
}



    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Load complete footprint name index from cache or GitLab tree API.
     * @returns {Promise<void>}
     */
export async function _loadFootprintNameIndex(fetcher) {
    const published = await fetcher._loadStaticIndex();
    if (published) {
        fetcher.footprintNameIndex = published.footprints;
        return;
    }

    // Ensure we know the latest release tag before fetching
    await fetcher._detectLatestRelease();

    const cacheKey = KICAD_FULL_FOOTPRINT_INDEX_CACHE_KEY;
    const cached = storageManager.get(cacheKey);
    if (isLikelyValidFootprintIndex(cached)) {
        fetcher.footprintNameIndex = cached;
        return;
    }

    const perPage = 100;
    for (const ref of fetcher._getGitRefs()) {
        const names = new Set();
        let page = 1;
        let hasMore = true;
        let failedPages = 0;

        while (hasMore) {
            const data = await fetcher._fetchGitLabTreePage({
                projectPath: KICAD_FOOTPRINTS_PROJECT_PATH,
                ref,
                perPage,
                page,
                recursive: true
            });

            if (!Array.isArray(data)) {
                failedPages += 1;
                break;
            }
            if (data.length === 0) {
                hasMore = false;
                break;
            }

            for (const entry of data) {
                const name = footprintNameFromPath(entry?.path);
                if (name) names.add(name);
            }

            page += 1;
        }

        if (failedPages === 0) {
            const list = Array.from(names).sort((a, b) => a.localeCompare(b));
            if (isLikelyValidFootprintIndex(list)) {
                fetcher.footprintNameIndex = list;
                fetcher._setContentCache(cacheKey, list);
                return;
            }
        }
    }

    // If live refresh fails, keep whatever valid cache exists; otherwise empty.
    if (isLikelyValidFootprintIndex(cached)) {
        fetcher.footprintNameIndex = cached;
    } else {
        fetcher.footprintNameIndex = [];
    }
}



    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Fetch a `.kicad_mod` footprint file with 7-day localStorage caching.
     * @param {string} lib - Footprint library name
     * @param {string} name - Footprint name (without extension)
     * @returns {Promise<string|null>} Raw file content or null
     */
export async function _fetchFootprintFile(fetcher, lib, name) {
    const cacheKey = `kicad_fp_${lib}_${name}`;
    const cached = storageManager.get(cacheKey);
    if (cached && typeof cached === 'string') {
        return cached;
    }

    const targetUrls = fetcher._buildRawUrlCandidates(fetcher.footprintsBase, `${lib}.pretty/${name}.kicad_mod`);

    const content = await fetcher._fetchFirstValidContentFromUrls(targetUrls, {
        validator: value => fetcher._isValidFootprintContent(value),
        errorContext: 'KiCad footprint fetch error'
    });
    if (content) {
        fetcher._setContentCache(cacheKey, content);
        return content;
    }

    return null;
}
