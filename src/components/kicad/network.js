/**
 * KiCad network plumbing owns release detection, CORS-proxied fetches,
 * response validation and raw GitLab URL construction for the fetcher.
 */

import { storageManager } from '../../core/StorageManager.js';
import { isValidStaticIndex, latestStableTag, KICAD_FOOTPRINTS_PROJECT_PATH } from '../kicad-index-format.js';
import {
    CONTENT_CACHE_TTL_MS, KICAD_FALLBACK_RELEASE, KICAD_GIT_REFS_BRANCHES,
    KICAD_LATEST_TAG_CACHE_KEY, STATIC_INDEX_URL, CONTENT_PREVIEW_LENGTH,
    SYMBOL_LIBRARY_MARKER, FOOTPRINT_MARKER
} from './constants.js';



    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Get ordered git refs to try: [latest-release, master, main].
     * Before the release tag is detected, falls back to the hardcoded default.
     * @returns {string[]}
     */
export function _getGitRefs(fetcher) {
    const tag = fetcher._latestRelease || KICAD_FALLBACK_RELEASE;
    return [tag, ...KICAD_GIT_REFS_BRANCHES];
}



    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Detect the latest stable KiCad library release tag from GitLab.
     * Result is cached in localStorage for 7 days.
     * @returns {Promise<string>}
     */
export async function _detectLatestRelease(fetcher) {
    if (fetcher._latestRelease) return fetcher._latestRelease;
    if (fetcher._latestReleasePromise) return fetcher._latestReleasePromise;

    fetcher._latestReleasePromise = fetcher._fetchLatestRelease();
    try {
        const tag = await fetcher._latestReleasePromise;
        fetcher._latestRelease = tag;
        return tag;
    } finally {
        fetcher._latestReleasePromise = null;
    }
}



    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Load the KiCad index published with the site. Resolves null when it is
     * absent or invalid (e.g. a local checkout), so callers fall back to live
     * GitLab loading. Loaded at most once per fetcher.
     * @returns {Promise<import('../kicad-index-format.js').StaticKiCadIndex|null>}
     */
export function _loadStaticIndex(fetcher) {
    if (!fetcher._staticIndexPromise) {
        fetcher._staticIndexPromise = fetcher._fetchStaticIndex();
    }
    return fetcher._staticIndexPromise;
}



    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher @returns {Promise<import('../kicad-index-format.js').StaticKiCadIndex|null>} */
export async function _fetchStaticIndex(fetcher) {
    try {
        const response = await fetch(STATIC_INDEX_URL);
        if (!response.ok) return null;
        const doc = await response.json();
        if (isValidStaticIndex(doc)) {
            console.log(`KiCadFetcher: Using published index for KiCad ${doc.tag}`);
            return doc;
        }
        console.warn('KiCadFetcher: Published KiCad index is invalid; loading from GitLab.');
    } catch {
        // Not published with this copy of the app; the live path takes over.
    }
    return null;
}



    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Latest stable release tag: the published index's tag (so symbol and
     * footprint lookups match the index), else the GitLab tags API.
     * @returns {Promise<string>}
     */
export async function _fetchLatestRelease(fetcher) {
    const published = await fetcher._loadStaticIndex();
    if (published) {
        return published.tag;
    }

    const cached = storageManager.get(KICAD_LATEST_TAG_CACHE_KEY);
    if (typeof cached === 'string' && cached.length > 0) {
        return cached;
    }

    try {
        const apiUrl = `https://gitlab.com/api/v4/projects/${KICAD_FOOTPRINTS_PROJECT_PATH}/repository/tags?per_page=10&order_by=version`;
        const data = await fetcher._fetchJsonWithProxy(apiUrl);
        const latest = Array.isArray(data) ? latestStableTag(data.map(t => t?.name)) : null;
        if (latest) {
            storageManager.set(KICAD_LATEST_TAG_CACHE_KEY, latest, CONTENT_CACHE_TTL_MS);
            console.log(`KiCad latest release tag: ${latest}`);
            return latest;
        }
    } catch (err) {
        console.warn('Failed to detect KiCad release tag, using fallback:', err);
    }

    // If API failed, try expired cache before hardcoded fallback
    const expired = storageManager.getRaw(KICAD_LATEST_TAG_CACHE_KEY);
    if (typeof expired?.data === 'string' && expired.data.length > 0) {
        console.log(`KiCad using expired cached tag: ${expired.data}`);
        return expired.data;
    }

    return KICAD_FALLBACK_RELEASE;
}



    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Cache fetched KiCad library content and emit a debug log.
     * @param {string} cacheKey
     * @param {string} library
     * @param {string} content
     */
export function _cacheLibraryContent(fetcher, cacheKey, library, content) {
    fetcher._setContentCache(cacheKey, content);
    console.log(`Cached KiCad library: ${library}`);
}



    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Cache content data with the standard content TTL.
     * @param {string} key
     * @param {any} value
     * @returns {boolean}
     */
export function _setContentCache(fetcher, key, value) {
    return storageManager.set(key, value, CONTENT_CACHE_TTL_MS);
}



    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Read response text and validate it using the provided validator.
     * @param {Response} response
     * @param {(content: unknown) => boolean} validator
     * @returns {Promise<string|null>}
     */
export async function _readValidatedResponseText(fetcher, response, validator) {
    const content = await response.text();
    return validator(content) ? content : null;
}



    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Fetch the first valid text payload from URL candidates.
     * @param {string[]} targetUrls
     * @param {object} options
    * @param {(content: unknown) => boolean} [options.validator]
     * @param {string} [options.errorContext='KiCad fetch error']
     * @param {string} [options.logPrefix]
     * @returns {Promise<string|null>}
     */
export async function _fetchFirstValidContentFromUrls(fetcher, targetUrls, { validator = () => true, errorContext = 'KiCad fetch error', logPrefix } = {}) {
    for (const targetUrl of targetUrls) {
        if (logPrefix) {
            console.log(logPrefix);
        }

        const response = await fetcher._fetchFirstOkResponse(targetUrl, errorContext);
        if (!response) {
            continue;
        }

        const content = await fetcher._readValidatedResponseText(response, validator);
        if (content) {
            return content;
        }
    }

    return null;
}



    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Validate that fetched content looks like a KiCad symbol library file.
     * @param {unknown} content
     * @returns {content is string}
     */
export function _isValidKiCadSymbolContent(fetcher, content) {
    if (typeof content !== 'string') {
        console.warn('KiCad content is not a string, skipping cache');
        return false;
    }

    if (!content.includes(SYMBOL_LIBRARY_MARKER)) {
        console.warn('Response does not look like a KiCad library file:', content.substring(0, CONTENT_PREVIEW_LENGTH));
        return false;
    }

    return true;
}



    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Validate footprint file content format.
     * @param {unknown} content
     * @returns {content is string}
     */
export function _isValidFootprintContent(fetcher, content) {
    return typeof content === 'string' && content.includes(FOOTPRINT_MARKER);
}



    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Parse JSON from a fetch response and optionally include headers.
     * @param {Response} response
     * @param {boolean} [returnHeaders=false]
     * @returns {Promise<any|null>}
     */
export async function _parseJsonFromResponse(fetcher, response, returnHeaders = false) {
    try {
        const json = await response.json();
        if (returnHeaders) {
            return { json, headers: response.headers };
        }
        return json;
    } catch (error) {
        console.error('KiCad JSON parse error:', error);
        return null;
    }
}



    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Fetch JSON from a URL through CORS proxies.
     * @param {string} targetUrl
     * @param {boolean} [returnHeaders=false] - If true, return `{ json, headers }`
     * @returns {Promise<any|null>}
     */
export async function _fetchJsonWithProxy(fetcher, targetUrl, returnHeaders = false) {
    const response = await fetcher._fetchFirstOkResponse(targetUrl);
    if (!response) {
        return null;
    }

    return fetcher._parseJsonFromResponse(response, returnHeaders);
}



    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Build a GitLab repository/tree API URL.
     * @param {object} params
     * @param {string} params.projectPath
     * @param {string} params.ref
     * @param {number} [params.perPage=100]
     * @param {number} [params.page=1]
     * @param {boolean} [params.recursive=false]
     * @param {string} [params.path]
     * @returns {string}
     */
export function _buildGitLabTreeApiUrl(fetcher, { projectPath, ref, perPage = 100, page = 1, recursive = false, path }) {
    const params = new URLSearchParams({
        ref,
        per_page: String(perPage),
        page: String(page)
    });
    if (recursive) {
        params.set('recursive', 'true');
    }
    if (typeof path === 'string' && path.length > 0) {
        params.set('path', path);
    }

    return `https://gitlab.com/api/v4/projects/${projectPath}/repository/tree?${params.toString()}`;
}



    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Build a GitLab search API URL.
     * @param {{projectPath: string, scope: string, search: string, perPage?: number, page?: number, ref?: string}} params
     * @returns {string}
     */
export function _buildGitLabSearchApiUrl(fetcher, { projectPath, scope, search, perPage = 50, page = 1, ref }) {
    const params = new URLSearchParams({
        scope,
        search,
        per_page: String(perPage),
        page: String(page)
    });
    if (ref) params.set('ref', ref);
    return `https://gitlab.com/api/v4/projects/${projectPath}/search?${params.toString()}`;
}



    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Fetch a GitLab repository/tree page through the configured proxy chain.
     * @param {object} params
     * @param {string} params.projectPath
     * @param {string} params.ref
     * @param {number} [params.perPage=100]
     * @param {number} [params.page=1]
     * @param {boolean} [params.recursive=false]
     * @param {string} [params.path]
     * @param {boolean} [returnHeaders=false]
     * @returns {Promise<any|null>}
     */
export function _fetchGitLabTreePage(fetcher, params, returnHeaders = false) {
    const apiUrl = fetcher._buildGitLabTreeApiUrl(params);
    return fetcher._fetchJsonWithProxy(apiUrl, returnHeaders);
}



    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Search blobs in a GitLab project.
     * @param {{projectPath: string, scope: string, search: string, perPage?: number, page?: number, ref?: string}} params
     * @returns {Promise<any|null>}
     */
export function _fetchGitLabSearchPage(fetcher, params) {
    const apiUrl = fetcher._buildGitLabSearchApiUrl(params);
    return fetcher._fetchJsonWithProxy(apiUrl);
}



    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Wrap fetch() with an AbortController timeout.
     * @param {string} url
     * @param {number} [timeoutMs=15000]
     * @returns {Promise<Response>}
     */
export async function _fetchWithTimeout(fetcher, url, timeoutMs = 15000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { signal: controller.signal });
    } finally {
        clearTimeout(timeoutId);
    }
}



    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Fetch a target URL through configured proxies and return the first successful response.
     * @param {string} targetUrl
     * @param {string} [errorContext='KiCad fetch error']
     * @returns {Promise<Response|null>}
     */
export async function _fetchFirstOkResponse(fetcher, targetUrl, errorContext = 'KiCad fetch error') {
    for (let attempt = 0; attempt < fetcher.corsProxies.length; attempt++) {
        try {
            const proxy = fetcher.corsProxies[attempt];
            const url = `${proxy}${encodeURIComponent(targetUrl)}`;
            const response = await fetcher._fetchWithTimeout(url);
            if (response.ok) {
                return response;
            }
            console.warn(`KiCad fetch failed with status ${response.status}`);
        } catch (error) {
            console.error(`${errorContext} with proxy ${fetcher.corsProxies[attempt]}:`, error);
        }
    }

    return null;
}



    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Check whether a URL exists by attempting a fetch through CORS proxies.
     * @param {string} targetUrl
     * @returns {Promise<boolean>}
     */
export async function _checkUrlExists(fetcher, targetUrl) {
    const response = await fetcher._fetchFirstOkResponse(targetUrl);
    return !!response;
}



    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Returns candidate raw bases, preferring configured base then alternate main/master.
     * @param {string} base
     * @returns {string[]}
     */
export function _getRawBaseCandidates(fetcher, base) {
    const tag = fetcher._latestRelease || KICAD_FALLBACK_RELEASE;
    const candidates = [base];
    // Try the latest stable release tag first, then master/main fallbacks.
    // Release tags match what users have installed; master may diverge.
    if (base.includes('/-/raw/master')) {
        candidates.unshift(base.replace('/-/raw/master', `/-/raw/${tag}`));
        candidates.push(base.replace('/-/raw/master', '/-/raw/main'));
    } else if (base.includes('/-/raw/main')) {
        candidates.unshift(base.replace('/-/raw/main', `/-/raw/${tag}`));
        candidates.push(base.replace('/-/raw/main', '/-/raw/master'));
    }

    return [...new Set(candidates)];
}



    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Builds raw URL candidates by combining raw base candidates and relative path.
     * @param {string} base
     * @param {string} relativePath
     * @returns {string[]}
     */
export function _buildRawUrlCandidates(fetcher, base, relativePath) {
    return fetcher._getRawBaseCandidates(base).map(rawBase => `${rawBase}/${relativePath}`);
}



    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Builds symbol-library URL candidates including optional /symbols subdir variants.
     * @param {string} library
     * @returns {string[]}
     */
export function _buildSymbolLibraryUrlCandidates(fetcher, library) {
    const expandedBases = [];
    for (const base of fetcher._getRawBaseCandidates(fetcher.symbolsBase)) {
        expandedBases.push(base);
        if (!base.endsWith('/symbols')) {
            expandedBases.push(`${base}/symbols`);
        }
    }

    return expandedBases.map(base => `${base}/${library}.kicad_sym`);
}



    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Resolves first existing URL from candidates with existence-cache support.
     * @param {string[]} candidates
     * @param {Map<string, boolean>} cache
     * @param {string} prefix
     * @returns {Promise<string|null>}
     */
export async function _resolveFirstExistingUrl(fetcher, candidates, cache, prefix) {
    for (const candidate of candidates) {
        const key = `${prefix}:${candidate}`;
        const cached = cache.has(key) ? cache.get(key) : null;
        if (cached === true) {
            return candidate;
        }
        if (cached === false) {
            continue;
        }

        const exists = await fetcher._checkUrlExists(candidate);
        cache.set(key, exists);
        if (exists) {
            return candidate;
        }
    }

    return null;
}
