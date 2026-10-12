import assert from 'node:assert/strict';
import { installFakeDom } from './helpers/fake-dom.mjs';

installFakeDom();
const requests = [];
let serveStatic = () => { throw new Error('Unexpected remote access'); };
globalThis.fetch = async url => {
    requests.push(String(url));
    return serveStatic(String(url));
};

const format = await import('../../src/components/kicad-index-format.js');
const { buildKiCadIndex, checkDeployedIndex, listTree } = await import('../../tools/build-kicad-index.mjs');
const { KiCadFetcher } = await import('../../src/components/KiCadFetcher.js');
const STATIC_URL = new URL('../../assets/kicad-index.json', import.meta.url).href;
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });

// Shared parsing and validation rules.
assert.equal(format.latestStableTag(['9.0.2', '10.0.0-rc1', '10.0.6', 'v8', '9.99.0-backport', '10.0.10', null]),
    '10.0.10', 'Numeric ordering, prereleases and legacy tags skipped');
assert.equal(format.latestStableTag(['10.0.0-rc1']), null);
{
    const index = {};
    format.addSymbolTreeEntries([
        { type: 'tree', path: 'Device.kicad_symdir' },
        { type: 'blob', path: 'Device.kicad_symdir/R.kicad_sym' },
        { type: 'blob', path: 'Device.kicad_symdir/C.kicad_sym' },
        { type: 'blob', path: 'Legacy.kicad_sym' },
        { type: 'blob', path: 'Deep.kicad_symdir/x/Y.kicad_sym' },
        { type: 'blob', path: 'README.md' },
        null,
    ], index);
    assert.deepEqual(index, { Device: ['R', 'C'] });
}
assert.equal(format.footprintNameFromPath('Resistor_SMD.pretty/R_0603.kicad_mod'), 'Resistor_SMD:R_0603');
assert.equal(format.footprintNameFromPath('Resistor_SMD.pretty'), null);
assert.equal(format.footprintNameFromPath(undefined), null);

// A synthetic GitLab with the minimum sizes the validators accept.
const TAG = '10.0.6';
function symbolEntries(libraryCount = format.MIN_EXPECTED_LIBRARY_COUNT) {
    const libs = ['Device', 'Timer', ...Array.from({ length: libraryCount - 2 }, (_, i) => `Lib${i}`)];
    return libs.flatMap(lib => [
        { type: 'tree', path: `${lib}.kicad_symdir` },
        { type: 'blob', path: `${lib}.kicad_symdir/${lib}_A.kicad_sym` },
    ]).concat({ type: 'blob', path: 'LICENSE.md' });
}
function footprintEntries(count = format.MIN_EXPECTED_FOOTPRINT_COUNT) {
    const prefixes = format.REQUIRED_FOOTPRINT_LIB_PREFIXES.map(prefix => prefix.slice(0, -1));
    const entries = prefixes.map(lib => ({ type: 'tree', path: `${lib}.pretty` }));
    for (let i = 0; i < count; i++) {
        entries.push({ type: 'blob', path: `${prefixes[i % prefixes.length]}.pretty/FP_${i}.kicad_mod` });
    }
    return entries;
}
function fakeGitLab({ symbols = symbolEntries(), footprints = footprintEntries(), tags = [TAG, '9.0.2'],
    failOnce = new Map(), deployed = null } = {}) {
    const calls = [];
    const fetchImpl = async url => {
        calls.push(url);
        if (failOnce.has(url)) {
            const status = failOnce.get(url);
            failOnce.delete(url);
            return json({ message: 'unavailable' }, status);
        }
        if (url === 'https://clearpcb.org/assets/kicad-index.json') {
            return deployed ? json(deployed) : json({ message: 'Not Found' }, 404);
        }
        const parsed = new URL(url);
        assert.equal(parsed.origin, 'https://gitlab.com', 'The generator calls GitLab directly, never the proxy');
        if (parsed.pathname.endsWith('/repository/tags')) return json(tags.map(name => ({ name })));
        assert.ok(parsed.pathname.endsWith('/repository/tree'));
        assert.equal(parsed.searchParams.get('ref'), TAG, 'Trees are listed at the release tag');
        assert.equal(parsed.searchParams.get('recursive'), 'true');
        const all = parsed.pathname.includes('kicad-symbols') ? symbols : footprints;
        const perPage = Number(parsed.searchParams.get('per_page'));
        const page = Number(parsed.searchParams.get('page'));
        return json(all.slice((page - 1) * perPage, page * perPage));
    };
    return { fetchImpl, calls };
}

{
    const gitlab = fakeGitLab();
    const doc = await buildKiCadIndex({ fetchImpl: gitlab.fetchImpl, retryDelayMs: 0,
        now: new Date('2026-01-02T03:04:05Z') });
    assert.equal(doc.format, format.STATIC_INDEX_FORMAT);
    assert.equal(doc.tag, TAG);
    assert.equal(doc.generatedAt, '2026-01-02T03:04:05.000Z');
    assert.equal(Object.keys(doc.symbols).length, format.MIN_EXPECTED_LIBRARY_COUNT);
    assert.deepEqual(doc.symbols.Timer, ['Timer_A']);
    assert.equal(doc.footprints.length, format.MIN_EXPECTED_FOOTPRINT_COUNT);
    assert.deepEqual(doc.footprints, [...doc.footprints].sort((a, b) => a.localeCompare(b)));
    assert.ok(format.isValidStaticIndex(doc));
    assert.equal(format.isValidStaticIndex({ ...doc, format: 2 }), false, 'Unknown formats are rejected');
    assert.equal(format.isValidStaticIndex({ ...doc, tag: '' }), false);
    assert.equal(format.isValidStaticIndex({ ...doc, footprints: doc.footprints.slice(1) }), false);
    const { Timer, ...withoutTimer } = doc.symbols;
    assert.ok(Timer);
    assert.equal(format.isValidStaticIndex({ ...doc, symbols: withoutTimer }), false);
}
{
    const exact = Array.from({ length: 200 }, (_, i) => ({ type: 'blob', path: `L.kicad_symdir/S${i}.kicad_sym` }));
    const gitlab = fakeGitLab({ symbols: exact });
    const entries = await listTree(format.KICAD_SYMBOLS_PROJECT_PATH, TAG,
        { fetchImpl: gitlab.fetchImpl, retryDelayMs: 0 });
    assert.equal(entries.length, 200, 'A listing that fills its last page ends at the following empty page');
}
{
    const page2 = 'https://gitlab.com/api/v4/projects/kicad%2Flibraries%2Fkicad-symbols/repository/tree' +
        `?ref=${TAG}&recursive=true&per_page=100&page=2`;
    const gitlab = fakeGitLab({ failOnce: new Map([[page2, 503]]) });
    const doc = await buildKiCadIndex({ fetchImpl: gitlab.fetchImpl, retryDelayMs: 0 });
    assert.equal(Object.keys(doc.symbols).length, format.MIN_EXPECTED_LIBRARY_COUNT, 'A transient 503 is retried');
    assert.equal(gitlab.calls.filter(url => url === page2).length, 2);
}
{
    const gitlab = fakeGitLab({ footprints: footprintEntries(format.MIN_EXPECTED_FOOTPRINT_COUNT - 1) });
    await assert.rejects(buildKiCadIndex({ fetchImpl: gitlab.fetchImpl, retryDelayMs: 0 }),
        /Incomplete KiCad 10\.0\.6 index/, 'A partial index is never written');
    const missing = fakeGitLab({ tags: ['10.0.0-rc1'] });
    await assert.rejects(buildKiCadIndex({ fetchImpl: missing.fetchImpl, retryDelayMs: 0 }), /no stable KiCad/);
}
{
    const gone = 'https://gitlab.com/api/v4/projects/kicad%2Flibraries%2Fkicad-footprints/repository/tags' +
        '?per_page=10&order_by=version';
    const gitlab = fakeGitLab({ failOnce: new Map([[gone, 404]]) });
    await assert.rejects(buildKiCadIndex({ fetchImpl: gitlab.fetchImpl, retryDelayMs: 0 }), /HTTP 404/);
    assert.equal(gitlab.calls.length, 1, 'Client errors are not retried');
}

// Weekly check of the deployed index.
{
    const url = 'https://clearpcb.org/assets/kicad-index.json';
    const current = await buildKiCadIndex({ fetchImpl: fakeGitLab().fetchImpl, retryDelayMs: 0 });
    const ok = await checkDeployedIndex(url, { fetchImpl: fakeGitLab({ deployed: current }).fetchImpl, retryDelayMs: 0 });
    assert.deepEqual(ok, { ok: true, message: 'The deployed KiCad index is current (10.0.6).' });
    const stale = await checkDeployedIndex(url,
        { fetchImpl: fakeGitLab({ deployed: { ...current, tag: '9.0.2' } }).fetchImpl, retryDelayMs: 0 });
    assert.equal(stale.ok, false);
    assert.match(stale.message, /index is for 9\.0\.2, but KiCad 10\.0\.6 is available/);
    const missing = await checkDeployedIndex(url, { fetchImpl: fakeGitLab().fetchImpl, retryDelayMs: 0 });
    assert.equal(missing.ok, false);
    assert.match(missing.message, /has no valid KiCad index.*KiCad 10\.0\.6/);
}

// The app loads the published index first and makes no GitLab or proxy calls.
const published = await buildKiCadIndex({ fetchImpl: fakeGitLab().fetchImpl, retryDelayMs: 0 });
{
    requests.length = 0;
    serveStatic = url => {
        assert.equal(url, STATIC_URL, 'Only the same-origin index is requested');
        return json(published);
    };
    const fetcher = new KiCadFetcher();
    fetcher._fetchJsonWithProxy = async () => { throw new Error('Tag lookup must come from the index'); };
    fetcher._fetchGitLabTreePage = async () => { throw new Error('Tree must not be paged'); };
    await fetcher.ensureIndexLoaded();
    assert.deepEqual(fetcher.libraryIndex, { symbols: published.symbols });
    assert.deepEqual(fetcher._symdirCache.get('Timer'), ['Timer_A']);
    assert.equal(await fetcher._detectLatestRelease(), TAG);
    assert.deepEqual(fetcher._getGitRefs(), [TAG, 'master', 'main'], 'Lookups use the index tag');
    await fetcher._ensureFootprintIndexLoaded();
    assert.deepEqual(fetcher.footprintNameIndex, published.footprints);
    assert.deepEqual(requests, [STATIC_URL], 'The published index is fetched once');
}
for (const [label, respond] of [
    ['missing', () => json({ message: 'Not Found' }, 404)],
    ['invalid', () => json({ ...published, format: 99 })],
    ['offline', () => { throw new TypeError('Failed to fetch'); }],
]) {
    requests.length = 0;
    serveStatic = respond;
    const warnings = [], warn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
        const fetcher = new KiCadFetcher();
        let livePages = 0;
        fetcher._fetchJsonWithProxy = async () => [{ name: '9.0.7' }];
        fetcher._fetchFullSymbolIndex = async () => {
            livePages++;
            fetcher.libraryIndex = { symbols: { Device: ['R'], Timer: ['NE555'] } };
        };
        await fetcher.ensureIndexLoaded();
        assert.equal(livePages, 1, `${label}: falls back to live GitLab loading`);
        assert.equal(fetcher._getGitRefs()[0], '9.0.7', `${label}: tag comes from the tags API`);
        assert.equal(warnings.some(w => w.includes('Published KiCad index is invalid')), label === 'invalid');
        assert.deepEqual(requests, [STATIC_URL]);
    } finally {
        console.warn = warn;
    }
}

console.log('PASS KiCad static index: shared rules, generator, deployed check, and static-first loading');
