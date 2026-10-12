#!/usr/bin/env node
// Builds the KiCad library index published with the site (assets/kicad-index.json),
// so browsers load one static file instead of paging GitLab's tree API through the
// CORS proxy. The index is pinned to the latest stable KiCad library tag at build time.
//
// Usage:
//   node tools/build-kicad-index.mjs <output.json>   build the index for the latest KiCad release
//   node tools/build-kicad-index.mjs --check <url>   fail if the index at <url> is missing,
//                                                   invalid, or older than the latest KiCad release
//
// Calls the GitLab API directly (no proxy). release.yml builds the index into each
// stable release; kicad-index-check.yml runs --check weekly against clearpcb.org.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    KICAD_FOOTPRINTS_PROJECT_PATH, KICAD_SYMBOLS_PROJECT_PATH, STATIC_INDEX_FORMAT,
    addSymbolTreeEntries, footprintNameFromPath, isValidStaticIndex, latestStableTag
} from '../src/components/kicad-index-format.js';

const API = 'https://gitlab.com/api/v4/projects';
const PER_PAGE = 100;
const PARALLEL_PAGES = 8;
const MAX_PAGES = 2000;
const ATTEMPTS = 4;

/**
 * GET JSON, retrying network errors, 429 and 5xx with linear backoff.
 * @param {string} url
 * @param {{ fetchImpl?: typeof fetch, retryDelayMs?: number }} [options]
 */
export async function getJson(url, { fetchImpl = fetch, retryDelayMs = 2000 } = {}) {
    let lastError;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        let response = null;
        try {
            response = await fetchImpl(url, { headers: { accept: 'application/json' } });
        } catch (err) {
            lastError = err;
        }
        if (response) {
            if (response.ok) return response.json();
            lastError = new Error(`HTTP ${response.status} for ${url}`);
            if (response.status !== 429 && response.status < 500) break;
        }
        if (attempt < ATTEMPTS) await new Promise(done => setTimeout(done, retryDelayMs * attempt));
    }
    throw lastError;
}

/** @param {{ fetchImpl?: typeof fetch, retryDelayMs?: number }} [options] */
export async function fetchLatestKiCadTag(options) {
    const tags = await getJson(
        `${API}/${KICAD_FOOTPRINTS_PROJECT_PATH}/repository/tags?per_page=10&order_by=version`, options);
    const tag = Array.isArray(tags) ? latestStableTag(tags.map(t => t?.name)) : null;
    if (!tag) throw new Error('GitLab returned no stable KiCad library tag');
    return tag;
}

/**
 * Every entry of a recursive repository tree listing. Pages are fetched in parallel
 * batches; the first short page marks the end.
 * @param {string} projectPath
 * @param {string} ref
 * @param {{ fetchImpl?: typeof fetch, retryDelayMs?: number }} [options]
 * @returns {Promise<Array<{type?: string, path?: string}>>}
 */
export async function listTree(projectPath, ref, options) {
    const entries = [];
    for (let first = 1; first <= MAX_PAGES; first += PARALLEL_PAGES) {
        const pages = await Promise.all(Array.from({ length: PARALLEL_PAGES }, (_, i) => getJson(
            `${API}/${projectPath}/repository/tree?ref=${encodeURIComponent(ref)}` +
            `&recursive=true&per_page=${PER_PAGE}&page=${first + i}`, options)));
        for (const page of pages) {
            if (!Array.isArray(page)) throw new Error(`Unexpected tree page for ${projectPath}`);
            entries.push(...page);
            if (page.length < PER_PAGE) return entries;
        }
    }
    throw new Error(`${projectPath} tree exceeds ${MAX_PAGES} pages`);
}

/**
 * Build and validate the index for the latest stable KiCad library release.
 * @param {{ fetchImpl?: typeof fetch, retryDelayMs?: number, now?: Date }} [options]
 * @returns {Promise<import('../src/components/kicad-index-format.js').StaticKiCadIndex>}
 */
export async function buildKiCadIndex(options = {}) {
    const tag = await fetchLatestKiCadTag(options);
    const symbols = {};
    addSymbolTreeEntries(await listTree(KICAD_SYMBOLS_PROJECT_PATH, tag, options), symbols);
    const footprints = [...new Set((await listTree(KICAD_FOOTPRINTS_PROJECT_PATH, tag, options))
        .map(entry => footprintNameFromPath(entry?.path))
        .filter(name => name !== null))]
        .sort((a, b) => a.localeCompare(b));
    const doc = {
        format: STATIC_INDEX_FORMAT,
        tag,
        generatedAt: (options.now || new Date()).toISOString(),
        symbols,
        footprints,
    };
    if (!isValidStaticIndex(doc)) {
        throw new Error(`Incomplete KiCad ${tag} index: ${Object.keys(symbols).length} libraries, ` +
            `${footprints.length} footprints`);
    }
    return doc;
}

/**
 * Compare a deployed index with the latest KiCad library release.
 * @param {string} url
 * @param {{ fetchImpl?: typeof fetch, retryDelayMs?: number }} [options]
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
export async function checkDeployedIndex(url, options) {
    const latest = await fetchLatestKiCadTag(options);
    let deployed = null;
    try {
        deployed = await getJson(url, options);
    } catch {
        // Missing or unreachable: reported as no valid index below.
    }
    if (!isValidStaticIndex(deployed)) {
        return { ok: false, message: `${url} has no valid KiCad index. ` +
            `Publish a ClearPCB release to build one for KiCad ${latest}.` };
    }
    if (deployed.tag !== latest) {
        return { ok: false, message: `The deployed KiCad index is for ${deployed.tag}, but KiCad ` +
            `${latest} is available. Publish a ClearPCB release to update it.` };
    }
    return { ok: true, message: `The deployed KiCad index is current (${latest}).` };
}

async function main(args) {
    if (args[0] === '--check' && args.length === 2) {
        const result = await checkDeployedIndex(args[1]);
        if (result.ok) {
            console.log(result.message);
        } else {
            console.error(`::error::${result.message}`);
            process.exitCode = 1;
        }
        return;
    }
    if (args.length !== 1 || args[0].startsWith('--')) {
        console.error('Usage: node tools/build-kicad-index.mjs <output.json> | --check <url>');
        process.exitCode = 2;
        return;
    }
    const doc = await buildKiCadIndex();
    const json = JSON.stringify(doc);
    await mkdir(dirname(resolve(args[0])), { recursive: true });
    await writeFile(args[0], json);
    const symbolCount = Object.values(doc.symbols).reduce((n, names) => n + names.length, 0);
    console.log(`Wrote ${args[0]}: KiCad ${doc.tag}, ${Object.keys(doc.symbols).length} libraries, ` +
        `${symbolCount} symbols, ${doc.footprints.length} footprints, ${Math.round(json.length / 1024)} KB`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    await main(process.argv.slice(2));
}
